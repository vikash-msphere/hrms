// Pure logic for the asset-tag sticker printer: sheet-format geometry, tag generation and slot
// scan order. Org-configurable via the `settings/asset-tags` blob (AssetTagSettings) - everything
// here takes the resolved config, with the built-ins below as fallback defaults. Kept free of
// React/DOM so it unit-tests under the workers pool.

export type SheetFormat = {
  id: string;
  label: string;
  cols: number;
  rows: number;
  w: number; // label width, mm
  h: number; // label height, mm
  marginX: number; // sheet side margin, mm
  marginY: number; // sheet top/bottom margin, mm
  gapX: number; // horizontal gap between labels, mm
  gapY: number; // vertical gap, mm
};

// What the printed code encodes: a login deep link, the public lost-and-found URL, or scanner-plain
// text (tag alone, or tag + serial).
export type QrMode = "link" | "found" | "tag" | "tag_serial";

// The org-wide printing config, stored as the `settings/asset-tags` value. Every field optional -
// omitted fields fall back to the defaults below, so a missing/partial blob always works.
export type AssetTagSettings = {
  prefix?: string; // tag prefix; blank/omitted = derive from the org name's initials
  separator?: string; // joins prefix / category code / number
  digits?: number; // zero-padded number width, 1-6
  default_format?: string; // sheet format id the printer opens with
  custom_formats?: SheetFormat[]; // org-specific sticker sheets, offered alongside the presets
  qr_mode?: QrMode; // what the code encodes by default
  code_type?: "qr" | "code128"; // 2D QR or 1D barcode (for orgs with laser scanners; always encodes the tag text)
  label?: { name?: boolean; serial?: boolean; org?: boolean; logo?: boolean; footer?: string }; // default label content (+ optional footer line, e.g. "If found: hr@x.com")
  found_page?: { enabled?: boolean; contact?: string; show_name?: boolean }; // public /found/<id> lookup
  custody?: AssetCustodySettings; // whether custody must be proved by scanning the tag (mirrors src/domain/assetCustody.ts)
};

// Custody enforcement, stored inside the same blob. Both `require_*` flags default ON server-side; turning
// them off makes a created asset land in stock and an assignment land assigned, with no scan in the loop.
export type AssetCustodySettings = {
  stock_scan_required?: boolean;
  ack_required?: boolean;
  manual_ack_allowed?: boolean; // holders may confirm without scanning (destroyed sticker)
  ack_reminder_days?: number; // how long an unconfirmed hand-over waits before the nightly nudge
  verify_stale_days?: number; // how long since the last sighting before an asset counts as stale
};

// The six states an asset can be in, and how they read. The two `pending_*` ones exist only because nobody
// has scanned the tag yet - they are the whole point of the custody loop, so they lead the list.
export const ASSET_STATUSES = ["pending_verification", "in_stock", "pending_ack", "assigned", "repair", "retired"] as const;
export type AssetStatusValue = (typeof ASSET_STATUSES)[number];

export const ASSET_STATUS_LABEL: Record<string, string> = {
  pending_verification: "Awaiting check-in",
  in_stock: "In stock",
  pending_ack: "Awaiting holder",
  assigned: "Assigned",
  repair: "In repair",
  retired: "Retired",
};

export const ASSET_STATUS_TONE: Record<string, string> = {
  pending_verification: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  in_stock: "bg-muted text-muted-foreground",
  pending_ack: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  assigned: "bg-primary/10 text-primary",
  repair: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  retired: "bg-destructive/10 text-destructive",
};

/** Only these two are settable by hand; the rest are produced by a scan verb or by (un)assigning. */
export const ASSET_MANUAL_STATUSES: AssetStatusValue[] = ["repair", "retired"];

export const ASSET_CONDITION_LABEL: Record<string, string> = { good: "Good", damaged: "Damaged", missing_parts: "Missing parts" };

// Common A4 self-adhesive label grids (Avery-style). Dimensions are the de-facto standard layouts;
// the printer's X/Y offset nudges absorb per-printer drift, so exactness to the sticker brand's
// datasheet matters less than symmetry.
export const SHEET_FORMATS: SheetFormat[] = [
  { id: "a4-65", label: "65 per sheet — 38.1 × 21.2 mm", cols: 5, rows: 13, w: 38.1, h: 21.2, marginX: 4.75, marginY: 10.7, gapX: 2.5, gapY: 0 },
  { id: "a4-40", label: "40 per sheet — 45.7 × 25.4 mm", cols: 4, rows: 10, w: 45.7, h: 25.4, marginX: 9.85, marginY: 21.5, gapX: 2.5, gapY: 0 },
  { id: "a4-24", label: "24 per sheet — 63.5 × 33.9 mm", cols: 3, rows: 8, w: 63.5, h: 33.9, marginX: 7.25, marginY: 12.9, gapX: 2.5, gapY: 0 },
  { id: "a4-21", label: "21 per sheet — 63.5 × 38.1 mm", cols: 3, rows: 7, w: 63.5, h: 38.1, marginX: 7.25, marginY: 15.15, gapX: 2.5, gapY: 0 },
];

// The code used in a tag when an asset has no category, matching FALLBACK_TAG_CODE on the server.
export const FALLBACK_TAG_CODE = "AST";

export const DEFAULT_TAG_SETTINGS = { separator: "-", digits: 3, default_format: "a4-65", qr_mode: "link" as const, label: { name: true, serial: false, org: true, logo: false } };

// Presets plus the org's custom formats (custom entries win on id collision so an org can re-define
// a preset's geometry without a new id). Blank-id entries are ignored - they're half-filled editor
// rows, not usable formats.
export function allFormats(s?: AssetTagSettings): SheetFormat[] {
  const custom = (s?.custom_formats ?? []).filter((f) => f.id?.trim());
  return [...custom, ...SHEET_FORMATS.filter((f) => !custom.some((c) => c.id === f.id))];
}

export function formatById(id: string | undefined, s?: AssetTagSettings): SheetFormat {
  const formats = allFormats(s);
  return formats.find((f) => f.id === id) ?? formats.find((f) => f.id === (s?.default_format ?? DEFAULT_TAG_SETTINGS.default_format)) ?? SHEET_FORMATS[0]!;
}

export function slotsPerSheet(f: SheetFormat): number {
  return f.cols * f.rows;
}

// Slot indices in the order empty slots get filled. Row-major reads like text; column-major fills
// down each column first (handy when cutting a sheet into vertical strips).
export function scanOrder(f: Pick<SheetFormat, "cols" | "rows">, fill: "row" | "col"): number[] {
  const out: number[] = [];
  if (fill === "row") {
    for (let i = 0; i < f.cols * f.rows; i++) out.push(i);
  } else {
    for (let c = 0; c < f.cols; c++) for (let r = 0; r < f.rows; r++) out.push(r * f.cols + c);
  }
  return out;
}

// Top-left corner of slot i on the sheet, mm from the page origin (offsets already applied).
export function slotPos(f: SheetFormat, i: number, offsetX: number, offsetY: number): { left: number; top: number } {
  return {
    left: f.marginX + offsetX + (i % f.cols) * (f.w + f.gapX),
    top: f.marginY + offsetY + Math.floor(i / f.cols) * (f.h + f.gapY),
  };
}

// Geometry of a label's text column, mm. The QR sits on the left, so the text gets what is left of
// the label after the padding, the code and the gap; the 1D barcode sits underneath, so the text
// gets the full inner width but only the height above the barcode.
export function labelTextBox(f: SheetFormat, codeType: "qr" | "code128"): { width: number; height: number } {
  const pad = f.h * 0.04;
  const inner = f.w - pad * 2;
  if (codeType === "qr") return { width: inner - f.h * 0.78 - f.h * 0.05, height: f.h - pad * 2 };
  return { width: inner, height: f.h - pad * 2 - f.h * 0.34 };
}

// A sticker is printed once and then read by a human and a scanner, so text that does not fit is
// WRAPPED and SHRUNK, never cut: a truncated asset name or serial is worse than a small one. Callers
// pass the measurement so the on-screen preview (canvas/Arial) and the exported PDF (pdf-lib/Helvetica)
// reach the same answer - the two faces are metric-compatible.
export type MeasureText = (text: string, size: number, bold: boolean) => number;

export const LABEL_LINE_HEIGHT = 1.25;
export const MIN_LABEL_MM = 1.1; // below this the print smears; nothing readable is gained by going on
export const LINE_MIN_SCALE = 0.8; // how far ONE line may shrink to stay on one line before it wraps
const SCALE_STEP = 0.02;

export type LabelLineSpec = { text: string; frac: number; bold?: boolean };
export type FittedLine = { text: string; size: number; bold: boolean; spec: number };
export type FittedBlock = { lines: FittedLine[]; scale: number };

// The pieces a line may be broken between: words, and inside a word, the runs a separator ends. Tags
// and serials are single "words" full of separators (YCPL-AST-001-23424242), and breaking one after a
// hyphen reads as the tag it is, where breaking it mid-run does not. The separator stays on the line
// it ends, the way a hyphenated word breaks in print.
export type LabelChunk = { text: string; space: boolean }; // space = a word boundary precedes it

export function labelChunks(text: string): LabelChunk[] {
  const out: LabelChunk[] = [];
  text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean).forEach((word, w) => {
    (word.match(/[^-/_]*[-/_]|[^-/_]+/g) ?? [word]).forEach((part, i) => out.push({ text: part, space: i === 0 && w > 0 }));
  });
  return out;
}

// Greedy wrap at a given size. A chunk too wide to stand alone is broken by character - the last resort,
// reached only when a single unseparated run is wider than the whole column.
export function wrapLabelLine(text: string, maxWidth: number, size: number, bold: boolean, measure: MeasureText): string[] {
  const chunks = labelChunks(text);
  if (!chunks.length) return [];
  if (maxWidth <= 0) return [chunks.map((c) => (c.space ? " " : "") + c.text).join("")];
  const out: string[] = [];
  let cur = "";
  const pushBroken = (chunk: string) => {
    let part = "";
    for (const ch of chunk) {
      if (part && measure(part + ch, size, bold) > maxWidth) {
        out.push(part);
        part = ch;
      } else part += ch;
    }
    cur = part;
  };
  for (const chunk of chunks) {
    const candidate = cur ? cur + (chunk.space ? " " : "") + chunk.text : chunk.text;
    if (!cur || measure(candidate, size, bold) <= maxWidth) {
      cur = candidate;
      continue;
    }
    out.push(cur);
    cur = "";
    if (measure(chunk.text, size, bold) <= maxWidth) cur = chunk.text;
    else pushBroken(chunk.text);
  }
  if (cur) out.push(cur);
  return out;
}

// The label's lines in print order, each sized as a fraction of the label height. Blank entries are
// dropped by the layout, so a caller turns a line off by passing "". Line index doubles as the ink
// colour index for both renderers (0 org, 1 tag, 2 name, 3 serial, 4 footer).
export type LabelContent = { org?: string; tag: string; name?: string; serial?: string; footer?: string };

export function labelLineSpecs(c: LabelContent): LabelLineSpec[] {
  return [
    { text: c.org ?? "", frac: 0.07 },
    { text: c.tag, frac: 0.12, bold: true },
    { text: c.name ?? "", frac: 0.08 },
    { text: c.serial ? `SN ${c.serial}` : "", frac: 0.07 },
    { text: c.footer ?? "", frac: 0.065 },
  ];
}

// One line's fit. Wrapping is free - a second line buys back the whole width - so text that is merely
// too long WRAPS at full size and stays readable. The size only comes down for the one thing wrapping
// cannot solve: a single unbreakable CHUNK wider than the column (a long serial, one run of a tag),
// where breaking mid-run reads worse than smaller type. That shrink is bounded by LINE_MIN_SCALE and by
// the physical floor; past it the run does break. Column height is the block's problem, below.
export function fitLabelLine(
  text: string,
  maxWidth: number,
  size: number,
  bold: boolean,
  measure: MeasureText,
  minScale = LINE_MIN_SCALE,
): { lines: string[]; size: number } {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return { lines: [], size };
  if (maxWidth <= 0) return { lines: [clean], size };
  if (measure(clean, size, bold) <= maxWidth) return { lines: [clean], size };
  const longest = Math.max(...labelChunks(clean).map((c) => measure(c.text, size, bold)));
  if (longest <= maxWidth) return { lines: wrapLabelLine(clean, maxWidth, size, bold, measure), size };
  const floor = Math.max(size * minScale, Math.min(size, MIN_LABEL_MM));
  const fitted = Math.max(floor, (size * maxWidth) / longest);
  return { lines: wrapLabelLine(clean, maxWidth, fitted, bold, measure), size: fitted };
}

// Lay the whole text column out at one scale so the type hierarchy survives the shrink: try full size,
// then step down until the fitted lines fit the box height. `reserved` is height already spent in the
// column (the logo). At the floor the block is returned as-is - the caller's box clips it - but by then
// the type is at MIN_LABEL_MM, which no sane sheet format reaches.
export function fitLabelBlock(
  specs: LabelLineSpec[],
  box: { width: number; height: number },
  labelHeight: number,
  measure: MeasureText,
  reserved = 0,
): FittedBlock {
  const live = specs.filter((s) => s.text.trim());
  const smallest = Math.min(...live.map((s) => s.frac * labelHeight), Infinity);
  const floor = Number.isFinite(smallest) && smallest > 0 ? Math.min(1, MIN_LABEL_MM / smallest) : 1;
  let last: FittedBlock = { lines: [], scale: 1 };
  for (let scale = 1; ; scale -= SCALE_STEP) {
    if (scale < floor) scale = floor;
    const lines: FittedLine[] = [];
    let used = reserved;
    for (const spec of live) {
      const bold = !!spec.bold;
      const fit = fitLabelLine(spec.text, box.width, spec.frac * labelHeight * scale, bold, measure);
      for (const text of fit.lines) {
        lines.push({ text, size: fit.size, bold, spec: specs.indexOf(spec) });
        used += fit.size * LABEL_LINE_HEIGHT;
      }
    }
    last = { lines, scale };
    if (used <= box.height || scale <= floor) return last;
  }
}

// The resolved tag pattern: settings merged over defaults, with the prefix falling back to the org name's
// initials. Tags themselves are ALLOCATED BY THE SERVER (src/domain/assetTag.ts) - this exists so the settings
// panel can show what the pattern produces, and mirrors the server's resolution so the preview is honest.
export type TagConfig = { prefix: string; separator: string; digits: number };

export function resolveTagConfig(orgName: string, s?: AssetTagSettings): TagConfig {
  return {
    prefix: s?.prefix?.trim() || orgPrefix(orgName),
    separator: s?.separator ?? DEFAULT_TAG_SETTINGS.separator,
    digits: s?.digits && Number.isInteger(s.digits) && s.digits >= 1 && s.digits <= 6 ? s.digits : DEFAULT_TAG_SETTINGS.digits,
  };
}

// Tag prefix derived from the org name's initials (e.g. "Meridian Systems" -> MS).
export function orgPrefix(orgName: string): string {
  const initials = orgName
    .split(/\s+/)
    .map((w) => w[0])
    .filter((ch) => ch && /[a-zA-Z0-9]/.test(ch))
    .join("")
    .toUpperCase();
  return initials.slice(0, 4) || FALLBACK_TAG_CODE;
}

/** What the pattern produces for a category's code and a sequence - the settings preview, not an allocation. */
export function formatTag(cfg: TagConfig, tagCode: string | null | undefined, n: number): string {
  const code = tagCode?.trim().toUpperCase() || FALLBACK_TAG_CODE;
  return [cfg.prefix, code, String(n).padStart(cfg.digits, "0")].filter(Boolean).join(cfg.separator);
}

// What lands inside the printed code. Size matters: at ~16.5mm and EC level M, payloads should stay
// short or module density hurts scan reliability - which is why the structured mode is `tag | SN:x`,
// not JSON. `origin` is the app origin (location.origin at the call site; injectable for tests).
// The `link` mode carries the asset's tag secret (`?s=`) as well as its id, and that is what makes the
// sticker worth scanning: the server accepts a custody confirmation only from someone who produced the
// secret, which lives on the physical label and nowhere a normal reader of the app can see. Passing no
// secret still produces a working deep link (older stickers, and the plain-text modes).
export function buildScanPayload(mode: QrMode, a: { id: string; tag?: string | null; serial?: string | null; secret?: string | null }, origin: string): string {
  if (mode === "tag" && a.tag) return a.tag;
  if (mode === "tag_serial" && a.tag) return a.serial ? `${a.tag} | SN:${a.serial}` : a.tag;
  if (mode === "found") return `${origin}/found/${a.id}`;
  return `${origin}/assets/${a.id}${a.secret ? `?s=${a.secret}` : ""}`;
}

// Inverse of buildScanPayload for the scanners: whatever shape the sticker encodes (deep link, found URL,
// plain tag, tag+serial - or a hand-typed tag), resolve it to an asset id or tag, plus the tag secret when
// the code carried one. The raw text travels on to the server as the proof; this only decides WHICH asset
// the scan is about.
export type ScanRef = ({ id: string } | { tag: string }) & { secret?: string };
export function parseScanPayload(text: string): ScanRef | null {
  const t = text.trim();
  if (!t) return null;
  const secret = t.match(/[?&]s=([A-Za-z0-9]+)/)?.[1];
  // `#/assets/<id>` as well as `/assets/<id>`: the app moved off hash routes, but a sticker is a physical
  // object with its own URL printed on it, and one already on a laptop lid has to keep scanning.
  const deepLink = t.match(/(?:#)?\/assets\/([A-Za-z0-9_-]+)(?:\?[^\s]*)?\s*$/);
  if (deepLink) return { id: deepLink[1]!, ...(secret ? { secret } : {}) };
  const foundUrl = t.match(/\/found\/([A-Za-z0-9_-]+)(?:\?[^\s]*)?\s*$/);
  if (foundUrl) return { id: foundUrl[1]!, ...(secret ? { secret } : {}) };
  if (/^https?:\/\//i.test(t)) return null; // some other URL - not one of ours
  const serialised = t.match(/^(.+?)\s*\|\s*SN:/);
  if (serialised) return { tag: serialised[1]!.trim() };
  return { tag: t };
}

// A MANUFACTURER's barcode read off the device itself, on its way into the serial-number field. Vendor labels
// are not a format we control, so the decoded text arrives with whatever the label printer put around the
// serial: a "S/N:" prefix repeated from the human-readable line, the Code 39 delimiters some encoders leave
// in, a GS1 serial application identifier, stray whitespace. What the reader wants in the field is the serial,
// so strip the packaging here rather than making them edit it by hand every time.
//
// Deliberately conservative: anything it does not recognise passes through trimmed and untouched, because a
// wrong "cleanup" of an unusual serial is worse than a prefix left on. Our OWN tag_serial sticker is the one
// composite it does understand (see buildScanPayload) - scanning that gives the serial straight away.
export function cleanScannedSerial(raw: string): string {
  let t = raw.trim();
  const ours = t.match(/\|\s*SN:\s*(.+)$/i);
  if (ours) t = ours[1]!.trim();
  // Code 39 encoders often emit the start/stop character as part of the text.
  if (/^\*.+\*$/.test(t)) t = t.slice(1, -1).trim();
  // GS1-128, as printed on boxed hardware: application identifier 21 holds the serial, 01 the GTIN before it.
  // Brackets are the human-readable convention and may or may not survive into the encoded data, and a
  // variable-length element ends at the FNC1 group separator (or the end of the string).
  const gs1 = t.match(/^\(?01\)?\d{14}\(?21\)?([^\x1d(]+)/) ?? t.match(/\(21\)([^\x1d(]+)/);
  if (gs1) t = gs1[1]!.trim();
  // "S/N: X", "SN X", "Serial No. X" - the label's own caption, encoded along with the value. A separator has
  // to follow, or a serial that merely begins with those letters (SNXW7781) would lose its head.
  t = t.replace(/^(?:s\s*\/?\s*n|serial(?:\s*(?:no\.?|number|#))?)(?:\s*[:#.]\s*|\s+)/i, "").trim();
  return t;
}

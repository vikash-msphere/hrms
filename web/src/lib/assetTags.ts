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
  separator?: string; // joins prefix / category / number
  digits?: number; // zero-padded number width, 1-6
  category_codes?: Record<string, string>; // category -> short code, merged over the built-ins
  default_format?: string; // sheet format id the printer opens with
  custom_formats?: SheetFormat[]; // org-specific sticker sheets, offered alongside the presets
  qr_mode?: QrMode; // what the code encodes by default
  code_type?: "qr" | "code128"; // 2D QR or 1D barcode (for orgs with laser scanners; always encodes the tag text)
  label?: { name?: boolean; serial?: boolean; org?: boolean; logo?: boolean; footer?: string }; // default label content (+ optional footer line, e.g. "If found: hr@x.com")
  found_page?: { enabled?: boolean; contact?: string; show_name?: boolean }; // public /found/<id> lookup
};

// Common A4 self-adhesive label grids (Avery-style). Dimensions are the de-facto standard layouts;
// the printer's X/Y offset nudges absorb per-printer drift, so exactness to the sticker brand's
// datasheet matters less than symmetry.
export const SHEET_FORMATS: SheetFormat[] = [
  { id: "a4-65", label: "65 per sheet — 38.1 × 21.2 mm", cols: 5, rows: 13, w: 38.1, h: 21.2, marginX: 4.75, marginY: 10.7, gapX: 2.5, gapY: 0 },
  { id: "a4-40", label: "40 per sheet — 45.7 × 25.4 mm", cols: 4, rows: 10, w: 45.7, h: 25.4, marginX: 9.85, marginY: 21.5, gapX: 2.5, gapY: 0 },
  { id: "a4-24", label: "24 per sheet — 63.5 × 33.9 mm", cols: 3, rows: 8, w: 63.5, h: 33.9, marginX: 7.25, marginY: 12.9, gapX: 2.5, gapY: 0 },
  { id: "a4-21", label: "21 per sheet — 63.5 × 38.1 mm", cols: 3, rows: 7, w: 63.5, h: 38.1, marginX: 7.25, marginY: 15.15, gapX: 2.5, gapY: 0 },
];

// Category -> short code fallbacks for generated tags ("Laptop" -> LAP); the org overrides/extends
// these via settings. Unknown categories fall back to their first three letters; uncategorised
// assets get AST.
export const DEFAULT_CATEGORY_CODES: Record<string, string> = { Laptop: "LAP", Phone: "PHN", Monitor: "MON", Peripheral: "PER", Furniture: "FUR", Other: "OTH" };

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

// The resolved tag-generation config the printer actually uses: settings merged over defaults,
// with the prefix falling back to the org name's initials.
export type TagConfig = { prefix: string; separator: string; digits: number; categoryCodes: Record<string, string> };

export function resolveTagConfig(orgName: string, s?: AssetTagSettings): TagConfig {
  return {
    prefix: s?.prefix?.trim() || orgPrefix(orgName),
    separator: s?.separator ?? DEFAULT_TAG_SETTINGS.separator,
    digits: s?.digits && Number.isInteger(s.digits) && s.digits >= 1 && s.digits <= 6 ? s.digits : DEFAULT_TAG_SETTINGS.digits,
    categoryCodes: { ...DEFAULT_CATEGORY_CODES, ...(s?.category_codes ?? {}) },
  };
}

export function categoryCode(codes: Record<string, string>, category?: string | null): string {
  const c = category?.trim();
  if (!c) return "AST";
  return codes[c]?.trim().toUpperCase() ?? (c.replace(/[^a-zA-Z0-9]/g, "").slice(0, 3).toUpperCase() || "AST");
}

// Tag prefix derived from the org name's initials (e.g. "Meridian Systems" -> MS).
export function orgPrefix(orgName: string): string {
  const initials = orgName
    .split(/\s+/)
    .map((w) => w[0])
    .filter((ch) => ch && /[a-zA-Z0-9]/.test(ch))
    .join("")
    .toUpperCase();
  return initials.slice(0, 4) || "AST";
}

export function formatTag(cfg: TagConfig, category: string | null | undefined, n: number): string {
  const cat = categoryCode(cfg.categoryCodes, category);
  return [cfg.prefix, cat, String(n).padStart(cfg.digits, "0")].filter(Boolean).join(cfg.separator);
}

// Next free tag in the configured pattern given every tag already taken (inventory rows plus tags
// assigned in this session whose reload hasn't landed yet).
export function nextTag(cfg: TagConfig, category: string | null | undefined, existingTags: Iterable<string | null | undefined>): string {
  const cat = categoryCode(cfg.categoryCodes, category);
  const sep = escapeRe(cfg.separator);
  const re = new RegExp(`^${cfg.prefix ? escapeRe(cfg.prefix) + sep : ""}${escapeRe(cat)}${sep}(\\d+)$`);
  let max = 0;
  for (const tag of existingTags) {
    const m = tag?.match(re);
    if (m) max = Math.max(max, parseInt(m[1]!, 10));
  }
  return formatTag(cfg, category, max + 1);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// What lands inside the printed code. Size matters: at ~16.5mm and EC level M, payloads should stay
// short or module density hurts scan reliability - which is why the structured mode is `tag | SN:x`,
// not JSON. `origin` is the app origin (location.origin at the call site; injectable for tests).
export function buildScanPayload(mode: QrMode, a: { id: string; tag?: string | null; serial?: string | null }, origin: string): string {
  if (mode === "tag" && a.tag) return a.tag;
  if (mode === "tag_serial" && a.tag) return a.serial ? `${a.tag} | SN:${a.serial}` : a.tag;
  if (mode === "found") return `${origin}/found/${a.id}`;
  return `${origin}/#/assets/${a.id}`;
}

// Inverse of buildScanPayload for the stocktake scanner: whatever shape the sticker encodes (deep
// link, found URL, plain tag, tag+serial - or a hand-typed tag), resolve it to an asset id or tag.
export function parseScanPayload(text: string): { id: string } | { tag: string } | null {
  const t = text.trim();
  if (!t) return null;
  const deepLink = t.match(/#\/assets\/([A-Za-z0-9_-]+)\s*$/);
  if (deepLink) return { id: deepLink[1]! };
  const foundUrl = t.match(/\/found\/([A-Za-z0-9_-]+)\s*$/);
  if (foundUrl) return { id: foundUrl[1]! };
  if (/^https?:\/\//i.test(t)) return null; // some other URL - not one of ours
  const serialised = t.match(/^(.+?)\s*\|\s*SN:/);
  if (serialised) return { tag: serialised[1]!.trim() };
  return { tag: t };
}

// Tags appearing on more than one asset - printing would produce identical stickers for different
// hardware, so the picker flags them.
export function duplicateTags(tags: Iterable<string | null | undefined>): Set<string> {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const t of tags) {
    if (!t) continue;
    if (seen.has(t)) dups.add(t);
    seen.add(t);
  }
  return dups;
}

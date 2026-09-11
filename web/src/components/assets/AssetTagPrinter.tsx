import { useEffect, useMemo, useRef, useState, type ReactNode, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { Printer, X, Search, AlertTriangle, Check, Ruler, Eraser, FilePlus2, FileDown, Crosshair, Ban, Trash2 } from "lucide-react";
import { get, invoke } from "@/api";
import { cn, idOf, formatDate } from "@/lib/utils";
import type { Asset, AssetCategory, Me } from "@/types";
import { useOrg } from "@/lib/org";
import {
  allFormats, formatById, slotsPerSheet, scanOrder, slotPos, buildScanPayload,
  fitLabelBlock, labelLineSpecs, labelTextBox, LABEL_LINE_HEIGHT,
  DEFAULT_TAG_SETTINGS, type AssetTagSettings, type SheetFormat, type QrMode,
} from "@/lib/assetTags";
import { useCollection } from "@/hooks/useCollection";
import { SettingsButton } from "@/components/common/SettingsButton";
import { useConfirm } from "@/components/common/confirm";
import { PanelSkeleton } from "@/components/common/Skeletons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/components/ui/use-toast";
import { getSetting } from "@/lib/settingsStore";

// Physical sticker-sheet asset-tag printer. Policy is org DATA, not code: the tag pattern, sheet formats
// (presets + org custom grids) and default code/label content come from the `settings/asset-tags` blob
// (gear in the header, same panel as Settings → Asset tags). Tags print straight from the real inventory
// rows - the asset's saved asset_tag is what lands on the sticker, and nothing here invents one: the
// server allocated it when the asset was created (services/assets.ts), so print and database cannot drift.
// The code can be a QR (deep link, public found-page URL, or plain text) or a Code128 barcode for
// orgs with 1D laser scanners. "Mark printed"
// stamps `tag_printed_time` on each asset (server data - visible to every device and teammate).
//
// Only genuinely device-bound state lives in localStorage: printer offsets and the used/queued slot
// map of the physical sheet sitting at this desk.

const STORE_KEY = "hrms.assetTagSheet.v3";

// A cell is free (null), spent on the physical sheet ("used"), or queued with an asset id.
type Cell = null | "used" | { assetId: string };
type CodeType = "qr" | "code128";
type Show = { name: boolean; serial: boolean; org: boolean; logo: boolean; footer: boolean };
type StoredState = {
  sheets: Cell[][]; // sheet 1 may be a partially used physical sheet; overflow spills onto fresh ones
  formatId: string; // the format the stored sheets are laid out for
  offsetX: number;
  offsetY: number;
  fill: "row" | "col";
};

function blankSheet(f: SheetFormat): Cell[] {
  return Array.from({ length: slotsPerSheet(f) }, () => null);
}

function loadStored(settings?: AssetTagSettings): StoredState {
  const defFormat = formatById(settings?.default_format, settings);
  const base: StoredState = { sheets: [blankSheet(defFormat)], formatId: defFormat.id, offsetX: 0, offsetY: 0, fill: "row" };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    const fmt = formatById(parsed.formatId, settings);
    const total = slotsPerSheet(fmt);
    const sheets = Array.isArray(parsed.sheets) && parsed.sheets.length > 0
      ? parsed.sheets.map((sheet) => Array.from({ length: total }, (_, i) => (Array.isArray(sheet) ? ((sheet[i] ?? null) as Cell) : null)))
      : [blankSheet(fmt)];
    const stored = { ...base, ...parsed, formatId: fmt.id, sheets };
    // A pristine stored sheet adopts the org's default format; one holding used marks or a queue
    // describes a real physical sheet of its own geometry, so it keeps it.
    if (stored.formatId !== defFormat.id && sheets.length === 1 && sheets[0].every((c) => c === null)) {
      return { ...stored, formatId: defFormat.id, sheets: [blankSheet(defFormat)] };
    }
    return stored;
  } catch {
    return base;
  }
}

// Centered modal shell (not fullscreen - the preview zooms, so it doesn't need the whole viewport).
// Click on the dimmed backdrop closes, clicks inside don't.
function Backdrop({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* dvh so the toolbar and the sheet both stay inside the visible viewport on a phone. */}
      <div className="flex h-full max-h-[94dvh] w-full max-w-[1500px] flex-col overflow-hidden rounded-lg border bg-background shadow-lg">{children}</div>
    </div>
  );
}

type LabelData = { tag: string; name: string; serial?: string; codeDataUrl?: string };

// Text width in mm for the label font, from one offscreen canvas. Width scales linearly with the font
// size, so each string is measured once at 100px and scaled - a full sheet is 65 labels.
let measureCtx: CanvasRenderingContext2D | null | undefined;
const measureCache = new Map<string, number>();
function measureMm(text: string, sizeMm: number, bold: boolean): number {
  const key = (bold ? "bold|" : "reg|") + text;
  let unit = measureCache.get(key);
  if (unit === undefined) {
    if (measureCtx === undefined) measureCtx = document.createElement("canvas").getContext("2d");
    if (!measureCtx) return text.length * sizeMm * 0.55; // no canvas: rough average glyph width
    measureCtx.font = `${bold ? "bold " : ""}100px Arial, Helvetica, sans-serif`;
    unit = measureCtx.measureText(text).width / 100;
    measureCache.set(key, unit);
  }
  return unit * sizeMm;
}

// Ink per line, indexed the way labelLineSpecs() orders them (org, tag, name, serial, footer).
const LINE_COLOR = ["#555", "#000", "#333", "#555", "#555"];

// One printed label, all dimensions derived from the label height so every sheet format gets a
// proportionate layout. QR: code left, text right. Code128: text on top, wide barcode along the
// bottom. Paper is white regardless of app theme.
function Label({ data, org, show, footer, logo, f, codeType }: { data: LabelData; org: string; show: Show; footer?: string; logo?: string; f: SheetFormat; codeType: CodeType }) {
  const qr = Math.round(f.h * 0.78 * 10) / 10;
  const box = labelTextBox(f, codeType);
  const withLogo = show.org && show.logo && !!logo;
  // A long asset name neither widens the label nor spills off it: the whole column is wrapped and, only
  // if the wrapped lines still overflow, scaled down as one block. Nothing is ever cut. Same helper as
  // the PDF export, so the sticker on screen is the sticker on paper.
  const fitted = fitLabelBlock(
    labelLineSpecs({
      org: show.org && !withLogo ? org : "",
      tag: data.tag,
      name: show.name ? data.name : "",
      serial: show.serial ? data.serial : "",
      footer: show.footer ? footer : "",
    }),
    box,
    f.h,
    measureMm,
    withLogo ? f.h * 0.14 * 1.2 : 0,
  );
  const text = (
    <div style={{ marginLeft: codeType === "qr" ? `${(f.h * 0.05).toFixed(2)}mm` : 0, minWidth: 0, overflow: "hidden", lineHeight: LABEL_LINE_HEIGHT }}>
      {withLogo && (
        <img src={logo} alt="" style={{ height: `${(f.h * 0.14).toFixed(2)}mm`, maxWidth: `${box.width.toFixed(2)}mm`, objectFit: "contain", display: "block", marginBottom: `${(f.h * 0.14 * 0.2).toFixed(2)}mm` }} />
      )}
      {fitted.lines.map((l, i) => (
        <div key={i} style={{ fontSize: `${l.size.toFixed(3)}mm`, fontWeight: l.bold ? 700 : undefined, color: LINE_COLOR[l.spec], whiteSpace: "pre" }}>{l.text}</div>
      ))}
    </div>
  );
  if (codeType === "code128") {
    return (
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: "100%", minWidth: 0, height: "100%", overflow: "hidden" }}>
        {text}
        {data.codeDataUrl ? (
          <img src={data.codeDataUrl} alt="" style={{ width: "100%", height: `${(f.h * 0.34).toFixed(2)}mm`, flexShrink: 0, objectFit: "fill" }} />
        ) : (
          <div style={{ height: `${(f.h * 0.34).toFixed(2)}mm`, flexShrink: 0 }} />
        )}
      </div>
    );
  }
  return (
    <>
      {data.codeDataUrl ? (
        <img src={data.codeDataUrl} alt="" style={{ width: `${qr}mm`, height: `${qr}mm`, flexShrink: 0, imageRendering: "pixelated" }} />
      ) : (
        <div style={{ width: `${qr}mm`, height: `${qr}mm`, flexShrink: 0 }} />
      )}
      {text}
    </>
  );
}

// One absolutely-positioned A4 sheet (210 x 297mm). `interactive` adds slot affordances for the
// on-screen preview (click menu, drag & drop, hover magnifier); the print portal renders the same
// geometry with none of them.
function SheetView({
  cells, f, offsetX, offsetY, labels, org, show, footer, logo, calibrate, codeType, interactive, selected,
  onCellClick, onToggleUsed, onDropOnCell, onHoverCell,
}: {
  cells: Cell[];
  f: SheetFormat;
  offsetX: number;
  offsetY: number;
  labels: Map<string, LabelData>;
  org: string;
  show: Show;
  footer?: string;
  logo?: string;
  calibrate: boolean;
  codeType: CodeType;
  interactive?: boolean;
  selected?: number | null;
  onCellClick?: (i: number, e: ReactMouseEvent) => void;
  onToggleUsed?: (i: number) => void;
  onDropOnCell?: (i: number, data: string) => void;
  onHoverCell?: (i: number, e: ReactMouseEvent | null) => void;
}) {
  return (
    <div style={{ position: "relative", width: "210mm", height: "297mm", background: "#fff", color: "#000", fontFamily: "Arial, Helvetica, sans-serif" }}>
      {cells.map((cell, i) => {
        const { left, top } = slotPos(f, i, offsetX, offsetY);
        const label = cell && cell !== "used" ? labels.get(cell.assetId) : undefined;
        return (
          <div
            key={i}
            onClick={interactive ? (e) => onCellClick?.(i, e) : undefined}
            onContextMenu={interactive ? (e) => { e.preventDefault(); onToggleUsed?.(i); } : undefined}
            draggable={interactive && !!cell && cell !== "used"}
            onDragStart={interactive ? (e) => { if (cell && cell !== "used") e.dataTransfer.setData("text/plain", `slot:${i}`); } : undefined}
            onDragOver={interactive ? (e) => { if (cell === null) e.preventDefault(); } : undefined}
            onDrop={interactive ? (e) => { e.preventDefault(); onDropOnCell?.(i, e.dataTransfer.getData("text/plain")); } : undefined}
            onMouseEnter={interactive && label ? (e) => onHoverCell?.(i, e) : undefined}
            onMouseLeave={interactive && label ? () => onHoverCell?.(i, null) : undefined}
            title={interactive ? (cell === "used" ? "Used slot - click for options" : cell ? `${label?.tag ?? ""} - click for options, drag to move` : "Click for options - or drag an asset here") : undefined}
            style={{
              position: "absolute",
              left: `${left}mm`,
              top: `${top}mm`,
              width: `${f.w}mm`,
              height: `${f.h}mm`,
              overflow: "hidden",
              display: "flex",
              alignItems: "center",
              padding: `${(f.h * 0.04).toFixed(2)}mm`,
              cursor: interactive ? "pointer" : undefined,
              ...(calibrate
                ? { border: "0.15mm solid #999" }
                : interactive
                  ? cell === "used"
                    ? { background: "#eceff3", border: "0.15mm solid #dde2e9" }
                    : cell
                      ? { border: "0.15mm solid hsl(var(--primary) / 0.4)", background: "hsl(var(--primary) / 0.06)" }
                      : selected === i
                        ? { border: "0.3mm solid hsl(var(--primary))", background: "hsl(var(--primary) / 0.12)" }
                        : { border: "0.15mm dashed #cfd6e0" }
                  : {}),
            }}
          >
            {!calibrate && label && <Label data={label} org={org} show={show} footer={footer} logo={logo} f={f} codeType={codeType} />}
            {!calibrate && interactive && cell === "used" && <span style={{ margin: "auto", fontSize: "2mm", color: "#aaa" }}>used</span>}
          </div>
        );
      })}
    </div>
  );
}

export function AssetTagPrinter(props: { me: Me; assets: Asset[]; onClose: () => void; onReload: () => Promise<void> | void; initialAssetIds?: string[] }) {
  // Load the org config first; the body's initial state (format, code mode, label content) derives from it.
  const [tagSettings, setTagSettings] = useState<AssetTagSettings | undefined>();
  const [cfgLoaded, setCfgLoaded] = useState(false);
  useEffect(() => {
    getSetting<AssetTagSettings>("asset-tags")
      .then((s) => setTagSettings(s.value))
      .catch(() => {}) // no row yet / offline -> built-in defaults
      .finally(() => setCfgLoaded(true));
  }, []);

  if (!cfgLoaded) {
    return (
      <Backdrop onClose={props.onClose}>
        <PanelSkeleton className="p-4" />
      </Backdrop>
    );
  }
  return <PrinterBody {...props} tagSettings={tagSettings} />;
}

function PrinterBody({ me, assets, onClose, onReload, initialAssetIds, tagSettings }: { me: Me; assets: Asset[]; onClose: () => void; onReload: () => Promise<void> | void; initialAssetIds?: string[]; tagSettings?: AssetTagSettings }) {
  const { org } = useOrg();
  const { toast } = useToast();
  const confirm = useConfirm();
  // Category names for the label/filter: an asset carries a reference, and the tag it already has carries the
  // category's code, so nothing here needs to compute a tag - only to say what kind of thing this is.
  const { rows: assetCategories } = useCollection<AssetCategory>("asset-categories");
  const catName = useMemo(() => {
    const m = new Map(assetCategories.map((c) => [idOf(c.path), c.display_name ?? ""]));
    return (p?: string | null) => (p ? m.get(idOf(p)) ?? "" : "");
  }, [assetCategories]);
  const [state, setState] = useState<StoredState>(() => loadStored(tagSettings));
  // Session-scoped display choices, defaulted from org config (change them for one run without
  // touching the org's settings; the gear edits the real defaults).
  const [qrMode, setQrModeState] = useState<QrMode>(tagSettings?.qr_mode ?? DEFAULT_TAG_SETTINGS.qr_mode);
  const [codeType, setCodeTypeState] = useState<CodeType>(tagSettings?.code_type ?? "qr");
  const footerText = tagSettings?.label?.footer?.trim() || undefined;
  const [show, setShow] = useState<Show>({ ...DEFAULT_TAG_SETTINGS.label, ...(tagSettings?.label ?? {}), footer: !!footerText });
  const foundEnabled = !!tagSettings?.found_page?.enabled;
  const [calibrate, setCalibrate] = useState(false);
  const [zoom, setZoom] = useState("0.75");
  const [view, setView] = useState<"all" | number>("all"); // which sheet the preview shows when there are many
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  // Every asset already has a tag, so the queue that matters is the one that has no sticker on it yet.
  const [unprintedOnly, setUnprintedOnly] = useState(false);
  const [marking, setMarking] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Target slot for the next queued tag ({sheet, slot}); null = first empty in fill order.
  const [selected, setSelected] = useState<{ s: number; i: number } | null>(null);
  // Click-anywhere slot menu (touch/keyboard-reachable alternative to the right-click shortcut).
  const [menu, setMenu] = useState<{ s: number; i: number; x: number; y: number } | null>(null);
  // Hover magnifier: a 2x readable preview of the label under the cursor.
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [printedBanner, setPrintedBanner] = useState(false);
  const [codeUrls, setCodeUrls] = useState<Map<string, string>>(new Map());

  const fmt = formatById(state.formatId, tagSettings);
  const formats = allFormats(tagSettings);

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch {
      /* private mode etc. - sheet state is a convenience, not data */
    }
  }, [state]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (menu) {
        setMenu(null);
        return;
      }
      const t = e.target as HTMLElement | null;
      if (!t?.closest("input, textarea, select, [role=listbox], [role=combobox]")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, menu]);

  // After a real print, offer to mark the queue as printed (can't detect a cancelled dialog, so ask).
  useEffect(() => {
    const onAfter = () => {
      if (!calibrate) setPrintedBanner(true);
    };
    window.addEventListener("afterprint", onAfter);
    return () => window.removeEventListener("afterprint", onAfter);
  }, [calibrate]);

  const byId = useMemo(() => new Map(assets.map((a) => [idOf(a.path), a])), [assets]);
  // Queue as an ordered multiset: the same asset may appear in several slots (spare stickers).
  const queueCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const sheet of state.sheets) for (const c of sheet) if (c && c !== "used") m.set(c.assetId, (m.get(c.assetId) ?? 0) + 1);
    return m;
  }, [state.sheets]);
  const queuedCount = useMemo(() => [...queueCounts.values()].reduce((a, b) => a + b, 0), [queueCounts]);

  // A queued asset deleted elsewhere (or left over in localStorage from another org) frees its slot.
  useEffect(() => {
    if (![...queueCounts.keys()].some((id) => !byId.has(id))) return;
    setState((s) => ({ ...s, sheets: s.sheets.map((sheet) => sheet.map((c) => (c && c !== "used" && !byId.has(c.assetId) ? null : c))) }));
  }, [queueCounts, byId]);

  // Every asset is tagged by the server on create, so this is a read, not a fallback chain.
  const tagOf = (a: Asset) => a.asset_tag ?? "";

  const labels = useMemo(() => {
    const m = new Map<string, LabelData>();
    for (const id of queueCounts.keys()) {
      const a = byId.get(id);
      if (!a) continue;
      m.set(id, { tag: tagOf(a), name: a.name, serial: a.serial_number ?? undefined, codeDataUrl: codeUrls.get(id) });
    }
    return m;
  }, [queueCounts, byId, codeUrls]);

  // Generate code images for queued assets: QR (qrcode lib) or Code128 (jsbarcode), both lazy-loaded.
  // Code128 always encodes the plain tag - that's what 1D laser scanners expect.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const missing = [...queueCounts.keys()].filter((id) => !codeUrls.has(id) && byId.has(id));
      if (missing.length === 0) return;
      let entries: (readonly [string, string])[];
      if (codeType === "code128") {
        const JsBarcode = (await import("jsbarcode")).default;
        entries = missing.flatMap((id) => {
          const a = byId.get(id)!;
          const tag = tagOf(a);
          if (!tag) return [];
          const canvas = document.createElement("canvas");
          try {
            JsBarcode(canvas, tag, { format: "CODE128", displayValue: false, margin: 0, width: 2, height: 60 });
            return [[id, canvas.toDataURL("image/png")] as const];
          } catch {
            return []; // characters Code128 can't encode - slot renders without a barcode
          }
        });
      } else {
        const QRCode = (await import("qrcode")).default;
        entries = await Promise.all(
          missing.map(async (id) => {
            const a = byId.get(id)!;
            const payload = buildScanPayload(qrMode, { id, tag: tagOf(a), serial: a.serial_number, secret: a.tag_secret }, location.origin);
            return [id, await QRCode.toDataURL(payload, { width: 220, margin: 0, errorCorrectionLevel: "M" })] as const;
          }),
        );
      }
      if (!cancelled) setCodeUrls((prev) => new Map([...prev, ...entries]));
    })();
    return () => {
      cancelled = true;
    };
  }, [queueCounts, byId, codeUrls, qrMode, codeType]);

  // Changing what the code encodes (or its symbology) invalidates every generated image.
  function setQrMode(mode: QrMode) {
    setCodeUrls(new Map());
    setQrModeState(mode);
  }
  function setCodeType(t: CodeType) {
    setCodeUrls(new Map());
    setCodeTypeState(t);
  }

  // Switching sheet format keeps the queue (re-flowed in order onto fresh sheets) but drops
  // used-slot marks - they described a physical sheet of the old geometry.
  function setFormat(id: string) {
    const f = formatById(id, tagSettings);
    setSelected(null);
    setView("all");
    setState((s) => {
      const ids = s.sheets.flatMap((sheet) => sheet.flatMap((c) => (c && c !== "used" ? [c.assetId] : [])));
      const total = slotsPerSheet(f);
      const sheets: Cell[][] = [];
      for (let i = 0; i < Math.max(1, Math.ceil(ids.length / total)); i++) {
        sheets.push(Array.from({ length: total }, (_, j) => (ids[i * total + j] ? { assetId: ids[i * total + j] } : null)));
      }
      return { ...s, formatId: f.id, sheets };
    });
  }

  // Drop trailing sheets that hold nothing (always keep sheet 1 - it carries the used marks).
  function prune(sheets: Cell[][]): Cell[][] {
    const out = [...sheets];
    while (out.length > 1 && out[out.length - 1].every((c) => c === null)) out.pop();
    return out;
  }

  function removeAt(s: number, i: number) {
    setState((st) => {
      const sheets = st.sheets.map((sh) => [...sh]);
      sheets[s][i] = null;
      return { ...st, sheets: prune(sheets) };
    });
    setSelected({ s, i }); // freed slot becomes the next target so a misclick is one click to redo
  }
  function setUsed(s: number, i: number, used: boolean) {
    setState((st) => {
      const sheets = st.sheets.map((sh) => [...sh]);
      sheets[s][i] = used ? "used" : null;
      return { ...st, sheets: prune(sheets) };
    });
    setSelected((sel) => (sel?.s === s && sel.i === i ? null : sel));
  }

  function onCellClick(s: number, i: number, e: ReactMouseEvent) {
    // Every slot opens the same small action menu at the cursor - discoverable and touch-friendly
    // (the right-click used-toggle stays as a power-user shortcut).
    setMenu({ s, i, x: Math.min(e.clientX, window.innerWidth - 230), y: Math.min(e.clientY, window.innerHeight - 160) });
  }

  function onToggleUsed(s: number, i: number) {
    const cell = state.sheets[s][i];
    if (cell && cell !== "used") return; // don't wipe a queued tag with a stray right-click
    setUsed(s, i, cell !== "used");
  }

  // Queue an asset into `target`, the aimed slot, or the first empty in fill order (growing onto a
  // fresh sheet when everything is full). The sticker prints the tag the record already carries - the number
  // was allocated when the asset was created, so opening the printer never writes to an asset.
  function queueAsset(a: Asset, target?: { s: number; i: number }): void {
    const id = idOf(a.path);
    setState((st) => {
      const sheets = st.sheets.map((sh) => [...sh]);
      let t: { s: number; i: number } | null =
        target && sheets[target.s]?.[target.i] === null ? target
        : selected && sheets[selected.s]?.[selected.i] === null ? selected
        : null;
      if (!t) {
        const order = scanOrder(fmt, st.fill);
        outer: for (let s = 0; s < sheets.length; s++) {
          for (const i of order) {
            if (sheets[s][i] === null) {
              t = { s, i };
              break outer;
            }
          }
        }
      }
      if (!t) {
        sheets.push(blankSheet(fmt));
        t = { s: sheets.length - 1, i: scanOrder(fmt, st.fill)[0] };
      }
      sheets[t.s][t.i] = { assetId: id };
      return { ...st, sheets };
    });
    setSelected(null);
  }

  // Drag & drop: an asset row dropped on an empty slot queues it right there; a queued label
  // dragged between slots moves it.
  function onDropOnCell(s: number, i: number, data: string) {
    if (state.sheets[s][i] !== null) return;
    const assetDrop = data.match(/^asset:(.+)$/);
    if (assetDrop) {
      const a = byId.get(assetDrop[1]);
      if (a) void queueAsset(a, { s, i });
      return;
    }
    const slotDrop = data.match(/^slot:(\d+):(\d+)$/);
    if (slotDrop) {
      const from = { s: Number(slotDrop[1]), i: Number(slotDrop[2]) };
      setState((st) => {
        const cell = st.sheets[from.s]?.[from.i];
        if (!cell || cell === "used") return st;
        const sheets = st.sheets.map((sh) => [...sh]);
        sheets[from.s][from.i] = null;
        sheets[s][i] = cell;
        return { ...st, sheets: prune(sheets) };
      });
    }
  }

  function bulkAdd(list: Asset[]) {
    for (const a of list) queueAsset(a);
  }

  // The physical outcome of a successful print: queued slots on sheet 1 are now spent stickers,
  // overflow sheets came off fresh sheets (nothing to remember), and every printed asset gets its
  // `tag_printed_time` stamped on the SERVER - so "printed" is visible to every device and teammate.
  async function markPrinted() {
    const ids = [...queueCounts.keys()];
    let stamped = 0;
    let skipped = 0;
    setMarking(true);
    try {
      for (const id of ids) {
        const a = byId.get(id);
        if (!a || !(a.access?.can?.includes("printTag") ?? false)) {
          skipped++;
          continue;
        }
        try {
          // The verb owns the stamp (and mints a tag secret if the row somehow lacks one), so the printed
          // sticker and the server's idea of "printed" can never disagree.
          await invoke(a.path, "printTag");
          stamped++;
        } catch {
          skipped++;
        }
      }
      await onReload();
    } finally {
      setMarking(false);
    }
    setState((st) => ({ ...st, sheets: prune([st.sheets[0].map((c) => (c && c !== "used" ? ("used" as Cell) : c))]) }));
    setSelected(null);
    setView("all");
    setPrintedBanner(false);
    toast({
      title: "Marked printed",
      description: `Print date recorded on ${stamped} asset${stamped === 1 ? "" : "s"}${skipped ? ` (${skipped} skipped - no edit access or a save failed)` : ""}; slots freed on the sheet map.`,
      variant: skipped ? "default" : "success",
    });
  }

  async function newSheet() {
    const dirty = queuedCount > 0 || state.sheets[0].some((c) => c === "used");
    if (dirty && !(await confirm({ title: "Start a new blank sheet?", description: "Clears the queue and every used-slot mark. Do this when you load a fresh, unused sticker sheet.", confirmLabel: "New sheet" }))) return;
    setState((st) => ({ ...st, sheets: [blankSheet(fmt)] }));
    setSelected(null);
    setView("all");
  }
  async function clearQueue() {
    if (!(await confirm({ title: "Clear the queue?", description: `Takes all ${queuedCount} queued tag${queuedCount === 1 ? "" : "s"} off the sheets. Used-slot marks stay.`, confirmLabel: "Clear queue" }))) return;
    setState((st) => ({ ...st, sheets: prune(st.sheets.map((sh) => sh.map((c) => (c && c !== "used" ? null : c)))) }));
    setSelected(null);
    setView("all");
  }

  // Deterministic alternative to the browser print dialog (which silently rescales): a PDF with the
  // exact same geometry, one page per sheet.
  async function exportPdf() {
    setExporting(true);
    try {
      const { buildTagSheetsPdf, downloadPdf } = await import("@/lib/assetTagsPdf");
      const pdfSheets = state.sheets.map((sheet) => sheet.map((c) => (c && c !== "used" ? labels.get(c.assetId) ?? null : null)));
      const bytes = await buildTagSheetsPdf({
        format: fmt,
        offsetX: state.offsetX,
        offsetY: state.offsetY,
        sheets: pdfSheets,
        orgName: org.name,
        logoDataUrl: org.logo,
        show,
        footer: show.footer ? footerText : undefined,
        codeType,
        calibrate,
      });
      downloadPdf(bytes, calibrate ? "tag-sheet-calibration.pdf" : "asset-tags.pdf");
    } catch (e) {
      toast({ variant: "destructive", title: "PDF export failed", description: (e as Error).message });
    } finally {
      setExporting(false);
    }
  }

  // Queue the launching rows once: one asset from the per-row "print tag" action on the Assets table, or the
  // whole run a bulk add just created - twenty new adapters want twenty stickers, and having to find them in
  // the picker is the boring half of the job the printer is for.
  const initialDone = useRef(false);
  useEffect(() => {
    if (initialDone.current || !initialAssetIds?.length) return;
    const opening = initialAssetIds.map((id) => byId.get(id)).filter((a): a is Asset => !!a);
    // Nothing matched YET: a run created a moment ago reaches this list only once the page's reload lands, so
    // stay armed rather than spending the one chance on a stale inventory.
    if (!opening.length) return;
    initialDone.current = true;
    const tagged = opening.filter((a) => a.asset_tag);
    // Don't silently PATCH a generated tag just from opening - surface the row instead.
    if (tagged.length) bulkAdd(tagged);
    else if (opening[0]) setSearch(opening[0].name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAssetIds, byId]);

  // Only the categories something in this inventory is actually filed under - an empty catalog entry is not a
  // useful filter here.
  const categories = useMemo(() => {
    const used = new Set(assets.map((a) => a.category).filter((c): c is string => !!c));
    return assetCategories.filter((c) => used.has(c.path));
  }, [assets, assetCategories]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return assets.filter((a) => {
      if (catFilter !== "all" && a.category !== catFilter) return false;
      if (statusFilter !== "all" && a.status !== statusFilter) return false;
      if (unprintedOnly && a.tag_printed_time) return false;
      if (!q) return true;
      return [a.asset_tag, a.name, catName(a.category), a.serial_number].some((v) => v?.toLowerCase().includes(q));
    });
  }, [assets, search, catFilter, statusFilter, unprintedOnly, catName]);

  const codesPending = [...queueCounts.keys()].some((id) => byId.has(id) && !codeUrls.has(id));
  const freeOnSheet1 = state.sheets[0].filter((c) => c === null).length;
  const menuCell = menu ? state.sheets[menu.s]?.[menu.i] : undefined;
  const visibleSheets: (readonly [Cell[], number])[] =
    view === "all" || state.sheets[view] === undefined ? state.sheets.map((cells, s) => [cells, s] as const) : [[state.sheets[view], view] as const];

  // While the printer is open, the injected rules hide the app and show only the print portal.
  const printCss = `
    @media print {
      @page { size: A4; margin: 0; }
      body.asset-tag-printing > *:not(#asset-tag-print-root) { display: none !important; }
      #asset-tag-print-root { display: block !important; }
    }
  `;
  useEffect(() => {
    document.body.classList.add("asset-tag-printing");
    return () => document.body.classList.remove("asset-tag-printing");
  }, []);

  const sectionTitle = "mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground";

  return (
    <Backdrop onClose={onClose}>
      <style>{printCss}</style>
      {/* Title on one line, the four actions on their own line below it when they will not fit beside it.
          The action group is one flex child rather than four siblings, so it moves as a block instead of
          leaving a stray Close button orphaned on the second line. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
        <Printer className="hidden h-5 w-5 shrink-0 text-muted-foreground sm:block" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Print asset tags</h2>
          {/* The print-settings advice is long and only actionable next to a print dialog, so it is a
              desktop line. The format label is the part worth keeping on a phone. */}
          <p className="truncate text-xs text-muted-foreground">
            {fmt.label}
            <span className="hidden sm:inline"> · print at 100% scale, margins off, headers/footers off - or export the PDF for exact output.</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <SettingsButton me={me} settingKey="asset-tags" />
          <Button variant="outline" loading={exporting} disabled={calibrate ? false : queuedCount === 0 || codesPending} onClick={exportPdf} title="Exact-geometry PDF - immune to print-dialog rescaling">
            <FileDown className="h-4 w-4" /> PDF
          </Button>
          <Button onClick={() => window.print()} disabled={calibrate ? false : queuedCount === 0 || codesPending}>
            <Printer className="h-4 w-4" />
            {/* "Print calibration outline" / "Print 24 tags" is the desktop label; a phone gets the verb
                and the count, which is all the button needs to say next to a queue it can see. */}
            <span className="hidden sm:inline">Print {calibrate ? "calibration outline" : `${queuedCount} tag${queuedCount === 1 ? "" : "s"}`}</span>
            <span className="sm:hidden">{calibrate ? "Print" : `Print ${queuedCount}`}</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {printedBanner && queuedCount > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-b bg-primary/5 px-4 py-2 text-xs">
          <Check className="h-4 w-4 text-primary" />
          <span className="flex-1 basis-48">Sheet sent to the printer. If it came out right, mark these tags printed - that frees the slots and records the print date on each asset.</span>
          <Button size="sm" loading={marking} onClick={markPrinted}>Mark printed</Button>
          <Button size="sm" variant="ghost" disabled={marking} onClick={() => setPrintedBanner(false)}>Not yet</Button>
        </div>
      )}

      {/* Picker beside sheet on a laptop, stacked on a phone: a 360px fixed pane next to the sheet preview
          does not fit a 390px screen, and side-by-side is not the point - picking the assets and seeing the
          sheet fill up are two steps, and on a phone they are two screens' worth of scroll. */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex w-full flex-shrink-0 flex-col border-b lg:w-[360px] lg:border-b-0 lg:border-r">
          <Tabs defaultValue="add" className="flex min-h-0 flex-1 flex-col">
            <TabsList className="mx-4 mt-3 grid grid-cols-2">
              <TabsTrigger value="add">Add assets</TabsTrigger>
              <TabsTrigger value="options">Options</TabsTrigger>
            </TabsList>
            <TabsContent value="add" className="mt-0 flex min-h-0 flex-1 flex-col p-4 pt-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input type="search" className="pl-8" placeholder="Search tag, name, serial…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div className="mt-2 flex gap-2">
              <Select value={catFilter} onValueChange={setCatFilter}>
                <SelectTrigger className="flex-1 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All categories</SelectItem>
                  {categories.map((c) => <SelectItem key={c.path} value={c.path}>{c.display_name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="flex-1 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any status</SelectItem>
                  <SelectItem value="in_stock">In stock</SelectItem>
                  <SelectItem value="assigned">Assigned</SelectItem>
                  <SelectItem value="repair">In repair</SelectItem>
                  <SelectItem value="retired">Retired</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label className="mt-2 flex items-center gap-2 text-xs">
              <Checkbox checked={unprintedOnly} onCheckedChange={(v) => setUnprintedOnly(v === true)} />
              Never-printed assets only
            </label>
            <div className="mt-2 min-h-0 flex-1 overflow-y-auto rounded-md border">
              {filtered.length === 0 && <div className="p-3 text-xs text-muted-foreground">No matching assets.</div>}
              {filtered.map((a) => {
                const id = idOf(a.path);
                const tag = a.asset_tag;
                const copies = queueCounts.get(id) ?? 0;
                const printedAt = a.tag_printed_time;
                return (
                  <div
                    key={a.path}
                    className="flex items-center gap-2 border-b p-2 text-xs last:border-b-0"
                    draggable={!!tag}
                    onDragStart={(e) => e.dataTransfer.setData("text/plain", `asset:${id}`)}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{a.name}{a.category && <span className="ml-1.5 font-normal text-muted-foreground">· {catName(a.category)}</span>}</div>
                      <div className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
                        {tag ? <span className="font-mono">{tag}</span> : <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400" title="This row predates server-allocated tags - edit it and type a tag to print a sticker"><AlertTriangle className="h-3 w-3" /> no tag</span>}
                        {copies > 0 && <span className="text-primary">queued ×{copies}</span>}
                        {printedAt && !copies && <span title={printedAt}>printed {formatDate(printedAt.slice(0, 10))}</span>}
                      </div>
                    </div>
                    <Button size="sm" variant="outline" disabled={!tag} title={tag ? (copies > 0 ? "Add another copy" : "Add - or drag onto a specific slot") : "This asset has no tag to print"} onClick={() => queueAsset(a)}>
                      Add
                    </Button>
                  </div>
                );
              })}
            </div>
            {filtered.length > 1 && (
              <Button className="mt-2 w-full" size="sm" variant="outline" onClick={() => bulkAdd(filtered.filter((a) => !queueCounts.get(idOf(a.path)) && a.asset_tag))}>
                Add all {filtered.length} filtered
              </Button>
            )}
            </TabsContent>

            <TabsContent value="options" className="mt-0 min-h-0 flex-1 space-y-5 overflow-y-auto p-4 pt-3">
          <div>
            <div className={sectionTitle}>Label content <span className="normal-case text-[10px] font-normal">(this print run - defaults from settings)</span></div>
            <div className="grid gap-1.5 text-xs">
              <label className="flex items-center gap-2"><Checkbox checked={show.name} onCheckedChange={(v) => setShow((s) => ({ ...s, name: v === true }))} /> Asset name</label>
              <label className="flex items-center gap-2"><Checkbox checked={show.serial} onCheckedChange={(v) => setShow((s) => ({ ...s, serial: v === true }))} /> Serial number</label>
              <label className="flex items-center gap-2"><Checkbox checked={show.org} onCheckedChange={(v) => setShow((s) => ({ ...s, org: v === true }))} /> Organization name</label>
              {org.logo && show.org && (
                <label className="flex items-center gap-2 pl-6"><Checkbox checked={show.logo} onCheckedChange={(v) => setShow((s) => ({ ...s, logo: v === true }))} /> Use the logo instead of text</label>
              )}
              {footerText && (
                <label className="flex items-center gap-2"><Checkbox checked={show.footer} onCheckedChange={(v) => setShow((s) => ({ ...s, footer: v === true }))} /> Footer line <span className="truncate text-muted-foreground">“{footerText}”</span></label>
              )}
            </div>
          </div>

          <div>
            <div className={sectionTitle}>Code</div>
            <Select value={codeType} onValueChange={(v) => setCodeType(v as CodeType)}>
              <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="qr">QR code</SelectItem>
                <SelectItem value="code128">Code 128 barcode (1D laser scanners)</SelectItem>
              </SelectContent>
            </Select>
            {codeType === "qr" ? (
              <div className="mt-2">
                <Select value={qrMode} onValueChange={(v) => setQrMode(v as QrMode)}>
                  <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="link">Link to the asset record (scan opens the app)</SelectItem>
                    <SelectItem value="found" disabled={!foundEnabled}>Public found-it page{foundEnabled ? "" : " (enable it in settings)"}</SelectItem>
                    <SelectItem value="tag">Tag text only (works with any scanner)</SelectItem>
                    <SelectItem value="tag_serial">Tag + serial number (plain text)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <p className="mt-1.5 text-xs text-muted-foreground">Barcodes encode the plain tag text.</p>
            )}
          </div>

          <div>
            <div className={sectionTitle}>Sheet format</div>
            <Select value={state.formatId} onValueChange={setFormat}>
              <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{formats.map((f) => <SelectItem key={f.id} value={f.id}>{f.label}</SelectItem>)}</SelectContent>
            </Select>
            <div className="mt-2">
              <Select value={state.fill} onValueChange={(v) => setState((s) => ({ ...s, fill: v as "row" | "col" }))}>
                <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="row">Fill across rows (left to right)</SelectItem>
                  <SelectItem value="col">Fill down columns (for cutting strips)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <div className={sectionTitle}>Printer alignment</div>
            <div className="flex gap-2">
              <label className="flex-1 text-xs text-muted-foreground">
                Offset X (mm)
                <Input type="number" step="0.1" value={state.offsetX} onChange={(e) => setState((s) => ({ ...s, offsetX: parseFloat(e.target.value) || 0 }))} />
              </label>
              <label className="flex-1 text-xs text-muted-foreground">
                Offset Y (mm)
                <Input type="number" step="0.1" value={state.offsetY} onChange={(e) => setState((s) => ({ ...s, offsetY: parseFloat(e.target.value) || 0 }))} />
              </label>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              If prints land slightly off the stickers, use <span className="font-medium">Calibrate</span> above the preview to print outlines on plain paper, then nudge these offsets.
            </p>
          </div>
            </TabsContent>
          </Tabs>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-2 border-b bg-background px-4 py-2">
            <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              <span className={cn("font-medium", queuedCount > 0 && "text-foreground")}>{queuedCount} queued</span>
              {" · "}{freeOnSheet1} free slot{freeOnSheet1 === 1 ? "" : "s"} on sheet 1
              {state.sheets.length > 1 ? ` · ${state.sheets.length} sheets will print` : ""}
            </div>
            {state.sheets.length > 2 && (
              <div className="flex items-center gap-1 text-xs">
                <button className={cn("rounded px-2 py-0.5", view === "all" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")} onClick={() => setView("all")}>All</button>
                {state.sheets.map((_, s) => (
                  <button key={s} className={cn("rounded px-2 py-0.5", view === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")} onClick={() => setView(s)}>{s + 1}</button>
                ))}
              </div>
            )}
            <Button size="sm" variant={calibrate ? "default" : "outline"} onClick={() => setCalibrate(!calibrate)} title="Print outlines only, on plain paper - hold the page against a sticker sheet, then nudge the offsets in Options">
              <Ruler className="h-4 w-4" /> Calibrate
            </Button>
            <Select value={zoom} onValueChange={setZoom}>
              <SelectTrigger className="w-20 text-xs" aria-label="Preview zoom"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="0.5">50%</SelectItem>
                <SelectItem value="0.75">75%</SelectItem>
                <SelectItem value="1">100%</SelectItem>
                <SelectItem value="1.25">125%</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" variant="ghost" onClick={newSheet} title="Reset to one fresh sheet - clears used marks and the queue">
              <FilePlus2 className="h-4 w-4" /> New sheet
            </Button>
            {queuedCount > 0 && (
              <Button size="sm" variant="ghost" onClick={clearQueue} title="Take every queued tag off the sheets (used marks stay)">
                <Eraser className="h-4 w-4" /> Clear queue
              </Button>
            )}
          </div>

          <div className="flex-1 overflow-auto bg-muted/40 p-6">
          {!calibrate && (
            <div className="mb-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5"><span className="h-3 w-4 rounded-[2px] border border-dashed bg-white" style={{ borderColor: "#cfd6e0" }} /> empty</span>
              <span className="flex items-center gap-1.5"><span className="h-3 w-4 rounded-[2px] border-2 bg-primary/10" style={{ borderColor: "hsl(var(--primary))" }} /> next tag lands here</span>
              <span className="flex items-center gap-1.5"><span className="h-3 w-4 rounded-[2px] border bg-primary/5" style={{ borderColor: "hsl(var(--primary) / 0.4)" }} /> queued</span>
              <span className="flex items-center gap-1.5"><span className="h-3 w-4 rounded-[2px] border" style={{ background: "#eceff3", borderColor: "#dde2e9" }} /> used</span>
              <span>click any slot for actions · drag to place</span>
            </div>
          )}
          {!calibrate && queuedCount === 0 && (
            <div className="mx-auto mb-4 w-fit rounded-md border border-dashed px-4 py-1.5 text-center text-xs text-muted-foreground">
              Nothing queued yet - add assets from the left (or drag one onto a slot).
            </div>
          )}
          <div className="mx-auto w-fit space-y-6" style={{ zoom: Number(zoom) }}>
            {visibleSheets.map(([cells, s]) => (
              <div key={s}>
                {state.sheets.length > 1 && <div className="mb-1 text-xs font-medium text-muted-foreground">Sheet {s + 1}{s > 0 ? " (load a fresh sheet)" : ""}</div>}
                <div className="shadow-lg">
                  <SheetView
                    cells={cells}
                    f={fmt}
                    offsetX={state.offsetX}
                    offsetY={state.offsetY}
                    labels={labels}
                    org={org.name}
                    show={show}
                    footer={footerText}
                    logo={org.logo}
                    calibrate={calibrate}
                    codeType={codeType}
                    interactive
                    selected={selected?.s === s ? selected.i : null}
                    onCellClick={(i, e) => onCellClick(s, i, e)}
                    onToggleUsed={(i) => onToggleUsed(s, i)}
                    onDropOnCell={(i, data) => onDropOnCell(s, i, data)}
                    onHoverCell={(i, e) => {
                      const cell = state.sheets[s][i];
                      if (!e || !cell || cell === "used") setHover(null);
                      else setHover({ id: cell.assetId, x: Math.min(e.clientX + 14, window.innerWidth - 320), y: Math.min(e.clientY + 14, window.innerHeight - 180) });
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
          </div>
        </div>
      </div>

      {/* Slot action menu - opened by clicking any slot; touch/keyboard-reachable. */}
      {menu && menuCell !== undefined && (
        <>
          <div className="fixed inset-0 z-[60]" onMouseDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="fixed z-[70] w-52 rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md" style={{ left: menu.x, top: menu.y }}>
            {menuCell === null && (
              <>
                <button className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-muted" onClick={() => { setSelected((sel) => (sel?.s === menu.s && sel.i === menu.i ? null : { s: menu.s, i: menu.i })); setMenu(null); }}>
                  <Crosshair className="h-4 w-4" /> {selected?.s === menu.s && selected.i === menu.i ? "Clear aim" : "Aim next tag here"}
                </button>
                <button className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-muted" onClick={() => { setUsed(menu.s, menu.i, true); setMenu(null); }}>
                  <Ban className="h-4 w-4" /> Mark used (already peeled)
                </button>
              </>
            )}
            {menuCell === "used" && (
              <button className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-muted" onClick={() => { setUsed(menu.s, menu.i, false); setMenu(null); }}>
                <Ban className="h-4 w-4" /> Clear used mark
              </button>
            )}
            {menuCell !== null && menuCell !== "used" && (
              <button className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-muted" onClick={() => { removeAt(menu.s, menu.i); setMenu(null); }}>
                <Trash2 className="h-4 w-4" /> Remove from the sheet
              </button>
            )}
          </div>
        </>
      )}

      {/* Hover magnifier: labels are squint-sized at 75% - show a readable copy near the cursor. */}
      {hover && !menu && labels.get(hover.id) && (
        <div className="pointer-events-none fixed z-[60] rounded-md border bg-white p-2 shadow-lg" style={{ left: hover.x, top: hover.y, zoom: 2.2 }}>
          <div style={{ width: `${fmt.w}mm`, height: `${fmt.h}mm`, display: "flex", alignItems: "center", padding: `${(fmt.h * 0.04).toFixed(2)}mm`, overflow: "hidden", color: "#000", fontFamily: "Arial, Helvetica, sans-serif" }}>
            <Label data={labels.get(hover.id)!} org={org.name} show={show} footer={footerText} logo={org.logo} f={fmt} codeType={codeType} />
          </div>
        </div>
      )}

      {createPortal(
        <div id="asset-tag-print-root" style={{ display: "none" }}>
          {(calibrate ? state.sheets.slice(0, 1) : state.sheets).map((cells, s, arr) => (
            <div key={s} style={{ breakAfter: s < arr.length - 1 ? "page" : "auto" }}>
              <SheetView cells={cells} f={fmt} offsetX={state.offsetX} offsetY={state.offsetY} labels={labels} org={org.name} show={show} footer={footerText} logo={org.logo} calibrate={calibrate} codeType={codeType} />
            </div>
          ))}
        </div>,
        document.body,
      )}
    </Backdrop>
  );
}

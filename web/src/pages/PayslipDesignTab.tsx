import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Eye, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { blobUrl, get, patch } from "@/api";
import { cn } from "@/lib/utils";
import {
  ALIGNABLE_KINDS, ATTENDANCE_CELL_LABELS, DEFAULT_PAYSLIP_TEMPLATE, MAX_PAYSLIP_BLOCKS, PAYSLIP_ATTENDANCE_CELLS,
  PAYSLIP_BLOCK_META, PAYSLIP_TOKENS, STOCK_DEFAULTS, newPayslipBlock,
  type PayslipAttendanceCell, type PayslipBlock, type PayslipBlockKind, type PayslipBlockStyle, type PayslipTemplate,
} from "@/lib/payslipTemplate";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/common/Field";
import { PanelSkeleton } from "@/components/common/Skeletons";
import { AccessAction } from "@/components/access/AccessAction";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConfirm } from "@/components/common/confirm";
import { useUnsavedTracker } from "@/components/common/UnsavedChanges";

type Toast = (t: { title: string; description?: string; variant?: "success" | "destructive" }) => void;

const BLOCK_ORDER: PayslipBlockKind[] = [
  "orgHeader", "identity", "kvGrid", "attendance", "earningsDeductions", "netBox", "employerCost", "note", "rule", "gap", "footer",
];

// The payslip layout as data: one active design org-wide, stored in the `payslip` setting and rendered by the
// server (src/domain/payslipTemplate.ts + src/lib/pdf.ts). Editing it affects FUTURE payroll runs only - a
// published payslip's PDF is already stored, so it never changes under an employee.
export default function PayslipDesignTab({ toast }: { toast: Toast }) {
  const confirm = useConfirm();
  const [template, setTemplate] = useState<PayslipTemplate | null>(null);
  const [etag, setEtag] = useState<string | undefined>();
  const [saved, setSaved] = useState<string>(""); // serialized baseline, for the dirty check
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  // Load the saved design; an unset blob means "the stock design" (the server's own fallback).
  useEffect(() => {
    let live = true;
    get<{ value?: PayslipTemplate; etag?: string }>("settings/payslip")
      .then((row) => {
        if (!live) return;
        const t = row.value?.blocks?.length ? row.value : DEFAULT_PAYSLIP_TEMPLATE;
        setTemplate(t);
        setSaved(JSON.stringify(t));
        setEtag(row.etag);
      })
      .catch(() => {
        if (!live) return;
        setTemplate(DEFAULT_PAYSLIP_TEMPLATE);
        setSaved(JSON.stringify(DEFAULT_PAYSLIP_TEMPLATE));
      });
    return () => { live = false; };
  }, []);

  const dirty = !!template && JSON.stringify(template) !== saved;
  useUnsavedTracker(dirty, () => save());

  // ── Live preview: the DRAFT rendered on sample figures (never a real employee's pay) ────────────────
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);
  const renderPreview = useCallback(async (t: PayslipTemplate) => {
    setPreviewing(true);
    try {
      const url = await blobUrl("payslips", { verb: "previewTemplate", body: { template: t } });
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      setPreviewUrl(url);
      setPreviewError(null);
    } catch (e) {
      setPreviewError((e as Error).message);
    } finally {
      setPreviewing(false);
    }
  }, []);
  // Re-render shortly after edits settle, so typing a label doesn't fire a PDF render per keystroke.
  useEffect(() => {
    if (!template) return;
    const id = setTimeout(() => renderPreview(template), 600);
    return () => clearTimeout(id);
  }, [template, renderPreview]);
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  async function save() {
    if (!template) return;
    setSaving(true);
    try {
      const row = await patch<{ etag?: string }>("settings/payslip", { value: template }, etag);
      setEtag(row.etag);
      setSaved(JSON.stringify(template));
      toast({ title: "Payslip design saved", description: "Applies to payslips generated from now on.", variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't save the design", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function resetToStock() {
    const ok = await confirm({
      title: "Restore the stock design?",
      description: "Your block layout is replaced by the built-in payslip design. Nothing is saved until you press Save.",
      confirmLabel: "Restore",
    });
    if (ok) setTemplate(structuredClone(DEFAULT_PAYSLIP_TEMPLATE));
  }

  // Merge into options, dropping an emptied value so the blob keeps only real overrides.
  const setOptions = (patchOpts: Partial<NonNullable<PayslipTemplate["options"]>>) =>
    setTemplate((t) => {
      if (!t) return t;
      const merged = { ...t.options, ...patchOpts };
      for (const k of Object.keys(merged) as (keyof typeof merged)[]) if (merged[k] == null || merged[k] === "") delete merged[k];
      return { ...t, options: Object.keys(merged).length ? merged : undefined };
    });

  // ── Block editing ──────────────────────────────────────────────────────────────────────────────────
  const blocks = template?.blocks ?? [];
  const setBlocks = (next: PayslipBlock[]) => setTemplate((t) => (t ? { ...t, blocks: next } : t));
  const setBlock = (i: number, patchBlock: Partial<PayslipBlock>) =>
    setBlocks(blocks.map((b, j) => (j === i ? { ...b, ...patchBlock } : b)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= blocks.length) return;
    const next = [...blocks];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setBlocks(next);
    setOpen(j);
  };
  const removeBlock = (i: number) => {
    setBlocks(blocks.filter((_, j) => j !== i));
    setOpen(null);
  };
  const addBlock = (kind: PayslipBlockKind) => {
    if (blocks.length >= MAX_PAYSLIP_BLOCKS) {
      toast({ title: `A design may hold at most ${MAX_PAYSLIP_BLOCKS} blocks`, variant: "destructive" });
      return;
    }
    setBlocks([...blocks, newPayslipBlock(kind)]);
    setOpen(blocks.length);
  };

  const tokenHelp = useMemo(() => PAYSLIP_TOKENS.map((t) => `{{${t}}}`).join("  "), []);

  if (!template) return <PanelSkeleton />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          The layout of every generated payslip, as a stack of blocks. Changes apply to payslips generated from
          now on - already-published payslips keep the design they were issued with. The preview uses sample
          figures, never a real employee's pay.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={resetToStock}><RotateCcw className="h-4 w-4" /> Stock design</Button>
          <AccessAction collection="settings" objectPath="settings/payslip" verb="previewTemplate" label="Preview payslip design">
            <Button variant="outline" size="sm" loading={previewing} onClick={() => renderPreview(template)}>
              {!previewing && <Eye className="h-4 w-4" />} Refresh preview
            </Button>
          </AccessAction>
          <Button size="sm" onClick={save} loading={saving} disabled={!dirty}>{!saving && <Save className="h-4 w-4" />} Save</Button>
        </div>
      </div>

      {/* Tabbed, not stacked: the settings panel is narrow (narrower still in the inline Sheet), and the three
          editors are long enough that stacking them buried the preview far below the fold. */}
      <Tabs defaultValue="blocks">
        <TabsList variant="segmented">
          <TabsTrigger value="blocks">Blocks</TabsTrigger>
          <TabsTrigger value="document">Document</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
        </TabsList>

        <TabsContent value="blocks">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Blocks <span className="ml-1 font-normal text-muted-foreground">({blocks.length})</span></CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {blocks.length === 0 && <p className="py-4 text-sm text-muted-foreground">No blocks - the payslip would be blank. Add one below, or restore the stock design.</p>}
              {blocks.map((b, i) => {
                const meta = PAYSLIP_BLOCK_META[b.kind];
                const isOpen = open === i;
                return (
                  <div key={i} className={cn("rounded-md border", isOpen && "border-primary/60 bg-accent/20")}>
                    <div className="flex items-center gap-2 px-2 py-1.5">
                      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(isOpen ? null : i)}>
                        <Badge variant="outline" className="shrink-0 text-[10px]">{i + 1}</Badge>
                        <span className="truncate text-sm font-medium">{meta.title}</span>
                        <span className="hidden truncate text-xs text-muted-foreground sm:inline">{meta.desc}</span>
                      </button>
                      <Button variant="ghost" size="icon" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ChevronUp className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="icon" title="Move down" disabled={i === blocks.length - 1} onClick={() => move(i, 1)}><ChevronDown className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="icon" title="Remove block" onClick={() => removeBlock(i)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                    </div>
                    {isOpen && (
                      <div className="space-y-3 border-t px-3 py-3">
                        <BlockFields block={b} onChange={(p) => setBlock(i, p)} />
                        {b.kind !== "gap" && <StyleFields block={b} onChange={(p) => setBlock(i, p)} />}
                      </div>
                    )}
                  </div>
                );
              })}
              <div className="flex flex-wrap gap-1.5 pt-1">
                {BLOCK_ORDER.map((kind) => (
                  <Button key={kind} variant="outline" size="sm" onClick={() => addBlock(kind)} title={PAYSLIP_BLOCK_META[kind].desc}>
                    <Plus className="h-3.5 w-3.5" /> {PAYSLIP_BLOCK_META[kind].title}
                  </Button>
                ))}
              </div>
              <p className="pt-1 text-xs text-muted-foreground">
                Text fields accept placeholders: <code className="rounded bg-muted px-1 text-[11px]">{tokenHelp}</code>
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="document">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Document</CardTitle></CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <Field label="Typeface" hint="Serif reads like a formal statement; sans is plainer. Money always uses a monospaced face.">
                <Select
                  value={template.options?.font ?? "serif"}
                  onValueChange={(v) => setOptions({ font: v as "serif" | "sans" })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="serif">Serif (Times)</SelectItem>
                    <SelectItem value="sans">Sans (Helvetica)</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Page size">
                <Select value={template.options?.pageSize ?? "a4"} onValueChange={(v) => setOptions({ pageSize: v as "a4" | "letter" })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="a4">A4</SelectItem>
                    <SelectItem value="letter">US Letter</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Margin (points)" hint="24 to 96. The content box is the page minus this on each side.">
                <Input type="number" min="24" max="96" value={template.options?.margin ?? STOCK_DEFAULTS.margin} onChange={(e) => setOptions({ margin: Number(e.target.value) })} />
              </Field>
              <Field label="Text scale" hint="0.8 to 1.25, multiplies every default size. A size set on a block wins over this.">
                <Input type="number" step="0.05" min="0.8" max="1.25" value={template.options?.scale ?? STOCK_DEFAULTS.scale} onChange={(e) => setOptions({ scale: Number(e.target.value) })} />
              </Field>
              <ColorField label="Accent" hint="Heavy rules, column totals, net-pay box border." value={template.options?.accent} fallback={STOCK_DEFAULTS.ink} onChange={(accent) => setOptions({ accent })} />
              <ColorField label="Ink" hint="Primary text." value={template.options?.ink} fallback={STOCK_DEFAULTS.ink} onChange={(ink) => setOptions({ ink })} />
              <ColorField label="Secondary text" hint="Captions and small-caps labels." value={template.options?.muted} fallback={STOCK_DEFAULTS.muted} onChange={(muted) => setOptions({ muted })} />
              <ColorField label="Lines" hint="Rules, boxes and dividers." value={template.options?.hairline} fallback={STOCK_DEFAULTS.hairline} onChange={(hairline) => setOptions({ hairline })} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* The A4 aspect ratio keeps the page shape honest at any panel width, so what you judge here is what prints. */}
        <TabsContent value="preview">
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-2 pb-2">
              <CardTitle className="text-sm">Preview <span className="ml-1 font-normal text-muted-foreground">sample data</span></CardTitle>
              {previewing && <span className="text-xs text-muted-foreground">Rendering…</span>}
            </CardHeader>
            <CardContent>
              {previewError ? (
                <p className="py-8 text-sm text-destructive">{previewError}</p>
              ) : previewUrl ? (
                <iframe
                  title="Payslip design preview"
                  src={previewUrl}
                  className="mx-auto w-full max-w-[820px] rounded-md border bg-muted/30"
                  style={{ aspectRatio: "595 / 842", minHeight: 520 }}
                />
              ) : (
                <p className="py-8 text-sm text-muted-foreground">Rendering…</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// A colour with an "unset = stock value" affordance: the swatch shows the effective colour, Clear removes the
// override entirely rather than storing the default.
function ColorField({ label, hint, value, fallback, onChange }: { label: string; hint?: string; value?: string; fallback: string; onChange: (v: string | undefined) => void }) {
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={label}
          className="h-9 w-12 shrink-0 cursor-pointer rounded border bg-background"
          value={value ?? fallback}
          onChange={(e) => onChange(e.target.value)}
        />
        <Input value={value ?? ""} placeholder={fallback} onChange={(e) => onChange(e.target.value || undefined)} />
        {value && <Button variant="ghost" size="sm" onClick={() => onChange(undefined)}>Clear</Button>}
      </div>
    </Field>
  );
}

// The style section every block shares. Empty inputs mean "inherit the stock design", so a block only carries
// what was deliberately changed - that is also what keeps an untouched template rendering byte-for-byte stock.
function StyleFields({ block, onChange }: { block: PayslipBlock; onChange: (patch: Partial<PayslipBlock>) => void }) {
  const [open, setOpen] = useState(false);
  const st = block.style ?? {};
  const touched = Object.keys(st).length;
  const setStyle = (p: Partial<PayslipBlockStyle>) => {
    const merged: PayslipBlockStyle = { ...st, ...p };
    for (const k of Object.keys(merged) as (keyof PayslipBlockStyle)[]) {
      const v = merged[k];
      if (v == null || v === "" || (typeof v === "number" && Number.isNaN(v))) delete merged[k];
    }
    onChange({ style: Object.keys(merged).length ? merged : undefined });
  };
  const num = (v: string) => (v === "" ? undefined : Number(v));

  return (
    <div className="rounded-md border bg-background/60">
      <button type="button" className="flex w-full items-center gap-2 px-2 py-1.5 text-left" onClick={() => setOpen(!open)}>
        {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        <span className="text-xs font-medium">Style</span>
        {touched > 0 && <Badge variant="outline" className="text-[10px]">{touched} override{touched === 1 ? "" : "s"}</Badge>}
        {touched === 0 && <span className="text-xs text-muted-foreground">stock</span>}
      </button>
      {open && (
        <div className="grid gap-3 border-t px-3 py-3 sm:grid-cols-2">
          <Field label="Text size (pt)" hint="5 to 36. Applies to this block's main text. Blank = stock.">
            <Input type="number" min="5" max="36" step="0.5" value={st.size ?? ""} placeholder="stock" onChange={(e) => setStyle({ size: num(e.target.value) })} />
          </Field>
          <Field label="Weight">
            <Select value={st.weight ?? "stock"} onValueChange={(v) => setStyle({ weight: v === "stock" ? undefined : (v as "regular" | "bold") })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="stock">Stock</SelectItem>
                <SelectItem value="regular">Regular</SelectItem>
                <SelectItem value="bold">Bold</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <ColorField label="Text colour" value={st.color} fallback={STOCK_DEFAULTS.ink} onChange={(color) => setStyle({ color })} />
          {ALIGNABLE_KINDS.includes(block.kind) && (
            <Field label="Alignment" hint="Only blocks with a single text column can be aligned.">
              <Select value={st.align ?? "stock"} onValueChange={(v) => setStyle({ align: v === "stock" ? undefined : (v as "left" | "center" | "right") })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="stock">Stock</SelectItem>
                  <SelectItem value="left">Left</SelectItem>
                  <SelectItem value="center">Centre</SelectItem>
                  <SelectItem value="right">Right</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field label="Space above (pt)">
            <Input type="number" min="0" max="120" value={st.spaceBefore ?? ""} placeholder="0" onChange={(e) => setStyle({ spaceBefore: num(e.target.value) })} />
          </Field>
          <Field label="Space below (pt)">
            <Input type="number" min="0" max="120" value={st.spaceAfter ?? ""} placeholder="0" onChange={(e) => setStyle({ spaceAfter: num(e.target.value) })} />
          </Field>
        </div>
      )}
    </div>
  );
}

// Per-kind field editors. Every input maps 1:1 to a property the server's block validator accepts.
function BlockFields({ block, onChange }: { block: PayslipBlock; onChange: (patch: Partial<PayslipBlock>) => void }) {
  const check = (label: string, key: "showLogo" | "showAddress" | "showDesignation" | "showWords" | "showTotals" | "emphasis", dflt: boolean) => (
    <label className="flex items-center gap-2 text-sm">
      <Checkbox checked={block[key] ?? dflt} onCheckedChange={(v) => onChange({ [key]: !!v } as Partial<PayslipBlock>)} />
      {label}
    </label>
  );

  switch (block.kind) {
    case "orgHeader":
      return (
        <>
          <div className="flex flex-wrap gap-4">{check("Show logo", "showLogo", true)}{check("Show address", "showAddress", true)}</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Logo height (pt)" hint="16 to 96.">
              <Input type="number" min="16" max="96" value={block.logoHeight ?? 36} onChange={(e) => onChange({ logoHeight: Number(e.target.value) })} />
            </Field>
            <Field label="Logo side" hint="The name and address take the other side.">
              <Select value={block.logoAlign ?? "right"} onValueChange={(v) => onChange({ logoAlign: v as "left" | "right" })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="right">Right</SelectItem><SelectItem value="left">Left</SelectItem></SelectContent>
              </Select>
            </Field>
          </div>
        </>
      );
    case "identity":
      return (
        <>
          <Field label="Caption" hint="Small line under the period, e.g. Payslip or Salary statement.">
            <Input value={block.caption ?? ""} onChange={(e) => onChange({ caption: e.target.value })} />
          </Field>
          {check("Show job title", "showDesignation", true)}
        </>
      );
    case "kvGrid": {
      const fields = block.fields ?? [];
      return (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Columns">
              <Select value={String(block.columns ?? 3)} onValueChange={(v) => onChange({ columns: Number(v) as 2 | 3 })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="2">2</SelectItem><SelectItem value="3">3</SelectItem></SelectContent>
              </Select>
            </Field>
            <Field label="Label case">
              <Select value={block.labelCase ?? "upper"} onValueChange={(v) => onChange({ labelCase: v as "upper" | "asis" })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="upper">UPPERCASE</SelectItem><SelectItem value="asis">As typed</SelectItem></SelectContent>
              </Select>
            </Field>
            <Field label="Label size (pt)" hint="5 to 24.">
              <Input type="number" min="5" max="24" step="0.5" value={block.labelSize ?? 6.5} onChange={(e) => onChange({ labelSize: Number(e.target.value) })} />
            </Field>
            <Field label="Row height (pt)" hint="18 to 72.">
              <Input type="number" min="18" max="72" value={block.rowHeight ?? 34} onChange={(e) => onChange({ rowHeight: Number(e.target.value) })} />
            </Field>
          </div>
          <div className="space-y-2">
            {fields.map((f, j) => (
              <div key={j} className="editor-row">
                <Input className="w-full sm:w-40" placeholder="Label" value={f.label} onChange={(e) => onChange({ fields: fields.map((x, k) => (k === j ? { ...x, label: e.target.value } : x)) })} />
                <Input className="editor-row-main" placeholder="{{token}} or text" value={f.value} onChange={(e) => onChange({ fields: fields.map((x, k) => (k === j ? { ...x, value: e.target.value } : x)) })} />
                <Button variant="ghost" size="icon" title="Remove field" onClick={() => onChange({ fields: fields.filter((_, k) => k !== j) })}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => onChange({ fields: [...fields, { label: "", value: "" }] })}><Plus className="h-3.5 w-3.5" /> Add field</Button>
          </div>
        </>
      );
    }
    case "attendance": {
      const picked = block.cells ?? PAYSLIP_ATTENDANCE_CELLS;
      const toggle = (cell: PayslipAttendanceCell, on: boolean) => {
        const next = on
          ? PAYSLIP_ATTENDANCE_CELLS.filter((c) => c === cell || picked.includes(c))
          : picked.filter((c) => c !== cell);
        if (!next.length) return; // the strip needs at least one figure - the server rejects an empty list
        onChange({ cells: [...next] });
      };
      return (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Section title"><Input value={block.title ?? ""} onChange={(e) => onChange({ title: e.target.value })} /></Field>
            <Field label="Strip height (pt)" hint="24 to 80."><Input type="number" min="24" max="80" value={block.cellHeight ?? 40} onChange={(e) => onChange({ cellHeight: Number(e.target.value) })} /></Field>
          </div>
          <Field label="Figures shown" hint="At least one. Cells share the width evenly.">
            <div className="flex flex-wrap gap-4">
              {PAYSLIP_ATTENDANCE_CELLS.map((c) => (
                <label key={c} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={picked.includes(c)} onCheckedChange={(v) => toggle(c, !!v)} />
                  {ATTENDANCE_CELL_LABELS[c]}
                </label>
              ))}
            </div>
          </Field>
        </>
      );
    }
    case "earningsDeductions":
      return (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Earnings heading"><Input value={block.earningsTitle ?? ""} onChange={(e) => onChange({ earningsTitle: e.target.value })} /></Field>
            <Field label="Deductions heading"><Input value={block.deductionsTitle ?? ""} onChange={(e) => onChange({ deductionsTitle: e.target.value })} /></Field>
            <Field label="Earnings total label"><Input value={block.earningsTotalLabel ?? ""} onChange={(e) => onChange({ earningsTotalLabel: e.target.value })} /></Field>
            <Field label="Deductions total label"><Input value={block.deductionsTotalLabel ?? ""} onChange={(e) => onChange({ deductionsTotalLabel: e.target.value })} /></Field>
            <Field label="Amount column label"><Input value={block.amountLabel ?? ""} onChange={(e) => onChange({ amountLabel: e.target.value })} /></Field>
            <Field label="Column split" hint="0.3 to 0.7 - the earnings column's share of the width.">
              <Input type="number" step="0.05" min="0.3" max="0.7" value={block.split ?? 0.5} onChange={(e) => onChange({ split: Number(e.target.value) })} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={block.zebra ?? false} onCheckedChange={(v) => onChange({ zebra: !!v })} /> Shade alternate rows
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={block.rowBorders ?? false} onCheckedChange={(v) => onChange({ rowBorders: !!v })} /> Line under every row
            </label>
          </div>
        </>
      );
    case "netBox":
      return (
        <>
          <Field label="Label"><Input value={block.label ?? ""} onChange={(e) => onChange({ label: e.target.value })} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Border weight (pt)" hint="0 to 4; 0 draws no border.">
              <Input type="number" step="0.5" min="0" max="4" value={block.borderWidth ?? 1.5} onChange={(e) => onChange({ borderWidth: Number(e.target.value) })} />
            </Field>
            <ColorField label="Fill" hint="Leave empty for no fill." value={block.fill} fallback="#eef2ff" onChange={(fill) => onChange({ fill })} />
          </div>
          {check("Show amount in words", "showWords", true)}
        </>
      );
    case "employerCost":
      return (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Heading"><Input value={block.title ?? ""} onChange={(e) => onChange({ title: e.target.value })} /></Field>
            <Field label="Cost-to-company total label" hint="Gross + the contributions that count inside CTC."><Input value={block.totalLabel ?? ""} onChange={(e) => onChange({ totalLabel: e.target.value })} /></Field>
            <Field label="All-in total label" hint="Shown only when a contribution sits over and above CTC."><Input value={block.grandTotalLabel ?? ""} onChange={(e) => onChange({ grandTotalLabel: e.target.value })} /></Field>
            <Field label="Over-and-above-CTC suffix" hint="Appended to a contribution the org keeps outside CTC."><Input value={block.aboveCtcSuffix ?? ""} onChange={(e) => onChange({ aboveCtcSuffix: e.target.value })} /></Field>
          </div>
          {check("Show the total rows", "showTotals", true)}
        </>
      );
    case "note":
      return (
        <>
          <Field label="Text" hint="Placeholders allowed.">
            <Textarea rows={2} value={block.text ?? ""} onChange={(e) => onChange({ text: e.target.value })} />
          </Field>
          <div className="flex flex-wrap items-center gap-4">
            <Field label="Alignment" className="w-40">
              <Select value={block.align ?? "left"} onValueChange={(v) => onChange({ align: v as "left" | "center" })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="left">Left</SelectItem><SelectItem value="center">Centre</SelectItem></SelectContent>
              </Select>
            </Field>
            {check("Emphasise", "emphasis", false)}
          </div>
        </>
      );
    case "rule":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Thickness" hint="Without a colour, 1 or above uses the accent and thinner rules a hairline.">
            <Input type="number" step="0.25" min="0.25" max="4" value={block.weight ?? 0.5} onChange={(e) => onChange({ weight: Number(e.target.value) })} />
          </Field>
          <ColorField label="Line colour" value={block.color} fallback={STOCK_DEFAULTS.hairline} onChange={(color) => onChange({ color })} />
        </div>
      );
    case "gap":
      return (
        <Field label="Height (points)">
          <Input type="number" min="0" max="120" className="w-32" value={block.height ?? 8} onChange={(e) => onChange({ height: Number(e.target.value) })} />
        </Field>
      );
    case "footer":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Left caption"><Input value={block.left ?? ""} onChange={(e) => onChange({ left: e.target.value })} /></Field>
          <Field label="Right caption"><Input value={block.right ?? ""} onChange={(e) => onChange({ right: e.target.value })} /></Field>
        </div>
      );
  }
}

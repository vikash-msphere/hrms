import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Copy, Eye, FileSignature, KeyRound, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { create, patch, remove } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { cn, idOf } from "@/lib/utils";
import type { Employee } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/common/Field";
import { AccessTarget } from "@/components/access/AccessTarget";
import { Badge } from "@/components/ui/badge";
import { useConfirm } from "@/components/common/confirm";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

type Toast = (t: { title: string; description?: string; variant?: "success" | "destructive" }) => void;

// Mirrors src/domain/letters.ts TemplateBlock (the editable subset). Kept loose - the server validates.
type Block = {
  kind: "subject" | "para" | "bullets" | "note" | "input" | "signature" | "acceptance" | "esignature" | "gap" | "pageBreak" | "computed";
  text?: string;
  bold?: boolean;
  items?: string[];
  closing?: string;
  label?: string; // esignature: caption under the signature line (default "Signature")
  withDate?: boolean; // esignature: add a date line aligned with the signature
  method?: "internal" | "cashfree"; // esignature: how the recipient signs - in-app image (default) or Aadhaar
  height?: number;
  ref?: "ctc_annexure" | "increment_table" | "settlement_table";
  field?: string;
  requires?: string;
};
type TemplateInput = { key: string; label: string; type?: "text" | "multiline"; placeholder?: string; required?: boolean };
// `id` holds the resource PATH (letter-templates/{id}); `etag` rides along for optimistic-concurrency saves.
type Template = { id: string; etag?: string; label: string; category?: string; filename?: string; inputs?: TemplateInput[]; blocks: Block[]; access?: { can?: string[] } };

// Group templates by category (first-seen order); untyped go under "Other".
function groupTemplates(ts: Template[]): { category: string; items: Template[] }[] {
  const groups: { category: string; items: Template[] }[] = [];
  for (const t of ts) {
    const cat = t.category?.trim() || "Other";
    let g = groups.find((x) => x.category === cat);
    if (!g) { g = { category: cat, items: [] }; groups.push(g); }
    g.items.push(t);
  }
  return groups;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

const BLOCK_KINDS: { kind: Block["kind"]; label: string }[] = [
  { kind: "subject", label: "Subject" },
  { kind: "para", label: "Paragraph" },
  { kind: "bullets", label: "Bullet list" },
  { kind: "note", label: "Note (small print)" },
  { kind: "input", label: "HR-entered body" },
  { kind: "computed", label: "Computed table" },
  { kind: "signature", label: "Company signature (authorized signatory)" },
  { kind: "acceptance", label: "Recipient — sign on paper (wet ink)" },
  { kind: "esignature", label: "Recipient — e-signature (in-app / Aadhaar)" },
  { kind: "gap", label: "Spacer" },
  { kind: "pageBreak", label: "Page break" },
];

// Block-level conditionals (the closed `requires` vocabulary the resolver understands).
const REQUIRES: { v: string; l: string }[] = [
  { v: "", l: "Always show" },
  { v: "ctc", l: "Only if compensation is set" },
  { v: "increment", l: "Only if there's an increment (2+ comp rows)" },
  { v: "ctc_no_increment", l: "Only if comp but no increment" },
  { v: "validity_date", l: "Only if offer validity is set" },
  { v: "working_pattern", l: "Only if working hours are set" },
];

// The placeholder vocabulary, for the insert palette. Smart clauses already include their own conditional
// wording + bolding, so they render to nothing when the underlying data is absent.
const PLACEHOLDERS: { group: string; tokens: string[] }[] = [
  { group: "Recipient (2nd party — the employee)", tokens: ["employee_name", "legal_name", "recipient_name", "recipient_legal_name", "employee_number", "first_name", "designation", "department", "manager", "joining_date", "end_date", "probation_months"] },
  { group: "Company (1st party) & sender", tokens: ["company", "date", "company_signatory_name", "company_signatory_title", "hr_name", "hr_email", "hr_phone", "work_mode", "working_hours", "working_days", "work_location", "working_pattern", "validity_date"] },
  { group: "Compensation", tokens: ["ctc_annual", "ctc_monthly", "ctc_in_words", "inc_old_annual", "inc_new_annual", "inc_new_annual_words", "inc_increase", "inc_effective_date"] },
  { group: "Smart clauses (auto-include + bold)", tokens: ["department_clause", "reporting_to_clause", "probation_clause", "work_location_suffix", "hr_contact_clause", "appraisal_role_clause", "exp_designation_clause", "exp_department_clause", "rel_role_clause", "tenure_clause", "employment_period"] },
];

// What each placeholder resolves to (shown as a tooltip in the palette). Mirrors src/domain/letters.ts.
const TOKEN_DESC: Record<string, string> = {
  employee_name: "Recipient's (employee's) display full name, e.g. Mara Manager.",
  legal_name: "Recipient's full legal name (official docs/IDs). Falls back to the display name if unset. Used for sign-off blocks.",
  recipient_name: "Recipient (2nd party) display name — alias of employee_name; use it to name the other side unambiguously in a contract.",
  recipient_legal_name: "Recipient (2nd party) legal name — alias of legal_name; the name that appears on the employee's e-signature.",
  employee_number: "The employee ID, e.g. EMP-0042. Blank if unset.",
  first_name: "Employee's first name.",
  designation: "Job title. Shows a blank line if not set.",
  department: "Department name (empty if none).",
  manager: "Reporting manager's name (empty if none).",
  joining_date: "Start date, formatted - e.g. 1 July 2026.",
  end_date: "End date, or today's date if none is set.",
  probation_months: "Probation length in months, derived from start and probation-end dates.",
  company: "Organization name (Settings → Organization).",
  date: "Today's date, formatted.",
  company_signatory_name: "Company (1st party) authorized signatory's name — who signs on behalf of the employer (Settings → Letter defaults).",
  company_signatory_title: "Company (1st party) signatory's title.",
  signatory_name: "Alias of company_signatory_name (kept for older templates).",
  signatory_title: "Alias of company_signatory_title (kept for older templates).",
  hr_name: "HR contact name (Letter defaults).",
  hr_email: "HR contact email (Letter defaults).",
  hr_phone: "HR contact phone (Letter defaults).",
  work_mode: "Work mode (on-site / remote / hybrid); defaults to full-time.",
  working_hours: "Working hours (Letter defaults).",
  working_days: "Working days (Letter defaults).",
  work_location: "Work location (Letter defaults).",
  working_pattern: "Working hours and days combined, e.g. 10:00 AM to 7:00 PM, Monday to Friday.",
  validity_date: "Offer expiry = issue date + validity days. Empty if validity isn't set.",
  ctc_annual: "Annual CTC in figures, e.g. INR 18,00,000.",
  ctc_monthly: "Monthly CTC in figures.",
  ctc_in_words: "Annual CTC in figures and words, e.g. INR 18,00,000/- (Eighteen Lakh only).",
  inc_old_annual: "Previous annual CTC (from the prior compensation row).",
  inc_new_annual: "Revised annual CTC (current compensation).",
  inc_new_annual_words: "Revised annual CTC in figures and words.",
  inc_increase: "Increase - revised CTC minus previous CTC.",
  inc_effective_date: "Effective date of the revised compensation.",
  department_clause: "Auto clause: “ in the <dept> department” (bold), or empty if no department.",
  reporting_to_clause: "Auto clause: “, initially reporting to <manager>” (bold), or empty.",
  probation_clause: "Auto clause: “ You will be on probation for <n> months.” (bold), or empty.",
  work_location_suffix: "Auto clause: “, based at <location>”, or empty.",
  hr_contact_clause: "Auto clause: “ to <name> at <phone> or <email>” (bold), or empty.",
  appraisal_role_clause: "Auto clause: “as <title> in the <dept> department”, or “in your role”.",
  exp_designation_clause: "Auto clause (experience): “ as <title>”, or empty.",
  exp_department_clause: "Auto clause (experience): “ in the <dept> department”, or empty.",
  rel_role_clause: "Auto clause (relieving): “, who was employed with us as <title>”.",
  tenure_clause: "Auto clause: “ from <start> to <end>” or “ until <end>”.",
  employment_period: "Auto clause: “from <start> to <end>” or “until <end>”.",
};

function newBlock(kind: Block["kind"]): Block {
  switch (kind) {
    case "subject": return { kind, text: "Subject: " };
    case "para": return { kind, text: "" };
    case "bullets": return { kind, items: [""] };
    case "note": return { kind, text: "" };
    case "input": return { kind, field: "body" };
    case "computed": return { kind, ref: "ctc_annexure" };
    case "signature": return { kind, closing: "For and on behalf of {{company}}," };
    case "esignature": return { kind, method: "internal" };
    default: return { kind } as Block;
  }
}

const REQUIRES_SELECT = (value: string, onChange: (v: string) => void) => (
  <select className="h-8 rounded-md border bg-background px-2 text-xs" value={value} onChange={(e) => onChange(e.target.value)}>
    {REQUIRES.map((r) => <option key={r.v} value={r.v}>{r.l}</option>)}
  </select>
);

/** Settings → Letters: a block editor for the `letter-templates` setting, with a placeholder palette and a
 *  live preview (rendered server-side from the draft, without saving). */
export default function LettersTab({ toast }: { toast: Toast }) {
  const confirm = useConfirm();
  const { rows: employees, state: employeesState } = useCollection<Employee>("employees");
  // The employee lookup feeds the preview picker; surface a load failure instead of a silently empty dropdown.
  useEffect(() => {
    if (employeesState === "error") toast({ title: "Couldn't load employees", description: "The preview picker may be empty. Try reloading.", variant: "destructive" });
  }, [employeesState, toast]);
  // Letter templates are a real collection now (each an addressable object -> per-template access icon).
  const { rows: rows, reload } = useCollection<{ path: string; etag?: string; label: string; category?: string; filename?: string; inputs?: TemplateInput[]; blocks: Block[]; access?: { can?: string[] } }>("letter-templates");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selId, setSelId] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newLabel, setNewLabel] = useState("");

  const [previewEmp, setPreviewEmp] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  // Sync server rows -> local editable copies (skip while there are unsaved edits, so a refetch can't clobber).
  useEffect(() => {
    if (dirty) return;
    const t: Template[] = rows.map((r) => ({ id: r.path, etag: r.etag, label: r.label, category: r.category, filename: r.filename, inputs: r.inputs, blocks: r.blocks ?? [], access: r.access }));
    setTemplates(t);
    setSelId((cur) => (t.some((x) => x.id === cur) ? cur : t[0]?.id ?? ""));
  }, [rows, dirty]);
  function revert() { setDirty(false); reload(); }
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const selected = useMemo(() => templates.find((t) => t.id === selId), [templates, selId]);
  const categories = useMemo(() => Array.from(new Set(templates.map((t) => t.category?.trim()).filter(Boolean))) as string[], [templates]);

  function mutateSelected(fn: (t: Template) => Template) {
    setTemplates((ts) => ts.map((t) => (t.id === selId ? fn(t) : t)));
    setDirty(true);
  }
  const updateBlock = (i: number, p: Partial<Block>) => mutateSelected((t) => ({ ...t, blocks: t.blocks.map((b, j) => (j === i ? { ...b, ...p } : b)) }));
  const moveBlock = (i: number, dir: -1 | 1) => mutateSelected((t) => {
    const blocks = [...t.blocks];
    const j = i + dir;
    if (j < 0 || j >= blocks.length) return t;
    [blocks[i], blocks[j]] = [blocks[j]!, blocks[i]!];
    return { ...t, blocks };
  });
  const deleteBlock = (i: number) => mutateSelected((t) => ({ ...t, blocks: t.blocks.filter((_, j) => j !== i) }));
  const addBlock = (kind: Block["kind"]) => mutateSelected((t) => ({ ...t, blocks: [...t.blocks, newBlock(kind)] }));
  const updateInput = (i: number, p: Partial<TemplateInput>) => mutateSelected((t) => ({ ...t, inputs: (t.inputs ?? []).map((f, j) => (j === i ? { ...f, ...p } : f)) }));
  const addInput = () => mutateSelected((t) => ({ ...t, inputs: [...(t.inputs ?? []), { key: `field${(t.inputs?.length ?? 0) + 1}`, label: "New field", type: "text" }] }));
  const removeInput = (i: number) => mutateSelected((t) => ({ ...t, inputs: (t.inputs ?? []).filter((_, j) => j !== i) }));

  async function addTemplate() {
    const label = newLabel.trim();
    if (!label) return;
    try {
      const row = await create<{ path: string }>("letter-templates", {
        label, filename: `{{employee_name}} - ${label}`,
        blocks: [{ kind: "subject", text: `Subject: ${label}` }, { kind: "para", text: "Dear {{first_name}}," }, { kind: "signature", closing: "For and on behalf of {{company}}," }],
      });
      setNewLabel("");
      setDirty(false);
      await reload();
      setSelId(row.path);
      toast({ title: "Letter type added", variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't add", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function deleteTemplate(id: string) {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    if (!(await confirm({ title: `Delete "${t.label}"?`, description: "This removes the letter type. Existing generated letters are unaffected.", confirmLabel: "Delete", destructive: true }))) return;
    try { await remove(t.id); setDirty(false); await reload(); toast({ title: "Deleted", variant: "success" }); }
    catch (e) { toast({ title: "Couldn't delete", description: (e as Error).message, variant: "destructive" }); }
  }

  async function save() {
    if (!selected) return;
    setSaving(true);
    try {
      // Normalize: trim blank bullet lines so empty bullets never render. Saves only the selected row.
      const blocks = selected.blocks.map((b) => (b.kind === "bullets" ? { ...b, items: (b.items ?? []).filter((x) => x.trim()) } : b));
      await patch(selected.id, { label: selected.label, category: selected.category ?? null, filename: selected.filename ?? null, inputs: selected.inputs ?? null, blocks }, selected.etag);
      setDirty(false);
      await reload();
      toast({ title: "Letter template saved", variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function copyToken(tok: string) {
    const text = `{{${tok}}}`;
    try { await navigator.clipboard.writeText(text); toast({ title: `Copied ${text}`, variant: "success" }); } catch { /* clipboard unavailable */ }
  }

  async function runPreview() {
    if (!selected || !previewEmp) return;
    setPreviewing(true);
    try {
      // Sample values for any input fields, so an HR-filled template still previews with placeholder text.
      const input = Object.fromEntries((selected.inputs ?? []).map((f) => [f.key, f.placeholder || `[${f.label}]`]));
      const tpl = { id: selected.id, label: selected.label, filename: selected.filename, inputs: selected.inputs, blocks: selected.blocks };
      const res = await fetch("/v1/personal-documents:previewLetter", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-By": "hrms-spa" },
        credentials: "include",
        body: JSON.stringify({ employee: `employees/${previewEmp}`, template: tpl, input }),
      });
      if (!res.ok) { toast({ title: "Preview failed", description: `HTTP ${res.status}`, variant: "destructive" }); return; }
      const url = URL.createObjectURL(await res.blob());
      setPreviewUrl(url);
    } catch (e) {
      toast({ title: "Preview failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setPreviewing(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Letter types HR can generate. Text supports <code className="rounded bg-muted px-1">{"{{placeholders}}"}</code> and <code className="rounded bg-muted px-1">**bold**</code>. Use the <KeyRound className="inline h-3.5 w-3.5 text-amber-600" /> icon on a letter type to manage who may generate or edit it.
        </p>
        <div className="flex items-center gap-2">
          {dirty && <Button variant="ghost" size="sm" onClick={revert}><RotateCcw className="h-4 w-4" /> Revert</Button>}
          <Button size="sm" onClick={save} loading={saving} disabled={!dirty}>{!saving && <Save className="h-4 w-4" />} Save</Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
        {/* Template list */}
        <Card className="h-fit">
          <CardHeader className="pb-2"><CardTitle className="text-sm">Letter types</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <div className="space-y-2">
              {groupTemplates(templates).map((g) => (
                <div key={g.category} className="space-y-0.5">
                  <p className="px-2 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{g.category}</p>
                  {g.items.map((t) => (
                    <div key={t.id} className={`flex items-center gap-1 rounded-md px-1 ${t.id === selId ? "bg-accent" : "hover:bg-muted"}`}>
                      <button onClick={() => setSelId(t.id)} className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-sm">
                        <FileSignature className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{t.label}</span>
                      </button>
                      <AccessTarget target={{ collection: "letter-templates", objectPath: t.id, can: t.access?.can, label: t.label }} />
                    </div>
                  ))}
                </div>
              ))}
              {templates.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">No letter types yet.</p>}
            </div>
            <div className="flex items-center gap-1.5 border-t pt-2">
              <Input className="h-8 text-sm" placeholder="New letter type…" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTemplate()} />
              <AccessAction collection="letter-templates" create label="Letter types">
                <Button size="sm" variant="outline" onClick={addTemplate} disabled={!newLabel.trim()}><Plus className="h-4 w-4" /></Button>
              </AccessAction>
            </div>
          </CardContent>
        </Card>

        {/* Editor */}
        {selected ? (
          <div className="space-y-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-3">
                <CardTitle className="flex items-center gap-2 text-sm">
                  {selected.label}
                  <AccessTarget target={{ collection: "letter-templates", objectPath: selected.id, can: selected.access?.can, label: selected.label }} />
                </CardTitle>
                <Button variant="ghost" size="sm" className="text-destructive" onClick={() => deleteTemplate(selected.id)}><Trash2 className="h-4 w-4" /> Delete type</Button>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <Field label="Label"><Input value={selected.label} onChange={(e) => mutateSelected((t) => ({ ...t, label: e.target.value }))} /></Field>
                <Field label="Category" hint="Groups the letter in the list and pickers.">
                  <Input list="letter-categories" value={selected.category ?? ""} onChange={(e) => mutateSelected((t) => ({ ...t, category: e.target.value }))} placeholder="e.g. Onboarding" />
                  <datalist id="letter-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Download filename" hint="Supports placeholders; .pdf is added automatically.">
                    <Input value={selected.filename ?? ""} onChange={(e) => mutateSelected((t) => ({ ...t, filename: e.target.value }))} placeholder="{{employee_name}} - Letter" />
                  </Field>
                </div>
              </CardContent>
            </Card>

            {/* Input fields (filled in by HR at generation time) */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Input fields</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                <p className="text-xs text-muted-foreground">Values HR types when generating this letter. A text field is usable as <code className="rounded bg-muted px-1">{"{{key}}"}</code>; a multiline field is placed with an “HR-entered body” block.</p>
                {(selected.inputs ?? []).map((f, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                    <Input className="h-8 w-28 font-mono text-xs" value={f.key} onChange={(e) => updateInput(i, { key: e.target.value })} placeholder="key" />
                    <Input className="h-8 w-40 text-sm" value={f.label} onChange={(e) => updateInput(i, { label: e.target.value })} placeholder="Label" />
                    <select className="h-8 rounded-md border bg-background px-2 text-xs" value={f.type ?? "text"} onChange={(e) => updateInput(i, { type: e.target.value as TemplateInput["type"] })}>
                      <option value="text">Text</option>
                      <option value="multiline">Multiline</option>
                    </select>
                    <label className="flex items-center gap-1 text-xs text-muted-foreground"><input type="checkbox" checked={!!f.required} onChange={(e) => updateInput(i, { required: e.target.checked })} /> Required</label>
                    <Button variant="ghost" size="icon" className="ml-auto h-7 w-7 text-destructive" onClick={() => removeInput(i)}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                ))}
                <Button variant="outline" size="sm" onClick={addInput}><Plus className="h-4 w-4" /> Add input field</Button>
              </CardContent>
            </Card>

            {/* Blocks */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Content blocks</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {selected.blocks.map((b, i) => (
                  <div key={i} className="rounded-lg border p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <Badge variant="secondary">{BLOCK_KINDS.find((k) => k.kind === b.kind)?.label ?? b.kind}</Badge>
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="icon" className="h-7 w-7" disabled={i === 0} onClick={() => moveBlock(i, -1)}><ChevronUp className="h-4 w-4" /></Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" disabled={i === selected.blocks.length - 1} onClick={() => moveBlock(i, 1)}><ChevronDown className="h-4 w-4" /></Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => deleteBlock(i)}><Trash2 className="h-4 w-4" /></Button>
                      </div>
                    </div>
                    <div className="space-y-2">
                      {(b.kind === "subject" || b.kind === "para" || b.kind === "note") && (
                        <Textarea rows={b.kind === "para" ? 3 : 2} value={b.text ?? ""} onChange={(e) => updateBlock(i, { text: e.target.value })} placeholder="Text…" />
                      )}
                      {b.kind === "bullets" && (
                        <Textarea rows={4} value={(b.items ?? []).join("\n")} onChange={(e) => updateBlock(i, { items: e.target.value.split("\n") })} placeholder="One bullet per line" />
                      )}
                      {b.kind === "signature" && (
                        <div className="space-y-1">
                          <Input value={b.closing ?? ""} onChange={(e) => updateBlock(i, { closing: e.target.value })} placeholder="Closing, e.g. For and on behalf of {{company}}," />
                          <p className="text-xs text-muted-foreground">Company (1st-party) sign-off. Renders the authorized signatory name, title and e-signature image from Settings → Letter defaults.</p>
                        </div>
                      )}
                      {b.kind === "acceptance" && (
                        <p className="text-xs text-muted-foreground">Recipient (2nd-party) wet-ink acceptance: a printed Name / Date / Signature line for the employee to sign by hand.</p>
                      )}
                      {b.kind === "computed" && (
                        <select className="h-9 rounded-md border bg-background px-2 text-sm" value={b.ref ?? "ctc_annexure"} onChange={(e) => updateBlock(i, { ref: e.target.value as Block["ref"] })}>
                          <option value="ctc_annexure">CTC annexure table</option>
                          <option value="increment_table">Increment (old → new) table</option>
                          <option value="settlement_table">Settlement (FnF) table</option>
                        </select>
                      )}
                      {b.kind === "input" && (
                        <select className="h-9 rounded-md border bg-background px-2 text-sm" value={b.field ?? ""} onChange={(e) => updateBlock(i, { field: e.target.value })}>
                          <option value="" disabled>Select an input field…</option>
                          {(selected.inputs ?? []).filter((f) => f.type === "multiline").map((f) => <option key={f.key} value={f.key}>{f.label} ({f.key})</option>)}
                        </select>
                      )}
                      {b.kind === "gap" && (
                        <Input type="number" className="w-28" value={b.height ?? 8} onChange={(e) => updateBlock(i, { height: Number(e.target.value) })} />
                      )}
                      {b.kind === "esignature" && (
                        <div className="space-y-2">
                          <Input value={b.label ?? ""} onChange={(e) => updateBlock(i, { label: e.target.value })} placeholder="Caption under the line (default: Signature)" />
                          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <input type="checkbox" checked={!!b.withDate} onChange={(e) => updateBlock(i, { withDate: e.target.checked })} /> Add a date line aligned with the signature
                          </label>
                          <div className="flex gap-2">
                            {([["internal", "In-app signature"], ["cashfree", "Aadhaar e-Sign"]] as const).map(([val, label]) => (
                              <button key={val} type="button" onClick={() => updateBlock(i, { method: val })}
                                className={cn("flex-1 rounded-md border px-2.5 py-1.5 text-xs", (b.method ?? "internal") === val ? "border-primary bg-primary/10 font-medium text-foreground" : "text-muted-foreground hover:bg-accent")}>
                                {label}
                              </button>
                            ))}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {(b.method ?? "internal") === "cashfree"
                              ? "Recipient signs via Aadhaar OTP on the vendor page. Requires the E-signature master switch and Aadhaar vendor settings (Settings → E-signature) plus an Aadhaar on file."
                              : "Recipient signs in the app using the signature image on their profile."}
                            {" "}A letter with this block requires signing before it is complete.
                          </p>
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-3 pt-1">
                        {b.kind === "para" && (
                          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <input type="checkbox" checked={!!b.bold} onChange={(e) => updateBlock(i, { bold: e.target.checked })} /> Bold
                          </label>
                        )}
                        {b.kind !== "pageBreak" && b.kind !== "gap" && (
                          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">Show: {REQUIRES_SELECT(b.requires ?? "", (v) => updateBlock(i, { requires: v || undefined }))}</label>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                <div className="flex items-center gap-2 border-t pt-3">
                  <span className="text-xs text-muted-foreground">Add block:</span>
                  <Select value="" onValueChange={(v) => addBlock(v as Block["kind"])}>
                    <SelectTrigger className="h-8 w-44 text-sm"><SelectValue placeholder="Choose a block…" /></SelectTrigger>
                    <SelectContent>
                      {BLOCK_KINDS.map((k) => <SelectItem key={k.kind} value={k.kind}>{k.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>

            {/* Placeholder palette */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Placeholders</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <TooltipProvider delayDuration={150}>
                  {PLACEHOLDERS.map((g) => (
                    <div key={g.group}>
                      <p className="mb-1 text-xs font-medium text-muted-foreground">{g.group}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {g.tokens.map((tok) => (
                          <span key={tok} className="inline-flex items-center overflow-hidden rounded border bg-muted/50 font-mono text-xs">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button onClick={() => copyToken(tok)} className="px-1.5 py-0.5 hover:bg-accent">{`{{${tok}}}`}</button>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs whitespace-normal font-sans normal-case">{TOKEN_DESC[tok] ?? "Insert this placeholder."}</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button onClick={() => copyToken(tok)} aria-label="Copy" className="border-l px-1 py-0.5 hover:bg-accent"><Copy className="h-3 w-3 opacity-50" /></button>
                              </TooltipTrigger>
                              <TooltipContent className="font-sans">Copy</TooltipContent>
                            </Tooltip>
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </TooltipProvider>
              </CardContent>
            </Card>

            {/* Live preview */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Preview</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="Sample employee">
                    <Select value={previewEmp} onValueChange={setPreviewEmp}>
                      <SelectTrigger className="w-64"><SelectValue placeholder="Select an employee…" /></SelectTrigger>
                      <SelectContent>
                        {employees.filter((e) => !e.disabled).map((e) => (
                          <SelectItem key={e.path} value={idOf(e.path)}>{e.first_name} {e.last_name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <AccessAction collection="personal-documents" verb="previewLetter" label="Preview letter">
                    <Button variant="outline" onClick={runPreview} loading={previewing} disabled={!previewEmp}>{!previewing && <Eye className="h-4 w-4" />} Preview</Button>
                  </AccessAction>
                  <span className="text-xs text-muted-foreground">Renders the current (unsaved) draft.</span>
                </div>
                {previewUrl && <iframe title="Letter preview" src={previewUrl} className="h-[640px] w-full rounded-md border" />}
              </CardContent>
            </Card>
          </div>
        ) : (
          <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">Select or add a letter type to edit.</CardContent></Card>
        )}
      </div>
    </div>
  );
}

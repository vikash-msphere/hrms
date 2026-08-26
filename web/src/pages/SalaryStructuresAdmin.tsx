import { useCallback, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { create, patch } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { useSplitStaleness } from "@/hooks/useSplitStaleness";
import { SplitStaleBanner } from "@/components/common/SplitStaleBanner";
import { usePermission } from "@/lib/perm";
import { idOf } from "@/lib/utils";
import { useMoney } from "@/lib/org";
import { navigate } from "@/router";
import type { Me, SalaryStructure, SalaryStructureLine, PayComponent } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { DataTable, type Column } from "@/components/common/DataTable";
import { metaColumns } from "@/components/common/metaColumns";
import { SoftDeleteRowActions } from "@/components/common/SoftDeleteRowActions";
import { Field } from "@/components/common/Field";
import { FormError } from "@/components/common/FormError";
import { useDialogGuard } from "@/components/common/dialogGuard";
import { AccessScope } from "@/components/access/AccessScope";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

type FormLine = { component: string; rate: string }; // component = pay-components/{id}; rate "" = use default
type Form = { name: string; description: string; lines: FormLine[] };
const EMPTY: Form = { name: "", description: "", lines: [] };
const defaultRateLabel = (c?: PayComponent) =>
  !c ? "" : c.method === "percent_base" ? `${c.rate ?? 0}% of base` : c.method === "fixed" ? `${c.rate ?? 0}` : c.method;

export default function SalaryStructuresAdmin({ embedded, openId }: { me?: Me; embedded?: boolean; openId?: string }) {
  const { rows, state, error, reload } = useCollection<SalaryStructure>("salary-structures", { showDeleted: true });
  useDeepOpen(openId, rows, openEdit);
  const { rows: payComponents } = useCollection<PayComponent>("pay-components");
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  // A structure's earning lines feed each assigned employee's CTC split, so editing/deleting one can stale
  // their cached basic / Special-Allowance (annual CTC held fixed) - same shared signal as pay components.
  const { canReapply, staleCount, skippedCount, reapplying, reapply: doReapply, promptReapply } = useSplitStaleness();
  // Deleting / disabling / restoring a structure re-points every employee assigned to it, so it prompts to
  // propagate like an edit does. Silent when no split moved.
  const afterMutation = useCallback(() => { reload(); void promptReapply(); }, [reload, promptReapply]);
  const sd = useSoftDelete("salary-structures", "salary structure", afterMutation);
  const writable = usePermission("salary-structures.write");
  const canPurge = usePermission("salary-structures.admin");

  // Earning components are the only ones a structure can hold (deductions/statutory apply globally).
  // Deductions and statutory components are global, never part of a structure - the server
  // rejects them in a structure; keep them out of the picker too.
  const earnings = useMemo(() => payComponents.filter((c) => c.kind === "earning" && c.method !== "rate_qty" && !c.delete_time), [payComponents]);
  const byPath = useMemo(() => new Map(payComponents.map((c) => [c.path, c])), [payComponents]);
  const nameOf = (compPath: string) => byPath.get(compPath)?.display_name ?? idOf(compPath);

  const money = useMoney();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SalaryStructure | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [err, setErr] = useState<string | null>(null);
  const guard = useDialogGuard(open, form, () => setOpen(false), { label: "salary structure" });

  function openCreate() {
    setEditing(null);
    setForm(EMPTY);
    setErr(null);
    setOpen(true);
  }
  function openEdit(s: SalaryStructure) {
    setEditing(s);
    setForm({
      name: s.display_name,
      description: s.description ?? "",
      lines: (s.lines ?? []).map((l) => ({ component: l.component, rate: l.rate == null ? "" : String(l.rate) })),
    });
    setErr(null);
    setOpen(true);
  }

  const addLine = (component: string) => setForm((f) => (f.lines.some((l) => l.component === component) ? f : { ...f, lines: [...f.lines, { component, rate: "" }] }));
  const removeLine = (i: number) => setForm((f) => ({ ...f, lines: f.lines.filter((_, j) => j !== i) }));
  const setRate = (i: number, rate: string) => setForm((f) => ({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, rate } : l)) }));
  const unusedEarnings = earnings.filter((c) => !form.lines.some((l) => l.component === c.path));

  // What the structure claims of basic pay before the Special Allowance plug gets a look in. Percentages are
  // taken of basic, so anything at or over 100% leaves nothing for the plug and every CTC split under this
  // structure fails to solve - a failure that otherwise only appears later, on someone's compensation revision.
  const percentOfBasic = form.lines.reduce((sum, l) => {
    const c = byPath.get(l.component);
    if (c?.method !== "percent_base") return sum;
    const rate = l.rate.trim() === "" ? c.rate ?? 0 : Number(l.rate);
    return sum + (Number.isFinite(rate) ? rate : 0);
  }, 0);
  // Fixed lines are an absolute floor on the monthly CTC, so their sum is the smallest CTC this structure can price.
  const fixedFloor = form.lines.reduce((sum, l) => {
    const c = byPath.get(l.component);
    if (c?.method !== "fixed") return sum;
    const rate = l.rate.trim() === "" ? c.rate ?? 0 : Number(l.rate);
    return sum + (Number.isFinite(rate) ? rate : 0);
  }, 0);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const body = {
        display_name: form.name.trim(),
        description: form.description.trim() || null,
        lines: form.lines.map((l) => ({ component: l.component, rate: l.rate.trim() === "" ? null : Number(l.rate) })),
      };
      if (editing) {
        await patch("salary-structures/" + idOf(editing.path), body, editing.etag);
        toast({ title: "Salary structure updated", variant: "success" });
      } else {
        await create("salary-structures", body);
        toast({ title: "Salary structure created", variant: "success" });
      }
      setOpen(false);
      reload();
      // A structure's lines only matter for employees assigned to it; propagate the split if any went stale.
      await promptReapply();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<SalaryStructure>[] = [
    { id: "name", header: "Structure", accessor: (s) => s.display_name, cell: (s) => <span className="font-medium">{s.display_name}</span> },
    {
      id: "components",
      header: "Earning components",
      sortable: false,
      filter: "none",
      cell: (s) =>
        (s.lines ?? []).length === 0 ? (
          <span className="text-muted-foreground">none</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {(s.lines ?? []).map((l) => (
              <Badge key={l.component} variant="secondary">
                {nameOf(l.component)}{l.rate != null ? ` @ ${l.rate}` : ""}
              </Badge>
            ))}
          </span>
        ),
    },
    { id: "description", header: "Description", defaultHidden: true, accessor: (s) => s.description ?? "" },
    ...metaColumns<SalaryStructure>(),
    {
      id: "actions",
      header: "",
      sortable: false,
      filter: "none",
      align: "right",
      cell: (s) => <SoftDeleteRowActions row={s} writable={writable} canPurge={canPurge} actions={sd} onEdit={openEdit} />,
    },
  ];

  const createBtn = writable ? (
    <AccessAction collection="salary-structures" create>
      <Button size="sm" variant="outline" onClick={openCreate}><Plus className="h-4 w-4" /> New structure</Button>
    </AccessAction>
  ) : undefined;

  return (
    <div className="space-y-6">
      {!embedded && <PageHeader accessCollection="salary-structures" title="Salary Structures" description="Reusable earning breakdowns you assign to employees." />}

      <SplitStaleBanner staleCount={staleCount} skippedCount={skippedCount} reapplying={reapplying} canReapply={canReapply} onReapply={doReapply} />

      <DataState state={state} error={error} onRetry={reload}>
        <DataTable
          columns={columns}
          tableId="salary-structures"
          rows={rows}
          getRowId={(s) => s.path}
          rowClassName={(s) => (s.delete_time ? "opacity-60" : undefined)}
          emptyTitle="No salary structures"
          emptyDescription="Create a structure (e.g. Standard, Senior) and pick its earning components."
          emptyAction={createBtn}
          toolbar={createBtn}
          accessCollection="salary-structures"
          accessTargetOf={(s) => ({ objectPath: s.path, label: s.display_name, can: s.access?.can })}
        />
      </DataState>

      <Dialog open={open} onOpenChange={guard.onOpenChange}>
        <DialogContent scrollBody onEnterSubmit={() => { if (!busy && form.name.trim()) submit(); }}>
          <AccessScope collection="salary-structures" objectPath={editing?.path}>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit salary structure" : "New salary structure"}</DialogTitle>
            <DialogDescription>The earning lines an employee assigned this structure is paid on. Their annual CTC is split across these; a Special Allowance takes up the slack.</DialogDescription>
          </DialogHeader>
          <DialogBody>
          <FormError error={err} />
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Standard or Senior" autoFocus /></Field>
          <Field label="Description (optional)"><Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <Field label="Earning components" hint="Only earnings; deductions and EPF/TDS always apply. Leave the rate blank to use the component's own rate.">
            <div className="space-y-2">
              {form.lines.length === 0 && <p className="text-sm text-muted-foreground">No components yet.</p>}
              {form.lines.map((l, i) => {
                const c = byPath.get(l.component);
                return (
                  // 8rem of rate input plus the remove button leaves a component name ("House Rent
                  // Allowance") about 160px on a phone, where it wraps to three lines beside a one-line
                  // input. Name and remove on the first row, the rate under them; one row from `sm` up.
                  <div key={l.component} className="grid grid-cols-[1fr_auto] items-center gap-2 rounded-md border p-2 sm:grid-cols-[1fr_8rem_auto]">
                    <span className="min-w-0 text-sm font-medium">{nameOf(l.component)}</span>
                    <Button variant="ghost" size="icon" className="h-8 w-8 sm:hidden" onClick={() => removeLine(i)} aria-label="Remove"><Trash2 className="h-4 w-4" /></Button>
                    <Input type="number" value={l.rate} onChange={(e) => setRate(i, e.target.value)} placeholder={defaultRateLabel(c)} className="col-span-2 h-8 sm:col-span-1" />
                    <Button variant="ghost" size="icon" className="hidden h-8 w-8 sm:inline-flex" onClick={() => removeLine(i)} aria-label="Remove"><Trash2 className="h-4 w-4" /></Button>
                  </div>
                );
              })}
              {unusedEarnings.length > 0 ? (
                <Select value="" onValueChange={addLine}>
                  <SelectTrigger className="h-8"><SelectValue placeholder="Add earning component…" /></SelectTrigger>
                  <SelectContent>
                    {unusedEarnings.map((c) => <SelectItem key={c.path} value={c.path}>{c.display_name} ({defaultRateLabel(c)})</SelectItem>)}
                  </SelectContent>
                </Select>
              ) : (
                /* The picker used to just vanish here, which reads as a broken form rather than as "there is
                   nothing left to add" - and the two causes need different answers. */
                <p className="text-xs text-muted-foreground">
                  {earnings.length === 0 ? (
                    <>
                      No earning components exist yet - a structure is built out of them.{" "}
                      <button type="button" className="font-medium text-primary hover:underline" onClick={() => { setOpen(false); navigate("pay-components"); }}>
                        Create a pay component
                      </button>{" "}
                      first.
                    </>
                  ) : (
                    "Every earning component is already on this structure."
                  )}
                </p>
              )}
            </div>
          </Field>
          {form.lines.length > 0 && (
            <div className="space-y-1 rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Percentage lines claim</span>
                <span className="font-medium tabular-nums">{Math.round(percentOfBasic * 100) / 100}% of basic</span>
              </div>
              {fixedFloor > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Fixed lines</span>
                  <span className="font-medium tabular-nums">{money(fixedFloor)} a month, whatever the CTC</span>
                </div>
              )}
              {percentOfBasic >= 100 && (
                <p className="pt-1 text-xs font-medium text-destructive">Over 100% of basic - no CTC can be split under this structure. Trim a rate.</p>
              )}
            </div>
          )}
          {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => guard.onOpenChange(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={!form.name.trim()}>{editing ? "Save changes" : "Create"}</Button>
          </DialogFooter>
          </AccessScope>
        </DialogContent>
      </Dialog>
    </div>
  );
}

import { useMemo, useState } from "react";
import { Plus, Pencil, Trash2, Rocket, UserPlus, Lock, Unlock } from "lucide-react";
import { create, patch, invoke, remove } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { idOf } from "@/lib/utils";
import type { Department, Employee, ReviewCycle } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { Field } from "@/components/common/Field";
import { EmployeePicker } from "@/components/common/EmployeePicker";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";

const STATE: Record<ReviewCycle["state"], { label: string; variant: "muted" | "secondary" | "success" }> = {
  DRAFT: { label: "Draft", variant: "muted" },
  ACTIVE: { label: "Active", variant: "secondary" },
  CLOSED: { label: "Closed", variant: "success" },
};
const EMPTY = { name: "", period_start: "", period_end: "", self_due_date: "", manager_due_date: "" };

export default function ReviewCycles({ embedded }: { embedded?: boolean }) {
  const { rows, state, error, reload } = useCollection<ReviewCycle>("review-cycles");
  const { rows: employees } = useCollection<Employee>("employees");
  const { rows: departments } = useCollection<Department>("departments");
  const { toast } = useToast();
  const confirm = useConfirm();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ReviewCycle | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [picker, setPicker] = useState<{ cycle: ReviewCycle; mode: "launch" | "enroll" } | null>(null);
  const [busy, setBusy] = useState(false);

  const sorted = useMemo(() => [...rows].sort((a, b) => (b.create_time ?? "").localeCompare(a.create_time ?? "")), [rows]);
  const badRange = !!form.period_start && !!form.period_end && form.period_end < form.period_start;

  function openCreate() { setEditing(null); setForm(EMPTY); setOpen(true); }
  function openEdit(c: ReviewCycle) {
    setEditing(c);
    setForm({ name: c.name, period_start: c.period_start ?? "", period_end: c.period_end ?? "", self_due_date: c.self_due_date ?? "", manager_due_date: c.manager_due_date ?? "" });
    setOpen(true);
  }

  async function submit() {
    const body = {
      name: form.name.trim(),
      period_start: form.period_start || null,
      period_end: form.period_end || null,
      self_due_date: form.self_due_date || null,
      manager_due_date: form.manager_due_date || null,
    };
    setBusy(true);
    try {
      if (editing) await patch(`review-cycles/${idOf(editing.path)}`, body, editing.etag);
      else await create("review-cycles", body);
      toast({ title: editing ? "Cycle updated" : "Cycle created", variant: "success" });
      setOpen(false);
      reload();
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function runVerb(c: ReviewCycle, verb: string, body?: Record<string, unknown>, okMsg?: string) {
    try {
      await invoke(`review-cycles/${idOf(c.path)}`, verb, undefined, body);
      if (okMsg) toast({ title: okMsg, variant: "success" });
      reload();
    } catch (e) {
      toast({ title: "Action failed", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function del(c: ReviewCycle) {
    if (!(await confirm({ title: `Delete the "${c.name}" cycle?`, destructive: true, confirmLabel: "Delete" }))) return;
    try { await remove(`review-cycles/${idOf(c.path)}`); reload(); }
    catch (e) { toast({ title: "Couldn't delete", description: (e as Error).message, variant: "destructive" }); }
  }

  async function onPick(refs: string[]) {
    if (!picker) return;
    await runVerb(picker.cycle, picker.mode === "launch" ? "launch" : "enroll", { employees: refs }, picker.mode === "launch" ? "Cycle launched" : "Reviewees added");
    setPicker(null);
  }

  const createBtn = (
    <Button onClick={openCreate}><Plus className="h-4 w-4" /> New cycle</Button>
  );

  return (
    <div>
      {!embedded && <PageHeader accessCollection="review-cycles" title="Review Cycles" description="Run performance review cycles. Pick who's reviewed; track each cycle to close." actions={createBtn} />}
      {embedded && (
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold">Review cycles</h3>
            <p className="text-sm text-muted-foreground">Create a cycle, choose who's reviewed, and launch. Reviews appear on each person's Reviews page.</p>
          </div>
          {createBtn}
        </div>
      )}

      <DataState state={state} error={error} onRetry={reload}>
        {sorted.length === 0 ? (
          <EmptyState icon={Rocket} title="No review cycles" description="Create a cycle to start a round of performance reviews." action={createBtn} />
        ) : (
          <div className="space-y-3">
            {sorted.map((c) => {
              const can = c.access?.can ?? [];
              return (
                <Card key={c.path} className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{c.name}</span>
                      <Badge variant={STATE[c.state].variant}>{STATE[c.state].label}</Badge>
                      <span className="text-xs text-muted-foreground">{c.review_count ?? 0} {c.review_count === 1 ? "review" : "reviews"}</span>
                    </div>
                    {(c.period_start || c.period_end) && (
                      <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">{c.period_start ?? "…"} → {c.period_end ?? "…"}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {c.state === "DRAFT" && can.includes("launch") && (
                      <Button size="sm" onClick={() => setPicker({ cycle: c, mode: "launch" })}><Rocket className="h-3.5 w-3.5" /> Launch</Button>
                    )}
                    {c.state === "ACTIVE" && can.includes("enroll") && (
                      <Button variant="outline" size="sm" onClick={() => setPicker({ cycle: c, mode: "enroll" })}><UserPlus className="h-3.5 w-3.5" /> Add people</Button>
                    )}
                    {c.state === "ACTIVE" && can.includes("close") && (
                      <Button variant="outline" size="sm" onClick={() => runVerb(c, "close", undefined, "Cycle closed")}><Lock className="h-3.5 w-3.5" /> Close</Button>
                    )}
                    {c.state === "CLOSED" && can.includes("reopen") && (
                      <Button variant="outline" size="sm" onClick={() => runVerb(c, "reopen", undefined, "Cycle reopened")}><Unlock className="h-3.5 w-3.5" /> Reopen</Button>
                    )}
                    {can.includes("update") && (
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(c)} aria-label="Edit"><Pencil className="h-3.5 w-3.5" /></Button>
                    )}
                    {c.state === "DRAFT" && can.includes("delete") && (
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => del(c)} aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </DataState>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onEnterSubmit={() => { if (!busy && form.name.trim() && !badRange) submit(); }}>
          <DialogHeader><DialogTitle>{editing ? "Edit cycle" : "New review cycle"}</DialogTitle></DialogHeader>
          <Field label="Name"><Input value={form.name} placeholder="e.g. H1 2026 Review" onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Period start (optional)"><Input type="date" value={form.period_start} onChange={(e) => setForm({ ...form, period_start: e.target.value })} /></Field>
            <Field label="Period end (optional)" error={badRange ? "End is before the start." : undefined}><Input type="date" value={form.period_end} min={form.period_start || undefined} onChange={(e) => setForm({ ...form, period_end: e.target.value })} /></Field>
            <Field label="Self-review due (optional)"><Input type="date" value={form.self_due_date} onChange={(e) => setForm({ ...form, self_due_date: e.target.value })} /></Field>
            <Field label="Manager review due (optional)"><Input type="date" value={form.manager_due_date} onChange={(e) => setForm({ ...form, manager_due_date: e.target.value })} /></Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={!form.name.trim() || badRange}>{editing ? "Save changes" : "Create"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {picker && (
        <EmployeePicker
          title={picker.mode === "launch" ? `Launch "${picker.cycle.name}"` : `Add people to "${picker.cycle.name}"`}
          confirmLabel={picker.mode === "launch" ? "Launch cycle" : "Add reviewees"}
          employees={employees}
          departments={departments}
          onClose={() => setPicker(null)}
          onConfirm={onPick}
        />
      )}
    </div>
  );
}

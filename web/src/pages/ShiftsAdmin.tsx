import { useMemo, useState } from "react";
import { Plus, Pencil, Trash2, CalendarClock } from "lucide-react";
import { create, patch, remove } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { idOf } from "@/lib/utils";
import type { Shift } from "@/types";
import { DataState } from "@/components/common/DataState";
import { AccessScope } from "@/components/access/AccessScope";
import { AccessAction } from "@/components/access/AccessAction";
import { AccessItem } from "@/components/access/AccessItem";
import { EmptyState } from "@/components/common/EmptyState";
import { Field } from "@/components/common/Field";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";

const COLORS = ["#6366f1", "#3b82f6", "#0ea5e9", "#14b8a6", "#22c55e", "#f59e0b", "#f97316", "#ef4444", "#ec4899", "#a855f7", "#64748b"];
const EMPTY = { name: "", start: "09:00", end: "18:00", break_minutes: "0", color: COLORS[1] };

// HR editor for the shift catalog (Settings → Time off → Shifts).
export default function ShiftsAdmin({ openId }: { openId?: string }) {
  const { rows, state, error, reload } = useCollection<Shift>("shifts");
  useDeepOpen(openId, rows, openEdit);
  const { toast } = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Shift | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);

  const sorted = useMemo(() => [...rows].sort((a, b) => (a.start ?? "").localeCompare(b.start ?? "")), [rows]);

  function openCreate() { setEditing(null); setForm({ ...EMPTY, color: COLORS[rows.length % COLORS.length] }); setOpen(true); }
  function openEdit(s: Shift) {
    setEditing(s);
    setForm({ name: s.name, start: s.start, end: s.end, break_minutes: String(s.break_minutes ?? 0), color: s.color ?? COLORS[0] });
    setOpen(true);
  }
  async function save() {
    const body = { name: form.name.trim(), start: form.start, end: form.end, break_minutes: Number(form.break_minutes) || 0, color: form.color };
    setBusy(true);
    try {
      if (editing) await patch(`shifts/${idOf(editing.path)}`, body, editing.etag);
      else await create("shifts", body);
      toast({ title: editing ? "Shift updated" : "Shift added", variant: "success" });
      setOpen(false); reload();
    } catch (e) { toast({ title: "Couldn't save the shift", description: (e as Error).message, variant: "destructive" }); }
    finally { setBusy(false); }
  }
  async function del(s: Shift) {
    if (!(await confirm({ title: `Delete the "${s.name}" shift?`, destructive: true, confirmLabel: "Delete" }))) return;
    try { await remove(`shifts/${idOf(s.path)}`); reload(); }
    catch (e) { toast({ title: "Couldn't delete", description: (e as Error).message, variant: "destructive" }); }
  }

  return (
    // Settings-embedded editor: no route scope to inherit, so bind the shifts collection explicitly.
    <AccessScope collection="shifts">
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">
            <AccessAction collection="shifts" label="Shifts"><span>Shifts</span></AccessAction>
          </h3>
          <p className="text-sm text-muted-foreground">Reusable shift patterns for the roster. Times are wall-clock.</p>
        </div>
        <AccessAction create label="Shift">
          <Button onClick={openCreate}><Plus className="h-4 w-4" /> New shift</Button>
        </AccessAction>
      </div>

      <DataState state={state} error={error} onRetry={reload}>
        {sorted.length === 0 ? (
          <EmptyState icon={CalendarClock} title="No shifts" description="Add a shift pattern to assign on the schedule." action={<Button onClick={openCreate}><Plus className="h-4 w-4" /> New shift</Button>} />
        ) : (
          <div className="space-y-2">
            {sorted.map((s) => (
              <AccessItem key={s.path} objectPath={s.path} can={s.access?.can} label={s.name}>
              <Card className="flex items-center justify-between gap-3 p-3">
                <div className="flex items-center gap-3">
                  <span className="h-8 w-2 rounded-full" style={{ backgroundColor: s.color ?? "#64748b" }} />
                  <div>
                    <span className="font-medium">{s.name}</span>
                    <p className="text-xs tabular-nums text-muted-foreground">{s.start}–{s.end}{s.break_minutes ? ` · ${s.break_minutes}m break` : ""}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(s)} aria-label="Edit"><Pencil className="h-3.5 w-3.5" /></Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => del(s)} aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              </Card>
              </AccessItem>
            ))}
          </div>
        )}
      </DataState>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onEnterSubmit={() => { if (!busy && form.name.trim()) save(); }}>
          <DialogHeader><DialogTitle>{editing ? "Edit shift" : "New shift"}</DialogTitle></DialogHeader>
          <Field label="Name"><Input value={form.name} placeholder="e.g. Day 9–6" onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
          <div className="grid grid-cols-3 gap-4">
            <Field label="Start"><Input type="time" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} /></Field>
            <Field label="End"><Input type="time" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} /></Field>
            <Field label="Break (min)"><Input type="number" min={0} value={form.break_minutes} onChange={(e) => setForm({ ...form, break_minutes: e.target.value })} /></Field>
          </div>
          <Field label="Color">
            <div className="flex flex-wrap gap-2">
              {COLORS.map((c) => (
                <button key={c} type="button" aria-label={c} onClick={() => setForm({ ...form, color: c })}
                  className={`h-6 w-6 rounded-full ring-2 ring-offset-2 ring-offset-background ${form.color === c ? "ring-foreground" : "ring-transparent"}`}
                  style={{ backgroundColor: c }} />
              ))}
            </div>
          </Field>
          {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={save} loading={busy} disabled={!form.name.trim()}>{editing ? "Save changes" : "Create"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </AccessScope>
  );
}

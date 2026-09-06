import { useMemo, useRef, useState } from "react";
import { Plus, Pencil, Trash2, CalendarClock, Check, Moon } from "lucide-react";
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
import { WriteDialog } from "@/components/common/WriteDialog";
import { fmtDuration } from "@/components/common/TimeRangeField";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";

const COLORS = ["#6366f1", "#3b82f6", "#0ea5e9", "#14b8a6", "#22c55e", "#f59e0b", "#f97316", "#ef4444", "#ec4899", "#a855f7", "#64748b"];
const EMPTY = { name: "", start: "09:00", end: "18:00", break_minutes: "0", color: COLORS[1] };

// The four patterns nearly every roster starts from. A preset fills the times (and the name, while it is still
// untouched), so the common case is one click instead of two time pickers.
const PRESETS: { name: string; start: string; end: string; break_minutes: string }[] = [
  { name: "Morning", start: "06:00", end: "14:00", break_minutes: "30" },
  { name: "Day", start: "09:00", end: "18:00", break_minutes: "60" },
  { name: "Evening", start: "14:00", end: "22:00", break_minutes: "30" },
  { name: "Night", start: "22:00", end: "06:00", break_minutes: "30" },
];

const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return (h || 0) * 60 + (m || 0); };
// A shift that ends at or before it starts runs past midnight, which is how night shifts are expressed.
const spanOf = (start: string, end: string) => { const d = toMin(end) - toMin(start); return d > 0 ? d : d + 1440; };

// HR editor for the shift catalog (Settings → Time off → Shifts).
export default function ShiftsAdmin({ openId }: { openId?: string }) {
  const { rows, state, error, reload } = useCollection<Shift>("shifts");
  useDeepOpen(openId, rows, openEdit);
  const { toast } = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Shift | null>(null);
  const [form, setForm] = useState(EMPTY);
  const nameRef = useRef<HTMLInputElement>(null);

  const sorted = useMemo(() => [...rows].sort((a, b) => (a.start ?? "").localeCompare(b.start ?? "")), [rows]);

  // Live shape of the shift being edited: what it pays, whether it crosses midnight, and whether it is savable.
  const spanMin = spanOf(form.start, form.end);
  const breakMin = Math.max(0, Number(form.break_minutes) || 0);
  const paidMin = spanMin - breakMin;
  const overnight = toMin(form.end) <= toMin(form.start);
  const sameTime = form.start === form.end;
  const breakTooLong = breakMin >= spanMin;
  // Two shifts with the same name are indistinguishable everywhere they matter (roster cell, legend, filter),
  // so the clash is caught here rather than discovered on the grid.
  const duplicateName = !!form.name.trim() && rows.some((s) => s.path !== editing?.path && s.name.trim().toLowerCase() === form.name.trim().toLowerCase());
  const canSave = !!form.name.trim() && !sameTime && !breakTooLong && !duplicateName;

  // A preset also names the shift while the name is still untouched (or matches another preset), so it never
  // overwrites something typed by hand.
  function applyPreset(p: (typeof PRESETS)[number]) {
    setForm((f) => {
      const untouched = !f.name.trim() || PRESETS.some((x) => x.name === f.name.trim());
      return { ...f, start: p.start, end: p.end, break_minutes: p.break_minutes, name: untouched ? p.name : f.name };
    });
  }

  function openCreate() {
    setEditing(null);
    setForm({ ...EMPTY, color: COLORS[rows.length % COLORS.length] });
    setOpen(true);
  }
  function openEdit(s: Shift) {
    setEditing(s);
    setForm({ name: s.name, start: s.start, end: s.end, break_minutes: String(s.break_minutes ?? 0), color: s.color ?? COLORS[0] });
    setOpen(true);
  }
  async function save() {
    const body = { name: form.name.trim(), start: form.start, end: form.end, break_minutes: Number(form.break_minutes) || 0, color: form.color };
    if (editing) await patch(`shifts/${idOf(editing.path)}`, body, editing.etag);
    else await create("shifts", body);
    toast({ title: editing ? "Shift updated" : "Shift added", variant: "success" });
    reload();
  }
  // "Save & add another": next colour in the rotation, focus back on the name.
  function nextBlank() {
    setForm({ ...EMPTY, color: COLORS[(rows.length + 1) % COLORS.length] });
    nameRef.current?.focus();
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
          <EmptyState icon={CalendarClock} title="No shifts" description="Add a shift pattern to assign on the schedule." action={<AccessAction create label="Shift"><Button onClick={openCreate}><Plus className="h-4 w-4" /> New shift</Button></AccessAction>} />
        ) : (
          <div className="space-y-2">
            {sorted.map((s) => (
              <AccessItem key={s.path} objectPath={s.path} can={s.access?.can} label={s.name}>
              <Card className="flex items-center justify-between gap-3 p-3">
                <div className="flex items-center gap-3">
                  <span className="h-8 w-2 rounded-full" style={{ backgroundColor: s.color ?? "#64748b" }} />
                  <div>
                    <span className="font-medium">{s.name}</span>
                    {/* Paid length is what a scheduler actually compares shifts on, so it sits beside the times. */}
                    <p className="flex flex-wrap items-center gap-x-1.5 text-xs tabular-nums text-muted-foreground">
                      <span>{s.start}–{s.end}</span>
                      <span aria-hidden>·</span>
                      <span className="font-medium text-foreground">{fmtDuration(Math.max(0, spanOf(s.start, s.end) - (s.break_minutes ?? 0)))}</span>
                      {s.break_minutes ? <span>· {s.break_minutes}m break</span> : null}
                      {toMin(s.end) <= toMin(s.start) && (
                        <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400"><Moon className="h-3 w-3" /> overnight</span>
                      )}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <AccessAction objectPath={s.path} can={s.access?.can} verb="update" label={s.name}>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(s)} aria-label="Edit"><Pencil className="h-3.5 w-3.5" /></Button>
                  </AccessAction>
                  <AccessAction objectPath={s.path} can={s.access?.can} verb="delete" label={s.name}>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => del(s)} aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>
                  </AccessAction>
                </div>
              </Card>
              </AccessItem>
            ))}
          </div>
        )}
      </DataState>

      <WriteDialog
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? "Edit shift" : "New shift"}
        description="A pattern the roster assigns by name and colour. Times are wall-clock, and a shift may run past midnight."
        collection="shifts"
        objectPath={editing?.path}
        guardLabel="shift"
        form={form}
        submitLabel={editing ? "Save changes" : "Create"}
        canSubmit={canSave}
        whyNot={
          !form.name.trim() ? "Give the shift a name." : duplicateName ? "Another shift already has that name." : sameTime ? "The start and end times are the same." : breakTooLong ? "The break is longer than the shift." : undefined
        }
        onSubmit={save}
        addAnother={editing ? undefined : nextBlank}
      >
          {!editing && (
            <div className="space-y-1.5">
              <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">Start from</span>
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((p) => (
                  <button key={p.name} type="button" onClick={() => applyPreset(p)}
                    className="shrink-0 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-primary hover:bg-primary/10 hover:text-primary coarse:min-h-9 coarse:px-3.5">
                    {p.name} <span className="tabular-nums opacity-70">{p.start}–{p.end}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {/* Eager, all three: none of these is a half-typed value the reader is about to finish - a clash is
              with ANOTHER shift, and the break and end-time rules are about a different field. They also
              gate Save, so held back they leave a disabled button with nothing on the form saying why. */}
          <Field label="Name" eager error={duplicateName ? "Another shift already has this name." : undefined}>
            <Input ref={nameRef} value={form.name} placeholder={`e.g. Day ${form.start}–${form.end}`} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
          </Field>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Field label="Start"><Input type="time" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} /></Field>
            <Field label="End" eager error={sameTime ? "Pick a different end time." : undefined}><Input type="time" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} /></Field>
            <Field label="Unpaid break" hint="minutes" eager error={breakTooLong ? "Shorter than the shift." : undefined} className="col-span-2 sm:col-span-1">
              <Input type="number" min={0} step={5} value={form.break_minutes} onChange={(e) => setForm({ ...form, break_minutes: e.target.value })} />
            </Field>
          </div>
          {/* What the shift will actually look like on the roster, and what it pays, before it is saved -
              the two questions a scheduler has after typing times. */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/20 p-3">
            <span className="flex h-12 min-w-[6rem] flex-col items-center justify-center rounded-md px-2 text-xs font-medium"
              style={{ backgroundColor: form.color + "22", color: form.color }}>
              <span className="max-w-[10rem] truncate">{form.name.trim() || "Shift"}</span>
              <span className="tabular-nums opacity-80">{form.start}-{form.end}</span>
            </span>
            <div className="text-right text-xs text-muted-foreground">
              <p className="text-sm font-semibold tabular-nums text-foreground">{fmtDuration(Math.max(0, paidMin))} paid</p>
              <p className="tabular-nums">
                {fmtDuration(spanMin)} on site{breakMin ? ` · ${breakMin}m unpaid break` : ""}
              </p>
              {overnight && <p className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400"><Moon className="h-3 w-3" /> ends next day</p>}
            </div>
          </div>
          <Field label="Color" hint="Colour is how the shift reads at a glance on the roster grid.">
            <div className="flex flex-wrap gap-2">
              {COLORS.map((c) => (
                <button key={c} type="button" aria-label={`Colour ${c}`} aria-pressed={form.color === c} onClick={() => setForm({ ...form, color: c })}
                  className={`flex h-7 w-7 items-center justify-center rounded-full ring-2 ring-offset-2 ring-offset-background transition-transform hover:scale-110 ${form.color === c ? "ring-foreground" : "ring-transparent"}`}
                  style={{ backgroundColor: c }}>
                  {form.color === c && <Check className="h-3.5 w-3.5 text-white" />}
                </button>
              ))}
            </div>
          </Field>
          {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
      </WriteDialog>
    </div>
    </AccessScope>
  );
}

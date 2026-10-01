import { useMemo, useRef, useState } from "react";
import { Plus, Pencil, Trash2, CalendarRange, Check } from "lucide-react";
import { create, patch, remove } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { cn, formatHHMM, idOf } from "@/lib/utils";
import type { Shift, WorkPattern, WorkPatternAssignment } from "@/types";
import { DataState } from "@/components/common/DataState";
import { TruncationNotice } from "@/components/common/TruncationNotice";
import { AccessScope } from "@/components/access/AccessScope";
import { AccessAction } from "@/components/access/AccessAction";
import { AccessItem } from "@/components/access/AccessItem";
import { EmptyState } from "@/components/common/EmptyState";
import { Field } from "@/components/common/Field";
import { WriteDialog } from "@/components/common/WriteDialog";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";

const COLORS = ["#6366f1", "#3b82f6", "#0ea5e9", "#14b8a6", "#22c55e", "#f59e0b", "#f97316", "#ef4444", "#ec4899", "#a855f7", "#64748b"];
// The cycle is STORED weekday 0=Sun..6=Sat (src/domain/workSchedule.ts), and read Monday-first everywhere a
// person looks at it. `SLOT[column]` is the stored index of the column, so the grid can be built in reading
// order without the storage order ever bending to it.
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SLOT = [1, 2, 3, 4, 5, 6, 0];
const MAX_CYCLE_WEEKS = 8;

// The cycles nearly every org starts from, so the common case is one click rather than seven pickers. The
// shift they use is whichever the admin picked last (or the first in the catalog) - the preset decides WHICH
// DAYS are worked, which is the part that is tedious to fill in by hand.
const PRESETS: { name: string; weeks: number; worked: number[] }[] = [
  { name: "Full week (Mon-Fri)", weeks: 1, worked: [1, 2, 3, 4, 5] },
  { name: "Mon/Wed/Fri", weeks: 1, worked: [1, 3, 5] },
  { name: "Four-day week (Mon-Thu)", weeks: 1, worked: [1, 2, 3, 4] },
  { name: "Weekends", weeks: 1, worked: [6, 0] },
];

const blankCycle = (weeks: number): (string | null)[] => Array<string | null>(weeks * 7).fill(null);

/**
 * HR editor for the schedule catalog (Settings → Time & leave → Schedules).
 *
 * A schedule is the repeating shape of somebody's week: which days they work, and on which shift. It is the
 * middle layer of a resolved day - a roster entry beats it, and it beats the org's own working week - so what
 * is drawn here is what the attendance grid, the leave charge and the payroll build all read.
 */
export default function WorkPatternsPanel({ openId }: { openId?: string }) {
  // `all` for the reason the shift editor gives: this is the whole catalog as a card list, and a card list has
  // nowhere to admit it is showing a window. The roster reads all of it too, so the editor must agree.
  const { rows, state, error, reload } = useCollection<WorkPattern>("work-patterns", { all: true });
  const { rows: shifts } = useCollection<Shift>("shifts", { all: true });
  // WHO IS STILL ON EACH ONE. Retiring a schedule leaves them on it (see `del` below), so the number is what
  // makes that sentence checkable rather than reassuring: "3 people" is the difference between retiring a
  // draft and retiring the schedule half the warehouse works.
  const { rows: assignments } = useCollection<WorkPatternAssignment>("work-pattern-assignments", { all: true });
  useDeepOpen(openId, rows, openEdit);
  const { toast } = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<WorkPattern | null>(null);
  const [name, setName] = useState("");
  const [weeks, setWeeks] = useState(1);
  const [days, setDays] = useState<(string | null)[]>(blankCycle(1));
  const [color, setColor] = useState(COLORS[0]!);
  // Which shift a click fills a day with. A cycle is mostly one shift repeated, so the picker is a brush
  // rather than a per-cell dropdown: click days to put this shift on them, click again to clear.
  const [brush, setBrush] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  const shiftById = useMemo(() => new Map(shifts.map((s) => [idOf(s.path), s])), [shifts]);
  const onPattern = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of assignments) {
      if (!a.pattern || a.delete_time) continue;
      m.set(idOf(a.pattern), (m.get(idOf(a.pattern)) ?? 0) + 1);
    }
    return m;
  }, [assignments]);
  const sorted = useMemo(() => [...rows].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")), [rows]);
  const worked = days.filter(Boolean).length;
  const duplicateName = !!name.trim() && rows.some((p) => p.path !== editing?.path && (p.name ?? "").trim().toLowerCase() === name.trim().toLowerCase());
  // A cycle with no working day at all is a schedule that says nobody ever works, which is never what somebody
  // meant to save - and it would quietly stop every day being owed for the people put on it.
  const canSave = !!name.trim() && !duplicateName && worked > 0;

  const effectiveBrush = brush || (shifts[0] ? `shifts/${idOf(shifts[0].path)}` : "");

  function setWeekCount(n: number) {
    setWeeks(n);
    // The existing weeks are KEPT when the cycle grows or shrinks, so widening a one-week pattern to two does
    // not wipe the week already filled in.
    setDays((prev) => {
      const next = blankCycle(n);
      for (let i = 0; i < Math.min(prev.length, next.length); i++) next[i] = prev[i]!;
      return next;
    });
  }
  function toggleDay(index: number) {
    if (!effectiveBrush) return;
    const id = idOf(effectiveBrush);
    setDays((prev) => prev.map((d, i) => (i === index ? (d === id ? null : id) : d)));
  }
  function applyPreset(p: (typeof PRESETS)[number]) {
    if (!effectiveBrush) return;
    const id = idOf(effectiveBrush);
    setWeeks(p.weeks);
    setDays(Array.from({ length: p.weeks * 7 }, (_, i) => (p.worked.includes(i % 7) ? id : null)));
    if (!name.trim() || PRESETS.some((x) => x.name === name.trim())) setName(p.name);
  }

  function openCreate() {
    setEditing(null);
    setName(""); setWeeks(1); setDays(blankCycle(1)); setBrush("");
    setColor(COLORS[rows.length % COLORS.length]!);
    setOpen(true);
  }
  function openEdit(p: WorkPattern) {
    setEditing(p);
    const w = Math.max(1, p.cycle_weeks ?? 1);
    setName(p.name ?? "");
    setWeeks(w);
    // A stored cycle whose length disagrees with its own `cycle_weeks` is what the resolver drops rather than
    // half-reads, so the editor pads it back to the length it claims instead of rendering a short grid.
    const stored = (p.days ?? []).map((d) => (d ? idOf(d) : null));
    setDays(Array.from({ length: w * 7 }, (_, i) => stored[i] ?? null));
    setColor(p.color ?? COLORS[0]!);
    setBrush("");
    setOpen(true);
  }
  async function save() {
    // `days` goes as RESOURCE PATHS, and a rest day goes as null - the array is always exactly `weeks * 7`
    // long, which the server checks rather than trusts.
    const body = {
      name: name.trim(),
      cycle_weeks: weeks,
      days: days.map((d) => (d ? `shifts/${d}` : null)),
      color,
    };
    if (editing) await patch(`work-patterns/${idOf(editing.path)}`, body, editing.etag);
    else await create("work-patterns", body);
    toast({ title: editing ? "Schedule updated" : "Schedule added", variant: "success" });
    reload();
  }
  function nextBlank() {
    setName(""); setDays(blankCycle(weeks));
    setColor(COLORS[(rows.length + 1) % COLORS.length]!);
    nameRef.current?.focus();
  }
  async function del(p: WorkPattern) {
    // Retiring a schedule does NOT take the people on it off it (services/workPatterns.ts): their assignments
    // keep resolving, because dropping them back onto the org's week would change what they are owed by way of
    // a catalog edit. Said out loud here, since the button would otherwise read as "stop using this".
    const on = onPattern.get(idOf(p.path)) ?? 0;
    if (!(await confirm({
      title: `Retire the "${p.name}" schedule?`,
      description: on
        ? `It stops being offered when assigning schedules. The ${on === 1 ? "person" : `${on} people`} already on it stay on it and keep working these days - move them onto another schedule first if that is what you want.`
        : "It stops being offered when assigning schedules. Nobody is on it.",
      destructive: true,
      confirmLabel: "Retire",
    }))) return;
    try { await remove(`work-patterns/${idOf(p.path)}`); reload(); }
    catch (e) { toast({ title: "Couldn't retire it", description: (e as Error).message, variant: "destructive" }); }
  }

  return (
    <AccessScope collection="work-patterns">
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">
            <AccessAction collection="work-patterns" label="Schedules"><span>Schedules</span></AccessAction>
          </h3>
          <p className="text-sm text-muted-foreground">
            A repeating week (or rotation) of shifts and rest days. Assign one on the roster; it decides which days those people are expected in.
          </p>
        </div>
        <AccessAction create label="Schedule">
          <Button onClick={openCreate} disabled={shifts.length === 0}><Plus className="h-4 w-4" /> New schedule</Button>
        </AccessAction>
      </div>

      <TruncationNotice collection={["work-patterns", "shifts"]} what="schedules and shifts" className="mb-3" />
      {shifts.length === 0 && (
        <p className="mb-3 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
          Add some shifts first - a schedule is built out of them.
        </p>
      )}
      <DataState state={state} error={error} onRetry={reload}>
        {sorted.length === 0 ? (
          <EmptyState
            icon={CalendarRange}
            title="No schedules yet"
            description="Define the working weeks your org uses - a full week, part-time days, a rotating roster - and assign them to people from the roster."
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {sorted.map((p) => {
              const cycle = (p.days ?? []).map((d) => (d ? idOf(d) : null));
              const w = Math.max(1, p.cycle_weeks ?? 1);
              return (
                <AccessItem key={p.path} objectPath={p.path} can={p.access?.can} label={p.name}>
                  <Card className="p-3">
                    <div className="mb-2 flex items-start gap-2">
                      <span className="mt-0.5 h-8 w-2 shrink-0 rounded-full" style={{ backgroundColor: p.color ?? "#64748b" }} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{p.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {w > 1 ? `${w}-week rotation · ` : ""}{cycle.filter(Boolean).length} working {cycle.filter(Boolean).length === 1 ? "day" : "days"}
                          {onPattern.get(idOf(p.path)) ? ` · ${onPattern.get(idOf(p.path))} on it` : ""}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Edit ${p.name}`} onClick={() => openEdit(p)}><Pencil className="h-3.5 w-3.5" /></Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" aria-label={`Retire ${p.name}`} onClick={() => del(p)}><Trash2 className="h-3.5 w-3.5" /></Button>
                      </div>
                    </div>
                    {/* The cycle as it reads, so a name is never the only thing distinguishing two schedules. */}
                    <div className="space-y-1">
                      {Array.from({ length: w }, (_, wi) => (
                        <div key={wi} className="flex flex-wrap items-center gap-1 text-[11px]">
                          {w > 1 && <span className="w-12 shrink-0 text-muted-foreground">Wk {wi + 1}</span>}
                          {DOW.map((label, ci) => {
                            const s = cycle[wi * 7 + SLOT[ci]!] ? shiftById.get(cycle[wi * 7 + SLOT[ci]!]!) : undefined;
                            return (
                              <span key={label} className={cn("rounded px-1.5 py-0.5", s ? "font-medium" : "text-muted-foreground/50")}
                                style={s ? { backgroundColor: (s.color ?? "#64748b") + "22", color: s.color ?? undefined } : undefined}>
                                {label}
                              </span>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </Card>
                </AccessItem>
              );
            })}
          </div>
        )}
      </DataState>

      <WriteDialog
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? "Edit schedule" : "New schedule"}
        description="A repeating week, or a rotation of up to eight. A day with no shift is a rest day: nothing is owed on it and nobody is marked absent for it."
        collection="work-patterns"
        objectPath={editing?.path}
        guardLabel="schedule"
        form={{ name, weeks, days, color }}
        submitLabel={editing ? "Save changes" : "Create"}
        canSubmit={canSave}
        whyNot={
          !name.trim() ? "Give the schedule a name." : duplicateName ? "Another schedule already has that name." : worked === 0 ? "Pick at least one working day." : undefined
        }
        onSubmit={save}
        addAnother={editing ? undefined : nextBlank}
      >
        <Field label="Name" eager error={duplicateName ? "Another schedule already has this name." : undefined}>
          <Input ref={nameRef} value={name} placeholder="e.g. Part-time mornings" onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Repeats every" hint="weeks">
            <Select value={String(weeks)} onValueChange={(v) => setWeekCount(Number(v))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Array.from({ length: MAX_CYCLE_WEEKS }, (_, i) => i + 1).map((n) => (
                  <SelectItem key={n} value={String(n)}>{n === 1 ? "1 week" : `${n} weeks`}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Shift to place" hint="click days to put this shift on them">
            <Select value={effectiveBrush} onValueChange={setBrush}>
              <SelectTrigger><SelectValue placeholder="Pick a shift" /></SelectTrigger>
              <SelectContent>
                {shifts.map((s) => <SelectItem key={s.path} value={`shifts/${idOf(s.path)}`}>{s.name} · {formatHHMM(s.start)} - {formatHHMM(s.end)}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        </div>
        {!editing && (
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <Button key={p.name} type="button" variant="outline" size="sm" className="h-7 text-xs" disabled={!effectiveBrush} onClick={() => applyPreset(p)}>
                {p.name}
              </Button>
            ))}
          </div>
        )}
        <Field label="Working days" hint={`${worked} working ${worked === 1 ? "day" : "days"} per ${weeks > 1 ? "cycle" : "week"}. A day with no shift is a rest day.`}>
          <div className="space-y-1.5">
            {Array.from({ length: weeks }, (_, wi) => (
              <div key={wi} className="flex items-center gap-1.5">
                {weeks > 1 && <span className="w-12 shrink-0 text-xs text-muted-foreground">Wk {wi + 1}</span>}
                {DOW.map((label, ci) => {
                  const index = wi * 7 + SLOT[ci]!;
                  const id = days[index];
                  const s = id ? shiftById.get(id) : undefined;
                  return (
                    <button key={label} type="button" aria-pressed={!!s} disabled={!effectiveBrush}
                      aria-label={`Week ${wi + 1} ${label}${s ? `, ${s.name}` : ", rest day"}`}
                      onClick={() => toggleDay(index)}
                      title={s ? `${s.name} ${formatHHMM(s.start)} - ${formatHHMM(s.end)}` : "Rest day"}
                      className={cn(
                        "flex h-12 flex-1 flex-col items-center justify-center rounded-md border text-[11px] transition-colors",
                        s ? "font-medium" : "border-dashed text-muted-foreground/60",
                        effectiveBrush ? "hover:border-primary" : "cursor-not-allowed",
                      )}
                      style={s ? { backgroundColor: (s.color ?? "#64748b") + "22", color: s.color ?? undefined, borderColor: s.color ?? undefined } : undefined}>
                      <span>{label}</span>
                      <span className="tabular-nums opacity-80">{s ? s.start : "off"}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </Field>
        <Field label="Color" hint="How the schedule reads at a glance on the roster.">
          <div className="flex flex-wrap gap-2">
            {COLORS.map((c) => (
              <button key={c} type="button" aria-label={`Colour ${c}`} aria-pressed={color === c} onClick={() => setColor(c)}
                className={cn("flex h-7 w-7 items-center justify-center rounded-full ring-2 ring-offset-2 ring-offset-background transition-transform hover:scale-110", color === c ? "ring-foreground" : "ring-transparent")}
                style={{ backgroundColor: c }}>
                {color === c && <Check className="h-3.5 w-3.5 text-white" />}
              </button>
            ))}
          </div>
        </Field>
      </WriteDialog>
    </div>
    </AccessScope>
  );
}

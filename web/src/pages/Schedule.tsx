import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, Check, ChevronLeft, ChevronRight, Plus, Trash2 } from "lucide-react";
import { get, create, patch, remove } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useClock } from "@/lib/clock";
import { usePermission } from "@/lib/perm";
import { cn, idOf } from "@/lib/utils";
import type { Department, Employee, Holiday, Me, Shift, ShiftAssignment } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings } from "@/components/common/SettingsButton";
import { AccessScope } from "@/components/access/AccessScope";
import { EmptyState } from "@/components/common/EmptyState";
import { Field } from "@/components/common/Field";
import { FormError } from "@/components/common/FormError";
import { useDiscardGuard } from "@/hooks/useDiscardGuard";
import { fmtDuration } from "@/components/common/TimeRangeField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";

const DAY = 86_400_000;
// Local calendar date - toISOString() would shift local midnight into the previous UTC day
// (in IST the whole week grid would be labeled one day off).
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function mondayOf(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // back to Monday
  return x;
}
const WEEKDAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const dayNum = (s: string) => new Date(s + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" });

export default function Schedule({ me }: { me: Me }) {
  const { rows: shifts, state: shiftsState, reload: reloadShifts } = useCollection<Shift>("shifts");
  const { rows: employees, state: employeesState } = useCollection<Employee>("employees");
  const { rows: departments, state: departmentsState } = useCollection<Department>("departments");
  // Holidays are read so the roster can say when a day it is about to fill is a closure day.
  const { rows: holidays } = useCollection<Holiday>("holidays");
  const { toast } = useToast();
  const confirm = useConfirm();
  // The roster has its own error handling; these three feed the filters/pickers. Surface a lookup failure so
  // an empty dropdown reads as "couldn't load" rather than "nothing here".
  useEffect(() => {
    if (shiftsState === "error" || employeesState === "error" || departmentsState === "error")
      toast({ title: "Couldn't load some schedule options", description: "Filters may be incomplete. Try reloading.", variant: "destructive" });
  }, [shiftsState, employeesState, departmentsState, toast]);
  const canManage = usePermission("shift-assignments.write");
  const canManageShifts = usePermission("shifts.write");
  // The org's working days (settings → Attendance), so "repeat onto the week" can default to working days
  // instead of blindly rostering the weekend.
  const workDays = useClock().sched.work_days;

  const [dept, setDept] = useState("all");
  const [shiftFilter, setShiftFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => ymd(new Date(+weekStart + i * DAY))), [weekStart]);
  const [assignments, setAssignments] = useState<ShiftAssignment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<{ employee: string; date: string; existing?: ShiftAssignment } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await get<{ results: ShiftAssignment[] }>(`shift-assignments?from=${days[0]}&to=${days[6]}&max_page_size=500`);
      setAssignments(r.results ?? []);
    } catch (e) {
      toast({ title: "Couldn't load the roster", description: (e as Error).message, variant: "destructive" });
    } finally {
      setLoaded(true);
    }
  }, [days[0], days[6]]);
  useEffect(() => { void load(); }, [load]);

  const shiftById = useMemo(() => new Map(shifts.map((s) => [idOf(s.path), s])), [shifts]);
  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Employee" : "");
  }, [employees]);
  // (employeeId|date) -> assignment
  const byCell = useMemo(() => {
    const m = new Map<string, ShiftAssignment>();
    for (const a of assignments) if (a.employee && a.date) m.set(`${idOf(a.employee)}|${a.date}`, a);
    return m;
  }, [assignments]);

  // employeeId -> set of shiftIds assigned in the visible week (for the shift filter).
  const shiftsByEmp = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const a of assignments) {
      if (!a.employee || !a.shift) continue;
      const k = idOf(a.employee);
      (m.get(k) ?? m.set(k, new Set()).get(k)!).add(idOf(a.shift));
    }
    return m;
  }, [assignments]);

  // Rows: managers/HR see everyone (to assign); others see only people who already have an assignment (themselves).
  const rows = useMemo(() => {
    const assigned = new Set(assignments.map((a) => idOf(a.employee ?? "")));
    const base = canManage
      ? [...employees].sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`))
      : employees.filter((e) => assigned.has(idOf(e.path)));
    const q = search.trim().toLowerCase();
    return base.filter((e) => {
      if (dept !== "all" && !(e.department && idOf(e.department) === dept)) return false;
      if (shiftFilter !== "all" && !shiftsByEmp.get(idOf(e.path))?.has(shiftFilter)) return false;
      if (q && !`${e.first_name} ${e.last_name} ${e.employee_number ?? ""} ${e.job_title ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [employees, assignments, canManage, dept, shiftFilter, search, shiftsByEmp]);

  function openCell(employeePath: string, date: string) {
    if (!canManage) return;
    const existing = byCell.get(`${idOf(employeePath)}|${date}`);
    setEditing({ employee: `employees/${idOf(employeePath)}`, date, existing });
  }
  // One employee's assignment on a day of the visible week. The assign dialog needs it for every day it can
  // repeat onto, not only the cell that was clicked.
  const cellFor = (employeeRef: string, date: string) => byCell.get(`${idOf(employeeRef)}|${date}`);

  // date -> the fixed holiday falling on it. Optional holidays are elective, so they are not closures and
  // rostering across one is not a mistake worth flagging.
  const holidayByDay = useMemo(() => {
    const m = new Map<string, Holiday>();
    for (const h of holidays) if (h.date && !h.delete_time && h.kind !== "optional") m.set(h.date, h);
    return m;
  }, [holidays]);

  // Coverage per day - "how many people are on" is the first thing a scheduler checks.
  const countByDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of assignments) if (a.date) m.set(a.date, (m.get(a.date) ?? 0) + 1);
    return m;
  }, [assignments]);

  const weekLabel = `${dayNum(days[0])} - ${dayNum(days[6])}`;
  const filtersActive = dept !== "all" || shiftFilter !== "all" || search.trim() !== "";
  const today = ymd(new Date());

  return (
    // The route key ("schedule") is not a collection; the roster's data is shift-assignments. Rebind the
    // ambient scope so the header icon and any nested affordance manage the right resource.
    <AccessScope collection="shift-assignments">
    <div>
      <PageHeader accessCollection="shift-assignments" title="Schedule" description={canManage ? "Click any cell to assign or change a shift." : undefined} actions={<PageSettings me={me} host="schedule" />} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setWeekStart((w) => new Date(+w - 7 * DAY))} aria-label="Previous week"><ChevronLeft className="h-4 w-4" /></Button>
        {/* 12rem of reserved label plus two 32px steppers plus "This week" is 330px before the filter
            group on the right gets a pixel, so the bar wraps and the label's floor relaxes on a phone. */}
        <span className="min-w-[8rem] text-center text-sm font-medium tabular-nums sm:min-w-[12rem]">{weekLabel}</span>
        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setWeekStart((w) => new Date(+w + 7 * DAY))} aria-label="Next week"><ChevronRight className="h-4 w-4" /></Button>
        <Button variant="ghost" size="sm" onClick={() => setWeekStart(mondayOf(new Date()))}>This week</Button>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search people…" className="h-8 w-40" />
          {departments.length > 0 && (
            <Select value={dept} onValueChange={setDept}>
              <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All departments</SelectItem>
                {departments.filter((d) => !d.delete_time).map((d) => <SelectItem key={d.path} value={idOf(d.path)}>{d.display_name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          {shifts.length > 0 && (
            <Select value={shiftFilter} onValueChange={setShiftFilter}>
              <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All shifts</SelectItem>
                {shifts.map((s) => <SelectItem key={s.path} value={idOf(s.path)}>{s.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {!loaded ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          illustration={filtersActive ? "noResults" : "schedule"}
          title={filtersActive ? "No matches" : "Nothing scheduled"}
          description={filtersActive ? "No people match the current filters." : canManage ? "Assign shifts to build the roster. Define shifts in Settings → Time off." : "You have no shifts scheduled this week."}
        />
      ) : (
        <>
          {/* Legend: which colour is which shift, so the grid reads at a glance. */}
          {shifts.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {shifts.map((s) => (
                <span key={s.path} className="inline-flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color ?? "#64748b" }} />
                  <span className="font-medium text-foreground">{s.name}</span>
                  <span className="tabular-nums">{s.start}-{s.end}</span>
                </span>
              ))}
            </div>
          )}
          <div className="scroll-shadow-x overflow-x-auto rounded-lg border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  {/* The frozen name column is 240px of a 1440px screen and 240px of a 390px one - two thirds
                      of a phone, leaving barely a day and a half of roster visible beside it. Narrower on a
                      phone (a first name plus an initial still reads), full width from `sm` up. */}
                  <th className="sticky left-0 z-10 w-[7.5rem] bg-muted/40 px-2 py-2 text-left font-medium sm:w-[240px] sm:px-3">Employee</th>
                  {days.map((d, i) => (
                    <th key={d} className={cn("px-2 py-2 text-center font-medium", d === today && "text-primary")}>
                      <div>{WEEKDAY[i]}</div>
                      <div className="text-xs font-normal tabular-nums text-muted-foreground">{dayNum(d)}</div>
                      {canManage && <div className="text-[10px] font-normal tabular-nums text-muted-foreground">{countByDay.get(d) ?? 0} on</div>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.path} className="border-b last:border-0">
                    <td className="sticky left-0 z-10 max-w-[7.5rem] truncate border-r bg-card px-2 py-2 font-medium sm:max-w-[240px] sm:px-3">{e.first_name} {e.last_name}</td>
                    {days.map((d) => {
                      const a = byCell.get(`${idOf(e.path)}|${d}`);
                      const s = a?.shift ? shiftById.get(idOf(a.shift)) : undefined;
                      return (
                        <td key={d} className={cn("border-r p-1 last:border-0 align-top", d === today && "bg-primary/5")}>
                          <button
                            type="button"
                            disabled={!canManage}
                            onClick={() => openCell(e.path, d)}
                            title={a ? [s?.name, s && `${s.start}-${s.end}`, a.note].filter(Boolean).join(" · ") : undefined}
                            className={cn(
                              "group flex h-12 w-full flex-col items-center justify-center rounded-md px-1 text-xs transition-colors",
                              a ? "font-medium" : "text-muted-foreground",
                              canManage ? "cursor-pointer hover:ring-1 hover:ring-primary/40" : "cursor-default",
                              !a && canManage && "hover:bg-muted/50",
                            )}
                            style={a ? { backgroundColor: (s?.color ?? "#64748b") + "22", color: s?.color ?? undefined } : undefined}
                          >
                            {a ? (
                              <>
                                <span className="truncate">{s?.name ?? "Shift"}</span>
                                {s && <span className="tabular-nums opacity-80">{s.start}-{s.end}</span>}
                              </>
                            ) : canManage ? <span className="opacity-0 transition-opacity group-hover:opacity-100">+</span> : ""}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {editing && (
        <AssignDialog
          employeeName={empName(editing.employee)}
          date={editing.date}
          existing={editing.existing}
          shifts={shifts}
          weekDays={days}
          workDays={workDays}
          assignedOn={(d) => cellFor(editing.employee, d)}
          shiftById={shiftById}
          holidayOn={(d) => holidayByDay.get(d)}
          // The catalog can be empty when someone first opens the roster, which used to be a dead end pointing
          // at Settings. With shifts.write the dialog can add the pattern in place and carry on.
          onCreateShift={canManageShifts ? async (body) => { const s = await create<Shift>("shifts", body); reloadShifts(); return `shifts/${idOf(s.path)}`; } : undefined}
          onClose={() => setEditing(null)}
          // Failures propagate: the dialog stays open and pins the reason in the form, which is where the data
          // that caused it still is.
          onSave={async (shiftRef, note, dates) => {
            // One dialog can cover several days of the visible week ("same shift Mon-Fri"), so each target
            // day is patched when it already has an assignment and created when it doesn't.
            for (const d of dates) {
              const at = cellFor(editing.employee, d);
              if (at) await patch(`shift-assignments/${idOf(at.path)}`, { shift: shiftRef, note: note || null }, at.etag);
              else await create("shift-assignments", { employee: editing.employee, shift: shiftRef, date: d, note: note || undefined });
            }
            toast({ title: dates.length > 1 ? `${dates.length} days scheduled` : editing.existing ? "Shift updated" : "Shift assigned", variant: "success" });
            setEditing(null); load();
          }}
          onRemove={editing.existing ? async () => {
            const ok = await confirm({
              title: "Remove this shift?",
              description: "That person is left unscheduled for the day, and anyone reading the roster sees the gap.",
              confirmLabel: "Remove shift",
              destructive: true,
            });
            if (!ok) return;
            await remove(`shift-assignments/${idOf(editing.existing!.path)}`);
            toast({ title: "Assignment removed", variant: "success" });
            setEditing(null); load();
          } : undefined}
        />
      )}
    </div>
    </AccessScope>
  );
}

const dayFull = (s: string) => new Date(s + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return (h || 0) * 60 + (m || 0); };
// End at or before start means the shift runs past midnight - the way a night shift is expressed.
const spanOf = (s: Shift) => { const d = toMin(s.end) - toMin(s.start); return d > 0 ? d : d + 1440; };
const paidOf = (s: Shift) => Math.max(0, spanOf(s) - (s.break_minutes ?? 0));

// Roster cell editor. Picking a shift is a visual choice (colour, times, paid length), so the shifts are cards
// rather than dropdown lines - the colour in the picker is the colour that lands in the grid. One dialog can
// also cover several days of the visible week, because rostering a person day-by-day is the tedious part.
function AssignDialog({ employeeName, date, existing, shifts, weekDays, workDays, assignedOn, shiftById, holidayOn, onCreateShift, onClose, onSave, onRemove }: {
  employeeName: string;
  date: string;
  existing?: ShiftAssignment;
  shifts: Shift[];
  weekDays: string[];
  workDays: number[];
  assignedOn: (date: string) => ShiftAssignment | undefined;
  shiftById: Map<string, Shift>;
  holidayOn: (date: string) => Holiday | undefined;
  // Present only when the caller may write the shift catalog; creates the pattern and returns its resource path.
  onCreateShift?: (body: { name: string; start: string; end: string; break_minutes: number; color: string }) => Promise<string>;
  onClose: () => void;
  onSave: (shiftRef: string, note: string, dates: string[]) => Promise<void>;
  onRemove?: () => Promise<void>;
}) {
  const guardClose = useDiscardGuard();
  const [shift, setShift] = useState(existing?.shift ? `shifts/${idOf(existing.shift)}` : "");
  const [note, setNote] = useState(existing?.note ?? "");
  // Days this save covers. Starts as the clicked day alone, so the repeat is opt-in and nothing is written
  // to a day the scheduler did not ask for.
  const [dates, setDates] = useState<string[]>([date]);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newShift, setNewShift] = useState<{ name: string; start: string; end: string } | null>(null); // inline catalog add
  const [creating, setCreating] = useState(false);
  const busy = saving || removing || creating;
  const chosen = shift ? shiftById.get(idOf(shift)) : undefined;
  const toggleDay = (d: string) => setDates((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));
  const others = weekDays.filter((d) => d !== date);
  const workingOthers = others.filter((d) => workDays.includes(new Date(d + "T00:00:00").getDay()));
  const spread = dates.length > 1;
  const dirty = shift !== (existing?.shift ? `shifts/${idOf(existing.shift)}` : "") || note.trim() !== (existing?.note ?? "") || spread || !!newShift;
  // Days already carrying a different shift that this save would overwrite - worth naming before it happens. The
  // clicked day is excluded: replacing its shift is the thing the scheduler just asked to do.
  const overwrites = dates.filter((d) => {
    if (d === date) return false;
    const at = assignedOn(d);
    return !!at && !!at.shift && !!shift && idOf(at.shift) !== idOf(shift);
  });
  // Selected days nobody is meant to be working: a company holiday, or a day outside the org's working week.
  const offDays = dates.filter((d) => !!holidayOn(d) || !workDays.includes(new Date(d + "T00:00:00").getDay()));
  const close = () => guardClose(dirty, onClose)(false);
  const save = async () => {
    setSaving(true); setError(null);
    try { await onSave(shift, note.trim(), dates); }
    catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };
  const createShift = async () => {
    if (!onCreateShift || !newShift?.name.trim()) return;
    setCreating(true); setError(null);
    try {
      const ref = await onCreateShift({ name: newShift.name.trim(), start: newShift.start, end: newShift.end, break_minutes: 0, color: "#3b82f6" });
      setShift(ref); setNewShift(null);
    } catch (e) { setError((e as Error).message); }
    finally { setCreating(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) close(); }}>
      <DialogContent scrollBody onEnterSubmit={() => { if (!busy && shift) save(); }}>
        <DialogHeader>
          <DialogTitle>{existing ? "Edit shift" : "Assign shift"}</DialogTitle>
          <DialogDescription asChild>
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{employeeName}</span> · {dayFull(date)}
              {holidayOn(date) && <span className="text-amber-600 dark:text-amber-400"> · {holidayOn(date)!.display_name}</span>}
            </p>
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
        <Field label="Shift">
          {shifts.length === 0 && !newShift ? (
            <div className="space-y-2 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
              <p>No shifts defined yet. A shift is a named pattern (times, break, colour) the roster hands out.</p>
              {onCreateShift ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setNewShift({ name: "Day", start: "09:00", end: "18:00" })}>
                  <Plus className="h-3.5 w-3.5" /> Add a shift
                </Button>
              ) : (
                <p>Ask HR to add them in <span className="font-medium text-foreground">Settings → Time off → Shifts</span>.</p>
              )}
            </div>
          ) : (
            <div role="radiogroup" aria-label="Shift" className="grid gap-2 sm:grid-cols-2">
              {shifts.map((s) => {
                const ref = `shifts/${idOf(s.path)}`;
                const on = shift === ref;
                return (
                  <button key={s.path} type="button" role="radio" aria-checked={on} onClick={() => setShift(ref)}
                    className={cn(
                      "flex items-center gap-3 rounded-lg border p-2.5 text-left transition-colors",
                      on ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted/50",
                    )}>
                    <span className="h-8 w-2 shrink-0 rounded-full" style={{ backgroundColor: s.color ?? "#64748b" }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{s.name}</span>
                      <span className="block text-xs tabular-nums text-muted-foreground">
                        {s.start}-{s.end} · {fmtDuration(paidOf(s))}{s.break_minutes ? ` · ${s.break_minutes}m break` : ""}
                      </span>
                    </span>
                    {on && <Check className="h-4 w-4 shrink-0 text-primary" />}
                  </button>
                );
              })}
              {/* Add-in-place: the same catalog entry the Settings editor writes, minus the parts a roster
                  decision doesn't need (break and colour take their defaults and can be refined later). */}
              {onCreateShift && !newShift && (
                <button type="button" onClick={() => setNewShift({ name: "", start: "09:00", end: "18:00" })}
                  className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed p-2.5 text-sm text-muted-foreground transition-colors hover:border-primary hover:text-primary">
                  <Plus className="h-3.5 w-3.5" /> New shift
                </button>
              )}
            </div>
          )}
        </Field>
        {newShift && (
          <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Shift name" className="min-w-[10rem] flex-1">
                <Input autoFocus value={newShift.name} placeholder="e.g. Night" onChange={(e) => setNewShift({ ...newShift, name: e.target.value })} />
              </Field>
              <Field label="Start"><Input type="time" className="w-28" value={newShift.start} onChange={(e) => setNewShift({ ...newShift, start: e.target.value })} /></Field>
              <Field label="End"><Input type="time" className="w-28" value={newShift.end} onChange={(e) => setNewShift({ ...newShift, end: e.target.value })} /></Field>
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" loading={creating} disabled={!newShift.name.trim() || newShift.start === newShift.end} onClick={createShift}>Add shift</Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setNewShift(null)}>Cancel</Button>
              <span className="text-xs text-muted-foreground">Break and colour can be set later in Settings.</span>
            </div>
          </div>
        )}
        {shifts.length > 0 && others.length > 0 && (
          <Field label="Days" hint={spread ? `Files ${dates.length} assignments, one per selected day.` : "Pick more days to roster the same shift across the week."}>
            <div className="flex flex-wrap items-center gap-1.5">
              {weekDays.map((d, i) => {
                const on = dates.includes(d);
                const at = assignedOn(d);
                const atShift = at?.shift ? shiftById.get(idOf(at.shift)) : undefined;
                const hol = holidayOn(d);
                const off = !workDays.includes(new Date(d + "T00:00:00").getDay());
                return (
                  <button key={d} type="button" aria-pressed={on} onClick={() => toggleDay(d)}
                    title={[`${WEEKDAY[i]}`, atShift?.name, hol?.display_name ?? (off ? "Not a working day" : undefined)].filter(Boolean).join(" · ")}
                    className={cn(
                      "flex w-11 flex-col items-center gap-0.5 rounded-md border py-1.5 text-[11px] font-medium transition-colors",
                      on ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted/60",
                      // A closure day or a non-working day is legal to roster but rarely intended, so it reads
                      // differently before it's picked.
                      !on && (hol || off) && "border-dashed text-muted-foreground/60",
                    )}>
                    <span className={cn(hol && !on && "text-amber-600 dark:text-amber-400")}>{WEEKDAY[i]}</span>
                    {/* A dot means the day already has a shift, so a repeat that replaces something is visible. */}
                    <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: atShift ? (atShift.color ?? "#64748b") : "transparent" }} />
                  </button>
                );
              })}
              {workingOthers.length > 0 && (
                <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs"
                  onClick={() => setDates(dates.length > 1 ? [date] : [...new Set([date, ...workingOthers])])}>
                  {dates.length > 1 ? "Just this day" : "Working days"}
                </Button>
              )}
            </div>
          </Field>
        )}
        {overwrites.length > 0 && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
            {overwrites.length === 1 ? "1 selected day already has a different shift" : `${overwrites.length} selected days already have a different shift`} and will be changed to {chosen?.name ?? "this shift"}.
          </p>
        )}
        {/* Rostering a holiday or a non-working day is allowed (cover happens), but it is named first so it is a
            decision rather than an accident of the "Working days" shortcut. */}
        {offDays.length > 0 && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
            {offDays.map((d) => holidayOn(d)?.display_name ?? dayFull(d)).join(", ")} {offDays.length === 1 ? "is" : "are"} not a working day for the org - assign only if this is cover.
          </p>
        )}
        <Field label="Note (optional)" hint="Shown on the roster cell's tooltip - e.g. covering for someone."><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <FormError error={error} />
        </DialogBody>
        <DialogFooter className="items-center">
          {onRemove && (
            <Button variant="ghost" size="sm" className="mr-auto text-destructive" loading={removing} disabled={saving}
              onClick={async () => {
                setRemoving(true); setError(null);
                try { await onRemove(); }
                catch (e) { setError((e as Error).message); }
                finally { setRemoving(false); }
              }}>
              <Trash2 className="h-3.5 w-3.5" /> Remove
            </Button>
          )}
          <Button variant="outline" onClick={close} disabled={busy}>Cancel</Button>
          <Button onClick={save} loading={saving} disabled={!shift || removing || dates.length === 0}>
            {spread ? `Assign ${dates.length} days` : existing ? "Save" : "Assign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, Check, ChevronLeft, ChevronRight, Plus, Trash2 } from "lucide-react";
import { getAllPages, create, patch, remove } from "@/api";
import { useCollection, useCollectionHasMore } from "@/hooks/useCollection";
import { runSequential, batchSummary } from "@/lib/batchRun";
import { useClock } from "@/lib/clock";
import { usePermission } from "@/lib/perm";
import { cn, formatHHMM, idOf } from "@/lib/utils";
import { todayStr, addDaysYmd, weekStartYmd, weekdayOf } from "@/lib/orgDay";
import { scheduleView } from "@/lib/workSchedule";
import type { Department, Employee, Holiday, Me, Shift, ShiftAssignment, WorkPattern, WorkPatternAssignment } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings } from "@/components/common/SettingsButton";
import { AccessScope } from "@/components/access/AccessScope";
import { EmptyState } from "@/components/common/EmptyState";
import { TruncationNotice } from "@/components/common/TruncationNotice";
import { Field, FieldRow } from "@/components/common/Field";
import { Checkbox } from "@/components/ui/checkbox";
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

// The roster's week is a run of seven DAY STRINGS, and every control that moves it steps those strings
// (lib/orgDay). It used to hold a local `Date` for the week start and format it with a local `ymd`, which is
// two problems in one: the week the page opened on was the BROWSER's week rather than the org's - so a
// manager abroad rostered against a different Monday to everyone else - and `+weekStart + i * DAY` is only a
// calendar day until a DST boundary falls inside the week, after which the grid repeats or skips a date.
const WEEKDAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// How far the roster will follow the cursor for one window. Seven days of a four-figure headcount is past what
// a grid is readable at anyway, and the notice says so rather than the page quietly showing part of a week.
const ROSTER_ROW_CAP = 2000;

// HOW MANY DAYS THE GRID DRAWS AT ONCE. A week is the rota view; four weeks is the one a rotation is visible
// in, which is the whole reason patterns exist. Past that a cell is too narrow to name a shift in, so the
// longest span is 28 days rather than a calendar month - every month then draws at one width, and the
// horizontal scroll is the same distance whichever month it is.
const SPANS = [
  { days: 7, label: "Week" },
  { days: 14, label: "2 weeks" },
  { days: 28, label: "4 weeks" },
] as const;
const dayNum = (s: string) => new Date(s + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" });
/** The seven days of the week `ymd` falls in, Monday first - the window the cell dialog can repeat across. */
const weekOf = (ymd: string) => Array.from({ length: 7 }, (_, i) => addDaysYmd(weekStartYmd(ymd), i));
// "Not working that day" as a choice in the shift picker. A sentinel rather than a second control because it
// IS the same choice - what this person is doing on this day - and splitting it into a toggle beside the
// picker makes "off" and "on the day shift" look like two unrelated decisions.
const OFF = "off";

export default function Schedule({ me }: { me: Me }) {
  // Complete for the same reason as employees below: `shiftById` labels every roster cell, and a shift past
  // the first page renders as the literal word "Shift" on every day it is rostered on.
  const { rows: shifts, state: shiftsState, reload: reloadShifts } = useCollection<Shift>("shifts", { all: true });
  // COMPLETE, not the first page: the grid is one row per person and `canManage` sees everyone, so a windowed
  // read means the hundred-and-first employee has no row at all and cannot be rostered from this page.
  const { rows: employees, state: employeesState } = useCollection<Employee>("employees", { all: true });
  const { rows: departments, state: departmentsState } = useCollection<Department>("departments", { all: true });
  // Holidays are read so the roster can say when a day it is about to fill is a closure day.
  const { rows: holidays } = useCollection<Holiday>("holidays", { all: true });
  const { toast } = useToast();
  const confirm = useConfirm();
  // The roster has its own error handling; these three feed the filters/pickers. Surface a lookup failure so
  // an empty dropdown reads as "couldn't load" rather than "nothing here".
  useEffect(() => {
    if (shiftsState === "error" || employeesState === "error" || departmentsState === "error")
      toast({ title: "Couldn't load some schedule options", description: "Filters may be incomplete. Try reloading.", variant: "destructive" });
  }, [shiftsState, employeesState, departmentsState, toast]);
  // `all: true` walks the employee cursor to its ceiling; if even that was not the whole directory, the grid is
  // still missing rows and says so below.
  const employeesTruncated = useCollectionHasMore(["employees"]);
  const canManage = usePermission("shift-assignments.write");
  const canManageShifts = usePermission("shifts.write");
  const canAssignPattern = usePermission("work-pattern-assignments.write");
  // The org's own schedule (settings → Attendance): the bottom layer of a resolved day, and what "repeat onto
  // the week" defaults to so the shortcut does not blindly roster the weekend.
  const orgSched = useClock().sched;
  const workDays = orgSched.work_days;
  // The schedule catalog and who is on what: the two layers above the roster entries themselves. Complete for
  // the same reason `shifts` is - a pattern past the first page would leave its people's cells looking empty.
  const { rows: patterns, reload: reloadPatterns } = useCollection<WorkPattern>("work-patterns", { all: true });

  const [dept, setDept] = useState("all");
  const [shiftFilter, setShiftFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [spanDays, setSpanDays] = useState<number>(7);
  const [weekStart, setWeekStart] = useState(() => weekStartYmd(todayStr()));
  const days = useMemo(() => Array.from({ length: spanDays }, (_, i) => addDaysYmd(weekStart, i)), [weekStart, spanDays]);
  const [assignments, setAssignments] = useState<ShiftAssignment[]>([]);
  const [patternAssignments, setPatternAssignments] = useState<WorkPatternAssignment[]>([]);
  const [rosterTruncated, setRosterTruncated] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<{ employee: string; date: string; existing?: ShiftAssignment } | null>(null);
  const [assigning, setAssigning] = useState(false);

  // The window's edges as named values, because `days[0]` inside a dependency array is an expression the
  // linter cannot check - it has to take on trust that it means what the body reads. Named here, the fetch
  // and its dependencies are the same two strings by construction.
  const [from, to] = [days[0]!, days[days.length - 1]!];
  // THE WEEK THIS LOAD IS FOR, so a response that lands after the reader has moved on is dropped.
  //
  // `getAllPages` follows the cursor, so this is several sequential round-trips, not one - a much wider window
  // than a single fetch. Page the week twice quickly and the slower FIRST request resolves last and overwrites
  // the newer rows, painting one week's roster under the other week's column headers. The cells are keyed by
  // (employee, date), so what the scheduler actually sees is EMPTY cells for shifts that exist - which is the
  // failure the cursor-following note below was written to remove ("a roster that is short is a roster that is
  // WRONG"), reached by a different route. They then roster over it and the day's unique index refuses the
  // save with "already rostered", which is safe and inexplicable.
  //
  // A generation counter rather than the `let live` cleanup flag its sibling uses (web/src/pages/Documents.tsx),
  // because `load` is also called directly after a write, where there is no effect cleanup to hang it on.
  const reqSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    try {
      // THE CURSOR IS FOLLOWED, because a roster that is short is a roster that is WRONG. This asked for
      // `max_page_size=500`; the server caps a page at 100 and says so only through `next_page_token`, which
      // nothing here read - so on any org whose week has more than a hundred entries (headcount times working
      // days reaches that at twenty people) the grid rendered EMPTY CELLS for shifts that exist. A scheduler
      // then rosters over them, and the person is assigned twice.
      // The roster entries AND who is on a schedule over the same window: the grid draws a cell from whichever
      // of them reaches the day, so loading one without the other would paint a pattern's days as empty.
      const [r, p] = await Promise.all([
        getAllPages<ShiftAssignment>(`shift-assignments?from=${from}&to=${to}`, ROSTER_ROW_CAP),
        getAllPages<WorkPatternAssignment>(`work-pattern-assignments?from=${from}&to=${to}`, ROSTER_ROW_CAP),
      ]);
      if (seq !== reqSeq.current) return; // a newer week is already loading (or loaded) - this answer is stale
      setAssignments(r.results);
      setPatternAssignments(p.results);
      setRosterTruncated(r.truncated || p.truncated);
    } catch (e) {
      if (seq !== reqSeq.current) return;
      toast({ title: "Couldn't load the roster", description: (e as Error).message, variant: "destructive" });
    } finally {
      // The spinner belongs to the LATEST request, so a superseded one must not clear it.
      if (seq === reqSeq.current) setLoaded(true);
    }
  }, [from, to, toast]);
  useEffect(() => { void load(); }, [load]);

  // WHAT EACH CELL ACTUALLY IS, over the three layers the server resolves (lib/workSchedule.ts): the roster
  // entry, the pattern the person is on, then the org's own week. Built here rather than read per cell so the
  // grid and the payroll build are answering out of one rule.
  const view = useMemo(
    () => scheduleView({ sched: orgSched, shifts, patterns, assignments, patternAssignments }),
    [orgSched, shifts, patterns, assignments, patternAssignments],
  );

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

  const weekLabel = `${dayNum(from)} - ${dayNum(to)}`;
  const filtersActive = dept !== "all" || shiftFilter !== "all" || search.trim() !== "";
  const today = todayStr();

  return (
    // The route key ("schedule") is not a collection; the roster's data is shift-assignments. Rebind the
    // ambient scope so the header icon and any nested affordance manage the right resource.
    <AccessScope collection="shift-assignments">
    <div>
      <PageHeader accessCollection="shift-assignments" title="Schedule" description={canManage ? "Click any cell to assign or change a shift." : undefined} actions={<PageSettings me={me} host="schedule" />} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {/* The steppers move by the SPAN, not by a week: on a four-week view, paging one week at a time makes
            the reader walk the same three weeks four times to reach the next unseen one. */}
        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setWeekStart((w) => addDaysYmd(w, -spanDays))} aria-label="Previous period"><ChevronLeft className="h-4 w-4" /></Button>
        {/* 12rem of reserved label plus two 32px steppers plus "This week" is 330px before the filter
            group on the right gets a pixel, so the bar wraps and the label's floor relaxes on a phone. */}
        <span className="min-w-[8rem] text-center text-sm font-medium tabular-nums sm:min-w-[12rem]">{weekLabel}</span>
        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setWeekStart((w) => addDaysYmd(w, spanDays))} aria-label="Next period"><ChevronRight className="h-4 w-4" /></Button>
        <Button variant="ghost" size="sm" onClick={() => setWeekStart(weekStartYmd(todayStr()))}>Today</Button>
        {/* How far the grid looks. A rotation is only visible over the weeks it turns in, so the span is the
            control that makes a multi-week pattern readable at all. */}
        <Select value={String(spanDays)} onValueChange={(v) => setSpanDays(Number(v))}>
          <SelectTrigger className="h-8 w-28" aria-label="How many days to show"><SelectValue /></SelectTrigger>
          <SelectContent>
            {SPANS.map((s) => <SelectItem key={s.days} value={String(s.days)}>{s.label}</SelectItem>)}
          </SelectContent>
        </Select>

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
          {/* PUTTING PEOPLE ON A SCHEDULE is the way a month (or a year) gets rostered: one row per person
              saying which pattern they follow and from when, rather than a roster entry per person per day. */}
          {canAssignPattern && (
            <Button variant="outline" size="sm" className="h-8" onClick={() => setAssigning(true)}>
              <CalendarClock className="h-3.5 w-3.5" /> Assign a schedule
            </Button>
          )}
        </div>
      </div>

      {/* The two ways this grid can still be a window: more roster entries in the week than the cursor was
          followed for, or more people than the employee walk loaded. Either one means a blank cell is not
          evidence that nobody is on - which is the one thing a scheduler reads this grid for. The shift and
          holiday catalogues are separately admitted below: those are lookups, so a short read there mislabels
          a cell rather than emptying one. */}
      <TruncationNotice collection={["shifts", "holidays"]} what="shifts and holidays" className="mb-3" />
      {(rosterTruncated || employeesTruncated) && (
        <p className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-muted-foreground">
          This week has more entries than the roster loads at once. An empty cell may not mean nobody is rostered - narrow by department or shift to be sure.
        </p>
      )}

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
                  <span className="tabular-nums">{formatHHMM(s.start)} - {formatHHMM(s.end)}</span>
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
                      {/* The window always starts on a Monday (`weekStartYmd`), so the weekday of column `i`
                          is its position within the week however many weeks the span runs. */}
                      <div>{WEEKDAY[i % 7]}</div>
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
                      // WHAT THE DAY ACTUALLY IS. The ROSTER ENTRY is what this grid has always drawn and
                      // still decides the cell where there is one; `day` is what the person's schedule makes
                      // of the days nobody rostered. Before schedules an empty cell meant "nobody is on";
                      // with a pattern behind it, it means "whatever the pattern says", and a grid that keeps
                      // drawing it blank tells the scheduler the opposite of the truth.
                      //
                      // `view` answers the org's own week while `schedule_source` is "org" (lib/workSchedule),
                      // so on an org that has not switched schedules on, this is exactly the old grid.
                      const day = view.of(idOf(e.path))(d);
                      const patternShift = !a && day.shiftId ? shiftById.get(day.shiftId) : undefined;
                      const fromPattern = !!patternShift;
                      // A cell drawn from a pattern is a lighter claim than a rostered one, so the two are
                      // never confused: solid is somebody's decision, a tint is what their schedule implies.
                      const shown = s ?? patternShift;
                      const restDay = a ? a.kind === "off" : day.off;
                      const colour = shown?.color ?? (shown ? "#64748b" : undefined);
                      // A day with no shift on it reads "no shift" whether that is because nobody rostered one
                      // or because the person's schedule has none - the layers decide what a day IS, not how
                      // it is described.
                      const label = a?.kind === "off" ? "Off" : shown?.name ?? (restDay ? "not working" : "no shift");
                      return (
                        <td key={d} className={cn("border-r p-1 last:border-0 align-top", d === today && "bg-primary/5")}>
                          <button
                            type="button"
                            disabled={!canManage}
                            onClick={() => openCell(e.path, d)}
                            title={[
                              a?.kind === "off" ? "Off (set on the roster)" : shown?.name,
                              shown && !restDay ? `${shown.start}-${shown.end}` : undefined,
                              fromPattern ? `From ${view.patternOn(idOf(e.path), d)?.name ?? "their schedule"}` : undefined,
                              a?.note,
                            ].filter(Boolean).join(" · ") || undefined}
                            // Who and when, said out loud: an empty cell draws nothing, so without this the
                            // roster is a grid of buttons called "button" - unusable by anything that reads
                            // the page rather than looks at it. Same shape as the timesheet grid's cells.
                            aria-label={`${e.first_name} ${e.last_name}, ${d}, ${label}${fromPattern ? " from their schedule" : ""}`}
                            className={cn(
                              "group flex h-12 w-full flex-col items-center justify-center rounded-md px-1 text-xs transition-colors",
                              a && a.kind !== "off" ? "font-medium" : "text-muted-foreground",
                              // A pattern day is a lighter claim than a rostered one: it is what the schedule
                              // implies, not what somebody put there.
                              fromPattern && "border border-dashed border-current/30",
                              canManage ? "cursor-pointer hover:ring-1 hover:ring-primary/40" : "cursor-default",
                              !a && canManage && "hover:bg-muted/50",
                            )}
                            style={colour && !restDay ? { backgroundColor: colour + (fromPattern ? "14" : "22"), color: colour } : undefined}
                          >
                            {restDay ? (
                              // A rest day SET on the roster is a decision and says so; an ordinary weekend is
                              // just the absence of one, and a dash on every Saturday is noise.
                              a?.kind === "off" ? <span className="opacity-70">Off</span> : canManage ? <span className="opacity-0 transition-opacity group-hover:opacity-100">+</span> : ""
                            ) : shown ? (
                              <>
                                <span className="truncate">{label}</span>
                                <span className="tabular-nums opacity-80">{shown.start}-{shown.end}</span>
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
          // The repeat control offers the WEEK the clicked day is in, not the whole span: twenty-eight day
          // chips is a second grid inside a dialog, and rostering a month one shift at a time is what
          // assigning a schedule is for.
          weekDays={weekOf(editing.date)}
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
            //
            // WALKED, NOT A BARE LOOP, and the grid is reloaded whatever happens. Thrown out of the middle,
            // the days before the failure were written and the days after were not, `load()` sat on the
            // success path so `cellFor` still reported Monday empty - and the retry the open dialog invites
            // then called `create` for a day that now has a row, which `shift_assignments`' partial unique
            // index on (employee, date) refuses. So Save failed on MONDAY, a day the scheduler believed they
            // had just failed to book, telling them to change an entry the un-reloaded grid does not show.
            const res = await runSequential(
              dates,
              (d) => d,
              async (d) => {
                const at = cellFor(editing.employee, d);
                // A REST DAY names no shift, so the two fields travel together and the service refuses a
                // "shift" entry without one. `shiftRef` is the sentinel OFF on that path.
                const off = shiftRef === OFF;
                // An emptied note is `""`, never `null`: a body carries VALUES, and every service reads the
                // empty string as "clear it". `null` fails contract validation at the Prism proxy the dev
                // server goes through - a 422 the worker never sees, so spreading a shift across the week did
                // nothing at all there. See the "No nulls on the wire" note in web/src/api.ts.
                const body = off ? { kind: "off" as const, note: note || "" } : { kind: "shift" as const, shift: shiftRef, note: note || "" };
                if (at) await patch(`shift-assignments/${idOf(at.path)}`, body, at.etag);
                else await create("shift-assignments", { employee: editing.employee, date: d, ...body, note: note || undefined });
              },
            );
            await load(); // whatever happened, the grid must show it - a retry then patches what exists
            if (res.failures.length) {
              // Thrown: the dialog stays open with the reason pinned, now naming the days it could not do.
              throw new Error(`${batchSummary(res, "day")} Not done: ${res.failures.map((f) => `${f.label} (${f.message})`).join("; ")}`);
            }
            toast({ title: dates.length > 1 ? `${dates.length} days scheduled` : editing.existing ? "Shift updated" : "Shift assigned", variant: "success" });
            setEditing(null);
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
            setEditing(null); void load();
          } : undefined}
        />
      )}

      {assigning && (
        <AssignScheduleDialog
          people={rows}
          patterns={patterns}
          defaultFrom={from}
          shiftById={shiftById}
          onCreatePattern={canManageShifts ? async (body) => { const p = await create<WorkPattern>("work-patterns", body); reloadPatterns(); return `work-patterns/${idOf(p.path)}`; } : undefined}
          onClose={() => setAssigning(false)}
          onSave={async (patternRef, employees, startDate, endDate) => {
            // One row per person, not one per person per day: that is the whole reason a pattern exists, and
            // it is what makes "roster the team for the quarter" a single action.
            //
            // WALKED, and the grid is reloaded whatever happens - the same shape (and the same reason) as the
            // cell dialog's save: thrown out of the middle, the people before the failure are on the schedule
            // and the people after are not, and the retry the open dialog invites would then create a second
            // assignment for the ones who already have one.
            const res = await runSequential(
              employees,
              (emp) => empName(emp),
              async (emp) => {
                await create("work-pattern-assignments", {
                  employee: emp,
                  pattern: patternRef,
                  start_date: startDate,
                  ...(endDate ? { end_date: endDate } : {}),
                });
              },
            );
            await load();
            if (res.failures.length) {
              throw new Error(`${batchSummary(res, "person")} Not done: ${res.failures.map((f) => `${f.label} (${f.message})`).join("; ")}`);
            }
            toast({ title: employees.length > 1 ? `${employees.length} people scheduled` : "Schedule assigned", variant: "success" });
            setAssigning(false);
          }}
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
  const [shift, setShift] = useState(existing?.kind === "off" ? OFF : existing?.shift ? `shifts/${idOf(existing.shift)}` : "");
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
  const workingOthers = others.filter((d) => workDays.includes(weekdayOf(d)));
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
  const offDays = dates.filter((d) => !!holidayOn(d) || !workDays.includes(weekdayOf(d)));
  const close = () => guardClose(dirty, onClose)(false);
  const save = async () => {
    // The button's whole condition, checked here rather than restated on the Enter path. `dates.length === 0`
    // is reachable (toggleDay can deselect the anchor day), and on the Enter path it was missing: `onSave`
    // then ran `runSequential` over an empty list, wrote nothing, closed the dialog and toasted "Shift
    // assigned" - a scheduler told a shift was rostered when no assignment was created.
    if (saving || removing || !shift || dates.length === 0) return;
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
      <DialogContent scrollBody onEnterSubmit={() => void save()}>
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
                        {formatHHMM(s.start)} - {formatHHMM(s.end)} · {fmtDuration(paidOf(s))}{s.break_minutes ? ` · ${s.break_minutes}m break` : ""}
                      </span>
                    </span>
                    {on && <Check className="h-4 w-4 shrink-0 text-primary" />}
                  </button>
                );
              })}
              {/* NOT WORKING, said explicitly. It is the one answer the picker could not give before, and it
                  is the common roster edit: a day off inside a pattern that would otherwise put them on. */}
              <button type="button" role="radio" aria-checked={shift === OFF} onClick={() => setShift(OFF)}
                className={cn(
                  "flex items-center gap-3 rounded-lg border p-2.5 text-left transition-colors",
                  shift === OFF ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted/50",
                )}>
                <span className="h-8 w-2 shrink-0 rounded-full bg-muted-foreground/30" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">Off</span>
                  <span className="block text-xs text-muted-foreground">Not working - nothing is owed that day</span>
                </span>
                {shift === OFF && <Check className="h-4 w-4 shrink-0 text-primary" />}
              </button>
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
                const off = !workDays.includes(weekdayOf(d));
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

// Put people on a schedule over a date range. This is the multi-week half of the roster: a pattern says which
// days somebody works and on which shift, so "the team is on the two-week rotation from Monday" is one row
// per person rather than a roster entry per person per day.
//
// Kept beside the cell dialog rather than on a page of its own because it is the same decision at a different
// grain - what this person is doing, for a day or for a quarter - and the roster is where both are seen.
function AssignScheduleDialog({ people, patterns, defaultFrom, shiftById, onCreatePattern, onClose, onSave }: {
  people: Employee[];
  patterns: WorkPattern[];
  defaultFrom: string;
  shiftById: Map<string, Shift>;
  /** Present only when the caller may write the catalog; creates the pattern and returns its resource path. */
  onCreatePattern?: (body: { name: string; cycle_weeks: number; days: (string | null)[] }) => Promise<string>;
  onClose: () => void;
  onSave: (patternRef: string, employees: string[], startDate: string, endDate: string | null) => Promise<void>;
}) {
  const guardClose = useDiscardGuard();
  const [pattern, setPattern] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [startDate, setStartDate] = useState(defaultFrom);
  // OPEN ENDED BY DEFAULT, because that is what a schedule normally is: somebody is on it until they are moved
  // off. An end date is the exception (a fixed-term rota, summer hours), so it is opt-in rather than a field
  // that has to be cleared.
  const [ends, setEnds] = useState(false);
  const [endDate, setEndDate] = useState("");
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const chosen = pattern ? patterns.find((p) => `work-patterns/${idOf(p.path)}` === pattern) : undefined;
  const dirty = !!pattern || picked.length > 0 || startDate !== defaultFrom || ends;
  const q = search.trim().toLowerCase();
  const listed = q
    ? people.filter((e) => `${e.first_name} ${e.last_name} ${e.employee_number ?? ""}`.toLowerCase().includes(q))
    : people;
  const toggle = (path: string) => setPicked((prev) => (prev.includes(path) ? prev.filter((x) => x !== path) : [...prev, path]));
  const badEnd = ends && (!endDate || endDate < startDate);

  const save = async () => {
    if (saving || !pattern || !picked.length || !startDate || badEnd) return;
    setSaving(true); setError(null);
    try { await onSave(pattern, picked, startDate, ends ? endDate : null); }
    catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };
  // A one-week pattern from the org's ordinary week, so an org with no catalog yet is not sent to Settings to
  // build one before it can use the feature at all. The days are filled in the editor afterwards.
  const createPattern = async () => {
    if (!onCreatePattern || !newName?.trim()) return;
    setCreating(true); setError(null);
    try {
      const ref = await onCreatePattern({ name: newName.trim(), cycle_weeks: 1, days: Array(7).fill(null) });
      setPattern(ref); setNewName(null);
    } catch (e) { setError((e as Error).message); }
    finally { setCreating(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !saving) guardClose(dirty, onClose)(false); }}>
      <DialogContent scrollBody onEnterSubmit={() => void save()}>
        <DialogHeader>
          <DialogTitle>Assign a schedule</DialogTitle>
          <DialogDescription>
            A schedule decides which days these people work and on which shift, from the date you pick onwards.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field label="Schedule">
            {patterns.length === 0 && !newName ? (
              <div className="space-y-2 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                <p>No schedules defined yet. A schedule is a repeating week (or rotation) of shifts and rest days.</p>
                {onCreatePattern ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => setNewName("")}>
                    <Plus className="h-3.5 w-3.5" /> Add a schedule
                  </Button>
                ) : (
                  <p>Ask HR to add them in <span className="font-medium text-foreground">Settings → Time off → Schedules</span>.</p>
                )}
              </div>
            ) : (
              <div role="radiogroup" aria-label="Schedule" className="grid gap-2">
                {patterns.map((p) => {
                  const ref = `work-patterns/${idOf(p.path)}`;
                  const on = pattern === ref;
                  const worked = (p.days ?? []).filter(Boolean).length;
                  return (
                    <button key={p.path} type="button" role="radio" aria-checked={on} onClick={() => setPattern(ref)}
                      className={cn(
                        "flex items-center gap-3 rounded-lg border p-2.5 text-left transition-colors",
                        on ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted/50",
                      )}>
                      <span className="h-8 w-2 shrink-0 rounded-full" style={{ backgroundColor: p.color ?? "#64748b" }} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{p.name}</span>
                        <span className="block text-xs text-muted-foreground">
                          {(p.cycle_weeks ?? 1) > 1 ? `${p.cycle_weeks}-week rotation · ` : ""}
                          {worked} working {worked === 1 ? "day" : "days"} per {(p.cycle_weeks ?? 1) > 1 ? "cycle" : "week"}
                        </span>
                      </span>
                      {on && <Check className="h-4 w-4 shrink-0 text-primary" />}
                    </button>
                  );
                })}
              </div>
            )}
          </Field>
          {newName !== null && (
            <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-muted/20 p-3">
              <Field label="Schedule name" className="min-w-[10rem] flex-1">
                <Input autoFocus value={newName} placeholder="e.g. Part-time mornings" onChange={(e) => setNewName(e.target.value)} />
              </Field>
              <Button type="button" size="sm" loading={creating} disabled={!newName.trim()} onClick={createPattern}>Add</Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setNewName(null)}>Cancel</Button>
              <p className="w-full text-xs text-muted-foreground">Which shift falls on which day is set in Settings → Time off → Schedules.</p>
            </div>
          )}
          {/* What the chosen pattern actually does, spelled out as the week it is: picking a schedule by name
              and finding out next month which days it meant is the mistake this line exists to prevent. */}
          {chosen && (chosen.days ?? []).length === (chosen.cycle_weeks ?? 1) * 7 && (
            <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {Array.from({ length: chosen.cycle_weeks ?? 1 }, (_, w) => (
                <div key={w} className="flex flex-wrap items-center gap-1.5 py-0.5">
                  {(chosen.cycle_weeks ?? 1) > 1 && <span className="w-14 shrink-0 font-medium text-foreground">Week {w + 1}</span>}
                  {WEEKDAY.map((label, i) => {
                    // The cycle is stored weekday 0=Sun..6=Sat; these chips read Monday-first like the grid.
                    const id = (chosen.days ?? [])[w * 7 + ((i + 1) % 7)];
                    const s = id ? shiftById.get(idOf(id)) : undefined;
                    return (
                      <span key={label} className={cn("rounded px-1.5 py-0.5", s ? "font-medium" : "opacity-50")}
                        style={s ? { backgroundColor: (s.color ?? "#64748b") + "22", color: s.color ?? undefined } : undefined}>
                        {label}{s ? ` ${formatHHMM(s.start)}` : " off"}
                      </span>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
          <FieldRow>
            <Field label="From"><Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field>
            <Field label="Until" hint={ends ? undefined : "Stays on it until they're moved off."}>
              <div className="flex items-center gap-2">
                <Checkbox checked={ends} onCheckedChange={(v) => setEnds(v === true)} aria-label="Set an end date" />
                <Input type="date" className="flex-1" disabled={!ends} value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />
              </div>
            </Field>
          </FieldRow>
          <Field label={`People${picked.length ? ` (${picked.length} selected)` : ""}`}>
            <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search people…" className="mb-2 h-8" />
            <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-lg border p-1">
              {listed.length === 0 ? (
                <p className="px-2 py-3 text-sm text-muted-foreground">No people match that search.</p>
              ) : listed.map((e) => (
                <label key={e.path} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/50">
                  {/* Named, because a row swallows the name of the control inside it: without this every
                      person in the list is a checkbox called "checkbox", and the end-date toggle above is
                      indistinguishable from them to anything reading the page rather than looking at it. */}
                  <Checkbox aria-label={`${e.first_name} ${e.last_name}`}
                    checked={picked.includes(`employees/${idOf(e.path)}`)} onCheckedChange={() => toggle(`employees/${idOf(e.path)}`)} />
                  <span className="truncate">{e.first_name} {e.last_name}</span>
                  {e.employee_number && <span className="sentry-mask ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{e.employee_number}</span>}
                </label>
              ))}
            </div>
            {/* Everyone the current filters show, which is how a department goes onto a rota in one go. */}
            {listed.length > 0 && (
              <Button type="button" variant="ghost" size="sm" className="mt-1 h-7 px-2 text-xs"
                onClick={() => setPicked(picked.length === listed.length ? [] : listed.map((e) => `employees/${idOf(e.path)}`))}>
                {picked.length === listed.length ? "Clear" : `Select all ${listed.length}`}
              </Button>
            )}
          </Field>
          {/* Moving somebody onto a new schedule CLOSES the open-ended one they are on, the day before this
              starts. Said here because it changes a row the scheduler did not name. */}
          {picked.length > 0 && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
              Anyone already on an open-ended schedule comes off it the day before {startDate || "this starts"}.
            </p>
          )}
          <FormError error={error} />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => guardClose(dirty, onClose)(false)} disabled={saving}>Cancel</Button>
          <Button onClick={save} loading={saving} disabled={!pattern || !picked.length || !startDate || badEnd}>
            {picked.length > 1 ? `Assign to ${picked.length} people` : "Assign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

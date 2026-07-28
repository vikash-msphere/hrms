import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, CalendarRange, Plane, CalendarDays, Plus, Users } from "lucide-react";
import { get } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { usePermission } from "@/lib/perm";
import { idOf, cn } from "@/lib/utils";
import { leaveColor } from "@/lib/leaveColors";
import { DEFAULT_SCHEDULE, type AttendanceSchedule } from "@/lib/attendance";
import type { Me, Employee, Department, LeaveRequest, LeaveType, Holiday, Event } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings } from "@/components/common/SettingsButton";
import { TruncationNotice } from "@/components/common/TruncationNotice";
import { AccessTarget } from "@/components/access/AccessTarget";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { RequestLeaveDialog } from "@/components/common/RequestLeaveDialog";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const DAY_MS = 86400000;
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ONE_LEAVE_COLOR = "#14b8a6"; // single neutral colour for viewers without the leave-type breakdown
const upper = (s?: string) => (s ?? "").toUpperCase();
const ymdUtc = (d: Date) => d.toISOString().slice(0, 10);
const parseYmd = (s: string) => Date.parse(s.slice(0, 10) + "T00:00:00Z");
// The viewer's LOCAL calendar date (toISOString would flip to UTC's date around midnight).
const todayYmd = () => new Date().toLocaleDateString("en-CA");
// First UTC midnight of the month containing `d`.
const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const dmy = (s?: string) => { if (!s) return ""; const [y, m, dd] = s.slice(0, 10).split("-"); return `${dd}/${m}/${y}`; };

export default function LeaveCalendar({ me }: { me: Me }) {
  const { rows: employees } = useCollection<Employee>("employees");
  const { rows: departments } = useCollection<Department>("departments");
  const { rows: leaves } = useCollection<LeaveRequest>("leave-requests", { max: 500 });
  const { rows: leaveTypes } = useCollection<LeaveType>("leave-types");
  const { rows: holidays } = useCollection<Holiday>("holidays");
  const { rows: events } = useCollection<Event>("events");

  // Org work schedule (which weekdays are non-working) for weekend shading; falls back to Mon–Fri.
  const [schedule, setSchedule] = useState<AttendanceSchedule>(DEFAULT_SCHEDULE);
  useEffect(() => {
    get<{ value?: Partial<AttendanceSchedule> }>("settings/attendance")
      .then((s) => { if (s.value) setSchedule({ ...DEFAULT_SCHEDULE, ...s.value }); })
      .catch(() => {});
  }, []);
  const workDays = schedule.work_days?.length ? schedule.work_days : [1, 2, 3, 4, 5];

  const [cursor, setCursor] = useState(() => monthStart(new Date()));
  const [dept, setDept] = useState("all");
  const [showPending, setShowPending] = useState(false);
  // Today starts selected so the page opens answering "who's out right now" in the detail panel below.
  const [selected, setSelected] = useState<string | null>(() => todayYmd());
  const [draft, setDraft] = useState<{ from: string; to: string } | null>(null);

  // Per-type leave colours are an HR/admin affordance (mirrors the dashboard timeline): only callers who
  // manage leave types see the per-type breakdown; everyone else sees one neutral colour.
  const distinctColors = usePermission("leave-types.write");
  const typeById = useMemo(() => new Map(leaveTypes.map((t) => [idOf(t.path), t] as const)), [leaveTypes]);
  const colorOf = (ref?: string) => (!distinctColors ? ONE_LEAVE_COLOR : leaveColor(typeById.get(ref ? idOf(ref) : "")?.color, ref ? idOf(ref) : ""));
  const typeName = (ref?: string) => typeById.get(ref ? idOf(ref) : "")?.display_name ?? "Leave";

  const empById = useMemo(() => new Map(employees.map((e) => [idOf(e.path), e] as const)), [employees]);
  // Employees in scope after the department filter (the denominator for availability).
  const visibleEmployees = useMemo(
    () => employees.filter((e) => !e.delete_time && (dept === "all" || (e.department && idOf(e.department) === dept))),
    [employees, dept],
  );
  const inDept = (empId: string) => dept === "all" || (empById.get(empId)?.department && idOf(empById.get(empId)!.department!) === dept);

  // Approved (and optionally pending) leaves, filtered to the department, with their day-range as ymd strings.
  const activeLeaves = useMemo(
    () =>
      leaves
        .filter((l) => l.employee && (upper(l.state) === "APPROVED" || (showPending && upper(l.state) === "PENDING")))
        .filter((l) => inDept(idOf(l.employee!)))
        .map((l) => ({ l, start: l.start_date.slice(0, 10), end: l.end_date.slice(0, 10), pending: upper(l.state) === "PENDING" })),
    [leaves, showPending, dept, empById],
  );

  const holByYmd = useMemo(() => {
    const m = new Map<string, Holiday>();
    for (const h of holidays) { if (!h.disabled && !h.delete_time) m.set(h.date.slice(0, 10), h); }
    return m;
  }, [holidays]);

  // The 42-cell grid (6 weeks) starting on the Sunday on/before the 1st of the visible month.
  const gridStart = useMemo(() => new Date(+cursor - cursor.getUTCDay() * DAY_MS), [cursor]);
  const cells = useMemo(() => Array.from({ length: 42 }, (_, i) => new Date(+gridStart + i * DAY_MS)), [gridStart]);
  const monthLabel = cursor.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
  const month = cursor.getUTCMonth();

  // Leaves overlapping a given ymd (a leave spans start..end inclusive).
  const leavesOn = (ymd: string) => activeLeaves.filter((x) => x.start <= ymd && x.end >= ymd);
  const eventsOn = (ymd: string) =>
    events.filter((ev) => {
      const s = ev.start_time.slice(0, 10), e = ev.end_time.slice(0, 10);
      return s <= ymd && e >= ymd && (ev.attendees ?? []).some((a) => inDept(idOf(a)));
    });

  const today = todayYmd();
  const onLeaveToday = useMemo(() => new Set(leavesOn(today).map((x) => idOf(x.l.employee!))).size, [activeLeaves]);

  // Leave types that actually appear in the visible data, so the legend stays short.
  const usedTypes = useMemo(() => {
    const used = new Set(activeLeaves.map((x) => (x.l.leave_type ? idOf(x.l.leave_type) : "")));
    return leaveTypes.filter((t) => used.has(idOf(t.path)));
  }, [activeLeaves, leaveTypes]);

  return (
    <div>
      <PageHeader
        title="Leave Calendar"
        description="Who's away each day, and how many of the team are available."
        actions={
          <>
            <PageSettings me={me} host="leave-calendar" />
            {departments.length > 0 && (
              <Select value={dept} onValueChange={setDept}>
                <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All departments</SelectItem>
                  {departments.filter((d) => !d.delete_time).map((d) => <SelectItem key={d.path} value={idOf(d.path)}>{d.display_name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Checkbox checked={showPending} onCheckedChange={(v) => setShowPending(v === true)} /> Include pending
            </label>
          </>
        }
      />

      <TruncationNotice collection="leave-requests" what="leave requests" className="mb-3" />

      <Card>
        <CardContent className="p-0">
          {/* Toolbar: month nav + today summary */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setCursor((c) => new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth() - 1, 1)))} aria-label="Previous month"><ChevronLeft className="h-4 w-4" /></Button>
              <Button variant="outline" size="sm" className="h-8" onClick={() => setCursor(monthStart(new Date()))}>Today</Button>
              <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setCursor((c) => new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth() + 1, 1)))} aria-label="Next month"><ChevronRight className="h-4 w-4" /></Button>
              <span className="ml-1 flex items-center gap-2 text-base font-semibold"><CalendarRange className="h-4 w-4 text-primary" />{monthLabel}</span>
              {/* Collection-level access key lives on the calendar toolbar (this view's control bar), not the heading. */}
              <AccessTarget target={{ collection: "leave-requests", label: "Leave calendar" }} className="h-6 w-6" />
            </div>
            <button
              type="button"
              onClick={() => { setCursor(monthStart(new Date())); setSelected(today); }}
              title="Jump to today and show who's out"
              className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <Plane className="h-4 w-4 text-primary" /> {onLeaveToday} of {visibleEmployees.length} on leave today
            </button>
          </div>

          {/* Weekday header */}
          <div className="grid grid-cols-7 border-b bg-muted/30 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {DOW.map((d, i) => (
              <div key={d} className={cn("py-2", !workDays.includes(i) && "text-muted-foreground/60")}>
                <span className="sm:hidden">{d[0]}</span>
                <span className="hidden sm:inline">{d}</span>
              </div>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7">
            {cells.map((d, i) => {
              const ymd = ymdUtc(d);
              const inMonth = d.getUTCMonth() === month;
              const isToday = ymd === today;
              const nonWorking = !workDays.includes(d.getUTCDay());
              const hol = holByYmd.get(ymd);
              const dayLeaves = leavesOn(ymd);
              const awayIds = new Set(dayLeaves.map((x) => idOf(x.l.employee!)));
              const isSel = selected === ymd;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => setSelected(isSel ? null : ymd)}
                  className={cn(
                    "relative min-h-[64px] border-b border-r p-1 text-left align-top transition-colors last:border-r-0 hover:bg-accent/50 sm:min-h-[92px] sm:p-1.5",
                    i % 7 === 6 && "border-r-0",
                    !inMonth && "bg-muted/20 text-muted-foreground/50",
                    hol ? "bg-violet-100/60 dark:bg-violet-950/30" : nonWorking && inMonth && "bg-slate-100/60 dark:bg-slate-800/30",
                    isSel && "ring-2 ring-inset ring-primary",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className={cn("flex h-5 w-5 items-center justify-center rounded-full text-xs tabular-nums sm:h-6 sm:w-6 sm:text-sm", isToday && "bg-primary font-semibold text-primary-foreground")}>{d.getUTCDate()}</span>
                    {awayIds.size > 0 && <span className="flex items-center gap-0.5 text-[11px] font-medium text-muted-foreground"><Plane className="h-3 w-3" />{awayIds.size}</span>}
                  </div>
                  {hol && inMonth && <p className="mt-0.5 truncate text-[11px] font-medium text-violet-700 dark:text-violet-300">{hol.display_name}</p>}
                  {/* Leave avatars (up to 4) + overflow count */}
                  {dayLeaves.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {dayLeaves.slice(0, 4).map(({ l, pending }) => {
                        const e = empById.get(idOf(l.employee!));
                        return (
                          <span key={l.path} className={cn("inline-flex items-center", pending && "opacity-50")} title={`${e ? `${e.first_name} ${e.last_name}` : "Someone"} · ${typeName(l.leave_type)}${pending ? " (pending)" : ""}`}>
                            <span className="h-4 w-4 rounded-full ring-1 ring-card" style={{ backgroundColor: colorOf(l.leave_type) }} />
                          </span>
                        );
                      })}
                      {dayLeaves.length > 4 && <span className="text-[11px] text-muted-foreground">+{dayLeaves.length - 4}</span>}
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {/* Legend: cell shading + what the dots mean (per-type colours only for leave-type managers) */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t p-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[9px] font-semibold tabular-nums text-primary-foreground">{new Date().getDate()}</span> Today
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded bg-violet-100 ring-1 ring-inset ring-violet-300 dark:bg-violet-950/40 dark:ring-violet-800" /> Holiday
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded bg-slate-100 ring-1 ring-inset ring-slate-300 dark:bg-slate-800/40 dark:ring-slate-600" /> Non-working day
            </span>
            {distinctColors ? (
              usedTypes.map((t) => (
                <span key={t.path} className="flex items-center gap-1.5">
                  <span className="h-3 w-3 rounded-full" style={{ backgroundColor: colorOf(t.path) }} /> {t.display_name}
                </span>
              ))
            ) : (
              <span className="flex items-center gap-1.5">
                <span className="h-3 w-3 rounded-full" style={{ backgroundColor: ONE_LEAVE_COLOR }} /> On leave (one dot per person)
              </span>
            )}
            {showPending && (
              <span className="flex items-center gap-1.5">
                <span className="h-3 w-3 rounded-full opacity-50" style={{ backgroundColor: ONE_LEAVE_COLOR }} /> Faded dot = pending approval
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {selected && <DayDetail
        ymd={selected}
        holiday={holByYmd.get(selected)}
        leaves={leavesOn(selected)}
        events={eventsOn(selected)}
        empById={empById}
        colorOf={colorOf}
        typeName={typeName}
        total={visibleEmployees.length}
        onRequest={() => setDraft({ from: selected, to: selected })}
      />}

      {draft && <RequestLeaveDialog open onOpenChange={(o) => !o && setDraft(null)} me={me} initial={{ from: draft.from, to: draft.to, startSession: 1, endSession: 2 }} onSubmitted={() => setDraft(null)} />}
    </div>
  );
}

type LeaveEntry = { l: LeaveRequest; start: string; end: string; pending: boolean };

// Detail panel for the clicked day: holiday, who's on leave (with half-day note), events, and a request action.
function DayDetail({ ymd, holiday, leaves, events, empById, colorOf, typeName, total, onRequest }: {
  ymd: string;
  holiday?: Holiday;
  leaves: LeaveEntry[];
  events: Event[];
  empById: Map<string, Employee>;
  colorOf: (ref?: string) => string;
  typeName: (ref?: string) => string;
  total: number;
  onRequest: () => void;
}) {
  const awayIds = new Set(leaves.map((x) => idOf(x.l.employee!)));
  // Alphabetical so a long who's-out list is scannable.
  const sortedLeaves = [...leaves].sort((a, b) => {
    const nameOf = (x: LeaveEntry) => { const e = empById.get(idOf(x.l.employee!)); return e ? `${e.first_name} ${e.last_name}` : "~"; };
    return nameOf(a).localeCompare(nameOf(b));
  });
  const dateLabel = new Date(parseYmd(ymd)).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  // Half-day note for a single-day request whose sessions don't span the whole day.
  const halfNote = (l: LeaveRequest) => {
    if (l.start_date.slice(0, 10) !== l.end_date.slice(0, 10)) return "";
    if (l.start_session === 1 && l.end_session === 1) return " · morning";
    if (l.start_session === 2 && l.end_session === 2) return " · afternoon";
    return "";
  };
  return (
    <Card className="mt-4">
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-primary" />
            <span className="font-semibold">{dateLabel}</span>
            {holiday && <Badge variant="secondary" className="bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">{holiday.display_name}</Badge>}
          </div>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground"><Users className="h-4 w-4" /> {Math.max(0, total - awayIds.size)} of {total} available</span>
            <Button size="sm" variant="outline" onClick={onRequest}><Plus className="h-4 w-4" /> Request leave</Button>
          </div>
        </div>

        {leaves.length === 0 ? (
          <p className="text-sm text-muted-foreground">No one on leave{holiday ? " (company holiday)" : ""}.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {sortedLeaves.map(({ l, pending }) => {
              const e = empById.get(idOf(l.employee!));
              return (
                <div key={l.path} className={cn("flex items-center gap-2 rounded-lg border p-2", pending && "opacity-70")}>
                  <PhotoAvatar employeeId={idOf(l.employee!)} name={e ? `${e.first_name} ${e.last_name}` : ""} photo={e?.photo} className="h-8 w-8" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{e ? `${e.first_name} ${e.last_name}` : "Someone"}</p>
                    <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: colorOf(l.leave_type) }} />
                      {typeName(l.leave_type)}{halfNote(l)}
                      <span className="text-muted-foreground/70">· {dmy(l.start_date)}–{dmy(l.end_date)}</span>
                      {pending && <Badge variant="warning" className="ml-1 h-4 px-1 text-[10px]">pending</Badge>}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {events.length > 0 && (
          <div className="space-y-1.5 border-t pt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Events</p>
            {events.map((ev) => (
              <div key={ev.path} className="flex items-center gap-2 text-sm">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: ev.color || "#6366f1" }} />
                <span className="font-medium">{ev.title}</span>
                {ev.description && <span className="truncate text-muted-foreground">· {ev.description}</span>}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

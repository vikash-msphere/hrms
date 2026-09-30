import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlarmClock, AlertTriangle, CalendarCheck, CalendarDays, Check, CheckSquare, ChevronLeft, ChevronRight,
  Clock, Coffee, List, Pencil, Scale, Timer, TrendingUp, Zap,
} from "lucide-react";
import { get, create, patch, remove } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useScheduleView } from "@/hooks/useScheduleView";
import { useMedia } from "@/hooks/useMedia";
import { listAllSessions } from "@/lib/clock";
import { cn, idOf, formatDate } from "@/lib/utils";
import {
  buildAttendanceRows, groupWeeks, statsOf, summarizeByDay,
  fmtDay, fmtDayLong, fmtDuration, fmtDurationShort, fmtHM, fmtMinOfDay, hhmmToMin, localDay, localMinutes,
  signedDuration, monthGridDays, weekdayOrder, CREDIT_LABEL, DOW, STATUS_UI, leaveRangeOf, unpaidLeaveTypes,
  type AttendanceRow, type AttendanceSchedule, type DayCredit, type DayStatus, type LeaveRange, type PunchTarget, type WeekGroup, type WindowStats,
} from "@/lib/attendance";
import type { AttendanceWindow } from "@/hooks/useAttendanceWindow";
import type { AttendanceDayMark, AttendanceSession, Holiday, LateEarlyRequest, LeaveRequest, LeaveType } from "@/types";
import { excusalsFor, usePunctualityPolicy, type LateEarlyKind } from "@/lib/lateEarly";
import { AccessAction } from "@/components/access/AccessAction";
import { Field } from "@/components/common/Field";
import { WriteDialog } from "@/components/common/WriteDialog";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";
import type { AttendanceSeriesDay } from "@/lib/analytics";
import { Chart } from "@/components/common/Chart";
import { heatmapDays } from "@/lib/chartTheme";
import { ExportButton } from "@/components/common/ExportButton";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { useKpiFocus } from "@/lib/kpiFocus";
import { exportTable } from "@/lib/exportTable";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

// One person's attendance over one window of days: the hours trend, the year heatmap, the summary strip and
// the history itself (a week-grouped list, or the same days as a month grid, each day folding open to its
// punches).
//
// It is the SAME component wherever attendance is read - the reader's own page, an employee's record, a
// manager's drill-in from the team table - so a day reads the same way to everyone who can see it and there
// is one place to fix how a day is described. What changes between them is who may act on a day: the
// correction affordances are `onCorrect`/`onLogOvertime`, and an approver reading somebody else's log is
// given neither. They do not file another person's correction; the person does, or the approver edits the
// answer to one that was filed.
//
// Data arrives either way round. A caller that already holds the punches (the Attendance page fetches
// everyone's for its team panel) hands them over and the history fetches nothing; a caller that holds none
// (an employee's record) omits them and the history reads its own window, narrowed to this employee by the
// server (`GET /v1/attendance?employee=`). Same for leave. That keeps the reader's own page at exactly the
// requests it made before this component existed.

export type AttendanceLeaveContext = {
  /** Approved leave covering this employee, for absent-day detection. */
  ranges: LeaveRange[];
  /** The request covering a day, for the "why there are no punches" detail. */
  forDay: (day: string) => LeaveRequest | undefined;
};

export function AttendanceHistory({
  employeeId, joinedYmd, trackedFromYmd, win, sched, orgToday, now: givenNow, title, canExport, exportName, canMark,
  sessions: givenSessions, loading: givenLoading, leave: givenLeave, lateEarly: givenLateEarly, onCorrect, onLogOvertime, onRequestLateEarly, emptyText, refreshKey,
  liveMinutes = 0,
}: {
  employeeId: string;
  /**
   * May the caller re-value THIS PERSON'S days (write `attendance-day-marks` about them)?
   *
   * Answered by the HOST, not by a hook in here, because the two hosts know different things and only they
   * know which. On a profile the page holds the server's per-subject answer (`access.subject`) and passes that
   * exact key; on the Attendance page - a roster spanning everybody, with no one subject to ask about - the
   * caller's own write breadth is the honest answer and the server still refuses any row it does not reach.
   * Asking `useSubjectCanWrite` from inside was wrong for the second host in the worst way: there is no
   * provider there, so the context answered its fail-closed empty set and the affordance vanished from the
   * page HR actually marks days on.
   */
  canMark: boolean;
  /** The person's join date: days before it aren't their attendance, so they're never flagged absent. */
  joinedYmd?: string;
  /** The day HRMS records start for them (`trackedFromOf`): an empty day before it is not an absence. */
  trackedFromYmd?: string;
  win: AttendanceWindow;
  sched: AttendanceSchedule;
  orgToday: string;
  /** A minute-grained clock from the owner, where it already keeps one (the Attendance page ticks for its
   *  team panel). Left out, the history runs its own - an open session's elapsed time has to advance. */
  now?: number;
  title: string;
  canExport: boolean;
  /** Filename stem for the export, e.g. "attendance" or "attendance-jane-doe". */
  exportName: string;
  sessions?: AttendanceSession[];
  loading?: boolean;
  leave?: AttendanceLeaveContext;
  /** Approved late arrival / early departure requests the host already holds (they may be everyone's; this
   *  keeps the employee's). Omitted, the history reads its own window of them. */
  lateEarly?: LateEarlyRequest[];
  /** Omitted on somebody else's record - see the note above. With `punch`, the request is about that one
   *  clock-in or clock-out of the (single) day rather than the whole day. */
  onCorrect?: (rows: AttendanceRow[], punch?: PunchTarget) => void;
  onLogOvertime?: (row: AttendanceRow) => void;
  /** Ask for a late arrival / early departure to be approved for a day the punches flagged. Omitted wherever
   *  the reader may not file one for this person - the same rule as `onCorrect`. */
  onRequestLateEarly?: (row: AttendanceRow, kind: LateEarlyKind) => void;
  emptyText?: string;
  /** Bumped by the owner to re-read the window (after a correction is filed, say). Ignored when `sessions`
   *  are supplied, because then the owner owns the fetch. */
  refreshKey?: number;
  /** Minutes of a session that is still open right now. `workedMinutes` counts closed sessions only, so
   *  without this the hours total on the current window goes backwards every morning until the punch-out. It
   *  only applies to the window that contains today. */
  liveMinutes?: number;
}) {
  const { view, page, fromYmd, toYmd, prevWindow, windowLabel, prevLabel, switchView, goPage } = win;
  const tz = sched.timezone;
  const [expanded, setExpanded] = useState<Set<string>>(new Set()); // days whose punch detail is unfolded
  const [selectedDay, setSelectedDay] = useState<string | null>(null); // month grid: the day whose detail is open
  const [picked, setPicked] = useState<Set<string>>(new Set()); // month grid: days ticked for a bulk correction
  const [compare, setCompare] = useState(false); // opt-in: fetch the previous window to show deltas
  const [prevStats, setPrevStats] = useState<WindowStats | null>(null);
  const compactViewport = useMedia("(max-width: 639px)"); // phones get day cards; the day table needs a wide viewport

  // Everything on screen is minute-grained, so a 30s tick is enough - and it only runs where the owner has no
  // clock of its own to lend.
  const [ownNow, setOwnNow] = useState(Date.now());
  useEffect(() => {
    if (givenNow !== undefined) return;
    const t = setInterval(() => setOwnNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [givenNow]);
  const now = givenNow ?? ownNow;

  // A different window has different days, so neither per-window selection survives one.
  useEffect(() => { setSelectedDay(null); setPicked(new Set()); }, [fromYmd, toYmd]);

  // ---- Punches ----
  // `ownSessions` is only ever populated when the caller supplied none; `ownLoading` starts true in that case
  // so the first paint is a skeleton rather than an empty window.
  const fetching = givenSessions === undefined;
  const [ownSessions, setOwnSessions] = useState<AttendanceSession[]>([]);
  const [ownLoading, setOwnLoading] = useState(fetching);
  useEffect(() => {
    if (!fetching) return;
    let live = true;
    setOwnLoading(true);
    void listAllSessions(
      `attendance?employee=employees/${employeeId}&from=${encodeURIComponent(`${fromYmd}T00:00:00.000Z`)}&to=${encodeURIComponent(`${toYmd}T23:59:59.999Z`)}`,
    )
      .then((s) => { if (live) setOwnSessions(s); })
      .catch(() => { if (live) setOwnSessions([]); })
      .finally(() => { if (live) setOwnLoading(false); });
    return () => { live = false; };
  }, [fetching, employeeId, fromYmd, toYmd, refreshKey]);

  // Whoever supplied the punches, they are filtered to this employee here: the page hands over everyone's.
  const sessions = useMemo(
    () => (givenSessions ?? ownSessions).filter((s) => s.employee && idOf(s.employee) === employeeId),
    [givenSessions, ownSessions, employeeId],
  );
  const pageLoading = fetching ? ownLoading : !!givenLoading;

  // ---- Leave, holidays and the day rows ----
  // Read only when the caller supplied no leave context. `holidays` and `leave-types` go through the shared
  // resource store, so a page that already reads them (the Attendance page does) shares the one request.
  const { rows: ownLeaves } = useCollection<LeaveRequest>("leave-requests", {
    enabled: !givenLeave,
    all: true,
    params: { employee: `employees/${employeeId}`, from: prevWindow.from, to: toYmd },
  });
  const { rows: holidays } = useCollection<Holiday>("holidays", { all: true });
  const { rows: leaveTypes } = useCollection<LeaveType>("leave-types");
  // HR's decisions about these days. `useCollection` gates on `attendance-day-marks.read`, so a caller who
  // cannot see them never fires the request and the grid simply has no marks on it - which is the correct
  // reading for somebody who is not allowed to know.
  const { rows: dayMarks, reload: reloadMarks } = useCollection<AttendanceDayMark>("attendance-day-marks", {
    all: true,
    // Back to the PREVIOUS window's start, not this one's: the opt-in comparison builds rows for that window
    // too, and marks fetched only for the visible one would have the comparison counting a marked day as an
    // absence while the window above it does not.
    params: { employee: `employees/${employeeId}`, from: prevWindow.from, to: toYmd },
  });
  const marksByDay = useMemo(
    () => new Map(dayMarks.filter((m) => m.date).map((m) => [m.date!, m.credit as DayCredit])),
    [dayMarks],
  );
  const markRowByDay = useMemo(() => new Map(dayMarks.filter((m) => m.date).map((m) => [m.date!, m])), [dayMarks]);
  const [marking, setMarking] = useState<AttendanceRow | null>(null);
  // Approved late arrivals / early departures over the same window (the comparison's too, for the reason given
  // on the marks above): each moves its day's start or end, and the day is judged against the moved window.
  // Gated like the marks - a caller who cannot read these requests fires no request and sees the org's window.
  const { rows: ownLateEarly } = useCollection<LateEarlyRequest>("late-early-requests", {
    enabled: !givenLateEarly,
    all: true,
    params: { employee: `employees/${employeeId}`, from: prevWindow.from, to: toYmd, state: "APPROVED" },
  });
  const excusals = useMemo(() => excusalsFor(givenLateEarly ?? ownLateEarly, employeeId), [givenLateEarly, ownLateEarly, employeeId]);
  const punctuality = usePunctualityPolicy();

  const ownApproved = useMemo(
    () => (givenLeave ? [] : ownLeaves.filter((l) => (l.state ?? "").toUpperCase() === "APPROVED")),
    [givenLeave, ownLeaves],
  );
  const unpaidTypes = useMemo(() => unpaidLeaveTypes(leaveTypes), [leaveTypes]);
  const leaveRanges = useMemo<LeaveRange[]>(
    () => givenLeave?.ranges ?? ownApproved.map((l) => leaveRangeOf(l, unpaidTypes)),
    [givenLeave, ownApproved, unpaidTypes],
  );
  const leaveForDay = useCallback(
    (day: string) => (givenLeave ? givenLeave.forDay(day) : ownApproved.find((l) => l.start_date <= day && day <= l.end_date)),
    [givenLeave, ownApproved],
  );
  const holidayByDay = useMemo(() => {
    const m = new Map<string, Holiday>();
    // A regional holiday for another location (`applies === false`) is a normal working day here.
    for (const h of holidays) if (!h.disabled && h.applies !== false) m.set(h.date, h);
    return m;
  }, [holidays]);
  const holidaySet = useMemo(() => new Set(holidayByDay.keys()), [holidayByDay]);
  const leaveTypeName = useMemo(() => {
    const m = new Map(leaveTypes.map((t) => [idOf(t.path), t]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) : undefined);
  }, [leaveTypes]);

  // This person's own days. WIDENED BACK TO THE COMPARISON WINDOW, because the same `buildRows` is used for
  // it: resolved against the visible window alone, the previous period would fall back to the org's week and
  // the two halves of the comparison would be counted on different calendars.
  const schedView = useScheduleView(sched, prevWindow.from < fromYmd ? prevWindow.from : fromYmd, toYmd, employeeId);
  const schedOf = useMemo(() => schedView.of(employeeId), [schedView, employeeId]);

  const buildRows = useCallback(
    (src: AttendanceSession[], opts: { from: string; to: string }) =>
      buildAttendanceRows({
        fromYmd: opts.from, toYmd: opts.to, todayYmd: orgToday, schedOf,
        summaries: summarizeByDay(src, sched, { excusals, policy: punctuality.attendance, leaveRanges }),
        holidays: holidaySet, leaveRanges, marksByDay, joinedYmd, trackedFromYmd,
      }),
    [orgToday, sched, schedOf, holidaySet, leaveRanges, marksByDay, joinedYmd, trackedFromYmd, excusals, punctuality],
  );

  const rows = useMemo(() => buildRows(sessions, { from: fromYmd, to: toYmd }), [sessions, buildRows, fromYmd, toYmd]);
  const rowByDay = useMemo(() => new Map(rows.map((r) => [r.day, r])), [rows]);

  // ---- The summary strip, which is also the history's filter ----
  // Every figure in the strip is a set of days, so clicking one narrows the list to exactly those days. The
  // month grid has to stay whole to read as a calendar, so a metric click lands in the list view.
  const isLateRow = (r: AttendanceRow) => r.status === "late" || r.status === "late_early";
  const isShortRow = (r: AttendanceRow) =>
    !!r.summary && r.summary.workedMinutes > 0 && r.summary.workedMinutes < sched.full_day_minutes;
  const isLongRow = (r: AttendanceRow) => !!r.summary && r.summary.workedMinutes > sched.full_day_minutes + 30;
  // Punctuality is judged on CLOSED days only, the way the on-time percentage is: a day still being worked
  // hasn't earned a verdict yet, so it belongs to neither side.
  const isOnTimeRow = (r: AttendanceRow) => !!r.summary && !r.summary.open && !r.summary.late;
  // One key per metric, even where two metrics count the same rows (days and hours worked): the key IS the
  // selection, so sharing one would light both segments off a single click.
  type DayFocus = "worked" | "hours" | "onTime" | "late" | "absent" | "short" | "long";
  const kf = useKpiFocus<AttendanceRow, DayFocus>({
    worked: { label: "days with punches", match: (r) => !!r.summary && r.summary.workedMinutes > 0 },
    hours: { label: "days with punches", match: (r) => !!r.summary && r.summary.workedMinutes > 0 },
    onTime: { label: "on-time days", match: isOnTimeRow },
    late: { label: "late arrivals", match: isLateRow },
    absent: { label: "days with no punches", match: (r) => r.status === "absent" },
    short: { label: "short days", match: isShortRow },
    long: { label: "days over a full shift", match: isLongRow },
  });
  const dayKpi = (key: DayFocus) => {
    const base = kf.kpi(key);
    return { ...base, onClick: () => { if (view !== "list") switchView("list"); base.onClick(); } };
  };
  const listRows = useMemo(() => kf.apply(rows), [rows, kf.focus]); // eslint-disable-line react-hooks/exhaustive-deps
  const weeks = useMemo<WeekGroup[]>(() => groupWeeks(listRows), [listRows]);

  const stats = useMemo(() => statsOf(rows, tz, schedOf, orgToday), [rows, tz, schedOf, orgToday]);
  // Absent days in the visible window, surfaced above the table so a missed punch is one click from a fix.
  const absentRows = useMemo(() => rows.filter((r) => r.status === "absent"), [rows]);
  const shortDays = useMemo(() => rows.filter(isShortRow).length, [rows, sched.full_day_minutes]); // eslint-disable-line react-hooks/exhaustive-deps
  const longDays = useMemo(() => rows.filter(isLongRow).length, [rows, sched.full_day_minutes]); // eslint-disable-line react-hooks/exhaustive-deps

  // The previous window is only ever fetched when the comparison is switched on (an extra read has to be
  // asked for), and it is always read here rather than taken from the caller: the caller holds the window on
  // screen, not the one before it.
  useEffect(() => {
    if (!compare) { setPrevStats(null); return; }
    let live = true;
    void (async () => {
      try {
        const prev = await listAllSessions(
          `attendance?employee=employees/${employeeId}&from=${encodeURIComponent(`${prevWindow.from}T00:00:00.000Z`)}&to=${encodeURIComponent(`${prevWindow.to}T23:59:59.999Z`)}`,
        );
        if (!live) return;
        setPrevStats(statsOf(buildRows(prev, { from: prevWindow.from, to: prevWindow.to }), tz, schedOf, orgToday));
      } catch {
        if (live) setPrevStats(null);
      }
    })();
    return () => { live = false; };
  }, [compare, prevWindow, buildRows, employeeId, tz, schedOf, orgToday]);

  // The grid opens on the day you're most likely to be looking for: today, else the newest day with a record.
  useEffect(() => {
    if (view !== "calendar" || pageLoading || selectedDay) return;
    setSelectedDay(rowByDay.has(orgToday) ? orgToday : rows[0]?.day ?? null);
  }, [view, pageLoading, selectedDay, rowByDay, rows, orgToday]);

  const toggleDay = useCallback((day: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(day) ? next.delete(day) : next.add(day);
      return next;
    });
  }, []);
  // Pressing a bar in the hours chart opens that day, in whichever shape the view has for a day: the month
  // grid's detail panel on the calendar, the unfolded punch row in the history list. Not a view switch: the
  // reader chose the view, and pressing a bar is a request to see a day, not to change how days are shown.
  const pickDay = useCallback((day: string) => {
    if (view === "calendar") { setSelectedDay(day); return; }
    setExpanded((prev) => new Set(prev).add(day));
    requestAnimationFrame(() => document.getElementById(`att-day-${day}`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
  }, [view]);

  const overtimeMinutes = (r: AttendanceRow) => {
    const dep = r.summary?.departure;
    if (!dep || !r.summary || r.summary.open) return 0;
    return Math.max(0, localMinutes(dep, tz) - hhmmToMin(sched.shift_end));
  };
  const dayDetailProps = (r: AttendanceRow) => ({
    row: r,
    punches: r.summary?.sessions ?? [],
    now,
    tz,
    // A half-day-leave row is about the leave too - it is the half that WAS excused - so the detail panel
    // gets the same request to describe.
    leave: r.status === "on_leave" || r.status === "half_day_leave" ? leaveForDay(r.day) : undefined,
    leaveType: r.status === "on_leave" || r.status === "half_day_leave" ? leaveTypeName(leaveForDay(r.day)?.leave_type) : undefined,
    holiday: r.status === "holiday" ? holidayByDay.get(r.day) : undefined,
    onCorrect: onCorrect ? () => onCorrect([r]) : undefined,
    onFixPunch: onCorrect ? (punch: PunchTarget) => onCorrect([r], punch) : undefined,
    // Offer the overtime hand-off only for a day that actually ran well past the shift (and only to callers
    // who may file one), so it stays a real signal rather than a button on every row.
    onLogOvertime: onLogOvertime && overtimeMinutes(r) >= 30 ? () => onLogOvertime(r) : undefined,
    overtimeMinutes: overtimeMinutes(r),
    // A late or left-early day offers the request that would excuse it: only where the reader may file one,
    // only for a kind the org's policy offers, and not where one is already approved (a day holds one live
    // request of each kind, so a second would only be refused).
    onRequestLate: onRequestLateEarly && r.summary?.late && r.summary.approvedLateUntil == null && punctuality.requests.enabled && punctuality.requests.late_arrival
      ? () => onRequestLateEarly(r, "late_arrival") : undefined,
    onRequestEarly: onRequestLateEarly && r.summary?.leftEarly && r.summary.approvedEarlyFrom == null && punctuality.requests.enabled && punctuality.requests.early_departure
      ? () => onRequestLateEarly(r, "early_departure") : undefined,
  });

  function exportWindow(format: "csv" | "xlsx") {
    // "Counted as" rides beside "Status", never instead of it. This export is what somebody attaches to a
    // question about their pay, and a sheet that showed only the derived status would state the opposite of
    // what was paid on every marked day - while one that showed only the mark would hide that a decision had
    // been made at all. The reason comes too: a decision without its reason is the thing being disputed.
    // "Approved" is the moved window a late or early day was judged against - without it, "Late by 20" on a
    // day somebody was approved to start two hours late reads as twenty minutes past nine.
    const headers = ["Date", "Day", "Status", "Counted as", "Reason", "Approved", "First in", "Last out", "Worked", "Worked minutes", "Late by (min)", "Left early by (min)"];
    const data = [...rows].reverse().map((r) => {
      const s = r.summary;
      return [
        r.day,
        new Date(`${r.day}T00:00:00`).toLocaleDateString(undefined, { weekday: "long" }),
        STATUS_UI[r.status].label,
        r.mark ? CREDIT_LABEL[r.mark] : "",
        (r.mark && markRowByDay.get(r.day)?.reason) || "",
        approvedLabel(s) ?? "",
        s?.arrival ? fmtHM(s.arrival, tz) : "",
        s?.departure ? fmtHM(s.departure, tz) : "",
        s ? fmtDuration(s.workedMinutes) : "",
        s?.workedMinutes ?? 0,
        s?.lateByMin ?? 0,
        s?.earlyByMin ?? 0,
      ];
    });
    void exportTable(`${exportName}-${fromYmd}-to-${toYmd}`, headers, data, format, "attendance");
  }

  const selectedRow = selectedDay ? rowByDay.get(selectedDay) : undefined;

  return (
    <div className="space-y-6">
      {/* Hours per day across the window, the running balance against the schedule, and (on request) how it
          compares with the window before. */}
      {!pageLoading && rows.length > 1 && (
        <HoursTrend
          rows={rows}
          full={sched.full_day_minutes}
          stats={stats}
          prev={prevStats}
          prevLabel={prevLabel}
          comparing={compare}
          onToggleCompare={() => setCompare((c) => !c)}
          selectedDay={view === "calendar" ? selectedDay : null}
          onPickDay={pickDay}
        />
      )}

      {/* A year at a glance. Folded away and fetched only when it is opened: a year of punches is a server
          aggregate (GET /v1/people-analytics with a series), and nobody should pay for it to look at this
          month. */}
      {!pageLoading && <YearHeatmap employeeId={employeeId} tz={tz} onPickDay={pickDay} inWindow={(d) => d >= fromYmd && d <= toYmd} />}

      {/* The visible window at a glance: days/hours, punctuality with average in-out, and what needs fixing.
          Every metric narrows the history below, so the strip rides directly on top of it - under the charts,
          which are only there to be read. */}
      {!pageLoading && rows.length > 0 && (
        <SummaryStrip
          className="mb-0"
          items={[
            { label: "Days worked", value: stats.worked, icon: CalendarCheck, hint: `of ${stats.workingDays} working`, ...dayKpi("worked") },
            { label: "Hours worked", value: fmtDuration(stats.minutes + (page === 0 ? liveMinutes : 0)), icon: Clock, hint: stats.avgDay ? `avg ${fmtDurationShort(stats.avgDay)} a day` : "nothing logged yet", ...dayKpi("hours") },
            {
              label: "On time",
              value: stats.onTimePct === null ? "-" : `${stats.onTimePct}%`,
              icon: Timer,
              tone: stats.onTimePct === null ? "muted" : stats.onTimePct >= 90 ? "success" : stats.onTimePct >= 75 ? "warning" : "destructive",
              hint: stats.avgIn !== null ? `in ${fmtMinOfDay(stats.avgIn)}${stats.avgOut !== null ? ` · out ${fmtMinOfDay(stats.avgOut)}` : ""}` : "no clock-ins yet",
              ...dayKpi("onTime"),
            },
            { label: "Late arrivals", value: stats.late, icon: AlarmClock, tone: stats.late > 0 ? "warning" : "muted", hint: stats.late ? "after shift start" : "all on time", ...dayKpi("late") },
            // Short and long days are what a timesheet argument turns on, and neither shows in a day count.
            ...(shortDays ? [{ label: "Short days", value: shortDays, icon: Clock, tone: "warning" as const, hint: "under a full shift", ...dayKpi("short") }] : []),
            ...(longDays ? [{ label: "Long days", value: longDays, icon: Clock, tone: "default" as const, hint: "over a full shift", ...dayKpi("long") }] : []),
            { label: "Absent", value: stats.absent, icon: AlertTriangle, tone: stats.absent > 0 ? "destructive" : "muted", hint: stats.absent ? "fix with a correction" : "none missed", ...dayKpi("absent") },
          ]}
        />
      )}

      {/* Misses that need regularizing, pulled out of the history so they're impossible to overlook. Only
          where a correction can actually be filed from here - on somebody else's record it would be a row of
          buttons that do nothing. */}
      {onCorrect && !pageLoading && absentRows.length > 0 && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
            <div className="min-w-0 space-y-2">
              <p className="text-sm font-medium">
                {absentRows.length === 1 ? "1 working day here has" : `${absentRows.length} working days here have`} no punches
              </p>
              <p className="text-xs text-muted-foreground">
                If you worked or forgot to clock, request a correction - your manager or HR approves it and the day is fixed.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {absentRows.map((r) => (
                  <button
                    key={r.day}
                    type="button"
                    onClick={() => onCorrect([r])}
                    className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-xs font-medium hover:border-foreground/30 hover:bg-muted"
                    title={`Request a correction for ${formatDate(r.day)}`}
                  >
                    <Pencil className="h-3 w-3 text-muted-foreground" aria-hidden /> {fmtDay(r.day)}
                  </button>
                ))}
                {absentRows.length > 1 && (
                  <button
                    type="button"
                    onClick={() => onCorrect(absentRows)}
                    className="inline-flex items-center gap-1.5 rounded-full border border-destructive/40 bg-background px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
                  >
                    <CheckSquare className="h-3 w-3" aria-hidden /> Fix all {absentRows.length} with the same times
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* The history: a week-grouped list of days, or the same days as a month grid (each day folds open to
          its punches) */}
      <Card>
        <CardHeader className="flex-col items-start gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <CardTitle className="text-base">{title}</CardTitle>
            <div className="inline-flex rounded-lg bg-muted p-0.5" role="group" aria-label="History view">
              {([["list", "List", List], ["calendar", "Month", CalendarDays]] as const).map(([v, label, Icon]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => switchView(v)}
                  aria-pressed={view === v}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    view === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" /> {label}
                </button>
              ))}
            </div>
          </div>
          {/* Export + a prev/label/next pager + Today. The window label alone reserves 11rem, which with the
              export control is already past a phone's width - so the row wraps, and the label's own floor
              drops to something that still fits a line of its own on the narrowest screen. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <ExportButton canExport={canExport} label={`Export ${rows.length} day${rows.length === 1 ? "" : "s"}`} onExport={exportWindow} disabled={rows.length === 0} />
            <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => goPage(page + 1)} aria-label="Previous month"><ChevronLeft className="h-4 w-4" /></Button>
            <span className="min-w-[7rem] text-center text-xs tabular-nums text-muted-foreground sm:min-w-[11rem]">{windowLabel}</span>
            <Button variant="outline" size="icon" className="h-7 w-7" disabled={page === 0} onClick={() => goPage(Math.max(0, page - 1))} aria-label="Next month"><ChevronRight className="h-4 w-4" /></Button>
            {page > 0 && <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => goPage(0)}>Today</Button>}
          </div>
        </CardHeader>
        <CardContent>
          {pageLoading ? (
            <div className="space-y-2 py-1">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className={cn("w-full", view === "calendar" ? "h-16" : "h-8")} />)}
            </div>
          ) : view === "calendar" ? (
            <div className="space-y-4">
              {/* Bulk correction: tick several days, fix them all with one set of times (a whole week of
                  missed punches is one request per day, not one dialog per day). */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  {!onCorrect ? "Click a day for its punches."
                    : picked.size > 0 ? `${picked.size} day${picked.size === 1 ? "" : "s"} ticked`
                    : "Click a day for its punches, or tick several to correct them together."}
                </p>
                {onCorrect && picked.size > 0 && (
                  <div className="flex items-center gap-1.5">
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setPicked(new Set())}>Clear</Button>
                    <Button size="sm" className="h-7" onClick={() => onCorrect([...picked].sort().map((d) => rowByDay.get(d) ?? { day: d, status: "absent" as DayStatus }))}>
                      <Pencil className="h-3 w-3" /> Correct {picked.size} day{picked.size === 1 ? "" : "s"}
                    </Button>
                  </div>
                )}
              </div>
              <MonthGrid
                monthYmd={fromYmd}
                rowByDay={rowByDay}
                orgToday={orgToday}
                workDays={sched.work_days}
                weekStart={sched.week_start ?? 0}
                selected={selectedDay}
                picked={picked}
                onSelect={setSelectedDay}
                onTick={!onCorrect ? undefined : (d) => setPicked((prev) => {
                  const next = new Set(prev);
                  next.has(d) ? next.delete(d) : next.add(d);
                  return next;
                })}
              />
              {selectedRow ? (
                <div className="rounded-xl border p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{fmtDayLong(selectedRow.day)}</span>
                      {selectedRow.day === orgToday && <Badge variant="info">Today</Badge>}
                      <StatusPill status={selectedRow.status} lateBy={selectedRow.summary?.lateByMin} earlyBy={selectedRow.summary?.earlyByMin} />
                      <ApprovedBadge summary={selectedRow.summary} />
                      {selectedRow.mark && <MarkBadge credit={selectedRow.mark} />}
                    </div>
                    <div className="flex items-center gap-2">
                      {canMark && (
                        <AccessAction collection="attendance-day-marks" create label="Count this day as">
                          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => setMarking(selectedRow)}>
                            <Scale className="h-3 w-3" /> Counts as
                          </Button>
                        </AccessAction>
                      )}
                      {selectedRow.summary && (
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {selectedRow.summary.arrival ? fmtHM(selectedRow.summary.arrival, tz) : "-"} – {selectedRow.summary.departure ? fmtHM(selectedRow.summary.departure, tz) : selectedRow.summary.open ? "open" : "-"} · {fmtDuration(selectedRow.summary.workedMinutes)}
                        </span>
                      )}
                      {onCorrect && (
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => onCorrect([selectedRow])}>
                          <Pencil className="h-3 w-3" /> Correct
                        </Button>
                      )}
                    </div>
                  </div>
                  <DayDetail {...dayDetailProps(selectedRow)} />
                </div>
              ) : (
                <p className="py-2 text-center text-sm text-muted-foreground">Pick a day to see its punches.</p>
              )}
            </div>
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {page === 0 ? emptyText ?? "No attendance recorded yet." : "No attendance in this period."}
            </p>
          ) : compactViewport ? (
            <DayCards weeks={weeks} orgToday={orgToday} tz={tz} expanded={expanded} onToggle={toggleDay} detail={dayDetailProps} />
          ) : (
            <div className="scroll-shadow-x [--scroll-ground:hsl(var(--card))] overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b text-left text-muted-foreground"><th className="w-7 py-2" /><th className="py-2 pr-3 font-medium">Day</th><th className="py-2 pr-3 font-medium">In</th><th className="py-2 pr-3 font-medium">Out</th><th className="py-2 pr-3 text-right font-medium">Worked</th><th className="py-2 font-medium">Status</th><th className="w-9 py-2" /></tr></thead>
                <tbody>
                  {listRows.length === 0 && (
                    <tr><td colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                      No {kf.activeLabel ?? "days"} in this window.{" "}
                      {kf.focus && <button type="button" className="font-medium text-primary underline-offset-2 hover:underline" onClick={kf.clear}>Show every day</button>}
                    </td></tr>
                  )}
                  {weeks.map((w) => (
                    <Fragment key={w.start}>
                      <tr className="border-b bg-muted/40">
                        <td />
                        <td colSpan={6} className="py-1.5 pr-3">
                          <div className="flex items-center justify-between gap-3 text-xs">
                            <span className="font-medium uppercase tracking-wide text-muted-foreground">Week of {fmtDay(w.start)}</span>
                            <span className="tabular-nums text-muted-foreground">{w.days} {w.days === 1 ? "day" : "days"} · <span className="font-semibold text-foreground">{fmtDuration(w.minutes)}</span></span>
                          </div>
                        </td>
                      </tr>
                      {w.rows.map((r) => {
                        const d = r.summary;
                        const isOpen = expanded.has(r.day);
                        return (
                          <Fragment key={r.day}>
                            {/* Expanding a day is the row's own action, so it needs a tab stop and
                                Enter/Space - the chevron is decoration, not the control. The key handler
                                ignores events from inside the row so the correction pencil keeps its own. */}
                            <tr
                              id={`att-day-${r.day}`}
                              className={cn("group cursor-pointer border-b last:border-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", isOpen && "bg-muted/30")}
                              tabIndex={0}
                              aria-expanded={isOpen}
                              onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggleDay(r.day); } }}
                              onClick={() => toggleDay(r.day)}
                            >
                              <td className="py-1.5 align-middle">
                                <button type="button" onClick={(e) => { e.stopPropagation(); toggleDay(r.day); }} className="text-muted-foreground hover:text-foreground" aria-label={isOpen ? `Collapse ${r.day}` : `Expand ${r.day}`} aria-expanded={isOpen}>
                                  <ChevronRight className={cn("h-4 w-4 transition-transform", isOpen && "rotate-90")} />
                                </button>
                              </td>
                              <td className="py-1.5 pr-3 font-medium">
                                <span className="flex items-center gap-2">
                                  <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_UI[r.status].dot)} aria-hidden />
                                  {fmtDay(r.day)}
                                  {r.day === orgToday && <span className="text-xs font-normal text-primary">Today</span>}
                                </span>
                              </td>
                              <td className="py-1.5 pr-3 tabular-nums">{d?.arrival ? fmtHM(d.arrival, tz) : "-"}</td>
                              <td className="py-1.5 pr-3 tabular-nums">{d?.departure ? fmtHM(d.departure, tz) : d?.open ? "open" : "-"}</td>
                              <td className="py-1.5 pr-3 text-right tabular-nums">{d ? fmtDuration(d.workedMinutes) : "-"}</td>
                              <td className="py-1.5">
                                <span className="flex flex-wrap items-center gap-1.5">
                                  <StatusPill status={r.status} lateBy={d?.lateByMin} earlyBy={d?.earlyByMin} />
                                  <ApprovedBadge summary={d} />
                                  {r.mark && <MarkBadge credit={r.mark} />}
                                </span>
                              </td>
                              <td className="py-1.5 text-right">
                                <span className="flex items-center justify-end gap-1">
                                  {canMark && (
                                    <button
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); setMarking(r); }}
                                      className={cn("text-muted-foreground transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100", r.mark ? "opacity-100" : "opacity-0")}
                                      title={`Set what ${formatDate(r.day)} counts as`}
                                      aria-label={`Set what ${formatDate(r.day)} counts as`}
                                    >
                                      <Scale className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                  {onCorrect && (
                                    <button
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); onCorrect([r]); }}
                                      className="text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                                      title={`Request a correction for ${formatDate(r.day)}`}
                                      aria-label={`Request a correction for ${formatDate(r.day)}`}
                                    >
                                      <Pencil className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                </span>
                              </td>
                            </tr>
                            {isOpen && (
                              <tr className="border-b bg-muted/30 last:border-0">
                                <td />
                                <td colSpan={6} className="pb-3 pr-3"><DayDetail {...dayDetailProps(r)} /></td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {marking && (
        <DayMarkDialog
          key={marking.day}
          row={marking}
          employeeId={employeeId}
          existing={markRowByDay.get(marking.day)}
          onClose={() => setMarking(null)}
          onSaved={() => { setMarking(null); reloadMarks(); }}
        />
      )}
    </div>
  );
}

/**
 * Set, change or withdraw what one day counts as.
 *
 * Deliberately not an approval flow: the person holding this grant IS the decision, and routing it through a
 * queue would only mean somebody approving their own request. What it does instead is make the decision
 * legible - the day's actual punches stay on screen beside the choice, the reason travels with it onto the
 * record, and the employee is told (the server notifies them).
 */
function DayMarkDialog({ row, employeeId, existing, onClose, onSaved }: {
  row: AttendanceRow;
  employeeId: string;
  existing?: AttendanceDayMark;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState({ credit: (existing?.credit as DayCredit) ?? "full", reason: existing?.reason ?? "" });
  const [withdrawing, setWithdrawing] = useState(false);

  async function withdraw() {
    if (!existing) return;
    setWithdrawing(true);
    try {
      await remove(existing.path, existing.etag);
      toast({ title: "Mark removed", description: "The day goes back to being judged on its punches.", variant: "success" });
      onSaved();
    } catch (e) {
      toast({ title: "Couldn't remove the mark", description: (e as Error).message, variant: "destructive" });
    } finally {
      setWithdrawing(false);
    }
  }

  const worked = row.summary?.workedMinutes ?? 0;
  return (
    <WriteDialog
      open
      onClose={onClose}
      title={`What does ${fmtDayLong(row.day)} count as?`}
      // The punches, restated in the dialog: this decision overrides them, so the thing being overridden
      // belongs on screen while it is made rather than behind the dialog.
      description={
        row.summary
          ? `${fmtDuration(worked)} clocked · ${STATUS_UI[row.status].label.toLowerCase()}. Pay is settled on what you choose here instead, and the employee is told.`
          : "No punches recorded. Pay is settled on what you choose here instead, and the employee is told."
      }
      collection="attendance-day-marks"
      objectPath={existing?.path}
      form={form}
      submitLabel={existing ? "Save" : "Mark day"}
      onSubmit={async () => {
        if (existing) await patch(existing.path, { credit: form.credit, reason: form.reason.trim() || null }, existing.etag);
        else await create("attendance-day-marks", { employee: `employees/${employeeId}`, date: row.day, credit: form.credit, reason: form.reason.trim() || undefined });
        toast({ title: `${fmtDay(row.day)} counts as ${CREDIT_LABEL[form.credit].toLowerCase()}`, variant: "success" });
      }}
      onSaved={onSaved}
      footerStart={existing ? (
        <Button variant="ghost" className="text-destructive hover:text-destructive" loading={withdrawing} onClick={withdraw}>
          Remove mark
        </Button>
      ) : undefined}
    >
      <Field label="Counts as">
        {/* Three buttons rather than a select: there are exactly three answers, and every one of them changes
            somebody's pay - worth seeing all of them at once before picking. */}
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Counts as">
          {(["full", "half", "absent"] as const).map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={form.credit === c}
              onClick={() => setForm((f) => ({ ...f, credit: c }))}
              className={cn(
                "rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors coarse:min-h-11",
                form.credit === c ? "border-primary bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted",
              )}
            >
              {CREDIT_LABEL[c]}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Reason" hint="Travels with the decision onto the record, and is shown to the employee.">
        <Textarea value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} rows={3} placeholder="Agreed half day for a clinic appointment" />
      </Field>
    </WriteDialog>
  );
}

// A year of days as a heatmap, beside a window that only ever shows a month: the long stretches, the gaps and
// whether the late mornings cluster are questions a month cannot answer.
//
// It is CLOSED until asked for. The year comes from the people-analytics series (one request, one aggregate,
// scoped server-side to what the caller may read), and an unopened panel costs nothing.
function YearHeatmap({ employeeId, tz, onPickDay, inWindow }: {
  employeeId: string;
  tz: string;
  /** Open a day the window below already holds. A year of squares reaches back past it - see the press handler. */
  onPickDay: (day: string) => void;
  inWindow: (day: string) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<AttendanceSeriesDay[] | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [stale, setStale] = useState<string | null>(null); // a day pressed that the window below does not hold

  const today = localDay(new Date().toISOString(), tz);
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 364 * 86_400_000).toISOString().slice(0, 10);

  // A different person is a different year, so an already-loaded one is dropped rather than redrawn under the
  // new name - the panel stays open and re-reads.
  useEffect(() => { setDays(null); setState("idle"); setStale(null); }, [employeeId]);

  useEffect(() => {
    if (!open || days || state === "loading") return;
    setState("loading");
    get<{ series?: AttendanceSeriesDay[] }>(`people-analytics?employee=employees/${employeeId}&from=${from}&to=${today}&series=true`)
      .then((r) => { setDays(r.series ?? []); setState("idle"); })
      .catch(() => setState("error"));
  }, [open, days, state, employeeId, from, today]);

  const points = useMemo(() => heatmapDays(new Map((days ?? []).map((d) => [d.day, Math.round((d.worked_minutes / 60) * 10) / 10]))), [days]);
  const lateDays = (days ?? []).filter((d) => d.late).length;

  return (
    <Card>
      <CardContent className="p-4 sm:p-4">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-h-[36px] w-full items-center justify-between gap-2 text-left coarse:min-h-[44px]"
        >
          <span className="text-sm font-medium">The last year</span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {open ? "Hide" : "Show"} <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
          </span>
        </button>
        {open && (
          <div className="mt-3">
            {state === "loading" && !days && <Skeleton className="h-32 w-full rounded-lg" />}
            {state === "error" && <p className="text-sm text-muted-foreground">Couldn't load the year just now.</p>}
            {days && (
              <>
                <Chart
                  type="heatmap"
                  height={180}
                  points={points}
                  start={new Date(`${from}T00:00:00Z`)}
                  end={new Date(`${today}T00:00:00Z`)}
                  countLabel="hours"
                  format={(v) => `${v}h`}
                  ariaLabel="Hours worked on each day of the last year"
                  emptyText="No punches in the last year."
                  // A square outside the window the page is currently showing has nothing to open - the day's
                  // punches are not loaded, and silently paging the history back a year under the reader is a
                  // worse answer than doing nothing. So the press is offered only where it can be honoured.
                  onSelectDay={(ymd) => { if (inWindow(ymd)) { onPickDay(ymd); setStale(null); } else setStale(ymd); }}
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  {days.length} day{days.length === 1 ? "" : "s"} with punches · {lateDays} late arrival{lateDays === 1 ? "" : "s"} · darker is a longer day
                </p>
                {stale && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {fmtDayLong(stale)} is outside the window above - step the history back to open it.
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function HoursTrend({ rows, full, stats, prev, prevLabel, comparing, onToggleCompare, selectedDay, onPickDay }: {
  rows: AttendanceRow[];
  full: number;
  stats: WindowStats;
  prev: WindowStats | null;
  prevLabel: string;
  comparing: boolean;
  onToggleCompare: () => void;
  /** The day the page has open, so the bar for it stays lit while the rest are dimmed. */
  selectedDay: string | null;
  onPickDay: (day: string) => void;
}) {
  const days = [...rows].reverse(); // rows are newest-first; a time axis runs the other way
  const balance = stats.doneMinutes - stats.expectedMinutes;
  const deltaPts = prev && stats.onTimePct !== null && prev.onTimePct !== null ? stats.onTimePct - prev.onTimePct : null;
  return (
    <Card>
      <CardContent className="space-y-3 p-4 sm:p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
            <span className="font-medium">Daily hours</span>
            <span className="text-xs text-muted-foreground">
              <span className="font-semibold tabular-nums text-foreground">{fmtDuration(stats.doneMinutes)}</span> worked vs {fmtDurationShort(stats.expectedMinutes)} expected ·{" "}
              <span className={cn("font-semibold tabular-nums", balance >= 0 ? "text-success" : "text-destructive")}>{signedDuration(balance)}</span>
            </span>
          </div>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground" onClick={onToggleCompare} aria-pressed={comparing}>
            <TrendingUp className="h-3.5 w-3.5" /> {comparing ? "Hide comparison" : `Compare with ${prevLabel}`}
          </Button>
        </div>

        {/* Hours per day against the full-day line. A real axis and a tooltip rather than the hand-drawn
            strip this used to be: the marker says what a full day is without a caption explaining a dash,
            and hovering a day names it instead of relying on a <title> nobody finds on a phone. */}
        <Chart
          type="bar"
          height={150}
          labels={days.map((d) => fmtDay(d.day))}
          datasets={[{ name: "Worked", values: days.map((d) => Math.round(((d.summary?.workedMinutes ?? 0) / 60) * 100) / 100) }]}
          markers={[{ label: `Full day (${fmtDurationShort(full)})`, value: Math.round((full / 60) * 100) / 100 }]}
          format={(v) => fmtDuration(Math.round(v * 60))}
          ariaLabel={`Hours worked on each of ${days.length} days in this window`}
          // A bar is one day, and the page already has a place to put a day: pressing one opens that day's
          // detail, the same thing pressing its cell in the month grid does.
          onSelect={(i) => { const d = days[i]; if (d) onPickDay(d.day); }}
          selected={selectedDay && days.findIndex((d) => d.day === selectedDay) >= 0 ? days.findIndex((d) => d.day === selectedDay) : null}
        />

        {comparing && (
          <p className="border-t pt-2 text-xs text-muted-foreground">
            {prev === null ? (
              `Loading ${prevLabel}…`
            ) : (
              <>
                vs {prevLabel}:{" "}
                <Delta label="hours" value={stats.minutes - prev.minutes} format={(v) => fmtDurationShort(Math.abs(v))} />{" · "}
                {deltaPts !== null && <><Delta label="on time" value={deltaPts} format={(v) => `${Math.abs(v)} pts`} />{" · "}</>}
                <Delta label="late" value={stats.late - prev.late} format={(v) => String(Math.abs(v))} lowerIsBetter />{" · "}
                <Delta label="absent" value={stats.absent - prev.absent} format={(v) => String(Math.abs(v))} lowerIsBetter />
              </>
            )}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// One "▲ 3h 10m more hours" style delta. Direction is stated in words as well as the arrow, so the sign is
// never carried by colour alone.
function Delta({ label, value, format, lowerIsBetter }: { label: string; value: number; format: (v: number) => string; lowerIsBetter?: boolean }) {
  if (value === 0) return <span>{label} unchanged</span>;
  const good = lowerIsBetter ? value < 0 : value > 0;
  return (
    <span className={good ? "text-success" : "text-destructive"}>
      {value > 0 ? "▲" : "▼"} {format(value)} {value > 0 ? "more" : "fewer"} {label}
    </span>
  );
}

// The month grid: one cell per day, tinted by that day's status, with its hours. Clicking opens the day; the
// checkbox in the corner ticks it for a bulk correction, and is absent for a reader who cannot file one.
// Days with no record are inert.
function MonthGrid({ monthYmd, rowByDay, orgToday, workDays, weekStart, selected, picked, onSelect, onTick }: {
  monthYmd: string;
  rowByDay: Map<string, AttendanceRow>;
  orgToday: string;
  workDays: number[];
  weekStart: number;
  selected: string | null;
  picked: Set<string>;
  onSelect: (day: string) => void;
  onTick?: (day: string) => void;
}) {
  const month = monthYmd.slice(0, 7);
  const cells = monthGridDays(monthYmd, weekStart);
  // Only the statuses actually on screen make the legend, so it stays short.
  const shown = Array.from(new Set(cells.map((d) => rowByDay.get(d)?.status).filter((s): s is DayStatus => !!s)));
  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-xl border">
        <div className="grid grid-cols-7 border-b bg-muted/30 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {weekdayOrder(weekStart).map((wd) => (
            <div key={wd} className={cn("py-2", !workDays.includes(wd) && "text-muted-foreground/60")}>
              <span className="sm:hidden">{DOW[wd][0]}</span>
              <span className="hidden sm:inline">{DOW[wd]}</span>
            </div>
          ))}
        </div>
        {/* Named, so the day buttons are one findable set: the page's KPI tiles are buttons with a "·" in
            their names too ("On time … in 9:02 AM · out 6:10 PM"). */}
        <div className="grid grid-cols-7" role="group" aria-label="Days of the month">
          {cells.map((day, i) => {
            const inMonth = day.slice(0, 7) === month;
            const r = inMonth ? rowByDay.get(day) : undefined;
            const ui = r ? STATUS_UI[r.status] : undefined;
            const isToday = day === orgToday;
            const isSel = selected === day;
            const isPicked = picked.has(day);
            const shell = cn(
              "relative min-h-[58px] border-b border-r p-1 text-left align-top transition-colors sm:min-h-[76px] sm:p-1.5",
              i % 7 === 6 && "border-r-0",
              i >= 35 && "border-b-0",
              !inMonth ? "bg-muted/20 text-muted-foreground/40" : ui?.cell,
              isSel && "ring-2 ring-inset ring-primary",
              isPicked && "ring-2 ring-inset ring-foreground/40",
            );
            const body = (
              <>
                <div className="flex items-center justify-between gap-1">
                  <span className={cn("flex h-5 w-5 items-center justify-center rounded-full text-xs tabular-nums sm:h-6 sm:w-6 sm:text-sm", isToday && "bg-primary font-semibold text-primary-foreground")}>
                    {Number(day.slice(8))}
                  </span>
                  {ui && <span className={cn("h-2 w-2 shrink-0 rounded-full", ui.dot)} aria-hidden />}
                </div>
                {r && <p className="mt-1 truncate text-[11px] font-medium tabular-nums text-foreground/80">{r.summary ? fmtDurationShort(r.summary.workedMinutes) : ui!.label}</p>}
                {/* A marked day has to be findable while SCANNING the month, not only after opening one:
                    otherwise the person who made the decisions cannot see which days carry them. The cell is
                    too small for the badge, so it gets the word and the tint the badge would have had. */}
                {r?.mark && (
                  <p className={cn(
                    "truncate text-[10px] font-semibold uppercase tracking-wide",
                    r.mark === "absent" ? "text-destructive" : r.mark === "half" ? "text-warning" : "text-success",
                  )}>
                    {CREDIT_LABEL[r.mark]}
                  </p>
                )}
              </>
            );
            if (!r) return <div key={day} className={shell}>{body}</div>;
            return (
              <div key={day} className={cn(shell, "group")}>
                <button
                  type="button"
                  onClick={() => onSelect(day)}
                  className="absolute inset-0 hover:bg-accent/40"
                  // The mark is in the name too: a screen reader scanning the grid gets the same fact the
                  // colour gives everybody else.
                  aria-label={`${fmtDayLong(day)} · ${ui!.label}${r.mark ? ` · counted as ${CREDIT_LABEL[r.mark].toLowerCase()}` : ""}`}
                  aria-pressed={isSel}
                />
                <div className="pointer-events-none relative">{body}</div>
                {onTick && (
                  <button
                    type="button"
                    onClick={() => onTick(day)}
                    aria-label={`${isPicked ? "Untick" : "Tick"} ${fmtDayLong(day)} for a bulk correction`}
                    aria-pressed={isPicked}
                    className={cn(
                      "absolute bottom-1 right-1 flex h-4 w-4 items-center justify-center rounded border bg-card transition-opacity",
                      isPicked ? "border-foreground/50 opacity-100" : "opacity-0 focus:opacity-100 group-hover:opacity-100",
                    )}
                  >
                    {isPicked && <Check className="h-3 w-3" />}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {shown.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
          {shown.map((s) => (
            <span key={s} className="flex items-center gap-1.5">
              <span className={cn("h-2.5 w-2.5 rounded-full", STATUS_UI[s].dot)} aria-hidden /> {STATUS_UI[s].label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// The history list on a phone: the same week grouping as the table, each day a tappable card (a table would
// force a horizontal scroll for the one column that matters).
function DayCards({ weeks, orgToday, tz, expanded, onToggle, detail }: {
  weeks: WeekGroup[];
  orgToday: string;
  tz: string;
  expanded: Set<string>;
  onToggle: (day: string) => void;
  detail: (row: AttendanceRow) => React.ComponentProps<typeof DayDetail>;
}) {
  return (
    <div className="space-y-4">
      {weeks.map((w) => (
        <div key={w.start} className="space-y-1.5">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="font-medium uppercase tracking-wide text-muted-foreground">Week of {fmtDay(w.start)}</span>
            <span className="tabular-nums text-muted-foreground">{w.days} {w.days === 1 ? "day" : "days"} · <span className="font-semibold text-foreground">{fmtDuration(w.minutes)}</span></span>
          </div>
          {w.rows.map((r) => {
            const d = r.summary;
            const isOpen = expanded.has(r.day);
            return (
              <div key={r.day} className={cn("rounded-lg border", isOpen && "bg-muted/30")}>
                <button type="button" onClick={() => onToggle(r.day)} className="flex w-full items-center gap-2 p-2.5 text-left" aria-expanded={isOpen}>
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", STATUS_UI[r.status].dot)} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      {fmtDay(r.day)}
                      {r.day === orgToday && <span className="text-xs font-normal text-primary">Today</span>}
                    </span>
                    <span className="block text-xs tabular-nums text-muted-foreground">
                      {d ? <>{d.arrival ? fmtHM(d.arrival, tz) : "-"} – {d.departure ? fmtHM(d.departure, tz) : d.open ? "open" : "-"} · {fmtDuration(d.workedMinutes)}</> : STATUS_UI[r.status].label}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-0.5">
                    <StatusPill status={r.status} lateBy={d?.lateByMin} earlyBy={d?.earlyByMin} />
                    <ApprovedBadge summary={d} />
                    {r.mark && <MarkBadge credit={r.mark} />}
                  </span>
                  <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} aria-hidden />
                </button>
                {isOpen && <div className="border-t p-2.5"><DayDetail {...detail(r)} /></div>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/**
 * What HR decided a day counts as, shown BESIDE the status the punches earned rather than instead of it. The
 * two together are the whole answer to "why was I paid for this day like that", which is the only question
 * anybody opens a marked day to ask.
 */
function MarkBadge({ credit }: { credit: DayCredit }) {
  return (
    <Badge variant={credit === "absent" ? "destructive" : credit === "half" ? "warning" : "success"}>
      Counted as {CREDIT_LABEL[credit].toLowerCase()}
    </Badge>
  );
}

/** The approved window a day was judged against, as words: "In by 10:30 approved", "Out at 16:00 approved". */
function approvedLabel(s?: { approvedLateUntil?: number; approvedEarlyFrom?: number }): string | undefined {
  const parts = [
    s?.approvedLateUntil != null ? `In by ${fmtMinOfDay(s.approvedLateUntil)}` : null,
    s?.approvedEarlyFrom != null ? `out at ${fmtMinOfDay(s.approvedEarlyFrom)}` : null,
  ].filter(Boolean) as string[];
  if (!parts.length) return undefined;
  const text = parts.join(", ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)} approved`;
}

/**
 * An approved late arrival or early departure, shown BESIDE the status the moved window earned rather than
 * instead of it - so "On time" on a day that started at 10:30 says why, and "Late 20m" on the same day says
 * from when.
 */
function ApprovedBadge({ summary }: { summary?: { approvedLateUntil?: number; approvedEarlyFrom?: number } }) {
  const label = approvedLabel(summary);
  return label ? <Badge variant="info">{label}</Badge> : null;
}

export function StatusPill({ status, lateBy, earlyBy }: { status: DayStatus; lateBy?: number; earlyBy?: number }) {
  const ui = STATUS_UI[status];
  const label =
    status === "late" ? `Late ${lateBy}m`
    : status === "left_early" ? `Left early ${earlyBy}m`
    : status === "late_early" ? `Late ${lateBy}m · early ${earlyBy}m`
    : ui.label;
  return <Badge variant={ui.badge}>{label}</Badge>;
}

// One time in a day's punch log. Where the reader may correct the day it is also the way to fix that one
// punch: a button that says which punch and which day, with a pencil that shows on hover and focus. Otherwise
// it is plain text, so nobody is shown a fix they could not file.
function PunchTime({ dot, time, fixLabel, onFix }: { dot: string; time: string; fixLabel: string; onFix?: () => void }) {
  const face = (
    <>
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} aria-hidden />
      {time}
    </>
  );
  if (!onFix) return <span className="flex w-[6.5rem] items-center gap-2 whitespace-nowrap">{face}</span>;
  return (
    <button
      type="button"
      onClick={onFix}
      aria-label={fixLabel}
      title={fixLabel}
      // Padded out so the whole cell is the target on touch, and pulled back by the same amount so the column
      // still lines up with the header above it.
      className="group/punch -mx-1.5 flex w-[7.25rem] items-center gap-2 whitespace-nowrap rounded px-1.5 py-1 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring coarse:min-h-9"
    >
      {face}
      <Pencil className="ml-auto h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/punch:opacity-100 group-focus-visible/punch:opacity-100 coarse:opacity-60" aria-hidden />
    </button>
  );
}

// The unfolded detail for a day: its punch log when there are clock-ins, otherwise why there are none
// (the leave taken + its reason, the holiday's name, or a plain absent note).
function DayDetail({ row, punches, now, tz, leave, leaveType, holiday, onCorrect, onFixPunch, onLogOvertime, overtimeMinutes = 0, onRequestLate, onRequestEarly }: {
  row: AttendanceRow;
  punches: AttendanceSession[];
  now: number;
  tz: string;
  leave?: LeaveRequest;
  leaveType?: LeaveType;
  holiday?: Holiday;
  onCorrect?: () => void;
  // Fix ONE clock-in or clock-out, from the time itself. Set exactly where `onCorrect` is.
  onFixPunch?: (punch: PunchTarget) => void;
  onLogOvertime?: () => void;
  overtimeMinutes?: number;
  onRequestLate?: () => void;
  onRequestEarly?: () => void;
}) {
  if (punches.length > 0) {
    // A session with no clock-out is running only on today. On any earlier day it is a missed punch-out, and
    // saying "Open" there reads as if the person were still at work.
    const isToday = row.day === localDay(new Date(now).toISOString(), tz);
    const day = formatDate(row.day);
    return (
      <div className="space-y-1.5">
        {/* `max-w-full` and a tighter phone gap: In + Out + Duration at gap-8 comes to 362px inside a 328px
            content column, and the box is `w-fit`, so it would size to the columns and push the page. A time
            column is 6.5rem so "12:45 PM" with its dot and fix pencil stays on one line. */}
        <div className="w-fit max-w-full rounded-lg border bg-background px-3 py-1 text-sm tabular-nums sm:px-4">
          <div className="flex items-center gap-3 border-b py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:gap-8">
            <span className="flex w-[6.5rem] items-center gap-2"><span className="h-1.5 w-1.5 shrink-0" aria-hidden />In</span>
            <span className="flex w-[6.5rem] items-center gap-2"><span className="h-1.5 w-1.5 shrink-0" aria-hidden />Out</span>
            <span className="w-16 text-right">Duration</span>
          </div>
          {punches.map((s, i) => {
            const mins = Math.max(0, Math.round(((s.clock_out ? +new Date(s.clock_out) : now) - +new Date(s.clock_in)) / 60000));
            // The gap since the previous punch-out is a break, shown between the rows it separates.
            const prev = punches[i - 1];
            const gap = prev?.clock_out ? Math.max(0, Math.round((+new Date(s.clock_in) - +new Date(prev.clock_out)) / 60000)) : 0;
            return (
              <Fragment key={i}>
                {gap > 0 && (
                  <div className="flex items-center gap-2 border-t py-1 text-[11px] text-muted-foreground">
                    <Coffee className="h-3 w-3" aria-hidden /> {fmtDurationShort(gap)} break
                  </div>
                )}
                <div className={cn("flex flex-wrap items-center gap-3 py-1.5 sm:gap-8", i > 0 && !gap && "border-t")}>
                  <PunchTime
                    dot="bg-success"
                    time={fmtHM(s.clock_in, tz)}
                    fixLabel={`Fix clock-in ${fmtHM(s.clock_in, tz)}, ${day}`}
                    onFix={onFixPunch && (() => onFixPunch({ index: i, edge: "in" }))}
                  />
                  {s.clock_out ? (
                    <PunchTime
                      dot="bg-muted-foreground/40"
                      time={fmtHM(s.clock_out, tz)}
                      fixLabel={`Fix clock-out ${fmtHM(s.clock_out, tz)}, ${day}`}
                      onFix={onFixPunch && (() => onFixPunch({ index: i, edge: "out" }))}
                    />
                  ) : isToday ? (
                    <span className="flex w-[6.5rem] items-center gap-1.5 text-xs font-medium text-success"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />Open</span>
                  ) : onFixPunch ? (
                    <button
                      type="button"
                      onClick={() => onFixPunch({ index: i, edge: "out" })}
                      className="-mx-1.5 flex min-w-[7.25rem] items-center gap-1.5 whitespace-nowrap rounded px-1.5 py-1 text-xs font-medium text-warning hover:bg-warning/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring coarse:min-h-9"
                      aria-label={`Add the missing clock-out, ${day}`}
                    >
                      <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden /> No clock-out · Add
                    </button>
                  ) : (
                    <span className="flex w-[6.5rem] items-center gap-1.5 whitespace-nowrap text-xs font-medium text-warning"><AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />No clock-out</span>
                  )}
                  <span className={cn("w-16 whitespace-nowrap text-right font-medium", s.clock_out ? "text-foreground" : "text-success")}>{fmtDuration(mins)}</span>
                  {s.source === "correction" && <Badge variant="muted">Corrected</Badge>}
                </div>
              </Fragment>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {onCorrect && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground" onClick={onCorrect}>
              <Pencil className="h-3 w-3" /> {onFixPunch ? "Edit the whole day" : "Wrong times? Request a correction"}
            </Button>
          )}
          {onFixPunch && <span className="text-xs text-muted-foreground">or pick a time to fix just that punch</span>}
          {onLogOvertime && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground" onClick={onLogOvertime}>
              <Zap className="h-3 w-3" /> Log {fmtDurationShort(overtimeMinutes)} past the shift as overtime
            </Button>
          )}
          {onRequestLate && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground" onClick={onRequestLate}>
              <AlarmClock className="h-3 w-3" /> Request a late arrival for this day
            </Button>
          )}
          {onRequestEarly && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground" onClick={onRequestEarly}>
              <Clock className="h-3 w-3" /> Request an early departure for this day
            </Button>
          )}
        </div>
      </div>
    );
  }

  if ((row.status === "on_leave" || row.status === "half_day_leave") && leave) {
    // For a multi-day leave that starts/ends on a half-day, only the boundary day is partial.
    const half =
      row.day === leave.start_date && leave.start_session === 2 ? "Second half (PM)"
      : row.day === leave.end_date && leave.end_session === 1 ? "First half (AM)"
      : leave.days % 1 !== 0 ? "Half day"
      : undefined;
    return (
      <div className="space-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          {leaveType?.color && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: leaveType.color }} aria-hidden />}
          <span className="font-medium">{leaveType?.display_name ?? "Leave"}</span>
          {leaveType && <Badge variant={leaveType.paid ? "secondary" : "muted"}>{leaveType.paid ? "Paid" : "Unpaid"}</Badge>}
          {half && <Badge variant="warning">{half}</Badge>}
        </div>
        <p className="text-xs tabular-nums text-muted-foreground">
          {leave.start_date === leave.end_date ? leave.start_date : `${leave.start_date} – ${leave.end_date}`} · {leave.days} day{leave.days === 1 ? "" : "s"}
        </p>
        {leave.reason ? (
          // The leave reason is masked in session replay wherever it renders (Leaves.tsx says why: it is
          // routinely a diagnosis or a bereavement, and `leave-requests: ["reason"]` is in REDACTED_FIELDS for
          // that reason). The label stays readable; only the value is hidden.
          <p className="text-muted-foreground"><span className="font-medium text-foreground">Reason:</span> <span data-sentry-mask>{leave.reason}</span></p>
        ) : (
          <p className="text-xs italic text-muted-foreground">No reason provided.</p>
        )}
      </div>
    );
  }

  if (row.status === "holiday") {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{holiday?.display_name ?? "Holiday"}</span>
        {holiday?.kind === "optional" && <Badge variant="muted">Optional</Badge>}
      </div>
    );
  }

  if (row.status === "absent") {
    // The one place a correction is most likely wanted, so the affordance is a visible button (not a hover pencil).
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <span>No punches recorded, and no approved leave or holiday on record for this day.</span>
        {onCorrect && <Button variant="outline" size="sm" onClick={onCorrect}><Pencil className="h-3 w-3" /> Request correction</Button>}
      </div>
    );
  }

  if (row.status === "untracked") {
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <span>Before HRMS records start for this person, so no punches were expected. Not counted as an absence.</span>
        {onCorrect && <Button variant="outline" size="sm" onClick={onCorrect}><Pencil className="h-3 w-3" /> Add times</Button>}
      </div>
    );
  }

  return <p className="text-sm text-muted-foreground">No punch detail for this day.</p>;
}

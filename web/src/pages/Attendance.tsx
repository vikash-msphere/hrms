import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clock, LogIn, LogOut, CircleDot, Pencil, ChevronLeft, ChevronRight, AlertTriangle, Plus, Trash2, CalendarDays, List, Coffee, Timer, CalendarCheck, AlarmClock, Users, Check, X, Zap, CheckSquare, TrendingUp } from "lucide-react";
import { create, get, invoke } from "@/api";
import { useCollection, useCollectionHasMore } from "@/hooks/useCollection";
import { useMedia } from "@/hooks/useMedia";
import { useApprovals } from "@/lib/approvals";
import { useClock, listAllSessions } from "@/lib/clock";
import { usePermission } from "@/lib/perm";
import { fireIntent, useIntent } from "@/lib/intent";
import { navigate } from "@/router";
import { exportTable } from "@/lib/exportTable";
import { cn, idOf, formatDate } from "@/lib/utils";
import { dateFormat } from "@/lib/intl";
import {
  summarizeByDay, buildAttendanceRows, fmtHM, fmtDuration, fmtDurationShort, fmtMinOfDay, localDay, localMinutes, zonedInstant,
  weekdayOf, weekStartOf, monthStartOf, monthEndOf, monthGridDays, weekdayOrder, addMonths, hhmmToMin, STATUS_UI,
  type DayStatus, type AttendanceRow, type AttendanceSchedule,
} from "@/lib/attendance";
import type { AttendanceSession, AttendanceRegularization, Department, Employee, Holiday, LeaveRequest, LeaveType, Me } from "@/types";
import { Chart } from "@/components/common/Chart";
import { heatmapPoints } from "@/lib/chartTheme";
import type { AttendanceSeriesDay } from "@/lib/analytics";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings } from "@/components/common/SettingsButton";
import { ExportButton } from "@/components/common/ExportButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/common/Field";
import { FormError } from "@/components/common/FormError";
import { useDiscardGuard } from "@/hooks/useDiscardGuard";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { useKpiFocus } from "@/lib/kpiFocus";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";
import { confirmDecision } from "@/lib/confirmDecision";

// Wall-clock "HH:MM" (24h) of an instant in the org timezone, for prefilling the correction modal's time inputs.
// `hourCycle: "h23"` because this fills an `<input type="time">`, which accepts 00-23 and rejects "24:15" - and
// `hour12: false` leaves the cycle to the locale, where h24 spells midnight that way.
const hhmm = (iso: string, tz: string) =>
  dateFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
// "Thu, Jun 12" for the history table's day column (the range caption above carries the year). One row per day
// of the range, so the formatter is shared rather than rebuilt per cell (see lib/intl.ts).
const DAY_OPTS: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };
const fmtDay = (ymd: string) => dateFormat(undefined, DAY_OPTS).format(new Date(`${ymd}T00:00:00`));
// "Thursday, 12 June" for the calendar's selected-day panel, which has room to spell it out.
const fmtDayLong = (ymd: string) => new Date(`${ymd}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
const monthLabel = (ymd: string) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_MS = 86400000;
const upper = (s?: string) => (s ?? "").toUpperCase();
const signed = (min: number) => `${min >= 0 ? "+" : "-"}${fmtDurationShort(Math.abs(min))}`;

// How the history is shown: a list of days (with weekly subtotals) or a month grid. Attendance is
// calendar-shaped, so the grid is the pattern view; the list is the detail view. Remembered per user.
type View = "list" | "calendar";
const viewKey = (email: string) => `hrms.attendance.view:${email}`;
const loadView = (email: string): View => {
  try { return localStorage.getItem(viewKey(email)) === "calendar" ? "calendar" : "list"; } catch { return "list"; }
};

// One week of the history list: its days plus the subtotal shown on the week's header row.
type WeekGroup = { start: string; rows: AttendanceRow[]; minutes: number; days: number };
// The half-day session flags ride along: a leave request can cover one session of its boundary day, and the
// grid has to see that or it calls a half-covered day "On leave" while payroll docks half of it. Shape (and
// the rule that reads it) comes from the server - see lib/attendance.ts.
type LeaveRange = { start: string; end: string; startSession?: number; endSession?: number };

// Everything the summary strip, the ledger and the period comparison read off a window of days.
type WindowStats = {
  worked: number; late: number; absent: number; minutes: number; workingDays: number;
  avgDay: number; onTimePct: number | null; avgIn: number | null; avgOut: number | null;
  // The ledger counts COMPLETED days only - today is still being worked, so counting it as a full expected
  // day would show a deficit all morning.
  doneMinutes: number; expectedMinutes: number;
};

function statsOf(rows: AttendanceRow[], tz: string, fullDayMinutes: number, todayYmd: string): WindowStats {
  let worked = 0, late = 0, absent = 0, minutes = 0, workingDays = 0, judged = 0, punctual = 0;
  let arrSum = 0, arrN = 0, depSum = 0, depN = 0, doneMinutes = 0, expectedDays = 0;
  for (const r of rows) {
    // A day nobody was rostered on is not a working day, whether it was worked or not: `worked_off_day` joins
    // holiday and on_leave here. Counted, it added a whole `full_day_minutes` of EXPECTATION for voluntary
    // work - so coming in on a Saturday moved the "done vs expected" bar backwards - and put that day's
    // arrival into the punctuality score for a shift window that did not apply to it. The minutes it earned
    // still count below; the day was simply not owed. (`workingDaysInRange` on the server skips it too.)
    const counts = r.status !== "holiday" && r.status !== "on_leave" && r.status !== "worked_off_day";
    if (counts) workingDays++;
    if (counts && r.day < todayYmd) expectedDays++;
    const s = r.summary;
    if (s) {
      worked++;
      minutes += s.workedMinutes;
      if (r.day < todayYmd) doneMinutes += s.workedMinutes;
      if (s.arrival) { arrSum += localMinutes(s.arrival, tz); arrN++; }
      if (s.departure) { depSum += localMinutes(s.departure, tz); depN++; }
      if (counts && !s.open) { judged++; if (!s.late) punctual++; } // a still-open day hasn't earned a verdict yet
    }
    if (r.status === "late" || r.status === "late_early") late++;
    else if (r.status === "absent") absent++;
  }
  return {
    worked, late, absent, minutes, workingDays,
    avgDay: worked ? Math.round(minutes / worked) : 0,
    onTimePct: judged ? Math.round((punctual / judged) * 100) : null,
    avgIn: arrN ? arrSum / arrN : null,
    avgOut: depN ? depSum / depN : null,
    doneMinutes,
    expectedMinutes: expectedDays * fullDayMinutes,
  };
}

export default function Attendance({ me }: { me: Me }) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const clock = useClock();
  const sched = clock.sched;
  const tz = sched.timezone;
  const [pageSessions, setPageSessions] = useState<AttendanceSession[]>([]); // sessions for the visible history window
  const [recentSessions, setRecentSessions] = useState<AttendanceSession[]>([]); // last couple of days, for "today"
  const [expanded, setExpanded] = useState<Set<string>>(new Set()); // history days whose punch detail is unfolded
  const [view, setView] = useState<View>(() => loadView(me.email));
  const [selectedDay, setSelectedDay] = useState<string | null>(null); // month grid: the day whose detail is open
  const [picked, setPicked] = useState<Set<string>>(new Set()); // month grid: days ticked for a bulk correction
  const [page, setPage] = useState(0); // 0 = the current window; each higher page steps one window further back
  const [pageLoading, setPageLoading] = useState(true); // history window fetch in flight (skeleton, not "no data")
  const [now, setNow] = useState(Date.now());
  const [correctionBusy, setCorrectionBusy] = useState(false); // a correction submit in flight
  const [correcting, setCorrecting] = useState<AttendanceRow[] | null>(null); // the day(s) a correction modal is open for
  const filedThisDialog = useRef<Set<string>>(new Set()); // days the open correction dialog already filed
  // Closing is the one moment the already-filed set stops being true, so every open starts clean.
  const closeCorrection = () => { filedThisDialog.current = new Set(); setCorrecting(null); };
  const [compare, setCompare] = useState(false); // opt-in: fetch the previous window to show deltas
  const [prevStats, setPrevStats] = useState<WindowStats | null>(null);
  const compactViewport = useMedia("(max-width: 639px)"); // phones get day cards; the day table needs a wide viewport
  // Org display switches (Settings → Attendance). Absent means shown, so an org that never touched them keeps
  // the bar; the projection is a sub-toggle of the bar it sits on.
  const showDayProgress = sched.show_day_progress !== false;
  const showFinishProjection = showDayProgress && sched.show_finish_projection !== false;
  const canApprove = me.capabilities.includes("attendance-regularizations.approve");
  const canExport = usePermission("export.read");
  const canLogOvertime = usePermission("overtime-requests.write");
  // `all: true` on the roster: this is the grid's list of PEOPLE, one row each, with no "load more" for a
  // reader to press - the shape `all` exists for. On one page, an org past a hundred simply had rows missing.
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  const { rows: departments } = useCollection<Department>("departments", { enabled: canApprove, all: true });
  const { rows: holidays } = useCollection<Holiday>("holidays", { all: true });
  const { rows: leaveTypes } = useCollection<LeaveType>("leave-types");
  const { rows: regularizations, reload: reloadRegs } = useCollection<AttendanceRegularization>("attendance-regularizations");
  const rosterTruncated = useCollectionHasMore(["employees", "leave-requests"]);

  // `useCallback`, because five memos and an effect on this page filter with it: as a bare arrow it changed
  // identity every render, so each of those either had to restate `me.employee_id` by hand or keep the copy it
  // was first given. Its identity now moves with the one field it reads.
  const mine = useCallback((ref?: string) => !!ref && idOf(ref) === me.employee_id, [me.employee_id]);
  // My correction requests (attendance-regularizations), newest first, so pending + decided are visible in one place.
  const myRegs = useMemo(
    () => regularizations.filter((r) => mine(r.employee)).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || (b.create_time ?? "").localeCompare(a.create_time ?? "")),
    [regularizations, mine],
  );
  // Days already waiting on a decision, so the correction dialog can say so before a second request is filed.
  const pendingCorrectionDays = useMemo(
    () => myRegs.filter((r) => upper(r.state) === "PENDING" && r.date).map((r) => r.date!),
    [myRegs],
  );
  async function cancelReg(r: AttendanceRegularization) {
    if (!(await confirmDecision(confirm, "cancel", `your correction for ${formatDate(r.date ?? "")}`))) return;
    try {
      await invoke(`attendance-regularizations/${idOf(r.path)}`, "cancel", r.etag);
      toast({ title: "Request cancelled", variant: "success" });
      reloadRegs();
    } catch (e) {
      toast({ title: "Couldn't cancel", description: (e as Error).message, variant: "destructive" });
    }
  }

  // "Today" in the org timezone, not UTC: punches are grouped by org-local day, so the history window,
  // today's totals and the Today marker must use the same calendar or early-morning punches vanish.
  const orgToday = localDay(new Date(now).toISOString(), tz);
  // The caller's join date: days before it aren't their attendance, so they're never flagged absent.
  const meEmployee = useMemo(() => employees.find((e) => idOf(e.path) === me.employee_id), [employees, me.employee_id]);
  const joinedYmd = meEmployee?.start_date;
  // The device's zone, when it differs from the org's: every time on this page is org-local, so say so once.
  const deviceTz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  // The visible window (YYYY-MM-DD). The list pages by 30 days from today; the grid pages by calendar month,
  // so the month it draws is exactly the month it fetched.
  const { fromYmd, toYmd } = useMemo(() => {
    if (view === "calendar") {
      const month = addMonths(monthStartOf(orgToday), -page);
      return { fromYmd: month, toYmd: monthEndOf(month) };
    }
    const toMs = Date.parse(orgToday + "T00:00:00Z") - page * 30 * DAY_MS;
    return { fromYmd: new Date(toMs - 29 * DAY_MS).toISOString().slice(0, 10), toYmd: new Date(toMs).toISOString().slice(0, 10) };
  }, [view, page, orgToday]);
  // The window immediately before this one, for the opt-in comparison.
  const prevWindow = useMemo(() => {
    if (view === "calendar") {
      const month = addMonths(fromYmd, -1);
      return { from: month, to: monthEndOf(month) };
    }
    const to = new Date(Date.parse(fromYmd + "T00:00:00Z") - DAY_MS);
    return { from: new Date(+to - 29 * DAY_MS).toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  }, [view, fromYmd]);
  const windowLabel = view === "calendar" ? monthLabel(fromYmd) : `${formatDate(fromYmd)} – ${formatDate(toYmd)}`;
  const prevLabel = view === "calendar" ? "last month" : "the previous 30 days";

  // Leave is fetched for the DAYS ON SCREEN, not as "the 100 most recently created requests in the org".
  //
  // This feed is what tells the grid which days are excused, and one page of it meant anybody whose approved
  // leave was older than that window arrived at `buildRows` with an empty range list - so their leave days
  // were classified `absent`, counted into their absence total by `statsOf`, and then sorted to the TOP of the
  // list, because the grid deliberately leads with the rows a manager has to act on. A person on holiday
  // presented as the one needing attention is worse than a missing row, and the truncation warning below does
  // not describe it. `leave-requests` takes `from`/`to` (services/dateWindow.ts) and the window is bounded by
  // what is being shown rather than by the org's whole history.
  //
  // The span covers everything that reads this feed: the visible window, the previous one (the opt-in
  // comparison), and today (the personal "today" row, which is outside the window when paging back).
  const leaveWindow = useMemo(() => {
    const lo = [prevWindow.from, fromYmd, orgToday].sort();
    const hi = [prevWindow.to, toYmd, orgToday].sort();
    return { from: lo[0]!, to: hi[hi.length - 1]! };
  }, [prevWindow.from, prevWindow.to, fromYmd, toYmd, orgToday]);
  const { rows: leaves } = useCollection<LeaveRequest>("leave-requests", { all: true, params: { from: leaveWindow.from, to: leaveWindow.to } });

  const toggleDay = useCallback((day: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(day) ? next.delete(day) : next.add(day);
      return next;
    });
  }, []);
  // Switching view re-bases the window (30 days vs a calendar month), so start again at the current one.
  const switchView = (v: View) => {
    setView(v);
    setPage(0);
    setSelectedDay(null);
    setPicked(new Set());
    try { localStorage.setItem(viewKey(me.email), v); } catch { /* private mode - the toggle just won't stick */ }
  };
  const goPage = (next: number) => { setPage(next); setSelectedDay(null); setPicked(new Set()); };

  // Shared inputs for building per-day rows (holidays + approved leave).
  const holidayByDay = useMemo(() => {
    const m = new Map<string, Holiday>();
    // A regional holiday for another location (`applies === false`) is a normal working day here.
    for (const h of holidays) if (!h.disabled && h.applies !== false) m.set(h.date, h);
    return m;
  }, [holidays]);
  const holidaySet = useMemo(() => new Set(holidayByDay.keys()), [holidayByDay]);
  const myApprovedLeaves = useMemo(() => leaves.filter((l) => mine(l.employee) && upper(l.state) === "APPROVED"), [leaves, mine]);
  const leaveRanges = useMemo<LeaveRange[]>(
    () => myApprovedLeaves.map((l) => ({ start: l.start_date, end: l.end_date, startSession: l.start_session, endSession: l.end_session })),
    [myApprovedLeaves],
  );
  // The approved leave covering a given day (for the expanded "why no punches" detail).
  const leaveForDay = useCallback((day: string) => myApprovedLeaves.find((l) => l.start_date <= day && day <= l.end_date), [myApprovedLeaves]);
  const leaveTypeName = useMemo(() => {
    const m = new Map(leaveTypes.map((t) => [idOf(t.path), t]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) : undefined);
  }, [leaveTypes]);

  // One way to turn a set of punches into per-day rows, reused for my window, the previous window and every
  // teammate's window (each with their own leave + join date).
  const buildRows = useCallback(
    (sessions: AttendanceSession[], opts: { from: string; to: string; leaves: LeaveRange[]; joined?: string }) =>
      buildAttendanceRows({
        fromYmd: opts.from, toYmd: opts.to, todayYmd: orgToday, sched,
        summaries: summarizeByDay(sessions, sched), holidays: holidaySet, leaveRanges: opts.leaves, joinedYmd: opts.joined,
      }),
    [orgToday, sched, holidaySet],
  );

  // Today's row (always today, independent of which history page the table shows) - built from a small recent
  // fetch so the My-clock punch log and the cumulative total stay put while you page through history.
  const todayRow = useMemo(
    () => buildRows(recentSessions.filter((s) => mine(s.employee)), { from: orgToday, to: orgToday, leaves: leaveRanges, joined: joinedYmd })[0],
    [recentSessions, buildRows, leaveRanges, joinedYmd, mine, orgToday],
  );

  // The history window: punches + holidays + my approved leave, with absent-day detection.
  const rows = useMemo(
    () => buildRows(pageSessions.filter((s) => mine(s.employee)), { from: fromYmd, to: toYmd, leaves: leaveRanges, joined: joinedYmd }),
    [pageSessions, buildRows, leaveRanges, fromYmd, toYmd, joinedYmd, mine],
  );
  const rowByDay = useMemo(() => new Map(rows.map((r) => [r.day, r])), [rows]);

  // Every figure in the strip above is a set of days, so clicking one narrows the history list to exactly those
  // days. The month grid has to stay whole to read as a calendar, so a metric click lands in the list view.
  const isLateRow = (r: AttendanceRow) => r.status === "late" || r.status === "late_early";
  const isShortRow = (r: AttendanceRow) =>
    !!r.summary && r.summary.workedMinutes > 0 && r.summary.workedMinutes < sched.full_day_minutes;
  const isLongRow = (r: AttendanceRow) => !!r.summary && r.summary.workedMinutes > sched.full_day_minutes + 30;
  // Punctuality is judged on CLOSED days only, the way the on-time percentage above is: a day still being
  // worked hasn't earned a verdict yet, so it belongs to neither side.
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
  // A metric click in the month view switches to the list, which is the shape that can show a filtered subset.
  const dayKpi = (key: DayFocus) => {
    const base = kf.kpi(key);
    return { ...base, onClick: () => { if (view !== "list") switchView("list"); base.onClick(); } };
  };
  const listRows = useMemo(() => kf.apply(rows), [rows, kf.focus]); // eslint-disable-line react-hooks/exhaustive-deps

  // The list groups days into weeks so a long window has rhythm and each week carries its own total.
  const weeks = useMemo(() => {
    const out: WeekGroup[] = [];
    for (const r of listRows) {
      const start = weekStartOf(r.day);
      let g = out[out.length - 1];
      if (!g || g.start !== start) { g = { start, rows: [], minutes: 0, days: 0 }; out.push(g); }
      g.rows.push(r);
      if (r.summary) { g.minutes += r.summary.workedMinutes; g.days++; }
    }
    return out;
  }, [listRows]);

  const stats = useMemo(() => statsOf(rows, tz, sched.full_day_minutes, orgToday), [rows, tz, sched.full_day_minutes, orgToday]);
  // Absent days in the visible window, surfaced above the table so a missed punch is one click from a fix.
  const absentRows = useMemo(() => rows.filter((r) => r.status === "absent"), [rows]);
  const shortDays = useMemo(() => rows.filter(isShortRow).length, [rows, sched.full_day_minutes]); // eslint-disable-line react-hooks/exhaustive-deps
  const longDays = useMemo(() => rows.filter(isLongRow).length, [rows, sched.full_day_minutes]); // eslint-disable-line react-hooks/exhaustive-deps

  const myOpen = clock.mine;
  const openMin = myOpen ? Math.max(0, Math.round((now - +new Date(myOpen.clock_in)) / 60000)) : 0;
  // workedMinutes counts only closed sessions, so add the current open session's elapsed minutes for a live total.
  const todayWorked = (todayRow?.summary?.workedMinutes ?? 0) + openMin;
  // Break time today = the gap inside the day's span that wasn't worked (clock out and back in makes a break).
  const todayPunches = todayRow?.summary?.sessions ?? [];
  const breakMin = useMemo(() => {
    const first = todayRow?.summary?.arrival;
    const end = myOpen ? now : todayRow?.summary?.departure ? +new Date(todayRow.summary.departure) : undefined;
    if (!first || end === undefined) return 0;
    return Math.max(0, Math.round((end - +new Date(first)) / 60000) - todayWorked);
  }, [todayRow, myOpen, now, todayWorked]);
  // An open session running past a plausible shift, or one left open since a previous day, is a forgotten
  // punch-out far more often than a real 14-hour day - and it silently inflates every total until it's fixed.
  const staleOpen = myOpen && (openMin > sched.full_day_minutes + 240 || localDay(myOpen.clock_in, tz) !== orgToday) ? myOpen : undefined;
  // Whether today even asks for a shift: a weekend, a holiday or approved leave means the progress bar is noise.
  const todayOff =
    holidayByDay.has(orgToday) ? holidayByDay.get(orgToday)!.display_name || "Company holiday"
    : leaveRanges.some((r) => r.start <= orgToday && orgToday <= r.end) ? "You're on approved leave today"
    : !sched.work_days.includes(weekdayOf(orgToday)) ? "Not a working day"
    : null;

  // Both loaders latch on a generation counter, and each resolves to whether it was still the current walk.
  // `listAllSessions` follows the server cursor with up to TEN sequential requests, so two windows in flight at
  // once is not a tight race - it is the ordinary shape of pressing "previous" twice. Without the latch the
  // slower walk won whenever it landed last, leaving `pageSessions` holding one window while `fromYmd`/`toYmd`
  // and everything derived from them described another, with the skeleton already taken down over it.
  //
  // A counter rather than the effect-local `let live` the comparison window below uses: these two are also
  // called directly (after a punch, and by the refresh button), where there is no cleanup to hang a flag on.
  const recentGen = useRef(0);
  const pageGen = useRef(0);
  // Recent punches (a couple of days) drive today's totals and the team's standing right now.
  const loadRecent = useCallback(async () => {
    const gen = ++recentGen.current;
    try {
      const sessions = await listAllSessions(`attendance?from=${encodeURIComponent(new Date(Date.now() - 2 * DAY_MS).toISOString())}`);
      if (gen !== recentGen.current) return false;
      setRecentSessions(sessions);
    } catch (e) {
      if (gen !== recentGen.current) return false;
      toast({ title: "Couldn't load attendance", description: (e as Error).message, variant: "destructive" });
    }
    return true;
  }, [toast]);
  // The history window's sessions (re-fetched when the window changes).
  const loadPage = useCallback(async () => {
    const gen = ++pageGen.current;
    try {
      const sessions = await listAllSessions(`attendance?from=${encodeURIComponent(`${fromYmd}T00:00:00.000Z`)}&to=${encodeURIComponent(`${toYmd}T23:59:59.999Z`)}`);
      if (gen !== pageGen.current) return false;
      setPageSessions(sessions);
    } catch (e) {
      if (gen !== pageGen.current) return false;
      setPageSessions([]);
      toast({ title: "Couldn't load attendance history", description: (e as Error).message, variant: "destructive" });
    }
    return true;
  }, [fromYmd, toYmd, toast]);

  useEffect(() => { void loadRecent(); }, [loadRecent]);
  // Skeleton only when the window changes; the silent refresh after a clock action goes through loadPage
  // directly. A superseded walk leaves the skeleton up - the walk that replaced it is the one that takes it
  // down, over its own data.
  useEffect(() => {
    setPageLoading(true);
    void loadPage().then((current) => { if (current) setPageLoading(false); });
  }, [loadPage]);
  // Everything on screen is minute-grained, so a 15s tick keeps the live figures honest without re-rendering
  // (and re-deriving the team's standing) once a second.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);
  // The grid opens on the day you're most likely to be looking for: today, else the newest day with a record.
  useEffect(() => {
    if (view !== "calendar" || pageLoading || selectedDay) return;
    setSelectedDay(rowByDay.has(orgToday) ? orgToday : rows[0]?.day ?? null);
  }, [view, pageLoading, selectedDay, rowByDay, rows, orgToday]);
  // The previous window is only ever fetched when the comparison is switched on (an extra read has to be asked for).
  useEffect(() => {
    if (!compare) { setPrevStats(null); return; }
    let live = true;
    void (async () => {
      try {
        const sessions = await listAllSessions(`attendance?from=${encodeURIComponent(`${prevWindow.from}T00:00:00.000Z`)}&to=${encodeURIComponent(`${prevWindow.to}T23:59:59.999Z`)}`);
        if (!live) return;
        const prevRows = buildRows(sessions.filter((s) => mine(s.employee)), { from: prevWindow.from, to: prevWindow.to, leaves: leaveRanges, joined: joinedYmd });
        setPrevStats(statsOf(prevRows, tz, sched.full_day_minutes, orgToday));
      } catch {
        if (live) setPrevStats(null);
      }
    })();
    return () => { live = false; };
  }, [compare, prevWindow, buildRows, leaveRanges, joinedYmd, tz, sched.full_day_minutes, orgToday, mine]);

  async function punch(verb: "clockIn" | "clockOut") {
    await clock.punch(verb);
    await Promise.all([loadRecent(), loadPage()]);
  }
  // ⌘K's "Clock in / clock out" lands here and punches whichever way matches the current state.
  useIntent("clock-toggle", () => { void punch(clock.mine ? "clockOut" : "clockIn"); });

  // A correction request is an attendance-regularization carrying the day's full intended in/out set. On
  // approval (manager/HR, via Approvals) the day's punches are superseded and these are written as the day's
  // sessions - no ticket, no manual data fixing. `pairs` are wall-clock "HH:MM"; [] means "remove all punches".
  // Several days at once file one regularization each, so every day stays independently approvable.
  // Files one regularization per day, each carrying that day's intended punches. Returns the failure message
  // (rather than toasting it) so the dialog can keep it beside the form the user still has to fix.
  async function submitCorrection(perDay: Record<string, { in: string; out: string }[]>, reason: string): Promise<string | undefined> {
    const days = Object.keys(perDay);
    setCorrectionBusy(true);
    const filed: string[] = [];
    let failure: string | undefined;
    for (const day of days) {
      // A retry after a partial failure must not re-file the days that already went through.
      if (filedThisDialog.current.has(day)) continue;
      // CLAIMED BEFORE THE AWAIT, released only if the write fails. Recording it afterwards made this ledger a
      // guard against a retry and not against a concurrent submit: two calls in flight both passed the
      // `has(day)` test above and both filed the same day.
      filedThisDialog.current.add(day);
      try {
        const sessions = perDay[day].map((p) => ({ clock_in: zonedInstant(day, p.in, tz), clock_out: zonedInstant(day, p.out, tz) }));
        await create("attendance-regularizations", { date: day, sessions, reason: reason || undefined });
        filed.push(day);
      } catch (e) {
        filedThisDialog.current.delete(day); // nothing was filed for this day, so it stays retryable
        // One rejected day (already corrected, outside the window, …) shouldn't silently swallow the rest -
        // stop and report exactly which days were filed.
        failure = `${formatDate(day)}: ${(e as Error).message}`;
        break;
      }
    }
    setCorrectionBusy(false);
    if (filed.length) {
      toast({
        title: filed.length === 1 ? "Correction requested" : `${filed.length} corrections requested`,
        description: "Your manager or HR will review it - track it below and under Approvals.",
        variant: "success",
      });
      reloadRegs();
      if (!failure) {
        closeCorrection();
        setPicked(new Set());
      }
    }
    const done = filedThisDialog.current.size;
    return failure && done ? `Filed ${done} of ${days.length}. ${failure}` : failure;
  }

  // Log the part of a long day that ran past the shift end as overtime, prefilled into the Overtime form -
  // the hours are already recorded here, so nobody should have to read them off and retype them.
  function logOvertime(row: AttendanceRow) {
    const end = row.summary?.departure;
    if (!end) return;
    navigate("overtime");
    fireIntent("new-overtime", {
      start_time: zonedInstant(row.day, sched.shift_end, tz),
      end_time: end,
      reason: `Worked past ${sched.shift_end} on ${row.day}`,
    });
  }

  function exportMine(format: "csv" | "xlsx") {
    const headers = ["Date", "Day", "Status", "First in", "Last out", "Worked", "Worked minutes", "Late by (min)", "Left early by (min)"];
    const data = [...rows].reverse().map((r) => {
      const s = r.summary;
      return [
        r.day,
        new Date(`${r.day}T00:00:00`).toLocaleDateString(undefined, { weekday: "long" }),
        STATUS_UI[r.status].label,
        s?.arrival ? fmtHM(s.arrival, tz) : "",
        s?.departure ? fmtHM(s.departure, tz) : "",
        s ? fmtDuration(s.workedMinutes) : "",
        s?.workedMinutes ?? 0,
        s?.lateByMin ?? 0,
        s?.earlyByMin ?? 0,
      ];
    });
    void exportTable(`attendance-${fromYmd}-to-${toYmd}`, headers, data, format, "attendance");
  }

  // Manager/HR: everyone's standing right now, from the sessions already fetched for the clock card (no extra
  // reads). People the caller can see but whose punches they can't read simply read as "not in yet".
  const roster = useMemo(
    () => employees.filter((e) => !e.delete_time && (!e.start_date || e.start_date.slice(0, 10) <= orgToday)),
    [employees, orgToday],
  );
  const approvedLeaveByEmp = useMemo(() => {
    const m = new Map<string, LeaveRange[]>();
    for (const l of leaves) {
      if (!l.employee || upper(l.state) !== "APPROVED") continue;
      const k = idOf(l.employee);
      const arr = m.get(k);
      const range = { start: l.start_date, end: l.end_date, startSession: l.start_session, endSession: l.end_session };
      if (arr) arr.push(range); else m.set(k, [range]);
    }
    return m;
  }, [leaves]);

  const team = useMemo(() => {
    if (!canApprove) return [];
    const openBy = new Map<string, AttendanceSession>();
    for (const s of clock.openSessions) if (s.employee) openBy.set(idOf(s.employee), s);
    const todayBy = new Map<string, AttendanceSession[]>();
    for (const s of recentSessions) {
      if (!s.employee || localDay(s.clock_in, tz) !== orgToday) continue;
      const k = idOf(s.employee);
      const arr = todayBy.get(k);
      if (arr) arr.push(s); else todayBy.set(k, [s]);
    }
    const lateAfter = hhmmToMin(sched.shift_start) + sched.grace_minutes;
    const nowMin = localMinutes(new Date(now).toISOString(), tz);
    const out: TeamEntry[] = [];
    for (const e of roster) {
      const id = idOf(e.path);
      const name = `${e.first_name} ${e.last_name}`;
      const dept = e.department ? idOf(e.department) : undefined;
      const open = openBy.get(id);
      const punches = todayBy.get(id) ?? [];
      const worked = punches.reduce((sum, s) => sum + (s.clock_out ? Math.max(0, Math.round((+new Date(s.clock_out) - +new Date(s.clock_in)) / 60000)) : 0), 0);
      const onLeave = (approvedLeaveByEmp.get(id) ?? []).some((r) => r.start <= orgToday && orgToday <= r.end);
      if (open) {
        out.push({ id, name, dept, photo: e.photo, group: "in", since: open.clock_in, worked: worked + Math.max(0, Math.round((now - +new Date(open.clock_in)) / 60000)) });
      } else if (punches.length) {
        const last = punches.reduce((a, b) => (+new Date(a.clock_out ?? a.clock_in) > +new Date(b.clock_out ?? b.clock_in) ? a : b));
        out.push({ id, name, dept, photo: e.photo, group: "done", out: last.clock_out ?? undefined, worked });
      } else if (onLeave) {
        out.push({ id, name, dept, photo: e.photo, group: "leave", worked: 0 });
      } else {
        out.push({ id, name, dept, photo: e.photo, group: "not_in", late: nowMin > lateAfter, worked: 0 });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [canApprove, roster, clock.openSessions, recentSessions, approvedLeaveByEmp, sched, tz, orgToday, now]);

  // Manager/HR: how the team did across the SAME window the history shows. Built from `pageSessions`, which is
  // already everyone's punches for that window - so the period view costs nothing beyond what's loaded.
  const teamPeriod = useMemo(() => {
    if (!canApprove) return [];
    const byEmp = new Map<string, AttendanceSession[]>();
    for (const s of pageSessions) {
      if (!s.employee) continue;
      const k = idOf(s.employee);
      const arr = byEmp.get(k);
      if (arr) arr.push(s); else byEmp.set(k, [s]);
    }
    return roster
      .map((e) => {
        const id = idOf(e.path);
        const empRows = buildRows(byEmp.get(id) ?? [], { from: fromYmd, to: toYmd, leaves: approvedLeaveByEmp.get(id) ?? [], joined: e.start_date });
        return {
          id,
          name: `${e.first_name} ${e.last_name}`,
          dept: e.department ? idOf(e.department) : undefined,
          rows: empRows,
          stats: statsOf(empRows, tz, sched.full_day_minutes, orgToday),
        };
      })
      // Worst first: absences, then lateness - the rows a manager has to act on lead.
      .sort((a, b) => b.stats.absent - a.stats.absent || b.stats.late - a.stats.late || a.name.localeCompare(b.name));
  }, [canApprove, roster, pageSessions, buildRows, approvedLeaveByEmp, fromYmd, toYmd, tz, sched.full_day_minutes, orgToday]);

  const selectedRow = selectedDay ? rowByDay.get(selectedDay) : undefined;
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
    // A half-day-leave row is about the leave too - it is the half that WAS excused - so the detail panel gets
    // the same request to describe.
    leave: r.status === "on_leave" || r.status === "half_day_leave" ? leaveForDay(r.day) : undefined,
    leaveType: r.status === "on_leave" || r.status === "half_day_leave" ? leaveTypeName(leaveForDay(r.day)?.leave_type) : undefined,
    holiday: r.status === "holiday" ? holidayByDay.get(r.day) : undefined,
    onCorrect: () => setCorrecting([r]),
    // Offer the overtime hand-off only for a day that actually ran well past the shift (and only to callers
    // who may file one), so it stays a real signal rather than a button on every row.
    onLogOvertime: canLogOvertime && overtimeMinutes(r) >= 30 ? () => logOvertime(r) : undefined,
    overtimeMinutes: overtimeMinutes(r),
  });

  return (
    <div>
      <PageHeader
        title="Attendance"
        description={`Shift ${sched.shift_start}–${sched.shift_end} · ${sched.timezone}`}
        actions={<PageSettings me={me} host="attendance" />}
      />
      {/* Every time on this page is org-local; on a device in another zone that has to be said, not inferred. */}
      {deviceTz && deviceTz !== tz && (
        <p className="-mt-4 mb-6 text-xs text-muted-foreground">Times are shown in {tz} (the org's timezone). Your device is in {deviceTz}.</p>
      )}
      {/* The clock state is a live change with no visual anchor for a screen reader; announce it. */}
      <p aria-live="polite" className="sr-only">{myOpen ? `Clocked in for ${fmtDuration(openMin)}` : "Not clocked in"}</p>

      <div className="space-y-6">
        {/* Clock card: live status + clock button (records a session log), over today's progress toward a full day */}
        <Card className={cn("overflow-hidden border-l-4 transition-colors", myOpen ? "border-l-success" : "border-l-muted-foreground/20")}>
          <CardContent className="space-y-4 p-4 sm:p-5">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
              {/* Live status */}
              <div className="flex items-center gap-4">
                <div className={cn("flex h-14 w-14 shrink-0 items-center justify-center rounded-full", myOpen ? "bg-success/15 text-success" : "bg-muted text-muted-foreground")}>
                  {myOpen ? <CircleDot className="h-6 w-6 animate-pulse" /> : <Clock className="h-6 w-6" />}
                </div>
                <div className="min-w-0">
                  <p className={cn("text-xs font-semibold uppercase tracking-wide", myOpen ? "text-success" : "text-muted-foreground")}>
                    {myOpen ? "Clocked in" : "Not clocked in"}
                  </p>
                  <p className="text-3xl font-bold leading-tight tabular-nums">{fmtDuration(myOpen ? openMin : todayWorked)}</p>
                  <p className="text-xs text-muted-foreground">
                    {myOpen ? <>since {fmtHM(myOpen.clock_in, tz)} · {fmtDuration(todayWorked)} today</> : "worked today"}
                  </p>
                </div>
              </div>

              {/* Action */}
              <div className="flex flex-col gap-1.5 sm:items-end">
                {myOpen ? (
                  <AccessAction collection="attendance" verb="clockOut" label="Clock out">
                    <Button className="h-11 w-full px-6 text-base sm:w-auto" variant="destructive" loading={clock.busy} onClick={() => void punch("clockOut")}><LogOut className="h-4 w-4" /> Clock out</Button>
                  </AccessAction>
                ) : (
                  <AccessAction collection="attendance" verb="clockIn" label="Clock in">
                    <Button className="h-11 w-full px-6 text-base sm:w-auto" loading={clock.busy} onClick={() => void punch("clockIn")}><LogIn className="h-4 w-4" /> Clock in</Button>
                  </AccessAction>
                )}
                <p className="text-xs text-muted-foreground sm:text-right">Clock out and back in to record a break.</p>
              </div>
            </div>

            {/* A session left open too long is almost always a missed punch-out - say so before it poisons the totals. */}
            {staleOpen && (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
                <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden />
                <span className="min-w-0 flex-1">
                  You've been clocked in since {fmtHM(staleOpen.clock_in, tz)}
                  {localDay(staleOpen.clock_in, tz) !== orgToday && <> on {fmtDay(localDay(staleOpen.clock_in, tz))}</>} ({fmtDuration(openMin)}). Forgot to clock out?
                </span>
                <Button size="sm" variant="outline" className="h-7" loading={clock.busy} onClick={() => void punch("clockOut")}>Clock out now</Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2"
                  onClick={() => {
                    const day = localDay(staleOpen.clock_in, tz);
                    setCorrecting([rowByDay.get(day) ?? todayRow ?? { day, status: "absent" as DayStatus }]);
                  }}
                >
                  Fix the times
                </Button>
              </div>
            )}

            {/* Today against the schedule: how far through a full day, and when it lands at the current pace.
                Both are org-configurable (Settings → Attendance), so a workplace that doesn't want a
                countdown on screen can turn one or both off without losing the punch log or the totals. */}
            {!showDayProgress ? null : todayOff && todayWorked === 0 && !myOpen ? (
              <p className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">{todayOff} - no shift expected. Clocking in still records the time.</p>
            ) : (
              <DayProgress
                worked={todayWorked}
                full={sched.full_day_minutes}
                half={sched.half_day_minutes}
                shift={`${sched.shift_start}–${sched.shift_end}`}
                projection={
                  !showFinishProjection
                    ? undefined
                    : todayWorked >= sched.full_day_minutes
                      ? `Full day done${todayWorked > sched.full_day_minutes ? ` · ${fmtDurationShort(todayWorked - sched.full_day_minutes)} over` : ""}`
                      : myOpen
                        ? `Full day at ~${fmtHM(new Date(now + (sched.full_day_minutes - todayWorked) * 60000).toISOString(), tz)}`
                        : `${fmtDurationShort(sched.full_day_minutes - todayWorked)} to a full day`
                }
                breaks={todayPunches.length > 1 || breakMin > 0 ? { count: Math.max(0, todayPunches.length - 1), minutes: breakMin } : undefined}
              />
            )}
          </CardContent>
        </Card>

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
          />
        )}

        {/* A year at a glance. Folded away and fetched only when it is opened: a year of punches is a server
            aggregate (GET /v1/people-analytics with a series), and nobody should pay for it to look at
            this month. */}
        {!pageLoading && me.employee_id && <YearHeatmap employeeId={me.employee_id} tz={tz} />}

        {/* The visible window at a glance: days/hours, punctuality with average in-out, and what needs fixing.
            Every metric narrows the history below, so the strip rides directly on top of it - under the charts,
            which are only there to be read. */}
        {!pageLoading && rows.length > 0 && (
          <SummaryStrip
            className="mb-0"
            items={[
              { label: "Days worked", value: stats.worked, icon: CalendarCheck, hint: `of ${stats.workingDays} working`, ...dayKpi("worked") },
              { label: "Hours worked", value: fmtDuration(stats.minutes + (page === 0 ? openMin : 0)), icon: Clock, hint: stats.avgDay ? `avg ${fmtDurationShort(stats.avgDay)} a day` : "nothing logged yet", ...dayKpi("hours") },
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

        {/* Misses that need regularizing, pulled out of the history so they're impossible to overlook. */}
        {!pageLoading && absentRows.length > 0 && (
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
                      onClick={() => setCorrecting([r])}
                      className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-xs font-medium hover:border-foreground/30 hover:bg-muted"
                      title={`Request a correction for ${formatDate(r.day)}`}
                    >
                      <Pencil className="h-3 w-3 text-muted-foreground" aria-hidden /> {fmtDay(r.day)}
                    </button>
                  ))}
                  {absentRows.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setCorrecting(absentRows)}
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

        {/* My history: a week-grouped list of days, or the same days as a month grid (each day folds open to its punches) */}
        <Card>
          <CardHeader className="flex-col items-start gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <CardTitle className="text-base">My attendance</CardTitle>
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
            {/* Export + a prev/label/next pager + Today. The window label alone reserves 11rem, which with
                the export control is already past a phone's width - so the row wraps, and the label's own
                floor drops to something that still fits a line of its own on the narrowest screen. */}
            <div className="flex flex-wrap items-center gap-1.5">
              <ExportButton canExport={canExport} label={`Export ${rows.length} day${rows.length === 1 ? "" : "s"}`} onExport={exportMine} disabled={rows.length === 0} />
              <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => goPage(page + 1)} aria-label={view === "calendar" ? "Previous month" : "Older 30 days"}><ChevronLeft className="h-4 w-4" /></Button>
              <span className="min-w-[7rem] text-center text-xs tabular-nums text-muted-foreground sm:min-w-[11rem]">{windowLabel}</span>
              <Button variant="outline" size="icon" className="h-7 w-7" disabled={page === 0} onClick={() => goPage(Math.max(0, page - 1))} aria-label={view === "calendar" ? "Next month" : "Newer 30 days"}><ChevronRight className="h-4 w-4" /></Button>
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
                    {picked.size > 0 ? `${picked.size} day${picked.size === 1 ? "" : "s"} ticked` : "Click a day for its punches, or tick several to correct them together."}
                  </p>
                  {picked.size > 0 && (
                    <div className="flex items-center gap-1.5">
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setPicked(new Set())}>Clear</Button>
                      <Button size="sm" className="h-7" onClick={() => setCorrecting([...picked].sort().map((d) => rowByDay.get(d) ?? { day: d, status: "absent" as DayStatus }))}>
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
                  onTick={(d) => setPicked((prev) => {
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
                      </div>
                      <div className="flex items-center gap-2">
                        {selectedRow.summary && (
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {selectedRow.summary.arrival ? fmtHM(selectedRow.summary.arrival, tz) : "-"} – {selectedRow.summary.departure ? fmtHM(selectedRow.summary.departure, tz) : selectedRow.summary.open ? "open" : "-"} · {fmtDuration(selectedRow.summary.workedMinutes)}
                          </span>
                        )}
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => setCorrecting([selectedRow])}>
                          <Pencil className="h-3 w-3" /> Correct
                        </Button>
                      </div>
                    </div>
                    <DayDetail {...dayDetailProps(selectedRow)} />
                  </div>
                ) : (
                  <p className="py-2 text-center text-sm text-muted-foreground">Pick a day to see its punches.</p>
                )}
              </div>
            ) : rows.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{page === 0 ? "No attendance yet. Clock in above to record your first day." : "No attendance in this period."}</p>
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
                                <td className="py-1.5"><StatusPill status={r.status} lateBy={d?.lateByMin} earlyBy={d?.earlyByMin} /></td>
                                <td className="py-1.5 text-right">
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); setCorrecting([r]); }}
                                    className="text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                                    title={`Request a correction for ${formatDate(r.day)}`}
                                    aria-label={`Request a correction for ${formatDate(r.day)}`}
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </button>
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

        {/* My correction requests: the audit trail of what I've asked to fix + where each stands. */}
        {myRegs.length > 0 && (
          <Card>
            <CardHeader><CardTitle className="text-base">My correction requests</CardTitle></CardHeader>
            <CardContent className="divide-y">
              {myRegs.map((r) => {
                const times = r.sessions.length === 0 ? "Remove all punches" : r.sessions.map((s) => `${fmtHM(s.clock_in, tz)}–${fmtHM(s.clock_out, tz)}`).join(", ");
                return (
                  <div key={r.path} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{formatDate(r.date)}</p>
                      <p className="truncate text-xs text-muted-foreground">{times}{r.reason ? ` · ${r.reason}` : ""}</p>
                    </div>
                    <RegStatePill state={r.state} />
                    {upper(r.state) === "PENDING" && (r.access?.can ?? []).includes("cancel") && (
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive" onClick={() => cancelReg(r)}>Cancel</Button>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        )}

        {/* Approvers: corrections waiting on ME, decided right here (the same queue the Approvals inbox shows) */}
        <PendingCorrections tz={tz} employees={employees} onDecided={() => { void loadPage(); void loadRecent(); }} />

        {/* Manager/HR: where the team stands today, and how the visible window went */}
        {canApprove && (
          <TeamPanel
            today={team}
            period={teamPeriod}
            departments={departments}
            windowLabel={windowLabel}
            tz={tz}
            now={now}
            off={todayOff}
            fullDay={sched.full_day_minutes}
            canExport={canExport}
            truncated={rosterTruncated}
          />
        )}
      </div>

      {correcting && (
        <CorrectionDialog
          key={correcting.map((r) => r.day).join(",")}
          rows={correcting}
          tz={tz}
          sched={sched}
          pendingDays={pendingCorrectionDays}
          busy={correctionBusy}
          onClose={closeCorrection}
          onSubmit={submitCorrection}
        />
      )}
    </div>
  );
}

// Today measured against the schedule: a bar to the full-day mark (with the half-day threshold ticked), the
// projected finish time, and how much of the day's span went on breaks.
function DayProgress({ worked, full, half, shift, projection, breaks }: {
  worked: number;
  full: number;
  half: number;
  shift: string;
  projection?: string; // omitted when the org has turned the projected finish time off
  breaks?: { count: number; minutes: number };
}) {
  const done = worked >= full;
  const pct = full > 0 ? Math.min(100, (worked / full) * 100) : 0;
  const halfPct = full > 0 ? Math.min(100, (half / full) * 100) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs">
        <span className="text-muted-foreground">
          <span className="font-semibold tabular-nums text-foreground">{fmtDuration(worked)}</span> of {fmtDurationShort(full)} · shift {shift}
        </span>
        {projection && <span className={cn("font-medium tabular-nums", done ? "text-success" : "text-muted-foreground")}>{projection}</span>}
      </div>
      <div
        className="relative h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={full}
        aria-valuenow={Math.min(worked, full)}
        aria-label="Worked today, toward a full day"
      >
        <div className={cn("h-full rounded-full transition-[width] duration-500", done ? "bg-success" : "bg-primary")} style={{ width: `${pct}%` }} />
        {halfPct > 0 && halfPct < 100 && (
          <span className="absolute inset-y-0 w-px bg-card/80" style={{ left: `${halfPct}%` }} title={`Half day (${fmtDurationShort(half)})`} aria-hidden />
        )}
      </div>
      {breaks && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Coffee className="h-3.5 w-3.5" aria-hidden />
          {breaks.count > 0 ? `${breaks.count} ${breaks.count === 1 ? "break" : "breaks"} · ${fmtDurationShort(breaks.minutes)} away` : `${fmtDurationShort(breaks.minutes)} away from the clock`}
        </p>
      )}
    </div>
  );
}

// Hours per day across the window: one bar per recorded day against a full-day reference line, plus the
// running balance and (on request) the same window a period earlier. One measure, one hue - the day's STATUS
// is the calendar's job, so the bars stay a magnitude read and don't get repainted per state.
// The last twelve months of this person's attendance as a calendar: one cell per day, shaded by how long they
// worked, with the late days countable beside it. The window view above answers "what happened this month";
// this answers the questions a month cannot - when the long stretches were, where the gaps are, whether the
// late mornings cluster.
//
// It is CLOSED until asked for. The year comes from the people-analytics series (one request, one aggregate,
// the caller's own attendance access), and an unopened panel costs nothing.
function YearHeatmap({ employeeId, tz }: { employeeId: string; tz: string }) {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<AttendanceSeriesDay[] | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");

  const today = localDay(new Date().toISOString(), tz);
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 364 * 86_400_000).toISOString().slice(0, 10);

  useEffect(() => {
    if (!open || days || state === "loading") return;
    setState("loading");
    get<{ series?: AttendanceSeriesDay[] }>(`people-analytics?employee=employees/${employeeId}&from=${from}&to=${today}&series=true`)
      .then((r) => { setDays(r.series ?? []); setState("idle"); })
      .catch(() => setState("error"));
  }, [open, days, state, employeeId, from, today]);

  const points = useMemo(() => heatmapPoints(new Map((days ?? []).map((d) => [d.day, Math.round((d.worked_minutes / 60) * 10) / 10]))), [days]);
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
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  {days.length} day{days.length === 1 ? "" : "s"} with punches · {lateDays} late arrival{lateDays === 1 ? "" : "s"} · darker is a longer day
                </p>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function HoursTrend({ rows, full, stats, prev, prevLabel, comparing, onToggleCompare }: {
  rows: AttendanceRow[];
  full: number;
  stats: WindowStats;
  prev: WindowStats | null;
  prevLabel: string;
  comparing: boolean;
  onToggleCompare: () => void;
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
              <span className={cn("font-semibold tabular-nums", balance >= 0 ? "text-success" : "text-destructive")}>{signed(balance)}</span>
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

// The month grid: one cell per day, tinted by that day's status, with its hours. Clicking opens the day;
// the checkbox in the corner ticks it for a bulk correction. Days with no record are inert.
function MonthGrid({ monthYmd, rowByDay, orgToday, workDays, weekStart, selected, picked, onSelect, onTick }: {
  monthYmd: string;
  rowByDay: Map<string, AttendanceRow>;
  orgToday: string;
  workDays: number[];
  weekStart: number;
  selected: string | null;
  picked: Set<string>;
  onSelect: (day: string) => void;
  onTick: (day: string) => void;
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
        <div className="grid grid-cols-7">
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
              </>
            );
            if (!r) return <div key={day} className={shell}>{body}</div>;
            return (
              <div key={day} className={cn(shell, "group")}>
                <button type="button" onClick={() => onSelect(day)} className="absolute inset-0 hover:bg-accent/40" aria-label={`${fmtDayLong(day)} · ${ui!.label}`} aria-pressed={isSel} />
                <div className="pointer-events-none relative">{body}</div>
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
                  <StatusPill status={r.status} lateBy={d?.lateByMin} earlyBy={d?.earlyByMin} />
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

// CSV / Excel of whatever the caller is looking at. Same gate as the DataTable export (`export` capability),
// so who may take data out of the app is one policy, not a per-page decision.

// Corrections awaiting THIS caller's decision, from the shared approvals queue - decided here so a manager
// looking at attendance doesn't have to go to the inbox to unblock a day they're already looking at.
function PendingCorrections({ tz, employees, onDecided }: { tz: string; employees: Employee[]; onDecided: () => void }) {
  const { regularizations, reload } = useApprovals();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const nameOf = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`] as const));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Someone" : "Someone");
  }, [employees]);
  if (regularizations.length === 0) return null;

  async function decide(r: AttendanceRegularization, verb: "approve" | "reject") {
    // Approving rewrites that day's punches with the requested ones - a correction to the attendance record,
    // which payroll reads. Worth naming whose day is about to change.
    if (!(await confirmDecision(confirm, verb, `${nameOf(r.employee)}'s correction for ${formatDate(r.date ?? "")}`))) return;
    setBusy(r.path);
    try {
      await invoke(`attendance-regularizations/${idOf(r.path)}`, verb, r.etag);
      toast({ title: verb === "approve" ? "Correction approved" : "Correction rejected", variant: "success" });
      reload();
      onDecided();
    } catch (e) {
      toast({ title: "Couldn't record the decision", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="border-warning/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Pencil className="h-4 w-4 text-warning" /> Corrections awaiting you
          <Badge variant="warning">{regularizations.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="divide-y">
        {regularizations.map((r) => (
          <div key={r.path} className="flex flex-wrap items-center gap-3 py-2.5 first:pt-0 last:pb-0">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{nameOf(r.employee)} · {formatDate(r.date)}</p>
              <p className="truncate text-xs text-muted-foreground">
                {r.sessions.length === 0 ? "Remove all punches" : r.sessions.map((s) => `${fmtHM(s.clock_in, tz)}–${fmtHM(s.clock_out, tz)}`).join(", ")}
                {r.reason ? ` · ${r.reason}` : ""}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <AccessAction collection="attendance-regularizations" verb="approve" objectPath={r.path} can={r.access?.can} label="Approve">
                <Button size="sm" variant="success" className="h-7" loading={busy === r.path} onClick={() => decide(r, "approve")}><Check className="h-3.5 w-3.5" /> Approve</Button>
              </AccessAction>
              <AccessAction collection="attendance-regularizations" verb="reject" objectPath={r.path} can={r.access?.can} label="Reject">
                <Button size="sm" variant="outline" className="h-7" disabled={busy === r.path} onClick={() => decide(r, "reject")}><X className="h-3.5 w-3.5" /> Reject</Button>
              </AccessAction>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

type TeamGroup = "in" | "not_in" | "done" | "leave";
type TeamEntry = { id: string; name: string; dept?: string; photo?: string; group: TeamGroup; worked: number; late?: boolean; since?: string; out?: string };
type TeamPeriodRow = { id: string; name: string; dept?: string; rows: AttendanceRow[]; stats: WindowStats };
const TEAM_GROUPS: { key: TeamGroup; label: string; dot: string }[] = [
  { key: "in", label: "In now", dot: "bg-emerald-500" },
  { key: "not_in", label: "Not in yet", dot: "bg-amber-500" },
  { key: "done", label: "Wrapped up", dot: "bg-muted-foreground/50" },
  { key: "leave", label: "On leave", dot: "bg-teal-500" },
];

// Manager/HR view: today's standing (derived from data the clock card already fetched) and the same window
// the history shows, per person - the pre-payroll check that attendance actually supports what will be paid.
function TeamPanel({ today, period, departments, windowLabel, tz, now, off, fullDay, canExport, truncated }: {
  today: TeamEntry[];
  period: TeamPeriodRow[];
  departments: Department[];
  windowLabel: string;
  tz: string;
  now: number;
  off: string | null;
  fullDay: number;
  canExport: boolean;
  truncated: boolean;
}) {
  const [tab, setTab] = useState<"today" | "period">("today");
  const [dept, setDept] = useState("all");
  const [picked, setPicked] = useState<TeamGroup>("in");

  // `useCallback` so both row memos below name the filter they apply rather than the state it reads.
  const inDept = useCallback((d?: string) => dept === "all" || d === dept, [dept]);
  const todayRows = useMemo(() => today.filter((e) => inDept(e.dept)), [today, inDept]);
  const periodRows = useMemo(() => period.filter((e) => inDept(e.dept)), [period, inDept]);

  const counts = useMemo(() => {
    const c: Record<TeamGroup, number> = { in: 0, not_in: 0, done: 0, leave: 0 };
    for (const e of todayRows) c[e.group]++;
    return c;
  }, [todayRows]);
  // On a day off "not in yet" means nothing, so it isn't offered - nobody is expected.
  const groups = TEAM_GROUPS.filter((g) => !(off && g.key === "not_in"));
  const active = counts[picked] && groups.some((g) => g.key === picked) ? picked : groups.find((g) => counts[g.key])?.key ?? "in";
  const list = useMemo(() => {
    const rows = todayRows.filter((e) => e.group === active);
    if (active === "in") return [...rows].sort((a, b) => (a.since ?? "").localeCompare(b.since ?? ""));
    if (active === "done") return [...rows].sort((a, b) => (b.out ?? "").localeCompare(a.out ?? ""));
    return rows;
  }, [todayRows, active]);

  function exportPeriod(format: "csv" | "xlsx") {
    const headers = ["Employee", "Days worked", "Working days", "Absent", "Late", "On time %", "Hours worked", "Avg per day", "Balance vs expected"];
    const data = periodRows.map((r) => [
      r.name,
      r.stats.worked,
      r.stats.workingDays,
      r.stats.absent,
      r.stats.late,
      r.stats.onTimePct ?? "",
      fmtDuration(r.stats.minutes),
      r.stats.avgDay ? fmtDurationShort(r.stats.avgDay) : "",
      signed(r.stats.doneMinutes - r.stats.expectedMinutes),
    ]);
    void exportTable(`team-attendance-${windowLabel.replace(/\s+/g, "-").toLowerCase()}`, headers, data, format, "attendance");
  }

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="h-4 w-4 text-primary" /> Team attendance
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {departments.length > 0 && (
              <Select value={dept} onValueChange={setDept}>
                <SelectTrigger className="h-8 w-40 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All departments</SelectItem>
                  {departments.filter((d) => !d.delete_time).map((d) => <SelectItem key={d.path} value={idOf(d.path)}>{d.display_name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            {tab === "period" && <ExportButton canExport={canExport} label={`Export ${periodRows.length} people`} onExport={exportPeriod} disabled={periodRows.length === 0} />}
          </div>
        </div>
        <div className="inline-flex rounded-lg bg-muted p-0.5" role="group" aria-label="Team view">
          {([["today", "Today"], ["period", windowLabel]] as const).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              aria-pressed={tab === k}
              className={cn("rounded-md px-2.5 py-1 text-xs font-medium transition-colors", tab === k ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
            >
              {label}
            </button>
          ))}
        </div>
        {/* Both feeds complete themselves now (the roster with `all`, the leave with `all` over the window on
            screen), so this only fires at the reader cap - an org larger than the walk will follow. If either
            is still a window, the per-person figures below are too: say so rather than presenting a partial
            team as the whole one. */}
        {truncated && <p className="text-xs text-warning">This org is larger than the grid loads in one go, so some people or leave days may be missing.</p>}
        {tab === "today" && (
          <>
            {off && <p className="text-xs text-muted-foreground">{off} - nobody is expected to clock in.</p>}
            {/* One scrolling row on a phone; wraps from `sm` up. */}
            <div className="scroll-shadow-x no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
              {groups.map((g) => (
                <button
                  key={g.key}
                  type="button"
                  onClick={() => setPicked(g.key)}
                  aria-pressed={active === g.key}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium transition-colors coarse:min-h-9 coarse:px-3.5",
                    active === g.key ? "border-primary/40 bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  <span className={cn("h-2 w-2 rounded-full", g.dot)} aria-hidden />
                  {g.label} <span className="tabular-nums">{counts[g.key]}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </CardHeader>
      <CardContent>
        {tab === "today" ? (
          list.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {active === "in" ? "Nobody is clocked in." : active === "not_in" ? "Everyone has clocked in." : active === "done" ? "Nobody has wrapped up yet." : "Nobody is on leave today."}
            </p>
          ) : (
            <div className="max-h-80 divide-y overflow-y-auto">
              {list.map((e) => (
                <div key={e.id} className="flex items-center gap-2.5 py-2 first:pt-0">
                  <PhotoAvatar employeeId={e.id} name={e.name} photo={e.photo} className="h-7 w-7 text-[10px]" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{e.name}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {e.group === "in" && e.since && <>since {fmtHM(e.since, tz)} · {fmtDuration(Math.max(0, Math.round((now - +new Date(e.since)) / 60000)))}</>}
                    {e.group === "done" && <>{e.out ? `out ${fmtHM(e.out, tz)} · ` : ""}{fmtDuration(e.worked)}</>}
                    {e.group === "not_in" && (e.late ? <span className="font-medium text-warning">not clocked in</span> : "expected")}
                    {e.group === "leave" && "approved leave"}
                  </span>
                </div>
              ))}
            </div>
          )
        ) : periodRows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No one to show for this department.</p>
        ) : (
          <div className="max-h-[28rem] overflow-auto">
            {/* Six numeric columns per person: one labelled block each on a phone, the table from `sm` up. */}
            <table className="table-stack w-full text-sm">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Employee</th>
                  <th className="py-2 pr-3 text-right font-medium">Present</th>
                  <th className="py-2 pr-3 text-right font-medium">Absent</th>
                  <th className="py-2 pr-3 text-right font-medium">Late</th>
                  <th className="py-2 pr-3 text-right font-medium">Hours</th>
                  <th className="py-2 pr-3 text-right font-medium">Balance</th>
                  <th className="hidden py-2 font-medium lg:table-cell">Pattern</th>
                </tr>
              </thead>
              <tbody>
                {periodRows.map((r) => {
                  const balance = r.stats.doneMinutes - r.stats.expectedMinutes;
                  return (
                    <tr key={r.id} className="border-b last:border-0">
                      {/* Name only, no avatar: this table can run to the whole org, and one photo fetch per
                          row would be a large fan-out for a figure nobody identifies people by. */}
                      <td className="py-1.5 pr-3 font-medium">{r.name}</td>
                      <td data-label="Present" className="py-1.5 pr-3 text-right tabular-nums">{r.stats.worked}<span className="text-muted-foreground">/{r.stats.workingDays}</span></td>
                      <td data-label="Absent" className={cn("py-1.5 pr-3 text-right tabular-nums", r.stats.absent > 0 && "font-semibold text-destructive")}>{r.stats.absent}</td>
                      <td data-label="Late" className={cn("py-1.5 pr-3 text-right tabular-nums", r.stats.late > 0 && "font-semibold text-warning")}>{r.stats.late}</td>
                      <td data-label="Hours" className="py-1.5 pr-3 text-right tabular-nums">{fmtDuration(r.stats.minutes)}</td>
                      <td data-label="Balance" className={cn("py-1.5 pr-3 text-right tabular-nums", balance >= 0 ? "text-success" : "text-destructive")}>{signed(balance)}</td>
                      <td data-label="Pattern" className="hidden py-1.5 lg:table-cell">
                        {/* One dot per recorded day, oldest first: the shape of the month at a glance. */}
                        <span className="flex flex-wrap gap-0.5">
                          {[...r.rows].reverse().map((d) => (
                            <span key={d.day} className={cn("h-2 w-2 rounded-[2px]", STATUS_UI[d.status].dot)} title={`${fmtDay(d.day)} · ${d.summary ? fmtDuration(d.summary.workedMinutes) : STATUS_UI[d.status].label}`} />
                          ))}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StatusPill({ status, lateBy, earlyBy }: { status: DayStatus; lateBy?: number; earlyBy?: number }) {
  const ui = STATUS_UI[status];
  const label =
    status === "late" ? `Late ${lateBy}m`
    : status === "left_early" ? `Left early ${earlyBy}m`
    : status === "late_early" ? `Late ${lateBy}m · early ${earlyBy}m`
    : ui.label;
  return <Badge variant={ui.badge}>{label}</Badge>;
}

// State of one of my correction requests (attendance-regularization).
function RegStatePill({ state }: { state?: string }) {
  switch (upper(state)) {
    case "APPROVED": return <Badge variant="success">Approved</Badge>;
    case "REJECTED": return <Badge variant="destructive">Rejected</Badge>;
    case "CANCELLED": return <Badge variant="muted">Cancelled</Badge>;
    default: return <Badge variant="warning">Pending</Badge>;
  }
}

// The unfolded detail for a day: its punch log when there are clock-ins, otherwise why there are none
// (the leave taken + its reason, the holiday's name, or a plain absent note).
function DayDetail({ row, punches, now, tz, leave, leaveType, holiday, onCorrect, onLogOvertime, overtimeMinutes = 0 }: {
  row: AttendanceRow;
  punches: AttendanceSession[];
  now: number;
  tz: string;
  leave?: LeaveRequest;
  leaveType?: LeaveType;
  holiday?: Holiday;
  onCorrect?: () => void;
  onLogOvertime?: () => void;
  overtimeMinutes?: number;
}) {
  if (punches.length > 0) {
    return (
      <div className="space-y-1.5">
        {/* `max-w-full` and a tighter phone gap: In + Out + Duration at gap-8 comes to 352px inside a 328px
            content column, and the box is `w-fit`, so it would size to the columns and push the page. */}
        <div className="w-fit max-w-full rounded-lg border bg-background px-3 py-1 text-sm tabular-nums sm:px-4">
          <div className="flex items-center gap-4 border-b py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:gap-8">
            <span className="flex w-24 items-center gap-2"><span className="h-1.5 w-1.5 shrink-0" aria-hidden />In</span>
            <span className="flex w-24 items-center gap-2"><span className="h-1.5 w-1.5 shrink-0" aria-hidden />Out</span>
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
                <div className={cn("flex flex-wrap items-center gap-4 py-1.5 sm:gap-8", i > 0 && !gap && "border-t")}>
                  <span className="flex w-24 items-center gap-2">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" aria-hidden />
                    {fmtHM(s.clock_in, tz)}
                  </span>
                  <span className="flex w-24 items-center gap-2">
                    {s.clock_out ? (
                      <>
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40" aria-hidden />
                        {fmtHM(s.clock_out, tz)}
                      </>
                    ) : (
                      <span className="flex items-center gap-1.5 text-xs font-medium text-success"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />Open</span>
                    )}
                  </span>
                  <span className={cn("w-16 text-right font-medium", s.clock_out ? "text-foreground" : "text-success")}>{fmtDuration(mins)}</span>
                  {s.source === "correction" && <Badge variant="muted">Corrected</Badge>}
                </div>
              </Fragment>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {onCorrect && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground" onClick={onCorrect}>
              <Pencil className="h-3 w-3" /> Wrong times? Request a correction
            </Button>
          )}
          {onLogOvertime && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground" onClick={onLogOvertime}>
              <Zap className="h-3 w-3" /> Log {fmtDurationShort(overtimeMinutes)} past the shift as overtime
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
          <p className="text-muted-foreground"><span className="font-medium text-foreground">Reason:</span> {leave.reason}</p>
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

  return <p className="text-sm text-muted-foreground">No punch detail for this day.</p>;
}

type PunchRow = { in: string; out: string };

// Correction request modal: seeded with the day's existing sessions (one row per punch), each editable, with
// add/remove. Submitting files an attendance-regularization carrying the FULL intended day; on approval the
// day's punches are superseded and these become the day's sessions. Removing every row clears the day.
// Several days at once default to one shared set of times (the "I forgot to clock all week" case) and file one
// request each; per-day mode gives each selected day its own times, because a real week is rarely identical.

// Per-row error: a row must have both times, in order ("HH:MM" compares lexically). Fully-blank rows are dropped.
const punchError = (r: PunchRow): string | undefined => {
  if (!r.in && !r.out) return undefined;
  if (!r.in || !r.out) return "Both times are required";
  if (r.out <= r.in) return "Clock-out must be after clock-in";
  return undefined;
};
const keptPunches = (rows: PunchRow[]) => rows.filter((r) => r.in || r.out); // rows the user actually filled
const punchTotal = (rows: PunchRow[]) => keptPunches(rows).reduce((sum, r) => (punchError(r) ? sum : sum + (hhmmToMin(r.out) - hhmmToMin(r.in))), 0);

function CorrectionDialog({ rows, tz, sched, pendingDays, busy, onClose, onSubmit }: {
  rows: AttendanceRow[];
  tz: string;
  // The org work schedule, so the standard day can be filled in with one click instead of typed twice.
  sched: AttendanceSchedule;
  // Days that already carry a pending correction - filing a second one for the same day is almost never meant.
  pendingDays: string[];
  busy: boolean;
  onClose: () => void;
  // Resolves to a failure message when a day was rejected, so the dialog can pin it beside the form.
  onSubmit: (perDay: Record<string, PunchRow[]>, reason: string) => Promise<string | undefined>;
}) {
  const guardClose = useDiscardGuard();
  const single = rows.length === 1 ? rows[0] : undefined;
  const seeded = (single?.summary?.sessions ?? []).map((s) => ({ in: hhmm(s.clock_in, tz), out: s.clock_out ? hhmm(s.clock_out, tz) : "" }));
  const [punches, setPunches] = useState<PunchRow[]>(seeded.length ? seeded : [{ in: "", out: "" }]);
  // null = every selected day takes the shared times above; a record = each day carries its own.
  const [perDay, setPerDay] = useState<Record<string, PunchRow[]> | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  // What each targeted day would become - the single source both the summary and the submit read from.
  const targets: Record<string, PunchRow[]> = perDay ?? Object.fromEntries(rows.map((r) => [r.day, punches]));
  const kept = keptPunches(punches);
  const canSubmit = Object.values(targets).every((p) => !keptPunches(p).some((r) => punchError(r))); // an empty set clears the day
  const total = punchTotal(punches);
  // What the day currently says, so the request reads as "this, instead of that" rather than a bare set of times.
  const recorded = single?.summary?.workedMinutes ?? 0;
  const delta = Math.max(0, total) - recorded;
  const edited = JSON.stringify(kept) !== JSON.stringify(seeded);
  const dirty = edited || !!reason.trim() || !!perDay;
  const clashes = rows.map((r) => r.day).filter((d) => pendingDays.includes(d));
  // One-click fills for the two shapes almost every correction takes: the org's standard day, and no punches at all.
  const scheduledDay = () => [{ in: sched.shift_start, out: sched.shift_end }];
  const fillScheduled = () => setPunches(scheduledDay());
  const restore = () => setPunches(seeded.length ? seeded : [{ in: "", out: "" }]);
  // Switching to per-day seeds every day from the shared times, so it refines what's there instead of clearing it.
  const splitDays = () => setPerDay(Object.fromEntries(rows.map((r) => [r.day, punches.map((p) => ({ ...p }))])));
  const close = () => guardClose(dirty, onClose)(false);
  const submit = async () => {
    // `busy` as well as validity: Enter fires from any input in this dialog, and the dedupe ledger one file
    // over records a day only AFTER its write resolves - so two Enters in flight both passed its `has(day)`
    // test and both filed the same day, leaving duplicate correction requests to be approved or rejected
    // individually. The ledger stops a retry; this stops a concurrent one.
    if (!canSubmit || busy) return;
    setError(null);
    const failure = await onSubmit(
      Object.fromEntries(Object.entries(targets).map(([day, p]) => [day, keptPunches(p)])),
      reason.trim(),
    );
    if (failure) setError(failure);
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) close(); }}>
      <DialogContent onEnterSubmit={submit}>
        <DialogHeader>
          <DialogTitle>{single ? `Correct attendance — ${formatDate(single.day)}` : `Correct ${rows.length} days`}</DialogTitle>
          <DialogDescription>
            {single
              ? "Set the day's actual clock in/out times. Your manager or HR approves it, and the day is fixed. Remove every row to clear the day's punches."
              : perDay
                ? "Each day carries its own times, and files its own request so it can be approved on its own."
                : "These times are applied to every selected day, filing one request per day so each can be approved on its own."}
          </DialogDescription>
        </DialogHeader>
        {!single && !perDay && (
          <div className="flex flex-wrap items-center gap-1.5">
            {rows.map((r) => <Badge key={r.day} variant="muted">{fmtDay(r.day)}</Badge>)}
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={splitDays}>Different times per day</Button>
          </div>
        )}
        {clashes.length > 0 && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
            {clashes.length === 1 ? `${fmtDay(clashes[0])} already has a correction awaiting approval` : `${clashes.length} of these days already have corrections awaiting approval`}. Filing again queues a second request for the same day - cancel the pending one below instead if you meant to change it.
          </p>
        )}
        {perDay ? (
          // Per-day mode: one block per selected day, each with its own punches, total and scheduled-day fill.
          <div className="space-y-3">
            {rows.map((r) => {
              const dayPunches = perDay[r.day] ?? [{ in: "", out: "" }];
              const dayKept = keptPunches(dayPunches);
              const set = (next: PunchRow[]) => setPerDay({ ...perDay, [r.day]: next });
              return (
                <div key={r.day} className="space-y-2 rounded-lg border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium">{fmtDay(r.day)}</span>
                    <span className="flex flex-wrap items-center gap-1 text-xs tabular-nums text-muted-foreground">
                      {dayKept.length === 0 ? "Clears the day" : <>Totals <span className="font-semibold text-foreground">{fmtDuration(Math.max(0, punchTotal(dayPunches)))}</span></>}
                      <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => set(scheduledDay())}>Scheduled</Button>
                      <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => set([{ in: "", out: "" }])}>Clear</Button>
                    </span>
                  </div>
                  <PunchRows punches={dayPunches} onChange={set} labels={false} />
                </div>
              );
            })}
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setPerDay(null)}>Back to one set of times</Button>
          </div>
        ) : (
          <>
            {/* What the day says today, next to the shortcuts that build the usual replacement. */}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/20 px-3 py-2 text-xs">
              <span className="text-muted-foreground">
                {single
                  ? seeded.length
                    ? <>Recorded now: <span className="font-medium tabular-nums text-foreground">{seeded.map((s) => `${s.in}-${s.out || "?"}`).join(", ")}</span> · {fmtDuration(recorded)}</>
                    : <>Nothing recorded on this day.</>
                  : <>No punches are read from the selected days; the times below replace each day in full.</>}
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={fillScheduled}>
                  Scheduled day <span className="ml-1 tabular-nums opacity-70">{sched.shift_start}-{sched.shift_end}</span>
                </Button>
                {single && edited && <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={restore}>Reset</Button>}
              </span>
            </div>
            <div className="space-y-2">
              <PunchRows punches={punches} onChange={setPunches} labels autoFocus />
              <div className="flex items-center justify-end gap-3">
                <span className="text-xs tabular-nums text-muted-foreground">
                  {kept.length === 0 ? (
                    single ? "Clears the day" : "Clears every selected day"
                  ) : (
                    <>
                      {single ? "Day totals" : "Each day totals"} <span className="font-semibold text-foreground">{fmtDuration(Math.max(0, total))}</span>
                      {/* The change, not just the result: an approver is deciding on the difference. */}
                      {single && delta !== 0 && (
                        <span className={cn("ml-1 font-medium", delta > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400")}>
                          ({delta > 0 ? "+" : "-"}{fmtDuration(Math.abs(delta))})
                        </span>
                      )}
                    </>
                  )}
                </span>
              </div>
            </div>
          </>
        )}
        <Field label="Reason" hint="Your manager or HR reads this when approving."><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. forgot to clock in after lunch" /></Field>
        <FormError error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={close}>Cancel</Button>
          <Button loading={busy} disabled={!canSubmit} onClick={submit}>{single ? "Submit request" : `Submit ${rows.length} requests`}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// One editable in/out list: a row per punch, add and remove, each row validated on its own. Shared by the
// correction dialog's two modes (one set of times for every day, or a set per day), which is the only reason
// it is a component rather than inline markup.
function PunchRows({ punches, onChange, labels, autoFocus }: {
  punches: PunchRow[];
  onChange: (next: PunchRow[]) => void;
  // Column labels sit above the first row. A per-day block repeats the list, where repeating the labels is noise.
  labels?: boolean;
  autoFocus?: boolean;
}) {
  const set = (i: number, patch: Partial<PunchRow>) => onChange(punches.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      {punches.map((r, i) => {
        const err = punchError(r);
        const label = (text: string) => (labels && i === 0 ? text : "");
        return (
          <div key={i} className="space-y-1">
            <div className="flex items-end gap-4">
              <Field label={label("Clock in")} className="flex-1"><Input type="time" aria-label={`Clock in, punch ${i + 1}`} autoFocus={autoFocus && i === 0} value={r.in} onChange={(e) => set(i, { in: e.target.value })} /></Field>
              <Field label={label("Clock out")} className="flex-1"><Input type="time" aria-label={`Clock out, punch ${i + 1}`} aria-invalid={!!err} className={cn(err && "border-destructive focus-visible:ring-destructive")} value={r.out} onChange={(e) => set(i, { out: e.target.value })} /></Field>
              <Button type="button" variant="ghost" size="icon" className="mb-0.5 h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive" onClick={() => onChange(punches.filter((_, j) => j !== i))} aria-label="Remove this in/out"><Trash2 className="h-4 w-4" /></Button>
            </div>
            {err && <p className="text-xs font-medium text-destructive">{err}</p>}
          </div>
        );
      })}
      <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => onChange([...punches, { in: "", out: "" }])}>
        <Plus className="h-3.5 w-3.5" /> Add another in/out
      </Button>
    </div>
  );
}

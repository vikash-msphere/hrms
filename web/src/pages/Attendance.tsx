import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clock, LogIn, LogOut, CircleDot, Pencil, AlertTriangle, Plus, Trash2, Users, Check, X, ChevronRight, Coffee } from "lucide-react";
import { create, invoke } from "@/api";
import { useCollection, useCollectionHasMore } from "@/hooks/useCollection";
import { useScheduleView } from "@/hooks/useScheduleView";
import { useApprovals } from "@/lib/approvals";
import { useClock, listAllSessions } from "@/lib/clock";
import { usePermission, useCanExport, useCanWriteOthers } from "@/lib/perm";
import { fireIntent, useIntent } from "@/lib/intent";
import { navigate } from "@/router";
import { exportTable } from "@/lib/exportTable";
import { cn, idOf, formatDate, formatHHMM } from "@/lib/utils";
import {
  summarizeByDay, buildAttendanceRows, statsOf, fmtDay, fmtHM, fmtHM24, fmtDuration, fmtDurationShort, describeCorrection,
  seedPunches, punchInstants, punchErrors, keptPunches, isOpenPunch, punchTotal, sameTimes, type PunchRow, type OpenAllowance, type PunchTarget,
  localDay, trackedFromOf, localMinutes, zonedInstant, weekdayOf, hhmmToMin, signedDuration, STATUS_UI, leaveRangeOf, unpaidLeaveTypes,
  type DayStatus, type AttendanceRow, type AttendanceSchedule, type LeaveRange, type WindowStats,
} from "@/lib/attendance";
import { useAttendanceWindow } from "@/hooks/useAttendanceWindow";
import { AttendanceHistory } from "@/components/common/AttendanceHistory";
import { excusalsByEmployee, usePunctualityPolicy, type DayExcusal, type LateEarlyKind } from "@/lib/lateEarly";
import type { AttendanceSession, AttendanceRegularization, Department, Employee, Holiday, LateEarlyRequest, LeaveRequest, LeaveType, Me } from "@/types";
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
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";
import { PunchFixDialog } from "@/components/common/PunchFixDialog";
import { confirmDecision } from "@/lib/confirmDecision";

const DAY_MS = 86400000;
const upper = (s?: string) => (s ?? "").toUpperCase();

export default function Attendance({ me }: { me: Me }) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const clock = useClock();
  const sched = clock.sched;
  const tz = sched.timezone;
  const [pageSessions, setPageSessions] = useState<AttendanceSession[]>([]); // sessions for the visible history window
  const [recentSessions, setRecentSessions] = useState<AttendanceSession[]>([]); // last couple of days, for "today"
  const [pageLoading, setPageLoading] = useState(true); // history window fetch in flight (skeleton, not "no data")
  const [now, setNow] = useState(Date.now());
  const [correctionBusy, setCorrectionBusy] = useState(false); // a correction submit in flight
  // The day(s) a correction modal is open for. With `punch` it is the one-punch fix (PunchFixDialog); without,
  // the whole-day editor, starting from `initial` when the one-punch fix handed its edit over.
  const [correcting, setCorrectingState] = useState<{ rows: AttendanceRow[]; punch?: PunchTarget; initial?: PunchRow[] } | null>(null);
  const setCorrecting = (rows: AttendanceRow[], punch?: PunchTarget) => setCorrectingState({ rows, punch });
  const filedThisDialog = useRef<Set<string>>(new Set()); // days the open correction dialog already filed
  // Closing is the one moment the already-filed set stops being true, so every open starts clean.
  const closeCorrection = () => { filedThisDialog.current = new Set(); setCorrectingState(null); };
  // Org display switches (Settings → Attendance). Absent means shown, so an org that never touched them keeps
  // the bar; the projection is a sub-toggle of the bar it sits on.
  const showDayProgress = sched.show_day_progress !== false;
  const showFinishProjection = showDayProgress && sched.show_finish_projection !== false;
  const canApprove = me.capabilities.includes("attendance-regularizations.approve");
  const canExport = useCanExport("attendance");
  const canLogOvertime = usePermission("overtime-requests.write");
  const canRequestLateEarly = usePermission("late-early-requests.write");
  const canCorrect = usePermission("attendance-regularizations.write");
  const punctuality = usePunctualityPolicy();
  // Re-valuing a day, for the teammate logs this page opens from the roster. A roster spans everybody, so
  // there is no one subject to ask about: the caller-level question ("is there anybody but me whose day I
  // could mark") is the honest one here, and the server still refuses any row the grant does not reach.
  const canMarkDays = useCanWriteOthers("attendance-day-marks");
  // `all: true` on the roster: this is the grid's list of PEOPLE, one row each, with no "load more" for a
  // reader to press - the shape `all` exists for. On one page, an org past a hundred simply had rows missing.
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  const { rows: departments } = useCollection<Department>("departments", { enabled: canApprove, all: true });
  const { rows: holidays } = useCollection<Holiday>("holidays", { all: true });
  const { rows: leaveTypes } = useCollection<LeaveType>("leave-types");
  // THE CALLER'S OWN correction requests, narrowed server-side (`?employee=`, routes/attendanceRegularizations)
  // and walked. Reading one org-wide page and filtering to "mine" in the browser worked only for a caller the
  // server had already scoped to themselves: an APPROVER gets everybody's rows newest-first, so their own
  // corrections lost their slots to the org's, "My requests" rendered empty, the duplicate-day guard below
  // stopped firing, and `cancelReg` could not reach a request that was not in the window.
  const { rows: regularizations, reload: reloadRegs } = useCollection<AttendanceRegularization>("attendance-regularizations", {
    enabled: !!me.employee_id,
    params: { employee: me.employee_id ? `employees/${me.employee_id}` : "" },
    all: true,
  });
  const rosterTruncated = useCollectionHasMore(["employees", "leave-requests"]);

  // `useCallback`, because five memos and an effect on this page filter with it: as a bare arrow it changed
  // identity every render, so each of those either had to restate `me.employee_id` by hand or keep the copy it
  // was first given. Its identity now moves with the one field it reads.
  const mine = useCallback((ref?: string) => !!ref && idOf(ref) === me.employee_id, [me.employee_id]);
  // My correction requests, newest first, so pending + decided are visible in one place. The read above is
  // already scoped to this person; the `mine` filter stays as the belt to its braces.
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
  const trackedFromYmd = trackedFromOf(meEmployee);
  // The device's zone, when it differs from the org's: every time on this page is org-local, so say so once.
  const deviceTz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  // The visible window, shared with the history below it: the team panel promises "the same days the history
  // shows", and one object is the only way that stays true through a view switch or a page back.
  const win = useAttendanceWindow(me.email, orgToday);
  const { fromYmd, toYmd, prevWindow, windowLabel } = win;

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
  // Approved late arrivals / early departures over the same span, for everyone the caller may see: each moves
  // its day's start or end, so today's row, the team table and my own history are all judged against the moved
  // window. One read, handed to the history below rather than read again there.
  const { rows: lateEarly } = useCollection<LateEarlyRequest>("late-early-requests", {
    all: true,
    params: { from: leaveWindow.from, to: leaveWindow.to, state: "APPROVED" },
  });
  const excusalsByEmp = useMemo(() => excusalsByEmployee(lateEarly), [lateEarly]);

  // Shared inputs for building per-day rows (holidays + approved leave).
  const holidayByDay = useMemo(() => {
    const m = new Map<string, Holiday>();
    // A regional holiday for another location (`applies === false`) is a normal working day here.
    for (const h of holidays) if (!h.disabled && h.applies !== false) m.set(h.date, h);
    return m;
  }, [holidays]);
  const holidaySet = useMemo(() => new Set(holidayByDay.keys()), [holidayByDay]);
  const myApprovedLeaves = useMemo(() => leaves.filter((l) => mine(l.employee) && upper(l.state) === "APPROVED"), [leaves, mine]);
  const unpaidTypes = useMemo(() => unpaidLeaveTypes(leaveTypes), [leaveTypes]);
  const leaveRanges = useMemo<LeaveRange[]>(
    () => myApprovedLeaves.map((l) => leaveRangeOf(l, unpaidTypes)),
    [myApprovedLeaves, unpaidTypes],
  );
  // The approved leave covering a given day (for the expanded "why no punches" detail).
  const leaveForDay = useCallback((day: string) => myApprovedLeaves.find((l) => l.start_date <= day && day <= l.end_date), [myApprovedLeaves]);
  // Everything the history needs to describe a day it has no punches for. Handed over rather than re-read:
  // the leave feed above is already on this page for the team panel, so the history fetches none of its own.
  const myLeave = useMemo(() => ({ ranges: leaveRanges, forDay: leaveForDay }), [leaveRanges, leaveForDay]);

  // Whose day is what, over every day this page draws. WIDENED TO INCLUDE TODAY, because the today row is
  // built independently of whichever history page the table is showing - resolved against a window that did
  // not cover it, today would quietly fall back to the org's own week.
  const schedFrom = fromYmd < orgToday ? fromYmd : orgToday;
  const schedTo = toYmd > orgToday ? toYmd : orgToday;
  const view = useScheduleView(sched, schedFrom, schedTo);

  // One way to turn a set of punches into per-day rows, reused for today's row and every teammate's window
  // (each with their own leave + join date).
  const buildRows = useCallback(
    (sessions: AttendanceSession[], opts: { from: string; to: string; leaves: LeaveRange[]; joined?: string; tracked?: string; excusals?: Map<string, DayExcusal>; employeeId?: string }) =>
      buildAttendanceRows({
        fromYmd: opts.from, toYmd: opts.to, todayYmd: orgToday,
        // WHOSE days these are. A rest day in somebody's own schedule is not an absence, and a four-hour
        // shift is a full day at four hours - the grid has to read that the way payroll does.
        schedOf: view.of(opts.employeeId ?? ""),
        summaries: summarizeByDay(sessions, sched, { excusals: opts.excusals, policy: punctuality.attendance, leaveRanges: opts.leaves }),
        holidays: holidaySet, leaveRanges: opts.leaves, joinedYmd: opts.joined, trackedFromYmd: opts.tracked,
      }),
    [orgToday, sched, holidaySet, punctuality, view],
  );
  const myExcusals = me.employee_id ? excusalsByEmp.get(me.employee_id) : undefined;

  // Today's row (always today, independent of which history page the table shows) - built from a small recent
  // fetch so the My-clock punch log and the cumulative total stay put while you page through history.
  const todayRow = useMemo(
    () => buildRows(recentSessions.filter((s) => mine(s.employee)), { from: orgToday, to: orgToday, leaves: leaveRanges, joined: joinedYmd, tracked: trackedFromYmd, excusals: myExcusals, employeeId: me.employee_id ?? undefined })[0],
    [recentSessions, buildRows, leaveRanges, joinedYmd, trackedFromYmd, mine, orgToday, myExcusals, me.employee_id],
  );

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

  async function punch(verb: "clockIn" | "clockOut") {
    await clock.punch(verb);
    await Promise.all([loadRecent(), loadPage()]);
  }
  // ⌘K's "Clock in / clock out" lands here and punches whichever way matches the current state.
  useIntent("clock-toggle", () => { void punch(clock.mine ? "clockOut" : "clockIn"); });

  // A correction request is an attendance-regularization carrying the day's full intended in/out set. On
  // approval (manager/HR, via Approvals) the day's punches are superseded and these are written as the day's
  // sessions - no ticket, no manual data fixing. `pairs` are wall-clock "HH:MM"; [] means "remove all punches".
  // A pair with no clock-out is today's last session, still running: it goes up without `clock_out`.
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
        const sessions = perDay[day].map((p) => punchInstants(day, p, tz));
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
      if (!failure) closeCorrection();
    }
    const done = filedThisDialog.current.size;
    return failure && done ? `Filed ${done} of ${days.length}. ${failure}` : failure;
  }

  // Ask for the late arrival / early departure that would have excused a flagged day, prefilled with the day and
  // the time the punches actually show - the same hand-off "Log overtime" makes, for the same reason.
  function requestLateEarly(row: AttendanceRow, kind: LateEarlyKind) {
    const at = kind === "late_arrival" ? row.summary?.arrival : row.summary?.departure;
    navigate("late-early");
    fireIntent("new-late-early", { date: row.day, kind, at: at ? fmtHM24(at, tz) : undefined });
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
      reason: `Worked past ${formatHHMM(sched.shift_end)} on ${formatDate(row.day)}`,
    });
  }

  // Manager/HR: everyone's standing right now, from the sessions already fetched for the clock card (no extra
  // reads). People the caller can see but whose punches they can't read simply read as "not in yet".
  const roster = useMemo(
    () => employees.filter((e) => !e.delete_time && (!e.start_date || e.start_date.slice(0, 10) <= orgToday)),
    [employees, orgToday],
  );
  // Anybody's join date and the day HRMS records start for them, for the per-person log the team table opens.
  const joinedOf = useCallback(
    (id: string) => {
      const e = employees.find((x) => idOf(x.path) === id);
      return { joined: e?.start_date, tracked: trackedFromOf(e) };
    },
    [employees],
  );
  const approvedLeaveByEmp = useMemo(() => {
    const m = new Map<string, LeaveRange[]>();
    for (const l of leaves) {
      if (!l.employee || upper(l.state) !== "APPROVED") continue;
      const k = idOf(l.employee);
      const arr = m.get(k);
      const range = leaveRangeOf(l, unpaidTypes);
      if (arr) arr.push(range); else m.set(k, [range]);
    }
    return m;
  }, [leaves, unpaidTypes]);

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
    const startMin = hhmmToMin(sched.shift_start);
    const lateAfter = startMin + sched.grace_minutes;
    // Somebody approved to come in at 10:30 is not late at 10:00: their own day starts at the approved time
    // (plus grace, unless the policy makes the approved time exact).
    const lateAfterFor = (id: string) => {
      const until = excusalsByEmp.get(id)?.get(orgToday)?.lateUntil;
      return until != null && until > startMin ? until + (punctuality.attendance.grace_on_top ? sched.grace_minutes : 0) : lateAfter;
    };
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
        out.push({ id, name, dept, photo: e.photo, group: "not_in", late: nowMin > lateAfterFor(id), worked: 0 });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [canApprove, roster, clock.openSessions, recentSessions, approvedLeaveByEmp, excusalsByEmp, punctuality, sched, tz, orgToday, now]);

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
        const empRows = buildRows(byEmp.get(id) ?? [], { from: fromYmd, to: toYmd, leaves: approvedLeaveByEmp.get(id) ?? [], joined: e.start_date, tracked: trackedFromOf(e), excusals: excusalsByEmp.get(id), employeeId: id });
        return {
          id,
          name: `${e.first_name} ${e.last_name}`,
          dept: e.department ? idOf(e.department) : undefined,
          rows: empRows,
          stats: statsOf(empRows, tz, view.of(id), orgToday),
        };
      })
      // Worst first: absences, then lateness - the rows a manager has to act on lead.
      .sort((a, b) => b.stats.absent - a.stats.absent || b.stats.late - a.stats.late || a.name.localeCompare(b.name));
  }, [canApprove, roster, pageSessions, buildRows, approvedLeaveByEmp, excusalsByEmp, fromYmd, toYmd, tz, view, orgToday]);

  return (
    <div>
      <PageHeader
        title="Attendance"
        description={`Shift ${formatHHMM(sched.shift_start)} – ${formatHHMM(sched.shift_end)} · ${sched.timezone}`}
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
                <p className="text-xs text-muted-foreground sm:text-right">
                  Clock out and back in to record a break.
                  {/* The morning punch is the one people miss or make late, and they notice while still at work -
                      so today's fix sits next to the clock rather than down in the history. */}
                  {canCorrect && !staleOpen && (
                    <>
                      {" "}
                      <button type="button" className="font-medium text-primary underline-offset-2 hover:underline" onClick={() => setCorrecting([todayRow ?? { day: orgToday, status: "absent" as DayStatus }])}>
                        Missed or wrong punch?
                      </button>
                    </>
                  )}
                </p>
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
                    // The day the forgotten punch belongs to, built from the recent fetch rather than read off
                    // the history: the history may be paged back to a window that does not contain it.
                    const day = localDay(staleOpen.clock_in, tz);
                    const [row] = buildRows(recentSessions.filter((s) => mine(s.employee)), { from: day, to: day, leaves: leaveRanges, joined: joinedYmd, tracked: trackedFromYmd, excusals: myExcusals, employeeId: me.employee_id ?? undefined });
                    setCorrecting([row ?? { day, status: "absent" as DayStatus }]);
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
                shift={`${formatHHMM(sched.shift_start)} – ${formatHHMM(sched.shift_end)}`}
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

        {/* My attendance: the hours trend, the year, the window summary and the day-by-day history. The same
            component an approver reads somebody else's record with - it is handed the punches this page has
            already fetched (they are everyone's; it keeps mine) and the leave feed, so it reads nothing of its
            own, and the correction affordances are wired up because this is my own record. */}
        {me.employee_id && (
          <AttendanceHistory
            employeeId={me.employee_id}
            joinedYmd={joinedYmd}
            trackedFromYmd={trackedFromYmd}
            win={win}
            sched={sched}
            orgToday={orgToday}
            now={now}
            title="My attendance"
            // Never on your own log, whatever the grant says: a day mark is what the day is PAID as, so
            // re-valuing your own is not an affordance this page offers. (grants.ts says the same in the other
            // direction - the self tier on day marks is read.)
            canMark={false}
            canExport={canExport}
            exportName="attendance"
            sessions={pageSessions}
            loading={pageLoading}
            leave={myLeave}
            lateEarly={lateEarly}
            liveMinutes={openMin}
            onCorrect={setCorrecting}
            onLogOvertime={canLogOvertime ? logOvertime : undefined}
            onRequestLateEarly={canRequestLateEarly ? requestLateEarly : undefined}
            emptyText="No attendance yet. Clock in above to record your first day."
          />
        )}
        {/* My correction requests: the audit trail of what I've asked to fix + where each stands. */}
        {myRegs.length > 0 && (
          <Card>
            <CardHeader><CardTitle className="text-base">My correction requests</CardTitle></CardHeader>
            <CardContent className="divide-y">
              {myRegs.map((r) => {
                const times = describeCorrection(r.recorded_sessions, r.sessions, (iso) => fmtHM(iso, tz));
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
            canMark={canMarkDays}
            truncated={rosterTruncated}
            sched={sched}
            orgToday={orgToday}
            joinedOf={joinedOf}
          />
        )}
      </div>

      {correcting?.punch && correcting.rows[0] ? (
        <PunchFixDialog
          key={`${correcting.rows[0].day}:${correcting.punch.index}:${correcting.punch.edge}`}
          row={correcting.rows[0]}
          punch={correcting.punch}
          tz={tz}
          today={orgToday}
          pendingDays={pendingCorrectionDays}
          busy={correctionBusy}
          onClose={closeCorrection}
          onSubmit={submitCorrection}
          onWholeDay={(initial) => setCorrectingState({ rows: correcting.rows, initial })}
        />
      ) : correcting && (
        <CorrectionDialog
          key={correcting.rows.map((r) => r.day).join(",")}
          rows={correcting.rows}
          initial={correcting.initial}
          tz={tz}
          sched={sched}
          today={orgToday}
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
                {describeCorrection(r.recorded_sessions, r.sessions, (iso) => fmtHM(iso, tz))}
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
function TeamPanel({ today, period, departments, windowLabel, tz, now, off, fullDay, canExport, canMark, truncated, sched, orgToday, joinedOf }: {
  today: TeamEntry[];
  period: TeamPeriodRow[];
  departments: Department[];
  windowLabel: string;
  tz: string;
  now: number;
  off: string | null;
  fullDay: number;
  canExport: boolean;
  /** The caller's own write breadth on day marks, for the teammate log this panel opens - see PersonAttendance. */
  canMark: boolean;
  truncated: boolean;
  sched: AttendanceSchedule;
  orgToday: string;
  /** That person's join date and the day HRMS records start for them, so their log doesn't flag the days before either. */
  joinedOf: (employeeId: string) => { joined?: string; tracked?: string };
}) {
  const [tab, setTab] = useState<"today" | "period">("today");
  const [dept, setDept] = useState("all");
  const [picked, setPicked] = useState<TeamGroup>("in");
  const [opened, setOpened] = useState<TeamPeriodRow | null>(null); // the person whose own log is open

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
      signedDuration(r.stats.doneMinutes - r.stats.expectedMinutes),
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
                  <th className="w-8 py-2" />
                </tr>
              </thead>
              <tbody>
                {periodRows.map((r) => {
                  const balance = r.stats.doneMinutes - r.stats.expectedMinutes;
                  return (
                    // The whole row opens that person's own attendance - these totals are the summary of a
                    // log, and the question they raise ("which days?") has to be answerable from here. A tab
                    // stop and Enter/Space, the same shape a day row in the history has.
                    <tr
                      key={r.id}
                      className="group cursor-pointer border-b last:border-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring hover:bg-muted/40"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setOpened(r); } }}
                      onClick={() => setOpened(r)}
                    >
                      {/* Name only, no avatar: this table can run to the whole org, and one photo fetch per
                          row would be a large fan-out for a figure nobody identifies people by. */}
                      <td className="py-1.5 pr-3 font-medium">{r.name}</td>
                      <td data-label="Present" className="py-1.5 pr-3 text-right tabular-nums">{r.stats.worked}<span className="text-muted-foreground">/{r.stats.workingDays}</span></td>
                      <td data-label="Absent" className={cn("py-1.5 pr-3 text-right tabular-nums", r.stats.absent > 0 && "font-semibold text-destructive")}>{r.stats.absent}</td>
                      <td data-label="Late" className={cn("py-1.5 pr-3 text-right tabular-nums", r.stats.late > 0 && "font-semibold text-warning")}>{r.stats.late}</td>
                      <td data-label="Hours" className="py-1.5 pr-3 text-right tabular-nums">{fmtDuration(r.stats.minutes)}</td>
                      <td data-label="Balance" className={cn("py-1.5 pr-3 text-right tabular-nums", balance >= 0 ? "text-success" : "text-destructive")}>{signedDuration(balance)}</td>
                      <td data-label="Pattern" className="hidden py-1.5 lg:table-cell">
                        {/* One dot per recorded day, oldest first: the shape of the month at a glance. */}
                        <span className="flex flex-wrap gap-0.5">
                          {[...r.rows].reverse().map((d) => (
                            <span key={d.day} className={cn("h-2 w-2 rounded-[2px]", STATUS_UI[d.status].dot)} title={`${fmtDay(d.day)} · ${d.summary ? fmtDuration(d.summary.workedMinutes) : STATUS_UI[d.status].label}`} />
                          ))}
                        </span>
                      </td>
                      <td className="py-1.5 text-right">
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setOpened(r); }}
                          className="text-muted-foreground transition-colors hover:text-foreground"
                          aria-label={`Open ${r.name}'s attendance`}
                        >
                          <ChevronRight className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>

      {/* One person's own log, over the same window the table summarises. It reads its own punches (narrowed
          to them by the server) rather than being handed the page's set, because it pages independently -
          stepping back a month here must not move the table underneath it. Read-only: an approver does not
          file somebody else's correction, they answer the one that person filed. */}
      <Sheet open={!!opened} onOpenChange={(o) => { if (!o) setOpened(null); }}>
        <SheetContent className="sm:max-w-[860px]">
          <SheetHeader>
            <SheetTitle>{opened?.name}</SheetTitle>
          </SheetHeader>
          <SheetBody>
            {opened && (
              <PersonAttendance
                employeeId={opened.id}
                name={opened.name}
                joinedYmd={joinedOf(opened.id).joined}
                trackedFromYmd={joinedOf(opened.id).tracked}
                sched={sched}
                orgToday={orgToday}
                now={now}
                canExport={canExport}
                // A teammate's log, opened from the roster table - and the place HR actually re-values a day,
                // which is why this is passed rather than read from a subject provider: this page has none
                // (no one subject spans a roster), so the component asking for itself answered "no" here and
                // the affordance was missing from the surface the feature is used on. The caller's own write
                // breadth is the honest answer; the server still refuses any row that grant does not reach.
                canMark={canMark}
              />
            )}
          </SheetBody>
        </SheetContent>
      </Sheet>
    </Card>
  );
}

// One teammate's attendance, in the sheet the period table opens. Its own window (`useAttendanceWindow` keyed
// on the person, so the view choice is remembered per record) and its own punches - see the note at the call
// site for why it does not borrow the page's.
function PersonAttendance({ employeeId, name, joinedYmd, trackedFromYmd, sched, orgToday, now, canExport, canMark }: {
  employeeId: string;
  name: string;
  joinedYmd?: string;
  trackedFromYmd?: string;
  sched: AttendanceSchedule;
  orgToday: string;
  now: number;
  canExport: boolean;
  /** The caller's own write breadth on day marks - see the prop's note in AttendanceHistory. */
  canMark: boolean;
}) {
  const win = useAttendanceWindow(`emp:${employeeId}`, orgToday);
  return (
    <AttendanceHistory
      employeeId={employeeId}
      joinedYmd={joinedYmd}
      trackedFromYmd={trackedFromYmd}
      win={win}
      sched={sched}
      orgToday={orgToday}
      now={now}
      title="Attendance"
      canExport={canExport}
      canMark={canMark}
      exportName={`attendance-${name.toLowerCase().replace(/\s+/g, "-")}`}
      emptyText={`No attendance recorded for ${name} yet.`}
    />
  );
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

// Correction request modal: seeded with the day's existing sessions (one row per punch), each editable, with
// add/remove. Submitting files an attendance-regularization carrying the FULL intended day; on approval the
// day's punches are superseded and these become the day's sessions. Removing every row clears the day.
// Fixing one punch is editing one field: the others are already filled with what was recorded, and the
// changed time is marked against it. On today the latest in/out may leave its clock-out blank - the person is
// still at work, and the approval keeps whatever clock-out they punch (services/attendanceRegularizations.ts).
// Several days at once default to one shared set of times (the "I forgot to clock all week" case) and file one
// request each; per-day mode gives each selected day its own times, because a real week is rarely identical.
// The form rules (PunchRow, punchErrors, punchTotal, ...) live in lib/attendance.ts, shared with PunchFixDialog.
function CorrectionDialog({ rows, initial, tz, sched, today, pendingDays, busy, onClose, onSubmit }: {
  rows: AttendanceRow[];
  // Where to start instead of the recorded day: PunchFixDialog's "Edit the whole day instead" hands its edit over.
  initial?: PunchRow[];
  tz: string;
  // The org work schedule, so the standard day can be filled in with one click instead of typed twice.
  sched: AttendanceSchedule;
  // The org-local today: only a correction for today can leave its latest clock-out blank.
  today: string;
  // Days that already carry a pending correction - filing a second one for the same day is almost never meant.
  pendingDays: string[];
  busy: boolean;
  onClose: () => void;
  // Resolves to a failure message when a day was rejected, so the dialog can pin it beside the form.
  onSubmit: (perDay: Record<string, PunchRow[]>, reason: string) => Promise<string | undefined>;
}) {
  const guardClose = useDiscardGuard();
  const single = rows.length === 1 ? rows[0] : undefined;
  const seeded = seedPunches(single?.summary?.sessions ?? [], tz);
  const [punches, setPunches] = useState<PunchRow[]>(initial ?? (seeded.length ? seeded : [{ in: "", out: "" }]));
  // null = every selected day takes the shared times above; a record = each day carries its own.
  const [perDay, setPerDay] = useState<Record<string, PunchRow[]> | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Only one day, and only today: the latest in/out may be left running. Read at render, which the page's own
  // 15s tick keeps close enough for a "not later than now" check.
  const openAllowed: OpenAllowance = single?.day === today ? { now: fmtHM24(new Date().toISOString(), tz) } : undefined;
  // What each targeted day would become - the single source both the summary and the submit read from.
  const targets: Record<string, PunchRow[]> = perDay ?? Object.fromEntries(rows.map((r) => [r.day, punches]));
  const kept = keptPunches(punches);
  const canSubmit = Object.values(targets).every((p) => !punchErrors(p, openAllowed).some(Boolean)); // an empty set clears the day
  const total = punchTotal(punches, openAllowed);
  const stillIn = !!openAllowed && kept.some(isOpenPunch);
  // What the day currently says, so the request reads as "this, instead of that" rather than a bare set of times.
  // A punch still running counts up to now on both sides, so moving this morning's clock-in reads as the
  // difference it makes rather than as the whole open stretch.
  const recorded = openAllowed ? punchTotal(seeded, openAllowed) : single?.summary?.workedMinutes ?? 0;
  const delta = Math.max(0, total) - recorded;
  const edited = !sameTimes(kept, seeded);
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
              ? openAllowed
                ? "Change only the time that's wrong - the rest stay as recorded. Still at work? Leave the last clock-out blank and clock out as usual. Your manager or HR approves it."
                : "Change only the time that's wrong - the rest stay as recorded. Your manager or HR approves it, and the day is fixed. Remove every row to clear the day's punches."
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
                      {dayKept.length === 0 ? "Clears the day" : <>Totals <span className="font-semibold text-foreground">{fmtDuration(Math.max(0, punchTotal(dayPunches, undefined)))}</span></>}
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
                    ? <>Recorded now: <span className="font-medium tabular-nums text-foreground">{seeded.map((s) => `${s.in}-${s.out || (openAllowed ? "still in" : "?")}`).join(", ")}</span> · {fmtDuration(recorded)}</>
                    : <>Nothing recorded on this day.</>
                  : <>No punches are read from the selected days; the times below replace each day in full.</>}
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={fillScheduled}>
                  Scheduled day <span className="ml-1 tabular-nums opacity-70">{formatHHMM(sched.shift_start)} - {formatHHMM(sched.shift_end)}</span>
                </Button>
                {single && edited && <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={restore}>Reset</Button>}
              </span>
            </div>
            <div className="space-y-2">
              <PunchRows punches={punches} onChange={setPunches} open={openAllowed} labels autoFocus />
              <div className="flex items-center justify-end gap-3">
                <span className="text-xs tabular-nums text-muted-foreground">
                  {kept.length === 0 ? (
                    single ? "Clears the day" : "Clears every selected day"
                  ) : (
                    <>
                      {stillIn ? "So far" : single ? "Day totals" : "Each day totals"} <span className="font-semibold text-foreground">{fmtDuration(Math.max(0, total))}</span>
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
function PunchRows({ punches, onChange, open, labels, autoFocus }: {
  punches: PunchRow[];
  onChange: (next: PunchRow[]) => void;
  // Set when the list is for today, so its latest in/out may leave the clock-out blank.
  open?: OpenAllowance;
  // Column labels sit above the first row. A per-day block repeats the list, where repeating the labels is noise.
  labels?: boolean;
  autoFocus?: boolean;
}) {
  const set = (i: number, patch: Partial<PunchRow>) => onChange(punches.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const errors = punchErrors(punches, open);
  // Under a field whose time the request changes, what the record said before - so fixing one punch reads as
  // exactly that, and the untouched ones visibly stay as they were.
  const was = (now: string, before?: string) =>
    before !== undefined && now !== before ? <p className="text-xs tabular-nums text-muted-foreground">was {before || "not punched"}</p> : null;
  return (
    <div className="space-y-2">
      {punches.map((r, i) => {
        const err = errors[i];
        const running = !err && !!open && isOpenPunch(r);
        const label = (text: string) => (labels && i === 0 ? text : "");
        // The field the error is about, so the other one of the pair is not painted wrong alongside it.
        const badIn = !!err && !r.in;
        const badOut = !!err && !badIn;
        const inNote = was(r.in, r.was?.in);
        const outNote = running ? <p className="text-xs font-medium text-success">Still clocked in</p> : was(r.out, r.was?.out);
        return (
          <div key={i} className="space-y-1">
            <div className="flex items-end gap-4">
              <Field label={label("Clock in")} className="flex-1"><Input type="time" aria-label={`Clock in, punch ${i + 1}`} aria-invalid={badIn} className={cn(badIn && "border-destructive focus-visible:ring-destructive")} autoFocus={autoFocus && i === 0} value={r.in} onChange={(e) => set(i, { in: e.target.value })} /></Field>
              <Field label={label("Clock out")} className="flex-1"><Input type="time" aria-label={`Clock out, punch ${i + 1}`} aria-invalid={badOut} className={cn(badOut && "border-destructive focus-visible:ring-destructive")} value={r.out} onChange={(e) => set(i, { out: e.target.value })} /></Field>
              <Button type="button" variant="ghost" size="icon" className="mb-0.5 h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive" onClick={() => onChange(punches.filter((_, j) => j !== i))} aria-label="Remove this in/out"><Trash2 className="h-4 w-4" /></Button>
            </div>
            {/* Same columns as the inputs above (the spacer stands in for the remove button), so each note sits under its field. */}
            {(inNote || outNote) && (
              <div className="flex gap-4">
                <div className="flex-1">{inNote}</div>
                <div className="flex-1">{outNote}</div>
                <div className="w-9 shrink-0" aria-hidden />
              </div>
            )}
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

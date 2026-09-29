import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactElement, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, ChevronUp, Cake, PartyPopper, UserPlus, ShieldCheck, CalendarRange, Clock, CalendarDays, Info, Users, type LucideIcon } from "lucide-react";
import type { Employee, LeaveRequest, LeaveType, Holiday, Celebration, AttendanceSession, Event, LateEarlyRequest, Me } from "@/types";
import { cn, idOf } from "@/lib/utils";
import { isCurrentEmployee } from "@/lib/employees";
import { useCollection } from "@/hooks/useCollection";
import { useScheduleView } from "@/hooks/useScheduleView";
import { excusalsByEmployee, usePunctualityPolicy } from "@/lib/lateEarly";
import { hhmmOf } from "../../../../src/domain/punctuality";
import { todayStr } from "@/lib/orgDay";
import { listAllSessionsPaged } from "@/lib/clock";
import { leaveColor } from "@/lib/leaveColors";
import { usePermission } from "@/lib/perm";
import { navigate } from "@/router";
import type { LeaveDraft } from "@/lib/leaveDraft";
import { RequestLeaveDialog } from "@/components/common/RequestLeaveDialog";
import { summarizeByDay, buildAttendanceRows, trackedFromOf, fmtHM, fmtDuration, localDay, localMinutes, enumerateDays, weekdayOf, DEFAULT_SCHEDULE, leaveRangeOf, unpaidLeaveTypes, type AttendanceSchedule, type DayStatus, type AttendanceRow } from "@/lib/attendance";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import confettiUrl from "./confetti.svg";
import { getSetting } from "@/lib/settingsStore";
import { useMedia } from "@/hooks/useMedia";

type TipPerson = { id: string; name: string; photo?: string };

// Wrap any single element so it shows a rich tooltip card on hover/focus (the timeline's one affordance for
// every event). `asChild` keeps the wrapped element as the DOM node, so grid placement/styles are preserved.
// The content is a styled card (header + meta rows), not the plain dark default.
function Tip({ label, children }: { label: ReactNode; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="overflow-hidden rounded-lg border bg-popover p-0 text-popover-foreground shadow-lg">{label}</TooltipContent>
    </Tooltip>
  );
}

// ---- Tooltip card building blocks (shared look; per-event accents) ---------------------------------------
// A colored title bar + an optional meta body. `accent` tints the title text to match the event.
function TipCard({ person, dot, dotColor, icon: Icon, iconClass, title, accent, eta, children }: {
  person?: TipPerson; dot?: string; dotColor?: string; icon?: LucideIcon; iconClass?: string; title: ReactNode; accent?: string; eta?: ReactNode; children?: ReactNode;
}) {
  return (
    <div className="min-w-[9.5rem] max-w-[17rem]">
      {person && (
        <div className="flex items-center gap-2 border-b border-border/60 px-2.5 py-2">
          <PhotoAvatar employeeId={person.id} name={person.name} photo={person.photo} className="h-7 w-7 text-[10px]" />
          <span className="truncate text-[13px] font-semibold text-foreground">{person.name}</span>
        </div>
      )}
      <div className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-2.5 py-1.5">
        {dot && <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", dot)} />}
        {dotColor && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: dotColor }} />}
        {Icon && <Icon className={cn("h-3.5 w-3.5 shrink-0", iconClass)} />}
        <span className={cn("text-[13px] font-semibold leading-tight", accent)}>{title}</span>
        {eta && <span className="ml-auto shrink-0 whitespace-nowrap rounded-full bg-background/70 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">{eta}</span>}
      </div>
      {children && <div className="space-y-1 px-2.5 py-1.5 text-xs text-muted-foreground">{children}</div>}
    </div>
  );
}
const TipRow = ({ icon: Icon, children }: { icon?: LucideIcon; children: ReactNode }) => (
  <div className="flex items-center gap-1.5">
    {Icon && <Icon className="h-3 w-3 shrink-0 text-muted-foreground/70" />}
    <span className="text-foreground/80">{children}</span>
  </div>
);
const TipChips = ({ children }: { children: ReactNode }) => <div className="flex flex-wrap gap-1 pt-0.5">{children}</div>;
const TipChip = ({ tone, children }: { tone: string; children: ReactNode }) => (
  <span className={cn("inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-medium", tone)}>{children}</span>
);

// Two-week team timeline (Dashboard widget). Rows = employees the caller can see; columns = 14 days. Layers
// every dated event we have: leaves (pills, coloured by type, pending dimmed), holidays (tinted column),
// birthdays/anniversaries, new joiners and probation endings (markers). Visibility is gated by `timeline.read`
// (configurable via the ACL); the underlying data stays enforced per collection, so pills only show what the
// caller may already see.
const DAYS = 14;
const DAY_MS = 86400000;
// Weekend/holiday columns render at this fraction of a working day's width (the rest of the row math is
// weight-based off this, so bars still line up). Working days are weight 1.
const WEEKEND_W = 0.5;
// Width of the employee-name column (px). Shared by the grid template AND the day-area overlay offset so the
// bars always start exactly where the day columns do. Phones get the narrow one: the name column is dead
// weight beside 14 days on a 360px screen, and it stays pinned there anyway.
const NAME_COL = 202;
const NAME_COL_SM = 152;
// Minimum width of ONE working-day column (px); weekend/holiday columns take WEEKEND_W of it. The grid is a
// horizontal scroller either way, so a phone spends that scroll on cells a finger can actually hit rather
// than on squeezing the fortnight into the viewport.
const DAY_MIN = 42;
const DAY_MIN_SM = 64;
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Per-day attendance dot. on_leave/holiday render as a pill / shaded column instead, so they get no dot.
// Light, dulled-down attendance dots (the -400 shades, not the bright -500s): green = present, sky = working
// now, yellow = half day, orange = partial day (late in / left early), red = MIA (no log / too short). Leave
// is grey - rendered as a pill (ONE_LEAVE_COLOR), not a dot.
const STATUS_DOT: Record<DayStatus, string | null> = {
  present: "bg-emerald-400",
  open: "bg-sky-400",
  late: "bg-orange-400",
  left_early: "bg-orange-400",
  late_early: "bg-orange-400",
  half_day: "bg-yellow-400",
  insufficient: "bg-red-400",
  absent: "bg-red-400",
  // Half the day was leave and the other half was never worked - it shows a dot (something is owed) rather
  // than the leave pill, which would read as a day fully spoken for.
  half_day_leave: "bg-yellow-400",
  // Worked on a day nobody was rostered: worth seeing, and not an accusation - violet, beside the holiday it
  // usually is.
  worked_off_day: "bg-violet-400",
  on_leave: null,
  holiday: null,
  untracked: null, // before their record existed: nothing to report either way
};
const STATUS_LABEL: Record<DayStatus, string> = {
  present: "Full day",
  open: "Clocked in",
  late: "Late in",
  left_early: "Left early",
  late_early: "Late in, left early",
  half_day: "Short day",
  insufficient: "Too short to count",
  absent: "No log",
  half_day_leave: "Half day leave, half unworked",
  worked_off_day: "Worked - not a working day",
  on_leave: "On leave",
  holiday: "Holiday",
  untracked: "Before HRMS",
};
// The single neutral leave colour shown to viewers without the leave-type breakdown affordance (everyone but
// HR/super). A muted slate grey - distinct from the event indigo, holiday violet, and the attendance dots.
const ONE_LEAVE_COLOR = "#94a3b8";
// Title accent color per status, so the tooltip header matches its dot.
const STATUS_TEXT: Record<DayStatus, string> = {
  present: "text-emerald-600 dark:text-emerald-400",
  open: "text-sky-600 dark:text-sky-400",
  late: "text-orange-600 dark:text-orange-400",
  left_early: "text-orange-600 dark:text-orange-400",
  late_early: "text-orange-600 dark:text-orange-400",
  half_day: "text-yellow-600 dark:text-yellow-400",
  insufficient: "text-red-600 dark:text-red-400",
  absent: "text-red-600 dark:text-red-400",
  half_day_leave: "text-yellow-600 dark:text-yellow-400",
  worked_off_day: "text-violet-600 dark:text-violet-400",
  on_leave: "text-brand-neutral-500 dark:text-brand-neutral-400",
  holiday: "text-violet-600 dark:text-violet-400",
  untracked: "text-muted-foreground",
};
const upper = (s?: string) => (s ?? "").toUpperCase();
const parseYmd = (s: string) => Date.parse(s.slice(0, 10) + "T00:00:00Z");
// Format an ISO "YYYY-MM-DD" as "dd/mm/yyyy" for tooltips.
const dmy = (s?: string) => {
  if (!s) return "";
  const [y, m, d] = s.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
};
const MON = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// Compact leave date range: same month -> "January 1 – 10"; crossing months -> "January 15 – February 20"; single day -> "January 1".
const leaveRange = (s: string, e: string) => {
  const [ay, am, ad] = s.slice(0, 10).split("-").map(Number);
  const [by, bm, bd] = e.slice(0, 10).split("-").map(Number);
  const start = `${MON[am - 1]} ${ad}`;
  if (ay === by && am === bm) return ad === bd ? start : `${start} – ${bd}`;
  return `${start} – ${MON[bm - 1]} ${bd}`;
};
// Relative ETA phrase from a whole-day offset (0 = today): "Today", "Tomorrow", "Yesterday", "in N days",
// "N days ago".
const relFromDays = (n: number): string =>
  n === 0 ? "Today" : n === 1 ? "Tomorrow" : n === -1 ? "Yesterday" : n > 0 ? `in ${n} days` : `${-n} days ago`;
// Relative ETA for a calendar date vs the ORG's today - the same clock the grid's columns are anchored on
// (`todayStr()`), and the same unit (a UTC-midnight calendar day, which is what `parseYmd` produces).
//
// It used to read the UTC calendar off `Date.now()`, which for an IST org is still yesterday between 00:00
// and 05:30 - so every tooltip on the widget was a day out for the first five and a half hours of the day:
// the attendance dot in the column RINGED AS TODAY said "Tomorrow", leave starting tomorrow read "in 2 days",
// a probation ending today read "Tomorrow". And the two clocks sat side by side, because the per-column
// "N away" tooltip already used `todayCol` and was org-anchored.
const relDay = (ymd?: string): string =>
  ymd ? relFromDays(Math.round((parseYmd(ymd) - Date.parse(`${todayStr()}T00:00:00Z`)) / DAY_MS)) : "";

// UTC midnight of the Sunday that starts the week containing the calendar day `ymd`.
//
// Takes a DAY, not an instant. It used to take `Date.now()` and read the UTC calendar off it, so for an IST org
// the week rolled over 5½ hours late: between 00:00 and 05:30 the timeline's "this week" was still last week's
// window while `todayStr()` - which every other surface uses, including the `min` on the request dialog this
// timeline opens - had already moved on. The columns are still UTC-anchored days (which is what makes
// `toISOString().slice(0, 10)` the right way to hand a column to the leave dialog); only the clock that decides
// WHICH days changed.
function weekStartUtc(ymd: string): number {
  const u = Date.parse(`${ymd}T00:00:00Z`);
  return u - new Date(u).getUTCDay() * DAY_MS;
}

// Confetti behind a celebrating person's name cell - the supplied confetti.svg sprinkle artwork, stretched to
// fill the cell. Purely decorative + pointer-events-none; the avatar/name (static, later in the DOM) sit above.
function ConfettiBg() {
  return (
    <img
      src={confettiUrl}
      aria-hidden
      alt=""
      className="pointer-events-none absolute inset-0 h-full w-full object-cover"
    />
  );
}

export function TeamTimeline({ me, employees, leaves, leaveTypes, holidays, celebrations, events = [], schedule = DEFAULT_SCHEDULE, hiddenMarkers = [], refreshKey = 0, onCollapse }: {
  me: Me;
  employees: Employee[];
  leaves: LeaveRequest[];
  leaveTypes: LeaveType[];
  holidays: Holiday[];
  celebrations: Celebration[];
  events?: Event[]; // org events; each marks its attendees unavailable for its date range
  schedule?: AttendanceSchedule; // org work schedule; drives non-working shading + per-day attendance status
  hiddenMarkers?: string[]; // marker categories the viewer's role may not see (from the dashboard role config)
  refreshKey?: number; // bump to force an attendance re-fetch (e.g. after the dashboard clock in/out)
  onCollapse?: () => void; // when the host can fold the widget away, the header draws the fold control
}) {
  // Memoized because five memos below depend on it: the fallback is a fresh array literal every render, so
  // as a bare const it changed identity on each pass and every memo keyed to it recomputed - the timeline's
  // segment building among them, which is the expensive one on this widget.
  const workDays = useMemo(() => (schedule.work_days?.length ? schedule.work_days : [1, 2, 3, 4, 5]), [schedule.work_days]);
  // Phone layout fork: narrower name column, wider day cells (see NAME_COL_SM / DAY_MIN_SM).
  const isPhone = useMedia("(max-width: 767px)");
  const nameCol = isPhone ? NAME_COL_SM : NAME_COL;
  // Working-hours window (org tz) so a timed event lands at its time-of-day INSIDE its column instead of
  // spanning the whole day: shift_start -> 0.0, shift_end -> 1.0 of the column, clamped. (A 2pm lunch in a
  // 9-6 day -> ~0.56, just right of centre.)
  const shiftMin = (s: string) => { const [h, m] = (s || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
  const shiftStart = shiftMin(schedule.shift_start);
  const shiftSpan = Math.max(1, shiftMin(schedule.shift_end) - shiftStart);
  const dayFrac = (iso: string) => Math.min(1, Math.max(0, (localMinutes(iso, schedule.timezone) - shiftStart) / shiftSpan));
  const [page, setPage] = useState(0); // 0 = this week + next week (current week on the left); ± pages by 14 days
  const [showPending, setShowPending] = useState(true); // toggle: draw pending (not-yet-approved) leave as dashed pills
  // Start at the beginning of the current week, so the default window is the current week followed by next week.
  const orgToday = todayStr();
  const startMs = useMemo(() => weekStartUtc(orgToday) + page * DAYS * DAY_MS, [orgToday, page]);
  const endMs = startMs + DAYS * DAY_MS - 1;

  // Attendance sessions for the visible window (re-fetched on page change). Scoped server-side to the caller's
  // attendance visibility, so it stays empty if they can't read attendance.
  // THE CURSOR IS FOLLOWED, through the helper written for exactly this shape (lib/clock.tsx). A bare `get`
  // takes the server's default page of 50, most-recent-first, for a window of 14 days x every employee the
  // caller can see - which two punches a day exhausts at about four people. Everything past the newest 50 was
  // simply absent from `sessions`, and a past working day with no session, no leave and no holiday classifies
  // as `absent`: a red "No log" dot against people who did clock in, filling the older half of the timeline
  // on the Dashboard, and never recoverable by paging back (the refetch truncated the same way).
  const [sessions, setSessions] = useState<AttendanceSession[]>([]);
  // ...and when even that walk stops on its ten-page ceiling, `absent` is suppressed below rather than
  // printed: a missing session reads as an accusation, so a gap this widget did not load must not be one.
  const [sessionsTruncated, setSessionsTruncated] = useState(false);
  useEffect(() => {
    let live = true;
    const q = `attendance?from=${encodeURIComponent(new Date(startMs).toISOString())}&to=${encodeURIComponent(new Date(endMs).toISOString())}`;
    listAllSessionsPaged(q)
      .then((r) => { if (live) { setSessions(r.sessions); setSessionsTruncated(r.truncated); } })
      .catch(() => { if (live) { setSessions([]); setSessionsTruncated(false); } });
    return () => { live = false; };
  }, [startMs, endMs, refreshKey]);

  // Approved late arrivals / early departures in the window: each moves its day's start or end, so a dot for a
  // day somebody was approved to start late does not say "late" about the approved part. Gated like every
  // collection read - a caller who cannot see these requests fires nothing and sees the org's window.
  const { rows: lateEarly } = useCollection<LateEarlyRequest>("late-early-requests", {
    all: true,
    params: { from: new Date(startMs).toISOString().slice(0, 10), to: new Date(endMs).toISOString().slice(0, 10), state: "APPROVED" },
  });
  const excusalsByEmp = useMemo(() => excusalsByEmployee(lateEarly), [lateEarly]);
  const punctuality = usePunctualityPolicy();

  // Org policy: when back-dating is disallowed, past columns are non-selectable for self-service (mirrors the
  // server gate in createLeaveRequest).
  const [allowBackdated, setAllowBackdated] = useState(true);
  useEffect(() => {
    let live = true;
    getSetting<{ allow_backdated?: boolean }>("leave-requests")
      .then((r) => { if (live && typeof r.value?.allow_backdated === "boolean") setAllowBackdated(r.value.allow_backdated); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  // Which marker categories this viewer's role may see is decided by the dashboard's role config and passed in
  // as `hiddenMarkers` (the categories to hide). Leaves/holidays/weekends are the core schedule, never gated.
  const showCat = (k: string) => !hiddenMarkers.includes(k);
  const cols = useMemo(() => Array.from({ length: DAYS }, (_, i) => new Date(startMs + i * DAY_MS)), [startMs]);
  // `useCallback`: four memos below map instants onto columns with this, and its identity moves with the
  // window's start - which is exactly what those memos were restating as `startMs` by hand.
  const colOf = useCallback((ms: number) => Math.floor((ms - startMs) / DAY_MS), [startMs]);
  const inWindow = (ms: number) => ms >= startMs && ms <= endMs;
  const now = new Date();
  const todayYmd = orgToday; // the ORG's day; the UTC one this replaced disagreed for part of every day
  // Off the same clock as the window's anchor, so the "today" column and the window can't disagree.
  const todayCol = colOf(Date.parse(`${todayYmd}T00:00:00Z`));
  // Current time as a fraction of the working day (org tz) - places the live "now" line inside today's column.
  const nowFrac = Math.min(1, Math.max(0, (localMinutes(now.toISOString(), schedule.timezone) - shiftStart) / shiftSpan));

  // Per-type leave colours are an HR/admin affordance: distinct colours surface the leave-type breakdown to
  // those who manage leave types (leave-types.write -> HR + super; not employees/managers). Everyone else
  // sees a single neutral leave colour for every type. Derived from the caller's grant, so it follows the ACL
  // (grant leave-types.write to someone and they get the breakdown too) - no role names, no hardcoded policy.
  const distinctLeaveColors = usePermission("leave-types.write");

  // Leave type lookup + colour (its configured hex, else a stable fallback). Keyed by leave-type id. Without
  // the breakdown affordance, every leave type resolves to the single neutral colour.
  const typeById = useMemo(() => new Map(leaveTypes.map((t) => [idOf(t.path), t] as const)), [leaveTypes]);
  const activeLeaveTypes = useMemo(() => leaveTypes.filter((t) => !t.delete_time && !t.disabled), [leaveTypes]);
  const unpaidTypes = useMemo(() => unpaidLeaveTypes(leaveTypes), [leaveTypes]);
  const colorOf = (leaveTypeRef?: string) => {
    if (!distinctLeaveColors) return ONE_LEAVE_COLOR;
    const id = leaveTypeRef ? idOf(leaveTypeRef) : "";
    return leaveColor(typeById.get(id)?.color, id);
  };

  const holByCol = useMemo(() => {
    const m = new Map<number, Holiday>();
    for (const h of holidays) { const c = colOf(parseYmd(h.date)); if (c >= 0 && c < DAYS) m.set(c, h); }
    return m;
  }, [holidays, colOf]);

  const leavesByEmp = useMemo(() => {
    const m = new Map<string, LeaveRequest[]>();
    for (const l of leaves) {
      if (!l.employee || upper(l.state) !== "APPROVED") continue; // timeline shows approved leave only
      const k = idOf(l.employee);
      const arr = m.get(k);
      if (arr) arr.push(l); else m.set(k, [l]);
    }
    return m;
  }, [leaves]);
  // Pending (not-yet-approved) leave, kept apart from approved so it drives the dashed pills + drag barriers
  // WITHOUT counting toward attendance status (which is approved-leave only).
  const pendingByEmp = useMemo(() => {
    const m = new Map<string, LeaveRequest[]>();
    for (const l of leaves) {
      if (!l.employee || upper(l.state) !== "PENDING") continue;
      const k = idOf(l.employee);
      const arr = m.get(k);
      if (arr) arr.push(l); else m.set(k, [l]);
    }
    return m;
  }, [leaves]);

  // Events the employee attends, keyed by employee id (an event lists its attendee employee refs).
  const eventsByEmp = useMemo(() => {
    const m = new Map<string, Event[]>();
    for (const ev of events) {
      for (const a of ev.attendees ?? []) {
        const k = idOf(a);
        const arr = m.get(k);
        if (arr) arr.push(ev); else m.set(k, [ev]);
      }
    }
    return m;
  }, [events]);
  const eventColor = (ev: Event) => ev.color || "#6366f1"; // indigo fallback

  // Whose day is what, across the window this timeline draws. The event-credit block below mirrors the
  // server's `eventCreditByDay`, which reads the day's own full-day minutes - so this has to as well, or a
  // four-hour day gets credited eight here and the timeline shows a day as covered that payroll docks.
  const schedView = useScheduleView(
    schedule,
    new Date(startMs).toISOString().slice(0, 10),
    new Date(endMs).toISOString().slice(0, 10),
  );

  // Per-employee, per-day attendance status across the window (present/late/half-day/absent/open). Reuses the
  // Attendance page's derivation (schedule + holidays + approved leave). Keyed by employee id -> day -> status.
  const statusByEmp = useMemo(() => {
    const fromYmd = new Date(startMs).toISOString().slice(0, 10);
    const toYmd = new Date(endMs).toISOString().slice(0, 10);
    const t = new Date();
    const nowMs = t.getTime();
    const todayYmd = todayStr();
    const holSet = new Set(holidays.filter((h) => !h.disabled && h.applies !== false).map((h) => h.date.slice(0, 10)));
    const byEmp = new Map<string, AttendanceSession[]>();
    for (const s of sessions) {
      if (!s.employee) continue;
      const k = idOf(s.employee);
      (byEmp.get(k) ?? byEmp.set(k, []).get(k)!).push(s);
    }
    const out = new Map<string, Map<string, AttendanceRow>>();
    for (const e of employees) {
      const eid = idOf(e.path);
      const schedOf = schedView.of(eid);
      // Don't flag days before the employee joined as a missing log.
      const empFrom = e.start_date && e.start_date.slice(0, 10) > fromYmd ? e.start_date.slice(0, 10) : fromYmd;
      if (empFrom > toYmd) continue;
      // The session flags come along, so a half-day leave reads as half a day here too rather than as a day
      // fully excused (see lib/attendance.ts `leaveRanges`) - and so does whether the leave is paid, so unpaid
      // leave reads here the way payroll docks it.
      const leaveRanges = (leavesByEmp.get(eid) ?? []).map((l) => leaveRangeOf({ ...l, start_date: l.start_date.slice(0, 10), end_date: l.end_date.slice(0, 10) }, unpaidTypes));
      const summaries = summarizeByDay(byEmp.get(eid) ?? [], schedule, { excusals: excusalsByEmp.get(eid), policy: punctuality.attendance, leaveRanges });
      const punchedDays = new Set(summaries.map((s) => s.day)); // days the employee actually clocked in
      const onLeaveDay = (day: string) => leaveRanges.some((r) => r.start <= day && day <= r.end);
      // Split the employee's events: count-as-work events credit per-day worked minutes; the rest just mark
      // Only count_as_work events touch attendance, and only as credited minutes: an event that doesn't count
      // as work leaves the day exactly as it was, so an attendee who never punched is absent (and docked).
      // An all-day work event (off-site) credits every attendee a full day; a timed one credits the day's
      // overlap with the event window (capped at a full day). Credit lands once the event has ended, and -
      // when the event requires a clock-in (e.g. a team lunch they punched out for) - only for attendees who
      // were actually at work that day. Never for on-leave attendees. Mirrors eventCreditByDay in
      // src/domain/attendance.ts, which is what payroll charges LOP from; keep the two in step.
      const workMinutesByDay = new Map<string, number>();
      for (const ev of eventsByEmp.get(eid) ?? []) {
        if (!ev.count_as_work) continue;
        if (!ev.all_day && +new Date(ev.end_time) >= nowMs) continue; // timed event still running / upcoming
        const sDay = ev.all_day ? ev.start_time.slice(0, 10) : localDay(ev.start_time, schedule.timezone);
        const eDay = ev.all_day ? ev.end_time.slice(0, 10) : localDay(ev.end_time, schedule.timezone);
        for (const day of enumerateDays(sDay, eDay)) {
          const ds = schedOf(day);
          if (ds.off) continue; // credit days this person was scheduled on only
          if (ev.all_day && day >= todayYmd) continue; // all-day: only days that have fully ended
          if (ev.requires_clock_in && !punchedDays.has(day)) continue; // credit only those actually at work
          if (onLeaveDay(day)) continue; // never credit an on-leave attendee
          let m: number;
          if (ev.all_day) m = ds.fullDayMinutes;
          else if (sDay === eDay) m = localMinutes(ev.end_time, schedule.timezone) - localMinutes(ev.start_time, schedule.timezone);
          else if (day === sDay) m = 1440 - localMinutes(ev.start_time, schedule.timezone);
          else if (day === eDay) m = localMinutes(ev.end_time, schedule.timezone);
          else m = 1440;
          m = Math.min(ds.fullDayMinutes, Math.max(0, m));
          workMinutesByDay.set(day, (workMinutesByDay.get(day) ?? 0) + m);
        }
      }
      const rows = buildAttendanceRows({ fromYmd: empFrom, toYmd, todayYmd, schedOf, summaries, holidays: holSet, leaveRanges, workMinutesByDay, trackedFromYmd: trackedFromOf(e) });
      // A gap this widget did not load is not an absence. When the session walk stopped on its page ceiling,
      // the `absent` days are dropped rather than drawn: a blank cell says "nothing to show", the red "No
      // log" dot says "this person did not come in", and only one of those is knowable here.
      const shown = sessionsTruncated ? rows.filter((r) => r.status !== "absent") : rows;
      out.set(eid, new Map(shown.map((r) => [r.day, r] as const)));
    }
    return out;
  }, [sessions, sessionsTruncated, employees, leavesByEmp, eventsByEmp, excusalsByEmp, punctuality, holidays, schedule, schedView, startMs, endMs, unpaidTypes]);

  // Styled tooltip card for an attendance day: a colored status header, the punch times / hours worked, and
  // late-arrival / early-departure chips (kept even when flexible hours count the day as full).
  const tz = schedule.timezone;
  const personOf = (e: Employee): TipPerson => ({ id: idOf(e.path), name: `${e.first_name} ${e.last_name}`, photo: e.photo });
  const attendanceTip = (person: TipPerson, row: AttendanceRow): ReactNode => {
    const s = row.summary;
    const head = { person, dot: STATUS_DOT[row.status] ?? "bg-muted-foreground", title: STATUS_LABEL[row.status], accent: STATUS_TEXT[row.status], eta: relDay(row.day) };
    // No punch but minutes on the day -> the time was credited by a count-as-work event.
    if (s && !s.arrival && s.workedMinutes > 0) return <TipCard {...head}><TipRow icon={CalendarRange}>{fmtDuration(s.workedMinutes)} credited from an event</TipRow></TipCard>;
    if (!s || !s.arrival) return <TipCard {...head}><TipRow>No punches recorded.</TipRow></TipCard>;
    if (s.open) return <TipCard {...head}><TipRow icon={Clock}>In at {fmtHM(s.arrival, tz)}</TipRow></TipCard>;
    return (
      <TipCard {...head}>
        <TipRow icon={Clock}>{fmtHM(s.arrival, tz)} – {s.departure ? fmtHM(s.departure, tz) : "-"}</TipRow>
        <TipRow>{fmtDuration(s.workedMinutes)} worked</TipRow>
        {(s.approvedLateUntil != null || s.approvedEarlyFrom != null) && (
          <TipRow icon={Clock}>
            Approved {[s.approvedLateUntil != null ? `in by ${hhmmOf(s.approvedLateUntil)}` : null, s.approvedEarlyFrom != null ? `out at ${hhmmOf(s.approvedEarlyFrom)}` : null].filter(Boolean).join(", ")}
          </TipRow>
        )}
        {(s.late || s.leftEarly) && (
          <TipChips>
            {s.late && <TipChip tone="bg-amber-500/15 text-amber-700 dark:text-amber-300">{fmtDuration(s.lateByMin)} late</TipChip>}
            {s.leftEarly && <TipChip tone="bg-amber-500/15 text-amber-700 dark:text-amber-300">left {fmtDuration(s.earlyByMin)} early</TipChip>}
          </TipChips>
        )}
      </TipCard>
    );
  };
  const holidayTip = (h: Holiday): ReactNode => (
    <TipCard icon={CalendarDays} iconClass="text-violet-500" title={h.display_name} accent="text-violet-600 dark:text-violet-400" eta={relDay(h.date)}>
      <TipRow>Company holiday</TipRow>
    </TipCard>
  );
  const leaveTip = (person: TipPerson, l: LeaveRequest): ReactNode => {
    const t = typeById.get(l.leave_type ? idOf(l.leave_type) : "");
    const start = l.start_date.slice(0, 10), end = l.end_date.slice(0, 10);
    const todayY = todayStr();
    const eta = todayY < start ? relDay(start) : todayY <= end ? "Ongoing" : relDay(end);
    const pending = upper(l.state) === "PENDING";
    return (
      <TipCard person={person} dotColor={colorOf(l.leave_type)} title={`${t?.display_name ?? "Leave"}${pending ? " · Pending" : ""}`} eta={eta}>
        <TipRow icon={CalendarDays}>{leaveRange(l.start_date, l.end_date)}</TipRow>
        <TipRow>{l.days} day{l.days === 1 ? "" : "s"}</TipRow>
      </TipCard>
    );
  };
  const celebrationTip = (person: TipPerson, c: Celebration): ReactNode => (
    <TipCard
      person={person}
      icon={c.kind === "birthday" ? Cake : PartyPopper}
      iconClass={c.kind === "birthday" ? "text-pink-500" : "text-amber-500"}
      title={c.kind === "birthday" ? "Birthday" : "Work anniversary"}
      accent="text-foreground"
      eta={relFromDays(c.in_days)}
    >
      {c.kind === "anniversary" && c.years ? <TipRow>{c.years} year{c.years === 1 ? "" : "s"}</TipRow> : null}
    </TipCard>
  );
  const eventTip = (ev: Event): ReactNode => {
    const sameDay = ev.start_time.slice(0, 10) === ev.end_time.slice(0, 10);
    const when = ev.all_day
      ? (sameDay ? dmy(ev.start_time) : `${dmy(ev.start_time)} – ${dmy(ev.end_time)}`)
      : sameDay
        ? `${dmy(ev.start_time)}, ${fmtHM(ev.start_time, tz)} – ${fmtHM(ev.end_time, tz)}`
        : `${dmy(ev.start_time)} ${fmtHM(ev.start_time, tz)} – ${dmy(ev.end_time)} ${fmtHM(ev.end_time, tz)}`;
    return (
      <TipCard icon={CalendarRange} iconClass="text-indigo-500" dotColor={eventColor(ev)} title={ev.title} accent="text-indigo-600 dark:text-indigo-400" eta={relDay(ev.start_time)}>
        <TipRow icon={CalendarDays}>{when}</TipRow>
        {ev.count_as_work ? <TipRow icon={Clock}>Counts as worked time</TipRow> : null}
        {ev.description ? <TipRow>{ev.description}</TipRow> : null}
      </TipCard>
    );
  };

  const celebsByEmp = useMemo(() => {
    const m = new Map<string, Celebration[]>();
    for (const c of celebrations) { const k = idOf(c.employee); const arr = m.get(k); if (arr) arr.push(c); else m.set(k, [c]); }
    return m;
  }, [celebrations]);

  // Day-unit span [lu, ru) for each leave (half-day boundaries shave 0.5 off the start/end day); clamped to
  // the visible window. Shared by approved + pending pill rows.
  const toSegs = useCallback((list: LeaveRequest[]) =>
    list
      .map((l) => ({ l, aRaw: colOf(parseYmd(l.start_date)), bRaw: colOf(parseYmd(l.end_date)) }))
      .filter((s) => s.bRaw >= 0 && s.aRaw < DAYS)
      .map(({ l, aRaw, bRaw }) => {
        const a = Math.max(0, aRaw), b = Math.min(DAYS - 1, bRaw);
        const ss = l.start_session ?? 1, es = l.end_session ?? 2;
        let lu = a, ru = b + 1;
        if (aRaw === bRaw) {
          if (ss === 1 && es === 1) ru = a + 0.5; // morning -> left half
          else if (ss === 2 && es === 2) lu = a + 0.5; // afternoon -> right half
        } else {
          if (ss === 2 && aRaw >= 0) lu = a + 0.5; // first day starts after lunch
          if (es === 1 && bRaw <= DAYS - 1) ru = b + 1 - 0.5; // last day ends at lunch
        }
        return { l, lu, ru };
      }), [colOf]);

  // Break a leave's [lu, ru) day-span into contiguous runs of COUNTED days, skipping weekend/holiday columns
  // (isOff). This lets the pill render as separate bars over those columns so the weekend/holiday cell - and
  // its separator - stays visually untouched by the leave.
  const splitRuns = (lu: number, ru: number, isOff: (i: number) => boolean): [number, number][] => {
    const bars: [number, number][] = [];
    let s: number | null = null, e = 0;
    for (let i = Math.floor(lu); i < Math.ceil(ru); i++) {
      const cl = Math.max(i, lu), cr = Math.min(i + 1, ru);
      if (cr <= cl) continue; // this column isn't covered by the leave
      if (isOff(i)) { if (s !== null) { bars.push([s, e]); s = null; } continue; }
      if (s === null) s = cl;
      e = cr;
    }
    if (s !== null) bars.push([s, e]);
    return bars;
  };

  // The people still here (lib/employees.ts), with the caller's own row hoisted to the top (drag-to-request
  // lives there).
  const rows = useMemo(() => {
    const live = employees.filter(isCurrentEmployee);
    return live.sort((a, b) => Number(idOf(b.path) === me.employee_id) - Number(idOf(a.path) === me.employee_id));
  }, [employees, me.employee_id]);

  // Pending leaves that land inside the visible window - the count on the header's "Pending leave" toggle, so
  // the chip says how much it is hiding before you press it.
  const pendingInView = useMemo(
    () => rows.reduce((n, e) => n + toSegs(pendingByEmp.get(idOf(e.path)) ?? []).length, 0),
    [rows, pendingByEmp, toSegs],
  );

  // Per-day team load: who's away (approved leave or at an event) on each visible day. Drives the "N away"
  // chip under each header date - the at-a-glance crunch-day signal - and its who-is-it tooltip.
  const awayByCol = useMemo(() => {
    const m = new Map<number, { id: string; name: string; why: string }[]>();
    const add = (col: number, entry: { id: string; name: string; why: string }) => {
      if (col < 0 || col >= DAYS) return;
      const arr = m.get(col);
      if (arr) { if (!arr.some((x) => x.id === entry.id)) arr.push(entry); } else m.set(col, [entry]);
    };
    for (const e of rows) {
      const eid = idOf(e.path);
      const name = `${e.first_name} ${e.last_name}`;
      for (const l of leavesByEmp.get(eid) ?? []) {
        const a = colOf(parseYmd(l.start_date)), b = colOf(parseYmd(l.end_date));
        for (let i = Math.max(0, a); i <= Math.min(DAYS - 1, b); i++) add(i, { id: eid, name, why: "on leave" });
      }
      for (const ev of eventsByEmp.get(eid) ?? []) {
        if (ev.count_as_work) continue; // working off-site, not away
        const a = colOf(parseYmd(ev.all_day ? ev.start_time : localDay(ev.start_time, schedule.timezone)));
        const b = colOf(parseYmd(ev.all_day ? ev.end_time : localDay(ev.end_time, schedule.timezone)));
        for (let i = Math.max(0, a); i <= Math.min(DAYS - 1, b); i++) add(i, { id: eid, name, why: ev.title });
      }
    }
    return m;
  }, [rows, leavesByEmp, eventsByEmp, colOf, schedule.timezone]);
  // Columns already covered by the caller's own leave. Unlike weekends/holidays these are hard barriers a
  // drag can't cross: a selection started before a leave clamps to the day just before it (see onMove).
  const leaveCols = useMemo(() => {
    const set = new Set<number>();
    if (me.employee_id) for (const l of [...(leavesByEmp.get(me.employee_id) ?? []), ...(pendingByEmp.get(me.employee_id) ?? [])]) {
      const a = Math.max(0, colOf(parseYmd(l.start_date))), b = Math.min(DAYS - 1, colOf(parseYmd(l.end_date)));
      for (let i = a; i <= b; i++) set.add(i);
    }
    return set;
  }, [leavesByEmp, pendingByEmp, me.employee_id, colOf]);
  // Columns the caller can't request against: weekends/holidays + past (when back-dating is off) + own leave.
  // Drag, hover and selection are all suppressed on these.
  const blockedCols = useMemo(() => {
    const set = new Set<number>(leaveCols);
    cols.forEach((d, i) => {
      if (holByCol.has(i) || !workDays.includes(d.getUTCDay())) set.add(i);
      if (!allowBackdated && i < todayCol) set.add(i); // back-dating disallowed -> past days are off-limits
    });
    return set;
  }, [cols, holByCol, workDays, leaveCols, allowBackdated, todayCol]);

  // Per-day column WEIGHT: weekends and holidays are shrunk to WEEKEND_W of a working day's width. The day
  // tracks are proportional `fr` units of these weights, and every overlay bar/marker is positioned by the
  // SAME cumulative weights (pctAt), so the calendar stays aligned at any width even though columns differ.
  const dayWeight = useMemo(
    () => cols.map((d, i) => (holByCol.has(i) || !workDays.includes(d.getUTCDay()) ? WEEKEND_W : 1)),
    [cols, holByCol, workDays],
  );
  const totalWeight = useMemo(() => dayWeight.reduce((s, w) => s + w, 0), [dayWeight]);
  // Cumulative weight at the START of each day index (length DAYS+1; cumWeight[DAYS] === totalWeight).
  const cumWeight = useMemo(() => {
    const o = [0];
    for (const w of dayWeight) o.push(o[o.length - 1] + w);
    return o;
  }, [dayWeight]);
  // % across the day area at fractional day position x (0..DAYS); a half-day lands at half that day's weight.
  const pctAt = (x: number) => {
    const i = Math.floor(x);
    const whole = cumWeight[Math.min(i, DAYS)]!;
    const frac = i < DAYS ? (x - i) * dayWeight[i]! : 0;
    return ((whole + frac) / totalWeight) * 100;
  };

  const gridCols = { gridTemplateColumns: `${nameCol}px ${dayWeight.map((w) => `${w}fr`).join(" ")}` } as const;
  // Scroll width = the name column + every day column at its minimum. Weight-driven, so a week full of
  // holidays (half-width columns) narrows the scroller instead of stretching the working days.
  const gridMin = { minWidth: nameCol + Math.ceil(totalWeight * (isPhone ? DAY_MIN_SM : DAY_MIN)) } as const;
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const rangeLabel = `${fmt(cols[0])} – ${fmt(cols[DAYS - 1])}`;

  // Shared per-column background so each day reads as one vertical band across header + every row.
  // Holiday (violet) wins over weekend/non-working (slate); working days stay clear.
  // Drag (or click) across day cells to mark a date range; on release it opens the leave-request dialog
  // prefilled for those dates. Selecting columns reads as "pick these dates" - it requests the viewer's own
  // leave, regardless of which row was dragged on.
  // Selection endpoints are half-slots: halfIndex = dayCol*2 + s, where s = 0 (morning / first half) or 1
  // (afternoon / second half), chosen by which half of the column the pointer is over. Clicking one half marks
  // a half-day; dragging across both halves of a day (or further) marks full days with half-day edges.
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null);
  // The half the pointer is over while NOT dragging - drives a faint pre-selection hover highlight.
  const [hover, setHover] = useState<{ col: number; half: number } | null>(null);
  // On release, the selection opens the request dialog inline (we navigate to Leaves only after submit).
  const [draft, setDraft] = useState<LeaveDraft | null>(null);
  const [dlgOpen, setDlgOpen] = useState(false);
  const halfAt = (ev: ReactMouseEvent<HTMLElement>) => {
    const r = ev.currentTarget.getBoundingClientRect();
    return ev.clientX - r.left < r.width / 2 ? 0 : 1;
  };
  // Effective day/half range from the selection endpoints (a single half-slot = a half-day).
  // `useCallback` on `sel`, because the mouseup handler below is registered from an effect: an arrow rebuilt
  // every render made the effect's dependency array a hand-written claim about what the handler reads, and
  // the handler is what turns a drag into a leave request - it must read the selection this render has.
  const effRange = useCallback(() => {
    if (!sel) return null;
    const lo = Math.min(sel.a, sel.b), hi = Math.max(sel.a, sel.b);
    return { loDay: Math.floor(lo / 2), loHalf: lo % 2, hiDay: Math.floor(hi / 2), hiHalf: hi % 2 };
  }, [sel]);
  // The selected portion of column i as % insets (null when unselected); a boundary half-day insets by 50%.
  const selSpan = (i: number) => {
    const r = effRange();
    if (!r || i < r.loDay || i > r.hiDay) return null;
    return {
      left: i === r.loDay && r.loHalf === 1 ? "50%" : "0%",
      right: i === r.hiDay && r.hiHalf === 0 ? "50%" : "0%",
    };
  };
  useEffect(() => {
    if (!sel) return;
    const finish = () => {
      const r = effRange();
      setSel(null);
      if (!r) return;
      const ymdOf = (dt: Date) => dt.toISOString().slice(0, 10);
      setDraft({
        from: ymdOf(cols[r.loDay]!),
        to: ymdOf(cols[r.hiDay]!),
        startSession: r.loHalf === 1 ? 2 : 1,
        endSession: r.hiHalf === 0 ? 1 : 2,
      });
      setDlgOpen(true);
    };
    // `pointerup` (and `pointercancel`, which is how a touch drag ends when the browser takes the gesture over)
    // rather than `mouseup`: a touch drag never produces one.
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [sel, cols, effRange]);

  const colBg = (i: number, d: Date) => {
    if (holByCol.get(i)) return "bg-violet-100/70 dark:bg-violet-950/30";
    if (!workDays.includes(d.getUTCDay())) return "bg-brand-neutral-100/80 dark:bg-brand-neutral-800/40";
    return "";
  };
  // The half-aware overlay drawn inside a (relative) day cell - header and every row use it. While dragging it
  // shows the selected fill; otherwise a fainter hint on just the hovered half.
  const selOverlay = (i: number, isSelf = false, blocked = false) => {
    if (!isSelf || blocked) return null;
    const s = selSpan(i);
    if (s) return <span className="pointer-events-none absolute inset-y-0 z-0 bg-primary/25 dark:bg-primary/40" style={{ left: s.left, right: s.right }} />;
    if (!sel && hover && hover.col === i) {
      const left = hover.half === 1 ? "50%" : "0%";
      const right = hover.half === 0 ? "50%" : "0%";
      return <span className="pointer-events-none absolute inset-y-0 z-0 bg-primary/10 dark:bg-primary/20" style={{ left, right }} />;
    }
    return null;
  };

  // Legend, shown from the header's info button (was an inline strip below the grid). Three groups
  // (leaves + holidays / events + markers / attendance), stacked with dividers to fit the tooltip card.
  const legendCard = (
    <div className="w-56 space-y-2 p-1 text-xs text-muted-foreground">
      <div className="flex flex-col gap-1.5">
        {distinctLeaveColors && activeLeaveTypes.length ? (
          activeLeaveTypes.map((t) => (
            <span key={t.path} className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: leaveColor(t.color, idOf(t.path)) }} /> {t.display_name}</span>
          ))
        ) : (
          <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-5 rounded-full" style={{ backgroundColor: ONE_LEAVE_COLOR }} /> Leave</span>
        )}
        <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-5 rounded-full border border-dashed border-muted-foreground" /> Leave awaiting approval</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-4 w-3 rounded-[2px] bg-violet-200 dark:bg-violet-900" /> Holiday</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-4 w-3 rounded-[2px] bg-brand-neutral-200 dark:bg-brand-neutral-700" /> Weekend</span>
      </div>
      <div className="flex flex-col gap-1.5 border-t pt-2">
        {showCat("events") && <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-5 rounded border border-l-[3px] border-indigo-500" /> Event</span>}
        {showCat("birthdays") && <span className="flex items-center gap-1.5"><Cake className="h-3.5 w-3.5 text-pink-500" /> Birthday</span>}
        {showCat("anniversaries") && <span className="flex items-center gap-1.5"><PartyPopper className="h-3.5 w-3.5 text-amber-500" /> Anniversary</span>}
        {showCat("joiners") && <span className="flex items-center gap-1.5"><UserPlus className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" /> New joiner</span>}
        {showCat("probation") && <span className="flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" /> Probation ends</span>}
      </div>
      <div className="flex flex-col gap-1.5 border-t pt-2">
        <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-400" /> Full day</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full bg-sky-400" /> Clocked in</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full bg-yellow-400" /> Half day</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full bg-orange-400" /> Late / early</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full bg-red-400" /> No log</span>
      </div>
    </div>
  );

  return (
    <TooltipProvider delayDuration={150}>
    <Card>
      {/* Below `sm` the title takes its own line and the controls take theirs - the control cluster is
          ~250px of buttons that cannot wrap away, so sharing a line with it would squeeze the title into a
          mid-phrase break. The single row returns from `sm` up, where both fit. The controls line itself
          never wraps: pending toggle, legend and the week nav stay one row, bought with tighter padding and
          gaps below `sm` (the header's own too). The toggle is the one flexible item - if a screen is still
          too narrow for all three, its label truncates rather than the row breaking apart.
          Where the widget folds, the whole header is the fold target - anything interactive inside it
          (buttons, tooltip triggers, the access affordance) opts out via the `closest` guard. */}
      <CardHeader
        className={cn("flex-col items-start gap-2 space-y-0 px-3 pb-2 pt-3 sm:flex-row sm:items-center sm:justify-between sm:gap-2 sm:p-6", onCollapse && "cursor-pointer")}
        onClick={onCollapse ? (ev) => { if (!(ev.target as HTMLElement).closest("button,a,[role='button'],input,select")) onCollapse(); } : undefined}
      >
        <div className="flex w-full min-w-0 items-baseline gap-2 sm:w-auto">
          <CardTitle className="text-base">
            <AccessAction collection="timeline" label="Team timeline">
              <span className="flex items-center gap-2"><CalendarRange className="h-4 w-4 shrink-0 text-primary" /> <span className="whitespace-nowrap">Team timeline</span></span>
            </AccessAction>
          </CardTitle>
          <span className="hidden text-xs text-muted-foreground lg:inline">· click a half-day or drag to request leave</span>
          {/* Fold control (phones): the host mounts the widget on open, so folding it away also stops paying
              for its attendance fan-out. Sits on the title line, opposite the title, where the header's own
              control cluster can't push it off. */}
          {onCollapse && (
            <Button variant="ghost" size="icon" className="relative -top-1 -my-1 ml-auto h-7 w-7 shrink-0 self-center text-muted-foreground" onClick={onCollapse} aria-label="Hide team timeline" title="Hide team timeline">
              <ChevronUp className="h-4 w-4" />
            </Button>
          )}
        </div>
        <div className="flex w-full flex-nowrap items-center gap-1.5 sm:w-auto sm:gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={showPending ? "secondary" : "outline"}
                size="sm"
                className={cn("h-7 min-w-0 gap-1 px-1.5 text-xs sm:gap-1.5 sm:px-2", showPending ? "text-foreground" : "text-muted-foreground")}
                onClick={() => setShowPending((v) => !v)}
                aria-pressed={showPending}
                aria-label="Awaiting approval"
              >
                {/* Swatch, not an icon: the same dashed pill the toggle draws on the rows. The swatch and the
                    count are fixed; only the label gives way, so the narrowest screens lose letters instead of
                    the row's alignment. */}
                <span className={cn("inline-block h-2.5 w-4 shrink-0 rounded-full border border-dashed border-current", !showPending && "opacity-50")} />
                <span className="truncate">Awaiting approval</span>
                {pendingInView > 0 && <span className="shrink-0 rounded-full bg-foreground/10 px-1 font-semibold tabular-nums">{pendingInView}</span>}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{showPending ? "Hide" : "Show"} leave requests awaiting approval</TooltipContent>
          </Tooltip>
          {/* tapToOpen: this button IS the legend - it has no other action, so without it the key to every
              colour on the timeline was hover-only, i.e. absent on the device the timeline is hardest to read on. */}
          <Tooltip tapToOpen>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-muted-foreground" aria-label="Legend"><Info className="h-4 w-4" /></Button>
            </TooltipTrigger>
            <TooltipContent className="rounded-lg border bg-popover text-popover-foreground shadow-lg">{legendCard}</TooltipContent>
          </Tooltip>
          <span className="hidden text-sm text-muted-foreground sm:inline">{rangeLabel}</span>
          {/* Previous / Today / Next is ONE control in three parts and stays together. `ml-auto` parks the
              group at the trailing edge of the controls line, where the thumb is. */}
          <div className="ml-auto flex shrink-0 items-center gap-1 sm:ml-0 sm:gap-2">
            <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setPage((p) => p - 1)} aria-label="Previous"><ChevronLeft className="h-4 w-4" /></Button>
            <Button variant="outline" size="sm" className="h-7 px-2 sm:px-3" onClick={() => setPage(0)} disabled={page === 0}>Today</Button>
            <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setPage((p) => p + 1)} aria-label="Next"><ChevronRight className="h-4 w-4" /></Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-0 sm:px-0">
        {/* Vertical cap so a big team doesn't let the timeline swallow the page: ~7 rows visible, the rest
            scroll within the card while the day header stays pinned (sticky needs the opaque bg-card). */}
        <div className="scroll-shadow-x max-h-[560px] overflow-x-auto overflow-y-auto border-y [--scroll-ground:hsl(var(--card))]">
          <div style={gridMin}>
            {/* Day headers */}
            <div className="sticky top-0 z-20 grid border-b bg-card" style={gridCols}>
              {/* The name column is pinned to the left edge of the scroller (both here and on every row), so
                  scrolling out to the far day never leaves a wall of anonymous cells. */}
              <div className="sticky left-0 z-30 flex items-center gap-1.5 border-r bg-card px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Team
                {rows.length > 0 && <span className="rounded-full bg-muted px-1.5 py-px font-semibold normal-case tabular-nums">{rows.length}</span>}
              </div>
              {cols.map((d, i) => {
                const nonWorking = !workDays.includes(d.getUTCDay());
                const hol = holByCol.get(i);
                const isToday = i === todayCol;
                const away = awayByCol.get(i) ?? [];
                // Crunch-day chip: green-free scale - quiet amber for 1-2 away, hot rose from 3 up.
                const awayChip = away.length > 0 && (
                  <Tip label={
                    <TipCard title={`${away.length} away`} accent={away.length >= 3 ? "text-rose-600 dark:text-rose-400" : "text-amber-600 dark:text-amber-400"} eta={relFromDays(i - todayCol)}>
                      {away.slice(0, 6).map((p) => <TipRow key={p.id}>{p.name} · {p.why}</TipRow>)}
                      {away.length > 6 && <TipRow>+{away.length - 6} more</TipRow>}
                    </TipCard>
                  }>
                    <span className={cn(
                      "mx-auto mt-1 inline-flex items-center justify-center rounded-full px-1.5 py-px text-[10px] font-semibold leading-none",
                      away.length >= 3 ? "bg-rose-500/15 text-rose-600 dark:text-rose-400" : "bg-amber-500/15 text-amber-700 dark:text-amber-400",
                    )}>{away.length}</span>
                  </Tip>
                );
                const cell = (
                  <div className={cn("relative border-l px-0.5 pb-1.5 pt-1.5 text-center text-xs", i === 7 && "border-l-2", colBg(i, d))}>
                    <div className="relative flex flex-col items-center">
                      <div className={cn("font-medium", nonWorking ? "text-muted-foreground/70" : "text-muted-foreground")}>{DOW[d.getUTCDay()]}</div>
                      <div className={cn("mt-1 flex h-7 w-7 items-center justify-center rounded-full text-sm tabular-nums", isToday && "bg-primary font-semibold text-primary-foreground shadow-sm", hol && !isToday && "font-semibold text-violet-600 dark:text-violet-300")}>{d.getUTCDate()}</div>
                      <div className="h-[15px]">{awayChip}</div>
                    </div>
                  </div>
                );
                return hol ? <Tip key={i} label={holidayTip(hol)}>{cell}</Tip> : <div key={i} className="contents">{cell}</div>;
              })}
            </div>
            {/* Employee rows (relative wrapper so the live "now" line can span all of them at once) */}
            {rows.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-6 text-center">
                <Users className="h-8 w-8 text-muted-foreground/40" aria-hidden />
                <p className="text-sm text-muted-foreground">No one to show here.</p>
              </div>
            ) : (
            <div className="relative">
            {/* Live now-line: a thin red marker at the current time-of-day inside today's column (org tz),
                like a calendar's current-time indicator. Hidden when today is outside the visible window. */}
            {todayCol >= 0 && todayCol < DAYS && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-y-0 z-[5] w-px bg-red-400/40 dark:bg-red-400/30"
                style={{ left: `calc(${nameCol}px + (100% - ${nameCol}px) * ${pctAt(todayCol + nowFrac) / 100})` }}
              >
                {/* Self-explaining marker: the current org-local time, floated at the top of the line. */}
                <span className="absolute left-0 top-0.5 -translate-x-1/2 whitespace-nowrap rounded bg-card/90 px-1 text-[9px] font-medium leading-3 tabular-nums text-red-400">
                  {fmtHM(now.toISOString(), tz)}
                </span>
              </div>
            )}
            {rows.map((e, idx) => {
              const eid = idOf(e.path);
              const person = personOf(e);
              // Drag-to-request leave only arms on the caller's own row (the draft is always for `me`).
              const isSelf = eid === me.employee_id;
              // Approved pills (solid) + pending pills (dashed, toggled); pending are drawn under the same lane.
              const segs = [...toSegs(leavesByEmp.get(eid) ?? []), ...(showPending ? toSegs(pendingByEmp.get(eid) ?? []) : [])];
              // Event bands span the covered day columns (the band marks the dates; exact times live in the
              // tooltip), clamped to the visible window.
              // Day-unit span [lu, ru) per event. All-day -> the covered day columns; timed -> placed by
              // time-of-day within working hours (on the event's org-local day), so a short event is a short
              // band at the right spot rather than a full-day bar.
              const eventSegs = (eventsByEmp.get(eid) ?? [])
                .map((ev) => {
                  const lu = ev.all_day ? colOf(parseYmd(ev.start_time)) : colOf(parseYmd(localDay(ev.start_time, schedule.timezone))) + dayFrac(ev.start_time);
                  const ru = ev.all_day ? colOf(parseYmd(ev.end_time)) + 1 : colOf(parseYmd(localDay(ev.end_time, schedule.timezone))) + dayFrac(ev.end_time);
                  return { ev, lu, ru };
                })
                .filter((s) => s.ru > 0 && s.lu < DAYS && s.ru > s.lu)
                .map((s) => ({ ev: s.ev, lu: Math.max(0, s.lu), ru: Math.min(DAYS, Math.max(s.lu + 0.04, s.ru)) }));
              const celebs = (celebsByEmp.get(eid) ?? [])
                .map((c) => ({ c, col: cols.findIndex((d) => d.getUTCMonth() + 1 === c.month && d.getUTCDate() === c.day) }))
                .filter((x) => x.col >= 0);
              // Does this person have a visible celebration in-window? Drives the confetti on their name cell.
              const hasCeleb = celebs.some(({ c }) => showCat(c.kind === "birthday" ? "birthdays" : "anniversaries"));
              const joinCol = e.start_date && inWindow(parseYmd(e.start_date)) ? colOf(parseYmd(e.start_date)) : -1;
              const probCol = e.probation_end_date && inWindow(parseYmd(e.probation_end_date)) ? colOf(parseYmd(e.probation_end_date)) : -1;
              // Position a day-column icon on the bottom icon line. `dx` nudges it off the column centre (in px)
              // so it sits beside the centred attendance dot instead of on top of it (birthday left, anniversary
              // right; joiner left, probation right). The transform replaces the old -translate-x-1/2 class.
              const markerAt = (col: number, dx = 0) => ({ left: `${pctAt(col + 0.5)}%`, transform: `translateX(calc(-50% + ${dx}px))` });
              return (
                <div key={e.path} className={cn("group relative grid border-b transition-colors last:border-0 hover:bg-accent/40", idx % 2 === 1 && "bg-muted/25")} style={gridCols}>
                  {/* Pinned name cell. It has to paint its own stripe + hover tint: `sticky` needs an opaque
                      background, which hides the row's own. z-[15] clears the attendance dots (z-10) and the
                      now-line (z-[5]) that would otherwise scroll across it. */}
                  <div className="sticky left-0 z-[15] flex items-center gap-2 overflow-hidden border-r bg-card py-2 pl-3 pr-2">
                    {idx % 2 === 1 && <span className="pointer-events-none absolute inset-0 bg-muted/25" />}
                    <span className="pointer-events-none absolute inset-0 transition-colors group-hover:bg-accent/40" />
                    {hasCeleb && <ConfettiBg />}
                    <span className="relative z-[1] shrink-0">
                      <PhotoAvatar employeeId={person.id} name={person.name} photo={person.photo} className={cn("text-sm", isPhone ? "h-9 w-9" : "h-10 w-10")} />
                    </span>
                    <span className="relative z-[1] min-w-0">
                      <span className="block truncate text-sm font-medium">{person.name}</span>
                      {/* Live presence subtitle: today's derived status (in-at time while clocked in). Only
                          renders while today is in the visible window; paging away drops it, by design. */}
                      {(() => {
                        const t = statusByEmp.get(eid)?.get(todayYmd);
                        if (!t) return null;
                        const dotCls = STATUS_DOT[t.status];
                        const text = t.status === "open" && t.summary?.arrival
                          ? `In since ${fmtHM(t.summary.arrival, tz)}`
                          : STATUS_LABEL[t.status];
                        return (
                          <span className="flex items-center gap-1 text-[11px] leading-tight text-muted-foreground">
                            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotCls ?? "bg-muted-foreground/50")} />
                            <span className="truncate">{text}</span>
                          </span>
                        );
                      })()}
                    </span>
                  </div>
                  {cols.map((d, i) => {
                    const hol = holByCol.get(i);
                    const row = statusByEmp.get(eid)?.get(d.toISOString().slice(0, 10));
                    const dot = row ? STATUS_DOT[row.status] : null;
                    const blocked = blockedCols.has(i);
                    const canSelect = isSelf && !blocked;
                    const onMove = (ev: ReactMouseEvent<HTMLElement>) => {
                      if (blocked) return; // don't hover-hint or extend a drag onto a weekend/holiday/leave day
                      const h = halfAt(ev);
                      if (sel) {
                        // Clamp the moving end so the range can't jump across an existing leave: stop at the
                        // half-day slot bordering the nearest leave between the anchor day and the target.
                        const aCol = Math.floor(sel.a / 2);
                        let nb = i * 2 + h;
                        if (i >= aCol) { for (let c = aCol + 1; c <= i; c++) if (leaveCols.has(c)) { nb = Math.min(nb, (c - 1) * 2 + 1); break; } }
                        else { for (let c = aCol - 1; c >= i; c--) if (leaveCols.has(c)) { nb = Math.max(nb, (c + 1) * 2); break; } }
                        setSel((s) => (s && s.b !== nb ? { ...s, b: nb } : s));
                      } else if (isSelf) setHover((c) => (c && c.col === i && c.half === h ? c : { col: i, half: h }));
                    };
                    const cell = (
                      // POINTER events, not mouse. This is the timeline's primary interaction and the timeline
                      // is a mobile surface by design (`dashboardPrefs.timelineOpen` is described as
                      // "mobile-only"), but a touch drag fires no `mouseenter` on the cells it passes over, so
                      // only a tap - a single half-day - ever worked on a phone; dragging a range scrolled the
                      // page instead. `touch-none` on the selectable cells stops the scroll competing with the
                      // drag, and the implicit pointer capture touch gives the element that received
                      // `pointerdown` is released below so moves retarget to the cell under the finger.
                      <div
                        className={cn("relative h-[72px] select-none border-l", i === 7 && "border-l-2", canSelect ? "cursor-cell touch-none" : "cursor-default", colBg(i, d), i === todayCol && "bg-amber-100/60 dark:bg-amber-900/20")}
                        onPointerDown={canSelect ? (ev) => {
                          ev.preventDefault();
                          if (ev.pointerType !== "mouse") ev.currentTarget.releasePointerCapture(ev.pointerId);
                          const p = i * 2 + halfAt(ev);
                          setHover(null);
                          setSel({ a: p, b: p });
                        } : undefined}
                        onPointerEnter={onMove}
                        onPointerMove={onMove}
                        onPointerLeave={() => setHover((c) => (c && c.col === i ? null : c))}
                      >
                        {selOverlay(i, isSelf, blocked)}
                        {dot && row && (
                          <Tip label={attendanceTip(person, row)}>
                            <span className={cn("absolute left-1/2 top-[31px] z-10 h-2.5 w-2.5 -translate-x-1/2 rounded-full ring-2 ring-card", dot, row.status === "open" && "animate-pulse")} />
                          </Tip>
                        )}
                      </div>
                    );
                    return hol ? <Tip key={i} label={holidayTip(hol)}>{cell}</Tip> : <div key={i} className="contents">{cell}</div>;
                  })}
                  {/* Day-area overlay (absolute, starting after the name column): pills + markers placed by % so
                      a half day renders as a half-width pill. */}
                  <div className="pointer-events-none absolute inset-y-0" style={{ left: nameCol, right: 0 }}>
                    {/* Event bands ride a slim ribbon at the top of the row so they don't collide with the
                        centered leave pill / attendance dot. Distinct from leave: outlined, with the event color. */}
                    {showCat("events") && eventSegs.map(({ ev, lu, ru }, k) => (
                      <Tip key={`e${k}`} label={eventTip(ev)}>
                        <div
                          style={{ left: `calc(${pctAt(lu)}% + 2px)`, width: `calc(${pctAt(ru) - pctAt(lu)}% - 4px)`, borderColor: eventColor(ev), color: eventColor(ev) }}
                          className={cn(
                            "pointer-events-auto absolute top-1.5 flex h-4 items-center overflow-hidden rounded border border-l-[3px] bg-card/95 text-[10px] font-semibold leading-none shadow-sm",
                            // Icon-only pills drop the padding (and centre the icon) so the calendar glyph isn't
                            // cropped by the px padding + thick accent border; min-w-4 leaves it exactly enough room.
                            ru - lu >= 0.5 ? "min-w-3 gap-1 px-1" : "min-w-4 justify-center px-0",
                          )}
                        >
                          <CalendarRange className="h-3 w-3 shrink-0" />
                          {ru - lu >= 0.5 && <span className="truncate">{ev.title}</span>}
                        </div>
                      </Tip>
                    ))}
                    {segs.flatMap(({ l, lu, ru }, k) => {
                      const pending = upper(l.state) === "PENDING";
                      const color = colorOf(l.leave_type);
                      // Split at weekend/holiday columns so the bar renders as separate runs, leaving those cells
                      // (and their separators) untouched. Approved = solid pill; pending = dashed translucent.
                      const bars = splitRuns(lu, ru, (i) => holByCol.has(i) || !workDays.includes(cols[i]!.getUTCDay()));
                      return bars.map(([bl, br], j) => {
                        // Only the leave's true ends get a rounded cap + 2px inset; edges landing on a
                        // weekend/holiday boundary stay square and butt the cell, so the runs read as one
                        // interrupted leave rather than separate bars opening and closing.
                        const capL = j === 0, capR = j === bars.length - 1;
                        const padL = capL ? 2 : 0, padR = capR ? 2 : 0;
                        const pos = { left: `calc(${pctAt(bl)}% + ${padL}px)`, width: `calc(${pctAt(br) - pctAt(bl)}% - ${padL + padR}px)` };
                        return (
                          <Tip key={`l${k}-${j}`} label={leaveTip(person, l)}>
                            <div
                              style={pending ? { ...pos, borderColor: color, color } : { ...pos, backgroundColor: color }}
                              className={cn(
                                "pointer-events-auto absolute top-[48px] flex h-5 items-center justify-start overflow-hidden px-2 text-xs font-semibold shadow-sm",
                                capL && "rounded-l-full", capR && "rounded-r-full",
                                pending ? "border border-dashed bg-card/80" : "text-white",
                                !capL && "border-l-0", !capR && "border-r-0", // pending: no vertical edge at a weekend break
                              )}
                            >
                              {/* Label on the first run only, if it's wide enough to hold the text. */}
                              {j === 0 && br - bl >= 1 && <span className="truncate">{l.days}d leave</span>}
                            </div>
                          </Tip>
                        );
                      });
                    })}
                    {celebs.filter(({ c }) => showCat(c.kind === "birthday" ? "birthdays" : "anniversaries")).map(({ c, col }, k) => (
                      <Tip key={`c${k}`} label={celebrationTip(person, c)}>
                        <div style={markerAt(col, c.kind === "birthday" ? -22 : 22)} className="pointer-events-auto absolute top-[24px] flex h-6 w-6 items-center justify-center rounded-full bg-card shadow-sm ring-1 ring-border">
                          {c.kind === "birthday" ? <Cake className="h-4 w-4 text-pink-500" /> : <PartyPopper className="h-4 w-4 text-amber-500" />}
                        </div>
                      </Tip>
                    ))}
                    {joinCol >= 0 && showCat("joiners") && (
                      <Tip label={<TipCard person={person} icon={UserPlus} iconClass="text-emerald-600" title="New joiner" accent="text-emerald-600 dark:text-emerald-400" eta={relDay(e.start_date)}><TipRow icon={CalendarDays}>Joined {dmy(e.start_date)}</TipRow></TipCard>}>
                        <div style={markerAt(joinCol, -22)} className="pointer-events-auto absolute top-[24px] flex h-6 w-6 items-center justify-center rounded-full bg-card shadow-sm ring-1 ring-border"><UserPlus className="h-4 w-4 text-emerald-600 dark:text-emerald-400" /></div>
                      </Tip>
                    )}
                    {probCol >= 0 && showCat("probation") && (
                      <Tip label={<TipCard person={person} icon={ShieldCheck} iconClass="text-sky-600" title="Probation ends" accent="text-sky-600 dark:text-sky-400" eta={relDay(e.probation_end_date)}><TipRow icon={CalendarDays}>{dmy(e.probation_end_date)}</TipRow></TipCard>}>
                        <div style={markerAt(probCol, 22)} className="pointer-events-auto absolute top-[24px] flex h-6 w-6 items-center justify-center rounded-full bg-card shadow-sm ring-1 ring-border"><ShieldCheck className="h-4 w-4 text-sky-600 dark:text-sky-400" /></div>
                      </Tip>
                    )}
                  </div>
                </div>
              );
            })}
            </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
    {dlgOpen && (
      <RequestLeaveDialog open={dlgOpen} onOpenChange={setDlgOpen} me={me} initial={draft} onSubmitted={() => navigate("leave-requests")} />
    )}
    </TooltipProvider>
  );
}

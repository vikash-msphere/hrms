import type { AttendanceSession } from "@/types";
import { dateFormat } from "./intl";
// The server's own leave-coverage rule, imported rather than mirrored. The "the web bundle can't import from
// src/" premise does not hold - lib/leaveForecast.ts, lib/eventRepeat.ts, lib/assetTagsPdf.ts and several pages
// already do it - and a copy of this particular rule is what let the grid and the payroll build disagree about
// which days leave excuses.
import { leaveCover, leaveTouches, type LeaveRange, type DayCredit } from "../../../src/domain/attendance";
// And the server's rule for whether a day was late or left early, for the same reason: an approved late arrival
// or early departure moves the day's window, and the payroll build judges the day against the moved window with
// this exact function (domain/punctuality.ts#judgeDay).
import { DEFAULT_PUNCTUALITY, judgeDay, leaveHalves, type DayExcusal, type PunctualityPolicy } from "../../../src/domain/punctuality";
// And the rule for WHOSE day a day is: which days are worked at all, and how many minutes earn a full or half
// one. The grid drawing a rest day as an absence, or a four-hour shift as "Under hours", is the same drift
// again - the person is told they missed work the payroll build never asked them for.
import { orgScheduleOf, type DaySchedule, type DayScheduleOf } from "../../../src/domain/workSchedule";
export type { DaySchedule, DayScheduleOf };
// Every attendance surface describes the same window of days, so the range type travels with the rule that
// reads it rather than being restated per page.
export type { LeaveRange, DayCredit, DayExcusal };

/** The paths of the leave types that are not paid (`paid: false`, e.g. "Loss of Pay"). */
export function unpaidLeaveTypes(types: readonly { path: string; paid?: boolean | null }[]): Set<string> {
  return new Set(types.filter((t) => t.paid === false).map((t) => t.path));
}

/**
 * One approved leave request as the range `leaveCover` reads - sessions AND whether its type is paid. Unpaid
 * leave excuses nothing (src/domain/attendance.ts LeaveRange), so the grid shows those days the way payroll
 * docks them; built in one place so no surface forgets the flag.
 */
export function leaveRangeOf(
  l: { start_date: string; end_date: string; start_session?: number | null; end_session?: number | null; leave_type?: string | null },
  unpaid: ReadonlySet<string>,
): LeaveRange {
  return {
    start: l.start_date,
    end: l.end_date,
    startSession: l.start_session ?? undefined,
    endSession: l.end_session ?? undefined,
    ...(l.leave_type && unpaid.has(l.leave_type) ? { paid: false } : {}),
  };
}

/** How a day mark reads on screen. One table, so the badge, the picker and the toast agree. */
export const CREDIT_LABEL: Record<DayCredit, string> = { full: "Full day", half: "Half day", absent: "Absent" };

// Org work schedule (stored in settings/attendance; HR edits it). Day status (late/early) is derived on the
// client from sessions + this schedule. Times are wall-clock in `timezone`; punches are real instants.
export type AttendanceSchedule = {
  timezone: string;
  work_days: number[]; // 0=Sun .. 6=Sat
  shift_start: string; // "HH:MM"
  shift_end: string; // "HH:MM"
  grace_minutes: number;
  // Date-scoped lateness forgiveness (bad weather, transit strike). On a listed date the day's grace is
  // widened for everyone: extra_grace_minutes added to grace_minutes, or lateness/early departure waived
  // entirely when omitted. Applies symmetrically to late arrival and early departure.
  grace_exceptions?: { date: string; reason?: string; extra_grace_minutes?: number }[]; // date = "YYYY-MM-DD"
  // Which weekday a calendar grid starts on (0=Sun .. 6=Sat). Display-only, and org-specific: a week that
  // starts on the wrong day makes every month grid read one column out of step with how people plan.
  week_start?: number;
  full_day_minutes: number; // worked minutes for a full day; from half_day_minutes up to this is a half day
  half_day_minutes: number; // minimum worked minutes to earn a half day; below this the day doesn't count
  flexible_hours?: boolean; // judge the day by minutes worked only; don't flag late arrival / early departure
  // Display-only, and the reason they're settings rather than constants: a progress bar toward a full day
  // (and especially a projected finish time) reads as a clock-watching target in some workplaces and as a
  // useful readout in others. Absent = shown, so an existing org keeps what it has.
  show_day_progress?: boolean; // the Attendance clock card's full-day bar, break line and day-off note
  show_finish_projection?: boolean; // the "Full day at ~6:12 PM" / "2h to a full day" text on that bar
  lop_enabled?: boolean; // deduct loss-of-pay for unexcused absences at payroll build
  lop_basis?: "working_days" | "days_30"; // per-day rate divisor
  lop_wage_basis?: "gross" | "basic"; // the monthly wage that divisor divides: gross (default) or basic only
  proration_basis?: "calendar_days" | "working_days"; // how a mid-period joiner/leaver's earnings are prorated
  // Whether a day is resolved through the roster and the schedule the person is on, or from this blob alone
  // (src/domain/workSchedule.ts). "org" is the default and is exactly the behaviour above: an org keeping a
  // roster as a planning grid must not find those entries deciding pay the moment schedules ship.
  schedule_source?: "org" | "resolved";
};

export const DEFAULT_SCHEDULE: AttendanceSchedule = {
  timezone: "Asia/Kolkata",
  work_days: [1, 2, 3, 4, 5],
  shift_start: "09:00",
  shift_end: "18:00",
  grace_minutes: 15,
  full_day_minutes: 480,
  half_day_minutes: 240,
  flexible_hours: false,
  show_day_progress: true,
  show_finish_projection: true,
  lop_enabled: false,
  lop_basis: "working_days",
  lop_wage_basis: "gross",
  proration_basis: "calendar_days",
  schedule_source: "org",
  week_start: 1,
};

// Minutes-since-midnight of a wall-clock "HH:MM" (the form the schedule and the correction dialog use).
export const hhmmToMin = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

// These three run once per PUNCH when a month of attendance is assembled, so the formatter is shared rather
// than rebuilt per call (see lib/intl.ts). The cache is keyed on the options, so a second timezone gets its
// own formatter rather than a wrong answer - in practice there is one, the org's.
// `hourCycle: "h23"`, not `hour12: false`: the latter asks only "not AM/PM" and leaves the cycle to the locale,
// which may resolve to h24 and number midnight 24. `localMinutes` below reads that hour back as a NUMBER, so a
// midnight punch would score 1440 instead of 0 - and this file is the browser mirror of the server's
// derivation (src/domain/attendance.ts), which names the cycle for the same reason. The two must agree.
const HM_24 = (tz: string): Intl.DateTimeFormatOptions => ({ timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const YMD = (tz: string): Intl.DateTimeFormatOptions => ({ timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
const HM_12 = (tz: string): Intl.DateTimeFormatOptions => ({ timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: true });

// Minutes-since-midnight of an instant in the org timezone (so 09:05 IST -> 545 regardless of viewer tz).
export function localMinutes(iso: string, tz: string): number {
  const parts = dateFormat("en-GB", HM_24(tz)).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

// The org-local calendar day ("YYYY-MM-DD") of an instant - used to group punches into days.
export function localDay(iso: string, tz: string): string {
  return dateFormat("en-CA", YMD(tz)).format(new Date(iso));
}

// The day HRMS records start for an employee: the `trackedFromYmd` floor of buildAttendanceRows. A date-only
// field, so it is used as the day it names.
export const trackedFromOf = (e: { tracked_from?: string } | undefined): string | undefined => e?.tracked_from?.slice(0, 10) || undefined;

// Inverse of localDay+wall-clock: the ISO instant for a wall-clock "HH:MM" on calendar day "YYYY-MM-DD" read
// in the org timezone. Guesses the instant as if UTC, then corrects by the zone's offset at that moment (so
// 09:00 on 2026-07-14 in Asia/Kolkata -> 03:30Z). Used to turn correction-dialog times back into punches.
export function zonedInstant(ymd: string, hhmm: string, tz: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const guess = Date.parse(`${ymd}T${String(h || 0).padStart(2, "0")}:${String(m || 0).padStart(2, "0")}:00Z`);
  const wanted = (h || 0) * 60 + (m || 0);
  // How far the instant `ms` prints from the wall-clock we asked for, in minutes.
  const driftAt = (ms: number): number => {
    let d = localMinutes(new Date(ms).toISOString(), tz) - wanted;
    if (d > 720) d -= 1440; // day-wrap: it printed as the previous/next day
    else if (d < -720) d += 1440;
    return d;
  };
  const first = guess - driftAt(guess) * 60000;
  // SECOND PASS, because the offset is read at one instant and applied to another.
  //
  // The correction moves the instant by up to a day, and a zone's offset is not constant across that move: on
  // a DST boundary the offset at the guess is not the offset at the answer, so a single pass lands an hour
  // out - silently, on a value that becomes a stored punch. Re-reading the drift AT the corrected instant and
  // applying what is left converges wherever the wall-clock time actually exists, which is every case but one.
  //
  // Deliberately one extra pass and not a loop: inside a spring-forward GAP the requested wall-clock time does
  // not occur at all, so no instant has zero drift and iterating would oscillate between the two sides of the
  // jump forever. One pass terminates and lands on the nearest real instant, which is the right answer to
  // "09:30 on a day that has no 09:30".
  const drift = driftAt(first);
  return new Date(drift === 0 ? first : first - drift * 60000).toISOString();
}

export type DaySummary = {
  day: string;
  sessions: AttendanceSession[];
  arrival?: string; // first clock_in
  departure?: string; // last clock_out (undefined if still open)
  workedMinutes: number; // sum of closed sessions
  open: boolean; // any session still open
  late: boolean;
  leftEarly: boolean;
  lateByMin: number; // measured from the day's own start: the approved time, where a late arrival was approved
  earlyByMin: number;
  // What an approved late arrival / early departure did to the day (domain/punctuality.ts#judgeDay). Optional
  // because a summary built for an event-only day carries no punches for any of it to apply to.
  excusedLate?: boolean; // the approval covered lateness the org's own window would have flagged
  excusedEarly?: boolean;
  creditMinutes?: number; // approved gap counted toward the full/half-day ladder, when the policy says so
  approvedLateUntil?: number; // minutes since midnight: the approved arrival time
  approvedEarlyFrom?: number; // minutes since midnight: the approved departure time
};

// The shift window a single day is judged against. `grace` is that day's effective lateness allowance -
// widened by a grace exception, or Infinity when the exception waives lateness entirely.
type ShiftWindow = { tz: string; startMin: number; endMin: number; grace: number };

/**
 * What else decides whether a day was late or left early, beyond its punches and the org's shift:
 * - `excusals`: approved late arrivals / early departures by day, which move that day's start or end;
 * - `policy`: whether grace still applies after an approved time, and whether the approved gap counts as worked;
 * - `leaveRanges`: approved leave, since a morning on leave is not a late arrival and an afternoon on leave is
 *   not an early departure.
 * Every field is optional, and a caller passing none gets the org's plain shift window.
 */
export type SummarizeOpts = {
  excusals?: Map<string, DayExcusal>;
  policy?: PunctualityPolicy["attendance"];
  leaveRanges?: readonly LeaveRange[];
};

// One day's punches -> its summary. Late / left-early are judged against that day's own shift window, by the
// rule the payroll build uses (judgeDay). NOT WHILE A SESSION IS STILL OPEN for leaving early: `departure` is the
// last CLOSED punch, so somebody who clocked out for lunch and back in has a "departure" mid-day, and a day that
// has not finished cannot be left early - judgeDay holds that line for every reader, the CSV export's "early by"
// column included.
function summarizeDay(day: string, ss: AttendanceSession[], shift: ShiftWindow, opts: SummarizeOpts): DaySummary {
  const sorted = [...ss].sort((a, b) => +new Date(a.clock_in) - +new Date(b.clock_in));
  const arrival = sorted[0]?.clock_in;
  const closed = sorted.filter((s) => s.clock_out);
  const open = sorted.some((s) => !s.clock_out);
  const departure = closed.length ? closed[closed.length - 1]!.clock_out : undefined;
  const workedMinutes = closed.reduce((sum, s) => sum + Math.max(0, Math.round((+new Date(s.clock_out!) - +new Date(s.clock_in)) / 60000)), 0);
  const excusal = opts.excusals?.get(day);
  const j = judgeDay({
    arrMin: arrival ? localMinutes(arrival, shift.tz) : null,
    depMin: departure ? localMinutes(departure, shift.tz) : null,
    open,
    startMin: shift.startMin,
    endMin: shift.endMin,
    grace: shift.grace,
    excusal,
    halves: opts.leaveRanges ? leaveHalves(day, opts.leaveRanges) : undefined,
    policy: opts.policy ?? DEFAULT_PUNCTUALITY.attendance,
  });
  return {
    day,
    sessions: sorted,
    arrival,
    departure,
    workedMinutes,
    open,
    late: j.late,
    leftEarly: j.leftEarly,
    lateByMin: j.lateByMin,
    earlyByMin: j.earlyByMin,
    excusedLate: j.excusedLate,
    excusedEarly: j.excusedEarly,
    creditMinutes: j.creditMinutes,
    approvedLateUntil: excusal?.lateUntil,
    approvedEarlyFrom: excusal?.earlyFrom,
  };
}

// Group a flat session list into per-day summaries with derived late/early flags. Sorted newest day first.
// The flags are computed under flexible hours too: there they are information (the timeline's chips), and the
// status ladder is what declines to call such a day late (`dayStatus`).
export function summarizeByDay(sessions: AttendanceSession[], sched: AttendanceSchedule, opts: SummarizeOpts = {}): DaySummary[] {
  const byDay = new Map<string, AttendanceSession[]>();
  for (const s of sessions) {
    const d = localDay(s.clock_in, sched.timezone);
    (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(s);
  }
  const startMin = hhmmToMin(sched.shift_start);
  const endMin = hhmmToMin(sched.shift_end);
  const exceptions = new Map((sched.grace_exceptions ?? []).map((e) => [e.date, e]));
  const out: DaySummary[] = [];
  for (const [day, ss] of byDay) {
    // On an exception day widen grace: add extra minutes, or waive lateness/early departure entirely.
    const ex = exceptions.get(day);
    const grace = ex ? (ex.extra_grace_minutes == null ? Infinity : sched.grace_minutes + ex.extra_grace_minutes) : sched.grace_minutes;
    out.push(summarizeDay(day, ss, { tz: sched.timezone, startMin, endMin, grace }, opts));
  }
  return out.sort((a, b) => b.day.localeCompare(a.day));
}

// Weekday (0=Sun..6=Sat) of a "YYYY-MM-DD" calendar date.
export const weekdayOf = (ymd: string) => new Date(`${ymd}T00:00:00Z`).getUTCDay();

// Inclusive list of "YYYY-MM-DD" from `fromYmd` to `toYmd`.
export function enumerateDays(fromYmd: string, toYmd: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${fromYmd}T00:00:00Z`); t <= Date.parse(`${toYmd}T00:00:00Z`); t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

// No "on_event": a count_as_work=false event does not excuse the day, so an attendee who never punched is
// plain "absent" (and docked). count_as_work events show up as credited minutes, not as a status of their own.
// `half_day_leave` = approved leave covered ONE session of the day and nothing was worked in the other, which
// is a day payroll charges 0.5 days of loss of pay for. It is deliberately distinct from `on_leave`: they are
// the two sides of the drift this grid used to have with `lopDayUnits`.
// `worked_off_day` = punches on a day nobody was scheduled to work (a weekend, or a company holiday). The
// server never measures those days at all - `lopDayUnits` and `workingDaysInRange` both skip them on their
// first line - so judging one against the weekday shift window called voluntary Saturday work "Under hours",
// "Half day" or "Late", which is a violation reported for work that earns nothing but goodwill. The minutes
// still count; the day is simply not owed.
// `untracked` = an empty working day after the employee joined but before HRMS records start for them
// (`trackedFromYmd`). It is not an absence, but it is still a row, so a correction or a day mark can be filed
// against it from the grid.
export type DayStatus = "open" | "present" | "late" | "left_early" | "late_early" | "half_day" | "insufficient" | "on_leave" | "half_day_leave" | "holiday" | "worked_off_day" | "absent" | "untracked";
/**
 * `status` is what the PUNCHES say the day was; `mark` is what HR decided it COUNTS as, where they have
 * decided. Both are kept, and the UI shows both, because a marked day is exactly the day somebody will later
 * ask about - "it says half day, why was I paid for a full one" has no answer if the grid only kept the
 * winner. What the mark actually changes is loss of pay, which the server settles (domain/attendance.ts).
 */
export type AttendanceRow = { day: string; summary?: DaySummary; status: DayStatus; mark?: DayCredit };

// Status of a day that has punches and/or event work credit. `total` is clocked + event-credited minutes;
// `s` is absent on an event-only day. Minutes decide first (a day too short to count can't be "late"), then
// punctuality - which only applies when there are real punches and the schedule isn't flexible.
//
// `day` is THAT DAY'S OWN schedule (src/domain/workSchedule.ts), so a four-hour shift is a full day at four
// hours here exactly as it is in the payroll build - the grid calling it "Under hours" while payroll docked
// nothing is the drift this file's other imports exist to prevent.
function dayStatus(s: DaySummary | undefined, total: number, day: DaySchedule): DayStatus {
  if (s?.open) return "open";
  if (total < day.halfDayMinutes) return "insufficient"; // too little (clocked + event) to earn even a half day
  if (total < day.fullDayMinutes) return "half_day";
  if (day.flexible || !s) return "present"; // event-only or flexible: a full day's worth of minutes = present
  if (s.late && s.leftEarly) return "late_early";
  if (s.late) return "late";
  if (s.leftEarly) return "left_early";
  return "present";
}

// Merge punches with the schedule + holidays + approved leave into a per-day grid. Working days with no punch
// (and not on leave / not a holiday) before today are flagged ABSENT. Weekends without punches are omitted.
export function buildAttendanceRows(opts: {
  fromYmd: string;
  toYmd: string;
  todayYmd: string;
  /** WHOSE days these are, day by day (src/domain/workSchedule.ts). A caller with no employee in hand builds
   *  it from the org's own week with `orgScheduleOf`, which is what this always used to do. */
  schedOf: DayScheduleOf;
  summaries: DaySummary[];
  holidays: Set<string>;
  // The SESSION FLAGS ride along, and they are not optional decoration. Approved leave can cover half a day
  // (the `start_session`/`end_session` columns on a leave request), and the server excuses exactly that half:
  // `lopDayUnits` still charges 0.5 days of loss of pay for a PM half-day with no punch. This grid used to take
  // `{start, end}` only, call the whole day "On leave", and so show as fully excused a day payroll then docked.
  leaveRanges: LeaveRange[];
  workMinutesByDay?: Map<string, number>; // count_as_work events: minutes credited toward the day's worked total
  marksByDay?: Map<string, DayCredit>; // HR's decision for a day, carried onto the row beside its derived status
  joinedYmd?: string; // employee start date; days before it aren't their attendance, so they're omitted (no absent)
  // The day HRMS records start for this person (`employees.tracked_from`, read by `trackedFromOf`). Someone who
  // joined before the org started using the app had no way to punch before it, so an empty working day before
  // it reads `untracked`, not absent. A day with punches, a mark or any approved leave is judged as usual,
  // which is exactly the day payroll judges (domain/attendance.ts isUntracked): a correction backfilling
  // go-live week, an unpaid leave taken then.
  trackedFromYmd?: string;
}): AttendanceRow[] {
  const { fromYmd, toYmd, todayYmd, schedOf, summaries, holidays, leaveRanges, workMinutesByDay = new Map(), marksByDay, joinedYmd, trackedFromYmd } = opts;
  const byDay = new Map(summaries.map((s) => [s.day, s]));
  // The SERVER'S rule, imported rather than restated - see the note on `leaveRanges` above and on
  // `leaveCover` in src/domain/attendance.ts. 1 = the whole day is excused, 0.5 = one session is.
  const excusedOn = (day: string) => leaveCover(day, leaveRanges);
  const rows: AttendanceRow[] = [];
  for (const day of enumerateDays(fromYmd, toYmd)) {
    if (joinedYmd && day < joinedYmd) continue; // before the employee joined -> not their attendance
    const s = byDay.get(day);
    const credit = workMinutesByDay.get(day) ?? 0; // worked-minutes credited by count-as-work events
    // THE SCHEDULE DECIDES WHAT KIND OF DAY IT IS; the punches only decide how the day went. Tested the other
    // way round, `work_days` and `holidays` gated the EMPTY days alone, so any day with a punch was judged
    // against shift_start/grace/half_day_minutes whether or not anyone was meant to be working.
    const ds = schedOf(day);
    const offDay = ds.off || holidays.has(day);
    if (s || credit > 0) {
      // Event credit adds to clocked minutes for the day's total; late/early flags come from real punches only.
      const total = (s?.workedMinutes ?? 0) + credit;
      // An approved late arrival / early departure's gap counts toward the full/half-day ladder when the
      // punctuality policy credits it (`creditMinutes`, 0 otherwise) - the reading payroll docks by - but it is
      // not WORK, so it stays out of the minutes the row reports as worked.
      const status = s?.open ? "open" : offDay ? "worked_off_day" : dayStatus(s, total + (s?.creditMinutes ?? 0), ds);
      const summary: DaySummary = s
        ? { ...s, workedMinutes: total }
        : { day, sessions: [], workedMinutes: total, open: false, late: false, leftEarly: false, lateByMin: 0, earlyByMin: 0 };
      rows.push({ day, summary, status });
    } else if (ds.off) {
      continue; // weekend, or a rest day in this person's own schedule, with no punch
    } else if (holidays.has(day)) {
      // (a worked holiday took the `worked_off_day` branch above, so this is the unworked one)
      rows.push({ day, status: "holiday" });
    } else if (excusedOn(day) >= 1) {
      rows.push({ day, status: "on_leave" });
    } else if (trackedFromYmd && day < trackedFromYmd && !leaveTouches(day, leaveRanges)) {
      rows.push({ day, status: "untracked" }); // before HRMS records start: no punch was possible
    } else if (excusedOn(day) > 0 && day < todayYmd) {
      // Half the day is excused and the other half was never worked. That is neither "On leave" (it isn't, and
      // payroll charges 0.5 days for it) nor a plain absence (half of it is spoken for), so it gets its own
      // status and the same ladder `lopDayUnits` reads. A half-day still in the future stays omitted, like any
      // other day nobody has clocked into yet.
      rows.push({ day, status: "half_day_leave" });
    } else if (day < todayYmd && excusedOn(day) === 0) {
      rows.push({ day, status: "absent" }); // a past working day with no punch and no leave/holiday
    }
    // today / future with no punch yet -> omit
  }
  // The mark rides along on whichever row the day produced. Applied here rather than inside each branch so
  // there is one place it can be attached and no branch can forget it.
  if (marksByDay?.size) for (const r of rows) { const m = marksByDay.get(r.day); if (m) r.mark = m; }
  return rows.sort((a, b) => b.day.localeCompare(a.day));
}

export const fmtHM = (iso: string, tz: string) => dateFormat(undefined, HM_12(tz)).format(new Date(iso));

export const fmtDuration = (min: number) => `${Math.floor(min / 60)}h ${min % 60}m`;

// Same duration with the zero part dropped ("8h", "45m") - for tight spots like a calendar cell.
export const fmtDurationShort = (min: number) => {
  const h = Math.floor(min / 60), m = min % 60;
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
};

// Minutes-since-midnight as a wall clock ("9:12 AM") - for averaged times, which are minutes, not instants.
export const fmtMinOfDay = (min: number) => {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  const h24 = Math.floor(m / 60);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m % 60).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
};

// ---- Calendar arithmetic (all UTC, since a "YYYY-MM-DD" is a calendar date, not an instant) ----
export const monthStartOf = (ymd: string) => `${ymd.slice(0, 7)}-01`;
export const addMonths = (ymd: string, n: number) => {
  // Sliced rather than split/destructured: a "YYYY-MM-DD" has its year and month at fixed offsets, so this
  // is total where the destructuring was `number | undefined` and only type-checked because the web project
  // does not set `noUncheckedIndexedAccess` (the root one does, and now sees this file).
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7));
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
};
export const monthEndOf = (ymd: string) => new Date(Date.parse(`${addMonths(ymd, 1)}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
// The 42 days (6 weeks from the week-start day on/before the 1st) that fill a month grid. `weekStart` is the
// org's configured first weekday (0=Sun default), so every grid in the app steps in the same rhythm.
export const monthGridDays = (ymd: string, weekStart = 0) => {
  const first = Date.parse(`${monthStartOf(ymd)}T00:00:00Z`);
  const start = first - ((new Date(first).getUTCDay() - weekStart + 7) % 7) * 86400000;
  return Array.from({ length: 42 }, (_, i) => new Date(start + i * 86400000).toISOString().slice(0, 10));
};
/** The weekday labels for a grid that starts on `weekStart`, as [index 0..6 of the column, weekday number]. */
export const weekdayOrder = (weekStart = 0) => Array.from({ length: 7 }, (_, i) => (weekStart + i) % 7);
// Monday of the week containing `ymd` - the grouping key for the history table's weekly subtotals.
export const weekStartOf = (ymd: string) => {
  const t = Date.parse(`${ymd}T00:00:00Z`);
  return new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
};

// ---- Day labels ----
// "Thu, Jun 12" for a history row (the range caption above it carries the year). One row per day of the
// range, so the formatter is shared rather than rebuilt per cell (see lib/intl.ts).
const DAY_OPTS: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };
export const fmtDay = (ymd: string) => dateFormat(undefined, DAY_OPTS).format(new Date(`${ymd}T00:00:00`));
// "Thursday, 12 June" for the calendar's selected-day panel, which has room to spell it out.
export const fmtDayLong = (ymd: string) =>
  new Date(`${ymd}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
export const monthLabel = (ymd: string) =>
  new Date(`${ymd}T00:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
export const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** A duration carrying its own sign, for a balance against what was expected ("+3h 10m", "-45m"). */
export const signedDuration = (min: number) => `${min >= 0 ? "+" : "-"}${fmtDurationShort(Math.abs(min))}`;
// Wall-clock "HH:MM" (24h) of an instant in the org timezone, for prefilling an `<input type="time">`, which
// accepts 00-23 and rejects "24:15" - `hour12: false` leaves the cycle to the locale, where h24 spells
// midnight that way.
export const fmtHM24 = (iso: string, tz: string) =>
  dateFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

// ---- Window totals ----
/** Everything a summary strip, an hours chart and a period comparison read off one window of days. */
export type WindowStats = {
  worked: number; late: number; absent: number; minutes: number; workingDays: number;
  avgDay: number; onTimePct: number | null; avgIn: number | null; avgOut: number | null;
  // The ledger counts COMPLETED days only - today is still being worked, so counting it as a full expected
  // day would show a deficit all morning.
  doneMinutes: number; expectedMinutes: number;
};

export function statsOf(rows: AttendanceRow[], tz: string, schedOf: DayScheduleOf, todayYmd: string): WindowStats {
  let worked = 0, late = 0, absent = 0, minutes = 0, workingDays = 0, judged = 0, punctual = 0;
  // EXPECTED MINUTES ARE SUMMED PER DAY, not one full-day figure times a count: on a week that mixes a
  // four-hour shift with an eight-hour one, multiplying either of them across the week is wrong in both
  // directions, and this is the number the "done vs expected" bar is read against.
  let arrSum = 0, arrN = 0, depSum = 0, depN = 0, doneMinutes = 0, expectedMinutes = 0;
  for (const r of rows) {
    // A day nobody was rostered on is not a working day, whether it was worked or not: `worked_off_day` joins
    // holiday and on_leave here. Counted, it added a whole `full_day_minutes` of EXPECTATION for voluntary
    // work - so coming in on a Saturday moved the "done vs expected" bar backwards - and put that day's
    // arrival into the punctuality score for a shift window that did not apply to it. The minutes it earned
    // still count below; the day was simply not owed. (`workingDaysInRange` on the server skips it too.)
    // An `untracked` day owes nothing either, until HR marks it: a mark is the one way such a day gets a value.
    const counts = r.status !== "holiday" && r.status !== "on_leave" && r.status !== "worked_off_day" && (r.status !== "untracked" || !!r.mark);
    if (counts) workingDays++;
    if (counts && r.day < todayYmd) expectedMinutes += schedOf(r.day).fullDayMinutes;
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
    // NOT an `else if`. Before day marks these two were exclusive - a status is one value, and no day is both
    // "late" and "absent" - so chaining them cost nothing. A mark breaks that: ANY day with punches can be
    // marked absent, late ones included, and chained the late branch swallowed it and the absence was never
    // counted. They are independent tallies now, and the fallback below still cannot double-count an unmarked
    // day (a late day's status is "late", never "absent").
    // ABSENCE IS THE ONE FIGURE HERE THAT READS AS A CONSEQUENCE rather than an observation - it is the count
    // somebody expects to see reflected in their pay - so it is the one a day mark overrides. Days worked,
    // lateness and short/long days stay what the punches say, because a mark does not claim the punches were
    // wrong; that is a regularization's job.
    //
    // `counts` gates it for the same reason `lopDayUnits` skips those days before it reads a mark: a day that
    // owed nothing settles at nothing whatever the mark says. A holiday or a wholly-excused leave day can
    // still CARRY a mark (leave is approved after the fact, and the mark stays visible so it can be withdrawn)
    // and letting it through here would have this strip count an absence the payroll build does not.
    if (r.mark && counts ? r.mark === "absent" : r.status === "absent") absent++;
  }
  return {
    worked, late, absent, minutes, workingDays,
    avgDay: worked ? Math.round(minutes / worked) : 0,
    onTimePct: judged ? Math.round((punctual / judged) * 100) : null,
    avgIn: arrN ? arrSum / arrN : null,
    avgOut: depN ? depSum / depN : null,
    doneMinutes,
    expectedMinutes,
  };
}

/** One week of the history list: its days plus the subtotal shown on the week's header row. */
export type WeekGroup = { start: string; rows: AttendanceRow[]; minutes: number; days: number };

/** Newest-first day rows, grouped into weeks so a long window has rhythm and each week carries its own total. */
export function groupWeeks(rows: AttendanceRow[]): WeekGroup[] {
  const out: WeekGroup[] = [];
  for (const r of rows) {
    const start = weekStartOf(r.day);
    let g = out[out.length - 1];
    if (!g || g.start !== start) { g = { start, rows: [], minutes: 0, days: 0 }; out.push(g); }
    g.rows.push(r);
    if (r.summary) { g.minutes += r.summary.workedMinutes; g.days++; }
  }
  return out;
}

// How a day status looks: its plain-language label, the Badge variant of its pill, the dot colour in the
// month grid / legend and the cell tint. One table so a colour means the same thing everywhere on the page.
export type StatusUi = { label: string; badge: "success" | "secondary" | "warning" | "destructive" | "muted"; dot: string; cell: string };
export const STATUS_UI: Record<DayStatus, StatusUi> = {
  open: { label: "Clocked in", badge: "success", dot: "bg-emerald-500", cell: "bg-emerald-50 dark:bg-emerald-950/40" },
  present: { label: "On time", badge: "secondary", dot: "bg-emerald-500", cell: "bg-emerald-50 dark:bg-emerald-950/40" },
  late: { label: "Late", badge: "warning", dot: "bg-amber-500", cell: "bg-amber-50 dark:bg-amber-950/40" },
  left_early: { label: "Left early", badge: "warning", dot: "bg-amber-500", cell: "bg-amber-50 dark:bg-amber-950/40" },
  late_early: { label: "Late · left early", badge: "warning", dot: "bg-amber-500", cell: "bg-amber-50 dark:bg-amber-950/40" },
  half_day: { label: "Half day", badge: "warning", dot: "bg-amber-500", cell: "bg-amber-50 dark:bg-amber-950/40" },
  insufficient: { label: "Under hours", badge: "destructive", dot: "bg-rose-500", cell: "bg-rose-50 dark:bg-rose-950/40" },
  on_leave: { label: "On leave", badge: "secondary", dot: "bg-teal-500", cell: "bg-teal-50 dark:bg-teal-950/40" },
  half_day_leave: { label: "Half day leave", badge: "warning", dot: "bg-amber-500", cell: "bg-amber-50 dark:bg-amber-950/40" },
  holiday: { label: "Holiday", badge: "muted", dot: "bg-violet-500", cell: "bg-violet-50 dark:bg-violet-950/40" },
  // Not amber and not rose: this is not a shortfall. The violet end of the palette, beside "Holiday", because
  // that is the kind of day it is.
  worked_off_day: { label: "Worked - not a working day", badge: "secondary", dot: "bg-violet-500", cell: "bg-violet-50 dark:bg-violet-950/40" },
  absent: { label: "Absent", badge: "destructive", dot: "bg-rose-500", cell: "bg-rose-50 dark:bg-rose-950/40" },
  // Neutral: nobody could have punched, so the day is neither kept nor missed.
  untracked: { label: "Before HRMS", badge: "muted", dot: "bg-muted-foreground/40", cell: "bg-muted/40" },
};

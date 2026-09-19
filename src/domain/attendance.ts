// Attendance-driven loss-of-pay for payroll. PURE: timestamps + the org schedule in, day counts + amount
// out. The schedule timezone defines calendar days and weekday membership (a 23:30 IST punch belongs to that
// IST day). Mirrors the client-side derivation in web/src/lib/attendance.ts; kept server-side because payroll
// must compute it authoritatively.

export type LopBasis = "working_days" | "days_30";
// How a partial-employment month is prorated: by calendar days in the period, or by scheduled working days.
export type ProrationBasis = "calendar_days" | "working_days";
// WHICH monthly wage an absent day is docked from. "gross" (default) is the period's regular earnings - basic
// plus every recurring allowance and the Special Allowance plug - because an unworked day earns none of them.
// "basic" docks the contractual basic only, for an org whose allowances are contractually unconditional.
export type LopWageBasis = "gross" | "basic";

// The attendance schedule as stored in settings/attendance (only the fields payroll needs).
export type AttendanceConfig = {
  timezone: string;
  work_days: number[]; // 0=Sun..6=Sat
  full_day_minutes?: number; // worked minutes for a full day; from half_day_minutes up to this counts as a half day
  half_day_minutes?: number; // minimum worked minutes to earn a half day; below this the day doesn't count (full absence)
  lop_enabled?: boolean;
  lop_basis?: LopBasis; // the DIVISOR: scheduled working days in the period, or a fixed 30
  lop_wage_basis?: LopWageBasis; // the WAGE the divisor divides (see LopWageBasis)
  proration_basis?: ProrationBasis; // basis for prorating a mid-period joiner/leaver's regular earnings
};

export const DEFAULT_ATTENDANCE: AttendanceConfig = {
  timezone: "Asia/Kolkata",
  work_days: [1, 2, 3, 4, 5],
  full_day_minutes: 480,
  half_day_minutes: 240,
  lop_enabled: false,
  lop_basis: "working_days",
  lop_wage_basis: "gross",
  proration_basis: "calendar_days",
};

// Fraction (0..1) of the pay period the employee is actually employed for, by the chosen basis - the multiplier
// for their regular earnings so a mid-period joiner/leaver isn't paid (or docked) a full month. 1.0 when
// employed for the whole period (the common case, a no-op). The employment window is the period clamped to the
// employee's start/end dates. LOP for in-window absences is applied separately, at the full daily rate.
import { round2 } from "./money";

export function employmentFraction(opts: {
  periodStartYmd: string;
  periodEndYmd: string;
  empStartYmd?: string | null;
  empEndYmd?: string | null;
  workDays: number[];
  holidays: Set<string>;
  basis: ProrationBasis;
}): number {
  const from = opts.empStartYmd && opts.empStartYmd > opts.periodStartYmd ? opts.empStartYmd : opts.periodStartYmd;
  const to = opts.empEndYmd && opts.empEndYmd < opts.periodEndYmd ? opts.empEndYmd : opts.periodEndYmd;
  if (from > to) return 0; // not employed at all within the period
  if (opts.basis === "working_days") {
    const total = workingDaysInRange(opts.periodStartYmd, opts.periodEndYmd, opts.workDays, opts.holidays);
    if (total <= 0) return 1;
    return Math.min(1, workingDaysInRange(from, to, opts.workDays, opts.holidays) / total);
  }
  const calDays = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;
  const total = calDays(opts.periodStartYmd, opts.periodEndYmd);
  return total <= 0 ? 1 : Math.min(1, calDays(from, to) / total);
}

// Calendar day "YYYY-MM-DD" of an INSTANT, read in the org timezone. For a moment that happened - a punch, an
// audit stamp, `now`. NOT for a date-only column: see utcDay.
export function localDay(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

// Calendar day "YYYY-MM-DD" of a DATE-ONLY column.
//
// Every date-only column in the schema is anchored at UTC midnight (`period_start`, `holidays.date`,
// `leave_requests.start_date`, `employees.start_date`, ...), so the day it NAMES is read in UTC and nowhere
// else. Reading one with `localDay(ms, tz)` asks a different question and gets a different answer: west of
// UTC, midnight-Z on the named day is the PREVIOUS evening locally, so every such day shifts back one - a
// payroll period that starts a day early and ends a day short, holidays that excuse the wrong day, and a
// proration window whose weekday composition is not the period's. East of UTC the two happen to agree, which
// is why the default Asia/Kolkata configuration never showed it.
//
// The rule is stated once in services/orgDay.ts (`dayStartMs` is the inverse: an org-local day -> the ms a
// date-only column stores it at). This is the forward half, named so the distinction is visible at the call
// site rather than being a property of which column somebody remembered.
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * A row carrying the org's calendar day, stamped by a route's `decorate` (services/orgDay.ts#stampOrgToday).
 *
 * The value is the UTC ms that day is stored at - the same anchor `dayStartMs` produces and every date-only
 * column in the schema uses - so a serializer can compare one against "today" without a clock of its own.
 */
export type WithOrgToday = { _todayMs?: number };

/**
 * The day a serializer should compare a date-only column against.
 *
 * The UTC fallback is the pre-stamp behaviour and is kept only so a caller outside the collection factory
 * cannot crash on a row it never decorated - it is NOT the supported path. Every route serializing a resource
 * with a derived "today" field stamps it; a new one that forgets is a day out for part of the day rather than
 * missing a field, which is the direction that hides, so the stamp belongs in the spec, not in the fallback.
 *
 * Lives here rather than in services/orgDay.ts because src/http/serialize.ts is one of its callers and
 * `services/settings.ts` already imports that module - so the reader has to be in a leaf, or the import graph
 * closes a cycle whose correctness depends on evaluation order.
 */
export function todayMsOf(row: WithOrgToday): number {
  if (typeof row._todayMs === "number") return row._todayMs;
  const n = new Date();
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
}

// Weekday (0=Sun..6=Sat) of a "YYYY-MM-DD".
export function weekdayOf(ymd: string): number {
  return new Date(`${ymd}T00:00:00Z`).getUTCDay();
}

function enumerate(startYmd: string, endYmd: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${startYmd}T00:00:00Z`); t <= Date.parse(`${endYmd}T00:00:00Z`); t += 86_400_000) {
    out.push(utcDay(t));
  }
  return out;
}

// Scheduled working days in [startYmd, endYmd] (inclusive) minus holidays - the LOP divisor base.
export function workingDaysInRange(startYmd: string, endYmd: string, workDays: number[], holidays: Set<string>): number {
  return enumerate(startYmd, endYmd).filter((d) => workDays.includes(weekdayOf(d)) && !holidays.has(d)).length;
}

// Wall-clock minutes since midnight of an instant, read in the org timezone.
//
// `hourCycle: "h23"` is STATED rather than inferred from `hour12: false`. The two are not the same request:
// `hour12: false` asks only "not AM/PM" and leaves the cycle to the locale, and the one it can resolve to is
// h24, which numbers midnight as 24 rather than 00. On a runtime that does, this returns 1440 for midnight
// instead of 0 - so a timed count-as-work event starting exactly at local midnight credits `1440 - 1440 = 0`
// minutes on its first day (eventCreditByDay below), and the day reads as unworked. Naming the cycle removes
// the dependency on which resolution the runtime's ICU happens to make.
export function localMinutes(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/**
 * Minutes one attendance session is worth to loss of pay.
 *
 * AN OPEN SESSION IS NOT ZERO. Both LOP walks used to score a session with no `clock_out` as 0 minutes, and
 * `lopDayUnits` reads 0 as "punched, and too short to earn a half day" - so a clock-in, which is positive
 * evidence of attendance, was charged as a full day's absence. Two ways in: a forgotten clock-out on a past
 * day, and - worse - building or rebuilding a run inside the period, which judges today and so docked a full
 * day for every employee currently clocked in. It also inflated `ncpDays` on the PF ECR, so a statutory return
 * overstated non-contributing days.
 *
 * An open session is credited from its clock-in to `min(now, the end of its own local day)`: the same reading
 * the live attendance page already shows the employee, capped so a session left open for a week cannot credit
 * a week. The org-local day boundary is derived from `localMinutes`, like every other day-relative reading
 * here, so the cap lands on the day the punch belongs to rather than on a UTC one.
 *
 * Used by BOTH copies of the walk - services/payroll.ts#assembleLop and
 * services/settlements.ts#finalMonthLopDays - because the settlement is a leaver's terminal payout and there
 * is no later run to correct a disagreement between them.
 */
export function sessionWorkedMinutes(clockInMs: number, clockOutMs: number | null, nowMs: number, tz: string): number {
  if (clockOutMs != null) return Math.max(0, Math.round((clockOutMs - clockInMs) / 60000));
  const endOfLocalDay = clockInMs + (1440 - localMinutes(clockInMs, tz)) * 60_000;
  return Math.max(0, Math.round((Math.min(nowMs, endOfLocalDay) - clockInMs) / 60000));
}

// A count_as_work calendar event as payroll sees it. All-day events are date-anchored at UTC midnight, so
// their calendar days come off the instant directly rather than through the org timezone.
export type WorkEvent = { startMs: number; endMs: number; allDay: boolean; requiresClockIn: boolean };

// Minutes each day is credited by one employee's count_as_work events. Mirrors the client derivation in
// web/src/components/common/TeamTimeline.tsx - keep the two in step, or the timeline shows a day as present
// that payroll then docks. Credit lands only once the event has ended, only on scheduled working days, never
// on an on-leave day, and - when the event requires it - only on a day the employee actually punched. Each
// event credits at most one full day per day; an event crediting less than the half-day minimum leaves the
// day short, exactly as a brief punch would.
export function eventCreditByDay(opts: {
  events: WorkEvent[];
  tz: string;
  workDays: number[];
  fullDayMinutes: number;
  todayYmd: string;
  nowMs: number;
  punchedDays: Set<string>;
  onLeave: (day: string) => boolean;
}): Map<string, number> {
  const { events, tz, workDays, fullDayMinutes, todayYmd, nowMs, punchedDays, onLeave } = opts;
  const out = new Map<string, number>();
  for (const ev of events) {
    if (!ev.allDay && ev.endMs >= nowMs) continue; // timed event still running / upcoming
    const sDay = ev.allDay ? utcDay(ev.startMs) : localDay(ev.startMs, tz);
    const eDay = ev.allDay ? utcDay(ev.endMs) : localDay(ev.endMs, tz);
    for (const day of enumerate(sDay, eDay)) {
      if (!workDays.includes(weekdayOf(day))) continue; // credit scheduled working days only
      if (ev.allDay && day >= todayYmd) continue; // all-day: only days that have fully ended
      if (ev.requiresClockIn && !punchedDays.has(day)) continue; // credit only those actually at work
      if (onLeave(day)) continue; // never credit an on-leave attendee
      let m: number;
      if (ev.allDay) m = fullDayMinutes;
      else if (sDay === eDay) m = localMinutes(ev.endMs, tz) - localMinutes(ev.startMs, tz);
      else if (day === sDay) m = 1440 - localMinutes(ev.startMs, tz);
      else if (day === eDay) m = localMinutes(ev.endMs, tz);
      else m = 1440;
      out.set(day, (out.get(day) ?? 0) + Math.min(fullDayMinutes, Math.max(0, m)));
    }
  }
  return out;
}

/**
 * One approved leave range as LOP sees it. `startSession`/`endSession` are the same half-day flags
 * `leave_requests` stores (1 = first half / AM, 2 = second half / PM): the leave runs contiguously from
 * `startSession` of `start` through `endSession` of `end`. Omitted means the whole of that boundary day, which
 * is the column default and what a caller that does not model halves should pass.
 */
export type LeaveRange = { start: string; end: string; startSession?: number; endSession?: number };

/**
 * How much of day `d` approved leave excuses: 0, 0.5 (one session) or 1 (both).
 *
 * HALF DAYS HAVE TO BE READ HERE, because `leaveDays` (domain/leave.ts) already charges only HALF a day to the
 * balance for a boundary session - so treating the same day as fully excused from loss of pay paid for half a
 * day the employee neither worked nor spent leave on. Sessions are tracked as AM/PM rather than summed, so two
 * ranges that touch the same day cannot add up past the day they are in.
 *
 * EXPORTED for the web bundle, which imports it directly (web/src/lib/attendance.ts) rather than restating it.
 * The attendance grid and the payroll build have to agree about which days leave excuses - a day the grid calls
 * "On leave" and payroll then docks half of is the exact drift `eventCreditByDay` warns about one file over -
 * and the only way two copies of this rule stay in step is for there to be one.
 */
export function leaveCover(d: string, ranges: LeaveRange[]): number {
  let am = false;
  let pm = false;
  for (const r of ranges) {
    if (d < r.start || d > r.end) continue;
    // Interior days are whole; only the range's own endpoints can carry a session flag.
    const first = d === r.start ? (r.startSession ?? 1) : 1;
    const last = d === r.end ? (r.endSession ?? 2) : 2;
    if (first <= 1) am = true;
    if (last >= 2) pm = true;
    if (am && pm) return 1;
  }
  return (am ? 0.5 : 0) + (pm ? 0.5 : 0);
}

/**
 * How much of a day's work a day counts as: a whole day, half of one, or none at all.
 *
 * Ordinarily this is DERIVED from the minutes punched (`derivedCredit` below). A day mark is an HR decision
 * that replaces that derivation for one employee on one day - the short afternoon that was agreed in advance
 * and should count in full, the eight hours clocked by somebody who was not actually working. The two are the
 * same scale on purpose, so a mark substitutes for the derivation rather than being a second mechanism
 * stacked on top of it.
 */
export type DayCredit = "full" | "half" | "absent";
/** A credit as day-units of work: the scale `lopDayUnits` settles up on. */
export const creditUnits = (c: DayCredit): number => (c === "full" ? 1 : c === "half" ? 0.5 : 0);

/**
 * What the punches alone say a day is worth. `undefined` (never punched) is kept distinct from 0 so a
 * configured `half_day_minutes` of 0 still reads a no-show as a no-show rather than as a satisfied half day.
 */
function derivedCredit(worked: number | undefined, fullDayMinutes: number, halfDayMinutes: number): number {
  if (worked === undefined || worked < halfDayMinutes) return 0; // no punch, or too short to earn a half day
  return worked < fullDayMinutes ? 0.5 : 1;
}

// Unexcused loss-of-pay DAY-UNITS over the period for one employee (fractional).
//
// Every scheduled working day that is not a holiday OWES a day of work, less whatever approved leave excuses
// (a half-day leave leaves half a day owed). Against that sits what the day was WORTH: normally the minutes
// punched, on the half-day ladder `derivedCredit` states - and where HR has marked the day, the mark instead.
// What is left over is unexcused, and a day worth more than it owed settles at zero rather than going
// negative (voluntary overtime does not bank against another day's absence).
//
// Stated as owed-minus-credit rather than as a ladder per leave case, because it IS one subtraction: the
// nested form had the same arithmetic written twice, and a day mark would have had to be threaded through
// both copies.
export function lopDayUnits(opts: {
  startYmd: string;
  endYmd: string;
  workDays: number[];
  holidays: Set<string>;
  leaveRanges: LeaveRange[];
  workedByDay: Map<string, number>; // day -> worked minutes; absent if no entry
  /** HR's decision for a day, which replaces what the punches say it was worth. */
  marksByDay?: Map<string, DayCredit>;
  fullDayMinutes: number;
  halfDayMinutes: number;
}): number {
  const { startYmd, endYmd, workDays, holidays, leaveRanges, workedByDay, marksByDay, fullDayMinutes, halfDayMinutes } = opts;
  let units = 0;
  for (const d of enumerate(startYmd, endYmd)) {
    if (!workDays.includes(weekdayOf(d)) || holidays.has(d)) continue;
    const owed = 1 - leaveCover(d, leaveRanges);
    if (owed <= 0) continue; // whole day on leave
    const mark = marksByDay?.get(d);
    const credit = mark ? creditUnits(mark) : derivedCredit(workedByDay.get(d), fullDayMinutes, halfDayMinutes);
    units += Math.max(0, owed - credit);
  }
  return Math.round(units * 2) / 2; // stay on the half-day grid
}

// LOP = (monthly wage / divisor) * absent days. `monthlyWage` is the wage the org docks from - the period's
// regular GROSS by default, not the bare basic: an unworked day earns neither the basic nor the allowances
// stacked on it, so docking basic alone charges roughly half of the day the employee did not work (and leaves
// the ESI/PF/tax bases inflated by the allowances that kept paying). The caller picks the wage per
// `lop_wage_basis`; this function only divides it. Divisor is the period's scheduled working days, or a fixed
// 30 ("days_30"). Rounded to paise. Clamped at 0.
export function lopAmount(monthlyWage: number, absentDays: number, basis: LopBasis, workingDaysInPeriod: number): number {
  if (absentDays <= 0 || monthlyWage <= 0) return 0;
  const divisor = basis === "days_30" ? 30 : Math.max(1, workingDaysInPeriod);
  return round2((monthlyWage / divisor) * absentDays);
}

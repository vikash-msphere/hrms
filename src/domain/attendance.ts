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

// Unexcused loss-of-pay DAY-UNITS over the period for one employee (fractional). For each scheduled working
// day that is not a holiday and not covered by approved leave: no punch is a full absence (1.0); worked below
// the half-day minimum is also a full absence (the session is too short to count); worked from the half-day
// minimum up to a full day is a half day (0.5); a full day adds nothing.
export function lopDayUnits(opts: {
  startYmd: string;
  endYmd: string;
  workDays: number[];
  holidays: Set<string>;
  leaveRanges: { start: string; end: string }[];
  workedByDay: Map<string, number>; // day -> worked minutes; absent if no entry
  fullDayMinutes: number;
  halfDayMinutes: number;
}): number {
  const { startYmd, endYmd, workDays, holidays, leaveRanges, workedByDay, fullDayMinutes, halfDayMinutes } = opts;
  const onLeave = (d: string) => leaveRanges.some((r) => r.start <= d && d <= r.end);
  let units = 0;
  for (const d of enumerate(startYmd, endYmd)) {
    if (!workDays.includes(weekdayOf(d)) || holidays.has(d) || onLeave(d)) continue;
    const worked = workedByDay.get(d);
    if (worked === undefined || worked < halfDayMinutes) units += 1; // no punch, or too short to earn a half day
    else if (worked < fullDayMinutes) units += 0.5; // earned a half day
    // else: a full day, nothing deducted
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

// Attendance-driven loss-of-pay for payroll. PURE: timestamps + the org schedule in, day counts + amount
// out. The schedule timezone defines calendar days and weekday membership (a 23:30 IST punch belongs to that
// IST day). Mirrors the client-side derivation in web/src/lib/attendance.ts; kept server-side because payroll
// must compute it authoritatively.

export type LopBasis = "working_days" | "days_30";
// How a partial-employment month is prorated: by calendar days in the period, or by scheduled working days.
export type ProrationBasis = "calendar_days" | "working_days";

// The attendance schedule as stored in settings/attendance (only the fields payroll needs).
export type AttendanceConfig = {
  timezone: string;
  work_days: number[]; // 0=Sun..6=Sat
  full_day_minutes?: number; // worked minutes for a full day; from half_day_minutes up to this counts as a half day
  half_day_minutes?: number; // minimum worked minutes to earn a half day; below this the day doesn't count (full absence)
  lop_enabled?: boolean;
  lop_basis?: LopBasis;
  proration_basis?: ProrationBasis; // basis for prorating a mid-period joiner/leaver's regular earnings
};

export const DEFAULT_ATTENDANCE: AttendanceConfig = {
  timezone: "Asia/Kolkata",
  work_days: [1, 2, 3, 4, 5],
  full_day_minutes: 480,
  half_day_minutes: 240,
  lop_enabled: false,
  lop_basis: "working_days",
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

// Calendar day "YYYY-MM-DD" of an instant in the org timezone.
export function localDay(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

// Weekday (0=Sun..6=Sat) of a "YYYY-MM-DD".
export function weekdayOf(ymd: string): number {
  return new Date(`${ymd}T00:00:00Z`).getUTCDay();
}

function enumerate(startYmd: string, endYmd: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${startYmd}T00:00:00Z`); t <= Date.parse(`${endYmd}T00:00:00Z`); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

// Scheduled working days in [startYmd, endYmd] (inclusive) minus holidays - the LOP divisor base.
export function workingDaysInRange(startYmd: string, endYmd: string, workDays: number[], holidays: Set<string>): number {
  return enumerate(startYmd, endYmd).filter((d) => workDays.includes(weekdayOf(d)) && !holidays.has(d)).length;
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

// LOP = (monthly base pay / divisor) * absent days. Divisor is the period's scheduled working days, or a
// fixed 30 ("days_30"). Rounded to paise. Clamped at 0.
export function lopAmount(basePay: number, absentDays: number, basis: LopBasis, workingDaysInPeriod: number): number {
  if (absentDays <= 0 || basePay <= 0) return 0;
  const divisor = basis === "days_30" ? 30 : Math.max(1, workingDaysInPeriod);
  return round2((basePay / divisor) * absentDays);
}

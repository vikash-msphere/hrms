import type { AttendanceSession } from "@/types";

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
  full_day_minutes: number; // worked minutes for a full day; from half_day_minutes up to this is a half day
  half_day_minutes: number; // minimum worked minutes to earn a half day; below this the day doesn't count
  flexible_hours?: boolean; // judge the day by minutes worked only; don't flag late arrival / early departure
  lop_enabled?: boolean; // deduct loss-of-pay for unexcused absences at payroll build
  lop_basis?: "working_days" | "days_30"; // per-day rate divisor
  proration_basis?: "calendar_days" | "working_days"; // how a mid-period joiner/leaver's earnings are prorated
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
  lop_enabled: false,
  lop_basis: "working_days",
  proration_basis: "calendar_days",
};

const hhmmToMin = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

// Minutes-since-midnight of an instant in the org timezone (so 09:05 IST -> 545 regardless of viewer tz).
export function localMinutes(iso: string, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

// The org-local calendar day ("YYYY-MM-DD") of an instant - used to group punches into days.
export function localDay(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

// Inverse of localDay+wall-clock: the ISO instant for a wall-clock "HH:MM" on calendar day "YYYY-MM-DD" read
// in the org timezone. Guesses the instant as if UTC, then corrects by the zone's offset at that moment (so
// 09:00 on 2026-07-14 in Asia/Kolkata -> 03:30Z). Used to turn correction-dialog times back into punches.
export function zonedInstant(ymd: string, hhmm: string, tz: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const guess = Date.parse(`${ymd}T${String(h || 0).padStart(2, "0")}:${String(m || 0).padStart(2, "0")}:00Z`);
  // Offset (minutes) = wall-clock the guess prints in tz, minus the wall-clock we asked for.
  const shown = localMinutes(new Date(guess).toISOString(), tz);
  const wanted = (h || 0) * 60 + (m || 0);
  let offset = shown - wanted;
  if (offset > 720) offset -= 1440; // day-wrap: the guess printed as the previous/next day
  else if (offset < -720) offset += 1440;
  return new Date(guess - offset * 60000).toISOString();
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
  lateByMin: number;
  earlyByMin: number;
};

// The shift window a single day is judged against. `grace` is that day's effective lateness allowance -
// widened by a grace exception, or Infinity when the exception waives lateness entirely.
type ShiftWindow = { tz: string; startMin: number; endMin: number; grace: number };

// One day's punches -> its summary. Late / left-early are judged against that day's own shift window.
function summarizeDay(day: string, ss: AttendanceSession[], shift: ShiftWindow): DaySummary {
  const sorted = [...ss].sort((a, b) => +new Date(a.clock_in) - +new Date(b.clock_in));
  const arrival = sorted[0]?.clock_in;
  const closed = sorted.filter((s) => s.clock_out);
  const open = sorted.some((s) => !s.clock_out);
  const departure = closed.length ? closed[closed.length - 1]!.clock_out : undefined;
  const workedMinutes = closed.reduce((sum, s) => sum + Math.max(0, Math.round((+new Date(s.clock_out!) - +new Date(s.clock_in)) / 60000)), 0);
  const arrMin = arrival ? localMinutes(arrival, shift.tz) : 0;
  const depMin = departure ? localMinutes(departure, shift.tz) : 0;
  const late = !!arrival && arrMin > shift.startMin + shift.grace;
  const leftEarly = !!departure && depMin < shift.endMin - shift.grace;
  return {
    day,
    sessions: sorted,
    arrival,
    departure,
    workedMinutes,
    open,
    late,
    leftEarly,
    lateByMin: late ? arrMin - shift.startMin : 0,
    earlyByMin: leftEarly ? shift.endMin - depMin : 0,
  };
}

// Group a flat session list into per-day summaries with derived late/early flags. Sorted newest day first.
export function summarizeByDay(sessions: AttendanceSession[], sched: AttendanceSchedule): DaySummary[] {
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
    out.push(summarizeDay(day, ss, { tz: sched.timezone, startMin, endMin, grace }));
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
export type DayStatus = "open" | "present" | "late" | "left_early" | "late_early" | "half_day" | "insufficient" | "on_leave" | "holiday" | "absent";
export type AttendanceRow = { day: string; summary?: DaySummary; status: DayStatus };

// Status of a day that has punches and/or event work credit. `total` is clocked + event-credited minutes;
// `s` is absent on an event-only day. Minutes decide first (a day too short to count can't be "late"), then
// punctuality - which only applies when there are real punches and the schedule isn't flexible.
function dayStatus(s: DaySummary | undefined, total: number, sched: AttendanceSchedule): DayStatus {
  if (s?.open) return "open";
  if (total < sched.half_day_minutes) return "insufficient"; // too little (clocked + event) to earn even a half day
  if (total < sched.full_day_minutes) return "half_day";
  if (sched.flexible_hours || !s) return "present"; // event-only or flexible: a full day's worth of minutes = present
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
  sched: AttendanceSchedule;
  summaries: DaySummary[];
  holidays: Set<string>;
  leaveRanges: { start: string; end: string }[];
  workMinutesByDay?: Map<string, number>; // count_as_work events: minutes credited toward the day's worked total
  joinedYmd?: string; // employee start date; days before it aren't their attendance, so they're omitted (no absent)
}): AttendanceRow[] {
  const { fromYmd, toYmd, todayYmd, sched, summaries, holidays, leaveRanges, workMinutesByDay = new Map(), joinedYmd } = opts;
  const byDay = new Map(summaries.map((s) => [s.day, s]));
  const onLeave = (day: string) => leaveRanges.some((r) => r.start <= day && day <= r.end);
  const rows: AttendanceRow[] = [];
  for (const day of enumerateDays(fromYmd, toYmd)) {
    if (joinedYmd && day < joinedYmd) continue; // before the employee joined -> not their attendance
    const s = byDay.get(day);
    const credit = workMinutesByDay.get(day) ?? 0; // worked-minutes credited by count-as-work events
    if (s || credit > 0) {
      // Event credit adds to clocked minutes for the day's total; late/early flags come from real punches only.
      const total = (s?.workedMinutes ?? 0) + credit;
      const status = dayStatus(s, total, sched);
      const summary: DaySummary = s
        ? { ...s, workedMinutes: total }
        : { day, sessions: [], workedMinutes: total, open: false, late: false, leftEarly: false, lateByMin: 0, earlyByMin: 0 };
      rows.push({ day, summary, status });
    } else if (!sched.work_days.includes(weekdayOf(day))) {
      continue; // weekend / non-working day with no punch
    } else if (holidays.has(day)) {
      rows.push({ day, status: "holiday" });
    } else if (onLeave(day)) {
      rows.push({ day, status: "on_leave" });
    } else if (day < todayYmd) {
      rows.push({ day, status: "absent" }); // a past working day with no punch and no leave/holiday
    }
    // today / future with no punch yet -> omit
  }
  return rows.sort((a, b) => b.day.localeCompare(a.day));
}

export const fmtHM = (iso: string, tz: string) =>
  new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: true }).format(new Date(iso));

export const fmtDuration = (min: number) => `${Math.floor(min / 60)}h ${min % 60}m`;

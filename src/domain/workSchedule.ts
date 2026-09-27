// THE SCHEDULE ONE PERSON IS ON, ONE DAY AT A TIME.
//
// PURE: data in, a day's schedule out. Imported by the web bundle directly, for the reason
// domain/attendance.ts gives for `leaveCover` - the attendance grid and the payroll build have to agree about
// what a day was owed and what it was worth, and the only way two readers agree is for there to be one rule.
//
// Every reader of a working day used to read `settings/attendance` and get the SAME answer for everybody: one
// `work_days` set, one shift window, one `full_day_minutes`. That is the org's schedule, not the person's, so
// a part-timer on Mon/Wed/Fri was absent on Tuesday, a night-shift arrival at 21:00 was twelve hours late
// against a 09:00 window, and a four-hour shift could never clear the 480-minute bar a full day needed.
//
// A day now resolves through three layers, most specific first:
//
//   1. a DAY OVERRIDE - a roster entry (`shift_assignments`) for that person on that date, which is either a
//      shift or an explicit rest day. One-off cover, a swapped day.
//   2. a PATTERN - the work pattern they are assigned to over that date (`work_pattern_assignments`), read at
//      that date's position in the pattern's cycle. This is what a schedule IS: a repeating week or rotation.
//   3. the ORG DEFAULT - `settings/attendance`, exactly as before. Everybody who is on nothing else is on this,
//      which is why turning the resolver on moves no existing org's numbers.
//
// `orgScheduleOf` builds layer 3 on its own. A caller with no employee in hand passes it and behaves as the
// app always has.
import { weekdayOf, type AttendanceConfig } from "./attendance";

// ---- The org's own window ----------------------------------------------------------------------------------

/** The fields of `settings/attendance` that describe the org's shift. Mirrors web/src/lib/attendance.ts#AttendanceSchedule. */
export type ShiftSchedule = {
  timezone: string;
  work_days: number[];
  shift_start: string; // "HH:MM"
  shift_end: string; // "HH:MM"
  grace_minutes: number;
  grace_exceptions?: { date: string; reason?: string; extra_grace_minutes?: number }[];
  flexible_hours?: boolean;
};

export const DEFAULT_SHIFT: ShiftSchedule = { timezone: "Asia/Kolkata", work_days: [1, 2, 3, 4, 5], shift_start: "09:00", shift_end: "18:00", grace_minutes: 15 };

/**
 * The schedule out of a stored attendance blob, with the SPA's defaults filled in. The server's own
 * `AttendanceConfig` never carried the shift window because loss of pay never needed it; the blob the SPA saves
 * has always held it, and an org that never saved one is on the defaults the SPA shows.
 */
export function shiftScheduleOf(att: Partial<ShiftSchedule> | Record<string, unknown> | null | undefined): ShiftSchedule {
  const a = (att ?? {}) as Partial<ShiftSchedule>;
  const hhmm = (v: unknown, d: string) => (typeof v === "string" && /^\d{1,2}:\d{2}$/.test(v) ? v : d);
  return {
    timezone: typeof a.timezone === "string" && a.timezone ? a.timezone : DEFAULT_SHIFT.timezone,
    work_days: Array.isArray(a.work_days) ? a.work_days : DEFAULT_SHIFT.work_days,
    shift_start: hhmm(a.shift_start, DEFAULT_SHIFT.shift_start),
    shift_end: hhmm(a.shift_end, DEFAULT_SHIFT.shift_end),
    grace_minutes: typeof a.grace_minutes === "number" && Number.isFinite(a.grace_minutes) && a.grace_minutes >= 0 ? a.grace_minutes : DEFAULT_SHIFT.grace_minutes,
    grace_exceptions: Array.isArray(a.grace_exceptions) ? a.grace_exceptions : [],
    flexible_hours: a.flexible_hours === true,
  };
}

/** Minutes since midnight of a wall-clock "HH:MM". */
export const minOfDay = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};
/** A minutes-since-midnight as "HH:MM". */
export const hhmmOf = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/**
 * The day's grace allowance: the org's, widened by a grace exception, or Infinity when the exception waives the
 * judgement entirely. The same reading web/src/lib/attendance.ts#summarizeByDay and analytics make.
 *
 * A grace exception is a CLOSURE-DAY decision - bad weather, a transit strike - so it belongs to the calendar
 * day rather than to whichever shift the person was on, and it widens a rostered shift's own grace the same way
 * it widens the org's.
 */
export function graceOn(day: string, sched: ShiftSchedule): number {
  const ex = (sched.grace_exceptions ?? []).find((e) => e.date === day);
  if (!ex) return sched.grace_minutes;
  return ex.extra_grace_minutes == null ? Infinity : sched.grace_minutes + ex.extra_grace_minutes;
}

// ---- What a resolved day is --------------------------------------------------------------------------------

/**
 * What ONE day is for ONE person: the window it is judged against, and what it is worth.
 *
 * `off` is the single question every day-walk asks first ("is anything owed here"), and it is the reason this
 * type exists rather than a `work_days` array being threaded further: a rest day in a rotation is not a
 * property of the weekday, it is a property of the person on that date.
 *
 * `endMin` LESS THAN `startMin` means the shift runs past midnight. The day a night shift belongs to is its
 * START day, which is the day its clock-in punch falls on (domain/punctuality.ts#punchDays groups that way).
 */
export type DaySchedule = {
  off: boolean;
  /** The shift this came from; absent on a day governed by the org's own window. */
  shiftId?: string;
  shiftName?: string;
  startMin: number; // minutes since midnight, org timezone
  endMin: number;
  breakMinutes: number;
  graceMinutes: number;
  fullDayMinutes: number; // worked minutes that earn a full day
  halfDayMinutes: number; // worked minutes that earn a half day
  flexible: boolean; // judged on minutes only: never late, never early
};

/**
 * One person's schedule, day by day.
 *
 * Every pure walk in domain/attendance.ts and domain/punctuality.ts takes this in place of the
 * `workDays` + `fullDayMinutes` + `halfDayMinutes` triple it used to take, because all three of them are now
 * answers to "which day, for whom" rather than constants of the org.
 */
export type DayScheduleOf = (ymd: string) => DaySchedule;

/**
 * One employee's schedule, by id - what a period walk asks for once per person.
 *
 * A resolver rather than a map because the caller that builds it (services/workSchedule.ts) has already read
 * the window's patterns and roster entries and knows which employees it read them for; an id it was not built
 * for answers with the org's own days, which is the right answer for somebody on nothing else.
 */
export type ScheduleResolver = (employeeId: string) => DayScheduleOf;

/** The resolver for an org where nobody's day differs: everyone gets `sched`. */
export const sameForEveryone = (sched: DayScheduleOf): ScheduleResolver => () => sched;

// ---- The inputs the resolver reads ---------------------------------------------------------------------------

/** A `shifts` row as the resolver reads it. Null on any of the last four means "take the org's answer". */
export type ShiftDef = {
  id: string;
  name: string;
  startTime: string; // "HH:MM"
  endTime: string; // "HH:MM"
  breakMinutes: number;
  fullDayMinutes?: number | null;
  halfDayMinutes?: number | null;
  graceMinutes?: number | null;
  flexibleHours?: boolean | null;
};

/** A roster entry: this person works this shift on this day, or is explicitly off it. */
export type DayOverride = { shiftId: string | null; off: boolean };

/**
 * A work pattern: a cycle of `cycleWeeks` weeks.
 *
 * `days` is indexed `weekIndex * 7 + weekday`, weekday 0=Sun..6=Sat, so a week of the array reads Sun..Sat
 * whatever weekday a calendar grid happens to start its columns on. An entry is a shift id, or null for a
 * rest day - which is how a pattern says "Mon/Wed/Fri only" without a second list of working days to keep in
 * step with the first.
 */
export type PatternDef = { id: string; name: string; cycleWeeks: number; days: (string | null)[] };

/**
 * One person on one pattern over a window. `endYmd` null is open-ended.
 *
 * `anchorYmd` is the date the cycle counts from, so two teams on the same three-week rotation offset by a week
 * differ in this and nothing else. It is snapped to its own week (below), so a cycle always turns over on a
 * week boundary rather than mid-week.
 */
export type PatternSpan = { patternId: string; startYmd: string; endYmd: string | null; anchorYmd: string };

// ---- Arithmetic a shift's own day-lengths come from ----------------------------------------------------------

const DAY_MS = 86_400_000;
const ymdMs = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`);

/** How long a shift runs, wrap included: 22:00-06:00 is eight hours, not minus sixteen. */
export function shiftSpanMinutes(startMin: number, endMin: number): number {
  const d = endMin - startMin;
  return d > 0 ? d : d + 1440;
}

/** The minutes a shift is actually worked for: its span, less the break that sits inside it. */
export function shiftPaidMinutes(shift: Pick<ShiftDef, "startTime" | "endTime" | "breakMinutes">): number {
  return Math.max(0, shiftSpanMinutes(minOfDay(shift.startTime), minOfDay(shift.endTime)) - (shift.breakMinutes || 0));
}

/**
 * A shift as a day, with the org's day filling in whatever the shift does not state.
 *
 * A FULL DAY IS THE SHIFT unless the shift says otherwise, and HALF A DAY IS HALF THE FULL ONE. That is the
 * rule a four-hour shift needs: without it the org's 480-minute bar applies to it, so every four-hour day the
 * person ever works reads as under hours and is docked half a day. `full_day_minutes` and `half_day_minutes`
 * on the shift override each step for the shift that genuinely is not its own span (a nine-hour window whose
 * full day is eight).
 *
 * The org's own day keeps its stored numbers rather than deriving them: the default 09:00-18:00 window is 540
 * minutes and every org's stored `full_day_minutes` is 480, so deriving there would move a figure nobody
 * asked to move.
 */
export function shiftDay(shift: ShiftDef, fallback: DaySchedule): DaySchedule {
  const startMin = minOfDay(shift.startTime);
  const endMin = minOfDay(shift.endTime);
  const paid = Math.max(0, shiftSpanMinutes(startMin, endMin) - (shift.breakMinutes || 0));
  const fullDayMinutes = shift.fullDayMinutes ?? paid;
  return {
    off: false,
    shiftId: shift.id,
    shiftName: shift.name,
    startMin,
    endMin,
    breakMinutes: shift.breakMinutes || 0,
    graceMinutes: shift.graceMinutes ?? fallback.graceMinutes,
    fullDayMinutes,
    halfDayMinutes: shift.halfDayMinutes ?? Math.round(fullDayMinutes / 2),
    flexible: shift.flexibleHours ?? fallback.flexible,
  };
}

/** The same day, owing nothing. The window is kept so a reader that formats one still has something to show. */
const asOff = (d: DaySchedule): DaySchedule => ({ ...d, off: true, shiftId: undefined, shiftName: undefined });

// ---- Layer 3: the org ----------------------------------------------------------------------------------------

/**
 * The org's schedule as a per-day answer: `work_days` decides whether the day is owed, and the stored window
 * and minutes describe it.
 *
 * THIS IS THE WHOLE OF TODAY'S BEHAVIOUR. Every walk that has no employee in hand passes this and gets exactly
 * what it got before the resolver existed, which is what lets the refactor of the pure signatures move no
 * numbers.
 */
export function orgScheduleOf(att: (AttendanceConfig & Partial<ShiftSchedule>) | Record<string, unknown>): DayScheduleOf {
  const sched = shiftScheduleOf(att);
  const a = att as AttendanceConfig;
  const startMin = minOfDay(sched.shift_start);
  const endMin = minOfDay(sched.shift_end);
  const fullDayMinutes = a.full_day_minutes ?? 480;
  const halfDayMinutes = a.half_day_minutes ?? 240;
  const breakMinutes = 0; // the org blob has never carried one; a shift is where a break is described
  return (ymd: string): DaySchedule => ({
    off: !sched.work_days.includes(weekdayOf(ymd)),
    startMin,
    endMin,
    breakMinutes,
    graceMinutes: graceOn(ymd, sched),
    fullDayMinutes,
    halfDayMinutes,
    flexible: sched.flexible_hours === true,
  });
}

// ---- Layer 2: the pattern's cycle -----------------------------------------------------------------------------

/** The Sunday on or before `ymd`, as ms. A cycle turns over on a week boundary, never mid-week. */
const weekStartMs = (ymd: string) => ymdMs(ymd) - weekdayOf(ymd) * DAY_MS;

/**
 * Which week of the cycle `ymd` falls in, counted from the anchor's own week.
 *
 * Floor-modulo, so a day BEFORE the anchor still resolves: an assignment can be anchored to the middle of its
 * own span (a rotation that was already running when it was recorded), and `-1 % 3` is -1 in JavaScript, which
 * would index off the front of the array.
 */
export function cycleWeekIndex(ymd: string, anchorYmd: string, cycleWeeks: number): number {
  const weeks = Math.round((weekStartMs(ymd) - weekStartMs(anchorYmd)) / (7 * DAY_MS));
  const n = Math.max(1, cycleWeeks);
  return ((weeks % n) + n) % n;
}

/** The span covering `ymd`, if one does. Spans for one employee never overlap (services/workSchedule.ts). */
function spanOn(ymd: string, spans: readonly PatternSpan[]): PatternSpan | undefined {
  return spans.find((s) => ymd >= s.startYmd && (s.endYmd == null || ymd <= s.endYmd));
}

// ---- The resolver -------------------------------------------------------------------------------------------

/**
 * One employee's `DayScheduleOf`, over the three layers.
 *
 * MEMOIZED, because the callers are day walks: a payroll build asks for every day of the period once per
 * measure it takes (the loss-of-pay walk, the owed-days clamp the penalty is capped against, the working-days
 * divisor), and each of those would otherwise re-find the span and re-read the pattern for the same date.
 */
export function employeeScheduleOf(opts: {
  /** Layer 3, built once for the org (`orgScheduleOf`). */
  org: DayScheduleOf;
  shifts: ReadonlyMap<string, ShiftDef>;
  patterns: ReadonlyMap<string, PatternDef>;
  /** This employee's pattern assignments. Order does not matter; they do not overlap. */
  spans: readonly PatternSpan[];
  /** This employee's roster entries, keyed "YYYY-MM-DD". */
  overrides: ReadonlyMap<string, DayOverride>;
}): DayScheduleOf {
  const { org, shifts, patterns, spans, overrides } = opts;
  const memo = new Map<string, DaySchedule>();
  return (ymd: string): DaySchedule => {
    const hit = memo.get(ymd);
    if (hit) return hit;
    const base = org(ymd);
    let out: DaySchedule;
    const override = overrides.get(ymd);
    const shiftOf = (id: string | null | undefined) => (id ? shifts.get(id) : undefined);
    if (override) {
      // A roster entry is a decision about THIS day, so it wins even over a rest day in the pattern (cover on a
      // day off) and over a working day in it (a swapped day). An entry naming a shift the catalogue no longer
      // holds falls through to the layer beneath rather than inventing a window.
      const s = override.off ? undefined : shiftOf(override.shiftId);
      if (override.off) out = asOff(base);
      else if (s) out = shiftDay(s, base);
      else out = base;
    } else {
      const span = spanOn(ymd, spans);
      const pattern = span ? patterns.get(span.patternId) : undefined;
      if (span && pattern) {
        const idx = cycleWeekIndex(ymd, span.anchorYmd, pattern.cycleWeeks) * 7 + weekdayOf(ymd);
        const s = shiftOf(pattern.days[idx]);
        // A null entry is a REST DAY, which is the whole of how a pattern says "Mon/Wed/Fri". An entry naming a
        // missing shift is treated as one too: the pattern said this day is not an ordinary org day, and
        // falling back to the org's weekday set would put the person back on a five-day week.
        out = s ? shiftDay(s, base) : asOff(base);
      } else {
        out = base;
      }
    }
    memo.set(ymd, out);
    return out;
  };
}

/**
 * Whether the day-override and pattern layers are consulted at all (`settings/attendance.schedule_source`).
 *
 * "org" is layer 3 alone, which is what the app did before schedules existed - and the default, because an org
 * that has been keeping a roster as a planning grid must not find those entries deciding pay the moment this
 * ships. "resolved" runs all three.
 */
export type ScheduleSource = "org" | "resolved";
export const SCHEDULE_SOURCES: readonly ScheduleSource[] = ["org", "resolved"];
export const scheduleSourceOf = (att: { schedule_source?: unknown } | null | undefined): ScheduleSource =>
  (att as { schedule_source?: string } | null | undefined)?.schedule_source === "resolved" ? "resolved" : "org";

// Late arrival and early departure. The org's policy (`settings/punctuality`) and the pure rules every reader of
// it shares: the request form and the server's filing checks, the attendance grid, analytics, the payroll build
// and the final settlement.
//
// PURE and imported by the web bundle directly (web/src/lib/attendance.ts), for the reason domain/attendance.ts
// gives for `leaveCover`: the grid calling a day "Late" that payroll then treats as excused, or the other way
// round, is the drift a second copy of these rules produces, and the only way two readers agree is one rule.
//
// HOW A REQUEST CHANGES A DAY. An approved late arrival moves that day's shift START to the approved time; an
// approved early departure moves its END. The day is then judged against the moved window exactly as any other
// day is judged against the org's, so arriving by the approved time (plus grace) is on time and arriving after
// it is late by the minutes past the approved time. Nothing else about the day changes unless the policy says so
// (`attendance.credit_minutes`).
import { invalidArgument } from "../lib/errors";
import { isUntracked, leaveCover, localMinutes, lopDayUnits, weekdayOf, type DayCredit, type LeaveRange } from "./attendance";

export type LateEarlyKind = "late_arrival" | "early_departure";
export const LATE_EARLY_KINDS: readonly LateEarlyKind[] = ["late_arrival", "early_departure"];
export const KIND_LABEL: Record<LateEarlyKind, string> = { late_arrival: "Late arrival", early_departure: "Early departure" };

export type LimitScope = "combined" | "per_kind";
export type OverLimit = "refuse" | "allow";
export type PenaltyCounts = "late" | "early" | "both";

export type PunctualityPolicy = {
  /** Who may file what, and when. */
  requests: {
    enabled: boolean;
    late_arrival: boolean;
    early_departure: boolean;
    /** The longest single request, in minutes. Past this it is a half-day leave, not a late arrival. */
    max_minutes: number | null;
    /** Allowance per calendar month, over the requests still pending or approved. */
    monthly_count: number | null;
    monthly_minutes: number | null;
    /** Whether the two kinds share one allowance or each has its own. */
    limit_scope: LimitScope;
    /** A request past the allowance: refused, or accepted and flagged for the approver. */
    over_limit: OverLimit;
    /** How many days back a request may be filed; 0 = today onward; null = any. */
    backdate_days: number | null;
    /** How many days ahead; null = any. */
    advance_days: number | null;
    /** A request has to be filed before the time it covers (the shift start, or the planned departure). */
    before_time: boolean;
    reason_required: boolean;
    /** Requests of at most this many minutes, inside the allowance, are approved on filing. Null = never. */
    auto_approve_minutes: number | null;
  };
  /** What an APPROVED request does to the day, beyond moving its window. */
  attendance: {
    /** The org's grace minutes still apply after the approved time. Off = the approved time is exact. */
    grace_on_top: boolean;
    /** The approved gap counts as worked time for the full-day and half-day thresholds. */
    credit_minutes: boolean;
  };
  /** What UNEXCUSED lateness costs. Charged through automatic loss of pay, so it needs `lop_enabled`. */
  penalties: {
    enabled: boolean;
    /** Which unexcused marks count toward the tally. */
    counts: PenaltyCounts;
    /** Marks per pay period before any deduction. */
    free_marks: number;
    /** Each further block of this many marks docks `deduct_days`. */
    every: number;
    deduct_days: number;
    /** The most the marks may dock in one period. Null = no cap. */
    max_days: number | null;
    /** An unexcused lateness or early departure longer than this counts the day as at most a half day. */
    severe_minutes: number | null;
  };
};

export const DEFAULT_PUNCTUALITY: PunctualityPolicy = {
  requests: {
    enabled: true,
    late_arrival: true,
    early_departure: true,
    max_minutes: 240,
    monthly_count: null,
    monthly_minutes: null,
    limit_scope: "combined",
    over_limit: "refuse",
    backdate_days: 7,
    advance_days: 90,
    before_time: false,
    reason_required: true,
    auto_approve_minutes: null,
  },
  attendance: { grace_on_top: true, credit_minutes: false },
  penalties: { enabled: false, counts: "both", free_marks: 3, every: 3, deduct_days: 0.5, max_days: null, severe_minutes: null },
};

// ---- Reading and validating the stored blob --------------------------------------------------------------

type Section = keyof PunctualityPolicy;
const SECTIONS: readonly Section[] = ["requests", "attendance", "penalties"];
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isIntIn = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const isHalfStepIn = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi && Number.isInteger(v * 2);

// Each leaf's shape, as data: the one table both the lenient reader and the strict validator walk, so a leaf the
// reader honours is a leaf the validator checks, and a typo is refused rather than silently read as the default.
type Leaf =
  | { t: "bool" }
  | { t: "int"; lo: number; hi: number; nullable?: boolean }
  | { t: "half"; lo: number; hi: number; nullable?: boolean }
  | { t: "enum"; of: readonly string[] };
const LEAVES: { [S in Section]: Record<keyof PunctualityPolicy[S] & string, Leaf> } = {
  requests: {
    enabled: { t: "bool" },
    late_arrival: { t: "bool" },
    early_departure: { t: "bool" },
    max_minutes: { t: "int", lo: 1, hi: 1440, nullable: true },
    monthly_count: { t: "int", lo: 1, hi: 100, nullable: true },
    monthly_minutes: { t: "int", lo: 1, hi: 44_640, nullable: true },
    limit_scope: { t: "enum", of: ["combined", "per_kind"] },
    over_limit: { t: "enum", of: ["refuse", "allow"] },
    backdate_days: { t: "int", lo: 0, hi: 366, nullable: true },
    advance_days: { t: "int", lo: 0, hi: 366, nullable: true },
    before_time: { t: "bool" },
    reason_required: { t: "bool" },
    auto_approve_minutes: { t: "int", lo: 1, hi: 1440, nullable: true },
  },
  attendance: {
    grace_on_top: { t: "bool" },
    credit_minutes: { t: "bool" },
  },
  penalties: {
    enabled: { t: "bool" },
    counts: { t: "enum", of: ["late", "early", "both"] },
    free_marks: { t: "int", lo: 0, hi: 31 },
    every: { t: "int", lo: 1, hi: 31 },
    deduct_days: { t: "half", lo: 0.5, hi: 1 },
    max_days: { t: "half", lo: 0.5, hi: 31, nullable: true },
    severe_minutes: { t: "int", lo: 1, hi: 1440, nullable: true },
  },
};

function leafOk(leaf: Leaf, v: unknown): boolean {
  if (v === null) return "nullable" in leaf && !!leaf.nullable;
  switch (leaf.t) {
    case "bool": return typeof v === "boolean";
    case "int": return isIntIn(v, leaf.lo, leaf.hi);
    case "half": return isHalfStepIn(v, leaf.lo, leaf.hi);
    case "enum": return typeof v === "string" && leaf.of.includes(v);
  }
}

function leafRule(leaf: Leaf): string {
  const orNull = "nullable" in leaf && leaf.nullable ? ", or null for none" : "";
  switch (leaf.t) {
    case "bool": return "true or false";
    case "int": return `a whole number from ${leaf.lo} to ${leaf.hi}${orNull}`;
    case "half": return `a number of days from ${leaf.lo} to ${leaf.hi} in half-day steps${orNull}`;
    case "enum": return `one of ${leaf.of.join(", ")}`;
  }
}

/**
 * The stored blob as the policy it means, leaf by leaf.
 *
 * DEEP, because `getSettingValue` merges shallowly: a stored `requests` object replaces the whole default
 * `requests` section, so an org that saved only `max_minutes` would otherwise read every other request rule as
 * undefined. A leaf that is absent or malformed reads as its default here; the validator below is what keeps a
 * malformed one from being stored in the first place.
 */
export function punctualityPolicyOf(raw: unknown): PunctualityPolicy {
  const src = isObj(raw) ? raw : {};
  const out = structuredClone(DEFAULT_PUNCTUALITY) as Record<Section, Record<string, unknown>>;
  for (const section of SECTIONS) {
    const stored = src[section];
    if (!isObj(stored)) continue;
    for (const [name, leaf] of Object.entries(LEAVES[section]) as [string, Leaf][]) {
      if (name in stored && leafOk(leaf, stored[name])) out[section][name] = stored[name];
    }
  }
  return out as unknown as PunctualityPolicy;
}

/**
 * Refuse a policy that would be stored and then read as something else. Every unknown section or leaf is
 * refused by name, because an unknown key reads as the default: a misspelled `monthly_cout` would leave the
 * allowance off on a screen that said it had been set.
 */
export function validatePunctuality(raw: unknown): PunctualityPolicy {
  if (!isObj(raw)) throw invalidArgument("punctuality must be an object");
  for (const [section, value] of Object.entries(raw)) {
    if (!(SECTIONS as readonly string[]).includes(section)) throw invalidArgument(`punctuality.${section} is not a section (${SECTIONS.join(", ")})`);
    if (!isObj(value)) throw invalidArgument(`punctuality.${section} must be an object`);
    const leaves = LEAVES[section as Section] as Record<string, Leaf>;
    for (const [name, v] of Object.entries(value)) {
      const leaf = leaves[name];
      if (!leaf) throw invalidArgument(`punctuality.${section}.${name} is not a setting`);
      if (!leafOk(leaf, v)) throw invalidArgument(`punctuality.${section}.${name} must be ${leafRule(leaf)}`);
    }
  }
  const p = punctualityPolicyOf(raw);
  // Switched on with nothing to file is "off" spelled as though it were a choice.
  if (p.requests.enabled && !p.requests.late_arrival && !p.requests.early_departure) {
    throw invalidArgument("punctuality.requests offers neither late arrivals nor early departures; switch requests off instead");
  }
  return p;
}

// ---- The org schedule, as these rules read it ------------------------------------------------------------

/** The fields of `settings/attendance` a day is judged against. Mirrors web/src/lib/attendance.ts#AttendanceSchedule. */
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
 */
export function graceOn(day: string, sched: ShiftSchedule): number {
  const ex = (sched.grace_exceptions ?? []).find((e) => e.date === day);
  if (!ex) return sched.grace_minutes;
  return ex.extra_grace_minutes == null ? Infinity : sched.grace_minutes + ex.extra_grace_minutes;
}

/** How far a request's time is from the shift edge it moves. Zero or less = not a late arrival / early departure. */
export function requestMinutes(kind: LateEarlyKind, at: string, sched: Pick<ShiftSchedule, "shift_start" | "shift_end">): number {
  const t = minOfDay(at);
  return kind === "late_arrival" ? t - minOfDay(sched.shift_start) : minOfDay(sched.shift_end) - t;
}

// ---- Judging one day -------------------------------------------------------------------------------------

/**
 * The approved windows on one day, as minutes since midnight: a late arrival moves the start to `lateUntil`, an
 * early departure moves the end to `earlyFrom`.
 */
export type DayExcusal = { lateUntil?: number; earlyFrom?: number };

/** Approved requests -> their windows per day. A later request of the same kind on the same day cannot exist
 *  (one live request per person, day and kind), but the widest window wins if the data ever says otherwise. */
export function excusalsByDay(requests: readonly { date: string; kind: LateEarlyKind; at: string }[]): Map<string, DayExcusal> {
  const out = new Map<string, DayExcusal>();
  for (const r of requests) {
    const e = out.get(r.date) ?? {};
    const t = minOfDay(r.at);
    if (r.kind === "late_arrival") e.lateUntil = e.lateUntil == null ? t : Math.max(e.lateUntil, t);
    else e.earlyFrom = e.earlyFrom == null ? t : Math.min(e.earlyFrom, t);
    out.set(r.date, e);
  }
  return out;
}

/** Which halves of a day approved leave covers. Paid or not: an approved unpaid morning off is still a morning
 *  nobody expected the person at their desk, even though payroll docks it. */
export type LeaveHalves = { am: boolean; pm: boolean };

export type DayJudgement = {
  late: boolean;
  lateByMin: number;
  leftEarly: boolean;
  earlyByMin: number;
  /** An approved window covered lateness that the org's own window would have flagged. */
  excusedLate: boolean;
  excusedEarly: boolean;
  /** Minutes of the approved gap actually missed, credited when the policy says so (0 otherwise). */
  creditMinutes: number;
};

/**
 * One day's punctuality. `arrMin` is the first clock-in and `depMin` the last clock-out, both as minutes since
 * midnight in the org timezone (null when there is none); `open` = a session is still running, and a day that has
 * not finished cannot be left early.
 */
export function judgeDay(opts: {
  arrMin: number | null;
  depMin: number | null;
  open: boolean;
  startMin: number;
  endMin: number;
  grace: number;
  flexible?: boolean;
  excusal?: DayExcusal;
  halves?: LeaveHalves;
  policy: PunctualityPolicy["attendance"];
}): DayJudgement {
  const { arrMin, depMin, open, startMin, endMin, grace, flexible, excusal, halves, policy } = opts;
  const lateUntil = excusal?.lateUntil != null && excusal.lateUntil > startMin ? excusal.lateUntil : null;
  const earlyFrom = excusal?.earlyFrom != null && excusal.earlyFrom < endMin ? excusal.earlyFrom : null;
  // Minutes of the approved gap actually missed: an approved 10:30 start with a 10:10 arrival credits 70, not
  // 90 - and a day with no punch at all credits nothing, so a no-show is never paid through an approval.
  let creditMinutes = 0;
  if (policy.credit_minutes) {
    if (lateUntil != null && arrMin != null) creditMinutes += Math.max(0, Math.min(lateUntil, arrMin) - startMin);
    if (earlyFrom != null && depMin != null && !open) creditMinutes += Math.max(0, endMin - Math.max(earlyFrom, depMin));
  }
  const none = { late: false, lateByMin: 0, leftEarly: false, earlyByMin: 0, excusedLate: false, excusedEarly: false, creditMinutes };
  if (flexible) return none; // judged by minutes worked only
  const effStart = lateUntil ?? startMin;
  const effEnd = earlyFrom ?? endMin;
  const lateGrace = lateUntil != null && !policy.grace_on_top ? 0 : grace;
  const earlyGrace = earlyFrom != null && !policy.grace_on_top ? 0 : grace;
  const late = arrMin != null && !halves?.am && arrMin > effStart + lateGrace;
  const leftEarly = !open && depMin != null && !halves?.pm && depMin < effEnd - earlyGrace;
  return {
    late,
    lateByMin: late ? arrMin! - effStart : 0,
    leftEarly,
    earlyByMin: leftEarly ? effEnd - depMin! : 0,
    excusedLate: lateUntil != null && !late && arrMin != null && !halves?.am && arrMin > startMin + grace,
    excusedEarly: earlyFrom != null && !leftEarly && !open && depMin != null && !halves?.pm && depMin < endMin - grace,
    creditMinutes,
  };
}

// ---- A pay period ------------------------------------------------------------------------------------------

/** One person's punches for one org-local day, collapsed: first clock-in, last closed clock-out, still open. */
export type PunchDay = { arrMs: number; depMs: number | null; open: boolean };

/** Collapse raw sessions into per-day punches, the same reading web/src/lib/attendance.ts#summarizeDay makes:
 *  arrival = the earliest clock-in, departure = the clock-out of the latest-starting CLOSED session. */
export function punchDays(sessions: readonly { clockInMs: number; clockOutMs: number | null }[], dayOf: (ms: number) => string): Map<string, PunchDay> {
  const byDay = new Map<string, { clockInMs: number; clockOutMs: number | null }[]>();
  for (const s of sessions) {
    const d = dayOf(s.clockInMs);
    (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(s);
  }
  const out = new Map<string, PunchDay>();
  for (const [d, ss] of byDay) {
    const sorted = [...ss].sort((a, b) => a.clockInMs - b.clockInMs);
    const closed = sorted.filter((s) => s.clockOutMs != null);
    out.set(d, { arrMs: sorted[0]!.clockInMs, depMs: closed.length ? closed[closed.length - 1]!.clockOutMs : null, open: sorted.some((s) => s.clockOutMs == null) });
  }
  return out;
}

export type PeriodPunctuality = {
  /** Approved-gap minutes to add to a day's worked minutes (policy.attendance.credit_minutes), for
   *  domain/attendance.ts#lopDayUnits. */
  creditByDay: Map<string, number>;
  /** The most a day may be worth (0.5), from a severe unexcused lateness or early departure. */
  capByDay: Map<string, number>;
  lateMarks: number;
  earlyMarks: number;
  severeDays: number;
  /** Day-units the marks dock, before any clamp against the days actually owed. */
  penaltyUnits: number;
};

/**
 * Day-units a period's marks dock: the first `free_marks` are free, then every full block of `every` marks
 * docks `deduct_days`, capped at `max_days`.
 */
export function penaltyUnitsFor(marks: number, p: PunctualityPolicy["penalties"]): number {
  if (!p.enabled || marks <= 0) return 0;
  const blocks = Math.floor(Math.max(0, marks - p.free_marks) / Math.max(1, p.every));
  const units = blocks * p.deduct_days;
  return Math.round((p.max_days != null ? Math.min(units, p.max_days) : units) * 2) / 2;
}

/**
 * Everything a period's punctuality means for pay, for ONE person. The days walked are the ones loss of pay walks
 * (scheduled working days that are not holidays) and, of those, only days with punches: an empty day is an
 * absence and is already docked as one. A day wholly on approved leave, and a day HR marked, are skipped - the
 * mark decides what that day is worth, which is what a mark is for.
 */
export function punctualityOverPeriod(opts: {
  startYmd: string;
  endYmd: string;
  holidays: Set<string>;
  sched: ShiftSchedule;
  punches: Map<string, PunchDay>;
  excusals?: Map<string, DayExcusal>;
  leaveRanges?: LeaveRange[];
  marksByDay?: Map<string, DayCredit>;
  policy: PunctualityPolicy;
}): PeriodPunctuality {
  const { startYmd, endYmd, holidays, sched, punches, excusals, leaveRanges = [], marksByDay, policy } = opts;
  const startMin = minOfDay(sched.shift_start);
  const endMin = minOfDay(sched.shift_end);
  const pen = policy.penalties;
  const out: PeriodPunctuality = { creditByDay: new Map(), capByDay: new Map(), lateMarks: 0, earlyMarks: 0, severeDays: 0, penaltyUnits: 0 };
  for (const [day, p] of punches) {
    if (day < startYmd || day > endYmd) continue;
    if (!sched.work_days.includes(weekdayOf(day)) || holidays.has(day)) continue;
    const halves = leaveHalves(day, leaveRanges);
    if (halves.am && halves.pm) continue;
    if (marksByDay?.has(day)) continue;
    const j = judgeDay({
      arrMin: localMinutes(p.arrMs, sched.timezone),
      depMin: p.depMs != null ? localMinutes(p.depMs, sched.timezone) : null,
      open: p.open,
      startMin, endMin,
      grace: graceOn(day, sched),
      flexible: sched.flexible_hours,
      excusal: excusals?.get(day),
      halves,
      policy: policy.attendance,
    });
    if (j.creditMinutes > 0) out.creditByDay.set(day, j.creditMinutes);
    if (!pen.enabled) continue;
    if (pen.severe_minutes != null && ((j.late && j.lateByMin > pen.severe_minutes) || (j.leftEarly && j.earlyByMin > pen.severe_minutes))) {
      out.capByDay.set(day, 0.5);
      out.severeDays++;
      continue; // the day is already worth half: counting it as a mark as well would charge it twice
    }
    if (j.late && pen.counts !== "early") out.lateMarks++;
    if (j.leftEarly && pen.counts !== "late") out.earlyMarks++;
  }
  out.penaltyUnits = penaltyUnitsFor(out.lateMarks + out.earlyMarks, pen);
  return out;
}

/** One period's loss of pay for one person, with what the punctuality policy adds to it. */
export type PeriodLop = {
  /** Day-units for unexcused absence: `lopDayUnits`, with approved gaps credited and severe days capped. */
  absenceUnits: number;
  /** Day-units the late and early marks dock, clamped so the two together never exceed the days owed. */
  penaltyUnits: number;
  /** What the period docks: the two above, on the half-day grid. */
  units: number;
  lateMarks: number;
  earlyMarks: number;
  severeDays: number;
};

/**
 * THE loss-of-pay reading of a period for one person, shared by the payroll build, the payslip's attendance
 * strip, the restatement of a closed period (payroll.ts#recomputeLopUnits) and the final settlement - so none
 * of them can dock a different number of days for the same attendance.
 *
 * Without `punctuality` (the policy not in play, or no punches read) this is exactly `lopDayUnits`.
 */
export function periodLop(opts: {
  startYmd: string;
  endYmd: string;
  workDays: number[];
  holidays: Set<string>;
  leaveRanges: LeaveRange[];
  workedByDay: Map<string, number>;
  marksByDay?: Map<string, DayCredit>;
  /** The day HRMS records start for this person - see `trackedFromYmd` on lopDayUnits. */
  trackedFromYmd?: string | null;
  fullDayMinutes: number;
  halfDayMinutes: number;
  punctuality?: { sched: ShiftSchedule; policy: PunctualityPolicy; punches: Map<string, PunchDay>; excusals?: Map<string, DayExcusal> };
}): PeriodLop {
  const { punctuality: pn, ...base } = opts;
  const p = pn
    ? punctualityOverPeriod({ startYmd: opts.startYmd, endYmd: opts.endYmd, holidays: opts.holidays, sched: pn.sched, punches: pn.punches, excusals: pn.excusals, leaveRanges: opts.leaveRanges, marksByDay: opts.marksByDay, policy: pn.policy })
    : null;
  const absenceUnits = lopDayUnits({ ...base, creditByDay: p?.creditByDay, capByDay: p?.capByDay });
  const penaltyUnits = p?.penaltyUnits ? Math.max(0, Math.min(p.penaltyUnits, owedDays(opts) - absenceUnits)) : 0;
  return {
    absenceUnits,
    penaltyUnits,
    units: Math.round((absenceUnits + penaltyUnits) * 2) / 2,
    lateMarks: p?.lateMarks ?? 0,
    earlyMarks: p?.earlyMarks ?? 0,
    severeDays: p?.severeDays ?? 0,
  };
}

/**
 * Day-units a window owes: its scheduled working days that are not holidays, less what paid leave covers. A day
 * before HRMS records start with nothing recorded owes nothing here either (`isUntracked`), the same day
 * lopDayUnits skips - the penalty clamp is "never more than the days owed", and the two must count one set.
 */
function owedDays(o: {
  startYmd: string;
  endYmd: string;
  workDays: number[];
  holidays: Set<string>;
  leaveRanges: LeaveRange[];
  workedByDay: Map<string, number>;
  marksByDay?: Map<string, DayCredit>;
  trackedFromYmd?: string | null;
}): number {
  let owed = 0;
  for (let t = Date.parse(`${o.startYmd}T00:00:00Z`); t <= Date.parse(`${o.endYmd}T00:00:00Z`); t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (!o.workDays.includes(weekdayOf(d)) || o.holidays.has(d)) continue;
    if (isUntracked(d, o.trackedFromYmd, o.workedByDay, o.marksByDay, o.leaveRanges)) continue;
    owed += 1 - leaveCover(d, o.leaveRanges);
  }
  return owed;
}

/** Whether the policy does anything to pay at all - the gate the payroll build reads approved requests behind. */
export const punctualityTouchesPay = (p: PunctualityPolicy): boolean => p.attendance.credit_minutes || p.penalties.enabled;

/** The AM/PM cover of `day` by approved leave, paid or not (see LeaveHalves). */
export function leaveHalves(day: string, ranges: readonly LeaveRange[]): LeaveHalves {
  let am = false;
  let pm = false;
  for (const r of ranges) {
    if (day < r.start || day > r.end) continue;
    if ((day === r.start ? (r.startSession ?? 1) : 1) <= 1) am = true;
    if ((day === r.end ? (r.endSession ?? 2) : 2) >= 2) pm = true;
  }
  return { am, pm };
}

// ---- Filing a request ------------------------------------------------------------------------------------

export type FilingVerdict = {
  minutes: number;
  /** Refusals, in the order a person should fix them. Empty = the request may be filed. */
  errors: string[];
  /** Past the monthly allowance, accepted because the policy allows it. */
  overLimit: boolean;
  /** Approved on filing by `auto_approve_minutes`. */
  autoApprove: boolean;
  /** What the allowance looks like with this request counted, for the form to show before it is sent. */
  usage: { count: number; minutes: number; countLimit: number | null; minutesLimit: number | null };
};

/**
 * Whether a request may be filed, and what happens when it is. PURE: the caller hands over the day's facts and
 * the person's other live requests for the same calendar month, so the form can show the same verdict the server
 * reaches before anybody presses Submit.
 */
export function checkFiling(ctx: {
  kind: LateEarlyKind;
  date: string;
  at: string;
  reason?: string | null;
  sched: ShiftSchedule;
  policy: PunctualityPolicy;
  todayYmd: string;
  /** Minutes since midnight now, in the org timezone. */
  nowMin: number;
  isHoliday: boolean;
  onFullLeave: boolean;
  /** This person's PENDING and APPROVED requests in the same calendar month, this one excluded. */
  monthRequests: readonly { kind: LateEarlyKind; minutes: number; date: string }[];
}): FilingVerdict {
  const { kind, date, at, reason, sched, policy, todayYmd, nowMin, isHoliday, onFullLeave, monthRequests } = ctx;
  const r = policy.requests;
  const errors: string[] = [];
  const noun = KIND_LABEL[kind].toLowerCase();
  const startMin = minOfDay(sched.shift_start);
  const endMin = minOfDay(sched.shift_end);
  const atMin = minOfDay(at);
  const minutes = requestMinutes(kind, at, sched);

  if (!r.enabled) errors.push("Late arrival and early departure requests are switched off.");
  else if (!r[kind]) errors.push(`${KIND_LABEL[kind]} requests are switched off.`);
  if (endMin <= startMin) errors.push("The org's shift ends before it starts, which these requests cannot describe.");
  if (!sched.work_days.includes(weekdayOf(date))) errors.push("That day is not a working day.");
  else if (isHoliday) errors.push("That day is a holiday.");
  else if (onFullLeave) errors.push("You are on approved leave for the whole of that day.");
  if (kind === "late_arrival") {
    if (minutes <= 0) errors.push(`A late arrival has to be after the shift starts at ${sched.shift_start}.`);
    else if (atMin >= endMin) errors.push(`A late arrival has to be before the shift ends at ${sched.shift_end}.`);
  } else {
    if (minutes <= 0) errors.push(`An early departure has to be before the shift ends at ${sched.shift_end}.`);
    else if (atMin <= startMin) errors.push(`An early departure has to be after the shift starts at ${sched.shift_start}.`);
  }
  if (minutes > 0 && r.max_minutes != null && minutes > r.max_minutes) {
    errors.push(`A ${noun} can be at most ${fmtMinutes(r.max_minutes)}; this one is ${fmtMinutes(minutes)}. Longer than that is half-day leave.`);
  }
  const back = daysBetween(date, todayYmd);
  if (r.backdate_days != null && back > r.backdate_days) {
    errors.push(r.backdate_days === 0 ? "Requests cannot be filed for a day that has passed." : `Requests can be filed at most ${r.backdate_days} day${r.backdate_days === 1 ? "" : "s"} after the day.`);
  }
  if (r.advance_days != null && -back > r.advance_days) errors.push(`Requests can be filed at most ${r.advance_days} days ahead.`);
  if (r.before_time) {
    const cutoff = kind === "late_arrival" ? startMin : atMin;
    if (date < todayYmd || (date === todayYmd && nowMin >= cutoff)) {
      errors.push(kind === "late_arrival" ? `A late arrival has to be requested before the shift starts at ${sched.shift_start}.` : `An early departure has to be requested before you leave at ${at}.`);
    }
  }
  if (r.reason_required && !reason?.trim()) errors.push("Say why - the policy asks for a reason.");

  const counted = r.limit_scope === "per_kind" ? monthRequests.filter((m) => m.kind === kind) : monthRequests;
  const usage = {
    count: counted.length + 1,
    minutes: counted.reduce((s, m) => s + m.minutes, 0) + Math.max(0, minutes),
    countLimit: r.monthly_count,
    minutesLimit: r.monthly_minutes,
  };
  const past = (usage.countLimit != null && usage.count > usage.countLimit) || (usage.minutesLimit != null && usage.minutes > usage.minutesLimit);
  const scope = r.limit_scope === "per_kind" ? `${noun} requests` : "late arrival and early departure requests";
  if (past && r.over_limit === "refuse") {
    const parts = [
      usage.countLimit != null ? `${usage.countLimit} request${usage.countLimit === 1 ? "" : "s"}` : null,
      usage.minutesLimit != null ? fmtMinutes(usage.minutesLimit) : null,
    ].filter(Boolean);
    errors.push(`This would go past the monthly allowance for ${scope} (${parts.join(" or ")} a month).`);
  }
  const overLimit = past && r.over_limit === "allow";
  const autoApprove = !errors.length && !overLimit && r.auto_approve_minutes != null && minutes <= r.auto_approve_minutes;
  return { minutes, errors, overLimit, autoApprove, usage };
}

/** Whole days from `a` to `b` ("YYYY-MM-DD"); positive when `a` is before `b`. */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** "1h 30m", "45m", "2h". */
export function fmtMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
}

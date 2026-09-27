// Whose day is what, in the browser.
//
// A THIN ASSEMBLER around the SERVER'S rule, not a second copy of it: `employeeScheduleOf` in
// src/domain/workSchedule.ts is pure and is imported straight into the bundle, the way `leaveCover` and
// `judgeDay` are in lib/attendance.ts. The roster grid calling a day a rest day that payroll then docks is the
// exact drift those two notes warn about, and the only way two readers agree is for there to be one rule.
//
// All four inputs are collections the SPA already reads, so this costs no endpoint of its own: the shift and
// pattern catalogs are small and cached by lib/resourceStore.ts, and the two assignment lists are the window
// the roster is already asking for.
import { employeeScheduleOf, orgScheduleOf, type DayOverride, type DayScheduleOf, type PatternDef, type PatternSpan, type ShiftDef } from "../../../src/domain/workSchedule";
import type { AttendanceSchedule } from "./attendance";
import { idOf } from "./utils";
import type { Shift, ShiftAssignment, WorkPattern, WorkPatternAssignment } from "@/types";

export type { DayScheduleOf };
export type { DaySchedule } from "../../../src/domain/workSchedule";

/** The catalog as the resolver reads it. A wire `shift` omits a field it has not set, which is the null the rule wants. */
export function shiftDefs(shifts: readonly Shift[]): Map<string, ShiftDef> {
  return new Map(shifts.map((s) => [idOf(s.path), {
    id: idOf(s.path),
    name: s.name ?? "Shift",
    startTime: s.start ?? "09:00",
    endTime: s.end ?? "18:00",
    breakMinutes: s.break_minutes ?? 0,
    fullDayMinutes: s.full_day_minutes ?? null,
    halfDayMinutes: s.half_day_minutes ?? null,
    graceMinutes: s.grace_minutes ?? null,
    flexibleHours: s.flexible_hours ?? null,
  } satisfies ShiftDef]));
}

/**
 * The pattern catalog, with each cycle read as ids.
 *
 * A pattern whose `days` is not the length its `cycle_weeks` claims is DROPPED, exactly as the server drops it
 * (services/workSchedule.ts): a short array would resolve its missing days to rest days, which reads as "this
 * person does not work Thursdays" on a grid that is meant to be the truth about who is on.
 */
export function patternDefs(patterns: readonly WorkPattern[]): Map<string, PatternDef> {
  const out = new Map<string, PatternDef>();
  for (const p of patterns) {
    const weeks = Math.max(1, p.cycle_weeks ?? 1);
    const days = p.days ?? [];
    if (days.length !== weeks * 7) continue;
    out.set(idOf(p.path), {
      id: idOf(p.path),
      name: p.name ?? "Schedule",
      cycleWeeks: weeks,
      days: days.map((d) => (d ? idOf(d) : null)),
    });
  }
  return out;
}

/** Everything a window of the roster needs to resolve a day, for as many people as it draws. */
export type ScheduleView = {
  /** This person's day-by-day schedule. Someone on nothing is on the org's own week. */
  of: (employeeId: string) => DayScheduleOf;
  /** Which pattern covers a person on a day, for the row header that names what they are on. */
  patternOn: (employeeId: string, ymd: string) => PatternDef | undefined;
  /** The roster entry for a cell, if there is one - so a day the ROSTER set draws differently from one the pattern implies. */
  overrideOn: (employeeId: string, ymd: string) => DayOverride | undefined;
};

/**
 * Build the view from the four lists a roster window holds.
 *
 * `sched` is `settings/attendance` (the clock's), which is the bottom layer and the answer for everybody on
 * nothing else - which is most people until HR puts them on a pattern.
 *
 * GATED ON `schedule_source`, exactly as the server is (services/workSchedule.ts). While the org is on "org",
 * a roster entry and a work pattern decide nothing about anybody's pay - so a grid that drew their days
 * anyway would be telling the scheduler that a day is covered when the payroll build has never heard of it.
 * The two have to answer the same question the same way, or the roster is a second opinion.
 */
export function scheduleView(opts: {
  sched: AttendanceSchedule;
  shifts: readonly Shift[];
  patterns: readonly WorkPattern[];
  assignments: readonly ShiftAssignment[];
  patternAssignments: readonly WorkPatternAssignment[];
}): ScheduleView {
  const org = orgScheduleOf(opts.sched);
  if (opts.sched.schedule_source !== "resolved") {
    return { of: () => org, patternOn: () => undefined, overrideOn: () => undefined };
  }
  const shifts = shiftDefs(opts.shifts);
  const patterns = patternDefs(opts.patterns);

  const overrides = new Map<string, Map<string, DayOverride>>();
  for (const a of opts.assignments) {
    if (!a.employee || !a.date || a.delete_time) continue;
    const emp = idOf(a.employee);
    let m = overrides.get(emp);
    if (!m) overrides.set(emp, (m = new Map()));
    m.set(a.date, { shiftId: a.shift ? idOf(a.shift) : null, off: a.kind === "off" });
  }

  const spans = new Map<string, PatternSpan[]>();
  for (const a of opts.patternAssignments) {
    if (!a.employee || !a.pattern || !a.start_date || a.delete_time) continue;
    const emp = idOf(a.employee);
    (spans.get(emp) ?? spans.set(emp, []).get(emp)!).push({
      patternId: idOf(a.pattern),
      startYmd: a.start_date,
      endYmd: a.end_date ?? null,
      anchorYmd: a.anchor_date ?? a.start_date,
    });
  }

  const built = new Map<string, DayScheduleOf>();
  const of = (employeeId: string): DayScheduleOf => {
    let f = built.get(employeeId);
    if (!f) {
      const s = spans.get(employeeId);
      const o = overrides.get(employeeId);
      f = !s && !o ? org : employeeScheduleOf({ org, shifts, patterns, spans: s ?? [], overrides: o ?? new Map() });
      built.set(employeeId, f);
    }
    return f;
  };

  const spanOn = (employeeId: string, ymd: string) =>
    (spans.get(employeeId) ?? []).find((s) => ymd >= s.startYmd && (s.endYmd == null || ymd <= s.endYmd));

  return {
    of,
    patternOn: (employeeId, ymd) => {
      const s = spanOn(employeeId, ymd);
      return s ? patterns.get(s.patternId) : undefined;
    },
    overrideOn: (employeeId, ymd) => overrides.get(employeeId)?.get(ymd),
  };
}

import { and, eq, gte, isNull, lte, or, type SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { DEFAULT_ATTENDANCE, utcDay, type AttendanceConfig } from "../domain/attendance";
import {
  employeeScheduleOf, orgScheduleOf, sameForEveryone, scheduleSourceOf,
  type DayOverride, type DayScheduleOf, type PatternDef, type PatternSpan, type ScheduleResolver, type ShiftDef,
} from "../domain/workSchedule";
import { refShifts, refWorkPatterns } from "../lib/refData";
import { getSettingValue } from "./settings";

// WHOSE DAY IS WHAT, loaded once for a window.
//
// The pure rule lives in domain/workSchedule.ts; this is the I/O half - the three reads that rule needs, and
// the resolver built over them. A payroll build calls it once for the period and asks it per employee, so the
// cost is three queries for the whole run rather than three per person.
//
// The reads are WINDOW-SCOPED rather than id-filtered, which is the convention every other period read here
// follows (services/lateEarlyRequests.ts#approvedExcusals, the day-mark and punch reads in
// services/payroll.ts#assembleLop): a run prices most of the directory anyway, D1 bills rows read rather than
// statements, and a four-hundred-id `IN` list is a statement no cursor helps with. `employeeIds` narrows the
// SQL only when it names exactly one person, which is the settlement and single-employee path.

/** A date-only column's ms, for a "YYYY-MM-DD". Matches services/orgDay.ts#dayStartMs. */
const dayMs = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`);

/** The `shifts` catalogue as the pure resolver reads it. */
function shiftDefs(rows: (typeof schema.shifts.$inferSelect)[]): Map<string, ShiftDef> {
  return new Map(rows.map((s) => [s.uuid, {
    id: s.uuid,
    name: s.name,
    startTime: s.startTime,
    endTime: s.endTime,
    breakMinutes: s.breakMinutes,
    fullDayMinutes: s.fullDayMinutes,
    halfDayMinutes: s.halfDayMinutes,
    graceMinutes: s.graceMinutes,
    flexibleHours: s.flexibleHours,
  } satisfies ShiftDef]));
}

/**
 * The `work_patterns` catalogue, with each cycle parsed.
 *
 * A pattern whose `days_json` will not parse, or does not hold the `cycle_weeks * 7` entries it claims, is
 * DROPPED rather than half-read: a short array would resolve its missing days to rest days, which reads as
 * "this person does not work Thursdays" and stops a day being owed. Dropped, the assignment finds no pattern
 * and the day falls through to the org's own week - visibly wrong on the roster, rather than quietly unpaid.
 */
function patternDefs(rows: (typeof schema.workPatterns.$inferSelect)[]): Map<string, PatternDef> {
  const out = new Map<string, PatternDef>();
  for (const p of rows) {
    const weeks = Math.max(1, p.cycleWeeks);
    let days: unknown;
    try { days = JSON.parse(p.daysJson); } catch { continue; }
    if (!Array.isArray(days) || days.length !== weeks * 7) continue;
    if (!days.every((d) => d === null || typeof d === "string")) continue;
    out.set(p.uuid, { id: p.uuid, name: p.name, cycleWeeks: weeks, days: days as (string | null)[] });
  }
  return out;
}

/**
 * One employee's schedule resolver for every day in `[fromYmd, toYmd]`, for as many employees as ask.
 *
 * Returns `sameForEveryone(orgScheduleOf(att))` - and reads nothing else at all - while the org is on
 * `schedule_source: "org"`, which is the default. An org that has been keeping a roster as a planning grid
 * must not find those entries deciding pay the moment schedules ship, so consulting them is a decision HR
 * makes in Settings.
 */
export async function scheduleCtxFor(
  deps: Deps,
  fromYmd: string,
  toYmd: string,
  employeeIds?: readonly string[],
): Promise<ScheduleResolver> {
  const att = await getSettingValue<AttendanceConfig>(deps, "attendance", DEFAULT_ATTENDANCE);
  return scheduleCtxWith(deps, att, fromYmd, toYmd, employeeIds);
}

/** The same, for a caller that has already read `settings/attendance` (every payroll path has). */
export async function scheduleCtxWith(
  deps: Deps,
  att: AttendanceConfig,
  fromYmd: string,
  toYmd: string,
  employeeIds?: readonly string[],
): Promise<ScheduleResolver> {
  const org = orgScheduleOf(att);
  if (scheduleSourceOf(att) !== "resolved") return sameForEveryone(org);

  const one = employeeIds?.length === 1 ? employeeIds[0]! : null;
  const mine = (id: string) => !employeeIds || employeeIds.includes(id);

  const [shiftRows, patternRows] = await Promise.all([refShifts(deps), refWorkPatterns(deps)]);
  const shifts = shiftDefs(shiftRows);
  const patterns = patternDefs(patternRows);

  // Roster entries touching the window. `sa_date_idx` binds it.
  const sa = schema.shiftAssignments;
  const saConds: SQL[] = [
    isNull(sa.deleteTime),
    gte(sa.date, new Date(dayMs(fromYmd))),
    lte(sa.date, new Date(dayMs(toYmd))),
  ];
  if (one) saConds.push(eq(sa.employeeId, one));
  const overridesByEmp = new Map<string, Map<string, DayOverride>>();
  for (const r of await deps.db
    .select({ employeeId: sa.employeeId, shiftId: sa.shiftId, kind: sa.kind, date: sa.date })
    .from(sa)
    .where(and(...saConds))) {
    if (!mine(r.employeeId)) continue;
    let m = overridesByEmp.get(r.employeeId);
    if (!m) overridesByEmp.set(r.employeeId, (m = new Map<string, DayOverride>()));
    m.set(utcDay(+new Date(r.date)), { shiftId: r.shiftId, off: r.kind === "off" });
  }

  // Pattern assignments OVERLAPPING the window: they start on or before its end, and either have not ended or
  // ended on or after its start. An open-ended assignment (`end_date` null) is the ordinary case - somebody is
  // on a schedule until they are moved off it - so the null arm is not an edge case to tack on.
  const wpa = schema.workPatternAssignments;
  const wpaConds: SQL[] = [
    isNull(wpa.deleteTime),
    lte(wpa.startDate, new Date(dayMs(toYmd))),
    or(isNull(wpa.endDate), gte(wpa.endDate, new Date(dayMs(fromYmd))))!,
  ];
  if (one) wpaConds.push(eq(wpa.employeeId, one));
  const spansByEmp = new Map<string, PatternSpan[]>();
  for (const r of await deps.db
    .select({ employeeId: wpa.employeeId, patternId: wpa.patternId, startDate: wpa.startDate, endDate: wpa.endDate, anchorDate: wpa.anchorDate })
    .from(wpa)
    .where(and(...wpaConds))) {
    if (!mine(r.employeeId)) continue;
    const startYmd = utcDay(+new Date(r.startDate));
    (spansByEmp.get(r.employeeId) ?? spansByEmp.set(r.employeeId, []).get(r.employeeId)!).push({
      patternId: r.patternId,
      startYmd,
      endYmd: r.endDate ? utcDay(+new Date(r.endDate)) : null,
      anchorYmd: r.anchorDate ? utcDay(+new Date(r.anchorDate)) : startYmd,
    });
  }

  // One resolver per employee, built on first ask and kept: the walks below ask the same person for the same
  // days several times over (the absence walk, the owed-days clamp, the working-days divisor).
  const built = new Map<string, DayScheduleOf>();
  return (employeeId: string): DayScheduleOf => {
    let f = built.get(employeeId);
    if (!f) {
      const spans = spansByEmp.get(employeeId);
      const overrides = overridesByEmp.get(employeeId);
      // Nobody on a pattern and nothing on the roster is the org's own week, which is most people: hand back
      // the shared resolver rather than wrapping an empty one per employee.
      f = !spans && !overrides
        ? org
        : employeeScheduleOf({ org, shifts, patterns, spans: spans ?? [], overrides: overrides ?? new Map() });
      built.set(employeeId, f);
    }
    return f;
  };
}

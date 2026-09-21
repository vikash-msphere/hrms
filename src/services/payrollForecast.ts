// Committed salary cost for the year ahead, assembled from the compensation timeline and the roster.
//
// The arithmetic is `domain/payrollForecast.ts`; this resolves the three things that come from the database -
// who is employed and until when, what each compensation row costs a month, and which cost centre carries it.
//
// SCOPED LIKE EVERY OTHER AGGREGATE. The caller's own `compensation` list verdict decides whose cost is in
// the answer, resolved by the middleware rather than here, so a manager sees their reports' committed cost
// and finance sees the organisation's - and a caller who may list nobody's gets an empty forecast rather than
// a 403 on a page.
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { ListScope } from "../domain/access";
import { applyScope } from "./listScope";
import { getSettingValue } from "./settings";
import { refPayComponents } from "../lib/refData";
import { applyStructure, ctcLines, DEFAULT_CTC_CONFIG, type CtcConfig } from "../domain/payroll";
import { structureLinesById } from "./salaryStructures";
import { forecastPayroll, type CostSegment, type ForecastPerson, type PayrollForecast } from "../domain/payrollForecast";
import { byIdChunks } from "../lib/dbBatch";

/** A year, which is the horizon the question is always asked over - a budget cycle, not a guess about how far
 *  ahead anybody can see. */
export const FORECAST_MONTHS = 12;

export async function payrollForecast(deps: Deps, scope: ListScope | undefined, fromMs: number = Date.now()): Promise<PayrollForecast & { horizon_months: number }> {
  // The people this caller may see the cost of, and nothing about anybody else. Bound on the compensation
  // code exactly as a list of that collection would be.
  const comp = await deps.db
    .select({
      employeeId: schema.compensation.employeeId,
      effectiveFrom: schema.compensation.effectiveFrom,
      effectiveTo: schema.compensation.effectiveTo,
      basePay: schema.compensation.basePay,
      specialAllowance: schema.compensation.specialAllowance,
      structureId: schema.compensation.structureId,
    })
    .from(schema.compensation)
    .where(and(applyScope(scope, schema.compensation.code, schema.compensation.employeeId), isNull(schema.compensation.deleteTime)));
  if (!comp.length) return { months: [], total: 0, horizon_months: FORECAST_MONTHS };

  // Employment windows and cost centres for exactly the people the compensation read returned. A terminated
  // employee with no end date on file is excluded: they are not committed cost, and treating them as open
  // ended would carry somebody who has left through the whole horizon.
  const ids = [...new Set(comp.map((c) => c.employeeId))];
  const employees = new Map(
    (await byIdChunks(ids, (group) =>
      deps.db
        .select({ uuid: schema.employees.uuid, departmentId: schema.employees.departmentId, startDate: schema.employees.startDate, endDate: schema.employees.endDate, status: schema.employees.status })
        .from(schema.employees)
        .where(and(inArray(schema.employees.uuid, group), isNull(schema.employees.deleteTime), ne(schema.employees.status, "terminated"))),
    )).map((e) => [e.uuid, e]),
  );

  const cfg = await getSettingValue<CtcConfig>(deps, "ctc", DEFAULT_CTC_CONFIG);
  const components = (await refPayComponents(deps)).filter((c) => !c.disabled && !c.deleteTime);
  const pfBasis = cfg.pf_wage_basis ?? "basic";

  // Structure lines are shared across employees, so they are resolved once per DISTINCT structure rather than
  // once per compensation row - a 400-person org on three structures reads three, not four hundred.
  const structures = new Map<string, Awaited<ReturnType<typeof structureLinesById>>>();
  const linesFor = async (structureId: string | null) => {
    const key = structureId ?? "";
    if (!structures.has(key)) structures.set(key, await structureLinesById(deps, structureId));
    return structures.get(key)!;
  };

  const bySegment = new Map<string, CostSegment[]>();
  for (const c of comp) {
    const effective = applyStructure(components, await linesFor(c.structureId));
    // FULL COMPANY COST, not gross: `ctcMonthly` is earnings plus the employer contributions that sit inside
    // CTC, which is what the month actually costs. Contributions the org pays OVER AND ABOVE CTC are excluded
    // here for the same reason they are excluded from CTC itself - that is the org's own convention, and this
    // figure has to mean the same thing as the one on the offer letter.
    const { ctcMonthly } = ctcLines(c.basePay, effective, true, c.specialAllowance, pfBasis);
    const held = bySegment.get(c.employeeId) ?? [];
    held.push({ fromMs: +new Date(c.effectiveFrom), toMs: c.effectiveTo ? +new Date(c.effectiveTo) : null, monthlyCost: ctcMonthly });
    bySegment.set(c.employeeId, held);
  }

  const people: ForecastPerson[] = [];
  for (const [employeeId, segments] of bySegment) {
    const e = employees.get(employeeId);
    if (!e) continue; // left, or outside this caller's reach
    people.push({
      employeeId,
      departmentId: e.departmentId ?? null,
      startMs: e.startDate ? +new Date(e.startDate) : null,
      endMs: e.endDate ? +new Date(e.endDate) : null,
      // Newest first, so `find` picks the latest segment in force when two overlap - which they should not,
      // but a timeline that has been hand-corrected sometimes does.
      segments: segments.sort((a, b) => b.fromMs - a.fromMs),
    });
  }

  return { ...forecastPayroll(people, fromMs, FORECAST_MONTHS), horizon_months: FORECAST_MONTHS };
}

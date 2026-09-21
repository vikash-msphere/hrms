// Raising and clearing loss-of-pay corrections for periods that have already been paid.
//
// The arithmetic and the direction convention are `domain/lopAdjust.ts`; this resolves the three things that
// come from the database - what the published run actually docked, what the period's attendance says now,
// and the per-day rate the correction is priced at.
//
// WHEN IT RUNS: whenever something that decides loss of pay changes for a day inside a CLOSED period -
// approved leave, an attendance regularization, an HR day-mark. The caller passes the employee and the day;
// this works out whether that day belongs to a period whose run has published and, if so, restates it.
//
// IT REPLACES, NEVER ACCUMULATES. `restateLop` recomputes the whole period from scratch and writes one row,
// so a second retroactive change to the same period overwrites the first. The partial unique index on
// (employee, period) where `paid_run_id is null` is the backstop, exactly as `run_period_committed_idx` is
// for a second committed run - a money invariant stated in a comment is one the database should be holding.
import { and, eq, inArray, isNull, lte, gte } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { audit } from "../lib/audit";
import { round2 } from "../domain/money";
import { lopAdjustment, type LopRestatement } from "../domain/lopAdjust";
import { allocOwnedCode, withFreshCode } from "./codeAlloc";
import { ONE_OFF_EARNING_CODES, type Line } from "../domain/payroll";

const parseLines = (json: string): Line[] => {
  try {
    return JSON.parse(json) as Line[];
  } catch {
    return [];
  }
};

/**
 * The per-day rate the closed period priced absence at.
 *
 * PREFERRED: read it off the run's OWN loss-of-pay line (amount / units). That is the exact rate the run
 * used, with no reconstruction of the wage basis, the divisor, or the proration factor that produced it - so
 * a refund gives back precisely what was taken.
 *
 * FALLBACK, for a run that docked nothing (the under-dock case, where there is no LOP line to read): the
 * period's regular earnings over its working days. This reconstructs rather than reads, so it can differ
 * from what a rebuild would charge if the org changed `lop_wage_basis` since - which is the right direction,
 * because the money being recovered is priced at the wage the period actually paid.
 */
function dailyRateOf(lines: Line[], workingDaysInPeriod: number): number {
  const lopLine = lines.find((l) => l.code === "LOP");
  if (lopLine && lopLine.units && lopLine.units > 0) {
    return round2(Math.abs(lopLine.amount) / lopLine.units);
  }
  const regular = lines
    .filter((l) => l.kind === "earning" && !ONE_OFF_EARNING_CODES.has(l.code) && l.code !== "LOP")
    .reduce((s, l) => s + l.amount, 0);
  const divisor = Math.max(1, workingDaysInPeriod);
  return round2(regular / divisor);
}

/** What the published run charged this employee, in day-units. Absent LOP line = nothing docked. */
function chargedUnits(lines: Line[]): number {
  const lopLine = lines.find((l) => l.code === "LOP");
  return lopLine?.units ?? 0;
}

export type RestateResult = { raised: boolean; cleared: boolean; dayUnits: number; amount: number };
const NOTHING: RestateResult = { raised: false, cleared: false, dayUnits: 0, amount: 0 };

/**
 * Restate one employee's loss of pay for one closed period.
 *
 * `correctUnits` is supplied by the caller rather than recomputed here, because working it out needs the
 * whole LOP assembly (holidays, leave ranges, punches, day-marks, the employment clamp) that
 * `services/payroll.ts` already owns - and a second implementation of it here would be a second answer to
 * the question the run itself answers.
 *
 * Returns what happened, so the caller can audit and so a cron can report a count.
 */
export async function restateLop(
  deps: Deps,
  employeeId: string,
  payPeriodId: string,
  correctUnits: number,
): Promise<RestateResult> {
  // The committed run for that period. A period with no committed run has nothing to correct - its numbers
  // are still being built, and the build will read the new attendance itself.
  const run = (await deps.db
    .select({ uuid: schema.payrollRuns.uuid })
    .from(schema.payrollRuns)
    .where(and(eq(schema.payrollRuns.payPeriodId, payPeriodId), inArray(schema.payrollRuns.state, ["APPROVED", "PUBLISHED"])))
    .limit(1))[0];
  if (!run) return NOTHING;

  const item = (await deps.db
    .select({ linesJson: schema.payrollRunItems.linesJson })
    .from(schema.payrollRunItems)
    .where(and(eq(schema.payrollRunItems.runId, run.uuid), eq(schema.payrollRunItems.employeeId, employeeId)))
    .limit(1))[0];
  // The run did not pay this person at all, so it docked nothing from them and there is nothing to restate.
  // Their pay for that period is a different question (they were unpriced, which the run already reports).
  if (!item) return NOTHING;

  const period = (await deps.db
    .select({ periodStart: schema.payPeriods.periodStart, periodEnd: schema.payPeriods.periodEnd })
    .from(schema.payPeriods)
    .where(eq(schema.payPeriods.uuid, payPeriodId))
    .limit(1))[0];
  if (!period) return NOTHING;

  const lines = parseLines(item.linesJson);
  const charged = chargedUnits(lines);

  // Every adjustment already raised for this period - the open one, which is replaced, and the PAID ones,
  // which are not. The paid units are netted off in `lopAdjustment` so a second correction pays only the
  // residual: `charged` is a historical constant, so without this the total correction would be restated
  // and paid again each time attendance moved. The open-row index cannot prevent that, because it
  // deliberately permits a new open row once the previous one is paid.
  const existing = await deps.db
    .select()
    .from(schema.lopAdjustments)
    .where(and(
      eq(schema.lopAdjustments.employeeId, employeeId),
      eq(schema.lopAdjustments.payPeriodId, payPeriodId),
    ));
  const open = existing.find((a) => a.paidRunId === null);
  const settled = round2(existing.filter((a) => a.paidRunId !== null).reduce((s, a) => s + a.dayUnits, 0));
  const restatement: LopRestatement = { charged, correct: round2(correctUnits), settled };

  // Working days are needed only by the fallback rate, and `dailyRateOf` prefers the run's own line.
  const days = Math.max(1, Math.round((+new Date(period.periodEnd) - +new Date(period.periodStart)) / 86_400_000) + 1);
  const adj = lopAdjustment(restatement, dailyRateOf(lines, days));

  if (!adj) {
    // Nothing further is owed - either the period was docked correctly all along, or what it got wrong has
    // already been settled. An OPEN adjustment must then GO, not sit at zero: attendance can be corrected
    // back to where it started, and a leftover row would pay a correction for a change that was undone.
    // Paid rows are never touched here; they are history, and `settled` above is how they stay accounted for.
    if (!open) return NOTHING;
    await deps.db.delete(schema.lopAdjustments).where(eq(schema.lopAdjustments.uuid, open.uuid));
    await audit(deps, "system", "lop_adjustment.clear", "lop-adjustments", open.uuid, { employee_id: employeeId, pay_period_id: payPeriodId });
    return { ...NOTHING, cleared: true };
  }

  if (open) {
    await deps.db
      .update(schema.lopAdjustments)
      .set({ chargedUnits: charged, correctUnits: restatement.correct, dayUnits: adj.dayUnits, amount: adj.amount, updatedAt: new Date() })
      .where(eq(schema.lopAdjustments.uuid, open.uuid));
    await audit(deps, "system", "lop_adjustment.restate", "lop-adjustments", open.uuid, { day_units: adj.dayUnits, amount: adj.amount, charged, correct: restatement.correct });
    return { raised: true, cleared: false, dayUnits: adj.dayUnits, amount: adj.amount };
  }

  const row = (await withFreshCode(async () => deps.db
    .insert(schema.lopAdjustments)
    .values({
      code: await allocOwnedCode(deps, schema.lopAdjustments, schema.lopAdjustments.employeeId, employeeId),
      employeeId,
      payPeriodId,
      chargedUnits: charged,
      correctUnits: restatement.correct,
      dayUnits: adj.dayUnits,
      amount: adj.amount,
    })
    .returning()))[0]!;
  await audit(deps, "system", "lop_adjustment.raise", "lop-adjustments", row.uuid, { day_units: adj.dayUnits, amount: adj.amount, charged, correct: restatement.correct });
  return { raised: true, cleared: false, dayUnits: adj.dayUnits, amount: adj.amount };
}

/** The closed period a day falls in, or null. A day in a period with no committed run is not closed. */
export async function closedPeriodFor(deps: Deps, dayMs: number): Promise<string | null> {
  const period = (await deps.db
    .select({ uuid: schema.payPeriods.uuid })
    .from(schema.payPeriods)
    .where(and(lte(schema.payPeriods.periodStart, new Date(dayMs)), gte(schema.payPeriods.periodEnd, new Date(dayMs))))
    .limit(1))[0];
  if (!period) return null;
  const committed = (await deps.db
    .select({ uuid: schema.payrollRuns.uuid })
    .from(schema.payrollRuns)
    .where(and(eq(schema.payrollRuns.payPeriodId, period.uuid), inArray(schema.payrollRuns.state, ["APPROVED", "PUBLISHED"])))
    .limit(1))[0];
  return committed ? period.uuid : null;
}

/** Unpaid adjustments for a set of employees, for the run build to pick up. */
export async function openAdjustmentsFor(deps: Deps, employeeIds: string[]) {
  if (!employeeIds.length) return [];
  return deps.db
    .select()
    .from(schema.lopAdjustments)
    .where(and(inArray(schema.lopAdjustments.employeeId, employeeIds), isNull(schema.lopAdjustments.paidRunId)));
}

/** Mark adjustments settled by a run. Shaped as a statement so the build can put it in its own atomic batch
 *  alongside every other payable marker (see `buildRunItems`). */
export function markLopAdjustmentsPaidByRun(deps: Deps, ids: string[], runId: string, at: Date) {
  return deps.db
    .update(schema.lopAdjustments)
    .set({ paidRunId: runId, paidAt: at, updatedAt: at })
    .where(and(inArray(schema.lopAdjustments.uuid, ids), isNull(schema.lopAdjustments.paidRunId)));
}

// Attainment -> variable pay: the loop goals exist for in most orgs, and the last hop the money side was
// missing. A review cycle produces a weighted attainment per person; each person's compensation carries a
// target variable pay; the two multiply into a RECOMMENDATION that a human reviews and awards.
//
// Deliberately a recommendation with a human gate. Nothing here writes money on its own: the computation is
// exact and auditable, but the decision to pay is a person's, and a payout that appeared because a percentage
// crossed a threshold is exactly the failure mode a payroll system must not have.
import { and, eq, inArray, isNull, lte, or, gte } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import type { ListScope } from "../domain/access";
import { applyScope } from "./listScope";
import { audit } from "../lib/audit";
import { failedPrecondition, invalidArgument, isVariablePayCollision, notFound } from "../lib/errors";
import { goalAttainment, type GoalSnapshot } from "../domain/performance";
import { round2 } from "../domain/money";
import { recordBonus, recordBonusesForCycle } from "./bonuses";
import { cycleGoalsFor } from "./reviews";
import { byIdChunks } from "../lib/dbBatch";
import { orgToday } from "./orgDay";

const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);

export type VariablePayLine = {
  employee: string;
  review: string;
  /** Weighted goal attainment for the cycle, 0-100, or null when there was nothing to score. */
  attainment: number | null;
  /** Full-year target variable pay from the effective compensation, or null when the person has none. */
  target: number | null;
  currency: string;
  /** target x attainment, rounded to the currency's two places. Null when either half is missing. */
  recommended: number | null;
  /** A bonus already awarded for this cycle, so a second run does not double-pay. */
  awarded: number | null;
  /** Why this line cannot be paid, when it cannot. */
  blocked?: "no_attainment" | "no_target" | "already_awarded" | "not_shared";
};

/** The bonus `kind` that marks a payout as this cycle's variable pay - also how a re-run spots its own work. */
export const VARIABLE_PAY_KIND = "Performance Variable Pay";
const reasonFor = (cycleName: string) => `Variable pay for ${cycleName}`;

/**
 * What each reviewee of a cycle has earned, and what they are owed for it.
 *
 * SCOPE. Reviews are read through the caller's own reviews scope, so a manager sees their team's numbers and
 * HR sees everyone's - the same rows either of them could list. The goals behind each score are read
 * unscoped, because the score IS the review's, already frozen into it at sharing; re-deriving it through a
 * narrower lens would quietly hand two people two different payout figures for the same person.
 */
export async function variablePayRun(deps: Deps, scope: ListScope, cycleId: string): Promise<{ cycle: typeof schema.reviewCycles.$inferSelect; lines: VariablePayLine[] }> {
  const cycle = (await deps.db.select().from(schema.reviewCycles).where(eq(schema.reviewCycles.uuid, cycleId)).limit(1))[0];
  if (!cycle || cycle.deleteTime) throw notFound("review cycle not found");

  const reviews = await deps.db
    .select()
    .from(schema.reviews)
    .where(and(applyScope(scope, schema.reviews.code, schema.reviews.employeeId), eq(schema.reviews.cycleId, cycleId)));

  // Everything already awarded out of THIS cycle, in one read - keyed on the cycle itself, so it survives
  // the cycle being renamed and cannot be confused with a same-named cycle from another year.
  const awardedByEmployee = await awardedForCycle(deps, cycleId);

  // TWO BULK READS, not two per reviewee. Everything below is per review, and the two things it needs -
  // the live goal set and the compensation in force - were a query each, so a cycle cost 2-3 round-trips a
  // head in ONE request: a two-hundred-person cycle spent the invocation's whole subrequest budget and the
  // run simply stopped working at whatever size crossed it, on the path that prices real money.
  const on = cycle.periodEnd ?? cycle.createdAt;
  const employeeIds = reviews.map((r) => r.employeeId);
  // Only the reviews that are not yet frozen need a live read; a shared one answers from its own snapshot.
  const liveGoals = await cycleGoalsFor(deps, reviews.filter((r) => !r.goalsJson).map((r) => r.employeeId), cycleId);
  const compByEmployee = await effectiveCompensationFor(deps, employeeIds, on);

  const lines: VariablePayLine[] = [];
  for (const review of reviews) {
    // The frozen snapshot is the reviewed truth. A review still in flight is scored LIVE, and is reported -
    // never paid: `blocked: "not_shared"` below is what makes that true. It used to be asserted here and
    // implemented nowhere, so `:award` on an active cycle wrote real bonuses off a self-assessment the
    // reviewee could still edit, at whatever number it happened to hold that minute.
    const frozen = !!review.goalsJson;
    const snapshot: GoalSnapshot[] = frozen ? safeParse(review.goalsJson!) : (liveGoals.get(review.employeeId) ?? []);
    const attained = goalAttainment(snapshot);
    const comp = compByEmployee.get(review.employeeId);
    const target = comp?.variablePayTarget ?? null;
    const awarded = awardedByEmployee.get(review.employeeId) ?? null;
    const recommended = attained && target != null ? round2((target * attained.score) / 100) : null;
    lines.push({
      employee: `employees/${review.employeeId}`,
      review: `reviews/${review.uuid}`,
      attainment: attained?.score ?? null,
      target,
      currency: comp?.currency ?? "INR",
      recommended,
      awarded,
      ...(awarded != null ? { blocked: "already_awarded" as const }
        : !attained ? { blocked: "no_attainment" as const }
        : target == null ? { blocked: "no_target" as const }
        : !frozen ? { blocked: "not_shared" as const }
        : {}),
    });
  }
  lines.sort((a, b) => (b.recommended ?? -1) - (a.recommended ?? -1));
  return { cycle, lines };
}

function safeParse(json: string): GoalSnapshot[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * The compensation revision in force on a given day, for many people at once - the same "effective THEN, not
 * latest" rule payroll uses, applied per employee over one read.
 *
 * The window is bound in SQL and the newest-wins pick is made in memory, because SQLite has no per-group
 * limit: `ORDER BY effective_from DESC LIMIT 1` answers for the whole result set, not for each employee.
 *
 * SOFT-DELETED REVISIONS ARE NOT IN FORCE. The compensation timeline is editable by design - a revision
 * entered wrong is corrected by deleting it - so `delete_time` is part of "which row applies", exactly as it
 * is for every other reader of this table (payroll's build, timelineOf, the letter annexure, the tax
 * projection, the custom grid). Without it the deleted row still won the newest-effective_from pick and set
 * the variable-pay TARGET, so the recommendation a human then awards as a real bonus was priced off a
 * revision payroll itself does not use - the two disagreeing about the same person's salary.
 */
async function effectiveCompensationFor(deps: Deps, employeeIds: string[], on: Date | number) {
  const day = new Date(on);
  const ids = [...new Set(employeeIds.filter(Boolean))];
  const out = new Map<string, typeof schema.compensation.$inferSelect>();
  if (!ids.length) return out;
  const rows = await byIdChunks(ids, (group) =>
    deps.db
      .select()
      .from(schema.compensation)
      .where(and(
        inArray(schema.compensation.employeeId, group),
        isNull(schema.compensation.deleteTime),
        lte(schema.compensation.effectiveFrom, day),
        or(isNull(schema.compensation.effectiveTo), gte(schema.compensation.effectiveTo, day)),
      )),
  );
  for (const r of rows) {
    const held = out.get(r.employeeId);
    if (!held || +new Date(r.effectiveFrom) > +new Date(held.effectiveFrom)) out.set(r.employeeId, r);
  }
  return out;
}

/**
 * What this cycle has already paid, per person, so a second run reports rather than repeats.
 *
 * Keyed on `bonuses.cycle_id` - the award's own reference to the cycle it came out of. The key used to be the
 * bonus `reason` TEXT, which embeds the cycle's name, and a name is not an identity: renaming a cycle after
 * awarding made this find nothing and pay everybody again, and two cycles sharing a name (an annual "Q1")
 * made it find the wrong year's payout and refuse a real one. One read for the whole run, not one per line.
 */
async function awardedForCycle(deps: Deps, cycleId: string): Promise<Map<string, number>> {
  const rows = await deps.db
    .select({ employeeId: schema.bonuses.employeeId, amount: schema.bonuses.amount })
    .from(schema.bonuses)
    .where(and(eq(schema.bonuses.cycleId, cycleId), eq(schema.bonuses.kind, VARIABLE_PAY_KIND)));
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.employeeId, round2((out.get(r.employeeId) ?? 0) + r.amount));
  return out;
}

/**
 * Award the recommendation: one bonus per named employee, at the figure the run computed.
 *
 * The AMOUNT is recomputed here rather than taken from the request. A payout is the one thing in this flow
 * nobody should be able to set by editing a number on the way past - the page shows what the arithmetic says,
 * and the award writes what the arithmetic says. An employee whose line is blocked is skipped rather than
 * paid a guess - and "the review has not been shared yet" is one of the blocked cases, so no payout is ever
 * priced off a score its own reviewee can still change.
 */
export async function awardVariablePay(
  deps: Deps,
  actor: AppUser,
  scope: ListScope,
  cycleId: string,
  employeeRefs: string[],
): Promise<{
  cycle: typeof schema.reviewCycles.$inferSelect;
  lines: VariablePayLine[];
  result: { awarded: number; total: number; skipped: number; currency: string };
}> {
  const ids = new Set(employeeRefs.map(idFromPath).filter(Boolean) as string[]);
  if (!ids.size) throw invalidArgument("select at least one person to award");
  const { cycle, lines } = await variablePayRun(deps, scope, cycleId);
  if (cycle.state === "DRAFT") throw failedPrecondition("this cycle has not been launched, so nothing has been scored yet");

  // The date this award is BOOKED on, in the org's timezone - it lands on a bonus row that payroll then picks
  // up by pay period, so a UTC-derived day could book an award into the wrong month for anyone whose local
  // month-end has not arrived yet (or has already passed).
  const awardDate = await orgToday(deps);
  let awarded = 0;
  let total = 0;
  let skipped = 0;
  let currency = "INR";
  /** What this press actually paid, per employee ref, so the answer can be patched rather than re-read. */
  const paid = new Map<string, number>();
  // The lines this press is actually paying, decided first, then written as ONE batched award.
  //
  // This loop used to call `recordBonus` per line - a duplicate read, a counter statement, an insert, an audit
  // entry and a `notify()` each - which is the per-employee fan-out this module's own comment above already
  // names as the thing that made a two-hundred-person cycle stop working. `recordBonusesForCycle` does the
  // whole group in a couple of statements; the idempotence story is unchanged, because it is the UNIQUE index
  // that settles a race either way (see that function).
  const payable: { employeeId: string; amount: number; currency: string; line: string }[] = [];
  for (const line of lines) {
    if (!ids.has(idFromPath(line.employee)!)) continue;
    if (line.blocked || line.recommended == null || line.recommended <= 0) {
      skipped++;
      continue;
    }
    currency = line.currency;
    payable.push({ employeeId: idFromPath(line.employee)!, amount: line.recommended, currency: line.currency, line: line.employee });
  }
  if (payable.length) {
    const res = await recordBonusesForCycle(deps, actor, cycleId, VARIABLE_PAY_KIND, reasonFor(cycle.name), awardDate, payable);
    // A refusal is somebody else's concurrent award having already paid that person, which is exactly what the
    // pre-read would have said had it seen their row - so it counts as skipped, as it always did.
    skipped += res.skipped;
    const written = new Set(res.awardedEmployeeIds);
    for (const a of payable) {
      if (!written.has(a.employeeId)) continue;
      awarded++;
      total = round2(total + a.amount);
      paid.set(a.line, round2((paid.get(a.line) ?? 0) + a.amount));
    }
  }
  // The trail records the CYCLE the money came out of, because "why was this bonus paid" is the question an
  // auditor opens with and the bonus row itself only carries a sentence.
  await audit(deps, actor, "review-cycle.awardVariablePay", "review-cycles", cycleId, {
    fields: [...ids].slice(0, 12).map((e) => `employees/${e}`),
    note: `awarded ${awarded} variable payout${awarded === 1 ? "" : "s"} totalling ${total} ${currency}${skipped ? `, skipped ${skipped}` : ""}`,
  }, cycle);
  const after = lines.map((line) => {
    const justPaid = paid.get(line.employee);
    if (justPaid === undefined) return line;
    return { ...line, awarded: round2((line.awarded ?? 0) + justPaid), blocked: "already_awarded" as const };
  });
  return { cycle, lines: after, result: { awarded, total, skipped, currency } };
}

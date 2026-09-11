import { allocOwnedCode } from "./codeAlloc";
import { and, eq, inArray, isNull, gte, sql, type SQL } from "drizzle-orm";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { genId } from "../lib/idCodec";
import { audit } from "../lib/audit";
import { invalidArgument, notFound } from "../lib/errors";
import { notify } from "./notifications";
import { orgCurrency } from "./settings";
import { round2 } from "../domain/money";

// One-off awards (bonus/incentive). A flat per-employee log; the bonus letter cites the most recent award.
export type BonusInput = {
  employee?: string | null;
  amount?: number;
  currency_code?: string;
  kind?: string | null;
  reason?: string | null;
  award_date?: string; // YYYY-MM-DD
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string) => (s ? Date.parse(s + "T00:00:00Z") : NaN);

// Idempotency guard for accidental double-submit (double-click / client retry): there is no stable natural key
// across two award calls (a group award mints a fresh batchId each time), so a DB unique index can't express
// it. Instead, an identical still-unpaid award for the same employee created within this window is treated as
// the same award and REUSED, not inserted again - otherwise the next payroll run pays the duplicate. A
// deliberate re-award outside the window (or after the first was paid) is unaffected. Match key: employee +
// amount + kind + awardDate + scope + scopeRef.
const DEDUP_WINDOW_MS = 2 * 60_000;
async function findRecentDuplicate(
  deps: Deps,
  key: { employeeId: string; amount: number; kind: string | null; reason: string | null; awardDateMs: number; scope: string; scopeRef: string | null },
  now: number,
): Promise<typeof schema.bonuses.$inferSelect | undefined> {
  const cutoff = new Date(now - DEDUP_WINDOW_MS);
  const rows = await deps.db
    .select()
    .from(schema.bonuses)
    .where(and(eq(schema.bonuses.employeeId, key.employeeId), isNull(schema.bonuses.paidRunId), gte(schema.bonuses.createdAt, cutoff)));
  return rows.find(
    (r) =>
      r.amount === key.amount &&
      (r.kind ?? null) === key.kind &&
      (r.reason ?? null) === key.reason &&
      +new Date(r.awardDate) === key.awardDateMs &&
      (r.scope ?? null) === key.scope &&
      (r.scopeRef ?? null) === key.scopeRef,
  );
}

// One employee's awards (newest first), or - unfiltered - everything the caller may see.
//
// PAGED IN SQL, on `award_date`. Unfiltered this list is org-wide, and a company-scope `bonuses:award`
// materializes one row per employee per award - so the table grows with headcount x award events and the
// unpaged version read all of it into the Worker on every list, sorted it in JS and returned the lot with
// `nextPageToken: undefined`. That is the pattern keysetPage exists to replace: the DB orders and LIMITs, and
// the caller follows the cursor. `award_date` is `notNull`, so it is a valid keyset key for every matching row.
export async function listBonuses(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, employeeId?: string) {
  const conds = [applyScope(scope, schema.bonuses.code, schema.bonuses.employeeId)];
  if (employeeId) conds.push(eq(schema.bonuses.employeeId, employeeId));
  const where = conds.filter(Boolean).length ? and(...(conds.filter(Boolean) as SQL[])) : undefined;
  return keysetPage<typeof schema.bonuses.$inferSelect>(deps, schema.bonuses, "bonuses", where, {
    max: maxPageSize,
    pageToken,
    order: { expr: sql`${schema.bonuses.awardDate}`, value: (r) => +new Date(r.awardDate) },
  });
}

/**
 * `origin` is set by a SERVER-SIDE awarder, never by a caller: it is deliberately not part of `BonusInput`,
 * so nothing on the wire can claim a bonus came out of a review cycle. Today the one awarder that uses it is
 * `services/variablePay.ts#awardVariablePay`, whose re-run detection reads it back.
 */
export async function recordBonus(deps: Deps, actor: AppUser, input: BonusInput, origin?: { cycleId?: string | null }) {
  const employeeId = idFromPath(input.employee);
  const when = dayMs(input.award_date);
  if (!employeeId) throw invalidArgument("employee is required");
  if (typeof input.amount !== "number" || input.amount <= 0) throw invalidArgument("amount must be greater than 0");
  if (Number.isNaN(when)) throw invalidArgument("award_date is required");
  const emp = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
  if (!emp || emp.deleteTime) throw notFound("employee not found");

  const kind = input.kind?.trim() || null;
  const reason = input.reason?.trim() || null;
  // Rounded to paise before anything sees it: every stored monetary value passes round2 (the schema's monetary
  // invariant), and a bonus is summed straight into a payroll run's gross.
  const amount = round2(input.amount);
  // Reuse an identical unpaid award from a recent double-submit instead of creating a second payable. `reason`
  // is part of the key so two distinct same-amount awards the same day (e.g. two referral bonuses) stay separate.
  const dup = await findRecentDuplicate(deps, { employeeId, amount, kind, reason, awardDateMs: when, scope: "individual", scopeRef: null }, +deps.clock.now());
  if (dup) return dup;

  const row = (await deps.db
    .insert(schema.bonuses)
    .values({
      code: await allocOwnedCode(deps, schema.bonuses, schema.bonuses.employeeId, employeeId),
      employeeId,
      amount,
      currency: input.currency_code?.trim() || await orgCurrency(deps),
      kind,
      reason,
      awardDate: new Date(when),
      scope: "individual",
      cycleId: origin?.cycleId ?? null,
    })
    .returning())[0]!;
  await audit(deps, actor, "bonus.record", "bonuses", row.uuid, { employee: `employees/${employeeId}` });
  await notify(deps, { recipient: employeeId, type: "bonus.awarded", title: "Bonus awarded", body: `${row.currency} ${row.amount}${reason ? ` - ${reason}` : ""} (paid in your next payroll run).`, link: "payslips", subject: `bonuses/${row.uuid}`, actorId: actor.employeeId });
  return row;
}

export type AwardInput = {
  scope?: "company" | "department" | "individual";
  department?: string | null; // departments/<id> (department scope)
  employee?: string | null; // employees/<id> (individual scope)
  amount?: number;
  currency_code?: string;
  kind?: string | null;
  reason?: string | null;
  award_date?: string; // YYYY-MM-DD
};

// Award a flat bonus across a scope - company-wide, a department, or one employee - materializing ONE row per
// in-scope active employee (so it shows on each profile and is paid, taxable, by the next payroll run). Group
// awards share a batch id. Returns the created rows.
export async function awardBonus(deps: Deps, actor: AppUser, input: AwardInput) {
  const scope = input.scope ?? "individual";
  if (typeof input.amount !== "number" || input.amount <= 0) throw invalidArgument("amount must be greater than 0");
  const amount = round2(input.amount); // stored to the paise, like every other monetary value
  const when = dayMs(input.award_date);
  if (!(amount > 0)) throw invalidArgument("amount must be greater than 0");
  if (Number.isNaN(when)) throw invalidArgument("award_date is required");

  const active = (await deps.db.select().from(schema.employees).where(eq(schema.employees.status, "active"))).filter((e) => !e.deleteTime);
  let targets = active;
  let scopeRef: string | null = null;
  if (scope === "company") {
    targets = active;
  } else if (scope === "department") {
    const deptId = idFromPath(input.department);
    if (!deptId) throw invalidArgument("department is required");
    scopeRef = `departments/${deptId}`;
    targets = active.filter((e) => e.departmentId === deptId);
  } else {
    const empId = idFromPath(input.employee);
    if (!empId) throw invalidArgument("employee is required");
    targets = active.filter((e) => e.uuid === empId);
    if (!targets.length) throw notFound("employee not found");
  }
  if (!targets.length) throw invalidArgument("no active employees in the selected scope");

  const batchId = scope === "individual" ? null : genId();
  const currency = input.currency_code?.trim() || await orgCurrency(deps);
  const kind = input.kind?.trim() || null;
  const reason = input.reason?.trim() || null;
  const now = +deps.clock.now();
  const created: (typeof schema.bonuses.$inferSelect)[] = [];
  for (const e of targets) {
    // Reuse an identical unpaid award from a recent double-submit (per employee), so a re-clicked group award
    // returns the same rows instead of doubling every payable. A wholly-new award (outside the window) inserts.
    const dup = await findRecentDuplicate(deps, { employeeId: e.uuid, amount, kind, reason, awardDateMs: when, scope, scopeRef }, now);
    if (dup) { created.push(dup); continue; }
    const row = (await deps.db
      .insert(schema.bonuses)
      .values({
        code: await allocOwnedCode(deps, schema.bonuses, schema.bonuses.employeeId, e.uuid),
        employeeId: e.uuid, amount, currency, kind, reason, awardDate: new Date(when), scope, scopeRef, batchId,
      })
      .returning())[0]!;
    created.push(row);
    await notify(deps, { recipient: e.uuid, type: "bonus.awarded", title: "Bonus awarded", body: `${currency} ${amount}${reason ? ` - ${reason}` : ""} (paid in your next payroll run).`, link: "payslips", subject: `bonuses/${row.uuid}`, actorId: actor.employeeId });
  }
  await audit(deps, actor, "bonus.award", "bonuses", batchId ?? created[0]!.uuid, { scope, scopeRef, count: created.length });
  return created;
}

// Bonuses awarded to an employee but not yet paid by any run (the next run pays them as a taxable earning).
// `paidAt` with no run means an FnF settlement already paid it (the leaver is in no run), so both markers gate
// the queue - checking paidRunId alone would re-pay an award the final settlement already covered.
const BONUS_UNPAID = and(isNull(schema.bonuses.paidRunId), isNull(schema.bonuses.paidAt));
export async function unpaidBonuses(deps: Deps, employeeId: string) {
  return deps.db.select().from(schema.bonuses).where(and(eq(schema.bonuses.employeeId, employeeId), BONUS_UNPAID));
}
// Every unpaid bonus in one read - the run build groups by employee (subrequest-budget shape, see dbBatch).
export async function unpaidBonusesAll(deps: Deps) {
  return deps.db.select().from(schema.bonuses).where(BONUS_UNPAID);
}
// Paid by a full-and-final settlement rather than a run (paidAt set, paidRunId left null), and the release a
// recomputed settlement uses to put them back in the queue. Guarded so neither can touch a run-paid award.
// Unexecuted statement, so the FnF commits it in the same atomic batch as the settlement (see reimbursements).
export function markBonusesSettledStmt(deps: Deps, ids: string[], at: Date) {
  return deps.db.update(schema.bonuses).set({ paidAt: at }).where(and(inArray(schema.bonuses.uuid, ids), isNull(schema.bonuses.paidRunId)));
}
export function releaseBonusesSettledStmt(deps: Deps, ids: string[]) {
  return deps.db.update(schema.bonuses).set({ paidAt: null }).where(and(inArray(schema.bonuses.uuid, ids), isNull(schema.bonuses.paidRunId)));
}
// Returns the UNEXECUTED statement so the build can batch it (thenable - a direct await still executes).
// Guarded on still being unpaid: the build reads the queue up front and flips it at the end, so two runs
// building concurrently would otherwise both claim the same bonus and pay it twice (mirrors encashments).
export function markBonusesPaidByRun(deps: Deps, ids: string[], runId: string, at: Date) {
  return deps.db.update(schema.bonuses).set({ paidRunId: runId, paidAt: at }).where(and(inArray(schema.bonuses.uuid, ids), isNull(schema.bonuses.paidRunId)));
}
// Undo a prior build's bonus payments on this run, so a rebuild is idempotent (mirrors encashments).
export function resetBonusesPaidByRun(deps: Deps, runId: string) {
  return deps.db.update(schema.bonuses).set({ paidRunId: null, paidAt: null }).where(eq(schema.bonuses.paidRunId, runId));
}

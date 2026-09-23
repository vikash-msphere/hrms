import { allocOwnedCode, allocOwnedCodeRuns } from "./codeAlloc";
import { and, eq, inArray, isNull, gte, sql, type SQL } from "drizzle-orm";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { genId } from "../lib/idCodec";
import { byIdChunks, insertBatches, runBatch } from "../lib/dbBatch";
import { audit } from "../lib/audit";
import { invalidArgument, isVariablePayCollision, notFound } from "../lib/errors";
import { notify, notifyMany } from "./notifications";
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
/**
 * Every in-scope employee, as ids - by the SCOPE's own predicate, in SQL.
 *
 * This used to be `select().from(employees).where(status = 'active')` - every column of every active person,
 * including the five encrypted PII blobs - filtered down to the target set in the isolate. D1 bills rows READ,
 * so a one-person `individual` award paid for the whole directory, and a company award paid for it twice over
 * (once here, once in the payload it never looked at). Same shape services/payroll.ts was rewritten out of.
 */
async function targetsFor(deps: Deps, scope: "company" | "department" | "individual", input: AwardInput): Promise<{ ids: string[]; scopeRef: string | null }> {
  const live = [eq(schema.employees.status, "active"), isNull(schema.employees.deleteTime)];
  if (scope === "individual") {
    const empId = idFromPath(input.employee);
    if (!empId) throw invalidArgument("employee is required");
    const rows = await deps.db.select({ uuid: schema.employees.uuid }).from(schema.employees).where(and(...live, eq(schema.employees.uuid, empId)));
    if (!rows.length) throw notFound("employee not found");
    return { ids: rows.map((r) => r.uuid), scopeRef: null };
  }
  if (scope === "department") {
    const deptId = idFromPath(input.department);
    if (!deptId) throw invalidArgument("department is required");
    const rows = await deps.db.select({ uuid: schema.employees.uuid }).from(schema.employees).where(and(...live, eq(schema.employees.departmentId, deptId)));
    return { ids: rows.map((r) => r.uuid), scopeRef: `departments/${deptId}` };
  }
  const rows = await deps.db.select({ uuid: schema.employees.uuid }).from(schema.employees).where(and(...live));
  return { ids: rows.map((r) => r.uuid), scopeRef: null };
}

/**
 * The employees among `ids` who already hold an identical unpaid award inside the dedup window, as one read
 * for the whole roster instead of one per person. Same match key as the single-award guard above.
 */
async function recentDuplicates(
  deps: Deps,
  ids: string[],
  key: { amount: number; kind: string | null; reason: string | null; awardDateMs: number; scope: string; scopeRef: string | null },
  now: number,
): Promise<Map<string, typeof schema.bonuses.$inferSelect>> {
  const cutoff = new Date(now - DEDUP_WINDOW_MS);
  const rows = await byIdChunks(ids, (group) =>
    deps.db.select().from(schema.bonuses).where(and(inArray(schema.bonuses.employeeId, group), isNull(schema.bonuses.paidRunId), gte(schema.bonuses.createdAt, cutoff))),
  );
  const out = new Map<string, typeof schema.bonuses.$inferSelect>();
  for (const r of rows) {
    if (out.has(r.employeeId)) continue;
    if (
      r.amount === key.amount &&
      (r.kind ?? null) === key.kind &&
      (r.reason ?? null) === key.reason &&
      +new Date(r.awardDate) === key.awardDateMs &&
      (r.scope ?? null) === key.scope &&
      (r.scopeRef ?? null) === key.scopeRef
    ) out.set(r.employeeId, r);
  }
  return out;
}

// Award a flat bonus across a scope - company-wide, a department, or one employee - materializing ONE row per
// in-scope active employee (so it shows on each profile and is paid, taxable, by the next payroll run). Group
// awards share a batch id. Returns the created rows.
//
// FANNED OUT IN BATCHES, NOT ROW BY ROW. This loop used to do, per employee: a duplicate-check SELECT, a
// counter statement for the code, an INSERT, and a `notify()` - which is itself a read, a counter statement
// and an insert. That is ~6 subrequests each against a per-invocation budget, so a company-wide award stopped
// working somewhere around a hundred and fifty people, and was slow long before that. The identical mistake is
// described in services/notifications.ts#notifyMany, which exists because the nightly cron made it: "one
// subtask spent more than the invocation's whole subrequest budget on a real headcount". The cron was
// converted; this - the interactive path, with no cap on the roster it walks - was not.
//
// Every primitive it needs already existed: `allocOwnedCodeRuns` reserves a code per owner in one batch,
// `insertBatches` + `runBatch` write the rows as a single statement group, and `notifyMany` does the bells in
// one fan-out. The cost is now a handful of statements whatever the headcount.
export async function awardBonus(deps: Deps, actor: AppUser, input: AwardInput) {
  const scope = input.scope ?? "individual";
  if (typeof input.amount !== "number" || input.amount <= 0) throw invalidArgument("amount must be greater than 0");
  const amount = round2(input.amount); // stored to the paise, like every other monetary value
  const when = dayMs(input.award_date);
  if (!(amount > 0)) throw invalidArgument("amount must be greater than 0");
  if (Number.isNaN(when)) throw invalidArgument("award_date is required");

  const { ids, scopeRef } = await targetsFor(deps, scope, input);
  if (!ids.length) throw invalidArgument("no active employees in the selected scope");

  const batchId = scope === "individual" ? null : genId();
  const currency = input.currency_code?.trim() || await orgCurrency(deps);
  const kind = input.kind?.trim() || null;
  const reason = input.reason?.trim() || null;
  const now = +deps.clock.now();

  // Reuse an identical unpaid award from a recent double-submit, so a re-clicked group award returns the same
  // rows instead of doubling every payable.
  const dupes = await recentDuplicates(deps, ids, { amount, kind, reason, awardDateMs: when, scope, scopeRef }, now);
  const fresh = ids.filter((id) => !dupes.has(id));

  // One counter batch for the whole roster. Allocating per employee is what `allocOwnedCodeRuns` was written
  // to replace - see its note on the nightly accrual running out of subrequests mid-roster.
  const codes = await allocOwnedCodeRuns(deps, schema.bonuses, schema.bonuses.employeeId, new Map(fresh.map((id) => [id, 1])));
  const rows = fresh.map((employeeId) => ({
    uuid: genId(), // minted here so the notifications can name each award without reading the inserts back
    code: codes.get(employeeId)![0]!,
    employeeId,
    amount,
    currency,
    kind,
    reason,
    awardDate: new Date(when),
    scope,
    scopeRef,
    batchId,
  }));
  if (rows.length) await runBatch(deps.db, insertBatches(rows, (group) => deps.db.insert(schema.bonuses).values(group)));
  // Read back for the server-side stamps the caller's ETag rides on (a batched insert returns nothing).
  const created = rows.length
    ? await byIdChunks(rows.map((r) => r.uuid), (group) => deps.db.select().from(schema.bonuses).where(inArray(schema.bonuses.uuid, group)))
    : [];
  const byId = new Map(created.map((r) => [r.uuid, r]));
  const inserted = rows.map((r) => byId.get(r.uuid)!).filter(Boolean);

  // The bell, once for the whole fan-out. `subjectFor` keeps each person's link pointing at their OWN award -
  // the one thing that differs per recipient - which is exactly what that parameter is for.
  const subjectByEmployee = new Map(inserted.map((r) => [r.employeeId, `bonuses/${r.uuid}`]));
  await notifyMany(deps, [...subjectByEmployee.keys()], {
    type: "bonus.awarded",
    title: "Bonus awarded",
    body: `${currency} ${amount}${reason ? ` - ${reason}` : ""} (paid in your next payroll run).`,
    link: "payslips",
    subjectFor: (employeeId) => subjectByEmployee.get(employeeId),
    actorId: actor.employeeId,
  });

  // Scope order, with the reused duplicates folded back in where they belong, so the answer describes the whole
  // scope the caller asked for and not only what this press happened to write. Keyed through a map rather than
  // a `find` per id - this list is a whole company on the scope that matters.
  const freshByEmployee = new Map(rows.map((r) => [r.employeeId, r.uuid]));
  const result = ids
    .map((id) => dupes.get(id) ?? byId.get(freshByEmployee.get(id) ?? ""))
    .filter(Boolean) as (typeof schema.bonuses.$inferSelect)[];
  if (!result.length) throw invalidArgument("no active employees in the selected scope");
  await audit(deps, actor, "bonus.award", "bonuses", batchId ?? result[0]!.uuid, { scope, scopeRef, count: result.length });
  return result;
}

/**
 * One variable-pay award per named employee, written as BATCHES rather than one call each.
 *
 * `awardVariablePay` (services/variablePay.ts) used to loop `recordBonus`, which is the same per-employee
 * fan-out `awardBonus` above was written out of - a duplicate read, a counter statement, an insert, an audit
 * entry and a `notify()` per person, against one invocation's subrequest budget. A review cycle is exactly the
 * shape that has a whole roster in it, and that module's own comment already says what that costs: "a
 * two-hundred-person cycle spent the invocation's whole subrequest budget and the run simply stopped working".
 *
 * Answers with WHICH employees were written, not just how many: on the fallback path the caller has to patch
 * its own lines, and a count cannot say whose.
 *
 * `cycle_id + employee_id` is UNIQUE (`bonus_cycle_emp_idx`), which is what makes this award idempotent, and
 * an atomic batch is all-or-nothing - so a single person already paid by a concurrent run would otherwise
 * abort the whole group. The batch is therefore tried first and, only if the index refuses it, the group falls
 * back to one insert at a time so each duplicate is skipped individually and everyone else is still paid. That
 * keeps the exact per-row semantics the caller had while making the ordinary path a couple of statements.
 */
export async function recordBonusesForCycle(
  deps: Deps,
  actor: AppUser,
  cycleId: string,
  kind: string,
  reason: string,
  awardDateYmd: string,
  awards: { employeeId: string; amount: number; currency: string }[],
): Promise<{ awardedEmployeeIds: string[]; skipped: number }> {
  if (!awards.length) return { awardedEmployeeIds: [], skipped: 0 };
  const when = dayMs(awardDateYmd);
  if (Number.isNaN(when)) throw invalidArgument("award_date is required");
  const ids = awards.map((a) => a.employeeId);
  const codes = await allocOwnedCodeRuns(deps, schema.bonuses, schema.bonuses.employeeId, new Map(ids.map((id) => [id, 1])));
  const rows = awards.map((a) => ({
    uuid: genId(),
    code: codes.get(a.employeeId)![0]!,
    employeeId: a.employeeId,
    amount: round2(a.amount),
    currency: a.currency,
    kind,
    reason,
    awardDate: new Date(when),
    scope: "individual" as const,
    cycleId,
  }));

  let written = rows;
  try {
    await runBatch(deps.db, insertBatches(rows, (group) => deps.db.insert(schema.bonuses).values(group)));
  } catch (e) {
    if (!isVariablePayCollision(e)) throw e;
    // The batch rolled back, so nothing landed: replay it row by row and let the index refuse the duplicates.
    written = [];
    for (const r of rows) {
      try {
        await deps.db.insert(schema.bonuses).values(r);
        written.push(r);
      } catch (inner) {
        if (!isVariablePayCollision(inner)) throw inner;
      }
    }
  }
  if (!written.length) return { awardedEmployeeIds: [], skipped: rows.length };

  const writtenByEmployee = new Map(written.map((r) => [r.employeeId, r.uuid]));
  await notifyMany(deps, [...writtenByEmployee.keys()], {
    type: "bonus.awarded",
    title: "Bonus awarded",
    body: reason,
    link: "payslips",
    subjectFor: (employeeId) => {
      const mine = writtenByEmployee.get(employeeId);
      return mine ? `bonuses/${mine}` : undefined;
    },
    actorId: actor.employeeId,
  });
  return { awardedEmployeeIds: written.map((r) => r.employeeId), skipped: rows.length - written.length };
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

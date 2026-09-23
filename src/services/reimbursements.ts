import { allocOwnedCode } from "./codeAlloc";
// WORKFLOW resource (custom methods :approve/:reject/:cancel; PAID is set by payout, never by hand).
import { eq, and, inArray, isNull } from "drizzle-orm";
import { applyScope } from "./listScope";
import { searchFilter } from "./searchFilter";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, createdMeta, stateMeta } from "../lib/audit";
import { round2 } from "../domain/money";
import { notify, notifyManager } from "./notifications";
import { emitEvent } from "./eventBus";
import { invalidArgument, notFound, failedPrecondition } from "../lib/errors";
import { keysetPage } from "./keysetPage";
import { getSettingValue } from "./settings";
import { outstandingOf } from "../domain/loans";
import { repaidCreditStmt } from "./loans";
import { runBatch, runBatchChecked } from "../lib/dbBatch";
import { genId } from "../lib/idCodec";
import { assertNotSubject, assertReviewedVersion } from "./decisionGuard";

export type ReimbursementInput = {
  employee?: string | null;
  category?: string | null;
  amount?: number;
  incurred_on?: string | null; // YYYY-MM-DD
  description?: string | null;
  advance?: string | null; // "loans/<id>" - the advance this claim spends
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string | null) => (s ? Date.parse(s + "T00:00:00Z") : NaN);

export async function listReimbursements(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, stateFilter?: string, q?: string) {
  // Visibility decided by the middleware (scopeFor over the grant); here we only bind it to columns.
  const conds = [applyScope(scope, schema.reimbursements.code, schema.reimbursements.employeeId)];
  // Server-side text filter (FTS). Narrows the scope above; it can never widen it.
  const textMatch = await searchFilter(deps, "reimbursements", q, schema.reimbursements.uuid);
  if (textMatch) conds.push(textMatch);
  if (stateFilter) conds.push(eq(schema.reimbursements.state, stateFilter as typeof schema.reimbursements.$inferSelect.state));
  return keysetPage(deps, schema.reimbursements, "reimbursements", and(...conds.filter(Boolean)), { max: maxPageSize, pageToken });
}

export async function getReimbursement(deps: Deps, _actor: AppUser, id: string) {
  // Read access (own / all) is enforced by the middleware on reimbursements/<code>.
  const row = (await deps.db.select().from(schema.reimbursements).where(eq(schema.reimbursements.uuid, id)).limit(1))[0];
  if (!row) throw notFound("reimbursement not found");
  return row;
}

export async function createReimbursement(deps: Deps, actor: AppUser, input: ReimbursementInput) {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw invalidArgument("amount must be a positive number");
  // Default the employee to the caller's own record unless an admin specifies one (owner-ref gated by mw).
  const employeeId = idFromPath(input.employee) ?? actor.employeeId;
  if (!employeeId) throw invalidArgument("employee is required");
  let categoryId: string | null = null;
  if (input.category) {
    categoryId = idFromPath(input.category)!;
    const cat = (await deps.db.select().from(schema.reimbursementCategories).where(eq(schema.reimbursementCategories.uuid, categoryId)).limit(1))[0];
    if (!cat || cat.deleteTime || cat.disabled) throw invalidArgument("that reimbursement category is unavailable");
  }
  const advanceId = await resolveAdvance(deps, input.advance, employeeId);
  const incurred = dayMs(input.incurred_on);
  const row = (await deps.db
    .insert(schema.reimbursements)
    .values({
      code: await allocOwnedCode(deps, schema.reimbursements, schema.reimbursements.employeeId, employeeId),
      employeeId,
      categoryId,
      advanceId,
      amount: round2(amount),
      incurredOn: Number.isNaN(incurred) ? null : new Date(incurred),
      // Empty string clears, like an omitted field (see web/src/api.ts: nothing on the wire is ever null).
      description: input.description?.trim() || null,
      state: "PENDING",
    })
    .returning())[0]!;
  await audit(deps, actor, "reimbursement.create", "reimbursements", row.uuid, createdMeta(row, "reimbursements"), row);
  await notifyManager(deps, employeeId, { type: "reimbursement.requested", noun: "reimbursement claim" });
  await emitEvent(deps, actor, "reimbursement.submitted", { subject: `reimbursements/${row.uuid}`, employeeId, payload: { amount: row.amount, categoryId } });
  return row;
}

/**
 * The advance a claim may be filed against, validated to the point where settling it cannot be wrong.
 *
 * Four conditions, and each one is a way the money goes astray if it is not checked: it has to BE an advance
 * (a housing loan is not a float somebody spends on a trip), it has to belong to the SAME employee (or one
 * person's claim discharges another's debt), it has to be DISBURSED (an advance that was never paid out has
 * funded nothing), and it has to still owe something (settling against a closed advance credits a balance that
 * is already zero and quietly turns a payable claim into an unpaid one).
 */
async function resolveAdvance(deps: Deps, path: string | null | undefined, employeeId: string): Promise<string | null> {
  const advanceId = idFromPath(path);
  if (!advanceId) return null;
  const adv = (await deps.db.select().from(schema.loans).where(eq(schema.loans.uuid, advanceId)).limit(1))[0];
  if (!adv || adv.deleteTime) throw invalidArgument("that advance is unavailable");
  if (adv.kind !== "advance") throw invalidArgument("only an advance can fund a claim - a loan is repaid, not spent");
  if (adv.employeeId !== employeeId) throw invalidArgument("that advance belongs to a different employee");
  if (adv.status !== "DISBURSED") throw invalidArgument("that advance has not been disbursed, so there is nothing to spend");
  if (outstandingOf(adv) <= 0.005) throw invalidArgument("that advance is already fully settled");
  return advanceId;
}

async function decide(deps: Deps, actor: AppUser, id: string, to: "APPROVED" | "REJECTED" | "CANCELLED", ifMatch?: string) {
  const row = await getReimbursement(deps, actor, id);
  // Who may approve/reject/cancel is enforced centrally by the verb's grant (middleware). Here the claim must
  // still be pending, be the version the decider read, and - to approve - not be the decider's own.
  if (row.state !== "PENDING") {
    throw failedPrecondition(to === "CANCELLED" ? "only pending claims can be cancelled" : "claim is not pending");
  }
  assertReviewedVersion(row, ifMatch);
  if (to === "APPROVED") await assertNotSubject(deps, actor, row.employeeId, "approve", "reimbursement claim");
  // APPROVING A CLAIM FILED AGAINST AN ADVANCE discharges the advance instead of paying the money out again.
  //
  // ONE ATOMIC BATCH with the state flip, and that is the whole difficulty. The flip is the exactly-once guard
  // (0 rows = a concurrent call got there first); crediting the advance afterwards, as a second await, would
  // mean a failure in the gap leaves the claim approved and payable with the advance still owing the full
  // amount - the employee paid twice, which is the exact outcome this feature exists to prevent. Checked, so a
  // credit the loan refuses (closed or soft-deleted between the read above and this commit) fails the approval
  // rather than approving a claim whose settlement never landed.
  const at = new Date();
  if (to === "APPROVED" && row.advanceId) {
    const adv = (await deps.db.select().from(schema.loans).where(eq(schema.loans.uuid, row.advanceId)).limit(1))[0];
    // An advance closed or withdrawn since the claim was filed settles nothing; the claim is approved and paid
    // normally, which is the honest outcome - the money was spent either way.
    const outstanding = adv && !adv.deleteTime && adv.status === "DISBURSED" ? outstandingOf(adv) : 0;
    const settled = round2(Math.min(row.amount, Math.max(0, outstanding)));
    if (settled > 0.005) {
      // THE LEDGER ROW IS THE LOCK, and it goes FIRST.
      //
      // A guarded UPDATE is not enough here, and that is the whole lesson of this block: D1 runs a batch as one
      // transaction, but a zero-row UPDATE is not an ERROR, so the batch still commits. Two approvals racing
      // each other therefore both ran to completion - the loser's claim-flip matched nothing, its credit landed
      // anyway, and the advance was discharged twice for one claim. `runBatchChecked` noticed afterwards, by
      // which point the money had moved; it detects, it does not prevent.
      //
      // `loan_repayment_claim_idx` makes a second credit for the same claim a UNIQUE VIOLATION, and a violation
      // IS an error, which is the one thing that rolls a D1 batch back. So the loser writes nothing: no credit,
      // no ledger row, no approval. It is also what makes a retry after a timeout safe.
      let done: string[];
      try {
        done = await runBatchChecked(deps.db, [
          deps.db.insert(schema.loanRepayments).values({ uuid: genId(), loanId: row.advanceId, runId: null, reimbursementId: id, amount: settled, at }),
          {
            stmt: repaidCreditStmt(deps, row.advanceId, settled, at).returning({ uuid: schema.loans.uuid }),
            expect: 1,
            label: "credit the advance",
          },
          {
            stmt: deps.db
              .update(schema.reimbursements)
              .set({ state: to, decidedBy: actor.uuid, advanceSettled: settled, updatedAt: at })
              .where(and(eq(schema.reimbursements.uuid, id), eq(schema.reimbursements.state, "PENDING")))
              .returning({ uuid: schema.reimbursements.uuid }),
            expect: 1,
            label: "approve the claim",
          },
        ]);
      } catch {
        // The unique violation, or any other statement error: the transaction rolled back, so nothing happened
        // and the caller is told the same thing a losing guarded flip would have told them.
        throw failedPrecondition("claim is not pending");
      }
      if (done.length) {
        // The batch COMMITTED but a guarded statement matched nothing - the advance was closed or withdrawn
        // between the read above and this write, so the credit is not there to justify the approval that is.
        // Compensate rather than leave the pair inconsistent: take the claim back to pending and remove the
        // ledger row that now describes a credit which never landed.
        await runBatch(deps.db, [
          deps.db.delete(schema.loanRepayments).where(eq(schema.loanRepayments.reimbursementId, id)),
          deps.db
            .update(schema.reimbursements)
            .set({ state: "PENDING", decidedBy: null, advanceSettled: 0, updatedAt: at })
            .where(eq(schema.reimbursements.uuid, id)),
        ]);
        throw failedPrecondition(`could not settle this claim against the advance (${[...new Set(done)].join(", ")}) - nothing was approved`);
      }
      const settledRow = await getReimbursement(deps, actor, id);
      await audit(deps, actor, "reimbursement.approved", "reimbursements", id, stateMeta(row.state, to, { employee: `employees/${row.employeeId}`, advance: `loans/${row.advanceId}`, settled }), settledRow);
      await notify(deps, { recipient: row.employeeId, type: "reimbursement.approved", title: "Reimbursement approved", body: `Approved, and ${settled} was set against your advance.`, link: "reimbursements/history", subject: `reimbursements/${id}`, actorId: actor.employeeId });
      await emitEvent(deps, actor, "reimbursement.approved", { subject: `reimbursements/${id}`, employeeId: row.employeeId, payload: { amount: row.amount } });
      return settledRow;
    }
  }

  // Guard the flip on PENDING so the decision is EXACTLY-ONCE (0 rows = already decided by a concurrent call).
  const [updated] = await deps.db
    .update(schema.reimbursements)
    .set({ state: to, decidedBy: actor.uuid, updatedAt: at })
    .where(and(eq(schema.reimbursements.uuid, id), eq(schema.reimbursements.state, "PENDING")))
    .returning();
  if (!updated) throw failedPrecondition(to === "CANCELLED" ? "only pending claims can be cancelled" : "claim is not pending");
  await audit(deps, actor, `reimbursement.${to.toLowerCase()}`, "reimbursements", id, stateMeta(row.state, to, { employee: `employees/${row.employeeId}` }), updated);
  if (to === "APPROVED" || to === "REJECTED") {
    await notify(deps, { recipient: row.employeeId, type: `reimbursement.${to.toLowerCase()}`, title: `Reimbursement ${to.toLowerCase()}`, body: `Your reimbursement claim was ${to.toLowerCase()}.`, link: "reimbursements/history", subject: `reimbursements/${id}`, actorId: actor.employeeId });
    await emitEvent(deps, actor, `reimbursement.${to.toLowerCase()}`, { subject: `reimbursements/${id}`, employeeId: row.employeeId, payload: { amount: row.amount } });
  }
  return updated;
}

export const approveReimbursement = (deps: Deps, actor: AppUser, id: string, ifMatch?: string) => decide(deps, actor, id, "APPROVED", ifMatch);
export const rejectReimbursement = (deps: Deps, actor: AppUser, id: string, ifMatch?: string) => decide(deps, actor, id, "REJECTED", ifMatch);
export const cancelReimbursement = (deps: Deps, actor: AppUser, id: string) => decide(deps, actor, id, "CANCELLED");

// ---- Expense bridge -------------------------------------------------------------------------------------
// An employee-fronted operational expense, once approved, becomes an already-APPROVED reimbursement so the
// normal payroll payout queue pays the employee (non-taxable). The expense-category maps to a
// reimbursement-category by matching name (best-effort; null when none matches). Returns the new row.
export async function createApprovedReimbursementForExpense(
  deps: Deps,
  actor: AppUser,
  args: { employeeId: string; amount: number; incurredOn?: Date | null; description?: string | null; expenseCategoryName?: string | null },
) {
  let categoryId: string | null = null;
  if (args.expenseCategoryName) {
    const cat = (await deps.db.select().from(schema.reimbursementCategories)).find(
      (c) => !c.deleteTime && !c.disabled && c.name.toLowerCase() === args.expenseCategoryName!.toLowerCase(),
    );
    categoryId = cat?.uuid ?? null;
  }
  const row = (await deps.db
    .insert(schema.reimbursements)
    .values({
      code: await allocOwnedCode(deps, schema.reimbursements, schema.reimbursements.employeeId, args.employeeId),
      employeeId: args.employeeId,
      categoryId,
      amount: round2(args.amount),
      incurredOn: args.incurredOn ?? null,
      description: args.description ?? null,
      state: "APPROVED",
      decidedBy: actor.uuid,
    })
    .returning())[0]!;
  await audit(deps, actor, "reimbursement.create", "reimbursements", row.uuid, createdMeta(row, "reimbursements"), row);
  return row;
}

// Undo markReimbursementsSettled for a recomputed settlement. Restricted to the ids that settlement recorded
// and to rows with no run, so a claim genuinely paid out of band (payReimbursement) is never re-queued.
export function releaseReimbursementsSettledStmt(deps: Deps, ids: string[]) {
  return deps.db
    .update(schema.reimbursements)
    .set({ state: "APPROVED", paidAt: null, updatedAt: new Date() })
    .where(and(inArray(schema.reimbursements.uuid, ids), eq(schema.reimbursements.state, "PAID"), isNull(schema.reimbursements.paidRunId)));
}

// ---- Payout ---------------------------------------------------------------------------------------------
export type PayoutMode = "payroll" | "separate";

// Org-wide payout mode (data, configurable in Settings). "payroll" => approved claims are paid as a
// non-taxable line on the next payroll run; "separate" => paid out-of-band via the :pay action.
export async function reimbursementPayoutMode(deps: Deps): Promise<PayoutMode> {
  const v = await getSettingValue<{ payout_mode?: string }>(deps, "reimbursements", {});
  return v.payout_mode === "separate" ? "separate" : "payroll";
}

// Approved, not-yet-paid claims for an employee - the payroll payout queue.
export async function approvedUnpaidReimbursements(deps: Deps, employeeId: string) {
  return deps.db
    .select()
    .from(schema.reimbursements)
    .where(and(eq(schema.reimbursements.employeeId, employeeId), eq(schema.reimbursements.state, "APPROVED"), isNull(schema.reimbursements.paidRunId)));
}

// The whole payout queue in one read - the run build groups by employee (subrequest-budget shape).
export async function approvedUnpaidReimbursementsAll(deps: Deps) {
  return deps.db
    .select()
    .from(schema.reimbursements)
    .where(and(eq(schema.reimbursements.state, "APPROVED"), isNull(schema.reimbursements.paidRunId)));
}

// The two below return UNEXECUTED statements so the build can batch them (a direct await still executes).

// Idempotent rebuild: un-pay any claims previously paid by THIS run (back to APPROVED) before re-picking.
export function resetReimbursementsPaidByRun(deps: Deps, runId: string) {
  return deps.db
    .update(schema.reimbursements)
    .set({ state: "APPROVED", paidRunId: null, paidAt: null, updatedAt: new Date() })
    .where(eq(schema.reimbursements.paidRunId, runId));
}

// Mark a set of claims paid by a payroll run (called during the build). Guarded on still being
// approved-and-unpaid: a claim paid separately (payReimbursement) or settled in an FnF between the build's
// read and its commit must not also be flipped to paid-by-this-run, which would hide the double payout.
export function markReimbursementsPaidByRun(deps: Deps, ids: string[], runId: string, at: Date) {
  return deps.db
    .update(schema.reimbursements)
    .set({ state: "PAID", paidRunId: runId, paidAt: at, updatedAt: at })
    .where(and(inArray(schema.reimbursements.uuid, ids), eq(schema.reimbursements.state, "APPROVED"), isNull(schema.reimbursements.paidRunId)));
}

// Mark approved claims settled by a FnF settlement (terminal payout, no payroll run). Reuses the PAID marker
// like separate-mode :pay - state=PAID with paidRunId left null - so the claims drop out of the payroll payout
// queue (state=APPROVED AND paidRunId IS NULL) and a run for a still-active leaver can't pay them a second time.
// Returns the UNEXECUTED statement so the FnF can commit it in the same atomic batch as the settlement that
// consumes the claim (thenable - a direct await still executes). Callers guard on a non-empty id list.
//
// GUARDED on still being approved-and-unpaid, exactly like markReimbursementsPaidByRun above and like every
// other settled-marker (bonuses, encashments, overtime, arrears). It was the one marker in the set with no
// guard, and the asymmetry ran the wrong way: the RELEASE below already refuses to touch a run-paid claim,
// while the mark overwrote one. A payroll run building for a still-active leaver claims the same queue, so a
// run committing between this settlement's read and its commit left the row reading `state=PAID,
// paid_run_id=<run>, paid_at=<settlement>` - paid on the payslip AND in the FnF net, with the trail saying
// neither. The guard makes that write land nowhere; the caller's runBatchChecked is what notices.
export function markReimbursementsSettledStmt(deps: Deps, ids: string[], at: Date) {
  return deps.db
    .update(schema.reimbursements)
    .set({ state: "PAID", paidAt: at, updatedAt: at })
    .where(and(inArray(schema.reimbursements.uuid, ids), eq(schema.reimbursements.state, "APPROVED"), isNull(schema.reimbursements.paidRunId)));
}

// Separate-mode :pay - mark an approved claim paid out-of-band (no payroll run).
export async function payReimbursement(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  const row = await getReimbursement(deps, actor, id);
  if (row.state !== "APPROVED") throw failedPrecondition("only approved claims can be marked paid");
  assertReviewedVersion(row, ifMatch);
  await assertNotSubject(deps, actor, row.employeeId, "mark paid", "reimbursement claim");
  // Guard on APPROVED so pay is EXACTLY-ONCE (0 rows = already paid by a concurrent call): no double payout notification.
  const [updated] = await deps.db
    .update(schema.reimbursements)
    .set({ state: "PAID", paidAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.reimbursements.uuid, id), eq(schema.reimbursements.state, "APPROVED")))
    .returning();
  if (!updated) throw failedPrecondition("only approved claims can be marked paid");
  await audit(deps, actor, "reimbursement.pay", "reimbursements", id, stateMeta(row.state, "PAID", { employee: `employees/${row.employeeId}` }), updated);
  await notify(deps, { recipient: row.employeeId, type: "reimbursement.paid", title: "Reimbursement paid", body: "Your approved reimbursement claim was paid.", link: "reimbursements/history", subject: `reimbursements/${id}`, actorId: actor.employeeId });
  await emitEvent(deps, actor, "reimbursement.paid", { subject: `reimbursements/${id}`, employeeId: row.employeeId, payload: { amount: row.amount } });
  return updated;
}

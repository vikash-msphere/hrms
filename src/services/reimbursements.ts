import { allocOwnedCode } from "./codeAlloc";
// WORKFLOW resource (custom methods :approve/:reject/:cancel; PAID is set by payout, never by hand).
import { eq, and, inArray, isNull } from "drizzle-orm";
import { applyScope } from "./listScope";
import { searchFilter } from "./searchFilter";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { round2 } from "../domain/money";
import { notify, notifyManager } from "./notifications";
import { emitEvent } from "./eventBus";
import { invalidArgument, notFound, failedPrecondition } from "../lib/errors";
import { keysetPage } from "./keysetPage";
import { getSettingValue } from "./settings";

export type ReimbursementInput = {
  employee?: string | null;
  category?: string | null;
  amount?: number;
  incurred_on?: string | null; // YYYY-MM-DD
  description?: string | null;
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
  return keysetPage(deps, schema.reimbursements, "reimbursements", and(...conds.filter(Boolean)), { dir: "asc", max: maxPageSize, pageToken });
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
  const incurred = dayMs(input.incurred_on);
  const row = (await deps.db
    .insert(schema.reimbursements)
    .values({
      code: await allocOwnedCode(deps, schema.reimbursements, schema.reimbursements.employeeId, employeeId),
      employeeId,
      categoryId,
      amount: round2(amount),
      incurredOn: Number.isNaN(incurred) ? null : new Date(incurred),
      description: input.description ?? null,
      state: "PENDING",
    })
    .returning())[0]!;
  await audit(deps, actor, "reimbursement.create", "reimbursements", row.uuid, undefined, row);
  await notifyManager(deps, employeeId, { type: "reimbursement.requested", noun: "reimbursement claim" });
  await emitEvent(deps, actor, "reimbursement.submitted", { subject: `reimbursements/${row.uuid}`, employeeId, payload: { amount: row.amount, categoryId } });
  return row;
}

async function decide(deps: Deps, actor: AppUser, id: string, to: "APPROVED" | "REJECTED" | "CANCELLED") {
  const row = await getReimbursement(deps, actor, id);
  // Who may approve/reject/cancel is enforced centrally by the verb's grant (middleware). Here only the
  // instance state matters: the claim must still be pending.
  if (row.state !== "PENDING") {
    throw failedPrecondition(to === "CANCELLED" ? "only pending claims can be cancelled" : "claim is not pending");
  }
  // Guard the flip on PENDING so the decision is EXACTLY-ONCE (0 rows = already decided by a concurrent call).
  const [updated] = await deps.db
    .update(schema.reimbursements)
    .set({ state: to, decidedBy: actor.uuid, updatedAt: new Date() })
    .where(and(eq(schema.reimbursements.uuid, id), eq(schema.reimbursements.state, "PENDING")))
    .returning();
  if (!updated) throw failedPrecondition(to === "CANCELLED" ? "only pending claims can be cancelled" : "claim is not pending");
  await audit(deps, actor, `reimbursement.${to.toLowerCase()}`, "reimbursements", id);
  if (to === "APPROVED" || to === "REJECTED") {
    await notify(deps, { recipient: row.employeeId, type: `reimbursement.${to.toLowerCase()}`, title: `Reimbursement ${to.toLowerCase()}`, body: `Your reimbursement claim was ${to.toLowerCase()}.`, link: "reimbursements/history", subject: `reimbursements/${id}`, actorId: actor.employeeId });
    await emitEvent(deps, actor, `reimbursement.${to.toLowerCase()}`, { subject: `reimbursements/${id}`, employeeId: row.employeeId, payload: { amount: row.amount } });
  }
  return updated;
}

export const approveReimbursement = (deps: Deps, actor: AppUser, id: string) => decide(deps, actor, id, "APPROVED");
export const rejectReimbursement = (deps: Deps, actor: AppUser, id: string) => decide(deps, actor, id, "REJECTED");
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
  await audit(deps, actor, "reimbursement.create", "reimbursements", row.uuid, undefined, row);
  return row;
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

// Idempotent rebuild: un-pay any claims previously paid by THIS run (back to APPROVED) before re-picking.
export async function resetReimbursementsPaidByRun(deps: Deps, runId: string) {
  await deps.db
    .update(schema.reimbursements)
    .set({ state: "APPROVED", paidRunId: null, paidAt: null, updatedAt: new Date() })
    .where(eq(schema.reimbursements.paidRunId, runId));
}

// Mark a set of claims paid by a payroll run (called during the build).
export async function markReimbursementsPaidByRun(deps: Deps, ids: string[], runId: string, at: Date) {
  if (!ids.length) return;
  await deps.db
    .update(schema.reimbursements)
    .set({ state: "PAID", paidRunId: runId, paidAt: at, updatedAt: at })
    .where(inArray(schema.reimbursements.uuid, ids));
}

// Mark approved claims settled by a FnF settlement (terminal payout, no payroll run). Reuses the PAID marker
// like separate-mode :pay - state=PAID with paidRunId left null - so the claims drop out of the payroll payout
// queue (state=APPROVED AND paidRunId IS NULL) and a run for a still-active leaver can't pay them a second time.
export async function markReimbursementsSettled(deps: Deps, ids: string[], at: Date) {
  if (!ids.length) return;
  await deps.db
    .update(schema.reimbursements)
    .set({ state: "PAID", paidAt: at, updatedAt: at })
    .where(inArray(schema.reimbursements.uuid, ids));
}

// Separate-mode :pay - mark an approved claim paid out-of-band (no payroll run).
export async function payReimbursement(deps: Deps, actor: AppUser, id: string) {
  const row = await getReimbursement(deps, actor, id);
  if (row.state !== "APPROVED") throw failedPrecondition("only approved claims can be marked paid");
  // Guard on APPROVED so pay is EXACTLY-ONCE (0 rows = already paid by a concurrent call): no double payout notification.
  const [updated] = await deps.db
    .update(schema.reimbursements)
    .set({ state: "PAID", paidAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.reimbursements.uuid, id), eq(schema.reimbursements.state, "APPROVED")))
    .returning();
  if (!updated) throw failedPrecondition("only approved claims can be marked paid");
  await audit(deps, actor, "reimbursement.pay", "reimbursements", id);
  await notify(deps, { recipient: row.employeeId, type: "reimbursement.paid", title: "Reimbursement paid", body: "Your approved reimbursement claim was paid.", link: "reimbursements/history", subject: `reimbursements/${id}`, actorId: actor.employeeId });
  await emitEvent(deps, actor, "reimbursement.paid", { subject: `reimbursements/${id}`, employeeId: row.employeeId, payload: { amount: row.amount } });
  return updated;
}

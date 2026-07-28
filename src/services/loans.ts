import { eq, and, isNull, gte } from "drizzle-orm";
import { allocOwnedCode } from "./codeAlloc";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, diffMeta } from "../lib/audit";
import { notify, notifyManager } from "./notifications";
import { emitEvent } from "./eventBus";
import { invalidArgument, notFound, aborted, failedPrecondition } from "../lib/errors";
import { etagOf } from "../http/serialize";
import { softDeleteRow, restoreRow, purgeRow } from "./softDelete";
import { installmentAmount, isFullyRepaid } from "../domain/loans";

type Status = typeof schema.loans.$inferSelect.status;
export type LoanInput = {
  employee?: string | null;
  kind?: "loan" | "advance";
  principal?: number;
  installments?: number;
  reason?: string | null;
  start_date?: string | null;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string | null) => (s ? Date.parse(s + "T00:00:00Z") : NaN);
import { round2 } from "../domain/money";
const MANUAL_REPAY_DEDUP_MS = 60_000; // an identical manual repayment within 60s = accidental double-submit

export async function listLoans(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, employee?: string, status?: string, showDeleted = false) {
  const conds = [applyScope(scope, schema.loans.code, schema.loans.employeeId)];
  const empId = idFromPath(employee);
  if (empId) conds.push(eq(schema.loans.employeeId, empId));
  if (status) conds.push(eq(schema.loans.status, status as Status));
  if (!showDeleted) conds.push(isNull(schema.loans.deleteTime));
  return keysetPage(deps, schema.loans, "loans", and(...conds.filter(Boolean)), { dir: "desc", max: maxPageSize, pageToken });
}

export async function getLoan(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.loans).where(eq(schema.loans.uuid, id)).limit(1))[0];
  if (!row) throw notFound("loan not found");
  return row;
}

export async function createLoan(deps: Deps, actor: AppUser, input: LoanInput, id?: string) {
  const employeeId = idFromPath(input.employee) ?? actor.employeeId;
  if (!employeeId) throw invalidArgument("employee is required");
  const principal = input.principal ?? 0;
  if (!(principal > 0)) throw invalidArgument("principal must be greater than 0");
  const installments = Math.max(1, Math.round(input.installments ?? 1));
  if (input.start_date && Number.isNaN(dayMs(input.start_date))) throw invalidArgument("start_date is invalid");
  const row = (await deps.db.insert(schema.loans).values({
    code: await allocOwnedCode(deps, schema.loans, schema.loans.employeeId, employeeId),
    ...(id ? { uuid: id } : {}),
    employeeId,
    kind: input.kind === "advance" ? "advance" : "loan",
    principal: round2(principal),
    installments,
    reason: input.reason?.trim() || null,
    startDate: input.start_date ? new Date(dayMs(input.start_date)) : null,
  }).returning())[0]!;
  await audit(deps, actor, "loan.create", "loans", row.uuid, undefined, row);
  await notifyManager(deps, employeeId, { type: "loan.requested", noun: `${row.kind === "advance" ? "advance" : "loan"} request` });
  await emitEvent(deps, actor, "loan.requested", { subject: `loans/${row.uuid}`, employeeId, payload: { amount: row.principal } });
  return row;
}

// Editable only while PENDING (before approval).
export async function updateLoan(deps: Deps, actor: AppUser, id: string, patch: LoanInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.loans).where(eq(schema.loans.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("loan not found");
  if (row.status !== "PENDING") throw failedPrecondition("only a pending loan can be edited");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const has = (k: keyof LoanInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("kind")) set.kind = patch.kind === "advance" ? "advance" : "loan";
  if (has("principal")) { if (!(Number(patch.principal) > 0)) throw invalidArgument("principal must be greater than 0"); set.principal = round2(patch.principal!); }
  if (has("installments")) set.installments = Math.max(1, Math.round(patch.installments ?? 1));
  if (has("reason")) set.reason = patch.reason?.trim() || null;
  if (has("start_date")) { if (patch.start_date && Number.isNaN(dayMs(patch.start_date))) throw invalidArgument("start_date is invalid"); set.startDate = patch.start_date ? new Date(dayMs(patch.start_date)) : null; }
  const updated = (await deps.db.update(schema.loans).set(set).where(eq(schema.loans.uuid, id)).returning())[0]!;
  await audit(deps, actor, "loan.update", "loans", id, diffMeta(row, updated, set), updated);
  return updated;
}

async function load(deps: Deps, id: string) {
  const row = (await deps.db.select().from(schema.loans).where(eq(schema.loans.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("loan not found");
  return row;
}
// `expectFrom` guards the write on the current status so a status transition is EXACTLY-ONCE: a
// double-clicked/concurrent approve/reject/disburse that also read the from-state loses here (0 rows,
// undefined) instead of both firing the notify/event side-effects twice.
async function setStatus(deps: Deps, id: string, set: Record<string, unknown>, expectFrom?: typeof schema.loans.$inferSelect.status) {
  const where = expectFrom ? and(eq(schema.loans.uuid, id), eq(schema.loans.status, expectFrom)) : eq(schema.loans.uuid, id);
  return (await deps.db.update(schema.loans).set({ ...set, updatedAt: new Date() }).where(where).returning())[0];
}

// PENDING -> APPROVED: fix the monthly installment amount (principal / installments) and default the start date.
export async function approveLoan(deps: Deps, actor: AppUser, id: string) {
  const row = await load(deps, id);
  if (row.status !== "PENDING") throw failedPrecondition("only a pending loan can be approved");
  const monthly = round2(row.principal / Math.max(1, row.installments));
  const updated = await setStatus(deps, id, { status: "APPROVED", monthlyAmount: monthly, decidedBy: actor.uuid, ...(row.startDate ? {} : { startDate: new Date() }) }, "PENDING");
  if (!updated) throw failedPrecondition("only a pending loan can be approved");
  await audit(deps, actor, "loan.approve", "loans", id);
  await notify(deps, { recipient: row.employeeId, type: "loan.approved", title: `${row.kind === "advance" ? "Advance" : "Loan"} approved`, body: `Your ${row.kind} was approved (monthly ${monthly}).`, link: "loans", actorId: actor.employeeId });
  await emitEvent(deps, actor, "loan.approved", { subject: `loans/${id}`, employeeId: row.employeeId, payload: { amount: row.principal, emiAmount: monthly, installments: row.installments } });
  return updated;
}
export async function rejectLoan(deps: Deps, actor: AppUser, id: string) {
  const row = await load(deps, id);
  if (row.status !== "PENDING") throw failedPrecondition("only a pending loan can be rejected");
  const updated = await setStatus(deps, id, { status: "REJECTED", decidedBy: actor.uuid }, "PENDING");
  if (!updated) throw failedPrecondition("only a pending loan can be rejected");
  await audit(deps, actor, "loan.reject", "loans", id);
  await notify(deps, { recipient: row.employeeId, type: "loan.rejected", title: `${row.kind === "advance" ? "Advance" : "Loan"} rejected`, body: `Your ${row.kind} request was rejected.`, link: "loans", actorId: actor.employeeId });
  await emitEvent(deps, actor, "loan.rejected", { subject: `loans/${id}`, employeeId: row.employeeId, payload: { amount: row.principal } });
  return updated;
}
export async function disburseLoan(deps: Deps, actor: AppUser, id: string) {
  const row = await load(deps, id);
  if (row.status !== "APPROVED") throw failedPrecondition("only an approved loan can be disbursed");
  const updated = await setStatus(deps, id, { status: "DISBURSED" }, "APPROVED");
  if (!updated) throw failedPrecondition("only an approved loan can be disbursed");
  await audit(deps, actor, "loan.disburse", "loans", id);
  await notify(deps, { recipient: row.employeeId, type: "loan.disbursed", title: `${row.kind === "advance" ? "Advance" : "Loan"} disbursed`, body: `Your ${row.kind} was disbursed.`, link: "loans", actorId: actor.employeeId });
  await emitEvent(deps, actor, "loan.disbursed", { subject: `loans/${id}`, employeeId: row.employeeId, payload: { amount: row.principal } });
  return updated;
}
// Record a MANUAL repayment against a disbursed loan; closes it once fully repaid. Writes a loan_repayments
// ledger row (runId null = manual, not tied to a payroll run) BEFORE advancing the loan, so every repayment -
// manual or payroll - is auditable through the ledger and the outstanding can be reconciled by summing it.
export async function recordLoanRepayment(deps: Deps, actor: AppUser, id: string, amount: number) {
  const row = await load(deps, id);
  if (row.status !== "DISBURSED") throw failedPrecondition("only a disbursed loan can take repayments");
  if (!(amount > 0)) throw invalidArgument("amount must be greater than 0");
  const applied = round2(Math.min(amount, row.principal - row.repaid)); // never over-repay past the principal
  // Idempotency for accidental double-submit: an identical manual (runId null) repayment of the same amount
  // recorded within the window is treated as the same entry and skipped, so a retry doesn't advance `repaid`
  // twice. A fully-repaying retry is already caught above (the loan is CLOSED, no longer DISBURSED).
  const cutoff = new Date(+deps.clock.now() - MANUAL_REPAY_DEDUP_MS);
  const recent = await deps.db
    .select()
    .from(schema.loanRepayments)
    .where(and(eq(schema.loanRepayments.loanId, id), isNull(schema.loanRepayments.runId), gte(schema.loanRepayments.at, cutoff)));
  if (recent.some((r) => round2(r.amount) === applied)) return row;
  const repaid = round2(row.repaid + applied);
  await deps.db.insert(schema.loanRepayments).values({ loanId: id, runId: null, amount: applied, at: new Date() });
  // No expectFrom: the DISBURSED check + dedup window above already gate this; the row exists (uuid matched).
  const updated = (await setStatus(deps, id, { repaid, ...(repaid >= row.principal ? { status: "CLOSED" } : {}) }))!;
  await audit(deps, actor, "loan.recordRepayment", "loans", id);
  return updated;
}

// ---- Payroll integration (domain PULL, mirrors bonuses/reimbursements) ----
type LoanRow = typeof schema.loans.$inferSelect;

// Installments due from an employee's DISBURSED loans this run: EMI capped at the outstanding balance (pure
// math in domain/loans.ts). The payroll build turns each into a "Loan repayment" deduction line. (Deferred:
// skip during unpaid-leave months.)
export async function dueLoanInstallments(deps: Deps, employeeId: string): Promise<{ loan: LoanRow; amount: number }[]> {
  const loans = await deps.db
    .select()
    .from(schema.loans)
    .where(and(eq(schema.loans.employeeId, employeeId), eq(schema.loans.status, "DISBURSED"), isNull(schema.loans.deleteTime)));
  return loans.map((l) => ({ loan: l, amount: installmentAmount(l) })).filter((x) => x.amount > 0.005);
}

// Idempotent rebuild: undo any repayments THIS run recorded (decrement `repaid`, reopen a loan it closed),
// then delete the ledger rows - so a re-build re-applies cleanly. Mirrors resetBonusesPaidByRun.
export async function resetLoanRepaymentsByRun(deps: Deps, runId: string): Promise<void> {
  const rows = await deps.db.select().from(schema.loanRepayments).where(eq(schema.loanRepayments.runId, runId));
  for (const r of rows) {
    const loan = (await deps.db.select().from(schema.loans).where(eq(schema.loans.uuid, r.loanId)).limit(1))[0];
    if (loan) {
      const repaid = Math.max(0, round2(loan.repaid - r.amount));
      await deps.db.update(schema.loans).set({ repaid, ...(loan.status === "CLOSED" ? { status: "DISBURSED" as const } : {}), updatedAt: new Date() }).where(eq(schema.loans.uuid, r.loanId));
    }
  }
  await deps.db.delete(schema.loanRepayments).where(eq(schema.loanRepayments.runId, runId));
}

// Record this run's loan deductions: write the ledger, advance each loan's `repaid`, CLOSE it when fully repaid,
// and announce it (loan.repaymentRecorded / loan.closed) for automations/observability. System-emitted.
export async function markLoanRepaymentsByRun(deps: Deps, entries: { loanId: string; amount: number }[], runId: string, at: Date): Promise<void> {
  for (const e of entries) {
    await deps.db.insert(schema.loanRepayments).values({ loanId: e.loanId, runId, amount: e.amount, at });
    const loan = (await deps.db.select().from(schema.loans).where(eq(schema.loans.uuid, e.loanId)).limit(1))[0];
    if (!loan) continue;
    const repaid = Math.min(loan.principal, round2(loan.repaid + e.amount));
    const closed = isFullyRepaid(loan.principal, repaid);
    await deps.db.update(schema.loans).set({ repaid, ...(closed ? { status: "CLOSED" as const } : {}), updatedAt: at }).where(eq(schema.loans.uuid, e.loanId));
    await emitEvent(deps, null, "loan.repaymentRecorded", { subject: `loans/${e.loanId}`, employeeId: loan.employeeId, payload: { amount: e.amount, outstanding: round2(loan.principal - repaid) } });
    if (closed) await emitEvent(deps, null, "loan.closed", { subject: `loans/${e.loanId}`, employeeId: loan.employeeId, payload: { principal: loan.principal } });
  }
}

export async function deleteLoan(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await softDeleteRow(deps, actor, schema.loans, "loan", "loans", id, ifMatch);
}
export async function restoreLoan(deps: Deps, actor: AppUser, id: string) {
  return restoreRow(deps, actor, schema.loans, "loan", "loans", id);
}
export async function purgeLoan(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await purgeRow(deps, actor, schema.loans, "loan", "loans", id, ifMatch);
}

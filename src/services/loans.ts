import { eq, and, isNull, gte, sql } from "drizzle-orm";
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
import { installmentAmount, isFullyRepaid, outstandingOf } from "../domain/loans";

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
import type { BatchStmt, CheckedStmt } from "../lib/dbBatch";
const MANUAL_REPAY_DEDUP_MS = 60_000; // an identical manual repayment within 60s = accidental double-submit

export async function listLoans(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, employee?: string, status?: string, showDeleted = false) {
  const conds = [applyScope(scope, schema.loans.code, schema.loans.employeeId)];
  const empId = idFromPath(employee);
  if (empId) conds.push(eq(schema.loans.employeeId, empId));
  if (status) conds.push(eq(schema.loans.status, status as Status));
  if (!showDeleted) conds.push(isNull(schema.loans.deleteTime));
  return keysetPage(deps, schema.loans, "loans", and(...conds.filter(Boolean)), { dir: "desc", max: maxPageSize, pageToken });
}


// SELF-SERVICE ONLY: a loan/advance request is always for the caller. There is no on-behalf-of path - `employee`
// is readOnly on the wire and this forces it, so no role (HR, payroll, super) can borrow in someone else's name.
// Same shape as holiday-selections: the service forces self, so `loans` carries no owner_ref for the middleware
// to gate. Everything AFTER the request (approve / reject / disburse / recordRepayment) stays an admin action.
export async function createLoan(deps: Deps, actor: AppUser, input: LoanInput, id?: string) {
  const employeeId = actor.employeeId;
  if (!employeeId) throw invalidArgument("only a user linked to an employee record can request a loan or advance");
  const asked = idFromPath(input.employee);
  if (asked && asked !== employeeId) throw invalidArgument("a loan or advance can only be requested for yourself");
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
  await deps.db.insert(schema.loanRepayments).values({ loanId: id, runId: null, amount: applied, at: new Date() });
  // Advance `repaid` by the delta in SQL (repaidCreditStmt), never by an absolute total computed from the read
  // above: a payroll build committing an installment in between would otherwise be erased, leaving the
  // employee owing an installment they already paid.
  await repaidCreditStmt(deps, id, applied, new Date());
  await audit(deps, actor, "loan.recordRepayment", "loans", id);
  return await load(deps, id);
}

// ---- Payroll integration (domain PULL, mirrors bonuses/reimbursements) ----
type LoanRow = typeof schema.loans.$inferSelect;

// Credit a repayment to a loan: advance `repaid` by the amount IN SQL and re-derive CLOSED from the result in
// the same statement. The ledger (loan_repayments) is the source of truth and `repaid` is its running total,
// so every writer moves it relatively - writing an absolute total computed from an earlier read silently
// discards any repayment committed in between (a payroll build's installment landing next to a manual
// repayment), leaving the loan owing money it has already collected. Clamped at the principal so no rounding
// path overshoots. Guarded on the loan still being collectible: one closed or soft-deleted between a build's
// read and its commit must not take another installment. Returns the UNEXECUTED statement so the payroll
// build can batch it - and check it, since a rejected credit means the payslip is deducting for a loan that
// no longer owes anything.
export function repaidCreditStmt(deps: Deps, loanId: string, amount: number, at: Date) {
  const moved = sql`round(${schema.loans.repaid} + ${amount}, 2)`;
  return deps.db
    .update(schema.loans)
    .set({
      repaid: sql`min(${schema.loans.principal}, ${moved})`,
      // Fully repaid, within the same epsilon as isFullyRepaid.
      status: sql`case when ${moved} >= ${schema.loans.principal} - 0.005 then 'CLOSED' else ${schema.loans.status} end`,
      updatedAt: at,
    })
    .where(and(eq(schema.loans.uuid, loanId), eq(schema.loans.status, "DISBURSED"), isNull(schema.loans.deleteTime)));
}

// The pay period a run is collecting for, as the installment rules need it: `periodEnd` decides whether recovery
// has started, `payDate` is the month the installment is collected in (and the date its ledger row carries).
export type LoanPeriod = { payDate?: Date | null; periodEnd?: Date | null; excludeRunId?: string };
const monthKeyOf = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

// Has recovery started by this period? A loan carries the date agreed at approval, and collecting before it
// takes money the employee was told would not be taken yet. No period (a run without one) collects as before.
function startedBy(loan: LoanRow, periodEnd?: Date | null): boolean {
  if (!loan.startDate || !periodEnd) return true;
  return +new Date(loan.startDate) <= +new Date(periodEnd);
}

// Installments due from an employee's DISBURSED loans this run: EMI capped at the outstanding balance (pure
// math in domain/loans.ts), collected only from the agreed start date and only once per calendar month. The
// payroll build turns each into a "Loan repayment" deduction line, itself capped so net can't go negative -
// which is also what stops a heavily docked (unpaid-leave) month from over-collecting.
async function dueLoanInstallments(deps: Deps, employeeId: string, period?: LoanPeriod): Promise<{ loan: LoanRow; amount: number }[]> {
  const loans = await deps.db
    .select()
    .from(schema.loans)
    .where(and(eq(schema.loans.employeeId, employeeId), eq(schema.loans.status, "DISBURSED"), isNull(schema.loans.deleteTime)));
  const collected = await collectedThisMonth(deps, period);
  return loans
    .filter((l) => startedBy(l, period?.periodEnd) && !collected.has(l.uuid))
    .map((l) => ({ loan: l, amount: installmentAmount(l) }))
    .filter((x) => x.amount > 0.005);
}

// Loans a RUN-DRIVEN repayment was already recorded against for the period's calendar month (this run's own
// rows excluded - a rebuild re-collects its own installment). An EMI is monthly: two runs whose periods fall in
// the same month (a correction run, a mid-month off-cycle run) must not each take one. Run-driven ledger rows are
// dated by their pay period (payroll.ts), so this compares like with like whenever a run was built.
async function collectedThisMonth(deps: Deps, period?: LoanPeriod): Promise<Set<string>> {
  const out = new Set<string>();
  const anchor = period?.payDate ?? period?.periodEnd;
  if (!anchor) return out;
  const from = new Date(Date.UTC(new Date(anchor).getUTCFullYear(), new Date(anchor).getUTCMonth(), 1));
  const key = monthKeyOf(new Date(anchor));
  for (const r of await deps.db.select().from(schema.loanRepayments).where(gte(schema.loanRepayments.at, from))) {
    if (!r.runId || r.runId === period?.excludeRunId) continue; // manual repayments don't stand in for the EMI
    if (monthKeyOf(new Date(r.at)) === key) out.add(r.loanId);
  }
  return out;
}

// An exiting employee's still-collectible loans and what each still owes. The FnF settlement recovers the
// WHOLE outstanding (not one installment): after the exit transition the employee is in no payroll run, so
// the final settlement is the last chance to recover the balance.
export async function outstandingLoans(deps: Deps, employeeId: string): Promise<{ uuid: string; kind: string; outstanding: number }[]> {
  const loans = await deps.db
    .select()
    .from(schema.loans)
    .where(and(eq(schema.loans.employeeId, employeeId), eq(schema.loans.status, "DISBURSED"), isNull(schema.loans.deleteTime)));
  return loans
    .map((l) => ({ uuid: l.uuid, kind: l.kind, outstanding: outstandingOf(l) }))
    .filter((l) => l.outstanding > 0.005);
}

// Every employee's due installments in one read, keyed by employee - the run build's shape (one select for
// the whole org instead of one per employee, to stay inside the per-invocation subrequest budget). Same two
// period rules as dueLoanInstallments: recovery must have started by the period, and one EMI per calendar month.
export async function dueLoanInstallmentsAll(deps: Deps, period?: LoanPeriod): Promise<Map<string, { loan: LoanRow; amount: number }[]>> {
  const loans = await deps.db.select().from(schema.loans).where(and(eq(schema.loans.status, "DISBURSED"), isNull(schema.loans.deleteTime)));
  const collected = await collectedThisMonth(deps, period);
  const out = new Map<string, { loan: LoanRow; amount: number }[]>();
  for (const l of loans) {
    if (!startedBy(l, period?.periodEnd) || collected.has(l.uuid)) continue;
    const amount = installmentAmount(l);
    if (amount <= 0.005) continue;
    const arr = out.get(l.employeeId);
    if (arr) arr.push({ loan: l, amount });
    else out.set(l.employeeId, [{ loan: l, amount }]);
  }
  return out;
}

// Every employee's still-outstanding disbursed loans in one read, keyed by employee. Feeds the payroll build's
// interest-concession perquisite (domain/loans.ts), which values the whole outstanding balance, not one EMI.
export async function outstandingLoansAll(deps: Deps): Promise<Map<string, LoanRow[]>> {
  const loans = await deps.db.select().from(schema.loans).where(and(eq(schema.loans.status, "DISBURSED"), isNull(schema.loans.deleteTime)));
  const out = new Map<string, LoanRow[]>();
  for (const l of loans) {
    if (outstandingOf(l) <= 0.005) continue;
    const arr = out.get(l.employeeId);
    if (arr) arr.push(l);
    else out.set(l.employeeId, [l]);
  }
  return out;
}

// Idempotent rebuild: undo any repayments THIS run recorded (re-derive `repaid`, reopen a loan it closed),
// then delete the ledger rows - so a re-build re-applies cleanly. Mirrors resetBonusesPaidByRun. Split into
// a read half and a statement half so the build can fold the writes into its atomic reset batch: the one
// read here (the run's ledger rows) is a single subrequest however many loans are involved - the balances
// go through recomputeRepaidStmt, which needs no loan read because it re-sums the ledger in SQL.
export async function resetLoanRepaymentStmts(deps: Deps, runId: string): Promise<BatchStmt[]> {
  const rows = await deps.db.select().from(schema.loanRepayments).where(eq(schema.loanRepayments.runId, runId));
  const stmts: BatchStmt[] = [];
  // A loan can have at most one ledger row per run, but sum defensively.
  const decrement = new Map<string, number>();
  for (const r of rows) decrement.set(r.loanId, round2((decrement.get(r.loanId) ?? 0) + r.amount));
  const at = new Date();
  for (const loanId of decrement.keys()) stmts.push(recomputeRepaidStmt(deps, loanId, at, runId));
  stmts.push(deps.db.delete(schema.loanRepayments).where(eq(schema.loanRepayments.runId, runId)));
  return stmts;
}

// Re-derive a loan's `repaid` from the ledger, ignoring the rows this run wrote (deleted in the same batch).
// `repaid` is by definition the running total of loan_repayments, so recomputing it is exact whatever state
// the row is in. Subtracting the run's ledger amounts instead would be wrong in one real case: the build's
// increment is guarded on the loan still being collectible while its ledger row is not, so a build that lost
// that race wrote a ledger row without ever advancing `repaid` - and the subtraction would then wipe out an
// installment the employee actually paid.
// `exceptRunId` omitted = re-derive from the WHOLE ledger (used after a settlement's repayment rows are
// deleted); passed = ignore that run's rows too, since they are deleted in the same batch.
export function recomputeRepaidStmt(deps: Deps, loanId: string, at: Date, exceptRunId?: string) {
  const scoped = exceptRunId
    ? sql`and (${schema.loanRepayments.runId} is null or ${schema.loanRepayments.runId} <> ${exceptRunId})`
    : sql``;
  const total = sql`round((select coalesce(sum(${schema.loanRepayments.amount}), 0) from ${schema.loanRepayments} where ${schema.loanRepayments.loanId} = ${loanId} ${scoped}), 2)`;
  return deps.db
    .update(schema.loans)
    .set({
      repaid: sql`max(0, min(${schema.loans.principal}, ${total}))`,
      status: sql`case when ${total} >= ${schema.loans.principal} - 0.005 then 'CLOSED' when ${schema.loans.status} = 'CLOSED' then 'DISBURSED' else ${schema.loans.status} end`,
      updatedAt: at,
    })
    .where(eq(schema.loans.uuid, loanId));
}

// Record this run's loan deductions: write the ledger, advance each loan's `repaid`, CLOSE it when fully
// repaid. Returns the UNEXECUTED statements plus the events to announce (loan.repaymentRecorded /
// loan.closed) - the caller batches the statements atomically with the rest of the build, then emits the
// events only after the batch commits, so an aborted build never announces a repayment that didn't land.
// `loans` are the rows the caller already holds (dueLoanInstallmentsAll) - no reads here.
export function loanRepaymentWrites(
  deps: Deps,
  loans: Map<string, LoanRow>,
  entries: { loanId: string; amount: number }[],
  runId: string,
  at: Date,
): { stmts: (BatchStmt | CheckedStmt)[]; events: { type: "loan.repaymentRecorded" | "loan.closed"; loanId: string; employeeId: string; payload: Record<string, number> }[] } {
  const stmts: (BatchStmt | CheckedStmt)[] = [];
  const events: ReturnType<typeof loanRepaymentWrites>["events"] = [];
  for (const e of entries) {
    const loan = loans.get(e.loanId);
    if (!loan) continue;
    stmts.push(deps.db.insert(schema.loanRepayments).values({ loanId: e.loanId, runId, amount: e.amount, at }));
    const repaid = Math.min(loan.principal, round2(loan.repaid + e.amount));
    const closed = isFullyRepaid(loan.principal, repaid);
    // Checked: the deduction is already on the payslip, so if the loan stopped being collectible between the
    // caller's read and this batch (closed by a manual repayment, soft-deleted), the caller must undo the
    // whole build rather than deduct from an employee for a loan that is no longer owed.
    stmts.push({ stmt: repaidCreditStmt(deps, e.loanId, e.amount, at).returning({ uuid: schema.loans.uuid }), expect: 1, label: `loan ${loan.code}` });
    events.push({ type: "loan.repaymentRecorded", loanId: e.loanId, employeeId: loan.employeeId, payload: { amount: e.amount, outstanding: round2(loan.principal - repaid) } });
    if (closed) events.push({ type: "loan.closed", loanId: e.loanId, employeeId: loan.employeeId, payload: { principal: loan.principal } });
  }
  return { stmts, events };
}


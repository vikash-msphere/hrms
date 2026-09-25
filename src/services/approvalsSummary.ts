import { and, eq, isNull, ne, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import * as schema from "../db/schema";
import { applyScope } from "./listScope";
import { APPROVAL_QUEUES } from "../domain/approvalsSummary";
import type { ListScope } from "../domain/access";
import type { Deps } from "../deps";

// How many things are waiting for MY decision, per queue: one request, one D1 batch, numbers only. It replaces
// the SPA reading all ten approval collections (a 200-row page each) on every page load just to render one
// badge - the rows themselves are still fetched, but only by the pages that actually show them.
//
// NO ACCESS CONTROL HERE. The middleware already decided, per queue, whether the caller may APPROVE anything
// in it and at what breadth, and handed the answers over on `approvalScopes` (collection -> ListScope) - the
// same decide()/scope pair a real `POST /v1/<collection>/<id>:approve` gets. A queue absent from the map
// contributes no count, so a caller who cannot approve in it never learns it has rows.
//
// PARITY. Each count's WHERE mirrors its collection's own list binding (applyScope over the same code/owner
// columns, plus the soft-delete filter where the table has one) and the awaiting state the SPA used to filter
// on client-side, so the badge equals what the Approvals inbox lists.

const count = sql<number>`count(*)`;
const conds = (...parts: (SQL | undefined)[]) => and(...(parts.filter(Boolean) as SQL[]));

// One COUNT statement per queue, keyed by collection. `awaiting` comes from the domain registry (each
// collection's own word for "not yet decided"), so a queue is defined in exactly two places: there and here.
// `exclude` is the caller's own employee id when they may not decide their own requests (services/
// decisionGuard.ts): those rows are waiting for somebody else, and the badge counts what is waiting for THEM.
function builders(deps: Deps, exclude: string | null): Record<string, (scope: ListScope, awaiting: string) => unknown> {
  const db = deps.db;
  const t = schema;
  const notMine = (col: SQLiteColumn) => (exclude ? ne(col, exclude) : undefined);
  return {
    "leave-requests": (s, a) =>
      db.select({ value: count }).from(t.leaveRequests).where(conds(applyScope(s, t.leaveRequests.code, t.leaveRequests.employeeId), eq(t.leaveRequests.state, a as "PENDING"), notMine(t.leaveRequests.employeeId))),
    reimbursements: (s, a) =>
      db.select({ value: count }).from(t.reimbursements).where(conds(applyScope(s, t.reimbursements.code, t.reimbursements.employeeId), eq(t.reimbursements.state, a as "PENDING"), notMine(t.reimbursements.employeeId))),
    "overtime-requests": (s, a) =>
      db.select({ value: count }).from(t.overtimeRequests).where(conds(applyScope(s, t.overtimeRequests.code, t.overtimeRequests.employeeId), eq(t.overtimeRequests.state, a as "PENDING"), notMine(t.overtimeRequests.employeeId))),
    "remote-work-requests": (s, a) =>
      db.select({ value: count }).from(t.remoteWorkRequests).where(conds(applyScope(s, t.remoteWorkRequests.code, t.remoteWorkRequests.employeeId), eq(t.remoteWorkRequests.state, a as "PENDING"), notMine(t.remoteWorkRequests.employeeId))),
    "late-early-requests": (s, a) =>
      db.select({ value: count }).from(t.lateEarlyRequests).where(conds(applyScope(s, t.lateEarlyRequests.code, t.lateEarlyRequests.employeeId), eq(t.lateEarlyRequests.state, a as "PENDING"), notMine(t.lateEarlyRequests.employeeId))),
    "attendance-regularizations": (s, a) =>
      db.select({ value: count }).from(t.attendanceRegularizations).where(conds(applyScope(s, t.attendanceRegularizations.code, t.attendanceRegularizations.employeeId), eq(t.attendanceRegularizations.state, a as "PENDING"), notMine(t.attendanceRegularizations.employeeId))),
    "leave-encashments": (s, a) =>
      db.select({ value: count }).from(t.leaveEncashments).where(conds(applyScope(s, t.leaveEncashments.code, t.leaveEncashments.employeeId), eq(t.leaveEncashments.state, a as "PENDING"), notMine(t.leaveEncashments.employeeId))),
    // Soft-deletable, so the deleted rows leave the queue the same way they leave the list.
    loans: (s, a) =>
      db.select({ value: count }).from(t.loans).where(conds(applyScope(s, t.loans.code, t.loans.employeeId), eq(t.loans.status, a as "PENDING"), isNull(t.loans.deleteTime), notMine(t.loans.employeeId))),
    "time-entries": (s, a) =>
      db.select({ value: count }).from(t.timeEntries).where(conds(applyScope(s, t.timeEntries.code, t.timeEntries.employeeId), eq(t.timeEntries.status, a as "SUBMITTED"), isNull(t.timeEntries.deleteTime), notMine(t.timeEntries.employeeId))),
    // A recurring expense is the TEMPLATE the cron raises real claims from; it is never itself approved.
    expenses: (s, a) =>
      db.select({ value: count }).from(t.expenses).where(conds(applyScope(s, t.expenses.code, t.expenses.employeeId), eq(t.expenses.state, a as "SUBMITTED"), eq(t.expenses.isRecurring, false), notMine(t.expenses.employeeId))),
    "asset-requests": (s, a) =>
      db.select({ value: count }).from(t.assetRequests).where(conds(applyScope(s, t.assetRequests.code, t.assetRequests.employeeId), eq(t.assetRequests.state, a as "PENDING"), notMine(t.assetRequests.employeeId))),
  };
}

export type ApprovalsSummary = { counts: Record<string, number>; total: number };

// `taxVerifications` is the prior-employer verification queue: not a collection, so the middleware passes a
// plain allowed/not (the same `tax-verifications.read` its own endpoint needs) instead of a scope. It counts
// off the plaintext status column, so nothing is decrypted to answer a badge.
export async function approvalsSummary(deps: Deps, scopes: Map<string, ListScope>, taxVerifications: boolean, exclude: string | null = null): Promise<ApprovalsSummary> {
  const build = builders(deps, exclude);
  const queues = APPROVAL_QUEUES.filter((q) => scopes.has(q.collection));
  const keys: string[] = queues.map((q) => q.collection);
  const stmts: unknown[] = queues.map((q) => build[q.collection]!(scopes.get(q.collection)!, q.awaiting));
  if (taxVerifications) {
    keys.push("tax-verifications");
    stmts.push(
      deps.db
        .select({ value: count })
        .from(schema.employees)
        .where(conds(eq(schema.employees.taxVerificationStatus, "DECLARED"), isNull(schema.employees.deleteTime))),
    );
  }
  if (!stmts.length) return { counts: {}, total: 0 };
  const results =
    stmts.length === 1
      ? [await (stmts[0] as PromiseLike<unknown>)]
      : ((await deps.db.batch(stmts as unknown as Parameters<typeof deps.db.batch>[0])) as unknown as unknown[]);
  const counts: Record<string, number> = {};
  let total = 0;
  keys.forEach((key, i) => {
    const row = (results[i] as { value: number }[])[0];
    const value = Number(row?.value ?? 0);
    counts[key] = value;
    total += value;
  });
  return { counts, total };
}

// Per-employee metrics for scheduled `perEmployee` automations. The pure condition evaluator can't query the
// database, so a scheduled firing carries these precomputed numbers in its payload - letting a data-defined
// rule be genuinely smart ("every Monday, if pendingApprovals > 0 -> nudge the manager") without teaching the
// evaluator to aggregate. Computed once per tick in a bounded set of full-table reads (daily cadence, D1).
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";

export type EmployeeMetrics = {
  pendingApprovals: number; // requests awaiting THIS employee's decision (as the requester's manager)
  daysSinceLastLeave: number; // days since their last approved leave ended (NEVER if they've taken none)
  leaveBalanceDays: number; // total leave balance across all types
};

// Sentinel for "has never taken leave" - large enough that `daysSinceLastLeave >= N` style thresholds fire.
export const NEVER_TAKEN_LEAVE = 100_000;

export async function computeEmployeeMetrics(
  deps: Deps,
  employees: { uuid: string; managerId: string | null }[],
): Promise<Map<string, EmployeeMetrics>> {
  const managerOf = new Map(employees.map((e) => [e.uuid, e.managerId]));
  const metrics = new Map<string, EmployeeMetrics>();
  for (const e of employees) metrics.set(e.uuid, { pendingApprovals: 0, daysSinceLastLeave: NEVER_TAKEN_LEAVE, leaveBalanceDays: 0 });

  // Pending approvals: every request awaiting a decision counts against its requester's manager.
  const bump = (requesterId: string) => {
    const mgr = managerOf.get(requesterId);
    const m = mgr ? metrics.get(mgr) : undefined;
    if (m) m.pendingApprovals++;
  };
  const pendingSets = await Promise.all([
    deps.db.select({ e: schema.leaveRequests.employeeId }).from(schema.leaveRequests).where(eq(schema.leaveRequests.state, "PENDING")),
    deps.db.select({ e: schema.reimbursements.employeeId }).from(schema.reimbursements).where(eq(schema.reimbursements.state, "PENDING")),
    deps.db.select({ e: schema.overtimeRequests.employeeId }).from(schema.overtimeRequests).where(eq(schema.overtimeRequests.state, "PENDING")),
    deps.db.select({ e: schema.remoteWorkRequests.employeeId }).from(schema.remoteWorkRequests).where(eq(schema.remoteWorkRequests.state, "PENDING")),
    deps.db.select({ e: schema.attendanceRegularizations.employeeId }).from(schema.attendanceRegularizations).where(eq(schema.attendanceRegularizations.state, "PENDING")),
    deps.db.select({ e: schema.loans.employeeId }).from(schema.loans).where(eq(schema.loans.status, "PENDING")),
  ]);
  for (const set of pendingSets) for (const r of set) bump(r.e);

  // Total leave balance per employee.
  const balances = await deps.db.select({ e: schema.leaveBalances.employeeId, b: schema.leaveBalances.balanceDays }).from(schema.leaveBalances);
  for (const row of balances) { const m = metrics.get(row.e); if (m) m.leaveBalanceDays += row.b; }

  // Days since last approved leave ended.
  const approved = await deps.db.select({ e: schema.leaveRequests.employeeId, end: schema.leaveRequests.endDate }).from(schema.leaveRequests).where(eq(schema.leaveRequests.state, "APPROVED"));
  const lastEnd = new Map<string, number>();
  for (const r of approved) { const t = +new Date(r.end); const cur = lastEnd.get(r.e); if (cur === undefined || t > cur) lastEnd.set(r.e, t); }
  const now = +deps.clock.now();
  for (const [e, t] of lastEnd) { const m = metrics.get(e); if (m) m.daysSinceLastLeave = Math.max(0, Math.floor((now - t) / 86_400_000)); }

  for (const m of metrics.values()) m.leaveBalanceDays = Math.round(m.leaveBalanceDays * 100) / 100;
  return metrics;
}

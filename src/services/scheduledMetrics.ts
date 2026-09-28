// Per-employee metrics for scheduled `perEmployee` automations. The pure condition evaluator can't query the
// database, so a scheduled firing carries these precomputed numbers in its payload - letting a data-defined
// rule be genuinely smart ("every Monday, if pendingApprovals > 0 -> nudge the manager") without teaching the
// evaluator to aggregate. Computed once per tick in a bounded set of full-table reads (daily cadence, D1).
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { goalPace, staleDays, STALE_AFTER_DAYS } from "../domain/goals";
import { round2 } from "../domain/money";
import type { Deps } from "../deps";

export type EmployeeMetrics = {
  pendingApprovals: number; // requests awaiting THIS employee's decision (as the requester's manager)
  daysSinceLastLeave: number; // days since their last approved leave ended (NEVER if they've taken none)
  leaveBalanceDays: number; // total leave balance across all types
  goalsDueSoon: number; // open goals due within the next 7 days
  goalsOverdue: number; // open goals past their due date
  goalsAtRisk: number; // open goals a quarter of the way behind their own pace, or the owner says are slipping
  goalsStale: number; // open goals nobody has touched in three weeks
  // Board work, counted the way the person doing it experiences it: assigned to them, not yet delivered.
  tasksDueSoon: number; // open cards assigned to them, due within the next 7 days
  tasksOverdue: number; // open cards assigned to them, past their due date
  tasksBlocked: number; // open cards assigned to them, flagged blocked
  // Review season. A cycle's deadlines were stored and rendered and read by nothing that tells anybody, so
  // the whole thing ran on whoever remembered to chase it.
  selfReviewsDue: number; // their own reviews awaiting their self-assessment, in an ACTIVE cycle
  teamReviewsDue: number; // reviews of their reports awaiting THEIR write-up
  goalSettingMissing: number; // 1 when an ACTIVE cycle wants goals by a date and they have none in it
  teamGoalSettingMissing: number; // how many of their reports are in that position
  appPinMissing: number; // 1 when their active sign-in account has no app PIN
};

const ZERO: Omit<EmployeeMetrics, "daysSinceLastLeave"> = {
  pendingApprovals: 0, leaveBalanceDays: 0,
  goalsDueSoon: 0, goalsOverdue: 0, goalsAtRisk: 0, goalsStale: 0,
  tasksDueSoon: 0, tasksOverdue: 0, tasksBlocked: 0,
  selfReviewsDue: 0, teamReviewsDue: 0, goalSettingMissing: 0, teamGoalSettingMissing: 0,
  appPinMissing: 0,
};

// Sentinel for "has never taken leave" - large enough that `daysSinceLastLeave >= N` style thresholds fire.
export const NEVER_TAKEN_LEAVE = 100_000;

export async function computeEmployeeMetrics(
  deps: Deps,
  employees: { uuid: string; managerId: string | null }[],
): Promise<Map<string, EmployeeMetrics>> {
  const managerOf = new Map(employees.map((e) => [e.uuid, e.managerId]));
  const metrics = new Map<string, EmployeeMetrics>();
  for (const e of employees) metrics.set(e.uuid, { ...ZERO, daysSinceLastLeave: NEVER_TAKEN_LEAVE });

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
    // `loans` is the one queue here that soft-deletes, and a deleted request is not sitting in anybody's
    // approval pile - the same rule the card read below follows with `isNull(delete_time)`. The other five
    // carry no `delete_time` at all, so their state column is the whole of their lifecycle.
    deps.db.select({ e: schema.loans.employeeId }).from(schema.loans).where(and(eq(schema.loans.status, "PENDING"), isNull(schema.loans.deleteTime))),
  ]);
  for (const set of pendingSets) for (const r of set) bump(r.e);

  // Total leave balance per employee.
  const balances = await deps.db.select({ e: schema.leaveBalances.employeeId, b: schema.leaveBalances.balanceDays }).from(schema.leaveBalances);
  for (const row of balances) { const m = metrics.get(row.e); if (m) m.leaveBalanceDays += row.b; }

  // Days since last approved leave ended. AGGREGATED IN SQL: the answer is one date per employee, and this
  // used to read every approved leave request the org had ever granted in order to take a max over them in
  // JS - a read bill that grows with history for a number that does not.
  const lastLeaveEnd = await deps.db
    .select({ e: schema.leaveRequests.employeeId, end: sql<number>`max(${schema.leaveRequests.endDate})` })
    .from(schema.leaveRequests)
    .where(eq(schema.leaveRequests.state, "APPROVED"))
    .groupBy(schema.leaveRequests.employeeId);
  const now = +deps.clock.now();
  for (const r of lastLeaveEnd) {
    const m = metrics.get(r.e);
    if (m && r.end != null) m.daysSinceLastLeave = Math.max(0, Math.floor((now - +new Date(r.end)) / 86_400_000));
  }

  // Goal pressure: due-date proximity, and the two signals that arrive EARLIER than a missed date - a goal
  // behind its own pace (or flagged by its owner), and a goal nobody has said anything about for weeks. A rule
  // that can only fire on "overdue" can only ever chase a goal that has already been missed.
  //
  // ONE pass over the goals table for the whole function. `cycleId` rides along because the goal-setting
  // season count further down needs it, and reading every goal in the org twice in one tick to answer two
  // questions about the same rows is a read bill (and a duration) paid for nothing.
  const allGoals = await deps.db
    .select({
      e: schema.goals.employeeId, due: schema.goals.dueDate, status: schema.goals.status, del: schema.goals.deleteTime,
      progress: schema.goals.progress, confidence: schema.goals.confidence, createdAt: schema.goals.createdAt, updatedAt: schema.goals.updatedAt,
      cycle: schema.goals.cycleId,
    })
    .from(schema.goals)
    // Both readers of `allGoals` skip a soft-deleted row anyway, so the filter belongs in SQL rather than
    // being paid for in rows read and then discarded.
    .where(isNull(schema.goals.deleteTime));
  const weekOut = now + 7 * 86_400_000;
  for (const g of allGoals) {
    if (g.del || (g.status !== "not_started" && g.status !== "in_progress")) continue;
    const m = metrics.get(g.e);
    if (!m) continue;
    if (g.due) {
      const t = +g.due;
      if (t < now) m.goalsOverdue++;
      else if (t <= weekOut) m.goalsDueSoon++;
    }
    const pace = goalPace(g, now);
    if (pace?.state === "at_risk" || g.confidence === "at_risk" || g.confidence === "off_track") m.goalsAtRisk++;
    // Comments are not read here: this runs over every goal in the org on a schedule, and one extra full-table
    // read for a weekly nudge is not worth it. A goal being commented on moves nothing on the row, so the
    // count is a slight over-report of silence - the digest says "check on these", not "these are abandoned".
    const stale = staleDays(g, null, now);
    if (stale != null && stale >= STALE_AFTER_DAYS) m.goalsStale++;
  }

  // Board work, counted off the ASSIGNEE rather than the card's owner: a task is chased out of the queue it
  // is actually sitting in, and those two people are frequently not the same one. Delivered cards drop out
  // whole - a card sitting in a done column past its due date is finished work, not a missed deadline.
  const cards = await deps.db
    .select({ a: schema.cards.assigneeId, due: schema.cards.dueDate, delivered: schema.cards.deliveredAt, blocked: schema.cards.blocked })
    .from(schema.cards)
    .where(isNull(schema.cards.deleteTime));
  for (const c of cards) {
    if (!c.a || c.delivered) continue;
    const m = metrics.get(c.a);
    if (!m) continue;
    // Blocked is counted separately from lateness rather than folded into it: a blocked task is somebody
    // else's move, and the nudge that helps is aimed at the manager, not at the person who is stuck.
    if (c.blocked) m.tasksBlocked++;
    if (c.due) {
      const t = +c.due;
      if (t < now) m.tasksOverdue++;
      else if (t <= weekOut) m.tasksDueSoon++;
    }
  }

  // Review season. Only ACTIVE cycles count: a DRAFT cycle is HR still building it, and a CLOSED one is over.
  const activeCycles = await deps.db
    .select({ uuid: schema.reviewCycles.uuid, goalSettingDue: schema.reviewCycles.goalSettingDueDate })
    .from(schema.reviewCycles)
    .where(and(eq(schema.reviewCycles.state, "ACTIVE"), isNull(schema.reviewCycles.deleteTime)));
  if (activeCycles.length) {
    const activeIds = new Set(activeCycles.map((c) => c.uuid));
    // Who owes what is exactly the review's own state: SELF is the employee's to write, MANAGER is the
    // reviewer's. SHARED and ACKNOWLEDGED owe nobody anything.
    // Narrowed to the ACTIVE cycles in SQL. Read whole, this was every review of every cycle the org has ever
    // run, discarded down to the current season in JS - and reviews are the collection that grows fastest,
    // one row per person per cycle forever. `activeIds` is a handful, so it stays inside the parameter cap.
    const reviews = await deps.db
      .select({ e: schema.reviews.employeeId, cycle: schema.reviews.cycleId, state: schema.reviews.state, reviewer: schema.reviews.reviewerId })
      .from(schema.reviews)
      .where(inArray(schema.reviews.cycleId, [...activeIds]));
    for (const r of reviews) {
      if (!activeIds.has(r.cycle)) continue;
      if (r.state === "SELF") {
        const m = metrics.get(r.e);
        if (m) m.selfReviewsDue++;
      } else if (r.state === "MANAGER") {
        // The assigned reviewer where there is one, else the manager chain - so a review handed to somebody
        // else is chased at the person who actually owes it (see services/reviews.ts#reviewerIdOf).
        const owes = r.reviewer ?? managerOf.get(r.e);
        const m = owes ? metrics.get(owes) : undefined;
        if (m) m.teamReviewsDue++;
      }
    }

    // Goal-setting season: a cycle that names a date by which goals are supposed to exist, and somebody who
    // has filed none against it. A cycle being ACTIVE is the org's own statement that its season has started,
    // so no second threshold is invented here - and the count stops the moment they write one goal.
    const cyclesWantingGoals = activeCycles.filter((c) => c.goalSettingDue).map((c) => c.uuid);
    if (cyclesWantingGoals.length) {
      const wanting = new Set(cyclesWantingGoals);
      const filed = new Set<string>();
      for (const g of allGoals) {
        // A cancelled goal is not a goal they set: leaving it in would let one called-off goal answer the
        // whole season.
        if (g.del || !g.cycle || !wanting.has(g.cycle) || g.status === "cancelled") continue;
        filed.add(`${g.e}\u0000${g.cycle}`);
      }
      for (const [id, m] of metrics) {
        const missing = cyclesWantingGoals.filter((cycle) => !filed.has(`${id}\u0000${cycle}`)).length;
        if (!missing) continue;
        m.goalSettingMissing = missing;
        const mgr = managerOf.get(id);
        const mm = mgr ? metrics.get(mgr) : undefined;
        if (mm) mm.teamGoalSettingMissing++;
      }
    }
  }

  // App lock: 1 when an active sign-in account linked to them has no PIN - no lock row at all, or one whose PIN
  // was turned off or reset. Somebody with no active account stays 0: they cannot sign in to set one.
  const pinless = await deps.db
    .select({ e: schema.users.employeeId })
    .from(schema.users)
    .leftJoin(schema.appLocks, eq(schema.appLocks.userId, schema.users.uuid))
    .where(and(eq(schema.users.status, "active"), isNotNull(schema.users.employeeId), isNull(schema.appLocks.pinHash)));
  for (const r of pinless) { const m = r.e ? metrics.get(r.e) : undefined; if (m) m.appPinMissing = 1; }

  // `round2`, not an inline `Math.round(n * 100) / 100`. Leave-day values sit under the same rounding rule as
  // money (domain/money.ts is the one helper for both), and the inline form multiplies in float, so a decimal
  // half-case rounds the wrong way - 12.005 scores 12.00 here and 12.01 everywhere else. These figures decide
  // workflow conditions and what a digest reports, so the two must not disagree.
  for (const m of metrics.values()) m.leaveBalanceDays = round2(m.leaveBalanceDays);
  return metrics;
}

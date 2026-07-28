import { allocOwnedCode } from "./codeAlloc";
// WORKFLOW resource template (custom methods :approve/:reject/:cancel).
import { eq, and, gte, sql } from "drizzle-orm";
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
import { leaveDays } from "../domain/leave";
import { getSettingValue } from "./settings";
import { DEFAULT_ATTENDANCE, type AttendanceConfig } from "../domain/attendance";

// Holidays (UTC YYYY-MM-DD) in [startMs, endMs] - the days leave shouldn't count. Mirrors the payroll/LOP set:
// non-deleted, non-disabled holidays of any kind.
async function holidaysInRange(deps: Deps, startMs: number, endMs: number): Promise<Set<string>> {
  return new Set(
    (await deps.db.select().from(schema.holidays))
      .filter((h) => !h.deleteTime && !h.disabled && +new Date(h.date) >= startMs && +new Date(h.date) <= endMs)
      .map((h) => new Date(h.date).toISOString().slice(0, 10)),
  );
}

export type LeaveRequestInput = {
  employee?: string | null;
  leave_type?: string | null;
  start_date?: string; // YYYY-MM-DD
  end_date?: string;
  start_session?: number; // 1 = first half (AM), 2 = second half (PM); leave begins this session of start_date
  end_session?: number; // 1 = first half (AM), 2 = second half (PM); leave ends this session of end_date
  reason?: string | null;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string) => (s ? Date.parse(s + "T00:00:00Z") : NaN);

// Org leave-request policy (generic settings key "leave-requests"). Default preserves the prior behaviour
// (back-dating allowed); HR can turn it off in Settings.
export const DEFAULT_LEAVE_REQUEST_CONFIG = { allow_backdated: true };

export async function listLeaveRequests(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, stateFilter?: string, q?: string) {
  // Visibility was decided in the middleware (scopeFor over the grant); here we only bind it to columns.
  const conds = [applyScope(scope, schema.leaveRequests.code, schema.leaveRequests.employeeId)];
  // Server-side text filter (FTS). Narrows the scope above; it can never widen it.
  const textMatch = await searchFilter(deps, "leave-requests", q, schema.leaveRequests.uuid);
  if (textMatch) conds.push(textMatch);
  if (stateFilter) conds.push(eq(schema.leaveRequests.state, stateFilter as typeof schema.leaveRequests.$inferSelect.state));
  // SQL-side keyset pagination (DB orders + LIMITs) so an all-scope list never loads the whole table.
  return keysetPage(deps, schema.leaveRequests, "leave-requests", and(...conds.filter(Boolean)), { dir: "asc", max: maxPageSize, pageToken });
}

export async function getLeaveRequest(deps: Deps, _actor: AppUser, id: string) {
  // Read access (own / dept / all) is enforced by the middleware on leave-requests/<code>.
  const row = (await deps.db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.uuid, id)).limit(1))[0];
  if (!row) throw notFound("leave request not found");
  return row;
}

export async function createLeaveRequest(deps: Deps, actor: AppUser, input: LeaveRequestInput) {
  const start = dayMs(input.start_date);
  const end = dayMs(input.end_date);
  if (!input.leave_type || Number.isNaN(start) || Number.isNaN(end)) throw invalidArgument("leave_type, start_date, end_date are required");
  if (end < start) throw invalidArgument("end_date must be on or after start_date");
  const startSession = input.start_session === 2 ? 2 : 1;
  const endSession = input.end_session === 1 ? 1 : 2;
  // On a single day the leave can't end before it begins (afternoon-start + morning-end is empty).
  if (start === end && startSession > endSession) throw invalidArgument("the start session must be on or before the end session");
  // Default the employee to the caller's own employee record unless an admin specifies one.
  const employeeId = idFromPath(input.employee) ?? actor.employeeId;
  if (!employeeId) throw invalidArgument("employee is required");

  // Back-dated requests: gated by the org policy toggle, but only for self-service. HR acting on behalf of
  // someone else (input.employee set to another person) can always back-date, e.g. to record past leave.
  const onBehalf = !!idFromPath(input.employee) && idFromPath(input.employee) !== actor.employeeId;
  if (!onBehalf) {
    const { allow_backdated } = await getSettingValue(deps, "leave-requests", DEFAULT_LEAVE_REQUEST_CONFIG);
    if (!allow_backdated) {
      const todayMs = dayMs(new Date(+deps.clock.now()).toISOString().slice(0, 10));
      if (start < todayMs) throw failedPrecondition("back-dated leave requests aren't allowed - pick today or a future date");
    }
  }

  // No overlapping leave for the same person (including self): a new request can't intersect an existing
  // PENDING/APPROVED leave for this employee. Half-day sessions are respected by mapping each endpoint to a
  // half-day slot, so a morning-ending leave can still abut an afternoon-starting one on the same day.
  const slotOf = (ms: number, session: number) => Math.round(ms / 86_400_000) * 2 + (session === 2 ? 1 : 0);
  const newStartSlot = slotOf(start, startSession);
  const newEndSlot = slotOf(end, endSession);
  const activeForEmployee = (await deps.db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.employeeId, employeeId)))
    .filter((r) => r.state === "PENDING" || r.state === "APPROVED");
  for (const r of activeForEmployee) {
    if (newStartSlot <= slotOf(+new Date(r.endDate), r.endSession) && slotOf(+new Date(r.startDate), r.startSession) <= newEndSlot) {
      throw failedPrecondition("this overlaps an existing leave request for these dates");
    }
  }

  // A disabled (or deleted) leave type can't be used for new requests.
  const leaveTypeId = idFromPath(input.leave_type)!;
  const lt = (await deps.db.select().from(schema.leaveTypes).where(eq(schema.leaveTypes.uuid, leaveTypeId)).limit(1))[0];
  if (!lt || lt.deleteTime || lt.disabled) throw invalidArgument("that leave type is unavailable");
  // Probation policy. A request "during probation" is one whose leave starts on or before probation end.
  const emp = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
  const probationEndMs = emp?.probationEndDate ? +new Date(emp.probationEndDate) : null;
  const duringProbation = probationEndMs !== null && start <= probationEndMs;
  if (duringProbation && !lt.availableDuringProbation) throw failedPrecondition("that leave type is not available during probation");

  // Chargeable days = configured working days in the range, minus holidays, honoring the start/end sessions.
  const att = await getSettingValue<AttendanceConfig>(deps, "attendance", DEFAULT_ATTENDANCE);
  const holidays = await holidaysInRange(deps, start, end);
  const days = leaveDays(start, end, startSession, endSession, att.work_days, holidays);
  if (days <= 0) throw invalidArgument("no working days in the selected range (weekends and holidays aren't counted) - pick a working day");

  // Balance check: a paid (entitlement-tracked) leave type can't be drawn below zero. The balance is reserved
  // at request time, so it already nets out earlier pending/approved requests. Unpaid types aren't balance-
  // limited. (idFromPath strips deleted/disabled types above.)
  if (lt.paid) {
    const bal = (await deps.db.select().from(schema.leaveBalances).where(and(eq(schema.leaveBalances.employeeId, employeeId), eq(schema.leaveBalances.leaveTypeId, leaveTypeId))).limit(1))[0];
    const available = bal?.balanceDays ?? 0;
    if (days > available + 1e-9) {
      throw failedPrecondition(`not enough ${lt.name} balance: requested ${days} day(s) but only ${available} available`);
    }
  }

  // Probation usage cap: total days of this type TAKEN during probation may not exceed probationCapDays.
  if (duringProbation && lt.probationCapDays != null) {
    const prior = (await deps.db.select().from(schema.leaveRequests).where(and(eq(schema.leaveRequests.employeeId, employeeId), eq(schema.leaveRequests.leaveTypeId, leaveTypeId))))
      .filter((r) => (r.state === "PENDING" || r.state === "APPROVED") && +new Date(r.startDate) <= probationEndMs!);
    const used = prior.reduce((s, r) => s + r.days, 0);
    if (used + days > lt.probationCapDays + 1e-9) {
      throw failedPrecondition(`exceeds the probation cap of ${lt.probationCapDays} day(s) for this leave type (already used ${used})`);
    }
  }
  const row = (await deps.db
    .insert(schema.leaveRequests)
    .values({ code: await allocOwnedCode(deps, schema.leaveRequests, schema.leaveRequests.employeeId, employeeId), employeeId, leaveTypeId, startDate: new Date(start), endDate: new Date(end), days, startSession, endSession, reason: input.reason ?? null, state: "PENDING" })
    .returning())[0]!;
  // Reserve the balance at request time; released if later rejected/cancelled. For a paid (entitlement) type
  // decrement CONDITIONALLY (WHERE balance_days >= days) so two concurrent requests can't both clear the
  // read-time check above and overdraw the balance - the loser matches 0 rows and we unwind the just-created
  // request. Unpaid types aren't entitlement-limited, so they use the plain adjust (may create the row).
  if (lt.paid) {
    const reserved = await deps.db
      .update(schema.leaveBalances)
      .set({ balanceDays: sql`round((${schema.leaveBalances.balanceDays} - ${days}) * 100) / 100`, updatedAt: new Date() })
      .where(and(eq(schema.leaveBalances.employeeId, employeeId), eq(schema.leaveBalances.leaveTypeId, leaveTypeId), gte(schema.leaveBalances.balanceDays, days)))
      .returning();
    if (!reserved.length) {
      await deps.db.delete(schema.leaveRequests).where(eq(schema.leaveRequests.uuid, row.uuid));
      throw failedPrecondition(`not enough ${lt.name} balance`);
    }
  } else {
    await adjustLeaveBalance(deps, employeeId, leaveTypeId, -days);
  }
  await audit(deps, actor, "leave_request.create", "leave-requests", row.uuid, undefined, row);
  await notifyManager(deps, employeeId, { type: "leave.requested", noun: "leave request" });
  await emitEvent(deps, actor, "leave.requested", {
    subject: `leave-requests/${row.uuid}`,
    employeeId,
    payload: { leaveTypeId, days, from: new Date(start).toISOString(), to: new Date(end).toISOString() },
  });
  return row;
}

// Add `delta` days to an employee's balance for a leave type (negative = consume). Creates the row if the
// employee has no balance for that type yet (so an approval before any accrual still records the usage).
async function adjustLeaveBalance(deps: Deps, employeeId: string, leaveTypeId: string, delta: number) {
  const bal = (await deps.db
    .select()
    .from(schema.leaveBalances)
    .where(and(eq(schema.leaveBalances.employeeId, employeeId), eq(schema.leaveBalances.leaveTypeId, leaveTypeId)))
    .limit(1))[0];
  if (bal) {
    // SQL-side delta (not a JS read-modify-write): an increment computed in the DB can't lose a concurrent
    // reserve/release on the same balance row the way read-then-write would. Mirrors the guarded debit above.
    await deps.db
      .update(schema.leaveBalances)
      .set({ balanceDays: sql`round((${schema.leaveBalances.balanceDays} + ${delta}) * 100) / 100`, updatedAt: new Date() })
      .where(eq(schema.leaveBalances.uuid, bal.uuid));
  } else {
    await deps.db
      .insert(schema.leaveBalances)
      .values({ code: await allocOwnedCode(deps, schema.leaveBalances, schema.leaveBalances.employeeId, employeeId), employeeId, leaveTypeId, balanceDays: round2(delta) });
  }
}

async function decide(deps: Deps, actor: AppUser, id: string, to: "APPROVED" | "REJECTED" | "CANCELLED") {
  const row = await getLeaveRequest(deps, actor, id);
  // Who may approve/reject/cancel is gated by the verb's grant (middleware). Here only the instance state +
  // dates matter. Approve/reject act on a PENDING request; cancel also works on an APPROVED leave that
  // hasn't started yet (so an employee can call off an upcoming approved leave and get the balance back).
  if (to === "CANCELLED") {
    if (row.state !== "PENDING" && row.state !== "APPROVED") throw failedPrecondition("only pending or approved leave can be cancelled");
    if (row.state === "APPROVED" && +new Date(row.startDate) <= +deps.clock.now()) throw failedPrecondition("approved leave that has already started cannot be cancelled");
  } else if (row.state !== "PENDING") {
    throw failedPrecondition("request is not pending");
  }
  // Guard the flip on the state we just validated so the decision is EXACTLY-ONCE: a concurrent or
  // double-clicked reject/cancel that also read PENDING loses here (0 rows) instead of both refunding the
  // balance twice (leave days are encashable = money, so a double refund is a real payout). 0 rows = someone
  // else already decided it.
  const from = row.state;
  const [updated] = await deps.db
    .update(schema.leaveRequests)
    .set({ state: to, decidedBy: actor.uuid, updatedAt: new Date() })
    .where(and(eq(schema.leaveRequests.uuid, id), eq(schema.leaveRequests.state, from)))
    .returning();
  if (!updated) throw failedPrecondition("request was already decided");
  // Balance is reserved at request time, so approval changes nothing; rejecting or cancelling releases it back.
  if (to === "REJECTED" || to === "CANCELLED") await adjustLeaveBalance(deps, row.employeeId, row.leaveTypeId, row.days);
  await audit(deps, actor, `leave_request.${to.toLowerCase()}`, "leave-requests", id);
  if (to === "APPROVED" || to === "REJECTED") {
    await notify(deps, { recipient: row.employeeId, type: `leave.${to.toLowerCase()}`, title: `Leave ${to.toLowerCase()}`, body: `Your leave request was ${to.toLowerCase()}.`, link: "leave-requests/history", subject: `leave-requests/${id}`, actorId: actor.employeeId });
  }
  await emitEvent(deps, actor, `leave.${to.toLowerCase()}`, {
    subject: `leave-requests/${id}`,
    employeeId: row.employeeId,
    payload: { leaveTypeId: row.leaveTypeId, days: row.days, from: new Date(row.startDate).toISOString(), to: new Date(row.endDate).toISOString() },
  });
  return updated;
}

export const approveLeaveRequest = (deps: Deps, actor: AppUser, id: string) => decide(deps, actor, id, "APPROVED");
export const rejectLeaveRequest = (deps: Deps, actor: AppUser, id: string) => decide(deps, actor, id, "REJECTED");
export const cancelLeaveRequest = (deps: Deps, actor: AppUser, id: string) => decide(deps, actor, id, "CANCELLED");

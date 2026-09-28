import { allocOwnedCode, withFreshCode } from "./codeAlloc";
import { and, eq, isNull, lte, inArray } from "drizzle-orm";
import { applyScope } from "./listScope";
import { searchFilter } from "./searchFilter";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, createdMeta, stateMeta } from "../lib/audit";
import { notify, notifyManager } from "./notifications";
import { emitEvent } from "./eventBus";
import { invalidArgument, notFound, failedPrecondition } from "../lib/errors";
import { keysetPage } from "./keysetPage";
import { assertNotSubject, assertReviewedVersion } from "./decisionGuard";

// Overtime requests: an employee logs extra hours for a day; a manager (own dept) or HR approves/rejects, the
// owner cancels while pending. Mirrors attendance-regularizations (request -> decide), without a side effect
// on approval - the approved record IS the tracked overtime. Who may approve/reject/cancel is the verb's grant
// (middleware); the service guards state transitions and maker-checker (services/decisionGuard.ts).
export type OvertimeInput = {
  employee?: string | null;
  start_time?: string; // ISO datetime when the overtime began
  end_time?: string; // ISO datetime when it ended
  reason?: string | null;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const MAX_MINUTES = 24 * 60;

export async function listOvertimeRequests(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, stateFilter?: string, q?: string, employeeId?: string) {
  const conds = [applyScope(scope, schema.overtimeRequests.code, schema.overtimeRequests.employeeId)];
  // Server-side text filter (FTS). Narrows the scope above; it can never widen it.
  const textMatch = await searchFilter(deps, "overtime-requests", q, schema.overtimeRequests.uuid);
  if (textMatch) conds.push(textMatch);
  if (stateFilter) conds.push(eq(schema.overtimeRequests.state, stateFilter as typeof schema.overtimeRequests.$inferSelect.state));
  // `?employee=`: one person's requests (a profile's attendance tab). Narrows the scope, never widens it.
  if (employeeId) conds.push(eq(schema.overtimeRequests.employeeId, employeeId));
  return keysetPage<typeof schema.overtimeRequests.$inferSelect>(deps, schema.overtimeRequests, "overtime-requests", and(...(conds.filter(Boolean) as any)), { max: maxPageSize, pageToken });
}

async function getOvertimeRequest(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.overtimeRequests).where(eq(schema.overtimeRequests.uuid, id)).limit(1))[0];
  if (!row) throw notFound("overtime request not found");
  return row;
}

export async function createOvertimeRequest(deps: Deps, actor: AppUser, input: OvertimeInput) {
  const start = input.start_time ? Date.parse(input.start_time) : NaN;
  const end = input.end_time ? Date.parse(input.end_time) : NaN;
  if (Number.isNaN(start) || Number.isNaN(end)) throw invalidArgument("start_time and end_time are required");
  if (end <= start) throw invalidArgument("end_time must be after start_time");
  if ((end - start) / 60000 > MAX_MINUTES) throw invalidArgument("overtime cannot exceed 24 hours");
  // The day the overtime is recorded under = the UTC day of its start (used for monthly grouping/display).
  const s = new Date(start);
  const dateMs = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate());
  // Default to the caller's own record unless an admin files on someone's behalf (owner-create is gated by the
  // middleware's owner_refs check, so a non-admin can only create under their own employee).
  const employeeId = idFromPath(input.employee) ?? actor.employeeId;
  if (!employeeId) throw invalidArgument("employee is required");
  // Allocated inside the retry (codeAlloc.ts): a late shift ends with several of these at once.
  const row = (await withFreshCode(async () => deps.db
    .insert(schema.overtimeRequests)
    .values({ code: await allocOwnedCode(deps, schema.overtimeRequests, schema.overtimeRequests.employeeId, employeeId), employeeId, date: new Date(dateMs), startTime: new Date(start), endTime: new Date(end), reason: input.reason?.trim() || null, state: "PENDING" })
    .returning()))[0]!;
  await audit(deps, actor, "overtime_request.create", "overtime-requests", row.uuid, createdMeta(row, "overtime-requests"), row);
  await notifyManager(deps, employeeId, { type: "overtime.requested", noun: "overtime request" });
  await emitEvent(deps, actor, "overtime.requested", { subject: `overtime-requests/${row.uuid}`, employeeId, payload: { hours: (end - start) / 3_600_000 } });
  return row;
}

async function decide(deps: Deps, actor: AppUser, id: string, to: "APPROVED" | "REJECTED" | "CANCELLED", note?: string | null, ifMatch?: string) {
  const row = await getOvertimeRequest(deps, actor, id);
  if (row.state !== "PENDING") throw failedPrecondition(to === "CANCELLED" ? "only pending requests can be cancelled" : "request is not pending");
  assertReviewedVersion(row, ifMatch);
  // Approved overtime is paid by the next run, so the person it pays may not be the one approving it.
  if (to === "APPROVED") await assertNotSubject(deps, actor, row.employeeId, "approve", "overtime request");
  // Guard the flip on PENDING so the decision is EXACTLY-ONCE: a double-clicked/concurrent call that also
  // read PENDING loses here (0 rows) instead of both firing the notify/event side-effects twice.
  const [updated] = await deps.db
    .update(schema.overtimeRequests)
    .set({ state: to, decidedBy: actor.uuid, decisionNote: note ?? null, updatedAt: new Date() })
    .where(and(eq(schema.overtimeRequests.uuid, id), eq(schema.overtimeRequests.state, "PENDING")))
    .returning();
  if (!updated) throw failedPrecondition(to === "CANCELLED" ? "only pending requests can be cancelled" : "request is not pending");
  await audit(deps, actor, `overtime_request.${to.toLowerCase()}`, "overtime-requests", id, stateMeta(row.state, to, { employee: `employees/${row.employeeId}`, ...(note ? { reason: note } : {}) }), updated);
  if (to === "APPROVED" || to === "REJECTED") {
    await notify(deps, { recipient: row.employeeId, type: `overtime.${to.toLowerCase()}`, title: `Overtime ${to.toLowerCase()}`, body: `Your overtime request was ${to.toLowerCase()}.`, link: "overtime/history", subject: `overtime-requests/${id}`, actorId: actor.employeeId });
  }
  if (to === "APPROVED") await emitEvent(deps, actor, "overtime.approved", { subject: `overtime-requests/${id}`, employeeId: row.employeeId, payload: { hours: (+new Date(row.endTime) - +new Date(row.startTime)) / 3_600_000 } });
  return updated;
}

export const approveOvertimeRequest = (deps: Deps, actor: AppUser, id: string, note?: string | null, ifMatch?: string) => decide(deps, actor, id, "APPROVED", note, ifMatch);
export const rejectOvertimeRequest = (deps: Deps, actor: AppUser, id: string, note?: string | null, ifMatch?: string) => decide(deps, actor, id, "REJECTED", note, ifMatch);
export const cancelOvertimeRequest = (deps: Deps, actor: AppUser, id: string) => decide(deps, actor, id, "CANCELLED");

// Approved overtime not yet paid by any run, optionally only up to a period-end (so future-dated OT isn't
// paid early). The next payroll run pays it as a taxable earning. Mirrors unpaidBonuses.
export async function approvedUnpaidOvertime(deps: Deps, employeeId: string, throughMs?: number) {
  const conds = [eq(schema.overtimeRequests.employeeId, employeeId), eq(schema.overtimeRequests.state, "APPROVED"), isNull(schema.overtimeRequests.paidRunId), isNull(schema.overtimeRequests.paidAt)];
  if (throughMs != null) conds.push(lte(schema.overtimeRequests.date, new Date(throughMs)));
  return deps.db.select().from(schema.overtimeRequests).where(and(...conds));
}
// The whole approved-unpaid queue in one read - the run build groups by employee (subrequest-budget shape).
// `paidAt` with no run = paid by an FnF settlement; both markers gate the queue (see bonuses).
export async function approvedUnpaidOvertimeAll(deps: Deps, throughMs?: number) {
  const conds = [eq(schema.overtimeRequests.state, "APPROVED"), isNull(schema.overtimeRequests.paidRunId), isNull(schema.overtimeRequests.paidAt)];
  if (throughMs != null) conds.push(lte(schema.overtimeRequests.date, new Date(throughMs)));
  return deps.db.select().from(schema.overtimeRequests).where(and(...conds));
}
// The two below return UNEXECUTED statements so the build can batch them (a direct await still executes).
// Guarded on still being approved-and-unpaid, so a row that left the queue between the build's read and its
// commit (another run claiming it, a decision reversal) can never be flipped to paid (mirrors bonuses).
export function markOvertimePaidByRun(deps: Deps, ids: string[], runId: string, at: Date) {
  return deps.db
    .update(schema.overtimeRequests)
    .set({ paidRunId: runId, paidAt: at })
    .where(and(inArray(schema.overtimeRequests.uuid, ids), eq(schema.overtimeRequests.state, "APPROVED"), isNull(schema.overtimeRequests.paidRunId)));
}
// Paid by a full-and-final settlement rather than a run, and the release a recomputed settlement uses.
// Unexecuted statement, so the FnF commits it in the same atomic batch as the settlement (see reimbursements).
export function markOvertimeSettledStmt(deps: Deps, ids: string[], at: Date) {
  return deps.db.update(schema.overtimeRequests).set({ paidAt: at }).where(and(inArray(schema.overtimeRequests.uuid, ids), isNull(schema.overtimeRequests.paidRunId)));
}
export function releaseOvertimeSettledStmt(deps: Deps, ids: string[]) {
  return deps.db.update(schema.overtimeRequests).set({ paidAt: null }).where(and(inArray(schema.overtimeRequests.uuid, ids), isNull(schema.overtimeRequests.paidRunId)));
}
export function resetOvertimePaidByRun(deps: Deps, runId: string) {
  return deps.db.update(schema.overtimeRequests).set({ paidRunId: null, paidAt: null }).where(eq(schema.overtimeRequests.paidRunId, runId));
}

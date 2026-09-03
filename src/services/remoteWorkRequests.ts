import { allocOwnedCode } from "./codeAlloc";
import { and, eq } from "drizzle-orm";
import { applyScope } from "./listScope";
import { searchFilter } from "./searchFilter";
import { dateWindow } from "./dateWindow";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, createdMeta, stateMeta } from "../lib/audit";
import { notify, notifyManager } from "./notifications";
import { emitEvent } from "./eventBus";
import { invalidArgument, notFound, failedPrecondition } from "../lib/errors";
import { keysetPage } from "./keysetPage";

// Work-from-home / remote-day requests: an employee asks to work remotely over a date range; a manager (own
// dept) or HR approves/rejects, the owner cancels while pending. Mirrors the overtime/regularization pattern
// (request -> decide, no side effect on approval). Who may decide is the verb's grant (middleware); the
// service only guards state transitions.
export type RemoteWorkInput = {
  employee?: string | null;
  start_date?: string; // YYYY-MM-DD
  end_date?: string; // YYYY-MM-DD (inclusive)
  start_session?: number; // 1 = first half (AM), 2 = second half (PM); range begins this session of start_date
  end_session?: number; // 1 = first half, 2 = second half; range ends this session of end_date
  location?: string | null;
  reason?: string | null;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string) => (s ? Date.parse(s + "T00:00:00Z") : NaN);

export async function listRemoteWorkRequests(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, stateFilter?: string, q?: string, fromYmd?: string, toYmd?: string) {
  const conds = [applyScope(scope, schema.remoteWorkRequests.code, schema.remoteWorkRequests.employeeId)];
  // Server-side text filter (FTS). Narrows the scope above; it can never widen it.
  const textMatch = await searchFilter(deps, "remote-work-requests", q, schema.remoteWorkRequests.uuid);
  if (textMatch) conds.push(textMatch);
  if (stateFilter) conds.push(eq(schema.remoteWorkRequests.state, stateFilter as typeof schema.remoteWorkRequests.$inferSelect.state));
  // `?from=&to=`: the window a calendar month asks for (see services/dateWindow.ts).
  conds.push(...dateWindow(schema.remoteWorkRequests.startDate, schema.remoteWorkRequests.endDate, fromYmd, toYmd));
  return keysetPage<typeof schema.remoteWorkRequests.$inferSelect>(deps, schema.remoteWorkRequests, "remote-work-requests", and(...(conds.filter(Boolean) as any)), { max: maxPageSize, pageToken });
}

async function getRemoteWorkRequest(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.remoteWorkRequests).where(eq(schema.remoteWorkRequests.uuid, id)).limit(1))[0];
  if (!row) throw notFound("remote work request not found");
  return row;
}

export async function createRemoteWorkRequest(deps: Deps, actor: AppUser, input: RemoteWorkInput) {
  const start = dayMs(input.start_date);
  const end = dayMs(input.end_date);
  if (Number.isNaN(start) || Number.isNaN(end)) throw invalidArgument("start_date and end_date are required (YYYY-MM-DD)");
  if (end < start) throw invalidArgument("end_date cannot be before start_date");
  const startSession = input.start_session === 2 ? 2 : 1;
  const endSession = input.end_session === 1 ? 1 : 2;
  if (start === end && startSession > endSession) throw invalidArgument("the start session must be on or before the end session");
  // Default to the caller's own record unless an admin files on someone's behalf (owner-create is gated by the
  // middleware's owner_refs check, so a non-admin can only create under their own employee).
  const employeeId = idFromPath(input.employee) ?? actor.employeeId;
  if (!employeeId) throw invalidArgument("employee is required");
  const row = (await deps.db
    .insert(schema.remoteWorkRequests)
    .values({ code: await allocOwnedCode(deps, schema.remoteWorkRequests, schema.remoteWorkRequests.employeeId, employeeId), employeeId, startDate: new Date(start), endDate: new Date(end), startSession, endSession, location: input.location?.trim() || null, reason: input.reason?.trim() || null, state: "PENDING" })
    .returning())[0]!;
  await audit(deps, actor, "remote_work_request.create", "remote-work-requests", row.uuid, createdMeta(row, "remote-work-requests"), row);
  await notifyManager(deps, employeeId, { type: "remote.requested", noun: "remote work request" });
  await emitEvent(deps, actor, "remoteWork.requested", { subject: `remote-work-requests/${row.uuid}`, employeeId, payload: { from: new Date(start).toISOString(), to: new Date(end).toISOString() } });
  return row;
}

async function decide(deps: Deps, actor: AppUser, id: string, to: "APPROVED" | "REJECTED" | "CANCELLED", note?: string | null) {
  const row = await getRemoteWorkRequest(deps, actor, id);
  if (row.state !== "PENDING") throw failedPrecondition(to === "CANCELLED" ? "only pending requests can be cancelled" : "request is not pending");
  // Guard the flip on PENDING so the decision is EXACTLY-ONCE (0 rows = already decided by a concurrent call).
  const [updated] = await deps.db
    .update(schema.remoteWorkRequests)
    .set({ state: to, decidedBy: actor.uuid, decisionNote: note ?? null, updatedAt: new Date() })
    .where(and(eq(schema.remoteWorkRequests.uuid, id), eq(schema.remoteWorkRequests.state, "PENDING")))
    .returning();
  if (!updated) throw failedPrecondition(to === "CANCELLED" ? "only pending requests can be cancelled" : "request is not pending");
  await audit(deps, actor, `remote_work_request.${to.toLowerCase()}`, "remote-work-requests", id, stateMeta(row.state, to, { employee: `employees/${row.employeeId}`, ...(note ? { reason: note } : {}) }), updated);
  if (to === "APPROVED" || to === "REJECTED") {
    await notify(deps, { recipient: row.employeeId, type: `remote.${to.toLowerCase()}`, title: `Remote work ${to.toLowerCase()}`, body: `Your remote work request was ${to.toLowerCase()}.`, link: "remote-work/history", subject: `remote-work-requests/${id}`, actorId: actor.employeeId });
  }
  if (to === "APPROVED") await emitEvent(deps, actor, "remoteWork.approved", { subject: `remote-work-requests/${id}`, employeeId: row.employeeId, payload: { from: new Date(row.startDate).toISOString(), to: new Date(row.endDate).toISOString() } });
  return updated;
}

export const approveRemoteWorkRequest = (deps: Deps, actor: AppUser, id: string, note?: string | null) => decide(deps, actor, id, "APPROVED", note);
export const rejectRemoteWorkRequest = (deps: Deps, actor: AppUser, id: string, note?: string | null) => decide(deps, actor, id, "REJECTED", note);
export const cancelRemoteWorkRequest = (deps: Deps, actor: AppUser, id: string) => decide(deps, actor, id, "CANCELLED");

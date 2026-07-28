import { eq, and, gte, lte } from "drizzle-orm";
import { allocOwnedCode } from "./codeAlloc";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, diffMeta } from "../lib/audit";
import { notify, notifyManager } from "./notifications";
import { invalidArgument, notFound, aborted, failedPrecondition } from "../lib/errors";
import { encodeCursor, decodeCursor } from "../http/pagination";
import { etagOf } from "../http/serialize";
import { softDeleteRow, restoreRow, purgeRow } from "./softDelete";

type Status = typeof schema.timeEntries.$inferSelect.status;
export type TimeEntryInput = {
  employee?: string | null;
  project?: string | null;
  date?: string | null;
  hours?: number;
  description?: string | null;
  billable?: boolean;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string | null) => (s ? Date.parse(s + "T00:00:00Z") : NaN);

export async function listTimeEntries(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, employee?: string, from?: string, to?: string, status?: string, showDeleted = false) {
  const conds = [applyScope(scope, schema.timeEntries.code, schema.timeEntries.employeeId)];
  const empId = idFromPath(employee);
  if (empId) conds.push(eq(schema.timeEntries.employeeId, empId));
  if (status) conds.push(eq(schema.timeEntries.status, status as Status));
  if (from && !Number.isNaN(dayMs(from))) conds.push(gte(schema.timeEntries.date, new Date(dayMs(from))));
  if (to && !Number.isNaN(dayMs(to))) conds.push(lte(schema.timeEntries.date, new Date(dayMs(to) + 86_399_999)));
  const all = (await deps.db.select().from(schema.timeEntries).where(conds.filter(Boolean).length ? and(...conds.filter(Boolean)) : undefined))
    .filter((e) => showDeleted || !e.deleteTime)
    .sort((a, b) => +new Date(a.date) - +new Date(b.date) || a.uuid.localeCompare(b.uuid));
  const cur = decodeCursor(pageToken);
  const start = cur ? all.findIndex((e) => +new Date(e.createdAt) > cur.createTimeMs || (+new Date(e.createdAt) === cur.createTimeMs && e.uuid > cur.uid)) : 0;
  const slice = start < 0 ? [] : all.slice(start, start + maxPageSize);
  const last = slice[slice.length - 1];
  const nextPageToken = start >= 0 && start + maxPageSize < all.length && last ? encodeCursor(+new Date(last.createdAt), last.uuid) : undefined;
  return { items: slice, nextPageToken };
}

export async function getTimeEntry(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.timeEntries).where(eq(schema.timeEntries.uuid, id)).limit(1))[0];
  if (!row) throw notFound("time entry not found");
  return row;
}

export async function createTimeEntry(deps: Deps, actor: AppUser, input: TimeEntryInput, id?: string) {
  const employeeId = idFromPath(input.employee) ?? actor.employeeId;
  if (!employeeId) throw invalidArgument("employee is required");
  const projectId = idFromPath(input.project);
  if (!projectId) throw invalidArgument("project is required");
  const ms = dayMs(input.date);
  if (Number.isNaN(ms)) throw invalidArgument("date is required");
  if (input.hours != null && (typeof input.hours !== "number" || input.hours < 0 || input.hours > 24)) throw invalidArgument("hours must be between 0 and 24");
  const row = (await deps.db.insert(schema.timeEntries).values({
    code: await allocOwnedCode(deps, schema.timeEntries, schema.timeEntries.employeeId, employeeId),
    ...(id ? { uuid: id } : {}),
    employeeId,
    projectId,
    date: new Date(ms),
    hours: input.hours ?? 0,
    description: input.description?.trim() || null,
    billable: input.billable ?? true,
  }).returning())[0]!;
  await audit(deps, actor, "time-entry.create", "time-entries", row.uuid, undefined, row);
  return row;
}

export async function updateTimeEntry(deps: Deps, actor: AppUser, id: string, patch: TimeEntryInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.timeEntries).where(eq(schema.timeEntries.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("time entry not found");
  if (row.status === "APPROVED") throw failedPrecondition("an approved entry can't be edited");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const has = (k: keyof TimeEntryInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("project")) { const p = idFromPath(patch.project); if (!p) throw invalidArgument("project is required"); set.projectId = p; }
  if (has("date")) { const ms = dayMs(patch.date); if (Number.isNaN(ms)) throw invalidArgument("date is invalid"); set.date = new Date(ms); }
  if (has("hours")) { if (patch.hours == null || patch.hours < 0 || patch.hours > 24) throw invalidArgument("hours must be between 0 and 24"); set.hours = patch.hours; }
  if (has("description")) set.description = patch.description?.trim() || null;
  if (has("billable")) set.billable = !!patch.billable;
  const updated = (await deps.db.update(schema.timeEntries).set(set).where(eq(schema.timeEntries.uuid, id)).returning())[0]!;
  await audit(deps, actor, "time-entry.update", "time-entries", id, diffMeta(row, updated, set), updated);
  return updated;
}

// Workflow transitions. submit (DRAFT/REJECTED -> SUBMITTED), approve / reject (SUBMITTED -> APPROVED/REJECTED).
async function transition(deps: Deps, actor: AppUser, id: string, allowedFrom: Status[], to: Status, decided: boolean) {
  const row = (await deps.db.select().from(schema.timeEntries).where(eq(schema.timeEntries.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("time entry not found");
  if (!allowedFrom.includes(row.status)) throw failedPrecondition(`a ${row.status.toLowerCase()} entry can't move to ${to.toLowerCase()}`);
  // Guard the flip on the read status so the transition is EXACTLY-ONCE (0 rows = a concurrent call moved it).
  const updated = (await deps.db.update(schema.timeEntries).set({ status: to, ...(decided ? { decidedBy: actor.uuid } : {}), updatedAt: new Date() }).where(and(eq(schema.timeEntries.uuid, id), eq(schema.timeEntries.status, row.status))).returning())[0];
  if (!updated) throw failedPrecondition(`a ${row.status.toLowerCase()} entry can't move to ${to.toLowerCase()}`);
  await audit(deps, actor, `time-entry.${to.toLowerCase()}`, "time-entries", id);
  if (to === "APPROVED" || to === "REJECTED") {
    await notify(deps, { recipient: row.employeeId, type: `timesheet.${to.toLowerCase()}`, title: `Timesheet ${to.toLowerCase()}`, body: `Your time entry was ${to.toLowerCase()}.`, link: "timesheets", actorId: actor.employeeId });
  } else if (to === "SUBMITTED") {
    // A submitted timesheet needs the manager's review.
    await notifyManager(deps, row.employeeId, { type: "timesheet.requested", noun: "timesheet" });
  }
  return updated;
}
export const submitTimeEntry = (deps: Deps, actor: AppUser, id: string) => transition(deps, actor, id, ["DRAFT", "REJECTED"], "SUBMITTED", false);
export const approveTimeEntry = (deps: Deps, actor: AppUser, id: string) => transition(deps, actor, id, ["SUBMITTED"], "APPROVED", true);
export const rejectTimeEntry = (deps: Deps, actor: AppUser, id: string) => transition(deps, actor, id, ["SUBMITTED"], "REJECTED", true);

export async function deleteTimeEntry(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await softDeleteRow(deps, actor, schema.timeEntries, "time-entry", "time-entries", id, ifMatch);
}
export async function restoreTimeEntry(deps: Deps, actor: AppUser, id: string) {
  return restoreRow(deps, actor, schema.timeEntries, "time-entry", "time-entries", id);
}
export async function purgeTimeEntry(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await purgeRow(deps, actor, schema.timeEntries, "time-entry", "time-entries", id, ifMatch);
}

import { eq, and, gte, lte } from "drizzle-orm";
import { allocOwnedCode } from "./codeAlloc";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, diffMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted } from "../lib/errors";
import { encodeCursor, decodeCursor } from "../http/pagination";
import { etagOf } from "../http/serialize";
import { softDeleteRow, restoreRow, purgeRow } from "./softDelete";
import { notify } from "./notifications";

export type ShiftAssignmentInput = {
  employee?: string | null;
  shift?: string | null;
  date?: string | null;
  note?: string | null;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string | null) => (s ? Date.parse(s + "T00:00:00Z") : NaN);

export async function listShiftAssignments(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, employee?: string, from?: string, to?: string, showDeleted = false) {
  const conds = [applyScope(scope, schema.shiftAssignments.code, schema.shiftAssignments.employeeId)];
  const empId = idFromPath(employee);
  if (empId) conds.push(eq(schema.shiftAssignments.employeeId, empId));
  if (from && !Number.isNaN(dayMs(from))) conds.push(gte(schema.shiftAssignments.date, new Date(dayMs(from))));
  if (to && !Number.isNaN(dayMs(to))) conds.push(lte(schema.shiftAssignments.date, new Date(dayMs(to) + 86_399_999)));
  const all = (await deps.db.select().from(schema.shiftAssignments).where(conds.filter(Boolean).length ? and(...conds.filter(Boolean)) : undefined))
    .filter((a) => showDeleted || !a.deleteTime)
    .sort((a, b) => +new Date(a.date) - +new Date(b.date) || a.uuid.localeCompare(b.uuid));
  const cur = decodeCursor(pageToken);
  const start = cur ? all.findIndex((e) => +new Date(e.createdAt) > cur.createTimeMs || (+new Date(e.createdAt) === cur.createTimeMs && e.uuid > cur.uid)) : 0;
  const slice = start < 0 ? [] : all.slice(start, start + maxPageSize);
  const last = slice[slice.length - 1];
  const nextPageToken = start >= 0 && start + maxPageSize < all.length && last ? encodeCursor(+new Date(last.createdAt), last.uuid) : undefined;
  return { items: slice, nextPageToken };
}

export async function getShiftAssignment(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.shiftAssignments).where(eq(schema.shiftAssignments.uuid, id)).limit(1))[0];
  if (!row) throw notFound("shift assignment not found");
  return row;
}

export async function createShiftAssignment(deps: Deps, actor: AppUser, input: ShiftAssignmentInput, id?: string) {
  const employeeId = idFromPath(input.employee) ?? actor.employeeId;
  if (!employeeId) throw invalidArgument("employee is required");
  const shiftId = idFromPath(input.shift);
  if (!shiftId) throw invalidArgument("shift is required");
  const ms = dayMs(input.date);
  if (Number.isNaN(ms)) throw invalidArgument("date is required");
  const row = (await deps.db.insert(schema.shiftAssignments).values({
    code: await allocOwnedCode(deps, schema.shiftAssignments, schema.shiftAssignments.employeeId, employeeId),
    ...(id ? { uuid: id } : {}),
    employeeId,
    shiftId,
    date: new Date(ms),
    note: input.note?.trim() || null,
  }).returning())[0]!;
  await audit(deps, actor, "shift-assignment.create", "shift-assignments", row.uuid, undefined, row);
  if (employeeId !== actor.employeeId)
    await notify(deps, { recipient: employeeId, type: "shift.assigned", title: "Shift assigned", body: `You've been rostered for ${input.date}.`, link: "schedule", subject: `shift-assignments/${row.uuid}`, actorId: actor.employeeId });
  return row;
}

export async function updateShiftAssignment(deps: Deps, actor: AppUser, id: string, patch: ShiftAssignmentInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.shiftAssignments).where(eq(schema.shiftAssignments.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("shift assignment not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const has = (k: keyof ShiftAssignmentInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("shift")) { const s = idFromPath(patch.shift); if (!s) throw invalidArgument("shift is required"); set.shiftId = s; }
  if (has("date")) { const ms = dayMs(patch.date); if (Number.isNaN(ms)) throw invalidArgument("date is invalid"); set.date = new Date(ms); }
  if (has("note")) set.note = patch.note?.trim() || null;
  const updated = (await deps.db.update(schema.shiftAssignments).set(set).where(eq(schema.shiftAssignments.uuid, id)).returning())[0]!;
  await audit(deps, actor, "shift-assignment.update", "shift-assignments", id, diffMeta(row, updated, set), updated);
  return updated;
}

export async function deleteShiftAssignment(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await softDeleteRow(deps, actor, schema.shiftAssignments, "shift-assignment", "shift-assignments", id, ifMatch);
}
export async function restoreShiftAssignment(deps: Deps, actor: AppUser, id: string) {
  return restoreRow(deps, actor, schema.shiftAssignments, "shift-assignment", "shift-assignments", id);
}
export async function purgeShiftAssignment(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await purgeRow(deps, actor, schema.shiftAssignments, "shift-assignment", "shift-assignments", id, ifMatch);
}

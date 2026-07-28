import { eq, and } from "drizzle-orm";
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

export type ActionItem = { text: string; done?: boolean };
export type CheckInInput = {
  employee?: string | null;
  counterpart?: string | null;
  meeting_date?: string | null;
  notes?: string | null;
  action_items?: ActionItem[];
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string | null) => (s ? Date.parse(s + "T00:00:00Z") : NaN);
const cleanItems = (items?: ActionItem[]) =>
  Array.isArray(items) ? JSON.stringify(items.filter((i) => i?.text?.trim()).map((i) => ({ text: i.text.trim(), done: !!i.done }))) : null;

export async function listCheckIns(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, employee?: string, showDeleted = false) {
  const conds = [applyScope(scope, schema.checkIns.code, schema.checkIns.employeeId)];
  const empId = idFromPath(employee);
  if (empId) conds.push(eq(schema.checkIns.employeeId, empId));
  const all = (await deps.db.select().from(schema.checkIns).where(conds.filter(Boolean).length ? and(...conds.filter(Boolean)) : undefined))
    .filter((c) => showDeleted || !c.deleteTime)
    .sort((a, b) => +new Date(b.meetingDate ?? b.createdAt) - +new Date(a.meetingDate ?? a.createdAt) || a.uuid.localeCompare(b.uuid));
  const cur = decodeCursor(pageToken);
  const start = cur ? all.findIndex((e) => +new Date(e.createdAt) < cur.createTimeMs || (+new Date(e.createdAt) === cur.createTimeMs && e.uuid > cur.uid)) : 0;
  const slice = start < 0 ? [] : all.slice(start, start + maxPageSize);
  const last = slice[slice.length - 1];
  const nextPageToken = start >= 0 && start + maxPageSize < all.length && last ? encodeCursor(+new Date(last.createdAt), last.uuid) : undefined;
  return { items: slice, nextPageToken };
}

export async function getCheckIn(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.checkIns).where(eq(schema.checkIns.uuid, id)).limit(1))[0];
  if (!row) throw notFound("check-in not found");
  return row;
}

export async function createCheckIn(deps: Deps, actor: AppUser, input: CheckInInput, id?: string) {
  const employeeId = idFromPath(input.employee) ?? actor.employeeId;
  if (!employeeId) throw invalidArgument("employee is required");
  if (input.meeting_date && Number.isNaN(dayMs(input.meeting_date))) throw invalidArgument("meeting_date is invalid");
  // Counterpart defaults to the report's manager (the usual 1:1 partner).
  let counterpartId = idFromPath(input.counterpart) ?? null;
  if (!counterpartId) {
    const subject = (await deps.db.select({ managerId: schema.employees.managerId }).from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
    counterpartId = subject?.managerId ?? null;
  }
  const row = (await deps.db.insert(schema.checkIns).values({
    code: await allocOwnedCode(deps, schema.checkIns, schema.checkIns.employeeId, employeeId),
    ...(id ? { uuid: id } : {}),
    employeeId,
    counterpartId,
    meetingDate: input.meeting_date ? new Date(dayMs(input.meeting_date)) : null,
    notes: input.notes?.trim() || null,
    actionItemsJson: cleanItems(input.action_items),
  }).returning())[0]!;
  await audit(deps, actor, "check-in.create", "check-ins", row.uuid, undefined, row);
  // Tell the other party (or both, if HR logged it) that a 1:1 was recorded.
  for (const rid of [employeeId, counterpartId].filter((r): r is string => !!r && r !== actor.employeeId))
    await notify(deps, { recipient: rid, type: "checkin.scheduled", title: "1:1 check-in logged", body: input.meeting_date ? `A 1:1 was scheduled for ${input.meeting_date}.` : "A 1:1 check-in was recorded with you.", link: "check-ins", subject: `check-ins/${row.uuid}`, actorId: actor.employeeId });
  return row;
}

export async function updateCheckIn(deps: Deps, actor: AppUser, id: string, patch: CheckInInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.checkIns).where(eq(schema.checkIns.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("check-in not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const has = (k: keyof CheckInInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("counterpart")) set.counterpartId = idFromPath(patch.counterpart) ?? null;
  if (has("meeting_date")) {
    if (patch.meeting_date && Number.isNaN(dayMs(patch.meeting_date))) throw invalidArgument("meeting_date is invalid");
    set.meetingDate = patch.meeting_date ? new Date(dayMs(patch.meeting_date)) : null;
  }
  if (has("notes")) set.notes = patch.notes?.trim() || null;
  if (has("action_items")) set.actionItemsJson = cleanItems(patch.action_items);
  const updated = (await deps.db.update(schema.checkIns).set(set).where(eq(schema.checkIns.uuid, id)).returning())[0]!;
  await audit(deps, actor, "check-in.update", "check-ins", id, diffMeta(row, updated, set), updated);
  return updated;
}

export async function deleteCheckIn(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await softDeleteRow(deps, actor, schema.checkIns, "check-in", "check-ins", id, ifMatch);
}
export async function restoreCheckIn(deps: Deps, actor: AppUser, id: string) {
  return restoreRow(deps, actor, schema.checkIns, "check-in", "check-ins", id);
}
export async function purgeCheckIn(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await purgeRow(deps, actor, schema.checkIns, "check-in", "check-ins", id, ifMatch);
}

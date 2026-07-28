import { eq } from "drizzle-orm";
import { allocFlatCode } from "./codeAlloc";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, diffMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted } from "../lib/errors";
import { encodeCursor, decodeCursor } from "../http/pagination";
import { etagOf } from "../http/serialize";
import { visibleByDelete, softDeleteRow, restoreRow, purgeRow } from "./softDelete";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export type ShiftInput = {
  name?: string;
  start?: string;
  end?: string;
  break_minutes?: number;
  color?: string | null;
};

export async function listShifts(deps: Deps, _actor: AppUser, maxPageSize: number, pageToken?: string, showDeleted = false) {
  const all = visibleByDelete(await deps.db.select().from(schema.shifts), showDeleted)
    .sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? "") || +new Date(a.createdAt) - +new Date(b.createdAt) || a.uuid.localeCompare(b.uuid));
  const cur = decodeCursor(pageToken);
  const start = cur ? all.findIndex((e) => +new Date(e.createdAt) > cur.createTimeMs || (+new Date(e.createdAt) === cur.createTimeMs && e.uuid > cur.uid)) : 0;
  const slice = start < 0 ? [] : all.slice(start, start + maxPageSize);
  const last = slice[slice.length - 1];
  const nextPageToken = start >= 0 && start + maxPageSize < all.length && last ? encodeCursor(+new Date(last.createdAt), last.uuid) : undefined;
  return { items: slice, nextPageToken };
}

export async function getShift(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.shifts).where(eq(schema.shifts.uuid, id)).limit(1))[0];
  if (!row) throw notFound("shift not found");
  return row;
}

const validTime = (t?: string) => t === undefined || HHMM.test(t);

export async function createShift(deps: Deps, actor: AppUser, input: ShiftInput, id?: string) {
  if (!input.name?.trim()) throw invalidArgument("name is required");
  if (!validTime(input.start) || !validTime(input.end)) throw invalidArgument("times must be HH:MM");
  const row = (await deps.db.insert(schema.shifts).values({
    code: await allocFlatCode(deps, schema.shifts),
    ...(id ? { uuid: id } : {}),
    name: input.name.trim(),
    startTime: input.start ?? "09:00",
    endTime: input.end ?? "18:00",
    breakMinutes: Math.max(0, input.break_minutes ?? 0),
    color: input.color?.trim() || null,
  }).returning())[0]!;
  await audit(deps, actor, "shift.create", "shifts", row.uuid, undefined, row);
  return row;
}

export async function updateShift(deps: Deps, actor: AppUser, id: string, patch: ShiftInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.shifts).where(eq(schema.shifts.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("shift not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const has = (k: keyof ShiftInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("name")) { if (!patch.name?.trim()) throw invalidArgument("name is required"); set.name = patch.name.trim(); }
  if (has("start")) { if (!validTime(patch.start)) throw invalidArgument("start must be HH:MM"); set.startTime = patch.start; }
  if (has("end")) { if (!validTime(patch.end)) throw invalidArgument("end must be HH:MM"); set.endTime = patch.end; }
  if (has("break_minutes")) set.breakMinutes = Math.max(0, patch.break_minutes ?? 0);
  if (has("color")) set.color = patch.color?.trim() || null;
  const updated = (await deps.db.update(schema.shifts).set(set).where(eq(schema.shifts.uuid, id)).returning())[0]!;
  await audit(deps, actor, "shift.update", "shifts", id, diffMeta(row, updated, set), updated);
  return updated;
}

export async function deleteShift(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await softDeleteRow(deps, actor, schema.shifts, "shift", "shifts", id, ifMatch);
}
export async function restoreShift(deps: Deps, actor: AppUser, id: string) {
  return restoreRow(deps, actor, schema.shifts, "shift", "shifts", id);
}
export async function purgeShift(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await purgeRow(deps, actor, schema.shifts, "shift", "shifts", id, ifMatch);
}

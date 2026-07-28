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
import { assertNotLocked } from "./lifecycle";

export type HolidayInput = { display_name?: string; date?: string; kind?: "fixed" | "optional" };

// Map of optional-holiday id -> the caller's selection id (empty for non-employees).
async function selectedIds(deps: Deps, actor: AppUser): Promise<Map<string, string>> {
  if (!actor.employeeId) return new Map();
  const rows = await deps.db
    .select()
    .from(schema.holidaySelections)
    .where(eq(schema.holidaySelections.employeeId, actor.employeeId));
  return new Map(rows.map((r) => [r.holidayId, r.uuid]));
}

export async function listHolidays(deps: Deps, actor: AppUser, maxPageSize: number, pageToken?: string, showDeleted = false) {
  const all = visibleByDelete(await deps.db.select().from(schema.holidays), showDeleted).sort(
    (a, b) => +new Date(a.createdAt) - +new Date(b.createdAt) || a.uuid.localeCompare(b.uuid),
  );
  const cur = decodeCursor(pageToken);
  const start = cur
    ? all.findIndex((e) => +new Date(e.createdAt) > cur.createTimeMs || (+new Date(e.createdAt) === cur.createTimeMs && e.uuid > cur.uid))
    : 0;
  const slice = start < 0 ? [] : all.slice(start, start + maxPageSize);
  const picked = await selectedIds(deps, actor);
  const items = slice.map((h) => ({ ...h, selected: picked.has(h.uuid), selectionId: picked.get(h.uuid) }));
  const last = slice[slice.length - 1];
  const nextPageToken = start >= 0 && start + maxPageSize < all.length && last ? encodeCursor(+new Date(last.createdAt), last.uuid) : undefined;
  return { items, nextPageToken };
}

export async function getHoliday(deps: Deps, actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.holidays).where(eq(schema.holidays.uuid, id)).limit(1))[0];
  if (!row) throw notFound("holiday not found");
  const picked = await selectedIds(deps, actor);
  return { ...row, selected: picked.has(row.uuid), selectionId: picked.get(row.uuid) };
}

export async function createHoliday(deps: Deps, actor: AppUser, input: HolidayInput, id?: string) {
  if (!input.display_name) throw invalidArgument("display_name is required");
  if (!input.date) throw invalidArgument("date is required");
  const dateMs = Date.parse(input.date + "T00:00:00Z");
  if (Number.isNaN(dateMs)) throw invalidArgument("date must be YYYY-MM-DD");
  const row = (await deps.db
    .insert(schema.holidays)
    .values({ code: await allocFlatCode(deps, schema.holidays), ...(id ? { id } : {}), name: input.display_name, date: new Date(dateMs), kind: input.kind ?? "fixed" })
    .returning())[0]!;
  await audit(deps, actor, "holiday.create", "holidays", row.uuid, undefined, row);
  return row;
}

export async function updateHoliday(deps: Deps, actor: AppUser, id: string, patch: HolidayInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.holidays).where(eq(schema.holidays.uuid, id)).limit(1))[0];
  if (!row) throw notFound("holiday not found");
  assertNotLocked(row);
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const has = (k: keyof HolidayInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("display_name")) set.name = patch.display_name;
  if (has("kind")) set.kind = patch.kind;
  if (has("date") && patch.date) {
    const dateMs = Date.parse(patch.date + "T00:00:00Z");
    if (Number.isNaN(dateMs)) throw invalidArgument("date must be YYYY-MM-DD");
    set.date = new Date(dateMs);
  }
  const updated = (await deps.db.update(schema.holidays).set(set).where(eq(schema.holidays.uuid, id)).returning())[0]!;
  await audit(deps, actor, "holiday.update", "holidays", id, diffMeta(row, updated, set), updated);
  return updated;
}

export async function deleteHoliday(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await softDeleteRow(deps, actor, schema.holidays, "holiday", "holidays", id, ifMatch);
}

export async function restoreHoliday(deps: Deps, actor: AppUser, id: string) {
  return restoreRow(deps, actor, schema.holidays, "holiday", "holidays", id);
}

export async function purgeHoliday(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await purgeRow(deps, actor, schema.holidays, "holiday", "holidays", id, ifMatch);
}

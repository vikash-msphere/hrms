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
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";

export type EventInput = {
  title?: string;
  start_time?: string; // ISO instant, or YYYY-MM-DD for an all-day event
  end_time?: string;
  all_day?: boolean;
  count_as_work?: boolean;
  color?: string | null;
  description?: string | null;
  attendees?: string[] | null; // employee paths/ids (decoded to internal ids by the inbound edge)
};

const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
// Normalise an attendees array (employee paths/ids) to a de-duped JSON array of internal ids.
const attendeesJson = (attendees?: string[] | null) =>
  JSON.stringify(Array.from(new Set((attendees ?? []).map((a) => idFromPath(a)).filter((x): x is string => !!x))));

// Parse a wire time. All-day events are date-anchored (UTC midnight of the given day, inclusive of the end
// day); timed events are exact instants. Returns ms, or NaN if unparseable.
function parseTime(s: string | undefined, allDay: boolean): number {
  if (!s) return NaN;
  if (allDay) return Date.parse(`${s.slice(0, 10)}T00:00:00.000Z`);
  // A bare date (no time) is still accepted for a timed event; treat as midnight.
  return Date.parse(s.length <= 10 ? `${s}T00:00:00.000Z` : s);
}

export async function listEvents(deps: Deps, scope: ListScope | undefined, maxPageSize: number, pageToken?: string, showDeleted = false) {
  const all = visibleByDelete(await deps.db.select().from(schema.events).where(applyScope(scope, schema.events.code, schema.events.code)), showDeleted).sort(
    (a, b) => +new Date(a.createdAt) - +new Date(b.createdAt) || a.uuid.localeCompare(b.uuid),
  );
  const cur = decodeCursor(pageToken);
  const start = cur
    ? all.findIndex((e) => +new Date(e.createdAt) > cur.createTimeMs || (+new Date(e.createdAt) === cur.createTimeMs && e.uuid > cur.uid))
    : 0;
  const slice = start < 0 ? [] : all.slice(start, start + maxPageSize);
  const last = slice[slice.length - 1];
  const nextPageToken = start >= 0 && start + maxPageSize < all.length && last ? encodeCursor(+new Date(last.createdAt), last.uuid) : undefined;
  return { items: slice, nextPageToken };
}

export async function getEvent(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.events).where(eq(schema.events.uuid, id)).limit(1))[0];
  if (!row) throw notFound("event not found");
  return row;
}

export async function createEvent(deps: Deps, actor: AppUser, input: EventInput, id?: string) {
  const title = (input.title ?? "").trim();
  if (!title) throw invalidArgument("title is required");
  const allDay = input.all_day !== false; // default to all-day
  const start = parseTime(input.start_time, allDay);
  const end = parseTime(input.end_time, allDay);
  if (Number.isNaN(start) || Number.isNaN(end)) throw invalidArgument("start_time and end_time are required");
  if (end < start) throw invalidArgument("end_time must be on or after start_time");
  const row = (await deps.db
    .insert(schema.events)
    .values({
      code: await allocFlatCode(deps, schema.events),
      ...(id ? { id } : {}),
      title,
      startTime: new Date(start),
      endTime: new Date(end),
      allDay,
      countAsWork: !!input.count_as_work,
      color: input.color ?? null,
      description: input.description ?? null,
      attendeeIds: attendeesJson(input.attendees),
    })
    .returning())[0]!;
  await audit(deps, actor, "event.create", "events", row.uuid, undefined, row);
  return row;
}

export async function updateEvent(deps: Deps, actor: AppUser, id: string, patch: EventInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.events).where(eq(schema.events.uuid, id)).limit(1))[0];
  if (!row) throw notFound("event not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const has = (k: keyof EventInput) => Object.prototype.hasOwnProperty.call(patch, k);
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (has("title")) {
    const title = (patch.title ?? "").trim();
    if (!title) throw invalidArgument("title cannot be empty");
    set.title = title;
  }
  if (has("color")) set.color = patch.color ?? null;
  if (has("description")) set.description = patch.description ?? null;
  if (has("count_as_work")) set.countAsWork = !!patch.count_as_work;
  if (has("attendees")) set.attendeeIds = attendeesJson(patch.attendees);
  // all_day may change alongside the times; resolve the effective flag then re-parse any supplied bound.
  const allDay = has("all_day") ? patch.all_day !== false : row.allDay;
  if (has("all_day")) set.allDay = allDay;
  if (has("start_time") || has("end_time") || has("all_day")) {
    const start = has("start_time") ? parseTime(patch.start_time, allDay) : +new Date(row.startTime);
    const end = has("end_time") ? parseTime(patch.end_time, allDay) : +new Date(row.endTime);
    if (Number.isNaN(start) || Number.isNaN(end)) throw invalidArgument("start_time and end_time must be valid");
    if (end < start) throw invalidArgument("end_time must be on or after start_time");
    set.startTime = new Date(start);
    set.endTime = new Date(end);
  }
  const updated = (await deps.db.update(schema.events).set(set).where(eq(schema.events.uuid, id)).returning())[0]!;
  await audit(deps, actor, "event.update", "events", id, diffMeta(row, updated, set), updated);
  return updated;
}

export async function deleteEvent(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await softDeleteRow(deps, actor, schema.events, "event", "events", id, ifMatch);
}

export async function restoreEvent(deps: Deps, actor: AppUser, id: string) {
  return restoreRow(deps, actor, schema.events, "event", "events", id);
}

export async function purgeEvent(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await purgeRow(deps, actor, schema.events, "event", "events", id, ifMatch);
}

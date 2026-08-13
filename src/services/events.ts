// Company events (holidays' timed sibling): all-day or timed, optionally counting as work for attendees.
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { invalidArgument } from "../lib/errors";
import { visibleByDelete } from "./softDelete";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import { encodeCursor, decodeCursor } from "../http/pagination";
import { has, type CrudSpec, type SetOf } from "./crud";

export type EventInput = {
  title?: string;
  start_time?: string; // ISO instant, or YYYY-MM-DD for an all-day event
  end_time?: string;
  all_day?: boolean;
  count_as_work?: boolean;
  requires_clock_in?: boolean; // only meaningful with count_as_work: credit only attendees who punched that day
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

// Scope-filtered in SQL (an event can be shared to a department), then paged like any other collection.
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

export const eventSpec: CrudSpec<EventInput, typeof schema.events> = {
  table: schema.events,
  collection: "events",
  auditName: "event",
  notFound: "event not found",
  insert: (input) => {
    const title = (input.title ?? "").trim();
    if (!title) throw invalidArgument("title is required");
    const allDay = input.all_day !== false; // default to all-day
    const start = parseTime(input.start_time, allDay);
    const end = parseTime(input.end_time, allDay);
    if (Number.isNaN(start) || Number.isNaN(end)) throw invalidArgument("start_time and end_time are required");
    if (end < start) throw invalidArgument("end_time must be on or after start_time");
    return {
      title,
      startTime: new Date(start),
      endTime: new Date(end),
      allDay,
      countAsWork: !!input.count_as_work,
      requiresClockIn: !!input.requires_clock_in,
      color: input.color ?? null,
      description: input.description ?? null,
      attendeeIds: attendeesJson(input.attendees),
    };
  },
  patch: (patch, row) => {
    const set: SetOf<typeof schema.events> = {};
    if (has(patch, "title")) {
      const title = (patch.title ?? "").trim();
      if (!title) throw invalidArgument("title cannot be empty");
      set.title = title;
    }
    if (has(patch, "color")) set.color = patch.color ?? null;
    if (has(patch, "description")) set.description = patch.description ?? null;
    if (has(patch, "count_as_work")) set.countAsWork = !!patch.count_as_work;
    if (has(patch, "requires_clock_in")) set.requiresClockIn = !!patch.requires_clock_in;
    if (has(patch, "attendees")) set.attendeeIds = attendeesJson(patch.attendees);
    // all_day may change alongside the times; resolve the effective flag then re-parse any supplied bound.
    const allDay = has(patch, "all_day") ? patch.all_day !== false : row.allDay;
    if (has(patch, "all_day")) set.allDay = allDay;
    if (has(patch, "start_time") || has(patch, "end_time") || has(patch, "all_day")) {
      const start = has(patch, "start_time") ? parseTime(patch.start_time, allDay) : +new Date(row.startTime);
      const end = has(patch, "end_time") ? parseTime(patch.end_time, allDay) : +new Date(row.endTime);
      if (Number.isNaN(start) || Number.isNaN(end)) throw invalidArgument("start_time and end_time must be valid");
      if (end < start) throw invalidArgument("end_time must be on or after start_time");
      set.startTime = new Date(start);
      set.endTime = new Date(end);
    }
    return set;
  },
};


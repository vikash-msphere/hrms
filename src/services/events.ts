// Company events (holidays' timed sibling): all-day or timed, optionally counting as work for attendees.
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { invalidArgument, notFound } from "../lib/errors";
import { visibleByDelete } from "./softDelete";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import { paginate } from "../http/pagination";
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
  repeat?: EventRepeat | null; // weekly / monthly / yearly; the cron rolls the series forward one at a time
};
export type EventRepeat = "weekly" | "monthly" | "yearly";

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
  const all = visibleByDelete(await deps.db.select().from(schema.events).where(applyScope(scope, schema.events.code, schema.events.code)), showDeleted);
  return paginate(all, maxPageSize, pageToken, (r) => +new Date(r.createdAt), (r) => r.uuid);
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
      color: input.color?.trim() || null,
      description: input.description?.trim() || null,
      attendeeIds: attendeesJson(input.attendees),
      repeat: input.repeat ?? null,
    };
  },
  patch: (patch, row) => {
    const set: SetOf<typeof schema.events> = {};
    if (has(patch, "title")) {
      const title = (patch.title ?? "").trim();
      if (!title) throw invalidArgument("title cannot be empty");
      set.title = title;
    }
    if (has(patch, "color")) set.color = patch.color?.trim() || null;
    if (has(patch, "description")) set.description = patch.description?.trim() || null;
    if (has(patch, "count_as_work")) set.countAsWork = !!patch.count_as_work;
    if (has(patch, "requires_clock_in")) set.requiresClockIn = !!patch.requires_clock_in;
    if (has(patch, "attendees")) set.attendeeIds = attendeesJson(patch.attendees);
    if (has(patch, "repeat")) set.repeat = patch.repeat ?? null;
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
  // An event's answers travel with it, so a reader always knows who is coming without a second request.
  decorate: async (deps, actor, rows) => withResponses(deps, actor, rows),
};

// Fold each event's RSVPs into the rows: the tally everyone sees, plus the caller's own answer so the buttons
// can show which one is theirs. One query per page, in the shape `decorate` is for.
export async function withResponses(deps: Deps, actor: AppUser | undefined, rows: any[]): Promise<any[]> {
  const ids = rows.map((r) => r.uuid);
  if (!ids.length) return rows;
  const all = await deps.db.select().from(schema.eventResponses).where(inArray(schema.eventResponses.eventId, ids));
  const byEvent = new Map<string, typeof all>();
  for (const r of all) byEvent.set(r.eventId, [...(byEvent.get(r.eventId) ?? []), r]);
  return rows.map((row) => {
    const list = byEvent.get(row.uuid) ?? [];
    return {
      ...row,
      _responses: list,
      _myResponse: actor?.employeeId ? list.find((r) => r.employeeId === actor.employeeId) : undefined,
    };
  });
}

/**
 * The `respond` verb: an attendee saying whether they are coming.
 *
 * Being on the attendee list says an event was aimed at you. It never said you would be there - so an organiser
 * counting heads for an off-site was counting a list nobody had confirmed, and `count_as_work` was crediting
 * attendance to people who had already said no.
 *
 * Answering twice replaces the answer rather than adding one (the unique index says one per person per event),
 * and only people the event is actually aimed at may answer - an RSVP from someone who was never invited is
 * noise on the organiser's list.
 */
export async function respondToEvent(deps: Deps, actor: AppUser, id: string, response: "going" | "maybe" | "declined", note?: string | null) {
  const row = (await deps.db.select().from(schema.events).where(eq(schema.events.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("event not found");
  if (!actor.employeeId) throw invalidArgument("only an employee can answer an event");
  let attendees: string[] = [];
  try {
    attendees = row.attendeeIds ? (JSON.parse(row.attendeeIds) as string[]) : [];
  } catch {
    attendees = [];
  }
  // An event with no list is a company-wide one: anyone who can see it may answer.
  if (attendees.length && !attendees.includes(actor.employeeId)) throw invalidArgument("you are not on this event's attendee list");
  const existing = (await deps.db
    .select()
    .from(schema.eventResponses)
    .where(and(eq(schema.eventResponses.eventId, id), eq(schema.eventResponses.employeeId, actor.employeeId)))
    .limit(1))[0];
  const text = note?.trim() || null;
  if (existing) await deps.db.update(schema.eventResponses).set({ response, note: text, updatedAt: new Date() }).where(eq(schema.eventResponses.uuid, existing.uuid));
  else await deps.db.insert(schema.eventResponses).values({ eventId: id, employeeId: actor.employeeId, response, note: text });
  await audit(deps, actor, "event.respond", "events", id, { response, ...(text ? { note: text } : {}) });
  const [decorated] = await withResponses(deps, actor, [row]);
  return decorated;
}

/**
 * One step of a repeating event, in the calendar's own terms: a weekly all-hands lands on the same weekday, a
 * monthly one on the same date, a yearly one on the same date next year. Returns the new start and end, keeping
 * the event's own length.
 *
 * Shared with the web so the form can show the dates a repeat will produce before it is saved - the mirror is
 * pinned by test/eventRepeat.test.ts.
 */
export function nextOccurrence(startMs: number, endMs: number, repeat: EventRepeat): { start: number; end: number } {
  const span = endMs - startMs;
  const d = new Date(startMs);
  if (repeat === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  else if (repeat === "monthly") d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  return { start: +d, end: +d + span };
}


// Company holidays: org-wide reference. `fixed` holidays apply to everyone; an `optional` one is picked per
// employee (holiday-selections), and a caller's own pick rides on the row as `selected`/`selection`.
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { invalidArgument } from "../lib/errors";
import { crudService, has, type CrudSpec, type SetOf } from "./crud";

export type HolidayInput = {
  display_name?: string;
  date?: string;
  kind?: "fixed" | "optional";
  location?: string | null;
  half_day?: boolean;
};

/** Free-text locations compare loosely - "Mumbai" and " mumbai " are the same office. */
const normLocation = (s?: string | null) => (s ?? "").trim().toLowerCase();

// A holiday is a calendar DAY, stored at UTC midnight so it is the same day for every reader.
function dayOf(date: string): Date {
  const ms = Date.parse(date + "T00:00:00Z");
  if (Number.isNaN(ms)) throw invalidArgument("date must be YYYY-MM-DD");
  return new Date(ms);
}

// Map of optional-holiday id -> the caller's selection id (empty for non-employees).
async function selectedIds(deps: Deps, actor: AppUser): Promise<Map<string, string>> {
  if (!actor.employeeId) return new Map();
  const rows = await deps.db
    .select()
    .from(schema.holidaySelections)
    .where(eq(schema.holidaySelections.employeeId, actor.employeeId));
  return new Map(rows.map((r) => [r.holidayId, r.uuid]));
}

/** The caller's current work location, from their open position row (null when they have none). */
export async function actorLocation(deps: Deps, actor: AppUser): Promise<string | null> {
  if (!actor.employeeId) return null;
  const rows = await deps.db
    .select({ location: schema.positions.location, effectiveTo: schema.positions.effectiveTo })
    .from(schema.positions)
    .where(eq(schema.positions.employeeId, actor.employeeId));
  const current = rows.find((r) => !r.effectiveTo);
  return current?.location ?? null;
}

/** Does a location-scoped holiday apply to someone working at `where`? Unscoped holidays apply to all. */
export const holidayApplies = (holidayLocation: string | null | undefined, where: string | null): boolean =>
  !normLocation(holidayLocation) || normLocation(holidayLocation) === normLocation(where);

export const holidaySpec: CrudSpec<HolidayInput, typeof schema.holidays> = {
  table: schema.holidays,
  collection: "holidays",
  auditName: "holiday",
  notFound: "holiday not found",
  insert: (input) => {
    if (!input.display_name) throw invalidArgument("display_name is required");
    if (!input.date) throw invalidArgument("date is required");
    return {
      name: input.display_name,
      date: dayOf(input.date),
      kind: input.kind ?? "fixed",
      location: input.location?.trim() || null,
      halfDay: !!input.half_day,
    };
  },
  patch: (patch) => {
    const set: SetOf<typeof schema.holidays> = {};
    if (has(patch, "display_name")) set.name = patch.display_name;
    if (has(patch, "kind")) set.kind = patch.kind;
    if (has(patch, "date") && patch.date) set.date = dayOf(patch.date);
    // An empty location clears the scope back to company-wide, so "" and null both mean everyone.
    if (has(patch, "location")) set.location = patch.location?.trim() || null;
    if (has(patch, "half_day")) set.halfDay = !!patch.half_day;
    return set;
  },
  decorate: async (deps, actor, rows) => {
    const picked = await selectedIds(deps, actor);
    const where = await actorLocation(deps, actor);
    return rows.map((h) => ({
      ...h,
      selected: picked.has(h.uuid),
      selectionId: picked.get(h.uuid),
      // Only meaningful for location-scoped rows; unscoped ones apply to everyone and say nothing.
      applies: h.location ? holidayApplies(h.location, where) : undefined,
    }));
  },
};

export const { list: listHolidays } = crudService(holidaySpec);

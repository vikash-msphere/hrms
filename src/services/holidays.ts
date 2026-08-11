// Company holidays: org-wide reference. `fixed` holidays apply to everyone; an `optional` one is picked per
// employee (holiday-selections), and a caller's own pick rides on the row as `selected`/`selection`.
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { invalidArgument } from "../lib/errors";
import { crudService, has, type CrudSpec } from "./crud";

export type HolidayInput = { display_name?: string; date?: string; kind?: "fixed" | "optional" };

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

export const holidaySpec: CrudSpec<HolidayInput> = {
  table: schema.holidays,
  collection: "holidays",
  auditName: "holiday",
  notFound: "holiday not found",
  insert: (input) => {
    if (!input.display_name) throw invalidArgument("display_name is required");
    if (!input.date) throw invalidArgument("date is required");
    return { name: input.display_name, date: dayOf(input.date), kind: input.kind ?? "fixed" };
  },
  patch: (patch) => {
    const set: Record<string, unknown> = {};
    if (has(patch, "display_name")) set.name = patch.display_name;
    if (has(patch, "kind")) set.kind = patch.kind;
    if (has(patch, "date") && patch.date) set.date = dayOf(patch.date);
    return set;
  },
  decorate: async (deps, actor, rows) => {
    const picked = await selectedIds(deps, actor);
    return rows.map((h) => ({ ...h, selected: picked.has(h.uuid), selectionId: picked.get(h.uuid) }));
  },
};

export const {
  list: listHolidays,
  get: getHoliday,
  create: createHoliday,
  update: updateHoliday,
  remove: deleteHoliday,
  restore: restoreHoliday,
  purge: purgeHoliday,
} = crudService(holidaySpec);

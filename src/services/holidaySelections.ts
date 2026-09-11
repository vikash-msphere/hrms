import { allocOwnedCode } from "./codeAlloc";
import { and, eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, removedMeta } from "../lib/audit";
import { invalidArgument, notFound, forbidden, failedPrecondition } from "../lib/errors";
import { getSettingValue } from "./settings";
import { paginate } from "../http/pagination";
import { refHolidays } from "../lib/refData";

const DEFAULT_POLICY = { max_optional: 2 };
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);

// The caller's own holiday picks.
export async function listHolidaySelections(deps: Deps, actor: AppUser, maxPageSize = 50, pageToken?: string) {
  if (!actor.employeeId) return { items: [], nextPageToken: undefined };
  const rows = await deps.db.select().from(schema.holidaySelections).where(eq(schema.holidaySelections.employeeId, actor.employeeId));
  return paginate(rows, maxPageSize, pageToken, (r) => +new Date(r.createdAt), (r) => r.uuid, "desc", { codec: deps.idCodec, collection: "holiday-selections" });
}

export async function getHolidaySelection(deps: Deps, actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.holidaySelections).where(eq(schema.holidaySelections.uuid, id)).limit(1))[0];
  if (!row || row.employeeId !== actor.employeeId) throw notFound("selection not found");
  return row;
}

// Opt into an optional holiday, capped at the org max_optional setting.
export async function createHolidaySelection(deps: Deps, actor: AppUser, holidayPath?: string | null) {
  if (!actor.employeeId) throw invalidArgument("only employees with a linked record can select holidays");
  const holidayId = idFromPath(holidayPath);
  if (!holidayId) throw invalidArgument("holiday is required");
  const h = (await deps.db.select().from(schema.holidays).where(eq(schema.holidays.uuid, holidayId)).limit(1))[0];
  if (!h || h.deleteTime) throw notFound("holiday not found");
  if (h.kind !== "optional") throw failedPrecondition("only optional holidays can be selected");
  if (h.disabled) throw failedPrecondition("this holiday is not available");

  const existing = (
    await deps.db
      .select()
      .from(schema.holidaySelections)
      .where(and(eq(schema.holidaySelections.employeeId, actor.employeeId), eq(schema.holidaySelections.holidayId, holidayId)))
      .limit(1)
  )[0];
  if (existing) return existing;

  // The allowance is per CALENDAR YEAR of the holiday being picked: an all-time cap would mean nobody could
  // pick anything in year two. Only this year's picks count against this year's allowance.
  const { max_optional } = await getSettingValue(deps, "holidays", DEFAULT_POLICY);
  const year = new Date(h.date).getUTCFullYear();
  const mine = await deps.db.select().from(schema.holidaySelections).where(eq(schema.holidaySelections.employeeId, actor.employeeId));
  const byId = new Map((await refHolidays(deps)).map((row) => [row.uuid, row]));
  const thisYear = mine.filter((s) => {
    const picked = byId.get(s.holidayId);
    return picked && new Date(picked.date).getUTCFullYear() === year;
  });
  if (thisYear.length >= max_optional)
    throw failedPrecondition(`you can select at most ${max_optional} optional holiday${max_optional === 1 ? "" : "s"} in ${year}`);
  const [row] = await deps.db.insert(schema.holidaySelections).values({ code: await allocOwnedCode(deps, schema.holidaySelections, schema.holidaySelections.employeeId, actor.employeeId), employeeId: actor.employeeId, holidayId }).returning();
  // WHICH holiday. A selection row is nothing but its two foreign keys, so an entry without them says only
  // that a person picked something.
  await audit(deps, actor, "holiday.select", "holiday-selections", row!.uuid, { diff: { holiday: { from: null, to: byId.get(holidayId)?.name ?? `holidays/${holidayId}` } } }, row);
  return row!;
}

export async function deleteHolidaySelection(deps: Deps, actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.holidaySelections).where(eq(schema.holidaySelections.uuid, id)).limit(1))[0];
  if (!row) throw notFound("selection not found");
  if (row.employeeId !== actor.employeeId) throw forbidden("not your selection");
  await deps.db.delete(schema.holidaySelections).where(eq(schema.holidaySelections.uuid, id));
  // Hard delete: the row is gone, so which holiday was given up survives only here.
  await audit(deps, actor, "holiday.deselect", "holiday-selections", id, removedMeta(row, "holiday-selections"), row);
}

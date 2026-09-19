import { and, eq, gte, isNotNull, isNull, lte } from "drizzle-orm";
import { allocOwnedCode, withFreshCode } from "./codeAlloc";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { notify } from "./notifications";
import { emitEvent } from "./eventBus";
import { getSettingValue } from "./settings";
import { refHolidays } from "../lib/refData";
import { DEFAULT_ATTENDANCE, type AttendanceConfig, type DayCredit, utcDay, weekdayOf } from "../domain/attendance";
import { invalidArgument, failedPrecondition } from "../lib/errors";
import { keysetPage } from "./keysetPage";
import { softDeleteRow } from "./softDelete";

// Attendance day marks: HR decides what ONE day is worth, and payroll settles up on that instead of on the
// minutes punched. See the table's own note in db/schema.ts for why this is a separate thing from a
// regularization, and domain/attendance.ts#lopDayUnits for what the credit does.

export type DayMarkInput = {
  employee?: string | null;
  date?: string; // YYYY-MM-DD
  credit?: string;
  reason?: string | null;
};

const CREDITS: DayCredit[] = ["full", "half", "absent"];
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string) => (s ? Date.parse(s + "T00:00:00Z") : NaN);

/**
 * Refuse a day the payroll rule would never look at. `lopDayUnits` skips non-working days and holidays on its
 * first line, so a mark on a Sunday is not a lenient mark - it is a row that silently does nothing, which is
 * worse than a refusal because it reads on the record as a decision that was made. The same two facts the
 * payroll build reads decide it here.
 */
/**
 * NOT ON YOUR OWN DAY, whatever the grant says.
 *
 * A mark decides what a day is PAID as, so the org-wide write HR holds (`attendance-day-marks.**`) covers
 * their own rows by construction - and the policy note beside the self tier says the quiet part: a self-scoped
 * rule here "would be a grant to re-value your own attendance" (domain/grants.ts). A broad rule hands out
 * exactly that. So the refusal is structural, like the maker-checker on a tax verification
 * (services/taxDetails.ts): somebody else with the grant decides the day, and the trail names them.
 *
 * Both ways in need it - making a mark (here) and changing one (the route's `beforeUpdate`, which is where
 * the row's owner is known) - because either one alone leaves the other as the way round.
 */
export function assertSomebodyElse(actor: AppUser, employeeId: string) {
  if (actor.employeeId && actor.employeeId === employeeId) {
    throw failedPrecondition("a day mark must be decided by somebody else - re-valuing your own day is a decision about your own pay");
  }
}

async function assertOwedDay(deps: Deps, dateMs: number) {
  const att = (await getSettingValue<AttendanceConfig>(deps, "attendance", DEFAULT_ATTENDANCE)) ?? DEFAULT_ATTENDANCE;
  const workDays = att.work_days ?? DEFAULT_ATTENDANCE.work_days;
  const ymd = utcDay(dateMs);
  if (!workDays.includes(weekdayOf(ymd))) throw invalidArgument("that day is not a working day, so nothing is owed on it to mark");
  const holiday = (await refHolidays(deps)).find((h) => !h.deleteTime && !h.disabled && utcDay(+new Date(h.date)) === ymd);
  if (holiday) throw invalidArgument("that day is a holiday, so nothing is owed on it to mark");
}

/**
 * `?employee=` narrows to one person and `?from`/`?to` to a window - the same two filters every attendance
 * surface already passes. Both narrow what the scope allows and neither widens it: `applyScope` is ANDed in
 * regardless, so naming somebody the caller cannot see answers with nothing.
 */
export async function listDayMarks(
  deps: Deps,
  scope: ListScope,
  maxPageSize: number,
  pageToken?: string,
  filters: { employeeId?: string; from?: string; to?: string; showDeleted?: boolean; deletedOnly?: boolean } = {},
) {
  const conds = [applyScope(scope, schema.attendanceDayMarks.code, schema.attendanceDayMarks.employeeId)];
  // A WITHDRAWN MARK IS NOT A MARK, and this list is what the attendance grid draws its badges from - so a
  // list that kept soft-deleted rows left the badge on a day whose mark had been removed, saying the day was
  // counted in a way payroll no longer counts it. `marksForPeriod` has always filtered them; this is the same
  // rule on the read the browser makes, with the lane's own `?show_deleted` / `?deleted_only` honoured so the
  // trail is still reachable.
  if (filters.deletedOnly) conds.push(isNotNull(schema.attendanceDayMarks.deleteTime));
  else if (!filters.showDeleted) conds.push(isNull(schema.attendanceDayMarks.deleteTime));
  if (filters.employeeId) conds.push(eq(schema.attendanceDayMarks.employeeId, filters.employeeId));
  const from = dayMs(filters.from);
  const to = dayMs(filters.to);
  if (!Number.isNaN(from)) conds.push(gte(schema.attendanceDayMarks.date, new Date(from)));
  if (!Number.isNaN(to)) conds.push(lte(schema.attendanceDayMarks.date, new Date(to)));
  return keysetPage<typeof schema.attendanceDayMarks.$inferSelect>(
    deps,
    schema.attendanceDayMarks,
    "attendance-day-marks",
    and(...(conds.filter(Boolean) as never[])),
    { max: maxPageSize, pageToken },
  );
}

/**
 * The live marks for a window, as payroll reads them: employee -> day -> credit.
 *
 * Bound in SQL to the period, and soft-deleted rows excluded - a withdrawn mark is not a mark, the same way a
 * superseded punch is not a punch (services/payroll.ts says why that one matters).
 */
export async function marksForPeriod(deps: Deps, startMs: number, endMs: number): Promise<Map<string, Map<string, DayCredit>>> {
  const out = new Map<string, Map<string, DayCredit>>();
  for (const m of await deps.db
    .select()
    .from(schema.attendanceDayMarks)
    .where(and(
      isNull(schema.attendanceDayMarks.deleteTime),
      gte(schema.attendanceDayMarks.date, new Date(startMs)),
      lte(schema.attendanceDayMarks.date, new Date(endMs)),
    ))) {
    let byDay = out.get(m.employeeId);
    if (!byDay) out.set(m.employeeId, (byDay = new Map<string, DayCredit>()));
    byDay.set(utcDay(+new Date(m.date)), m.credit);
  }
  return out;
}

export async function createDayMark(deps: Deps, actor: AppUser, input: DayMarkInput) {
  const date = dayMs(input.date);
  if (Number.isNaN(date)) throw invalidArgument("date is required");
  const credit = input.credit as DayCredit | undefined;
  if (!credit || !CREDITS.includes(credit)) throw invalidArgument(`credit must be one of ${CREDITS.join(", ")}`);
  // NOT defaulted to the caller: a mark is about somebody else's day by construction, and defaulting it to
  // whoever is holding the pen is how an HR admin marks their own day by leaving a field out.
  const employeeId = idFromPath(input.employee);
  if (!employeeId) throw invalidArgument("employee is required");
  assertSomebodyElse(actor, employeeId);
  await assertOwedDay(deps, date);
  // Checked here for the message, enforced by `attmark_live_day_idx` for the race: two marks on one day is a
  // question payroll cannot answer, so the index is what actually holds and this only says so in words.
  const existing = (await deps.db
    .select({ uuid: schema.attendanceDayMarks.uuid })
    .from(schema.attendanceDayMarks)
    .where(and(
      eq(schema.attendanceDayMarks.employeeId, employeeId),
      eq(schema.attendanceDayMarks.date, new Date(date)),
      isNull(schema.attendanceDayMarks.deleteTime),
    ))
    .limit(1))[0];
  if (existing) throw failedPrecondition("that day is already marked - change or remove the existing mark");

  const ymd = utcDay(date);
  const row = (await withFreshCode(async () => deps.db
    .insert(schema.attendanceDayMarks)
    .values({
      code: await allocOwnedCode(deps, schema.attendanceDayMarks, schema.attendanceDayMarks.employeeId, employeeId),
      employeeId,
      date: new Date(date),
      credit,
      reason: input.reason?.trim() || null,
    })
    .returning()))[0]!;
  await audit(deps, actor, "attendance-day-mark.create", "attendance-day-marks", row.uuid, {
    employee: `employees/${employeeId}`, date: ymd, credit, ...(input.reason ? { reason: input.reason } : {}),
  }, row);
  // The person whose pay this changes is told, by the person who changed it. A day quietly re-valued by
  // somebody else is the one thing about this feature that would be worth complaining about.
  // `dayMark.*` is a registered notification category (domain/notificationConfig.ts) AND a registered event
  // type (domain/events.ts) - the same name in both, so the org's mute switch and the rule builder are
  // talking about the same thing. An unregistered category still delivers but appears in neither.
  await notify(deps, {
    recipient: employeeId,
    type: "dayMark.set",
    title: `${ymd} counted as ${LABEL[credit]}`,
    body: input.reason?.trim() || null,
    subject: `attendance-day-marks/${row.uuid}`,
    actorId: actor.employeeId ?? null,
  });
  await emitEvent(deps, actor, "dayMark.set", { subject: `attendance-day-marks/${row.uuid}`, employeeId, payload: { date: ymd, credit } });
  return row;
}

/** How a credit reads in a sentence - shared by the notification and the audit trail. */
const LABEL: Record<DayCredit, string> = { full: "a full day", half: "a half day", absent: "absent" };

/**
 * Tell the employee their day was RE-valued, wired as the collection's `afterUpdate` so it runs only once the
 * write has committed.
 *
 * Silent when only the reason was reworded: the point of the message is what the day is now worth, and one
 * that says nothing changed is the kind of noise that teaches people to mute the category.
 */
export async function notifyDayMarkChanged(
  deps: Deps,
  actor: AppUser,
  row: typeof schema.attendanceDayMarks.$inferSelect,
  before: typeof schema.attendanceDayMarks.$inferSelect,
): Promise<void> {
  if (row.credit === before.credit) return;
  const ymd = utcDay(+new Date(row.date));
  await notify(deps, {
    recipient: row.employeeId,
    type: "dayMark.set",
    title: `${ymd} now counted as ${LABEL[row.credit]}`,
    body: row.reason || null,
    subject: `attendance-day-marks/${row.uuid}`,
    actorId: actor.employeeId ?? null,
  });
  await emitEvent(deps, actor, "dayMark.set", { subject: `attendance-day-marks/${row.uuid}`, employeeId: row.employeeId, payload: { date: ymd, credit: row.credit } });
}

/**
 * Withdraw a mark: the day goes back to being judged on its punches, and the person is told THAT too.
 *
 * The lane has an `afterUpdate` hook but no `afterDelete`, so the delete is overridden to call the same
 * shared soft-delete (etag check, audit row, `delete_time`) and then say so. Left alone, somebody told their
 * day counted in full would be holding a notification that had quietly stopped being true - the same gap the
 * edit notification closes, on the one path that reaches the employee's pay by REMOVING a decision.
 */
export async function removeDayMark(deps: Deps, actor: AppUser, id: string, ifMatch?: string): Promise<void> {
  const before = (await deps.db.select().from(schema.attendanceDayMarks).where(eq(schema.attendanceDayMarks.uuid, id)).limit(1))[0];
  await softDeleteRow(deps, actor, schema.attendanceDayMarks, "attendance-day-mark", "attendance-day-marks", id, ifMatch);
  if (!before) return;
  const ymd = utcDay(+new Date(before.date));
  await notify(deps, {
    recipient: before.employeeId,
    type: "dayMark.set",
    title: `${ymd} is back to its clocked hours`,
    body: null,
    subject: `attendance-day-marks/${before.uuid}`,
    actorId: actor.employeeId ?? null,
  });
}

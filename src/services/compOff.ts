// Comp-off for holiday work: someone who worked a day the company was closed is owed that day back. The
// nightly tick looks at YESTERDAY (a full local day is over, so the punches are in), decides half or whole day
// from the same thresholds attendance uses, and credits the org's compensatory-off leave type.
//
// Opt-in (settings/holidays `comp_off_on_holiday_work`), because plenty of orgs pay overtime for this instead -
// and the overtime lane already exists. Nothing here is retroactive: it only ever looks at one day.
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { allocOwnedCodesFor } from "./codeAlloc";
import { byIdChunks, insertBatches, runBatchChecked, type BatchStmt, type CheckedStmt } from "../lib/dbBatch";
import { getSettingValue } from "./settings";
import { DEFAULT_ATTENDANCE, localDay, type AttendanceConfig } from "../domain/attendance";
import { holidayApplies } from "./holidays";
import { notifyMany } from "./notifications";
import { refLeaveTypes } from "../lib/refData";

const DAY_MS = 86_400_000;
const DEFAULT_TYPE_NAME = "Compensatory Off";

export type CompOffPolicy = { comp_off_on_holiday_work?: boolean; comp_off_leave_type?: string };

/** Leave days are stored in halves, so a credit lands on the same increment the rest of the module uses. */
const toHalfDays = (n: number): number => Math.round(n * 2) / 2;

/**
 * Credit comp-off to everyone who worked yesterday's holiday. Returns how many employees were credited.
 * Idempotent: the comp_off_credits row (unique per employee+day) is written first and the balance moves only
 * when that insert wins, so a re-run credits nobody twice.
 */
export async function creditHolidayCompOff(deps: Deps): Promise<number> {
  const policy = await getSettingValue<CompOffPolicy>(deps, "holidays", {});
  if (!policy.comp_off_on_holiday_work) return 0;
  const att = await getSettingValue<AttendanceConfig>(deps, "attendance", DEFAULT_ATTENDANCE);
  const tz = att.timezone || "Asia/Kolkata";
  const ymd = localDay(+deps.clock.now() - DAY_MS, tz);
  const dayMs = Date.parse(ymd + "T00:00:00Z");

  const holidays = (await deps.db.select().from(schema.holidays).where(eq(schema.holidays.date, new Date(dayMs)))).filter(
    (h) => !h.deleteTime && !h.disabled,
  );
  if (!holidays.length) return 0;

  const typeName = policy.comp_off_leave_type?.trim() || DEFAULT_TYPE_NAME;
  const leaveType = (await refLeaveTypes(deps)).find(
    (t) => t.name.trim().toLowerCase() === typeName.toLowerCase() && !t.deleteTime && !t.disabled,
  );
  // No comp-off leave type to credit into is a configuration gap, not an error to throw at 2am.
  if (!leaveType) {
    console.warn(`comp-off: no leave type named "${typeName}"; nothing credited for ${ymd}`);
    return 0;
  }

  // Punches for the local day. The window is generous (the day ± one) and then filtered by local day, so a
  // timezone offset can't clip an early or late shift.
  const sessions = (
    await deps.db
      .select()
      .from(schema.attendanceSessions)
      .where(and(gte(schema.attendanceSessions.clockIn, new Date(dayMs - DAY_MS)), lte(schema.attendanceSessions.clockIn, new Date(dayMs + 2 * DAY_MS))))
  ).filter((s) => !s.supersededBy && s.clockOut && localDay(+new Date(s.clockIn), tz) === ymd);
  if (!sessions.length) return 0;

  const minutesByEmployee = new Map<string, number>();
  for (const s of sessions) {
    const worked = Math.max(0, Math.round((+new Date(s.clockOut!) - +new Date(s.clockIn)) / 60_000));
    minutesByEmployee.set(s.employeeId, (minutesByEmployee.get(s.employeeId) ?? 0) + worked);
  }

  // Which office each of them works at, so a regional holiday only credits the people it closed.
  const positions = await deps.db
    .select({ employeeId: schema.positions.employeeId, location: schema.positions.location, effectiveTo: schema.positions.effectiveTo })
    .from(schema.positions);
  const locationOf = new Map<string, string | null>();
  for (const p of positions) if (!p.effectiveTo) locationOf.set(p.employeeId, p.location ?? null);

  const full = att.full_day_minutes ?? DEFAULT_ATTENDANCE.full_day_minutes ?? 480;
  const half = att.half_day_minutes ?? DEFAULT_ATTENDANCE.half_day_minutes ?? 240;

  // ---- Plan the whole roster in memory, touching the database not at all -----------------------------------
  //
  // This walk used to do the writing as it went, and cost about ten subrequests per credited person: an owned-
  // code allocation (two) and a claim insert, then a balance read and a compare-and-set, then a whole `notify`
  // (the recipient read, another allocation, another insert). A holiday twenty people worked was two hundred
  // sequential round trips against a per-invocation ceiling (lib/dbBatch.ts) - in the nightly tick, as its
  // LAST subtask, after twenty-one others had already spent from the same budget. When it ran out, the loop
  // failed per employee, and the failure is not recoverable: the tick only ever looks at yesterday, so nobody
  // gets a second try at the day.
  //
  // Same three passes as the leave accrual next door (services/leaveAccrual.ts): plan, reserve every code in
  // one go, write once.
  type Credit = { employeeId: string; owed: number; holidayName: string; holidayId: string };
  const planned: Credit[] = [];
  for (const [employeeId, minutes] of minutesByEmployee) {
    const days = minutes >= full ? 1 : minutes >= half ? 0.5 : 0;
    if (!days) continue;
    // Two holidays can fall on one date (a company-wide half-day plus a location-specific full day). Prefer a
    // WHOLE-day match: the cap below is what a half-day holiday owes, so picking whichever row happened to come
    // back first would under-credit somebody who worked a full closed day.
    const applicable = holidays.filter((h) => holidayApplies(h.location, locationOf.get(employeeId) ?? null));
    const holiday = applicable.find((h) => !h.halfDay) ?? applicable[0];
    if (!holiday) continue; // the day was a working day for this employee - overtime's problem, not comp-off's
    // A half-day holiday only owes back the half the office was shut for.
    planned.push({ employeeId, owed: holiday.halfDay ? Math.min(days, 0.5) : days, holidayName: holiday.name, holidayId: holiday.uuid });
  }
  if (!planned.length) return 0;

  const workedDate = new Date(dayMs);
  // THE IDEMPOTENCY, now a read rather than a caught constraint violation. `comp_off_credits` is unique per
  // (employee, date), and the loop above relied on that insert failing to know a re-run had already credited
  // someone - which cannot work inside a batch, because a violation aborts every other employee's write with
  // it. One read says the same thing up front, and a genuine concurrent tick still hits the index and fails
  // the whole batch loudly (the cron wrapper turns that into a red `cron_runs` row) rather than half-crediting.
  const claimed = new Set(
    (
      await byIdChunks(planned.map((p) => p.employeeId), (group) =>
        deps.db
          .select({ employeeId: schema.compOffCredits.employeeId })
          .from(schema.compOffCredits)
          .where(and(eq(schema.compOffCredits.workedDate, workedDate), inArray(schema.compOffCredits.employeeId, group))))
    ).map((r) => r.employeeId),
  );
  const todo = planned.filter((p) => !claimed.has(p.employeeId));
  if (!todo.length) return 0;

  // The balance rows these credits land in - one read for the whole roster, where the loop read one per person.
  const balances = await byIdChunks(todo.map((p) => p.employeeId), (group) =>
    deps.db
      .select({ uuid: schema.leaveBalances.uuid, employeeId: schema.leaveBalances.employeeId, balanceDays: schema.leaveBalances.balanceDays })
      .from(schema.leaveBalances)
      .where(and(eq(schema.leaveBalances.leaveTypeId, leaveType.uuid), inArray(schema.leaveBalances.employeeId, group))));
  const balanceOf = new Map(balances.map((b) => [b.employeeId, b]));

  // Every code for the night in two reservations: one claim per person, plus a balance row for anyone who has
  // none of this leave type yet. Sequential rather than concurrent - two batches against the same D1 session.
  const creditCodes = await allocOwnedCodesFor(deps, schema.compOffCredits, schema.compOffCredits.employeeId, todo.map((p) => p.employeeId));
  const needBalance = todo.filter((p) => !balanceOf.has(p.employeeId));
  const balanceCodes = needBalance.length
    ? await allocOwnedCodesFor(deps, schema.leaveBalances, schema.leaveBalances.employeeId, needBalance.map((p) => p.employeeId))
    : new Map<string, string>();

  // ---- One write --------------------------------------------------------------------------------------
  const now = new Date();
  const stmts: (BatchStmt | CheckedStmt)[] = [];
  stmts.push(
    ...insertBatches(
      todo.map((p) => ({ code: creditCodes.get(p.employeeId)!, employeeId: p.employeeId, workedDate, days: p.owed, holidayId: p.holidayId })),
      (group) => deps.db.insert(schema.compOffCredits).values(group),
    ),
  );
  if (needBalance.length) {
    stmts.push(
      ...insertBatches(
        needBalance.map((p) => ({ code: balanceCodes.get(p.employeeId)!, employeeId: p.employeeId, leaveTypeId: leaveType.uuid, balanceDays: p.owed })),
        (group) => deps.db.insert(schema.leaveBalances).values(group),
      ),
    );
  }
  // Compare-and-set on the balance that was read, for the reason the accrual credit guards the same way: the
  // value written is ABSOLUTE and the snapshot above was taken before the batch, so writing it blind would undo
  // any debit committed in between (a leave approval landing during the tick) and hand back days the employee
  // has already spent. A guard that matches nothing is not an error - it means somebody else moved the row -
  // and `runBatchChecked` reports it by label so the claim can be released below.
  for (const p of todo) {
    const bal = balanceOf.get(p.employeeId);
    if (!bal) continue;
    stmts.push({
      label: p.employeeId,
      expect: 1,
      stmt: deps.db
        .update(schema.leaveBalances)
        .set({ balanceDays: toHalfDays(bal.balanceDays + p.owed), updatedAt: now })
        .where(and(eq(schema.leaveBalances.uuid, bal.uuid), eq(schema.leaveBalances.balanceDays, bal.balanceDays)))
        .returning({ uuid: schema.leaveBalances.uuid }),
    });
  }
  const short = new Set(await runBatchChecked(deps.db, stmts));

  // A claim whose balance did not move must not survive: the claim is what makes tomorrow's re-run skip this
  // person, so keeping it would lose the day for good. Released in one statement, not one per employee.
  if (short.size) {
    await deps.db
      .delete(schema.compOffCredits)
      .where(and(eq(schema.compOffCredits.workedDate, workedDate), inArray(schema.compOffCredits.employeeId, [...short])));
    console.warn(`comp-off: ${short.size} credit(s) for ${ymd} lost a race on the leave balance; claims released for the next run`);
  }

  const credited = todo.filter((p) => !short.has(p.employeeId));
  // One fan-out, not a `notify()` each: the wording differs per person (their holiday, their half or whole
  // day), which is exactly what `titleFor`/`bodyFor` exist for - see the note on notifyMany.
  const byId = new Map(credited.map((p) => [p.employeeId, p]));
  await notifyMany(deps, [...byId.keys()], {
    type: "leave.comp_off_credited",
    title: "Comp-off credited",
    link: "leave-requests",
    titleFor: (rid) => (byId.get(rid)?.owed === 1 ? "A day of comp-off credited" : "Half a day of comp-off credited"),
    bodyFor: (rid) => {
      const p = byId.get(rid);
      return p ? `You worked ${p.holidayName} on ${ymd}, so ${p.owed} day of ${leaveType.name} was added to your balance.` : null;
    },
  });
  return credited.length;
}

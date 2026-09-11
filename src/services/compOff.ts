// Comp-off for holiday work: someone who worked a day the company was closed is owed that day back. The
// nightly tick looks at YESTERDAY (a full local day is over, so the punches are in), decides half or whole day
// from the same thresholds attendance uses, and credits the org's compensatory-off leave type.
//
// Opt-in (settings/holidays `comp_off_on_holiday_work`), because plenty of orgs pay overtime for this instead -
// and the overtime lane already exists. Nothing here is retroactive: it only ever looks at one day.
import { and, eq, gte, lte } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { allocOwnedCode, withFreshCode, CODE_WIDTH } from "./codeAlloc";
import { isCompOffDuplicate } from "../lib/errors";
import { getSettingValue } from "./settings";
import { DEFAULT_ATTENDANCE, localDay, type AttendanceConfig } from "../domain/attendance";
import { holidayApplies } from "./holidays";
import { notify } from "./notifications";
import { refLeaveTypes } from "../lib/refData";

const DAY_MS = 86_400_000;
const DEFAULT_TYPE_NAME = "Compensatory Off";

export type CompOffPolicy = { comp_off_on_holiday_work?: boolean; comp_off_leave_type?: string };

/**
 * Add `owed` days to one employee's balance of one leave type, or create the balance row. Returns whether the
 * credit landed: the caller holds a written idempotency claim, so "the guard matched nothing" has to be
 * distinguishable from "credited" rather than looking like success.
 */
async function creditBalance(deps: Deps, employeeId: string, leaveTypeId: string, owed: number): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = (
      await deps.db
        .select()
        .from(schema.leaveBalances)
        .where(and(eq(schema.leaveBalances.employeeId, employeeId), eq(schema.leaveBalances.leaveTypeId, leaveTypeId)))
        .limit(1)
    )[0];
    if (!existing) {
      try {
        await deps.db.insert(schema.leaveBalances).values({
          code: await allocOwnedCode(deps, schema.leaveBalances, schema.leaveBalances.employeeId, employeeId),
          employeeId,
          leaveTypeId,
          balanceDays: owed,
        });
        return true;
      } catch {
        continue; // another writer created the row first - re-read and add to it
      }
    }
    // Compare-and-set on the balance we read, the same guard the accrual credit uses.
    const [updated] = await deps.db
      .update(schema.leaveBalances)
      .set({ balanceDays: Math.round((existing.balanceDays + owed) * 2) / 2, updatedAt: new Date() })
      .where(and(eq(schema.leaveBalances.uuid, existing.uuid), eq(schema.leaveBalances.balanceDays, existing.balanceDays)))
      .returning({ uuid: schema.leaveBalances.uuid });
    if (updated) return true;
  }
  return false;
}

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
  let credited = 0;

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
    const owed = holiday.halfDay ? Math.min(days, 0.5) : days;

    // Claim the day first. A duplicate (this employee, this date) means another run already credited it, and
    // that is the ONLY failure this skips on.
    //
    // It used to skip on every failure - `catch { continue }` - which read as "the duplicate case" and was in
    // fact three cases wearing one coat. A lost code race (two writes composing the same next code, the thing
    // `withFreshCode` exists for) was treated as "already credited" and the day was dropped; so was a
    // transient D1 error. Neither was logged, and neither gets a second chance: the tick credits YESTERDAY's
    // holiday, so there is no later run that would find this work again. A day of leave the employee earned
    // by working a holiday went missing with nothing anywhere to say so.
    try {
      await withFreshCode(async (attempt) => {
        // `attempt > 1` re-establishes this person's counter against what is actually on disk, the same
        // resync the notification insert does on a retry (services/notifications.ts).
        const code = await allocOwnedCode(deps, schema.compOffCredits, schema.compOffCredits.employeeId, employeeId, CODE_WIDTH.owned, attempt > 1);
        await deps.db.insert(schema.compOffCredits).values({
          code,
          employeeId,
          workedDate: new Date(dayMs),
          days: owed,
          holidayId: holiday.uuid,
        });
      });
    } catch (e) {
      if (isCompOffDuplicate(e)) continue; // already credited by an earlier run - the idempotency this relies on
      // Anything else is a real failure and the day is lost, so it has to be visible. Not rethrown: one
      // employee's credit failing must not abandon the rest of the roster.
      console.error(`comp-off: could not claim ${owed} day for ${employeeId} on ${ymd}`, e);
      continue;
    }

    // Move the balance, and only keep the claim if it actually moved. The credit row above is what makes a
    // re-run skip this employee, so a compare-and-set that quietly matched nothing (any concurrent write to the
    // same balance - a leave approval landing during the tick) would burn the claim and lose the day for good.
    // Retry on a lost race; release the claim if it still won't land, so tomorrow's tick tries again.
    if (!(await creditBalance(deps, employeeId, leaveType.uuid, owed))) {
      await deps.db.delete(schema.compOffCredits).where(and(eq(schema.compOffCredits.employeeId, employeeId), eq(schema.compOffCredits.workedDate, new Date(dayMs))));
      console.warn(`comp-off: could not credit ${owed} day to ${employeeId} for ${ymd}; claim released for the next run`);
      continue;
    }
    await notify(deps, {
      recipient: employeeId,
      type: "leave.comp_off_credited",
      title: `${owed === 1 ? "A day" : "Half a day"} of comp-off credited`,
      body: `You worked ${holiday.name} on ${ymd}, so ${owed} day of ${leaveType.name} was added to your balance.`,
      link: "leave-requests",
    });
    credited++;
  }
  return credited;
}

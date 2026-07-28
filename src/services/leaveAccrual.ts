import { and, eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { computeAccrual, roundToIncrement } from "../domain/leave";
import { allocOwnedCode } from "./codeAlloc";
import { getSettingValue } from "./settings";

// How accrued balances are rounded (settings/leave_accrual). "half" keeps balances in 0.5-day steps (the
// default - prorated joining months otherwise produce values like 2.41); "day" = whole days; "none" = exact.
const INCREMENT: Record<string, number> = { none: 0, half: 0.5, day: 1 };
async function accrualIncrement(deps: Deps): Promise<number> {
  const v = await getSettingValue<{ rounding?: string }>(deps, "leave_accrual", {});
  return INCREMENT[v.rounding ?? "half"] ?? 0.5;
}

// Credits each active employee's leave balance for every accruing leave type, prorating the joining month and
// skipping probation months for types not available during probation. Idempotent: only credits calendar
// months not yet recorded on the balance row. Pass `onlyLeaveTypeId` to (re)accrue a single type - used when a
// leave type's accrual rate changes, so the balance updates immediately instead of waiting for the daily cron.
export async function accrueLeave(deps: Deps, onlyLeaveTypeId?: string): Promise<number> {
  const now = Date.now();
  const inc = await accrualIncrement(deps);
  let credited = 0;
  const employees = await deps.db.select().from(schema.employees).where(eq(schema.employees.status, "active"));
  const leaveTypes = (await deps.db.select().from(schema.leaveTypes)).filter((lt) => !onlyLeaveTypeId || lt.uuid === onlyLeaveTypeId);
  for (const emp of employees) {
    if (emp.deleteTime || !emp.startDate) continue;
    const startMs = +new Date(emp.startDate);
    const endMs = emp.endDate ? +new Date(emp.endDate) : null;
    const probationEndMs = emp.probationEndDate ? +new Date(emp.probationEndDate) : null;
    for (const lt of leaveTypes) {
      if (!lt.accrualDaysPerYear || lt.deleteTime || lt.disabled) continue;
      const existing = (await deps.db
        .select()
        .from(schema.leaveBalances)
        .where(and(eq(schema.leaveBalances.employeeId, emp.uuid), eq(schema.leaveBalances.leaveTypeId, lt.uuid)))
        .limit(1))[0];
      const { add, newLastYm } = computeAccrual({
        accrualDaysPerYear: lt.accrualDaysPerYear,
        probationAccrualDaysPerYear: lt.probationAccrualDaysPerYear,
        startMs,
        endMs,
        probationEndMs,
        lastAccrualYm: existing?.lastAccrualYm ?? null,
        currentMs: now,
        frequency: lt.accrualFrequency === "semi_monthly" ? "semi_monthly" : "monthly",
      });
      if (existing) {
        // Round the resulting balance to the configured increment; also re-rounds (normalizes) an existing
        // balance even when no new month accrued, so a tidied policy fixes old values like 2.41 on the next run.
        const newBalance = roundToIncrement(existing.balanceDays + add, inc);
        if (newBalance === existing.balanceDays && newLastYm === existing.lastAccrualYm) continue; // nothing changed
        await deps.db
          .update(schema.leaveBalances)
          .set({ balanceDays: newBalance, lastAccrualYm: newLastYm, updatedAt: new Date() })
          .where(eq(schema.leaveBalances.uuid, existing.uuid));
        credited++;
      } else {
        if (add === 0 && newLastYm === null) continue; // employee hasn't started yet
        await deps.db.insert(schema.leaveBalances).values({ code: await allocOwnedCode(deps, schema.leaveBalances, schema.leaveBalances.employeeId, emp.uuid), employeeId: emp.uuid, leaveTypeId: lt.uuid, balanceDays: roundToIncrement(add, inc), lastAccrualYm: newLastYm });
        credited++;
      }
    }
  }
  return credited;
}

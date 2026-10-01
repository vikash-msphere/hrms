import { capAccrual, computeAccrual, hrmsPricingStartMs, ymOf, type AccrualFrequency } from "../../../src/domain/leave";
import { splitCarryForward } from "../../../src/domain/carryForward";
import type { Employee, LeaveBalance, LeaveType } from "@/types";
import { todayStr } from "@/lib/orgDay";

// What a balance card can promise about the future: the next credit, where the balance lands by 31 Dec, and
// how much of that never survives the year end. The arithmetic is the SERVER'S (src/domain/leave.ts accrual,
// src/domain/carryForward.ts split) imported directly rather than restated here - a forecast that disagrees
// with the cron that later runs it is worse than no forecast.

export type CarryForwardMode = { mode: "per_type" | "cumulative"; cumulativeCapDays: number | null; excess: "encash" | "forfeit" };
export const DEFAULT_CARRY_FORWARD: CarryForwardMode = { mode: "per_type", cumulativeCapDays: null, excess: "encash" };

export type BalanceForecast = {
  /** Days added by the next credit, and the date it lands (YYYY-MM-DD). Null when the type doesn't accrue. */
  next: { days: number; on: string } | null;
  /** Balance on 31 Dec if nothing more is taken. */
  yearEnd: number;
  /** Of that, what does NOT carry into next year. */
  excess: number;
  /** What happens to the excess: paid out (org policy "encash") or lost. */
  excessFate: "encash" | "forfeit";
};

const ymd = (d: Date) => d.toISOString().slice(0, 10);

// "Now", as UTC midnight of the ORG's calendar day.
//
// Every reader below takes its calendar parts off `now` with `getUTC*`, which made the whole module run on the
// UTC day - so on 1 January, before the org's offset from UTC had elapsed, the forecast projected to the
// PREVIOUS 31 December and the year's accrual walk covered the wrong year. Anchoring the default at the org's
// day keeps all of that arithmetic exactly as it is (it is deliberately UTC-anchored, matching how date-only
// values are stored across the schema) while making the DAY it starts from the one the rest of the app means.
const orgNow = () => new Date(`${todayStr()}T00:00:00Z`);

// The next date the accrual cron would credit this type: the 1st of next month, or - for semi-monthly - the
// next 1st/16th boundary.
function nextCreditDate(now: Date, frequency: AccrualFrequency): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  if (frequency === "semi_monthly" && now.getUTCDate() < 16) return ymd(new Date(Date.UTC(y, m, 16)));
  return ymd(new Date(Date.UTC(y, m + 1, 1)));
}

/** Each accrual credit so far this calendar year: the period it covered and what it added. */
export function accrualEntriesThisYear(
  type: LeaveType | undefined,
  employee: Employee | undefined,
  now = orgNow(),
): { on: string; days: number; label: string }[] {
  const annual = type?.accrual_days_per_year ?? 0;
  if (!annual) return [];
  const frequency: AccrualFrequency = type!.accrual_frequency === "semi_monthly" ? "semi_monthly" : "monthly";
  const startMs = employee?.start_date ? Date.parse(employee.start_date + "T00:00:00Z") : null;
  const probationEndMs = employee?.probation_end_date ? Date.parse(employee.probation_end_date + "T00:00:00Z") : null;
  const floorMs = employee?.tracked_from ? Date.parse(employee.tracked_from + "T00:00:00Z") : null;
  // A period before HRMS records start is the opening balance's (domain/leave.ts floorMs), so it is not listed
  // as an accrual here - the opening entry is what stands for it.
  const pricedFrom = hrmsPricingStartMs({ startMs, floorMs, frequency });
  const year = now.getUTCFullYear();
  const out: { on: string; days: number; label: string }[] = [];
  // Walk the year's credit dates up to today, asking the real accrual what each one added (the previous
  // period is marked credited, so every call answers for exactly one period - joining-month proration
  // included, since the employee's start date is passed through).
  const dates: Date[] = [];
  for (let m = 0; m <= now.getUTCMonth(); m++) {
    dates.push(new Date(Date.UTC(year, m, 1)));
    if (frequency === "semi_monthly") dates.push(new Date(Date.UTC(year, m, 16)));
  }
  for (const at of dates) {
    if (+at > +now) break;
    if (pricedFrom !== null && +at < pricedFrom) continue;
    const prev = new Date(+at - 86_400_000);
    const lastAccrualYm = frequency === "semi_monthly" ? `${ymOf(+prev)}-H${prev.getUTCDate() >= 16 ? 2 : 1}` : ymOf(+prev);
    const { add } = computeAccrual({
      accrualDaysPerYear: annual,
      probationAccrualDaysPerYear: type!.probation_accrual_days_per_year ?? 0,
      startMs,
      endMs: null,
      probationEndMs,
      lastAccrualYm,
      currentMs: +at,
      frequency,
      floorMs,
    });
    if (add > 0) out.push({ on: ymd(at), days: add, label: "Accrued" });
  }
  return out;
}

/** Forecast one balance row. Returns null when there is nothing to say (no accrual and nothing at risk). */
export function forecastBalance(
  balance: LeaveBalance,
  type: LeaveType | undefined,
  employee: Employee | undefined,
  caps: CarryForwardMode,
  now = orgNow(),
): BalanceForecast | null {
  if (!type) return null;
  const annual = type.accrual_days_per_year ?? 0;
  const frequency: AccrualFrequency = type.accrual_frequency === "semi_monthly" ? "semi_monthly" : "monthly";
  const startMs = employee?.start_date ? Date.parse(employee.start_date + "T00:00:00Z") : null;
  const probationEndMs = employee?.probation_end_date ? Date.parse(employee.probation_end_date + "T00:00:00Z") : null;
  const floorMs = employee?.tracked_from ? Date.parse(employee.tracked_from + "T00:00:00Z") : null;

  // Credits still to come this calendar year: run the real accrual from "everything up to now is credited"
  // through 31 Dec. Marking the CURRENT period as credited is what keeps the projection forward-looking.
  const yearEndMs = Date.UTC(now.getUTCFullYear(), 11, 31);
  const remaining = annual
    ? computeAccrual({
        accrualDaysPerYear: annual,
        probationAccrualDaysPerYear: type.probation_accrual_days_per_year ?? 0,
        startMs,
        endMs: null,
        probationEndMs,
        lastAccrualYm: frequency === "semi_monthly" ? `${ymOf(+now)}-H${now.getUTCDate() >= 16 ? 2 : 1}` : ymOf(+now),
        currentMs: yearEndMs,
        frequency,
        floorMs,
      }).add
    : 0;

  // One credit's worth, for the "next credit" line: the same call bounded to the next credit date.
  const nextOn = nextCreditDate(now, frequency);
  const nextDays = annual
    ? computeAccrual({
        accrualDaysPerYear: annual,
        probationAccrualDaysPerYear: type.probation_accrual_days_per_year ?? 0,
        startMs,
        endMs: null,
        probationEndMs,
        lastAccrualYm: frequency === "semi_monthly" ? `${ymOf(+now)}-H${now.getUTCDate() >= 16 ? 2 : 1}` : ymOf(+now),
        currentMs: Date.parse(nextOn + "T00:00:00Z"),
        frequency,
        floorMs,
      }).add
    : 0;

  // Both cut at the accrual cap, as the cron will cut them (domain/leave.ts capAccrual). Every credit still to
  // come is positive, so capping their sum once is the same as capping each in turn.
  const cap = type.accrual_cap_days ?? null;
  const capped = capAccrual(balance.balance_days, remaining, cap);
  const nextCapped = capAccrual(balance.balance_days, nextDays, cap);
  const yearEnd = Math.round((balance.balance_days + capped) * 100) / 100;
  // Cumulative mode shares ONE cap across every eligible type, so a per-type figure would be a guess - say
  // nothing about the excess rather than mis-state it. Per-type mode is the server's default.
  const excess =
    caps.mode === "cumulative" && type.carry_forward
      ? 0
      : splitCarryForward(yearEnd, !!type.carry_forward, type.carry_forward_cap_days ?? null).excess;

  if (!nextCapped && !excess) return null;
  return { next: nextCapped ? { days: nextCapped, on: nextOn } : null, yearEnd, excess, excessFate: caps.excess };
}

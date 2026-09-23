// PURE leave-encashment helpers. No DB/IO here - the service (src/services/leaveEncashments.ts) gathers the
// facts (balance, comp, FY-to-date encashed) and persists; this module owns the rate math + eligibility rules.
export type RateBasis = "base" | "gross";

import { round2 } from "./money";

// Per-day encashment rate from the chosen basis amount (base pay or monthly gross) and the divisor (default
// 30, matching the FnF settlement per-day basis). A non-positive divisor falls back to 30.
export function encashmentRatePerDay(basisAmount: number, divisor: number): number {
  return round2(basisAmount / (divisor > 0 ? divisor : 30));
}

// Total payout, rounded ONCE from the UNROUNDED per-day rate (days x basis / divisor). Multiplying a rounded
// per-day rate by days shaves paise (e.g. rate 3333.33 x 10 = 33333.30 vs the true 33333.33). The stored/shown
// per-day figure still comes from encashmentRatePerDay; only the payable amount must round once.
export function encashmentAmount(days: number, basisAmount: number, divisor: number): number {
  return round2((days * basisAmount) / (divisor > 0 ? divisor : 30));
}

export type EligibilityFacts = {
  encashable: boolean; // leave type opts in
  disabled: boolean; // leave type disabled
  days: number; // days requested
  balance: number; // current balance for (employee, leave type)
  minBalanceRetainedDays: number; // floor the balance may not be encashed below
  capDaysPerYear: number | null; // annual cap (null = uncapped)
  alreadyEncashedThisYear: number; // APPROVED+PAID days already committed this calendar year
};

// Returns null when the request is eligible, else a human-readable reason. The service maps a non-null
// result to a failedPrecondition error; keeping it pure makes every branch unit-testable.
export function encashmentEligibilityError(f: EligibilityFacts): string | null {
  if (!f.encashable || f.disabled) return "that leave type is not encashable";
  if (f.days > f.balance) return `insufficient leave balance (${f.balance} day(s) available)`;
  if (round2(f.balance - f.days) < f.minBalanceRetainedDays) {
    return `must retain at least ${f.minBalanceRetainedDays} day(s) of this leave type`;
  }
  if (f.capDaysPerYear != null && round2(f.alreadyEncashedThisYear + f.days) > f.capDaysPerYear) {
    return `annual encashment cap of ${f.capDaysPerYear} day(s) exceeded (${f.alreadyEncashedThisYear} already used)`;
  }
  return null;
}

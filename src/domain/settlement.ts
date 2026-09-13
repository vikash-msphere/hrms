// Pure full-and-final settlement (FnF) math. Given the assembled exit facts, it produces the settlement
// line items (earnings + deductions) and the net payable. No DB/IO here - the service (src/services/
// settlements.ts) gathers the facts and persists the snapshot; the FnF letter renders it.
// `taxable` is the CHARGEABLE slice of an earning, defaulting to the whole amount: a reimbursement is 0, and
// gratuity / leave encashment at exit are partly exempt (s.10(10) / s.10(10AA)). The FnF is salary income and
// usually the year's largest single payment, so the service withholds income tax on `totalTaxableEarnings`.
// `code` is the stable machine identity of a line the FnF itself produces (SALARY / ENCASH / GRATUITY / REIMB /
// NOTICE). Callers reading a specific line back - the ESI wage base needs the final month's salary - must match
// on it, never on the display `name`: "Salary" is also the prefix of the "Salary arrears" line the caller
// itself contributes, and matching by label picked up the wrong one and double-counted the arrears.
export type SettlementLine = { name: string; kind: "earning" | "deduction"; amount: number; taxable?: number; code?: string };

export type SettlementFacts = {
  monthlyGross: number; // base + recurring earnings (the monthly CTC-ish figure paid)
  basePay: number; // monthly base, used for the per-day rate
  daysWorkedInMonth: number; // days worked in the final (partial) month, clamped to the employment window
  daysInMonth: number; // days in that month
  lopDaysInFinalMonth?: number; // unexcused absence day-units inside that window (docked at the same per-day rate)
  leaveDays: number; // encashable leave balance
  encashBasis?: number; // monthly amount the per-day encashment rate derives from (default: basePay)
  encashDivisor?: number; // encashment per-day divisor (default: perDayDivisor)
  encashExempt?: number; // exempt slice of the encashment payout under s.10(10AA)
  noticeShortfallDays: number; // notice days not served (recovery)
  reimbursements: number; // approved-unpaid reimbursements
  perDayDivisor?: number; // per-day rate basis (default 30)
  gratuity?: { amount: number; exempt: number }; // statutory gratuity payable at exit + its s.10(10) exempt slice
  // Everything else the leaver is owed or owes at exit, priced by the caller: unpaid bonuses, approved-unpaid
  // encashments and overtime, unpaid salary arrears (earnings), and outstanding loan/advance balances plus the
  // statutory withholding (deductions). A terminated employee is in no payroll run, so if the FnF doesn't carry
  // these they are never paid - and an outstanding loan is never recovered.
  extraEarnings?: SettlementLine[];
  extraDeductions?: SettlementLine[];
};

export type Settlement = {
  lines: SettlementLine[];
  totalEarnings: number;
  totalTaxableEarnings: number;
  totalDeductions: number;
  net: number;
};

import { round2, sum2 } from "./money";

export function computeSettlement(f: SettlementFacts): Settlement {
  const div = f.perDayDivisor ?? 30;
  const lines: SettlementLine[] = [];

  // Final-month salary on the days actually WORKED: the caller clamps the window to employment (so a mid-month
  // joiner is not paid from the 1st) and passes the month's unexcused absence day-units, which are docked at the
  // same per-day rate rather than left on a wage the employee never earned.
  const lopDays = Math.max(0, f.lopDaysInFinalMonth ?? 0);
  // A month is the ceiling. `daysWorkedInMonth` is assembled by the caller from a settlement date and a month
  // start, and any disagreement between those two about which day (or which month) it is lands here as a
  // fraction ABOVE one - which pays more than the month's whole gross for a month, silently, on the largest
  // single payment most employees ever receive. The caller's arithmetic is exact now (services/settlements.ts
  // anchors the settlement day rather than using a wall-clock instant); this is the invariant said out loud,
  // so a future caller cannot reintroduce it. Clamped BEFORE loss of pay is taken off, so a docked day still
  // reduces the payout from a full month rather than from an inflated one.
  const workedDays = f.daysInMonth > 0 ? Math.min(f.daysWorkedInMonth, f.daysInMonth) : f.daysWorkedInMonth;
  const paidDays = Math.max(0, round2(workedDays - lopDays));
  const salary = f.daysInMonth > 0 ? round2((f.monthlyGross * paidDays) / f.daysInMonth) : 0;
  if (salary > 0) {
    const label = `Salary for ${round2(workedDays)} day(s)${lopDays > 0 ? ` less ${lopDays} day(s) loss of pay` : ""}`;
    lines.push({ code: "SALARY", name: label, kind: "earning", amount: salary });
  }

  // Round the day-priced amounts ONCE from the unrounded per-day rate (days x basis / divisor); multiplying a
  // rounded per-day rate by days would shave paise. The basis + divisor come from the SAME leave-encashment
  // settings a mid-employment cashout uses, so one concept has one rate.
  const encashBasis = f.encashBasis ?? f.basePay;
  const encashDiv = f.encashDivisor && f.encashDivisor > 0 ? f.encashDivisor : div;
  const encash = round2((f.leaveDays * encashBasis) / encashDiv);
  if (encash > 0) {
    // s.10(10AA): the exempt slice is the caller's (it needs service length + the statutory ceiling).
    const exempt = Math.min(encash, Math.max(0, f.encashExempt ?? 0));
    lines.push({ code: "ENCASH", name: `Leave encashment (${f.leaveDays} day(s))`, kind: "earning", amount: encash, taxable: round2(encash - exempt) });
  }

  // Statutory gratuity (Payment of Gratuity Act): payable at exit once the qualifying service is served, exempt
  // u/s 10(10) up to the ceiling, the excess chargeable.
  if (f.gratuity && f.gratuity.amount > 0) {
    const amount = round2(f.gratuity.amount);
    const exempt = Math.min(amount, Math.max(0, f.gratuity.exempt));
    lines.push({ code: "GRATUITY", name: "Gratuity", kind: "earning", amount, taxable: round2(amount - exempt) });
  }

  // Reimbursements repay money the employee already spent: paid in full, never taxable.
  if (f.reimbursements > 0) lines.push({ code: "REIMB", name: "Pending reimbursements", kind: "earning", amount: round2(f.reimbursements), taxable: 0 });

  for (const l of f.extraEarnings ?? []) if (l.amount > 0) lines.push({ ...l, kind: "earning", amount: round2(l.amount) });

  // Notice-period recovery: the pay the employee would have earned over the days not served, so it is priced on
  // the same monthly GROSS the final-month salary above is - recovering only the basic slice would let someone
  // buy out their notice at roughly half its cost.
  const notice = round2((f.noticeShortfallDays * f.monthlyGross) / div);
  if (notice > 0) lines.push({ code: "NOTICE", name: `Notice period recovery (${f.noticeShortfallDays} day(s))`, kind: "deduction", amount: notice });

  // Recoveries are NOT capped at the earnings: a leaver whose loan outstanding exceeds their dues owes the
  // company the difference, and the settlement must state that (a negative net) rather than quietly write it off.
  for (const l of f.extraDeductions ?? []) if (l.amount > 0) lines.push({ ...l, kind: "deduction", amount: round2(l.amount) });

  const earnings = lines.filter((l) => l.kind === "earning");
  const totalEarnings = sum2(earnings.map((l) => l.amount));
  const totalTaxableEarnings = sum2(earnings.map((l) => (l.taxable === undefined ? l.amount : l.taxable)));
  const totalDeductions = sum2(lines.filter((l) => l.kind === "deduction").map((l) => l.amount));
  return { lines, totalEarnings, totalTaxableEarnings, totalDeductions, net: round2(totalEarnings - totalDeductions) };
}

// ---- Exit benefits (pure) --------------------------------------------------------------------------------

// Statutory gratuity, as data: `enabled` off means the org settles gratuity outside payroll (an LIC/trust
// policy) and the FnF must not pay it twice. Defaults are the Payment of Gratuity Act's own numbers - 15 days'
// wages for every completed year of service (part beyond six months counting as a year) on a 26-day month,
// payable once 5 years are served - with the s.10(10) exemption ceiling at ₹20,00,000.
export type GratuityConfig = {
  enabled: boolean;
  min_years: number;
  days_per_year: number;
  divisor: number;
  exemption_cap: number;
};
export const DEFAULT_GRATUITY_CONFIG: GratuityConfig = {
  enabled: true,
  min_years: 5,
  days_per_year: 15,
  divisor: 26,
  exemption_cap: 2_000_000,
};

// Elapsed service in years, unrounded. This - not the rounded count below - is what QUALIFYING service is
// tested against: s.4(1) requires five years actually served, while the s.4(2) rounding only sizes the payout.
//
// COUNTED IN CALENDAR ANNIVERSARIES, not by dividing elapsed days by an average year. `(end - start) / 365.25`
// is a fraction of a day short of the truth for any span whose leap-day count is below the 0.25/year average,
// and the five-year mark is exactly where that is decided: a five-calendar-year span is 1826 or 1827 days, and
// 1826 / 365.25 is 4.99932. So an employee who served precisely five years measured 4.99932, `servedYears <
// cfg.min_years` was true, and gratuity - a statutory entitlement, and the commonest exit there is - came out
// at zero. It depended on the joining year: three start years in five produce a 1826-day span and were denied,
// the other two produced 1827 and were paid, which is the kind of difference nobody finds by reading the code.
//
// Whole years come off the calendar (an anniversary that has passed is a year served, whatever the leap days
// did), and only the trailing part-year is a ratio - measured against ITS OWN length, so the fraction means
// "this far through the current year of service" on both sides of a 29 February.
export function yearsOfService(startMs: number, endMs: number): number {
  if (!(endMs > startMs)) return 0;
  const s = new Date(startMs);
  const anniversary = (n: number) => Date.UTC(s.getUTCFullYear() + n, s.getUTCMonth(), s.getUTCDate());
  const e = new Date(endMs);
  // Calendar years elapsed, then walked back one if this year's anniversary has not arrived yet. A 29 February
  // anchor normalises forward to 1 March in a common year, which is where `addMonthsUtc`'s clamp would put the
  // anniversary a day earlier - a day either way at the boundary of a whole year, not the systematic shortfall
  // the division produced.
  let whole = e.getUTCFullYear() - s.getUTCFullYear();
  if (endMs < anniversary(whole)) whole -= 1;
  if (whole < 0) return 0;
  const from = anniversary(whole);
  const to = anniversary(whole + 1);
  return to > from ? whole + (endMs - from) / (to - from) : whole;
}

// Completed years of service for gratuity: whole years, and a trailing part-year of MORE than six months counts
// as one more (s.4(2)). Returns 0 for a non-positive span. This is the MULTIPLIER, never the eligibility test -
// rounding 4 years 7 months up to 5 and then gating on it pays gratuity to someone who never qualified.
export function completedYearsOfService(startMs: number, endMs: number): number {
  const years = yearsOfService(startMs, endMs);
  if (years <= 0) return 0;
  const whole = Math.floor(years);
  return whole + (years - whole > 0.5 ? 1 : 0);
}

// Gratuity payable: last-drawn wage (basic + DA) / divisor x days_per_year x completed years, and nothing at all
// until the qualifying service is met. `servedYears` is the RAW elapsed service the min_years gate is applied
// to; `years` is the s.4(2)-rounded multiplier the amount is computed from.
export function gratuityAmount(lastDrawnWage: number, years: number, cfg: GratuityConfig, servedYears = years): number {
  if (!cfg.enabled || servedYears < cfg.min_years || !(lastDrawnWage > 0)) return 0;
  const div = cfg.divisor > 0 ? cfg.divisor : 26;
  return round2((lastDrawnWage / div) * cfg.days_per_year * years);
}

// s.10(10) exemption for a non-government employee: the least of the gratuity received, 15 days' wages per
// completed year (the statutory formula above at the Act's own rates), and the lifetime ceiling.
export function gratuityExemption(amount: number, lastDrawnWage: number, years: number, cfg: GratuityConfig): number {
  if (amount <= 0) return 0;
  const statutory = round2((lastDrawnWage / 26) * 15 * years);
  return round2(Math.max(0, Math.min(amount, statutory, cfg.exemption_cap)));
}

// s.10(10AA) exemption on leave encashed AT EXIT: the least of (a) the amount received, (b) the notified ceiling
// (₹25,00,000), (c) ten months' AVERAGE salary, and (d) the cash value of at most 30 days of unused leave per
// completed year of service. `salary` is the monthly basic (+DA) the caller prices the encashment on;
// `averageSalary` is the average of the last ten months, which is what limbs (c) and (d) are measured on - the
// statute says average salary, and using the last-drawn figure after a final-year raise over-exempts.
// Mid-employment encashment is fully taxable and never comes through here.
export const LEAVE_ENCASHMENT_EXEMPTION_CAP = 2_500_000;
export function leaveEncashmentExemption(
  amount: number,
  salary: number,
  leaveDays: number,
  years: number,
  cap = LEAVE_ENCASHMENT_EXEMPTION_CAP,
  averageSalary = salary,
): number {
  if (amount <= 0 || salary <= 0) return 0;
  const avg = averageSalary > 0 ? averageSalary : salary;
  const tenMonths = round2(avg * 10);
  const cappedDays = Math.min(leaveDays, 30 * Math.max(0, years));
  const thirtyDayValue = round2((cappedDays * avg) / 30);
  return round2(Math.max(0, Math.min(amount, cap, tenMonths, thirtyDayValue)));
}

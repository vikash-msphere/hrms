// Pure full-and-final settlement (FnF) math. Given the assembled exit facts, it produces the settlement
// line items (earnings + deductions) and the net payable. No DB/IO here - the service (src/services/
// settlements.ts) gathers the facts and persists the snapshot; the FnF letter renders it.
// `taxable` is the CHARGEABLE slice of an earning, defaulting to the whole amount: a reimbursement is 0, and
// gratuity / leave encashment at exit are partly exempt (s.10(10) / s.10(10AA)). The FnF is salary income and
// usually the year's largest single payment, so the service withholds income tax on `totalTaxableEarnings`.
export type SettlementLine = { name: string; kind: "earning" | "deduction"; amount: number; taxable?: number };

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
  const paidDays = Math.max(0, round2(f.daysWorkedInMonth - lopDays));
  const salary = f.daysInMonth > 0 ? round2((f.monthlyGross * paidDays) / f.daysInMonth) : 0;
  if (salary > 0) {
    const label = `Salary for ${round2(f.daysWorkedInMonth)} day(s)${lopDays > 0 ? ` less ${lopDays} day(s) loss of pay` : ""}`;
    lines.push({ name: label, kind: "earning", amount: salary });
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
    lines.push({ name: `Leave encashment (${f.leaveDays} day(s))`, kind: "earning", amount: encash, taxable: round2(encash - exempt) });
  }

  // Statutory gratuity (Payment of Gratuity Act): payable at exit once the qualifying service is served, exempt
  // u/s 10(10) up to the ceiling, the excess chargeable.
  if (f.gratuity && f.gratuity.amount > 0) {
    const amount = round2(f.gratuity.amount);
    const exempt = Math.min(amount, Math.max(0, f.gratuity.exempt));
    lines.push({ name: "Gratuity", kind: "earning", amount, taxable: round2(amount - exempt) });
  }

  // Reimbursements repay money the employee already spent: paid in full, never taxable.
  if (f.reimbursements > 0) lines.push({ name: "Pending reimbursements", kind: "earning", amount: round2(f.reimbursements), taxable: 0 });

  for (const l of f.extraEarnings ?? []) if (l.amount > 0) lines.push({ ...l, kind: "earning", amount: round2(l.amount) });

  const notice = round2((f.noticeShortfallDays * f.basePay) / div);
  if (notice > 0) lines.push({ name: `Notice period recovery (${f.noticeShortfallDays} day(s))`, kind: "deduction", amount: notice });

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

// Completed years of service for gratuity: whole years, and a trailing part-year of MORE than six months counts
// as one more (s.4(2)). Returns 0 for a non-positive span.
export function completedYearsOfService(startMs: number, endMs: number): number {
  if (!(endMs > startMs)) return 0;
  const years = (endMs - startMs) / (365.25 * 86_400_000);
  const whole = Math.floor(years);
  return whole + (years - whole > 0.5 ? 1 : 0);
}

// Gratuity payable: last-drawn wage (basic + DA) / divisor x days_per_year x completed years, and nothing at all
// until the qualifying service is met.
export function gratuityAmount(lastDrawnWage: number, years: number, cfg: GratuityConfig): number {
  if (!cfg.enabled || years < cfg.min_years || !(lastDrawnWage > 0)) return 0;
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
// (₹25,00,000), (c) ten months' average salary, and (d) the cash value of at most 30 days of unused leave per
// completed year of service. `salary` is the monthly basic (+DA) the caller prices the encashment on.
// Mid-employment encashment is fully taxable and never comes through here.
export const LEAVE_ENCASHMENT_EXEMPTION_CAP = 2_500_000;
export function leaveEncashmentExemption(
  amount: number,
  salary: number,
  leaveDays: number,
  years: number,
  cap = LEAVE_ENCASHMENT_EXEMPTION_CAP,
): number {
  if (amount <= 0 || salary <= 0) return 0;
  const tenMonths = round2(salary * 10);
  const cappedDays = Math.min(leaveDays, 30 * Math.max(0, years));
  const thirtyDayValue = round2((cappedDays * salary) / 30);
  return round2(Math.max(0, Math.min(amount, cap, tenMonths, thirtyDayValue)));
}

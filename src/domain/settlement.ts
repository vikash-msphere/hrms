// Pure full-and-final settlement (FnF) math. Given the assembled exit facts, it produces the settlement
// line items (earnings + deductions) and the net payable. No DB/IO here - the service (src/services/
// settlements.ts) gathers the facts and persists the snapshot; the FnF letter renders it.
export type SettlementLine = { name: string; kind: "earning" | "deduction"; amount: number };

export type SettlementFacts = {
  monthlyGross: number; // base + recurring earnings (the monthly CTC-ish figure paid)
  basePay: number; // monthly base, used for the per-day rate
  daysWorkedInMonth: number; // days worked in the final (partial) month
  daysInMonth: number; // days in that month
  leaveDays: number; // encashable leave balance
  noticeShortfallDays: number; // notice days not served (recovery)
  reimbursements: number; // approved-unpaid reimbursements
  perDayDivisor?: number; // per-day rate basis (default 30)
  // Everything else the leaver is owed or owes at exit, priced by the caller: unpaid bonuses, approved-unpaid
  // encashments and overtime, unpaid salary arrears (earnings), and outstanding loan/advance balances
  // (deductions). A terminated employee is in no payroll run, so if the FnF doesn't carry these they are never
  // paid - and an outstanding loan is never recovered.
  extraEarnings?: SettlementLine[];
  extraDeductions?: SettlementLine[];
};

export type Settlement = {
  lines: SettlementLine[];
  totalEarnings: number;
  totalDeductions: number;
  net: number;
};

import { round2 } from "./money";

export function computeSettlement(f: SettlementFacts): Settlement {
  const div = f.perDayDivisor ?? 30;
  const lines: SettlementLine[] = [];

  const salary = f.daysInMonth > 0 ? round2((f.monthlyGross * f.daysWorkedInMonth) / f.daysInMonth) : 0;
  if (salary > 0) lines.push({ name: `Salary for ${f.daysWorkedInMonth} day(s)`, kind: "earning", amount: salary });

  // Round the day-priced amounts ONCE from the unrounded per-day rate (days x base / divisor); multiplying a
  // rounded per-day rate by days would shave paise.
  const encash = round2((f.leaveDays * f.basePay) / div);
  if (encash > 0) lines.push({ name: `Leave encashment (${f.leaveDays} day(s))`, kind: "earning", amount: encash });

  if (f.reimbursements > 0) lines.push({ name: "Pending reimbursements", kind: "earning", amount: round2(f.reimbursements) });

  for (const l of f.extraEarnings ?? []) if (l.amount > 0) lines.push({ ...l, kind: "earning", amount: round2(l.amount) });

  const notice = round2((f.noticeShortfallDays * f.basePay) / div);
  if (notice > 0) lines.push({ name: `Notice period recovery (${f.noticeShortfallDays} day(s))`, kind: "deduction", amount: notice });

  // Recoveries are NOT capped at the earnings: a leaver whose loan outstanding exceeds their dues owes the
  // company the difference, and the settlement must state that (a negative net) rather than quietly write it off.
  for (const l of f.extraDeductions ?? []) if (l.amount > 0) lines.push({ ...l, kind: "deduction", amount: round2(l.amount) });

  const totalEarnings = round2(lines.filter((l) => l.kind === "earning").reduce((s, l) => s + l.amount, 0));
  const totalDeductions = round2(lines.filter((l) => l.kind === "deduction").reduce((s, l) => s + l.amount, 0));
  return { lines, totalEarnings, totalDeductions, net: round2(totalEarnings - totalDeductions) };
}

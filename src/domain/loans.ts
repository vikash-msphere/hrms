// Pure loan repayment math (no I/O). The payroll integration (services/loans.ts) uses these to size each
// installment and decide when a loan is fully repaid. Kept pure so the edge cases (final short installment,
// overpay guard, close threshold) are unit-tested without a DB.
import { round2 } from "./money";

export type LoanFacts = { principal: number; installments: number; monthlyAmount: number; repaid: number };

// The fixed EMI: the amount set at approval, or principal/installments as a fallback.
export function emiOf(l: LoanFacts): number {
  return l.monthlyAmount > 0 ? l.monthlyAmount : round2(l.principal / Math.max(1, l.installments));
}

// What's still owed.
export function outstandingOf(l: LoanFacts): number {
  return round2(l.principal - l.repaid);
}

// The amount to deduct this run: the EMI, capped at the outstanding balance (so the final installment is the
// remainder, never an overpay). 0 when nothing is owed.
export function installmentAmount(l: LoanFacts): number {
  const outstanding = outstandingOf(l);
  if (outstanding <= 0.005) return 0;
  return Math.min(emiOf(l), outstanding);
}

// Is the loan fully repaid once `repaid` reaches the principal (within a rounding epsilon)?
export function isFullyRepaid(principal: number, repaid: number): boolean {
  return repaid >= principal - 0.005;
}

// ---- Interest concession as a perquisite (Rule 3(7)(i)) ---------------------------------------------------
// An interest-free or concessional employer loan is a taxable PERQUISITE: the value is interest at the SBI rate
// for the same kind of loan, on the maximum outstanding monthly balance, less any interest the employer actually
// charged. Exempt when the aggregate ORIGINAL amount of all such loans does not exceed the threshold (₹20,000),
// or when the loan is for a notified medical treatment.
// Off by default: it needs the SBI rate as on the first day of the financial year, which is a policy figure HR
// must set (settings/loan-perquisite), and this system's loans carry no interest at all, so a wrong rate would
// silently over-withhold. `interest_charged_pct` exists so an org that does charge interest nets it off.
export type LoanPerquisiteConfig = {
  enabled: boolean;
  sbi_rate_pct: number; // annual, as notified on 1 April of the financial year
  interest_charged_pct: number; // annual interest the employer actually charges (0 for an interest-free loan)
  exempt_principal_upto: number; // aggregate original principal at or below which nothing is taxable
};
export const DEFAULT_LOAN_PERQUISITE_CONFIG: LoanPerquisiteConfig = {
  enabled: false,
  sbi_rate_pct: 0,
  interest_charged_pct: 0,
  exempt_principal_upto: 20_000,
};

// One month's perquisite value across an employee's outstanding loans. `outstanding` is the balance at the start
// of the month (the maximum outstanding monthly balance, before this run's installment), so the value is
// (sum outstanding) x (rate - interest charged) / 12.
export function loanPerquisiteMonthly(loans: LoanFacts[], cfg: LoanPerquisiteConfig): number {
  if (!cfg.enabled) return 0;
  const netRate = Math.max(0, (cfg.sbi_rate_pct ?? 0) - (cfg.interest_charged_pct ?? 0));
  if (netRate <= 0) return 0;
  const principal = loans.reduce((s, l) => s + l.principal, 0);
  if (principal <= (cfg.exempt_principal_upto ?? 0)) return 0; // below the aggregate threshold: not a perquisite
  const outstanding = loans.reduce((s, l) => s + Math.max(0, outstandingOf(l)), 0);
  if (outstanding <= 0) return 0;
  return round2((outstanding * (netRate / 100)) / 12);
}

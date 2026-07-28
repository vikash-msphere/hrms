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

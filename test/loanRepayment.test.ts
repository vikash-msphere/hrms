import { describe, it, expect } from "vitest";
import { emiOf, outstandingOf, installmentAmount, isFullyRepaid, loanPerquisiteMonthly, DEFAULT_LOAN_PERQUISITE_CONFIG } from "../src/domain/loans";

describe("loan repayment math (payroll integration)", () => {
  it("EMI is the set monthly amount, else principal/installments", () => {
    expect(emiOf({ principal: 12000, installments: 12, monthlyAmount: 1000, repaid: 0 })).toBe(1000);
    expect(emiOf({ principal: 12000, installments: 12, monthlyAmount: 0, repaid: 0 })).toBe(1000); // fallback
    expect(emiOf({ principal: 10000, installments: 3, monthlyAmount: 0, repaid: 0 })).toBe(3333.33); // rounded
  });
  it("outstanding is principal minus repaid", () => {
    expect(outstandingOf({ principal: 12000, installments: 12, monthlyAmount: 1000, repaid: 5000 })).toBe(7000);
  });
  it("installment is the EMI, capped at the outstanding balance (final installment is the remainder)", () => {
    const loan = { principal: 12000, installments: 12, monthlyAmount: 1000, repaid: 0 };
    expect(installmentAmount({ ...loan, repaid: 0 })).toBe(1000); // normal
    expect(installmentAmount({ ...loan, repaid: 11500 })).toBe(500); // final: capped, not a full EMI
    expect(installmentAmount({ ...loan, repaid: 12000 })).toBe(0); // fully repaid -> nothing due
  });
  it("close detection tolerates rounding", () => {
    expect(isFullyRepaid(12000, 12000)).toBe(true);
    expect(isFullyRepaid(12000, 11999.997)).toBe(true); // within epsilon
    expect(isFullyRepaid(12000, 11000)).toBe(false);
  });
});

// Rule 3(7)(i): an interest-free employer loan is a taxable perquisite valued at the SBI rate on the outstanding
// balance, unless the aggregate original principal is at or below the threshold.
describe("loan interest concession as a perquisite (pure)", () => {
  const on = { ...DEFAULT_LOAN_PERQUISITE_CONFIG, enabled: true, sbi_rate_pct: 9 };
  const loan = (principal: number, repaid = 0) => ({ principal, installments: 12, monthlyAmount: 0, repaid });

  it("is off unless enabled, and needs a rate", () => {
    expect(loanPerquisiteMonthly([loan(200000)], DEFAULT_LOAN_PERQUISITE_CONFIG)).toBe(0);
    expect(loanPerquisiteMonthly([loan(200000)], { ...on, sbi_rate_pct: 0 })).toBe(0);
  });
  it("values one month's interest on the outstanding balance", () => {
    expect(loanPerquisiteMonthly([loan(200000)], on)).toBe(1500); // 200000 x 9% / 12
    expect(loanPerquisiteMonthly([loan(200000, 50000)], on)).toBe(1125); // on 150000 outstanding
  });
  it("nets off the interest the employer actually charges", () => {
    expect(loanPerquisiteMonthly([loan(200000)], { ...on, interest_charged_pct: 4 })).toBe(833.33); // 5% of 200000 / 12
    expect(loanPerquisiteMonthly([loan(200000)], { ...on, interest_charged_pct: 9 })).toBe(0); // at the SBI rate: no concession
  });
  it("exempts a small aggregate principal", () => {
    expect(loanPerquisiteMonthly([loan(20000)], on)).toBe(0); // at the threshold
    expect(loanPerquisiteMonthly([loan(15000), loan(10000)], on)).toBe(187.5); // aggregate 25000 > threshold
  });
  it("is 0 once the loans are repaid", () => {
    expect(loanPerquisiteMonthly([loan(200000, 200000)], on)).toBe(0);
  });
});

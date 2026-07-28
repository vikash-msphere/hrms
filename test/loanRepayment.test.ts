import { describe, it, expect } from "vitest";
import { emiOf, outstandingOf, installmentAmount, isFullyRepaid } from "../src/domain/loans";

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

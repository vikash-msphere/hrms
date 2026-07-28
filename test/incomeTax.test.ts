import { describe, it, expect } from "vitest";
import { computeAnnualTax, monthlyTds, DEFAULT_TAX_CONFIG } from "../src/domain/incomeTax";

// New-regime numbers cross-checked against the official incometaxindia.gov.in calculator (AY 2026-27).
const NEW = DEFAULT_TAX_CONFIG.regimes.new!;

describe("computeAnnualTax - new regime AY 2026-27", () => {
  it("zero tax up to the rebate ceiling (taxable 12,00,000 -> full 87A rebate)", () => {
    const b = computeAnnualTax(1275000, NEW); // gross - 75k std ded = 12,00,000 taxable
    expect(b.taxableIncome).toBe(1200000);
    expect(b.incomeTax).toBe(60000); // 4-8L @5% =20k, 8-12L @10% =40k
    expect(b.rebate).toBe(60000);
    expect(b.totalTax).toBe(0);
  });

  it("just past the ceiling gets marginal relief (taxable 12,10,000)", () => {
    const b = computeAnnualTax(1285000, NEW); // taxable 12,10,000
    expect(b.taxableIncome).toBe(1210000);
    expect(b.incomeTax).toBe(61500); // +15% on the 10,000 over 12L = 1,500
    expect(b.rebate).toBe(51500); // marginal relief: 61500 - (1210000-1200000)
    expect(b.incomeTaxAfterRebate).toBe(10000);
    expect(b.cess).toBe(400); // 4%
    expect(b.totalTax).toBe(10400);
  });

  it("mid-bracket, no rebate, no surcharge (taxable 20,00,000)", () => {
    const b = computeAnnualTax(2075000, NEW); // taxable 20,00,000
    expect(b.incomeTax).toBe(200000); // 20k+40k+60k+80k
    expect(b.rebate).toBe(0);
    expect(b.surcharge).toBe(0);
    expect(b.cess).toBe(8000); // 4% of 200000
    expect(b.totalTax).toBe(208000);
  });

  it("applies 10% surcharge above 50L (taxable 60,00,000)", () => {
    const b = computeAnnualTax(6075000, NEW); // taxable 60,00,000
    expect(b.incomeTax).toBe(1380000); // up to 24L = 3,00,000, then 30% of 36L = 10,80,000
    expect(b.surcharge).toBe(138000); // 10% (no marginal relief needed this far past 50L)
    expect(b.cess).toBe(60720); // 4% of (1380000 + 138000)
    expect(b.totalTax).toBe(1578720);
  });

  it("standard deduction floors taxable income at 0 for tiny incomes", () => {
    const b = computeAnnualTax(50000, NEW);
    expect(b.taxableIncome).toBe(0);
    expect(b.totalTax).toBe(0);
  });
});

describe("monthlyTds - distribute the balance over remaining months, clamp at 0", () => {
  it("spreads remaining tax evenly", () => {
    expect(monthlyTds(120000, 0, 12)).toBe(10000);
    expect(monthlyTds(120000, 30000, 9)).toBe(10000); // 90k over 9 months
  });
  it("never negative (over-deducted / pay cut)", () => {
    expect(monthlyTds(50000, 80000, 4)).toBe(0);
  });
  it("zero remaining months -> 0", () => {
    expect(monthlyTds(120000, 0, 0)).toBe(0);
  });
});

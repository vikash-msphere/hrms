import { describe, it, expect } from "vitest";
import { computeAnnualTax, monthlyTds, allowedDeductions, COMMON_SECTION_CAPS, DEFAULT_TAX_CONFIG, DEFAULT_TAX_FY_START_YEAR, fyLabels, type RegimeConfig } from "../src/domain/incomeTax";

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

// Chapter VI-A: a VERIFIED declaration reduces withholding, but only for the sections the regime allows and only
// up to each section's cap. The new regime keeps 80CCD(2)/80CCH and nothing else.
describe("allowedDeductions", () => {
  it("drops sections the regime disallows and keeps the ones it lists", () => {
    const { total, rows } = allowedDeductions({ "80C": 150000, "80CCD(2)": 40000 }, NEW);
    expect(total).toBe(40000);
    expect(rows.find((r) => r.section === "80C")).toEqual({ section: "80C", declared: 150000, allowed: 0 });
    expect(rows.find((r) => r.section === "80CCD(2)")!.allowed).toBe(40000);
  });
  it("caps a section at its statutory limit when the regime allows it", () => {
    const old: RegimeConfig = { ...NEW, label: "Old regime", standardDeduction: 50000, deductionSections: undefined, sectionCaps: COMMON_SECTION_CAPS };
    const { total, rows } = allowedDeductions({ "80C": 200000, "80D": 30000, "80G": 5000 }, old);
    expect(rows.find((r) => r.section === "80C")!.allowed).toBe(150000); // capped
    expect(rows.find((r) => r.section === "80D")!.allowed).toBe(25000); // capped
    expect(rows.find((r) => r.section === "80G")!.allowed).toBe(5000); // no cap configured
    expect(total).toBe(180000);
  });
  it("comes off taxable income, so it moves the tax", () => {
    const bare = computeAnnualTax(1500000, NEW);
    const withNps = computeAnnualTax(1500000, NEW, 100000);
    expect(withNps.chapterVIA).toBe(100000);
    expect(withNps.taxableIncome).toBe(bare.taxableIncome - 100000);
    expect(withNps.totalTax).toBeLessThan(bare.totalTax);
  });
});

// The slab table's vintage stamp. Two strings that must describe the SAME year: an assessment year is always
// the financial year plus one, and hand-editing one without the other has already shipped once (a config
// stamped FY 2025-26 / AY 2026-27 seeded beside FY 2026-27 pay periods). `fyLabels` is the single builder;
// this pins that the seed actually goes through it.
describe("DEFAULT_TAX_CONFIG - the slab vintage stamp", () => {
  it("derives both labels from one start year, so FY and AY cannot disagree", () => {
    expect(DEFAULT_TAX_CONFIG.financialYear).toBe(fyLabels(DEFAULT_TAX_FY_START_YEAR).financialYear);
    expect(DEFAULT_TAX_CONFIG.assessmentYear).toBe(fyLabels(DEFAULT_TAX_FY_START_YEAR).assessmentYear);
  });

  it("builds an AY exactly one year after its FY, across a century roll", () => {
    expect(fyLabels(2025)).toEqual({ financialYear: "2025-26", assessmentYear: "2026-27" });
    expect(fyLabels(2099)).toEqual({ financialYear: "2099-00", assessmentYear: "2100-01" });
  });
});

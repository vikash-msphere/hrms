import { describe, it, expect } from "vitest";
import { collectibleMonths, assembleProjection, fyWindow, employedMonthsInFy } from "../src/services/taxProjection";
import { DEFAULT_TAX_CONFIG } from "../src/domain/incomeTax";

// FY 2026-27: Apr 2026 .. Mar 2027.
const fy = fyWindow(new Date(Date.UTC(2026, 6, 5))); // asOf July 2026
const none = new Set<string>();

describe("collectibleMonths - calendar months left to collect TDS in", () => {
  it("July with nothing paid -> Jul..Mar = 9 (not 12: Apr-Jun are gone)", () => {
    expect(collectibleMonths(new Date(Date.UTC(2026, 6, 5)), null, fy, none)).toBe(9);
  });
  it("skips months a finalized run already paid", () => {
    expect(collectibleMonths(new Date(Date.UTC(2026, 6, 5)), null, fy, new Set(["2026-07", "2026-08"]))).toBe(7);
  });
  it("clamps to the join month for a future joiner", () => {
    expect(collectibleMonths(new Date(Date.UTC(2026, 6, 5)), new Date(Date.UTC(2026, 9, 1)), fy, none)).toBe(6); // Oct..Mar
  });
  it("before the FY starts -> the whole year", () => {
    expect(collectibleMonths(new Date(Date.UTC(2026, 1, 1)), null, fy, none)).toBe(12);
  });
  it("March pays the last installment; past the FY end -> 0", () => {
    expect(collectibleMonths(new Date(Date.UTC(2027, 2, 31)), null, fy, none)).toBe(1);
    expect(collectibleMonths(new Date(Date.UTC(2027, 3, 1)), null, fy, none)).toBe(0);
  });
});

describe("assembleProjection - income months vs collection months", () => {
  const base = {
    cfg: DEFAULT_TAX_CONFIG,
    regime: "new",
    tdsConfigured: true,
    decl: {},
  };
  it("projects income over unpaid EMPLOYED months but spreads tax over calendar collectMonths", () => {
    // Employed all year (12), zero runs finalized, asOf July -> 9 collectible months.
    const p = assembleProjection({ ...base, employedMonths: 12, paidGross: 0, paidTax: 0, paidMonths: 0, collectMonths: 9, recurringMonthly: 200000 });
    expect(p.annualGross).toBe(2400000); // income still counts all 12 months
    expect(p.remainingMonths).toBe(9); // but only 9 months remain to collect in
    expect(p.monthlyTds).toBe(Math.round(p.breakdown.totalTax / 9));
  });
  it("build context: the current run is one of the collect months", () => {
    const p = assembleProjection({ ...base, employedMonths: 12, paidGross: 600000, paidTax: 30000, paidMonths: 3, collectMonths: 9, recurringMonthly: 200000, currentRunGross: 200000 });
    expect(p.annualGross).toBe(2400000); // 3 paid + this run + 8 future at the recurring rate
    expect(p.monthlyTds).toBe(Math.round((p.breakdown.totalTax - 30000) / 9));
  });
  it("zero collect months -> no TDS line", () => {
    const p = assembleProjection({ ...base, employedMonths: 12, paidGross: 2400000, paidTax: 100000, paidMonths: 12, collectMonths: 0, recurringMonthly: 200000 });
    expect(p.monthlyTds).toBe(0);
  });
  it("employedMonthsInFy clamps a mid-year joiner", () => {
    expect(employedMonthsInFy(new Date(Date.UTC(2026, 9, 15)), fy)).toBe(6); // Oct..Mar
  });

  it("bounds a self-declared prior-employer TDS by the prior income (can't zero out withholding with no income)", () => {
    const args = { ...base, employedMonths: 12, paidGross: 0, paidTax: 0, paidMonths: 0, collectMonths: 9, recurringMonthly: 200000 };
    const baseline = assembleProjection(args);
    // Absurd prior TDS but NO prior income: TDS can't exceed the income it was withheld from, so the ceiling is
    // 0 and withholding is unchanged. This is the sanity guard (real fraud gate is HR verification upstream).
    const abusive = assembleProjection({ ...args, decl: { priorEmployerIncome: 0, priorEmployerTds: 99_999_999 } });
    expect(baseline.monthlyTds).toBeGreaterThan(0);
    expect(abusive.monthlyTds).toBe(baseline.monthlyTds);
  });

  it("credits real prior-employer TDS even when the prior income alone is under the 87A rebate limit", () => {
    // Mid-year joiner: 5,00,000 prior income (in isolation the new-regime 87A rebate zeros its tax), with
    // 30,000 actually withheld by the ex-employer. Combined with this job it's well over the rebate limit, so the
    // 30,000 must be credited - the old "tax on prior income alone" clamp wrongly discarded it (double taxation).
    const args = { ...base, employedMonths: 12, paidGross: 0, paidTax: 0, paidMonths: 0, collectMonths: 9, recurringMonthly: 200000 };
    const credited = assembleProjection({ ...args, decl: { priorEmployerIncome: 500000, priorEmployerTds: 30000 } });
    const noCredit = assembleProjection({ ...args, decl: { priorEmployerIncome: 500000, priorEmployerTds: 0 } });
    expect(credited.priorEmployerTds).toBe(30000); // fully credited, not zeroed
    expect(credited.monthlyTds).toBe(Math.round((credited.breakdown.totalTax - 30000) / 9));
    expect(credited.monthlyTds).toBeLessThan(noCredit.monthlyTds); // the prior TDS lowers the balance to collect
  });

  it("credits prior TDS in full even when it exceeds the marginal tax on the prior income", () => {
    // The ex-employer may over-withhold relative to what the prior income adds to THIS return; the money is still
    // remitted, so it's credited in full (excess -> ITR refund, never negative payroll). 1,00,000 prior income
    // with 28,275 withheld: the marginal-cap would have clipped it, the income ceiling (1,00,000) does not.
    const args = { ...base, employedMonths: 12, paidGross: 0, paidTax: 0, paidMonths: 0, collectMonths: 9, recurringMonthly: 200000 };
    const credited = assembleProjection({ ...args, decl: { priorEmployerIncome: 100000, priorEmployerTds: 28275 } });
    expect(credited.priorEmployerTds).toBe(28275);
    expect(credited.monthlyTds).toBe(Math.round((credited.breakdown.totalTax - 28275) / 9));
  });
});

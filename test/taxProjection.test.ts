import { describe, it, expect } from "vitest";
import { collectibleMonths, assembleProjection, fyWindow, employedMonthsInFy, unpaidEarningMonths, projectedGrossForMonths, compAsOf } from "../src/services/taxProjection";
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

describe("mid-year revision - each month priced at the salary in force then", () => {
  // One employee, raised from 1,00,000 to 2,00,000/month effective 1 Oct 2026 (inside FY 2026-27).
  const oct = Date.UTC(2026, 9, 1);
  const timeline = [
    { uuid: "old", effectiveFrom: new Date(Date.UTC(2025, 3, 1)), effectiveTo: new Date(oct), basePay: 100000, specialAllowance: 0, structureId: null },
    { uuid: "new", effectiveFrom: new Date(oct), effectiveTo: null, basePay: 200000, specialAllowance: 0, structureId: null },
  ];
  const grossFor = (r: (typeof timeline)[number]) => r.basePay;

  it("splits the year at the effective date instead of repainting it at the new rate", () => {
    const months = unpaidEarningMonths(fy, null, null, none);
    expect(months).toHaveLength(12);
    // Apr..Sep at 1,00,000 + Oct..Mar at 2,00,000 = 18,00,000 (not 12 x 2,00,000 = 24,00,000).
    expect(projectedGrossForMonths(months, timeline, grossFor)).toBe(1800000);
  });

  it("a FUTURE-dated raise leaves the months before it at the old salary", () => {
    // Projected in July, before the raise takes effect: the open row is already the new one, so pricing off
    // "current compensation" would inflate Jul..Sep too.
    const months = unpaidEarningMonths(fy, null, null, new Set(["2026-04", "2026-05", "2026-06"]));
    expect(projectedGrossForMonths(months, timeline, grossFor)).toBe(300000 + 1200000); // Jul..Sep old + Oct..Mar new
  });

  it("months a finalized run already paid, and the run being built, are left out", () => {
    const months = unpaidEarningMonths(fy, null, null, new Set(["2026-04"]), "2026-05");
    expect(months.map((m) => m.getUTCMonth())).toEqual([5, 6, 7, 8, 9, 10, 11, 0, 1, 2]); // Jun..Mar
  });

  it("a leaver's months stop at the leaving month", () => {
    const months = unpaidEarningMonths(fy, null, new Date(Date.UTC(2026, 7, 15)), none);
    expect(months).toHaveLength(5); // Apr..Aug
    expect(projectedGrossForMonths(months, timeline, grossFor)).toBe(500000); // all at the old rate
  });

  it("compAsOf picks the row in force, and the open row when no date is given", () => {
    expect(compAsOf(timeline, Date.UTC(2026, 8, 30))?.uuid).toBe("old");
    expect(compAsOf(timeline, oct)?.uuid).toBe("new"); // half-open: the new row owns its effective date
    expect(compAsOf(timeline, undefined)?.uuid).toBe("new");
  });

  it("the projected split flows into the year's tax", () => {
    const p = assembleProjection({
      cfg: DEFAULT_TAX_CONFIG, fy, regime: "new", tdsConfigured: true, decl: {},
      employedMonths: 12, paidGross: 0, paidTax: 0, collectMonths: 9,
      projectedGross: projectedGrossForMonths(unpaidEarningMonths(fy, null, null, none), timeline, grossFor),
    });
    expect(p.annualGross).toBe(1800000);
  });
});

describe("assembleProjection - income months vs collection months", () => {
  const base = {
    cfg: DEFAULT_TAX_CONFIG,
    fy,
    regime: "new",
    tdsConfigured: true,
    decl: {},
  };

  // The year a projection is LABELLED with comes from the payroll window, never from the slab table's
  // vintage stamp. They differ whenever the loaded config is a year behind the year being run - which is the
  // normal state for the months of a financial year before that year's Budget is loaded - and reading the
  // label off `cfg` captions a FY 2026-27 projection "FY 2025-26" while every number on it is right.
  //
  // The stamp is passed in DELIBERATELY WRONG rather than taken from DEFAULT_TAX_CONFIG. Asserting that the
  // shipped stamp differs from the window is not a test of this behaviour, it is a test of what year it is:
  // it passed only while the two happened to disagree, and the annual vintage bump - which changes the stamp
  // and nothing else - made it fail while leaving the labelling it exists to pin completely untested.
  it("labels the projection from the FY window, not the config's slab vintage", () => {
    const staleStamp = { ...DEFAULT_TAX_CONFIG, financialYear: "2019-20", assessmentYear: "2020-21" };
    const p = assembleProjection({ ...base, cfg: staleStamp, employedMonths: 12, paidGross: 0, paidTax: 0, collectMonths: 9, projectedGross: 2400000 });
    expect(p.financialYear).toBe("2026-27"); // fy's window, not staleStamp's
    expect(p.assessmentYear).toBe("2027-28");
  });
  it("projects income over unpaid EMPLOYED months but spreads tax over calendar collectMonths", () => {
    // Employed all year (12), zero runs finalized, asOf July -> 9 collectible months.
    const p = assembleProjection({ ...base, employedMonths: 12, paidGross: 0, paidTax: 0, collectMonths: 9, projectedGross: 2400000 });
    expect(p.annualGross).toBe(2400000); // income still counts all 12 months
    expect(p.remainingMonths).toBe(9); // but only 9 months remain to collect in
    expect(p.monthlyTds).toBe(Math.round(p.breakdown.totalTax / 9));
  });
  it("build context: the current run is one of the collect months", () => {
    const p = assembleProjection({ ...base, employedMonths: 12, paidGross: 600000, paidTax: 30000, collectMonths: 9, projectedGross: 1600000, currentRunGross: 200000 });
    expect(p.annualGross).toBe(2400000); // 3 paid + this run + 8 future at the recurring rate
    expect(p.monthlyTds).toBe(Math.round((p.breakdown.totalTax - 30000) / 9));
  });
  it("zero collect months -> no TDS line", () => {
    const p = assembleProjection({ ...base, employedMonths: 12, paidGross: 2400000, paidTax: 100000, collectMonths: 0, projectedGross: 0 });
    expect(p.monthlyTds).toBe(0);
  });
  it("employedMonthsInFy clamps a mid-year joiner", () => {
    expect(employedMonthsInFy(new Date(Date.UTC(2026, 9, 15)), fy)).toBe(6); // Oct..Mar
  });

  it("bounds a self-declared prior-employer TDS by the prior income (can't zero out withholding with no income)", () => {
    const args = { ...base, employedMonths: 12, paidGross: 0, paidTax: 0, collectMonths: 9, projectedGross: 2400000 };
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
    const args = { ...base, employedMonths: 12, paidGross: 0, paidTax: 0, collectMonths: 9, projectedGross: 2400000 };
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
    const args = { ...base, employedMonths: 12, paidGross: 0, paidTax: 0, collectMonths: 9, projectedGross: 2400000 };
    const credited = assembleProjection({ ...args, decl: { priorEmployerIncome: 100000, priorEmployerTds: 28275 } });
    expect(credited.priorEmployerTds).toBe(28275);
    expect(credited.monthlyTds).toBe(Math.round((credited.breakdown.totalTax - 28275) / 9));
  });
});

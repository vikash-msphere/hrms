// Regressions for the money-surface defects fixed in money-defects.md. Each case is the behaviour that was
// WRONG before the fix, pinned so it cannot come back. Pure-domain cases live here; the payroll/FnF paths that
// need a database are exercised in moneyFlow.test.ts.
import { describe, it, expect } from "vitest";
import { lopAmount, DEFAULT_ATTENDANCE } from "../src/domain/attendance";
import { componentLineCode, employerCostLines, type CtcComponent } from "../src/domain/payroll";
import { yearsOfService, completedYearsOfService, gratuityAmount, leaveEncashmentExemption, DEFAULT_GRATUITY_CONFIG } from "../src/domain/settlement";
import { professionalTax, DEFAULT_PT_CONFIG } from "../src/domain/statutory";
import { assertSupportedRegime, SUPPORTED_REGIMES } from "../src/domain/incomeTax";

describe("loss of pay is priced on the wage the day actually earned", () => {
  // Basic 40,000 of a 80,000 gross: an absent day costs the whole day's pay, not the basic slice of it.
  it("docks the monthly GROSS by default, not the bare basic", () => {
    const gross = lopAmount(80_000, 1, "days_30", 22);
    const basic = lopAmount(40_000, 1, "days_30", 22);
    expect(gross).toBe(2666.67);
    expect(basic).toBe(1333.33);
    expect(gross).toBeCloseTo(basic * 2, 1); // twice the dock, up to the paise each rounds to independently
  });

  it("defaults the wage basis to gross in the shipped attendance config", () => {
    expect(DEFAULT_ATTENDANCE.lop_wage_basis).toBe("gross");
  });

  it("rounds ONCE from the unrounded per-day rate", () => {
    // 100000/22 = 4545.4545...; x3 rounded once is 13636.36, not 3 x 4545.45 = 13636.35.
    expect(lopAmount(100_000, 3, "working_days", 22)).toBe(13636.36);
  });
});

describe("gratuity qualifying service", () => {
  it("does not pay an employee who has served less than the qualifying years", () => {
    const start = Date.UTC(2021, 0, 1);
    const end = Date.UTC(2025, 7, 1); // 4 years 7 months
    const served = yearsOfService(start, end);
    const rounded = completedYearsOfService(start, end);
    expect(rounded).toBe(5); // s.4(2) rounds the MULTIPLIER up
    expect(served).toBeLessThan(5); // but five years were never actually served
    expect(gratuityAmount(50_000, rounded, DEFAULT_GRATUITY_CONFIG, served)).toBe(0);
  });

  it("pays once the qualifying service is served, sized by the rounded years", () => {
    const start = Date.UTC(2019, 0, 1);
    const end = Date.UTC(2025, 7, 1); // 6 years 7 months -> 7
    const served = yearsOfService(start, end);
    const rounded = completedYearsOfService(start, end);
    expect(rounded).toBe(7);
    expect(gratuityAmount(52_000, rounded, DEFAULT_GRATUITY_CONFIG, served)).toBe(210_000); // 52000/26 x 15 x 7
  });
});

describe("s.10(10AA) is measured on average salary", () => {
  it("uses the ten-month average, not the last-drawn figure, for the salary-based limbs", () => {
    // Encashing 60 days after 10 years. Last drawn 100k after a raise; the ten-month average is 60k.
    const amount = 200_000;
    const lastDrawn = leaveEncashmentExemption(amount, 100_000, 60, 10);
    const average = leaveEncashmentExemption(amount, 100_000, 60, 10, undefined, 60_000);
    expect(lastDrawn).toBe(200_000); // 30-day value 200k, ten months 1,000k -> the whole amount
    expect(average).toBe(120_000); // 30-day value at the average: 60 x 60000/30
    expect(average).toBeLessThan(lastDrawn);
  });
});

describe("pay-component line codes cannot collide with the engine's own", () => {
  it("prefixes a component whose name slugs onto a reserved code", () => {
    expect(componentLineCode("PT")).toBe("C_PT");
    expect(componentLineCode("LOP")).toBe("C_LOP");
    expect(componentLineCode("EPF")).toBe("C_EPF");
    expect(componentLineCode("Round")).toBe("C_ROUND");
    expect(componentLineCode("ER_EPF")).toBe("C_ER_EPF"); // must not masquerade as an employer line either
  });

  it("leaves an ordinary component name alone", () => {
    expect(componentLineCode("House Rent Allowance")).toBe("HOUSE_RENT_ALLOWANCE");
    expect(componentLineCode("Conveyance Allowance")).toBe("CONVEYANCE_ALLOWANCE");
  });
});

describe("employer contributions carry the wage they were priced on", () => {
  const comp = (over: Partial<CtcComponent>): CtcComponent =>
    ({ kind: "employer_contribution", method: "epf", name: "Employer PF", rate: 12, cap: 15_000, recurring: true, ...over }) as CtcComponent;

  it("states PF wages for the PF family, so the register never divides a capped contribution back out", () => {
    // PF wages 50,000 with a 15,000 ceiling: the contribution is 1,800, which reverse-derives to 15,000.
    const [line] = employerCostLines(50_000, 60_000, [comp({})], true, undefined, 50_000);
    expect(line!.monthly).toBe(1800);
    expect(line!.basis).toBe(50_000); // the real wage, not the ceiling the contribution implies
  });

  it("states gross for ESI, which is rounded UP and so cannot be divided back out", () => {
    const [line] = employerCostLines(15_000, 20_001, [comp({ method: "esi", name: "Employer ESI", rate: 3.25, cap: 21_000 })], true);
    expect(line!.basis).toBe(20_001);
  });
});

describe("professional tax", () => {
  it("caps the year in the shipped config (Article 276(2))", () => {
    expect(DEFAULT_PT_CONFIG.annual_cap).toBe(2500);
  });

  it("charges the slab the month's wage falls in", () => {
    expect(professionalTax(25_000, DEFAULT_PT_CONFIG)).toBe(0);
    expect(professionalTax(25_001, DEFAULT_PT_CONFIG)).toBe(200);
  });

  it("lifts the bracket when a bonus is paid in the month", () => {
    // Slabs that only bite above 30,000: a 25,000 regular wage is nil, but the month a 10,000 bonus is paid is not.
    const cfg = { slabs: [{ up_to: 30_000, amount: 0 }, { up_to: null, amount: 200 }], annual_cap: 2500 };
    expect(professionalTax(25_000, cfg)).toBe(0);
    expect(professionalTax(25_000 + 10_000, cfg)).toBe(200);
  });
});

describe("income tax regimes", () => {
  it("accepts the implemented regime", () => {
    expect(SUPPORTED_REGIMES).toEqual(["new"]);
    expect(() => assertSupportedRegime("new")).not.toThrow();
  });

  it("refuses a regime it cannot compute rather than withholding a wrong figure", () => {
    // The old regime needs s.16(iii) / s.10(13A) / LTA, none of which this build computes. Falling back to the
    // new regime's slabs under the old regime's label would over-withhold from every employee on it.
    expect(() => assertSupportedRegime("old")).toThrow(/not implemented/);
  });
});

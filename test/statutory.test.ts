import { describe, it, expect } from "vitest";
import { esiEmployeeContribution, esiEmployerContribution, esiContributionPeriod, professionalTax, DEFAULT_PT_CONFIG, type PtConfig } from "../src/domain/statutory";

describe("ESI contribution period (Apr-Sep / Oct-Mar)", () => {
  const win = (iso: string) => esiContributionPeriod(new Date(iso));
  const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  it("May falls in the Apr 1 - Oct 1 half", () => {
    const w = win("2026-05-15");
    expect(ymd(w.start)).toBe("2026-04-01");
    expect(ymd(w.end)).toBe("2026-10-01");
  });
  it("November falls in the Oct 1 - Apr 1 half", () => {
    const w = win("2026-11-15");
    expect(ymd(w.start)).toBe("2026-10-01");
    expect(ymd(w.end)).toBe("2027-04-01");
  });
  it("February belongs to the PRIOR October's half", () => {
    const w = win("2027-02-15");
    expect(ymd(w.start)).toBe("2026-10-01");
    expect(ymd(w.end)).toBe("2027-04-01");
  });
});

describe("ESI employee contribution", () => {
  it("is 0.75% of gross, rounded UP to the next rupee, within the ceiling", () => {
    expect(esiEmployeeContribution(20000, 0.75, 21000)).toBe(150); // 150.00 exact
    expect(esiEmployeeContribution(18333, 0.75, 21000)).toBe(138); // 137.49 -> ceil 138
  });
  it("is 0 above the eligibility ceiling", () => {
    expect(esiEmployeeContribution(21001, 0.75, 21000)).toBe(0);
    expect(esiEmployeeContribution(50000, 0.75, 21000)).toBe(0);
  });
  it("is 0 for non-positive gross, and honors a custom rate/ceiling", () => {
    expect(esiEmployeeContribution(0, 0.75, 21000)).toBe(0);
    expect(esiEmployeeContribution(15000, 1, 25000)).toBe(150); // 1% of 15000
  });
});

describe("ESI employer contribution (CTC cost)", () => {
  it("is 3.25% of gross, rounded UP to the next rupee, within the ceiling", () => {
    expect(esiEmployerContribution(20000, 3.25, 21000)).toBe(650); // 650.00 exact
    expect(esiEmployerContribution(18333, 3.25, 21000)).toBe(596); // 595.82 -> ceil 596
  });
  it("is 0 above the eligibility ceiling and for non-positive gross", () => {
    expect(esiEmployerContribution(21001, 3.25, 21000)).toBe(0);
    expect(esiEmployerContribution(0, 3.25, 21000)).toBe(0);
  });
  it("honors a custom rate/ceiling (e.g. report-side Infinity gate)", () => {
    expect(esiEmployerContribution(15000, 3.25, 25000)).toBe(488); // 487.5 -> ceil 488
    expect(esiEmployerContribution(21066, 3.25, Infinity)).toBe(685); // eligibility proven elsewhere -> no re-gate
  });
});

describe("Professional Tax slabs", () => {
  it("picks the first matching bracket (default: nil to 25k, 200 above)", () => {
    expect(professionalTax(20000, DEFAULT_PT_CONFIG)).toBe(0);
    expect(professionalTax(25000, DEFAULT_PT_CONFIG)).toBe(0); // boundary inclusive
    expect(professionalTax(25001, DEFAULT_PT_CONFIG)).toBe(200);
    expect(professionalTax(80000, DEFAULT_PT_CONFIG)).toBe(200);
  });
  it("supports multi-bracket state slabs", () => {
    const cfg: PtConfig = { slabs: [{ up_to: 15000, amount: 0 }, { up_to: 20000, amount: 150 }, { up_to: null, amount: 200 }] };
    expect(professionalTax(15000, cfg)).toBe(0);
    expect(professionalTax(18000, cfg)).toBe(150);
    expect(professionalTax(30000, cfg)).toBe(200);
  });
  it("is 0 for non-positive gross", () => {
    expect(professionalTax(0, DEFAULT_PT_CONFIG)).toBe(0);
  });
});

import { describe, it, expect } from "vitest";
import {
  computeSettlement, completedYearsOfService, yearsOfService, gratuityAmount, gratuityExemption, leaveEncashmentExemption,
  DEFAULT_GRATUITY_CONFIG,
} from "../src/domain/settlement";

// Pure FnF math: pro-rated final salary + leave encashment + reimbursements - notice recovery = net.
describe("computeSettlement", () => {
  it("assembles earnings, deductions and net (per-day = base/30)", () => {
    const s = computeSettlement({
      monthlyGross: 150000,
      basePay: 90000,
      daysWorkedInMonth: 15,
      daysInMonth: 30,
      leaveDays: 10,
      noticeShortfallDays: 5,
      reimbursements: 4000,
    });
    const perDay = 90000 / 30; // 3000, the ENCASHMENT rate (basis = basePay)
    const grossPerDay = 150000 / 30; // 5000, the SALARY rate
    expect(s.lines.find((l) => l.name.startsWith("Salary"))?.amount).toBe(75000); // 150000 * 15/30
    expect(s.lines.find((l) => l.name.startsWith("Leave"))?.amount).toBe(perDay * 10); // 30000
    expect(s.lines.find((l) => l.name === "Pending reimbursements")?.amount).toBe(4000);
    // Notice recovery is the pay the unserved days would have earned, so it is priced on monthly GROSS - the
    // same wage the final-month salary above is - not on the bare basic.
    expect(s.lines.find((l) => l.name.startsWith("Notice"))?.amount).toBe(grossPerDay * 5); // 25000
    expect(s.totalEarnings).toBe(75000 + 30000 + 4000);
    expect(s.totalDeductions).toBe(25000);
    expect(s.net).toBe(75000 + 30000 + 4000 - 25000); // 84000
  });

  it("omits zero lines (no leave, no notice shortfall, no reimbursements)", () => {
    const s = computeSettlement({ monthlyGross: 60000, basePay: 60000, daysWorkedInMonth: 30, daysInMonth: 30, leaveDays: 0, noticeShortfallDays: 0, reimbursements: 0 });
    expect(s.lines).toHaveLength(1); // salary only
    expect(s.totalDeductions).toBe(0);
    expect(s.net).toBe(60000);
  });
});

// Loss of pay + a mid-month join are docked from the final month, and the leave-encashment rate comes from the
// caller's configured basis/divisor rather than a hard-wired base/30.
describe("computeSettlement - final month + exit benefits", () => {
  it("pays only the days worked less loss of pay, and says so on the line", () => {
    const s = computeSettlement({
      monthlyGross: 60000, basePay: 60000,
      daysWorkedInMonth: 20, daysInMonth: 30, lopDaysInFinalMonth: 2,
      leaveDays: 0, noticeShortfallDays: 0, reimbursements: 0,
    });
    const salary = s.lines.find((l) => l.name.startsWith("Salary"))!;
    expect(salary.amount).toBe(36000); // 60000 x (20 - 2) / 30
    expect(salary.name).toContain("less 2 day(s) loss of pay");
  });

  it("prices encashment off the configured basis + divisor (gross / 26), rounding once", () => {
    const s = computeSettlement({
      monthlyGross: 100000, basePay: 50000,
      daysWorkedInMonth: 30, daysInMonth: 30,
      leaveDays: 10, encashBasis: 100000, encashDivisor: 26,
      noticeShortfallDays: 0, reimbursements: 0,
    });
    expect(s.lines.find((l) => l.name.startsWith("Leave"))!.amount).toBe(38461.54); // 10 x 100000 / 26
  });

  it("carries the chargeable slice separately: reimbursements and exempt gratuity/encashment are not taxed", () => {
    const s = computeSettlement({
      monthlyGross: 60000, basePay: 60000,
      daysWorkedInMonth: 30, daysInMonth: 30,
      leaveDays: 10, encashExempt: 20000, // 20000 of the 20000 encashment is exempt
      noticeShortfallDays: 0, reimbursements: 5000,
      gratuity: { amount: 300000, exempt: 250000 },
    });
    expect(s.totalEarnings).toBe(60000 + 20000 + 300000 + 5000);
    expect(s.totalTaxableEarnings).toBe(60000 + 0 + 50000); // salary + taxable gratuity excess only
  });
});

describe("gratuity (pure)", () => {
  const cfg = DEFAULT_GRATUITY_CONFIG;
  const yearsBetween = (from: string, to: string) => completedYearsOfService(Date.parse(from), Date.parse(to));

  it("counts a trailing part-year over six months as a full year", () => {
    expect(yearsBetween("2019-01-01", "2026-02-01")).toBe(7); // 7y 1m
    expect(yearsBetween("2019-01-01", "2026-09-01")).toBe(8); // 7y 8m -> 8
  });

  it("pays 15 days' basic per completed year on a 26-day month, once 5 years are served", () => {
    expect(gratuityAmount(52000, 4, cfg)).toBe(0); // under the qualifying service
    expect(gratuityAmount(52000, 6, cfg)).toBe(180000); // 52000/26 x 15 x 6
  });

  it("is disabled when the org settles gratuity outside payroll", () => {
    expect(gratuityAmount(52000, 10, { ...cfg, enabled: false })).toBe(0);
  });

  // REGRESSION. `yearsOfService` divided elapsed milliseconds by an average 365.25-day year, and a
  // five-calendar-year span is 1826 or 1827 days: 1826 / 365.25 is 4.99932, so an employee who had served
  // exactly five years measured under the five-year gate and was paid nothing. Which of the two lengths a span
  // came out at depended on how many leap days it happened to contain, so three joining years in five were
  // denied and two were paid - the commonest gratuity exit there is, decided by the joining year.
  //
  // Every anniversary must read as a whole number, whatever the leap days did.
  it("counts a whole year on the anniversary, in every joining year", () => {
    for (const year of [2020, 2021, 2022, 2023, 2024]) {
      const start = Date.parse(`${year}-01-01T00:00:00Z`);
      const fiveYearsOn = Date.parse(`${year + 5}-01-01T00:00:00Z`);
      expect(yearsOfService(start, fiveYearsOn)).toBe(5);
      expect(gratuityAmount(52000, completedYearsOfService(start, fiveYearsOn), cfg, yearsOfService(start, fiveYearsOn)))
        .toBe(150000); // 52000/26 x 15 x 5
    }
  });

  it("pays at exactly five years and not a day before", () => {
    const start = Date.parse("2021-06-15T00:00:00Z");
    const served = (to: string) => yearsOfService(start, Date.parse(`${to}T00:00:00Z`));
    expect(served("2026-06-15")).toBe(5);
    expect(served("2026-06-14")).toBeLessThan(5);
    expect(gratuityAmount(52000, 5, cfg, served("2026-06-15"))).toBe(150000);
    expect(gratuityAmount(52000, 5, cfg, served("2026-06-14"))).toBe(0);
  });

  // A 29 February anchor has no anniversary in a common year; it must land on one real day rather than drift
  // a fraction short of the gate forever.
  it("handles a 29 February joining date", () => {
    const leapStart = Date.parse("2020-02-29T00:00:00Z");
    expect(yearsOfService(leapStart, Date.parse("2025-03-01T00:00:00Z"))).toBe(5);
    expect(yearsOfService(leapStart, Date.parse("2025-02-28T00:00:00Z"))).toBeLessThan(5);
  });

  it("exempts the least of received, the statutory formula and the ceiling", () => {
    expect(gratuityExemption(180000, 52000, 6, cfg)).toBe(180000); // formula == received
    expect(gratuityExemption(500000, 52000, 6, cfg)).toBe(180000); // ex-gratia excess is taxable
    expect(gratuityExemption(3_000_000, 500000, 20, cfg)).toBe(2_000_000); // ceiling bites
  });
});

describe("leave encashment exemption at exit (s.10(10AA))", () => {
  it("is the least of received, the ceiling, ten months' salary and 30 days per year", () => {
    // 40 days at 60000/30 = 80000 received; 30 days/year allows 30 x 5 = 150 days, so the received amount stands.
    expect(leaveEncashmentExemption(80000, 60000, 40, 5)).toBe(80000);
    // Only 1 completed year: at most 30 days count -> 60000.
    expect(leaveEncashmentExemption(80000, 60000, 40, 1)).toBe(60000);
    // Ten months' salary caps a very large balance.
    expect(leaveEncashmentExemption(9_000_000, 300000, 400, 30)).toBe(2_500_000); // notified ceiling
  });
  it("is 0 without a salary or an amount", () => {
    expect(leaveEncashmentExemption(0, 60000, 10, 5)).toBe(0);
    expect(leaveEncashmentExemption(1000, 0, 10, 5)).toBe(0);
  });
});

// A month is the ceiling on the final-month salary.
//
// `daysWorkedInMonth` is assembled by the caller from a settlement date and a month start, and a disagreement
// between those two about which day (or which month) it is arrives here as a fraction above one - paying more
// than a whole month's gross for a month, on the largest single payment most employees ever receive. The
// caller's arithmetic is exact (services/settlements.ts anchors the settlement day to the org's calendar day
// rather than using the wall-clock instant the request arrived on); this is the invariant stated where it
// cannot be reintroduced from a new call site.
describe("computeSettlement - the month is the ceiling", () => {
  it("never pays more than a full month's gross for the final month", () => {
    const full = computeSettlement({ monthlyGross: 60000, basePay: 60000, daysWorkedInMonth: 30, daysInMonth: 30, leaveDays: 0, noticeShortfallDays: 0, reimbursements: 0 });
    // 31 days against a 30-day month is the shape the instant-vs-day bug produced on 30 September.
    const over = computeSettlement({ monthlyGross: 60000, basePay: 60000, daysWorkedInMonth: 31, daysInMonth: 30, leaveDays: 0, noticeShortfallDays: 0, reimbursements: 0 });
    expect(full.lines.find((l) => l.code === "SALARY")!.amount).toBe(60000);
    expect(over.lines.find((l) => l.code === "SALARY")!.amount).toBe(60000);
    expect(over.net).toBe(full.net);
  });

  it("takes loss of pay off the clamped month, not off an inflated one", () => {
    const s = computeSettlement({
      monthlyGross: 60000, basePay: 60000, daysWorkedInMonth: 31, daysInMonth: 30, lopDaysInFinalMonth: 2,
      leaveDays: 0, noticeShortfallDays: 0, reimbursements: 0,
    });
    expect(s.lines.find((l) => l.code === "SALARY")!.amount).toBe(56000); // 28/30 of 60000, not 29/30
    expect(s.lines.find((l) => l.code === "SALARY")!.name).toContain("30 day(s)");
  });

  it("leaves an ordinary partial month exactly as it was", () => {
    const s = computeSettlement({ monthlyGross: 60000, basePay: 60000, daysWorkedInMonth: 13, daysInMonth: 30, leaveDays: 0, noticeShortfallDays: 0, reimbursements: 0 });
    expect(s.lines.find((l) => l.code === "SALARY")!.amount).toBe(26000); // 13/30
  });
});

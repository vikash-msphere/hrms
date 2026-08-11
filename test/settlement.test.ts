import { describe, it, expect } from "vitest";
import {
  computeSettlement, completedYearsOfService, gratuityAmount, gratuityExemption, leaveEncashmentExemption,
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
    const perDay = 90000 / 30; // 3000
    expect(s.lines.find((l) => l.name.startsWith("Salary"))?.amount).toBe(75000); // 150000 * 15/30
    expect(s.lines.find((l) => l.name.startsWith("Leave"))?.amount).toBe(perDay * 10); // 30000
    expect(s.lines.find((l) => l.name === "Pending reimbursements")?.amount).toBe(4000);
    expect(s.lines.find((l) => l.name.startsWith("Notice"))?.amount).toBe(perDay * 5); // 15000
    expect(s.totalEarnings).toBe(75000 + 30000 + 4000);
    expect(s.totalDeductions).toBe(15000);
    expect(s.net).toBe(75000 + 30000 + 4000 - 15000); // 94000
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

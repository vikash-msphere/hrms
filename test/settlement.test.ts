import { describe, it, expect } from "vitest";
import { computeSettlement } from "../src/domain/settlement";

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

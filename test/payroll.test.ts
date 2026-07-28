import { describe, it, expect } from "vitest";
import { computeRunItem, canTransition, isEditable, overtimePay, wholeMonthsBetween, ctcLines, splitCtc, DEFAULT_CTC_CONFIG, DEFAULT_OVERTIME_CONFIG } from "../src/domain/payroll";
import { monthlyRecurringGross } from "../src/services/taxProjection";
import { grantFor } from "../src/domain/grants";
import { resolveRequest, decide } from "../src/domain/permissions";

describe("overtime pay (pure)", () => {
  it("prices from base pay × multiplier when no flat rate (default 2×, 200h/mo)", () => {
    // hourly = 40000/200 = 200; ×2 = 400/h; 90min = 1.5h → 600
    expect(overtimePay(90, 40000, DEFAULT_OVERTIME_CONFIG)).toBe(600);
  });
  it("uses a flat rate_per_hour when set (multiplier ignored)", () => {
    expect(overtimePay(120, 40000, { enabled: true, multiplier: 2, hours_per_month: 200, rate_per_hour: 300 })).toBe(600);
  });
  it("is 0 for no minutes", () => {
    expect(overtimePay(0, 40000, DEFAULT_OVERTIME_CONFIG)).toBe(0);
  });
});

describe("whole months between (arrears sizing)", () => {
  const ms = (s: string) => Date.parse(s + "T00:00:00Z");
  it("counts calendar months, 0 when not backdated", () => {
    expect(wholeMonthsBetween(ms("2026-04-01"), ms("2026-06-01"))).toBe(2);
    expect(wholeMonthsBetween(ms("2026-06-10"), ms("2026-06-01"))).toBe(0);
    expect(wholeMonthsBetween(ms("2025-12-01"), ms("2026-02-01"))).toBe(2);
  });
});

describe("CTC breakdown (ctcLines, pure)", () => {
  // Employer contributions are DATA (employer_contribution pay components), never hardcoded. These mirror the
  // seeded catalog: gratuity = 4.81% of basic, employer PF = 12% of basic capped at the ₹15,000 ceiling.
  const gratuity = { kind: "employer_contribution" as const, method: "percent_base", name: "Gratuity", rate: 4.81, cap: null, recurring: true };
  const erPf = { kind: "employer_contribution" as const, method: "epf", name: "Employer PF", rate: 12, cap: 15000, recurring: true };

  it("adds a gratuity employer contribution on top of basic; EPF opted out", () => {
    const { lines, ctcMonthly } = ctcLines(50000, [gratuity], false, DEFAULT_CTC_CONFIG);
    // 50000 basic + 4.81% gratuity = 52405
    expect(ctcMonthly).toBe(52405);
    expect(lines.map((l) => l.name)).toEqual(["Basic", "Gratuity"]);
  });
  it("adds the Special Allowance plug as a gross earning; ctcMonthly is the sum of all lines", () => {
    const { lines, ctcMonthly } = ctcLines(50000, [gratuity], false, DEFAULT_CTC_CONFIG, 30000);
    expect(lines.find((l) => l.name === "Special Allowance")?.monthly).toBe(30000);
    expect(ctcMonthly).toBe(82405); // 50000 + 30000 + 2405 gratuity
    expect(lines.reduce((s, l) => s + l.monthly, 0)).toBe(ctcMonthly);
  });
  it("has no employer-contribution lines when none are configured (CTC == gross)", () => {
    const { ctcMonthly, lines } = ctcLines(50000, [], false, DEFAULT_CTC_CONFIG);
    expect(ctcMonthly).toBe(50000);
    expect(lines.map((l) => l.name)).toEqual(["Basic"]);
  });
  it("gates an employer-PF (method epf) contribution on the employee's EPF enrolment", () => {
    expect(ctcLines(50000, [erPf], false, DEFAULT_CTC_CONFIG).ctcMonthly).toBe(50000); // opted out: no PF
    // Enrolled: 12% of basic capped at 15000 = 1800 on top.
    const { lines, ctcMonthly } = ctcLines(50000, [erPf], true, DEFAULT_CTC_CONFIG);
    expect(ctcMonthly).toBe(51800);
    expect(lines.find((l) => l.name === "Employer PF")?.monthly).toBe(1800);
  });
  it("excludes employer PF from the CTC total when employer_pf_in_ctc is off (CTC + PF)", () => {
    const cfg = { ...DEFAULT_CTC_CONFIG, employer_pf_in_ctc: false };
    const { lines, ctcMonthly } = ctcLines(50000, [gratuity, erPf], true, cfg);
    // Gratuity stays IN CTC (50000 + 2405); PF (1800) rides over and above, marked aboveCtc, out of the total.
    expect(ctcMonthly).toBe(52405);
    const pf = lines.find((l) => l.name === "Employer PF");
    expect(pf?.monthly).toBe(1800);
    expect(pf?.aboveCtc).toBe(true);
    expect(lines.find((l) => l.name === "Gratuity")?.aboveCtc).toBeUndefined();
  });
  it("top-down split with PF off solves the rest of CTC and lets PF ride on top", () => {
    const target = 100000;
    const cfg = { ...DEFAULT_CTC_CONFIG, employer_pf_in_ctc: false };
    const split = splitCtc(target, [erPf], true, cfg);
    // The split's CTC (PF excluded) lands on the target; PF then sits above it.
    const { ctcMonthly } = ctcLines(split!.basePay, [erPf], true, cfg, split!.specialAllowance);
    expect(Math.abs(ctcMonthly - target)).toBeLessThan(1);
  });
});

describe("top-down CTC split (splitCtc, pure)", () => {
  const gratuity = { kind: "employer_contribution" as const, method: "percent_base", name: "Gratuity", rate: 4.81, cap: null, recurring: true };
  it("pins basic at basic_pct% and solves a plug that reconstructs the target CTC", () => {
    const target = 100000; // monthly
    const split = splitCtc(target, [gratuity], false, DEFAULT_CTC_CONFIG);
    expect(split).not.toBeNull();
    expect(split!.basePay).toBe(50000); // 50% of the monthly CTC
    // Feeding the split back through ctcLines lands on the target (within a rupee).
    const back = ctcLines(split!.basePay, [gratuity], false, DEFAULT_CTC_CONFIG, split!.specialAllowance).ctcMonthly;
    expect(Math.abs(back - target)).toBeLessThanOrEqual(0.5);
  });
  it("returns null when even a zero plug already overshoots (basic_pct too high to fit)", () => {
    // basic_pct 100 => basic = full CTC, and the gratuity contribution on top already exceeds the target.
    expect(splitCtc(100000, [gratuity], false, { ...DEFAULT_CTC_CONFIG, basic_pct: 100 })).toBeNull();
  });
});

describe("monthly recurring gross (arrears base, pure)", () => {
  it("includes the Special Allowance plug, not just basic", () => {
    // Regression guard: backdated arrears size off recurring GROSS, so a raise landing in the
    // Special Allowance (as it does under the top-down split) must count.
    expect(monthlyRecurringGross(50000, [], 30000)).toBe(80000);
    expect(monthlyRecurringGross(50000, [])).toBe(50000);
  });
});

describe("payroll math (pure)", () => {
  it("net = sum(earnings) - sum(deductions)", () => {
    const r = computeRunItem([
      { code: "BASIC", name: "Base", kind: "earning", amount: 5000 },
      { code: "HRA", name: "HRA", kind: "earning", amount: 2000 },
      { code: "LOP", name: "Loss of pay", kind: "deduction", amount: 733.33 },
    ]);
    expect(r).toEqual({ gross: 7000, taxableGross: 7000, totalDeductions: 733.33, net: 6266.67 });
  });

  it("a non-taxable earning (e.g. reimbursement) is paid in net but excluded from taxableGross", () => {
    const r = computeRunItem([
      { code: "BASIC", name: "Base", kind: "earning", amount: 5000 },
      { code: "REIMB", name: "Reimbursement", kind: "earning", amount: 1200, taxable: false },
    ]);
    expect(r).toEqual({ gross: 6200, taxableGross: 5000, totalDeductions: 0, net: 6200 });
  });
});

describe("payroll run state machine (pure)", () => {
  it("allows DRAFT->REVIEW->APPROVED->PUBLISHED", () => {
    expect(canTransition("DRAFT", "REVIEW")).toBe(true);
    expect(canTransition("REVIEW", "APPROVED")).toBe(true);
    expect(canTransition("APPROVED", "PUBLISHED")).toBe(true);
  });
  it("forbids editing/regressing an approved or published run", () => {
    expect(canTransition("APPROVED", "DRAFT")).toBe(false);
    expect(canTransition("PUBLISHED", "APPROVED")).toBe(false);
    expect(isEditable("APPROVED")).toBe(false);
    expect(isEditable("DRAFT")).toBe(true);
  });
});

describe("payroll run items (review breakdown) read authz", () => {
  const canRead = (role: string) =>
    decide(grantFor(role), resolveRequest("GET", "/v1/payroll-runs/07-1/items"), { employeeCode: "07-002-001" }).allow;
  it("payroll_admin + super may read; employee + manager may not", () => {
    for (const role of ["payroll_admin", "super_admin"]) expect(canRead(role)).toBe(true);
    for (const role of ["employee", "manager"]) expect(canRead(role)).toBe(false);
  });
});

describe("payroll run delete authz (the PUBLISHED guard is a service precondition)", () => {
  const canDelete = (role: string) =>
    decide(grantFor(role), resolveRequest("DELETE", "/v1/payroll-runs/07-1"), { employeeCode: "07-002-001" }).allow;
  it("payroll_admin + super may delete; employee + manager may not", () => {
    for (const role of ["payroll_admin", "super_admin"]) expect(canDelete(role)).toBe(true);
    for (const role of ["employee", "manager"]) expect(canDelete(role)).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { computeRunItem, canTransition, isEditable, overtimePay, ctcLines, splitCtc, employerCostLines, pfWagesOf, DEFAULT_CTC_CONFIG, DEFAULT_OVERTIME_CONFIG } from "../src/domain/payroll";
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

describe("CTC breakdown (ctcLines, pure)", () => {
  // Employer contributions are DATA (employer_contribution pay components), never hardcoded. These mirror the
  // seeded catalog: gratuity = 4.81% of basic, employer PF = 12% of basic capped at the ₹15,000 ceiling.
  const gratuity = { kind: "employer_contribution" as const, method: "percent_base", name: "Gratuity", rate: 4.81, cap: null, recurring: true };
  const erPf = { kind: "employer_contribution" as const, method: "epf", name: "Employer PF", rate: 12, cap: 15000, recurring: true };

  it("adds a gratuity employer contribution on top of basic; EPF opted out", () => {
    const { lines, ctcMonthly } = ctcLines(50000, [gratuity], false);
    // 50000 basic + 4.81% gratuity = 52405
    expect(ctcMonthly).toBe(52405);
    expect(lines.map((l) => l.name)).toEqual(["Basic", "Gratuity"]);
  });
  it("adds the Special Allowance plug as a gross earning; ctcMonthly is the sum of all lines", () => {
    const { lines, ctcMonthly } = ctcLines(50000, [gratuity], false, 30000);
    expect(lines.find((l) => l.name === "Special Allowance")?.monthly).toBe(30000);
    expect(ctcMonthly).toBe(82405); // 50000 + 30000 + 2405 gratuity
    expect(lines.reduce((s, l) => s + l.monthly, 0)).toBe(ctcMonthly);
  });
  it("has no employer-contribution lines when none are configured (CTC == gross)", () => {
    const { ctcMonthly, lines } = ctcLines(50000, [], false);
    expect(ctcMonthly).toBe(50000);
    expect(lines.map((l) => l.name)).toEqual(["Basic"]);
  });
  it("gates an employer-PF (method epf) contribution on the employee's EPF enrolment", () => {
    expect(ctcLines(50000, [erPf], false).ctcMonthly).toBe(50000); // opted out: no PF
    // Enrolled: 12% of basic capped at 15000 = 1800 on top.
    const { lines, ctcMonthly } = ctcLines(50000, [erPf], true);
    expect(ctcMonthly).toBe(51800);
    expect(lines.find((l) => l.name === "Employer PF")?.monthly).toBe(1800);
  });
  it("excludes a contribution marked over-and-above-CTC from the CTC total (CTC + PF)", () => {
    // The CTC side is per component (`inCtc`), so any contribution - PF here, ESI or gratuity just as well -
    // can be paid over and above CTC without touching the others.
    const { lines, ctcMonthly } = ctcLines(50000, [gratuity, { ...erPf, inCtc: false }], true);
    // Gratuity stays IN CTC (50000 + 2405); PF (1800) rides over and above, marked aboveCtc, out of the total.
    expect(ctcMonthly).toBe(52405);
    const pf = lines.find((l) => l.name === "Employer PF");
    expect(pf?.monthly).toBe(1800);
    expect(pf?.aboveCtc).toBe(true);
    expect(lines.find((l) => l.name === "Gratuity")?.aboveCtc).toBeUndefined();
  });
  // employerCostLines is what the payroll run, the payslip and ctcLines itself all price the employer's cost
  // with, so the CTC-inclusion verdict is decided once. These pin the contract the run relies on.
  it("employerCostLines codes each contribution, prices it, and carries the CTC verdict", () => {
    const erEsi = { kind: "employer_contribution" as const, method: "esi", name: "Employer ESI", rate: 3.25, cap: 21000, recurring: true };
    const inCtc = employerCostLines(50000, 60000, [gratuity, erPf, erEsi], true);
    // Gratuity + PF only: gross 60000 is over the ESI ceiling, so no employer ESI.
    // `basis` is the wage each was priced on - basic for gratuity (percent_base), PF wages for employer PF -
    // carried so the statutory register states the run's own wage instead of dividing a rounded contribution.
    expect(inCtc).toEqual([
      { code: "ER_GRATUITY", name: "Gratuity", monthly: 2405, aboveCtc: false, basis: 50000 },
      { code: "ER_EPF", name: "Employer PF", monthly: 1800, aboveCtc: false, basis: 50000 },
    ]);
    // Each component decides its own side: here PF rides above CTC while gratuity stays inside it, and vice
    // versa - the flag is data on the row, not a policy about PF.
    expect(employerCostLines(50000, 60000, [gratuity, { ...erPf, inCtc: false }], true).map((l) => [l.code, l.aboveCtc]))
      .toEqual([["ER_GRATUITY", false], ["ER_EPF", true]]);
    expect(employerCostLines(50000, 60000, [{ ...gratuity, inCtc: false }, erPf], true).map((l) => [l.code, l.aboveCtc]))
      .toEqual([["ER_GRATUITY", true], ["ER_EPF", false]]);
    // Employer ESI can sit over and above CTC too (nothing is PF-specific).
    expect(employerCostLines(20000, 20000, [{ ...erEsi, inCtc: false }], true).map((l) => [l.code, l.aboveCtc])).toEqual([["ER_ESI", true]]);
    // PF is opt-in per employee, exactly as on the employee side.
    expect(employerCostLines(50000, 60000, [erPf], false)).toEqual([]);
    // An explicit ESI verdict (payroll's sticky eligibility) overrides the plain ceiling test.
    expect(employerCostLines(20000, 24000, [erEsi], true, true)[0]).toEqual({ code: "ER_ESI", name: "Employer ESI", monthly: 780, aboveCtc: false, basis: 24000 });
    expect(employerCostLines(20000, 20000, [erEsi], true, false)).toEqual([]);
  });
  it("top-down split with an over-and-above-CTC contribution solves the rest and lets it ride on top", () => {
    const target = 100000;
    const pfAbove = { ...erPf, inCtc: false };
    const split = splitCtc(target, [pfAbove], true, DEFAULT_CTC_CONFIG);
    // The split's CTC (PF excluded) lands on the target; PF then sits above it.
    const { ctcMonthly } = ctcLines(split!.basePay, [pfAbove], true, split!.specialAllowance);
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
    const back = ctcLines(split!.basePay, [gratuity], false, split!.specialAllowance).ctcMonthly;
    expect(Math.abs(back - target)).toBeLessThanOrEqual(0.5);
  });
  it("returns null when even a zero plug already overshoots (basic_pct too high to fit)", () => {
    // basic_pct 100 => basic = full CTC, and the gratuity contribution on top already exceeds the target.
    expect(splitCtc(100000, [gratuity], false, { ...DEFAULT_CTC_CONFIG, basic_pct: 100 })).toBeNull();
  });

  // Employer ESI is the one component that makes CTC NON-MONOTONIC in the plug: it is charged only while gross
  // is at or under the eligibility ceiling, so at the rupee the plug pushes gross past it the ESI line drops to
  // zero and the CTC steps DOWN by ~3.25% of the ceiling. The solver must still answer a plug that rebuilds the
  // target on both sides of that step, and across the ceiling itself - which is precisely the band of salaries
  // where most of an Indian org's headcount sits, so "it only bites at the edges" is not a defence.
  //
  // The sweep is the point: a single target proves a single crossing, and the failure this guards is a target
  // landing somewhere the search does not look. The stride is deliberately not a round number, so the samples
  // do not line up with the ceiling or with the solver's own scan grid.
  it("reconstructs the target on both sides of the employer-ESI eligibility cliff", () => {
    const esi = { kind: "employer_contribution" as const, method: "esi", name: "Employer ESI", rate: 3.25, cap: 21000, recurring: true };
    for (let target = 18000; target <= 30000; target += 37) {
      const split = splitCtc(target, [esi], false, DEFAULT_CTC_CONFIG);
      expect(split, `no split for target ${target}`).not.toBeNull();
      const back = ctcLines(split!.basePay, [esi], false, split!.specialAllowance).ctcMonthly;
      // Within a rupee, not within a paise: ESI is rounded UP to the next rupee, so the reachable CTCs are a
      // one-rupee staircase and some targets fall in a gap between two treads. Off by under a rupee is the
      // closest a split can be; off by more would mean the solver settled somewhere that is not a crossing.
      expect(Math.abs(back - target), `target ${target} reconstructed as ${back}`).toBeLessThan(1);
    }
  });

  it("never answers a split that fails to reconstruct its own target", () => {
    // The guarantee stated as itself: whatever the component mix, a non-null answer always rebuilds the target.
    // A fixed employer cost larger than the whole target is unsolvable at any plug, and is answered with null
    // rather than with the nearest thing to it.
    const huge = { kind: "employer_contribution" as const, method: "fixed", name: "Unfunded cost", rate: 500000, cap: null, recurring: true };
    expect(splitCtc(100000, [huge], false, DEFAULT_CTC_CONFIG)).toBeNull();
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

// PF wages: what EPF, EDLI and the administration charge are all priced on.
describe("PF wages + the employer's PF side-charges (pure)", () => {
  const hra = { kind: "earning" as const, method: "percent_base", name: "HRA", rate: 40, cap: null, recurring: true };
  const conveyance = { kind: "earning" as const, method: "fixed", name: "Conveyance", rate: 1600, cap: null, recurring: true, pfWages: true };
  const erPf = { kind: "employer_contribution" as const, method: "epf", name: "Employer PF", rate: 12, cap: 15000, recurring: true };
  const edli = { kind: "employer_contribution" as const, method: "edli", name: "EDLI", rate: 0.5, cap: 15000, recurring: true };
  const admin = { kind: "employer_contribution" as const, method: "pf_admin", name: "PF admin", rate: 0.5, cap: 15000, recurring: true };

  it("defaults to basic alone", () => {
    expect(pfWagesOf(20000, 5000, [hra, conveyance])).toBe(20000);
  });
  it("under basic_plus adds the Special Allowance plug + only the FLAGGED allowances (never HRA)", () => {
    expect(pfWagesOf(20000, 5000, [hra, conveyance], "basic_plus")).toBe(26600); // 20000 + 5000 + 1600
  });

  it("prices EDLI + administration charges on PF wages, capped at the same ceiling", () => {
    // PF wages 12000 (under the 15000 ceiling): 12% / 0.5% / 0.5% of 12000.
    expect(employerCostLines(12000, 20000, [erPf, edli, admin], true, undefined, 12000).map((l) => [l.code, l.monthly]))
      .toEqual([["ER_EPF", 1440], ["ER_EDLI", 60], ["ER_PF_ADMIN", 60]]);
    // Above the ceiling everything sits on 15000.
    expect(employerCostLines(50000, 80000, [erPf, edli, admin], true, undefined, 50000).map((l) => [l.code, l.monthly]))
      .toEqual([["ER_EPF", 1800], ["ER_EDLI", 75], ["ER_PF_ADMIN", 75]]);
  });

  it("skips the whole PF family for an employee who is not a member", () => {
    expect(employerCostLines(20000, 20000, [erPf, edli, admin], false)).toEqual([]);
  });

  it("counts the charges in the CTC build-up (they are real employer cost)", () => {
    // Basic 20000 is over the 15000 ceiling, so all three sit on 15000: 1800 + 75 + 75.
    const { ctcMonthly } = ctcLines(20000, [erPf, edli, admin], true);
    expect(ctcMonthly).toBe(20000 + 1800 + 75 + 75);
  });
});

// A perquisite is taxable value the employee never receives: it lifts the taxable gross and nothing else.
describe("computeRunItem: perquisite + negative-earning loss of pay", () => {
  it("adds perquisite value to taxable gross only", () => {
    const t = computeRunItem([
      { code: "BASIC", name: "Basic", kind: "earning", amount: 50000 },
      { code: "PERQ_LOAN", name: "Loan interest concession", kind: "perquisite", amount: 1200 },
    ]);
    expect(t.gross).toBe(50000);
    expect(t.taxableGross).toBe(51200);
    expect(t.net).toBe(50000);
  });
  it("takes loss of pay out of gross AND the taxable base", () => {
    const t = computeRunItem([
      { code: "BASIC", name: "Basic", kind: "earning", amount: 50000 },
      { code: "LOP", name: "Loss of pay (3d)", kind: "earning", amount: -5000 },
    ]);
    expect(t.gross).toBe(45000);
    expect(t.taxableGross).toBe(45000);
    expect(t.net).toBe(45000);
  });
});

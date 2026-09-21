/// <reference types="vite/client" />
// The run-to-run statement, and the two numbers in it that must always read zero.
//
// The residual assertions are the important ones. `reconcileRuns` buckets exhaustively, so a non-zero residual
// cannot mean "payroll is wrong" - it can only mean this file has a hole in its bucketing and the attribution
// printed beside it is lying. That makes the residual a test of the decomposition, which is why the last two
// cases throw shapes at it that no hand-written example would cover.
import { describe, it, expect } from "vitest";
import { reconcileRuns, MOVEMENT_ORDER, type RunItemSnapshot } from "../src/domain/payrollReconcile";
import type { Line } from "../src/domain/payroll";

const earn = (code: string, amount: number): Line => ({ code, name: code, kind: "earning", amount });
const deduct = (code: string, amount: number): Line => ({ code, name: code, kind: "deduction", amount });
const item = (employeeId: string, ...lines: Line[]): RunItemSnapshot => ({ employeeId, lines });
const amountOf = (r: ReturnType<typeof reconcileRuns>, key: string) => r.movements.find((m) => m.key === key)!.amount;
const countOf = (r: ReturnType<typeof reconcileRuns>, key: string) => r.movements.find((m) => m.key === key)!.employees;

const BASIC = (n: number) => earn("BASIC", n);

describe("reconcileRuns", () => {
  it("attributes a month with a joiner, a leaver, a raise and a bonus", () => {
    const prior = [
      item("a", BASIC(50_000)),
      item("b", BASIC(40_000)),
      item("c", BASIC(30_000)), // leaves
    ];
    const current = [
      item("a", BASIC(55_000)), // raise: +5,000
      item("b", BASIC(40_000), earn("BONUS", 10_000)), // one-off: +10,000
      item("d", BASIC(35_000)), // joiner
    ];
    const r = reconcileRuns(prior, current);

    expect(r.opening).toEqual({ employees: 3, gross: 120_000 });
    expect(r.closing).toEqual({ employees: 3, gross: 140_000 });
    expect(amountOf(r, "joiners")).toBe(35_000);
    expect(amountOf(r, "leavers")).toBe(-30_000);
    expect(amountOf(r, "recurring")).toBe(5_000);
    expect(amountOf(r, "added")).toBe(10_000);
    expect(amountOf(r, "dropped")).toBe(0);
    // The statement closes: 120,000 + 35,000 - 30,000 + 5,000 + 10,000 = 140,000.
    expect(r.residual).toBe(0);
    expect(r.headcountResidual).toBe(0);
  });

  it("counts people as well as money, so one big movement is not read as many", () => {
    // Same amount, very different facts: one person's joining bonus against eighty people's raises.
    const prior = [item("a", BASIC(100_000)), item("b", BASIC(100_000))];
    const current = [item("a", BASIC(100_000), earn("BONUS", 80_000)), item("b", BASIC(100_000))];
    const r = reconcileRuns(prior, current);
    expect(amountOf(r, "added")).toBe(80_000);
    expect(countOf(r, "added")).toBe(1);
    expect(countOf(r, "recurring")).toBe(0); // nobody's recurring pay moved
  });

  it("drops a one-off that was paid last month and not this one", () => {
    const prior = [item("a", BASIC(50_000), earn("OVERTIME", 4_000))];
    const current = [item("a", BASIC(50_000))];
    const r = reconcileRuns(prior, current);
    expect(amountOf(r, "dropped")).toBe(-4_000);
    expect(r.closing.gross - r.opening.gross).toBe(-4_000);
    expect(r.residual).toBe(0);
  });

  it("reads a renamed component as the same component", () => {
    // THE CASE THE CODE KEY EXISTS FOR. Renaming "Special Allowance" does not change what anybody is paid, and
    // matching on the display name would report a dropped line and an added line of identical size - two
    // movements, both fictional, that happen to cancel.
    const prior = [item("a", BASIC(50_000), { code: "SPL", name: "Special Allowance", kind: "earning", amount: 9_000 })];
    const current = [item("a", BASIC(50_000), { code: "SPL", name: "Flexible Allowance", kind: "earning", amount: 9_000 })];
    const r = reconcileRuns(prior, current);
    for (const key of MOVEMENT_ORDER) expect(amountOf(r, key)).toBe(0);
    expect(r.residual).toBe(0);
  });

  it("ignores everything that is not an earning", () => {
    // Deductions are their own question. A month where only the tax moved has NOT changed what payroll costs,
    // and folding deductions in would reconcile gross to a number nobody is looking at.
    const prior = [item("a", BASIC(50_000), deduct("TDS", 4_000))];
    const current = [item("a", BASIC(50_000), deduct("TDS", 9_000))];
    const r = reconcileRuns(prior, current);
    expect(r.opening.gross).toBe(50_000);
    expect(r.closing.gross).toBe(50_000);
    for (const key of MOVEMENT_ORDER) expect(amountOf(r, key)).toBe(0);
  });

  it("calls everybody a joiner on the very first run", () => {
    const r = reconcileRuns([], [item("a", BASIC(50_000)), item("b", BASIC(40_000))]);
    expect(r.opening).toEqual({ employees: 0, gross: 0 });
    expect(amountOf(r, "joiners")).toBe(90_000);
    expect(countOf(r, "joiners")).toBe(2);
    expect(r.residual).toBe(0);
    expect(r.headcountResidual).toBe(0);
  });

  it("counts a joiner who priced at zero", () => {
    // Somebody who started on the last day of the period can price at nothing. They are still a joiner, and if
    // membership were inferred from a non-zero amount the headcount identity would break on a correct run.
    const r = reconcileRuns([item("a", BASIC(50_000))], [item("a", BASIC(50_000)), item("z")]);
    expect(countOf(r, "joiners")).toBe(1);
    expect(amountOf(r, "joiners")).toBe(0);
    expect(r.headcountResidual).toBe(0);
    expect(r.residual).toBe(0);
  });

  it("closes on randomly generated pairs of runs", () => {
    // THE PROPERTY, not an example. Both residuals are zero by construction, so any shape that produces a
    // non-zero one has found a bucket this file forgot - which is exactly the failure a hand-written case
    // cannot be relied on to contain.
    let seed = 20260920;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
    const CODES = ["BASIC", "HRA", "SPL", "BONUS", "OVERTIME", "ARREARS"];

    for (let round = 0; round < 200; round++) {
      const build = (): RunItemSnapshot[] => {
        const people = Math.floor(rnd() * 6);
        const out: RunItemSnapshot[] = [];
        for (let p = 0; p < people; p++) {
          const lines: Line[] = [];
          const n = Math.floor(rnd() * 4);
          for (let l = 0; l < n; l++) {
            const amount = Math.round(rnd() * 100_000) / 100;
            // Deductions and employer contributions in the mix, so "earnings only" is exercised too.
            const kind = pick(["earning", "earning", "earning", "deduction", "employer_contribution"] as const);
            lines.push({ code: pick(CODES), name: "x", kind, amount });
          }
          out.push(item(`e${Math.floor(rnd() * 8)}`, ...lines));
        }
        // Two items for one employee in one run is not a thing the schema allows (rri_run_emp_idx), so collapse.
        return [...new Map(out.map((i) => [i.employeeId, i])).values()];
      };
      const r = reconcileRuns(build(), build());
      expect(r.residual).toBe(0);
      expect(r.headcountResidual).toBe(0);
    }
  });
});

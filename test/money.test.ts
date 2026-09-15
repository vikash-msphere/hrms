import { describe, it, expect } from "vitest";
import { round2, sum2 } from "../src/domain/money";

// The one money-rounding helper. These lock the decimal-half correctness that the old inline
// `Math.round(n * 100) / 100` got WRONG (the multiply happened in float, so a .xx5 case rounded down).
describe("round2", () => {
  it("rounds decimal half-cases the way a human expects (the bug the inline form had)", () => {
    expect(round2(1.005)).toBe(1.01); // Math.round(1.005*100)/100 === 1.00 (wrong)
    expect(round2(2.675)).toBe(2.68); // Math.round(2.675*100)/100 === 2.67 (wrong)
    expect(round2(5.015)).toBe(5.02);
    expect(round2(1000000.005)).toBe(1000000.01); // still correct at large magnitude
  });
  it("breaks ties AWAY FROM ZERO, so a negative amount rounds like its positive twin", () => {
    // `Math.round` ties toward +∞, which treats the same half-paise as a round-up on one sign and a round-down
    // on the other. Loss of pay is a negative earning, and corrections and clawbacks are negative too, so the
    // asymmetry is reachable with ordinary payroll data - not only in theory.
    expect(round2(-1.005)).toBe(-1.01);
    expect(round2(-2.675)).toBe(-2.68);
    expect(round2(-5.015)).toBe(-5.02);
    expect(round2(-1.005)).toBe(-round2(1.005));
    expect(round2(-0.125)).toBe(-round2(0.125));
    // Never -0: it compares equal to 0 but renders as "-0" on a payslip.
    expect(Object.is(round2(-0.001), 0)).toBe(true);
    expect(Object.is(round2(-1e-9), 0)).toBe(true);
  });
  it("clears float accumulation noise", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3); // 0.30000000000000004 -> 0.3
    expect(round2(70000 / 3)).toBe(23333.33);
  });
  it("preserves plain 2dp values and passes through exact ones", () => {
    expect(round2(25000)).toBe(25000);
    expect(round2(1234.56)).toBe(1234.56);
    expect(round2(0)).toBe(0);
  });
  it("collapses sub-paise noise to 0", () => {
    expect(round2(1e-9)).toBe(0);
  });

  // A NON-FINITE FIGURE THROWS RATHER THAN ANSWERING 0, which is the failure mode this whole module's header
  // names. It is reached the ordinary way - a float accumulator that overflows - and answering 0 turns an
  // overflowed total into a report that reads as untouched: `computeBudgetSpendMany` accumulates SUBMITTED
  // expenses into a plain `+=`, so two absurd claims made a budget show `pending: 0` and `remaining: the whole
  // cap` with the rows still on the books, and no threshold alert fired. Same call domain/incomeTax.ts
  // #monthlyTds makes: "an arrival is worth a throw rather than a zero".
  it("throws on a non-finite figure instead of answering zero", () => {
    expect(() => round2(NaN)).toThrow(/non-finite/);
    expect(() => round2(Infinity)).toThrow(/non-finite/);
    expect(() => round2(-Infinity)).toThrow(/non-finite/);
    // The overflowed TOTAL is the reachable case, and it surfaces rather than reading as 0.
    expect(() => sum2([1e308, 1e308])).toThrow(/non-finite/);
  });
  it("stays a number at the top of the range, where JS stringifies exponentially", () => {
    // The decimal-string scaling (`${n}e2`) only parses while `n` is positional. At 1e21 JS switches to
    // exponential and "1e21e2" is NaN - so the guard has to cover BOTH ends, not just the sub-paise one.
    // No real payroll figure lands here; a rounding helper that silently answers NaN is the problem.
    for (const n of [1e21, -1e21, 5e30, Number.MAX_VALUE]) {
      expect(Number.isFinite(round2(n)), String(n)).toBe(true);
    }
    expect(round2(1e21)).toBe(1e21);
    expect(round2(-1e21)).toBe(-1e21);
  });

  // THE HOLE UNDERNEATH THAT GUARD. There are two decimal-string parses, and they go exponential at
  // DIFFERENT inputs: `${n}e2` at n = 1e21, but `${rounded}e-2` at rounded = 1e21, i.e. at n = 1e19. A guard
  // written against the first left the second answering NaN for two whole decades - and `|| 0` turned that
  // into a silent ZERO, which is worse than the NaN the guard was added to stop. Returning the value is the
  // only acceptable answer; returning 0 is money vanishing without an error.
  it("does not collapse to zero between 1e19 and 1e21, where only the SECOND parse goes exponential", () => {
    for (const n of [1e19, -1e19, 1.5e19, 1e20, 5e20, 9.99e20]) {
      expect(round2(n), String(n)).toBe(n);
    }
  });
});

describe("sum2", () => {
  it("sums then rounds ONCE (no per-row drift in the total)", () => {
    // Ten 0.1s: the running float sum is 0.9999999999999999; a single trailing round pins it to 1.00.
    expect(sum2(Array(10).fill(0.1))).toBe(1);
    expect(sum2([1000000.01, 2000000.02, 3000000.03])).toBe(6000000.06);
    expect(sum2([])).toBe(0);
    expect(sum2([1.005, 1.005])).toBe(2.01); // 2.0099999... -> 2.01
  });

  // A non-finite ELEMENT is a missing line, which has always meant "nothing to add"; a non-finite TOTAL is
  // every element being real and their sum leaving the range, which is the case that must not read as 0.
  it("drops a non-finite element but refuses a non-finite total", () => {
    expect(sum2([100, NaN, 50])).toBe(150);
    expect(sum2([1e308, 5000])).toBe(1e308); // large-but-finite still passes through
    expect(() => sum2([1e308, 1e308, 1e308])).toThrow(/non-finite/);
  });
});

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
  it("clears float accumulation noise", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3); // 0.30000000000000004 -> 0.3
    expect(round2(70000 / 3)).toBe(23333.33);
  });
  it("preserves plain 2dp values and passes through exact ones", () => {
    expect(round2(25000)).toBe(25000);
    expect(round2(1234.56)).toBe(1234.56);
    expect(round2(0)).toBe(0);
  });
  it("collapses non-finite / sub-paise noise to 0", () => {
    expect(round2(NaN)).toBe(0);
    expect(round2(Infinity)).toBe(0);
    expect(round2(1e-9)).toBe(0);
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
});

import { describe, it, expect } from "vitest";
import { decimalsFor, roundMoney, DEFAULT_CURRENCY_DECIMALS } from "../src/domain/currency";
import { round2 } from "../src/domain/money";

// Per-currency display/payout precision. Storage stays full precision (round2); this only decides how many
// places a currency is shown and paid in. INR defaults to 0 (whole rupees) by app convention.
describe("decimalsFor", () => {
  it("defaults INR to 0 (whole rupees) with no config", () => {
    expect(decimalsFor("INR")).toBe(0);
    expect(decimalsFor("inr")).toBe(0); // case-insensitive
  });
  it("uses 2 for a currency not in the base table", () => {
    expect(decimalsFor("USD")).toBe(2);
    expect(decimalsFor("EUR")).toBe(2);
  });
  it("honours known ISO exceptions", () => {
    expect(decimalsFor("JPY")).toBe(0);
    expect(decimalsFor("KWD")).toBe(3);
  });
  it("lets an org override win over the base table", () => {
    expect(decimalsFor("INR", { INR: 2 })).toBe(2); // org wants paise
    expect(decimalsFor("USD", { USD: 0 })).toBe(0);
  });
  it("clamps a bad config to [0, 4] and falls back on non-numbers", () => {
    expect(decimalsFor("INR", { INR: 9 })).toBe(4);
    expect(decimalsFor("INR", { INR: -1 })).toBe(0);
    expect(decimalsFor("USD", { USD: NaN as unknown as number })).toBe(2);
  });
  it("falls back to INR=0 when the code is null/empty", () => {
    expect(decimalsFor(null)).toBe(0);
    expect(decimalsFor(undefined)).toBe(0);
  });
  it("DEFAULT_CURRENCY_DECIMALS seeds INR to whole rupees", () => {
    expect(DEFAULT_CURRENCY_DECIMALS.INR).toBe(0);
  });
});

describe("roundMoney", () => {
  it("rounds to 0 decimals (whole rupees) decimal-half-correct", () => {
    expect(roundMoney(1800.5, 0)).toBe(1801);
    expect(roundMoney(1800.49, 0)).toBe(1800);
    expect(roundMoney(2.5, 0)).toBe(3); // the half rounds up in magnitude, like round2
  });
  it("rounds to 2 decimals like round2", () => {
    expect(roundMoney(1.005, 2)).toBe(1.01);
    expect(roundMoney(23333.335, 2)).toBe(23333.34);
  });
  it("supports 3-decimal currencies", () => {
    expect(roundMoney(1.2345, 3)).toBe(1.235);
  });
  it("collapses non-finite and sub-unit noise to 0", () => {
    expect(roundMoney(NaN, 0)).toBe(0);
    expect(roundMoney(0.4, 0)).toBe(0);
    expect(roundMoney(1e-9, 2)).toBe(0);
  });
  // The output boundary must round the way the ledger does, or a figure changes its mind between the stored
  // value and the payslip. Both halves of round2's contract, over the amounts that are actually negative here:
  // loss of pay is a negative earning, and a clawback / settlement correction is negative.
  it("ties AWAY FROM ZERO, so a half is treated the same on both signs", () => {
    expect(roundMoney(-2.5, 0)).toBe(-3); // not -2, which is what Math.round gives
    expect(roundMoney(-1800.5, 0)).toBe(-1801);
    expect(roundMoney(-1.005, 2)).toBe(round2(-1.005));
    expect(roundMoney(1.005, 2)).toBe(round2(1.005));
    expect(roundMoney(-2.5, 0)).toBe(-roundMoney(2.5, 0));
  });
  it("never answers NaN past the exponential-notation switch, and never -0", () => {
    // `${n}e${dp}` and `${rounded}e-${dp}` go exponential at different magnitudes; unchecked, the second one
    // answered NaN for values between them - a figure that renders as "NaN" rather than as a number.
    expect(roundMoney(5e20, 2)).toBe(5e20);
    expect(roundMoney(1e21, 2)).toBe(1e21);
    expect(Object.is(roundMoney(-0.004, 2), 0)).toBe(true); // "-0" on a payslip is not a number anyone wants
  });
});

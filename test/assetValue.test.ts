import { describe, it, expect } from "vitest";
import { bookValue } from "../src/domain/assetValue";

// `asset.book_value` is the one figure on the inventory that is arithmetic rather than a stored fact, so the
// rules it keeps have to be pinned here: straight line, floored at zero, and - the half that matters most -
// `undefined` rather than 0 whenever an input is missing. A 0 for un-priced kit would total identically to
// kit that is genuinely written off, and every "what are we holding" sum over the column would understate the
// company's position with nothing to show for it.

const DAY = 86_400_000;
const MONTH = 30.436_875 * DAY; // the mean month the helper writes down over
const NOW = Date.UTC(2026, 0, 1);
/** `n` months before NOW, as an epoch ms purchase date. */
const monthsAgo = (n: number) => NOW - n * MONTH;

describe("bookValue", () => {
  it("is the full cost on the day it was bought", () => {
    expect(bookValue(120_000, NOW, 36, NOW)).toBe(120_000);
  });

  it("writes down straight-line over the category's useful life", () => {
    // Halfway through a 36-month life: half the cost is gone.
    expect(bookValue(120_000, monthsAgo(18), 36, NOW)).toBeCloseTo(60_000, 2);
    // A third of the way through: two thirds left.
    expect(bookValue(90_000, monthsAgo(12), 36, NOW)).toBeCloseTo(60_000, 2);
  });

  it("floors at zero once the life is up, and stays there", () => {
    expect(bookValue(120_000, monthsAgo(36), 36, NOW)).toBe(0);
    expect(bookValue(120_000, monthsAgo(80), 36, NOW)).toBe(0);
  });

  it("never exceeds the purchase cost, even for a date in the future", () => {
    // A mis-typed year, or an order logged before it arrived. Nothing here appreciates.
    expect(bookValue(120_000, NOW + 400 * DAY, 36, NOW)).toBe(120_000);
  });

  it("rounds to paise, like every other money figure", () => {
    const v = bookValue(100_000, monthsAgo(7), 36, NOW)!;
    expect(v).toBe(Math.round(v * 100) / 100);
  });

  // The whole point of the helper's return type: these are not zero.
  it.each([
    ["no purchase cost", undefined, monthsAgo(6), 36],
    ["no purchase date", 120_000, undefined, 36],
    ["a category with no useful life", 120_000, monthsAgo(6), undefined],
    ["a null cost", null, monthsAgo(6), 36],
    ["a null life", 120_000, monthsAgo(6), null],
    ["a zero-month life", 120_000, monthsAgo(6), 0],
    ["a negative life", 120_000, monthsAgo(6), -12],
  ] as const)("answers undefined, not 0, for %s", (_label, cost, at, life) => {
    expect(bookValue(cost, at, life, NOW)).toBeUndefined();
  });

  it("refuses a non-finite figure rather than poisoning a total", () => {
    // One Infinity in a column turns every sum over it into Infinity - the hazard http/moneyField.ts fences
    // at the input. This is the same fence one layer further in, for a row that got past it some other way.
    expect(bookValue(Infinity, monthsAgo(6), 36, NOW)).toBeUndefined();
    expect(bookValue(Number.NaN, monthsAgo(6), 36, NOW)).toBeUndefined();
    expect(bookValue(120_000, Number.NaN, 36, NOW)).toBeUndefined();
  });

  it("values a free asset at zero, which is a real answer", () => {
    // A donation or a no-charge transfer in. Recorded as 0, and distinct from never having been priced.
    expect(bookValue(0, monthsAgo(6), 36, NOW)).toBe(0);
  });
});

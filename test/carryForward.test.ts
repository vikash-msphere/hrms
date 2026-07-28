import { describe, it, expect } from "vitest";
import { calendarYearOf, splitCarryForward, splitCarryForwardCumulative, splitEncashExcess } from "../src/domain/carryForward";

const ms = (d: string) => Date.parse(d + "T00:00:00Z");

describe("calendarYearOf", () => {
  it("is the UTC calendar year", () => {
    expect(calendarYearOf(ms("2025-03-31"))).toBe("2025");
    expect(calendarYearOf(ms("2026-01-01"))).toBe("2026");
  });
});

describe("splitCarryForward (per type)", () => {
  it("flag off -> the whole balance is excess (resets)", () => {
    expect(splitCarryForward(18, false, 10)).toEqual({ carried: 0, excess: 18 });
  });
  it("null cap -> unlimited carry-forward", () => {
    expect(splitCarryForward(18, true, null)).toEqual({ carried: 18, excess: 0 });
  });
  it("caps the carried balance, the rest is excess", () => {
    expect(splitCarryForward(18, true, 10)).toEqual({ carried: 10, excess: 8 });
  });
  it("under the cap carries everything", () => {
    expect(splitCarryForward(6, true, 10)).toEqual({ carried: 6, excess: 0 });
  });
});

describe("splitCarryForwardCumulative", () => {
  it("keeps everything when the total is within the cap", () => {
    expect(splitCarryForwardCumulative([5, 8], 20)).toEqual([{ carried: 5, excess: 0 }, { carried: 8, excess: 0 }]);
  });
  it("null cap is unlimited", () => {
    expect(splitCarryForwardCumulative([5, 8], null)).toEqual([{ carried: 5, excess: 0 }, { carried: 8, excess: 0 }]);
  });
  it("caps the total and reduces each proportionally", () => {
    // total 40, cap 30 -> factor 0.75; each kept at 75%.
    expect(splitCarryForwardCumulative([20, 20], 30)).toEqual([{ carried: 15, excess: 5 }, { carried: 15, excess: 5 }]);
  });
});

describe("splitEncashExcess", () => {
  it("forfeit mode forfeits all excess", () => {
    expect(splitEncashExcess(8, "forfeit", Infinity)).toEqual({ encash: 0, forfeit: 8 });
  });
  it("encash mode encashes up to the remaining encashment cap, forfeits the rest", () => {
    expect(splitEncashExcess(8, "encash", 5)).toEqual({ encash: 5, forfeit: 3 });
    expect(splitEncashExcess(8, "encash", Infinity)).toEqual({ encash: 8, forfeit: 0 });
    expect(splitEncashExcess(8, "encash", 0)).toEqual({ encash: 0, forfeit: 8 });
  });
});

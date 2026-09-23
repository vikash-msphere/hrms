import { describe, it, expect } from "vitest";
import { splitCarryForward, splitCarryForwardCumulative, splitEncashExcess } from "../src/domain/carryForward";

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

  // Each share rounded on its own can go up by half a paise-day, so N types put the KEPT total OVER the cap
  // the policy states - and left the excess (which the year-end auto-encashment PAYS OUT) short by the same
  // amount. Shares are allocated against a running total instead, so the kept total lands on the cap.
  it("never carries more than the shared cap, whatever the rounding", () => {
    const cases: [number[], number][] = [
      [[75.06, 97.28, 101.22, 107.79, 71.97, 12.63, 82.58], 30],
      [[108.21, 82.5, 51.86, 78.21, 16.92, 74], 15],
      [[104.68, 13.99, 63.51, 97.97], 10],
      [[1, 1, 1, 1, 1, 1, 1], 10 / 3],
    ];
    for (const [balances, cap] of cases) {
      const out = splitCarryForwardCumulative(balances, cap);
      const kept = Math.round(out.reduce((s, o) => s + o.carried, 0) * 100) / 100;
      expect(kept, `balances=${JSON.stringify(balances)} cap=${cap}`).toBe(Math.round(cap * 100) / 100);
      // And no days are invented or lost on any row: what is not carried is excess.
      out.forEach((o, i) => expect(Math.round((o.carried + o.excess) * 100) / 100).toBe(balances[i]!));
    }
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

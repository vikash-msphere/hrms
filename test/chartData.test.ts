/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { stackSeries, heatmapPoints, shareOf, monthlyTotals, topSlices, chartColors, heatmapColors } from "../web/src/lib/chartTheme";

// The arithmetic behind the app's charts. It lives in a pure module precisely so it can be checked here: a
// chart that draws the wrong numbers looks exactly as convincing as one that draws the right ones, and
// nothing downstream of these functions would notice.

describe("stackSeries", () => {
  it("turns per-band counts into running totals, so each band's top edge is the sum below it", () => {
    expect(stackSeries([[1, 2, 3], [10, 20, 30], [100, 200, 300]])).toEqual([
      [1, 2, 3],
      [11, 22, 33],
      [111, 222, 333],
    ]);
  });

  it("leaves the input alone and survives an empty set", () => {
    const input = [[1, 2]];
    expect(stackSeries([])).toEqual([]);
    stackSeries(input);
    expect(input).toEqual([[1, 2]]); // the caller's arrays are not mutated into their own stack
  });

  it("carries a shorter series without inventing values for the columns it does not reach", () => {
    expect(stackSeries([[1, 1, 1], [5]])).toEqual([[1, 1, 1], [6]]);
  });
});

describe("heatmapPoints", () => {
  it("keys each day by its UTC midnight in seconds, which is what the calendar reads", () => {
    const out = heatmapPoints(new Map([["2026-06-01", 8], ["2026-06-02", 4]]));
    expect(out[String(Date.parse("2026-06-01T00:00:00Z") / 1000)]).toBe(8);
    expect(out[String(Date.parse("2026-06-02T00:00:00Z") / 1000)]).toBe(4);
  });

  it("drops zero days and unparseable keys: a blank square and a zero say different things", () => {
    expect(heatmapPoints({ "2026-06-01": 0, "not-a-day": 5, "2026-06-03": 2 })).toEqual({
      [String(Date.parse("2026-06-03T00:00:00Z") / 1000)]: 2,
    });
  });
});

describe("shareOf", () => {
  it("turns quantities into whole percentage points", () => {
    expect(shareOf([25, 25, 50])).toEqual([25, 25, 50]);
    expect(shareOf([1, 1, 1])).toEqual([33, 33, 33]);
  });

  it("answers an empty funnel with zeroes rather than NaNs", () => {
    expect(shareOf([0, 0])).toEqual([0, 0]);
    expect(shareOf([])).toEqual([]);
  });
});

describe("monthlyTotals", () => {
  it("buckets by month and fills the quiet ones, oldest first", () => {
    const out = monthlyTotals(
      [
        { date: "2026-06-04", value: 10 },
        { date: "2026-06-20", value: 5 },
        { date: "2026-08-01", value: 2 },
        { date: "2025-01-01", value: 999 }, // outside the window: not counted anywhere
      ],
      3,
      "2026-08-26",
    );
    expect(out.values).toEqual([15, 0, 2]); // June, July (quiet), August
    expect(out.labels).toHaveLength(3);
  });
});

describe("topSlices", () => {
  it("totals by key, biggest first, and pools the tail into one honest slice", () => {
    const rows = [
      { k: "a", v: 5 }, { k: "b", v: 4 }, { k: "c", v: 3 },
      { k: "d", v: 2 }, { k: "e", v: 1 },
    ];
    const out = topSlices(rows, (r) => r.k, (r) => r.v, 3);
    expect(out.labels).toEqual(["a", "b", "c", "Other (2)"]);
    expect(out.values).toEqual([5, 4, 3, 3]);
  });

  it("names a missing key rather than dropping the rows under it, and skips empty totals", () => {
    const out = topSlices([{ k: "", v: 2 }, { k: "x", v: 0 }], (r) => r.k, (r) => r.v);
    expect(out.labels).toEqual(["Unspecified"]);
    expect(out.values).toEqual([2]);
  });
});

describe("the palettes", () => {
  it("gives every series a colour, repeating the categorical order past the eighth", () => {
    expect(chartColors("light", 3)).toHaveLength(3);
    const ten = chartColors("dark", 10);
    expect(ten).toHaveLength(10);
    expect(ten[8]).toBe(ten[0]); // wraps rather than running out
  });

  it("keeps light and dark distinct, and the heatmap at the five steps the calendar needs", () => {
    expect(chartColors("light", 1)[0]).not.toBe(chartColors("dark", 1)[0]);
    expect(heatmapColors("light")).toHaveLength(5);
    expect(heatmapColors("dark")).toHaveLength(5);
  });
});

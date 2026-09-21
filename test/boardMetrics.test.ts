/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { computeBoardMetrics } from "../src/domain/boardMetrics";

// Time in each column, over the stays that ended.
//
// The board already had the diagram; what it could not say is where the time goes, which is the question
// anybody looking at a cumulative flow chart is trying to answer by eye.

const DAY = 86_400_000;
const T0 = Date.parse("2026-01-01T00:00:00Z");
const NOW = T0 + 20 * DAY;
const COLUMNS = [{ key: "doing", label: "Doing" }, { key: "review", label: "Review" }, { key: "done", label: "Done" }];

describe("column dwell", () => {
  it("measures each ended stay, and ignores the one still running", () => {
    const movements = [
      // a: two days doing, one day in review, then done.
      { cardId: "a", toColumn: "doing", at: T0 },
      { cardId: "a", toColumn: "review", at: T0 + 2 * DAY },
      { cardId: "a", toColumn: "done", at: T0 + 3 * DAY },
      // b: four days doing, then still sitting in review right now.
      { cardId: "b", toColumn: "doing", at: T0 },
      { cardId: "b", toColumn: "review", at: T0 + 4 * DAY },
    ];
    const cards = [
      { committedAt: T0, startedAt: T0, deliveredAt: T0 + 3 * DAY },
      { committedAt: T0, startedAt: T0, deliveredAt: null },
    ];
    const m = computeBoardMetrics(COLUMNS, cards, movements, { days: 30, now: NOW });
    const dwell = new Map(m.column_dwell.map((c) => [c.key, c]));
    expect(dwell.get("doing")).toMatchObject({ p50: 4, count: 2 });
    // b is STILL in review, so review has exactly one sample: a's single day.
    expect(dwell.get("review")).toMatchObject({ p50: 1, count: 1 });
    // Nothing has ever left Done, so it is absent rather than reported as a zero-day column.
    expect(dwell.has("done")).toBe(false);
  });

  it("is an empty list on a board with no movements", () => {
    expect(computeBoardMetrics(COLUMNS, [], [], { now: NOW }).column_dwell).toEqual([]);
  });
});

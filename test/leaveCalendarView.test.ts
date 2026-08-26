import { describe, it, expect } from "vitest";
import {
  addDays, barGeometry, coverOf, expandByDay, gridCells, groupRuns, halfLabel, hiddenPerDay, layoutStrip,
  thinDays, weekdayOrder, workingDaysIn, ymdUtc, type CalEntry,
} from "../web/src/lib/leaveCalendar";
import { buildIcs } from "../web/src/lib/ics";

// The calendar's geometry, tested where it is pure. Lanes, half-day insets and the exclusive iCalendar end
// date are the three places a leave silently shifts a day on screen or in someone's Outlook.

const entry = (over: Partial<CalEntry> & { key: string; start: string; end: string }): CalEntry => ({
  row: {} as CalEntry["row"],
  kind: "leave",
  empId: over.key,
  name: over.key,
  short: over.key,
  deptId: "",
  startSession: 1,
  endSession: 2,
  days: 1,
  pending: false,
  mine: false,
  color: "#000000",
  type: "Annual",
  ...over,
});

describe("layoutStrip", () => {
  it("packs overlapping leave into separate lanes and reuses a lane once it is free", () => {
    const segs = layoutStrip(
      [
        entry({ key: "a", start: "2026-06-01", end: "2026-06-03" }),
        entry({ key: "b", start: "2026-06-02", end: "2026-06-04" }), // overlaps a
        entry({ key: "c", start: "2026-06-05", end: "2026-06-06" }), // after a, so lane 0 again
      ],
      "2026-06-01",
      "2026-06-07",
    );
    expect(segs.map((s) => [s.en.key, s.i, s.span, s.lane])).toEqual([
      ["a", 0, 3, 0],
      ["b", 1, 3, 1],
      ["c", 4, 2, 0],
    ]);
  });

  it("clips a leave crossing the strip's edges and flags both cuts", () => {
    const [seg] = layoutStrip([entry({ key: "a", start: "2026-05-28", end: "2026-06-10" })], "2026-06-01", "2026-06-07");
    expect(seg).toMatchObject({ i: 0, span: 7, cutL: true, cutR: true });
  });

  it("drops nothing and hides only what a lane budget can't fit", () => {
    const segs = layoutStrip(
      ["a", "b", "c", "d"].map((k) => entry({ key: k, start: "2026-06-01", end: "2026-06-02" })),
      "2026-06-01",
      "2026-06-07",
    );
    expect(segs).toHaveLength(4);
    const hidden = hiddenPerDay(segs, "2026-06-01", 3);
    expect(hidden.get("2026-06-01")).toBe(1); // the 4th bar, on both of its days
    expect(hidden.get("2026-06-02")).toBe(1);
    expect(hidden.get("2026-06-03")).toBeUndefined();
  });
});

describe("barGeometry", () => {
  const seg = (over: Partial<CalEntry>, i = 0, span = 1, cutL = false, cutR = false) =>
    ({ en: entry({ key: "a", start: "2026-06-01", end: "2026-06-01", ...over }), i, span, cutL, cutR, lane: 0 });

  it("gives a full day the whole column", () => {
    const g = barGeometry(seg({}), 7);
    expect(g.left).toBe(0);
    expect(g.width).toBeCloseTo(100 / 7, 6);
  });

  it("insets a morning leave to the first half of its day", () => {
    const g = barGeometry(seg({ startSession: 1, endSession: 1 }), 7);
    expect(g.left).toBe(0);
    expect(g.width).toBeCloseTo(50 / 7, 6);
  });

  it("insets an afternoon leave to the second half", () => {
    const g = barGeometry(seg({ startSession: 2, endSession: 2 }), 7);
    expect(g.left).toBeCloseTo(50 / 7, 6);
    expect(g.width).toBeCloseTo(50 / 7, 6);
  });

  it("keeps a cut edge full width - the leave continues off the strip", () => {
    const g = barGeometry(seg({ startSession: 2 }, 0, 2, true, false), 7);
    expect(g.left).toBe(0);
    expect(g.width).toBeCloseTo(200 / 7, 6);
  });
});

describe("day helpers", () => {
  it("labels only single-day halves", () => {
    expect(halfLabel({ start: "2026-06-01", end: "2026-06-01", startSession: 1, endSession: 1 })).toBe("AM");
    expect(halfLabel({ start: "2026-06-01", end: "2026-06-01", startSession: 2, endSession: 2 })).toBe("PM");
    expect(halfLabel({ start: "2026-06-01", end: "2026-06-02", startSession: 2, endSession: 1 })).toBe("");
  });

  it("expands a leave across every day it covers", () => {
    const byDay = expandByDay([entry({ key: "a", start: "2026-06-01", end: "2026-06-03" })]);
    expect([...byDay.keys()]).toEqual(["2026-06-01", "2026-06-02", "2026-06-03"]);
  });

  it("counts working days in a range, past weekends and holidays", () => {
    // Fri 5 Jun 2026 .. Tue 9 Jun: Fri, Mon, Tue = 3, less a holiday on the Monday = 2.
    expect(workingDaysIn("2026-06-05", "2026-06-09", [1, 2, 3, 4, 5], new Set())).toBe(3);
    expect(workingDaysIn("2026-06-05", "2026-06-09", [1, 2, 3, 4, 5], new Set(["2026-06-08"]))).toBe(2);
  });

  it("tiers cover by the share of the team away", () => {
    expect(coverOf(0, 10)).toBe("none");
    expect(coverOf(2, 10)).toBe("some");
    expect(coverOf(3, 10)).toBe("heavy");
    expect(coverOf(5, 10)).toBe("critical");
    expect(coverOf(3, 0)).toBe("none"); // no denominator, no claim
  });
});

describe("grid layout follows the org's week start", () => {
  it("starts the grid on Sunday by default and on Monday when configured", () => {
    const june = new Date(Date.UTC(2026, 5, 1)); // 1 Jun 2026 is a Monday
    expect(ymdUtc(gridCells(june, 0)[0]!)).toBe("2026-05-31"); // the Sunday before
    expect(ymdUtc(gridCells(june, 1)[0]!)).toBe("2026-06-01"); // the Monday itself
    expect(weekdayOrder(1)).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });
});

describe("thin-cover alerts", () => {
  const days = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-06"];
  const away = new Map([["2026-06-01", 4], ["2026-06-02", 4], ["2026-06-03", 1], ["2026-06-04", 5], ["2026-06-06", 6]]);
  const awayOn = (d: string) => away.get(d) ?? 0;

  it("names only working days whose share crossed the line, worst first", () => {
    const thin = thinDays(days, awayOn, 10, [1, 2, 3, 4, 5], new Set());
    // 6 Jun is a Saturday (not a working day) and 3 Jun is only 10% away, so neither is thin.
    expect(thin.map((t) => t.ymd)).toEqual(["2026-06-04", "2026-06-01", "2026-06-02"]);
  });

  it("excludes a holiday - a day nobody works isn't thin, it's closed", () => {
    const thin = thinDays(days, awayOn, 10, [1, 2, 3, 4, 5], new Set(["2026-06-04"]));
    expect(thin.map((t) => t.ymd)).toEqual(["2026-06-01", "2026-06-02"]);
  });

  it("merges thin days into runs, bridging a weekend gap", () => {
    const runs = groupRuns([{ ymd: "2026-06-04", away: 5 }, { ymd: "2026-06-01", away: 4 }, { ymd: "2026-06-02", away: 4 }]);
    expect(runs).toEqual([{ from: "2026-06-01", to: "2026-06-04", peak: 5 }]);
  });

  it("keeps distant thin days apart", () => {
    const runs = groupRuns([{ ymd: "2026-06-01", away: 4 }, { ymd: "2026-06-20", away: 6 }]);
    expect(runs.map((r) => r.from)).toEqual(["2026-06-01", "2026-06-20"]);
  });
});

describe("buildIcs", () => {
  const ics = buildIcs(
    [{ uid: "a", start: "2026-06-01", end: "2026-06-03", summary: "Ravi K - Annual; sick", tentative: true }],
    "Leave · June 2026",
    new Date(Date.UTC(2026, 5, 1, 9, 30)),
  );

  it("ends the event the day AFTER the last day (DTEND is exclusive)", () => {
    expect(ics).toContain("DTSTART;VALUE=DATE:20260601");
    expect(ics).toContain("DTEND;VALUE=DATE:20260604");
  });

  it("marks a pending request tentative, so plan reads differently from fact", () => {
    expect(ics).toContain("STATUS:TENTATIVE");
  });

  it("escapes the delimiters a name or reason can carry", () => {
    expect(ics).toContain("SUMMARY:Ravi K - Annual\\; sick");
  });

  it("is a well-formed calendar with CRLF line endings", () => {
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
  });
});

describe("addDays", () => {
  it("crosses a month boundary", () => expect(addDays("2026-06-30", 1)).toBe("2026-07-01"));
  it("walks backwards", () => expect(addDays("2026-07-01", -1)).toBe("2026-06-30"));
});

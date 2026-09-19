import { describe, it, expect } from "vitest";
import {
  BLANK,
  dateWindowRange,
  filterChipLabel,
  matchesFilter,
  numberStats,
  parseDateFilter,
  parseNumberFilter,
} from "../web/src/lib/tableFilter";

// The grammar behind a typed column filter. What these pin is the pair of failures that would be invisible
// on screen: a filter that silently matches the WRONG rows (a money comparison done as text, a day range
// that is off by one at its edges), and a half-typed filter that empties the table while someone is still
// saying what they want.

const TODAY = "2026-09-19"; // a Saturday, mid-month, mid-year - no boundary doing the work for us

describe("number filters", () => {
  it("reads every comparison and range form", () => {
    expect(parseNumberFilter(">100")).toEqual({ op: ">", n: 100 });
    expect(parseNumberFilter(">= 100")).toEqual({ op: ">=", n: 100 });
    expect(parseNumberFilter("<100.5")).toEqual({ op: "<", n: 100.5 });
    expect(parseNumberFilter("100..200")).toEqual({ from: 100, to: 200 });
    expect(parseNumberFilter("100..")).toEqual({ from: 100, to: undefined });
    expect(parseNumberFilter("..200")).toEqual({ from: undefined, to: 200 });
    expect(parseNumberFilter("-5")).toEqual({ op: "=", n: -5 });
  });

  it("compares as a number, not as text", () => {
    // The whole point of typing the column: as a substring, "5000" matches 15000 and misses 5000.5.
    expect(matchesFilter("number", ">5000", 15000, TODAY)).toBe(true);
    expect(matchesFilter("number", "=5000", 15000, TODAY)).toBe(false);
    expect(matchesFilter("number", ">5000", 5000.5, TODAY)).toBe(true);
    expect(matchesFilter("number", ">=5000", 5000, TODAY)).toBe(true);
    expect(matchesFilter("number", ">5000", 5000, TODAY)).toBe(false);
    expect(matchesFilter("number", "100..200", 200, TODAY)).toBe(true);
    expect(matchesFilter("number", "100..200", 201, TODAY)).toBe(false);
  });

  it("treats a row with no figure as not matching, and finds it with the blank filter", () => {
    expect(matchesFilter("number", ">0", null, TODAY)).toBe(false);
    expect(matchesFilter("number", BLANK, null, TODAY)).toBe(true);
    expect(matchesFilter("number", BLANK, 0, TODAY)).toBe(false);
    expect(matchesFilter("number", `!${BLANK}`, null, TODAY)).toBe(false);
  });

  it("matches everything while the filter is half-typed", () => {
    // These strings exist for one keystroke each as someone types ">5000". Emptying the table on them takes
    // the rows away exactly while the reader is saying which ones they want.
    for (const partial of [">", ">=", "..", "-", "."]) {
      expect(matchesFilter("number", partial, 42, TODAY)).toBe(true);
    }
  });
});

describe("date filters", () => {
  it("resolves the named windows off the day given, not off the machine clock", () => {
    expect(dateWindowRange("today", TODAY)).toEqual({ from: TODAY, to: TODAY });
    expect(dateWindowRange("last7", TODAY)).toEqual({ from: "2026-09-13", to: TODAY });
    expect(dateWindowRange("next7", TODAY)).toEqual({ from: TODAY, to: "2026-09-25" });
    expect(dateWindowRange("thismonth", TODAY)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(dateWindowRange("lastmonth", TODAY)).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(dateWindowRange("nextmonth", TODAY)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(dateWindowRange("thisyear", TODAY)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(dateWindowRange("past", TODAY)).toEqual({ to: "2026-09-18" });
    expect(dateWindowRange("future", TODAY)).toEqual({ from: "2026-09-20" });
  });

  it("gets February right, in a leap year and out of one", () => {
    expect(dateWindowRange("thismonth", "2024-02-10")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(dateWindowRange("thismonth", "2026-02-10")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(dateWindowRange("lastmonth", "2026-03-05")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(dateWindowRange("nextmonth", "2026-01-31")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("takes an explicit range, an open end, a single day or a month", () => {
    expect(parseDateFilter("2026-01-01..2026-03-31", TODAY)).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    expect(parseDateFilter("..2026-03-31", TODAY)).toEqual({ from: undefined, to: "2026-03-31" });
    expect(parseDateFilter("2026-03-31..", TODAY)).toEqual({ from: "2026-03-31", to: undefined });
    expect(parseDateFilter("2026-03-31", TODAY)).toEqual({ from: "2026-03-31", to: "2026-03-31" });
    expect(parseDateFilter("2026-02", TODAY)).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("includes both ends of a range and reads a timestamp as its day", () => {
    expect(matchesFilter("date", "2026-09-01..2026-09-30", "2026-09-01", TODAY)).toBe(true);
    expect(matchesFilter("date", "2026-09-01..2026-09-30", "2026-09-30", TODAY)).toBe(true);
    expect(matchesFilter("date", "2026-09-01..2026-09-30", "2026-10-01", TODAY)).toBe(false);
    expect(matchesFilter("date", "today", "2026-09-19T23:14:00.000Z", TODAY)).toBe(true);
    expect(matchesFilter("date", "past", "2026-09-19", TODAY)).toBe(false);
    expect(matchesFilter("date", "past", "2026-09-18", TODAY)).toBe(true);
  });

  it("does not match a row with no date, and ignores a half-typed one", () => {
    expect(matchesFilter("date", "today", "", TODAY)).toBe(false);
    expect(matchesFilter("date", "today", "not a date", TODAY)).toBe(false);
    expect(matchesFilter("date", "2026-", "2026-09-19", TODAY)).toBe(true);
  });
});

describe("text and select filters", () => {
  it("keeps the old semantics: substring for text, exact for select", () => {
    expect(matchesFilter("text", "smi", "Smith", TODAY)).toBe(true);
    expect(matchesFilter("select", "Smi", "Smith", TODAY)).toBe(false);
    expect(matchesFilter("select", "Smith", "Smith", TODAY)).toBe(true);
  });

  it("excludes with a leading bang", () => {
    expect(matchesFilter("select", "!APPROVED", "APPROVED", TODAY)).toBe(false);
    expect(matchesFilter("select", "!APPROVED", "REJECTED", TODAY)).toBe(true);
    expect(matchesFilter("text", "!draft", "Draft policy", TODAY)).toBe(false);
  });

  it("finds rows with nothing in the column, and rows with something", () => {
    expect(matchesFilter("select", BLANK, "", TODAY)).toBe(true);
    expect(matchesFilter("select", BLANK, null, TODAY)).toBe(true);
    expect(matchesFilter("select", BLANK, "Laptops", TODAY)).toBe(false);
    expect(matchesFilter("select", `!${BLANK}`, "Laptops", TODAY)).toBe(true);
    expect(matchesFilter("select", `!${BLANK}`, "", TODAY)).toBe(false);
  });

  it("passes everything when the filter is empty", () => {
    expect(matchesFilter("text", "", "anything", TODAY)).toBe(true);
    expect(matchesFilter("number", "   ", 1, TODAY)).toBe(true);
  });
});

describe("chip labels", () => {
  const money = (n: number) => `₹${n}`;
  it("reads a filter back in the column's own terms", () => {
    expect(filterChipLabel("number", ">5000", money)).toBe("> ₹5000");
    expect(filterChipLabel("number", "100..200", money)).toBe("₹100 - ₹200");
    expect(filterChipLabel("number", "=0", money)).toBe("₹0");
    expect(filterChipLabel("date", "last30")).toBe("last 30 days");
    expect(filterChipLabel("select", "!APPROVED")).toBe("not APPROVED");
    expect(filterChipLabel("select", BLANK)).toBe("blank");
    expect(filterChipLabel("select", `!${BLANK}`)).toBe("has a value");
  });
});

describe("numberStats", () => {
  it("summarises a column, ignoring what is not a number", () => {
    expect(numberStats([3, 1, 2])).toEqual({ count: 3, min: 1, max: 3, sum: 6, avg: 2, median: 2 });
    expect(numberStats([4, 1, 2, 3])?.median).toBe(2.5);
    expect(numberStats([1, Number.NaN])?.count).toBe(1);
    expect(numberStats([])).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { parseHolidayLines, parseLooseDate, planYearCopy, toLine } from "../web/src/lib/holidayBulk";

// Bulk entry is where an HR admin seeds a whole year in one go, so a silently mis-parsed line is a wrong
// holiday for the whole company. These pin the forgiving-but-strict parsing and the year-copy warnings.

describe("parseLooseDate", () => {
  it("reads ISO and day-first forms", () => {
    expect(parseLooseDate("2026-01-26")).toBe("2026-01-26");
    expect(parseLooseDate("26/01/2026")).toBe("2026-01-26");
    expect(parseLooseDate("26.1.26")).toBe("2026-01-26");
    expect(parseLooseDate(" 2026-3-4 ")).toBe("2026-03-04");
  });

  it("rejects dates that don't exist rather than rolling them", () => {
    expect(parseLooseDate("31/02/2026")).toBeNull();
    expect(parseLooseDate("2026-13-01")).toBeNull();
    expect(parseLooseDate("Republic Day")).toBeNull();
  });
});

describe("parseHolidayLines", () => {
  it("takes a plain date + name list", () => {
    const rows = parseHolidayLines("2026-01-26 Republic Day\n2026-08-15 Independence Day");
    expect(rows.map((r) => r.draft)).toEqual([
      { date: "2026-01-26", name: "Republic Day", kind: "fixed", half_day: false, location: null },
      { date: "2026-08-15", name: "Independence Day", kind: "fixed", half_day: false, location: null },
    ]);
  });

  it("reads flags and a location in any order", () => {
    const [a, b] = parseHolidayLines("26/01/2026 | Republic Day | optional | half day | Mumbai\n2026-03-04, Holi, half, opt");
    expect(a?.draft).toEqual({ date: "2026-01-26", name: "Republic Day", kind: "optional", half_day: true, location: "Mumbai" });
    expect(b?.draft).toEqual({ date: "2026-03-04", name: "Holi", kind: "optional", half_day: true, location: null });
  });

  // The whitespace form is what an ordinary paste looks like, and it used to collapse everything after the
  // date into the name - so "Holi optional" created a FIXED holiday called "Holi optional": a company-wide
  // closure where an elective day was meant.
  it("reads trailing flags in the whitespace form", () => {
    const [a, b, c] = parseHolidayLines("2026-03-04  Holi  optional\n2026-03-05 Holi second half day\n2026-01-26 Republic Day");
    expect(a?.draft).toEqual({ date: "2026-03-04", name: "Holi", kind: "optional", half_day: false, location: null });
    expect(b?.draft).toEqual({ date: "2026-03-05", name: "Holi second", kind: "fixed", half_day: true, location: null });
    // A name is still a name: nothing here looks like a flag, so nothing is peeled off it.
    expect(c?.draft).toEqual({ date: "2026-01-26", name: "Republic Day", kind: "fixed", half_day: false, location: null });
  });

  it("round-trips a draft through toLine without losing a flag or a location", () => {
    const draft = { date: "2026-03-04", name: "Holi", kind: "optional" as const, half_day: true, location: "Mumbai" };
    expect(parseHolidayLines(toLine(draft))[0]?.draft).toEqual(draft);
  });

  it("skips blanks and comments, and reports unusable lines", () => {
    const rows = parseHolidayLines("\n# a comment\nnope\n2026-01-26\n2026-05-01 May Day");
    expect(rows.filter((r) => r.draft).length).toBe(1);
    expect(rows.filter((r) => r.error).map((r) => r.line)).toEqual([3, 4]);
  });

  it("flags a date repeated within the paste", () => {
    const rows = parseHolidayLines("2026-01-26 Republic Day\n2026-01-26 Also Republic Day");
    expect(rows[0]?.draft).toBeTruthy();
    expect(rows[1]?.error).toMatch(/more than once/);
  });
});

describe("planYearCopy", () => {
  const existing = [
    { date: "2026-01-26", name: "Republic Day", kind: "fixed" },
    { date: "2026-03-04", name: "Holi", kind: "optional", half_day: true, location: "Mumbai" },
    { date: "2027-01-26", name: "Republic Day", kind: "fixed" }, // already copied once
  ];

  it("shifts the year, keeping kind, half-day and location", () => {
    const plan = planYearCopy(existing, "2026", "2027");
    expect(plan.map((r) => [r.date, r.name, r.kind, r.half_day, r.location])).toEqual([
      // A holiday with no location carries "" - the SPA never puts a null on the wire (web/src/api.ts).
      ["2027-01-26", "Republic Day", "fixed", false, ""],
      ["2027-03-04", "Holi", "optional", true, "Mumbai"],
    ]);
  });

  it("flags what already exists in the target year", () => {
    const plan = planYearCopy(existing, "2026", "2027");
    expect(plan[0]?.duplicate).toBe(true);
    expect(plan[1]?.duplicate).toBe(false);
  });

  it("flags a copy that lands on a non-working day", () => {
    // 2027-01-26 is a Tuesday; 2027-03-04 a Thursday. Republic Day 2032-01-26 is a Monday, 2026-08-15 a Saturday.
    const plan = planYearCopy([{ date: "2026-08-15", name: "Independence Day", kind: "fixed" }], "2026", "2027");
    expect(plan[0]?.date).toBe("2027-08-15"); // a Sunday
    expect(plan[0]?.wasted).toBe(true);
  });

  it("clamps 29 Feb into a common year instead of silently landing on 1 March", () => {
    const plan = planYearCopy([{ date: "2028-02-29", name: "Leap Day", kind: "fixed" }], "2028", "2029");
    expect(plan[0]?.date).toBe("2029-02-28");
  });
});

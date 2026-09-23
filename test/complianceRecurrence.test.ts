import { describe, it, expect } from "vitest";
import { dueDatesInRange, periodLabelFor, type RecurrenceRule } from "../src/domain/complianceRecurrence";

const d = (s: string) => Date.parse(s + "T00:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

describe("dueDatesInRange", () => {
  it("monthly: one due date per month on the due day, within the window", () => {
    const rule: RecurrenceRule = { frequency: "monthly", dueDay: 15 };
    const out = dueDatesInRange(rule, d("2026-06-01"), d("2026-08-31")).map(iso);
    expect(out).toEqual(["2026-06-15", "2026-07-15", "2026-08-15"]);
  });

  it("clamps the due day to the month length (no skipped short months)", () => {
    const rule: RecurrenceRule = { frequency: "monthly", dueDay: 31 };
    const out = dueDatesInRange(rule, d("2026-01-01"), d("2026-03-31")).map(iso);
    expect(out).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  });

  it("quarterly: fires on the anchor month then every 3 months", () => {
    const rule: RecurrenceRule = { frequency: "quarterly", dueDay: 7, anchorMonth: 7 }; // Jul, Oct, Jan, Apr
    const out = dueDatesInRange(rule, d("2026-06-01"), d("2027-06-30")).map(iso);
    expect(out).toEqual(["2026-07-07", "2026-10-07", "2027-01-07", "2027-04-07"]);
  });

  it("annual: once a year in the anchor month", () => {
    const rule: RecurrenceRule = { frequency: "annual", dueDay: 30, anchorMonth: 9 };
    const out = dueDatesInRange(rule, d("2026-01-01"), d("2028-12-31")).map(iso);
    expect(out).toEqual(["2026-09-30", "2027-09-30", "2028-09-30"]);
  });

  it("respects the window bounds (inclusive) and returns empty for an inverted window", () => {
    const rule: RecurrenceRule = { frequency: "monthly", dueDay: 10 };
    expect(dueDatesInRange(rule, d("2026-06-10"), d("2026-06-10")).map(iso)).toEqual(["2026-06-10"]);
    expect(dueDatesInRange(rule, d("2026-08-01"), d("2026-06-01"))).toEqual([]);
  });

  it("monthly period label is the prior month; quarterly/annual are blank", () => {
    expect(periodLabelFor({ frequency: "monthly", dueDay: 15 }, d("2026-01-15"))).toBe("Dec 2025");
    expect(periodLabelFor({ frequency: "monthly", dueDay: 15 }, d("2026-07-15"))).toBe("Jun 2026");
    expect(periodLabelFor({ frequency: "quarterly", dueDay: 7, anchorMonth: 7 }, d("2026-07-07"))).toBeNull();
    expect(periodLabelFor({ frequency: "annual", dueDay: 30, anchorMonth: 9 }, d("2026-09-30"))).toBeNull();
  });
});

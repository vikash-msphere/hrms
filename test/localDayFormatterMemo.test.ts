/// <reference types="vite/client" />
// `localDay` and `localMinutes` keep one Intl formatter PER TIMEZONE instead of building one per call.
//
// Constructing an Intl.DateTimeFormat resolves locale and timezone data and costs around thirty times what
// formatting with an existing one does, and both helpers are called in loops - the loss-of-pay walk prices
// every employee across every day of a period, and `orgYear.covers` runs once per row.
//
// THE DEFECT A MEMO CAN INTRODUCE is returning one zone's formatter for another, which would make every
// org-local day silently read in whichever timezone happened to be asked for first. That is invisible in the
// default single-timezone configuration - the same blind spot `utcDay` vs `localDay` was broken through twice
// - so the keying is pinned here rather than trusted. Interleaving the zones matters: a memo keyed on
// anything but the timezone passes a test that asks for each zone once, in order.
import { describe, it, expect } from "vitest";
import { localDay, localMinutes } from "../src/domain/attendance";

// 1 Jan 2026, 02:00 UTC. Already the 1st in Kolkata (+5:30), still 31 Dec in New York (-5).
const NEW_YEAR = Date.UTC(2026, 0, 1, 2, 0);

describe("localDay keeps its formatters keyed by timezone", () => {
  it("answers each zone for itself, however they are interleaved", () => {
    // Asked repeatedly and out of order: a shared or first-wins formatter gives one of these the other's day.
    for (let i = 0; i < 3; i++) {
      expect(localDay(NEW_YEAR, "Asia/Kolkata")).toBe("2026-01-01");
      expect(localDay(NEW_YEAR, "America/New_York")).toBe("2025-12-31");
      expect(localDay(NEW_YEAR, "UTC")).toBe("2026-01-01");
      expect(localDay(NEW_YEAR, "Pacific/Kiritimati")).toBe("2026-01-01"); // +14
      expect(localDay(NEW_YEAR, "Etc/GMT+12")).toBe("2025-12-31");
    }
  });

  it("is stable across repeated calls for one zone", () => {
    // The memo is a cache, so the second answer must equal the first - the property a stale or mutated
    // formatter would break.
    const first = localDay(NEW_YEAR, "America/New_York");
    for (let i = 0; i < 50; i++) expect(localDay(NEW_YEAR, "America/New_York")).toBe(first);
  });

  it("still moves with the instant, not just the zone", () => {
    // A memo that accidentally cached the RESULT rather than the formatter would return the same day for
    // every instant in a zone.
    expect(localDay(NEW_YEAR, "UTC")).toBe("2026-01-01");
    expect(localDay(NEW_YEAR + 86_400_000, "UTC")).toBe("2026-01-02");
    expect(localDay(NEW_YEAR - 86_400_000, "UTC")).toBe("2025-12-31");
  });
});

describe("localMinutes keeps its formatters keyed by timezone", () => {
  it("answers each zone for itself, however they are interleaved", () => {
    for (let i = 0; i < 3; i++) {
      expect(localMinutes(NEW_YEAR, "UTC")).toBe(120); // 02:00
      expect(localMinutes(NEW_YEAR, "Asia/Kolkata")).toBe(7 * 60 + 30); // 07:30
      expect(localMinutes(NEW_YEAR, "America/New_York")).toBe(21 * 60); // 21:00 the previous day
    }
  });

  it("numbers local midnight as 0, not 1440", () => {
    // `hourCycle: "h23"` is load-bearing and lives inside the memoized formatter now, so it is asserted
    // through the memo rather than at the construction site. Under h24 this returns 1440, and a timed
    // count-as-work event starting at local midnight credits zero minutes for its first day.
    const utcMidnight = Date.UTC(2026, 0, 1, 0, 0);
    expect(localMinutes(utcMidnight, "UTC")).toBe(0);
  });
});

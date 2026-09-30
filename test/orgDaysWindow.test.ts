import { describe, it, expect } from "vitest";
import { orgDaysWindow } from "../web/src/lib/attendance";

// Attendance windows are ORG days. Bounded at UTC midnights instead, a punch at 00:30 on the 1st in
// Asia/Kolkata (19:00Z the day before) fell out of the month it belongs to - the history showed today with no
// punch on it right after midnight.
const bounds = (q: string) => Object.fromEntries(new URLSearchParams(q)) as { from: string; to: string };

describe("orgDaysWindow", () => {
  it("runs from org midnight to the instant before the next one", () => {
    expect(bounds(orgDaysWindow("2026-10-01", "2026-10-31", "Asia/Kolkata"))).toEqual({
      from: "2026-09-30T18:30:00.000Z",
      to: "2026-10-31T18:29:59.999Z",
    });
  });

  it("holds a punch made just after org midnight on the window's first day", () => {
    const { from, to } = bounds(orgDaysWindow("2026-10-01", "2026-10-01", "Asia/Kolkata"));
    const punch = "2026-09-30T19:00:00.000Z"; // 00:30 on 1 Oct in Kolkata
    expect(punch >= from && punch <= to).toBe(true);
  });

  it("is the UTC day in UTC", () => {
    expect(bounds(orgDaysWindow("2026-02-28", "2026-02-28", "UTC"))).toEqual({
      from: "2026-02-28T00:00:00.000Z",
      to: "2026-02-28T23:59:59.999Z",
    });
  });
});

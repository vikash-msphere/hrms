/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { nextOccurrence as serverNext } from "../src/services/events";
import { nextOccurrence as clientNext, upcomingOccurrences } from "../web/src/lib/eventRepeat";

// The event form previews the dates a repeat will produce; the cron creates them hours later. Two copies of one
// stepping rule, so they are pinned to each other here - a preview that disagrees with what the cron does is
// worse than no preview, because people plan around it.
//
// The interesting cases are the ones a naive "+30 days" gets wrong: month lengths, February, leap years, and
// the end-of-month overflow JS resolves by rolling forward (31 Jan + 1 month = 2 or 3 March).
const day = 86400000;
const at = (iso: string) => Date.parse(iso);

describe("the event form's repeat preview mirrors the cron", () => {
  const cases: [string, string, "weekly" | "monthly" | "yearly"][] = [
    ["2026-08-21T09:00:00.000Z", "2026-08-21T10:00:00.000Z", "weekly"],
    ["2026-08-31T00:00:00.000Z", "2026-08-31T00:00:00.000Z", "monthly"], // 31st -> a month with 30 days
    ["2026-01-31T00:00:00.000Z", "2026-01-31T00:00:00.000Z", "monthly"], // 31 Jan -> February
    ["2026-02-28T00:00:00.000Z", "2026-03-01T00:00:00.000Z", "yearly"],  // spans a month boundary
    ["2028-02-29T00:00:00.000Z", "2028-02-29T00:00:00.000Z", "yearly"],  // leap day -> a non-leap year
    ["2026-12-30T18:00:00.000Z", "2027-01-02T12:00:00.000Z", "weekly"],  // multi-day, across new year
  ];

  it("agrees on every date shape", () => {
    for (const [start, end, repeat] of cases) {
      expect(clientNext(at(start), at(end), repeat), `${start} ${repeat}`).toEqual(serverNext(at(start), at(end), repeat));
    }
  });

  it("keeps the event's own length", () => {
    const start = at("2026-08-21T09:00:00.000Z");
    const end = start + 3 * day + 7200000;
    const next = serverNext(start, end, "monthly");
    expect(next.end - next.start).toBe(end - start);
  });

  it("walks forward from each occurrence, not from the first", () => {
    const start = at("2026-01-31T00:00:00.000Z");
    const three = upcomingOccurrences(start, start, "monthly", 3);
    // Each step is taken from the previous RESULT, which is what the cron does when it catches up a stale
    // series - so 31 Jan lands in March (Feb overflow), then April, then May.
    expect(three.map((ms) => new Date(ms).toISOString().slice(0, 10))).toEqual(["2026-03-03", "2026-04-03", "2026-05-03"]);
  });
});

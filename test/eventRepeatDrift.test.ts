/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { nextOccurrence as serverNext } from "../src/services/events";
import { nextOccurrence as clientNext, upcomingOccurrences } from "../web/src/lib/eventRepeat";

// The event form previews the dates a repeat will produce; the cron creates them hours later. These were two
// copies of one stepping rule, and this file pinned them to each other - which held them equal to the SAME
// end-of-month bug, in both places, until it was found. They are now one shared implementation
// (src/domain/calendar.ts) that both sides import, so what is left to test is the rule itself: the cases a
// naive step gets wrong are month lengths, February, leap years, and the end-of-month overflow JS resolves by
// rolling forward (31 Jan + 1 month = 3 March).
const day = 86400000;
const at = (iso: string) => Date.parse(iso);
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

describe("the event form's repeat preview and the cron are the same rule", () => {
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

  it("clamps a month step into a short month instead of rolling past it", () => {
    // The whole point: 31 January has no counterpart in February, and JS answers "3 March" - which skips the
    // month the occurrence belonged to AND moves every later one, since each step is taken from the last
    // result. Clamped, the series lands in February and keeps the 28th from then on.
    expect(ymd(serverNext(at("2026-01-31T00:00:00.000Z"), at("2026-01-31T00:00:00.000Z"), "monthly").start)).toBe("2026-02-28");
    expect(ymd(serverNext(at("2026-08-31T00:00:00.000Z"), at("2026-08-31T00:00:00.000Z"), "monthly").start)).toBe("2026-09-30");
    // A leap day stepped a year lands on 28 February, not on 1 March.
    expect(ymd(serverNext(at("2028-02-29T00:00:00.000Z"), at("2028-02-29T00:00:00.000Z"), "yearly").start)).toBe("2029-02-28");
  });

  it("walks forward from each occurrence, not from the first", () => {
    const start = at("2026-01-31T00:00:00.000Z");
    const three = upcomingOccurrences(start, start, "monthly", 3);
    expect(three.map(ymd)).toEqual(["2026-02-28", "2026-03-28", "2026-04-28"]);
  });

  it("keeps the weekday on a weekly step", () => {
    const start = at("2026-08-21T09:00:00.000Z"); // a Friday
    const three = upcomingOccurrences(start, start, "weekly", 3);
    for (const ms of three) expect(new Date(ms).getUTCDay()).toBe(new Date(start).getUTCDay());
  });
});

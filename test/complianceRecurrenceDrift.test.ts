import { describe, it, expect } from "vitest";
import { dueDatesInRange } from "../src/domain/complianceRecurrence";
import { nextDueDates } from "../web/src/lib/complianceRecurrence";

// The rule editor previews the dates a recurring obligation will generate ("next: 15 Sep, 15 Oct, 15 Nov"), so
// its recurrence maths has to be the server's. The web bundle can't import from src/, so the core is mirrored
// in web/src/lib/complianceRecurrence.ts and pinned here - a server-side change to clamping or to the
// quarterly anchor that the preview doesn't follow fails this test rather than lying to whoever writes a rule.
// Wide enough that even an annual rule has three occurrences inside it, so both sides are compared on three.
const WINDOW_MS = 1300 * 86_400_000;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

describe("the rule preview mirrors the server's recurrence", () => {
  const from = new Date("2026-02-10T09:30:00Z"); // mid-month, so "next" skips the current month's past date
  const fromMs = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());

  const cases = [
    { frequency: "monthly" as const, dueDay: 15, anchorMonth: null },
    { frequency: "monthly" as const, dueDay: 31, anchorMonth: null }, // clamps in Feb / Apr / Jun…
    { frequency: "quarterly" as const, dueDay: 7, anchorMonth: 4 },
    { frequency: "quarterly" as const, dueDay: 30, anchorMonth: 1 },
    { frequency: "annual" as const, dueDay: 31, anchorMonth: 7 },
  ];

  for (const rule of cases) {
    it(`${rule.frequency} day ${rule.dueDay}${rule.anchorMonth ? ` from month ${rule.anchorMonth}` : ""}`, () => {
      const server = dueDatesInRange(rule, fromMs, fromMs + WINDOW_MS).slice(0, 3).map(ymd);
      expect(nextDueDates(rule, 3, from)).toEqual(server);
    });
  }

  it("gives back nothing rather than guessing when the day is out of range", () => {
    // The editor blocks a bad day before it previews; this pins that the mirror still clamps like the server.
    expect(nextDueDates({ frequency: "monthly", dueDay: 99 }, 1, from)).toEqual(
      dueDatesInRange({ frequency: "monthly", dueDay: 99 }, fromMs, fromMs + WINDOW_MS).slice(0, 1).map(ymd),
    );
  });
});

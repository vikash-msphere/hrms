/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { findFreeSlots, parseContact, type BusyWindow } from "../web/src/lib/ats";

// The two pure helpers behind the Recruiting dialogs: the free-slot search the interview form offers, and the
// paste-to-fill parser the candidate form uses. Both are guesses presented to a reader who can override them,
// so what matters is that they never claim something false: a slot must genuinely be free for the whole panel,
// and the parser must not invent a value it did not find.

const HOUR = 3_600_000;
// A Monday, so the weekend rule is exercised by walking forward rather than by starting on one.
const MONDAY_9AM = new Date(2026, 7, 24, 9, 0, 0, 0).getTime(); // 24 Aug 2026 is a Monday (local time)
const overlaps = (a: { start: number; end: number }, b: BusyWindow) => a.start < b.end && a.end > b.start;

describe("findFreeSlots", () => {
  it("offers working-hour slots of the asked-for length, on the grid", () => {
    const slots = findFreeSlots({ panel: ["a"], busy: [], durationMin: 60, fromMs: MONDAY_9AM, limit: 4 });
    expect(slots).toHaveLength(4);
    for (const s of slots) {
      expect(s.end - s.start).toBe(HOUR);
      const d = new Date(s.start);
      expect(d.getHours() * 60 + d.getMinutes()).toBeGreaterThanOrEqual(9 * 60);
      expect(new Date(s.end).getHours() * 60 + new Date(s.end).getMinutes()).toBeLessThanOrEqual(18 * 60);
      expect(s.start).toBeGreaterThanOrEqual(MONDAY_9AM);
    }
  });

  it("never returns a slot that overlaps anyone on the panel", () => {
    // Two panelists, each busy for part of the morning; the search must route around both.
    const busy: BusyWindow[] = [
      { who: "a", start: MONDAY_9AM, end: MONDAY_9AM + 3 * HOUR },
      { who: "b", start: MONDAY_9AM + 3 * HOUR, end: MONDAY_9AM + 5 * HOUR },
    ];
    const slots = findFreeSlots({ panel: ["a", "b"], busy, durationMin: 60, fromMs: MONDAY_9AM, limit: 6 });
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) for (const b of busy) expect(overlaps(s, b)).toBe(false);
  });

  it("ignores commitments belonging to people who are not on the panel", () => {
    const busy: BusyWindow[] = [{ who: "someone-else", start: MONDAY_9AM, end: MONDAY_9AM + 8 * HOUR }];
    const first = findFreeSlots({ panel: ["a"], busy, durationMin: 60, fromMs: MONDAY_9AM, limit: 1 })[0];
    expect(first?.start).toBe(MONDAY_9AM);
  });

  it("skips weekends", () => {
    // A panel busy for the whole of the next five days pushes the search past the weekend, never onto it.
    const busy: BusyWindow[] = [{ who: "a", start: MONDAY_9AM, end: MONDAY_9AM + 5 * 24 * HOUR }];
    const slots = findFreeSlots({ panel: ["a"], busy, durationMin: 60, fromMs: MONDAY_9AM, limit: 3 });
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) expect([0, 6]).not.toContain(new Date(s.start).getDay());
  });

  it("returns nothing rather than something wrong when the duration cannot fit a working day", () => {
    expect(findFreeSlots({ panel: ["a"], busy: [], durationMin: 24 * 60, fromMs: MONDAY_9AM })).toEqual([]);
    expect(findFreeSlots({ panel: ["a"], busy: [], durationMin: 0, fromMs: MONDAY_9AM })).toEqual([]);
  });
});

describe("parseContact", () => {
  it("reads a name, an email and a phone out of a signature block", () => {
    const parsed = parseContact("Asha Rao\nSenior Engineer, Acme\nasha.rao@example.com\n+91 98765 43210");
    expect(parsed.name).toBe("Asha Rao");
    expect(parsed.email).toBe("asha.rao@example.com");
    expect(parsed.phone?.replace(/\D/g, "")).toBe("919876543210");
  });

  it("falls back to the email's local part when no name line is there to read", () => {
    expect(parseContact("please see attached - asha.rao@example.com").name).toBe("Asha Rao");
  });

  it("invents nothing from text that holds no contact details", () => {
    const parsed = parseContact("Following up on our conversation from last week.");
    expect(parsed.email).toBeUndefined();
    expect(parsed.phone).toBeUndefined();
  });

  it("does not mistake a greeting or a sign-off for a name", () => {
    const parsed = parseContact("Hi team\nThanks\nRavi Kumar\nravi@example.com");
    expect(parsed.name).toBe("Ravi Kumar");
  });
});

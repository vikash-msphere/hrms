import { describe, it, expect } from "vitest";
import { breakAround, bestBridge, isWeekendDay, longBreakCount } from "../web/src/lib/holidayBreaks";

// The holiday page promises two things a wrong answer would embarrass it over: "4-day break" and "take this
// Friday off and it becomes one". Both fall out of the working week, so a Saturday-working org must get
// different numbers - that is what these pin.

const MON_FRI = [1, 2, 3, 4, 5];
const MON_SAT = [1, 2, 3, 4, 5, 6];
const offFn = (holidays: string[], workDays = MON_FRI) => (d: string) =>
  isWeekendDay(d, workDays) || holidays.includes(d);

describe("breakAround", () => {
  it("pulls the weekend in around a Friday holiday", () => {
    const isOff = offFn(["2026-01-16"]);
    expect(breakAround("2026-01-16", isOff)).toEqual({ from: "2026-01-16", to: "2026-01-18", days: 3 });
  });

  it("leaves a midweek holiday standing alone", () => {
    const isOff = offFn(["2026-01-14"]);
    expect(breakAround("2026-01-14", isOff)).toEqual({ from: "2026-01-14", to: "2026-01-14", days: 1 });
  });

  it("joins two holidays straddling a weekend into one stretch", () => {
    const isOff = offFn(["2026-01-16", "2026-01-19"]);
    expect(breakAround("2026-01-19", isOff)).toEqual({ from: "2026-01-16", to: "2026-01-19", days: 4 });
  });

  it("counts Saturday as a working day when the org works it", () => {
    const isOff = offFn(["2026-01-16"], MON_SAT);
    expect(breakAround("2026-01-16", isOff)).toEqual({ from: "2026-01-16", to: "2026-01-16", days: 1 });
  });
});

describe("bestBridge", () => {
  it("suggests the Friday after a Thursday holiday", () => {
    const isOff = offFn(["2026-01-15"]);
    const brk = breakAround("2026-01-15", isOff);
    expect(bestBridge(brk, isOff)).toEqual({ take: ["2026-01-16"], from: "2026-01-15", to: "2026-01-18", days: 4 });
  });

  it("suggests the Monday before a Tuesday holiday, reaching back over the weekend", () => {
    const isOff = offFn(["2026-01-13"]);
    const brk = breakAround("2026-01-13", isOff);
    expect(bestBridge(brk, isOff)).toEqual({ take: ["2026-01-12"], from: "2026-01-10", to: "2026-01-13", days: 4 });
  });

  it("prefers one day of leave over two, and the earlier side on a tie", () => {
    const isOff = offFn(["2026-01-16"]); // Fri holiday: Thu before or Mon after both give 4 days
    const brk = breakAround("2026-01-16", isOff);
    expect(bestBridge(brk, isOff)).toEqual({ take: ["2026-01-15"], from: "2026-01-15", to: "2026-01-18", days: 4 });
  });

  it("spends two days when that is what a Wednesday holiday costs", () => {
    const isOff = offFn(["2026-01-14"]);
    const brk = breakAround("2026-01-14", isOff);
    expect(bestBridge(brk, isOff)).toEqual({
      take: ["2026-01-12", "2026-01-13"],
      from: "2026-01-10",
      to: "2026-01-14",
      days: 5,
    });
  });

  it("suggests nothing when a day of leave still wouldn't buy a break", () => {
    // Saturday-working org: Friday holiday + Saturday leave is only Fri-Sun, under the 4-day bar.
    const isOff = offFn(["2026-01-16"], MON_SAT);
    const brk = breakAround("2026-01-16", isOff);
    expect(bestBridge(brk, isOff)).toBeNull();
  });
});

describe("longBreakCount", () => {
  it("counts a stretch once however many holidays sit in it", () => {
    const isOff = offFn(["2026-01-16", "2026-01-19"]);
    expect(longBreakCount(["2026-01-16", "2026-01-19"], isOff)).toBe(1);
  });

  it("ignores a holiday that buys no long weekend at all", () => {
    const isOff = offFn(["2026-01-14"]);
    expect(longBreakCount(["2026-01-14"], isOff)).toBe(0);
  });
});

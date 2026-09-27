import { describe, it, expect } from "vitest";
import {
  cycleWeekIndex, employeeScheduleOf, orgScheduleOf, shiftDay, shiftPaidMinutes, shiftSpanMinutes,
  type DayOverride, type PatternDef, type PatternSpan, type ShiftDef,
} from "../src/domain/workSchedule";
import { lopDayUnits, workingDaysInRange } from "../src/domain/attendance";

// The three layers a day resolves through, and what each one decides. Every walk in domain/attendance.ts and
// domain/punctuality.ts reads its answers, so a mistake here is a mistake in loss of pay, in what a leave
// request costs and in what the attendance grid draws - all at once.

const ORG = orgScheduleOf({ work_days: [1, 2, 3, 4, 5], full_day_minutes: 480, half_day_minutes: 240 });

const shift = (over: Partial<ShiftDef> = {}): ShiftDef => ({
  id: "s1", name: "Day", startTime: "09:00", endTime: "18:00", breakMinutes: 0, ...over,
});
const catalog = (...list: ShiftDef[]) => new Map(list.map((s) => [s.id, s]));

// 2026-06-01 is a Monday, 06-06 a Saturday, 06-07 a Sunday.
const MON = "2026-06-01";
const TUE = "2026-06-02";
const WED = "2026-06-03";
const SAT = "2026-06-06";

describe("the org's own week, as a per-day answer", () => {
  it("owes a scheduled weekday and nothing on a weekend", () => {
    expect(ORG(MON).off).toBe(false);
    expect(ORG(SAT).off).toBe(true);
  });

  it("keeps the org's STORED day lengths rather than deriving them from the window", () => {
    // 09:00-18:00 is 540 minutes, and every org's stored full day is 480. Deriving here would move a figure
    // nobody asked to move, so the derivation is a SHIFT's rule and not the org's.
    expect(ORG(MON)).toMatchObject({ startMin: 540, endMin: 1080, fullDayMinutes: 480, halfDayMinutes: 240 });
  });

  it("reads a grace exception as that day's allowance", () => {
    const sched = orgScheduleOf({ work_days: [1, 2, 3, 4, 5], grace_minutes: 15, grace_exceptions: [{ date: TUE, extra_grace_minutes: 45 }] });
    expect(sched(MON).graceMinutes).toBe(15);
    expect(sched(TUE).graceMinutes).toBe(60);
  });
});

describe("a shift's own day lengths", () => {
  it("measures a night shift's span across midnight", () => {
    expect(shiftSpanMinutes(9 * 60, 18 * 60)).toBe(540);
    expect(shiftSpanMinutes(22 * 60, 6 * 60)).toBe(480); // not minus 960
  });

  it("takes the break out of the paid length", () => {
    expect(shiftPaidMinutes({ startTime: "09:00", endTime: "18:00", breakMinutes: 60 })).toBe(480);
  });

  // THE RULE A FOUR-HOUR SHIFT NEEDS. Against the org's 480-minute bar, every day of one reads as under hours
  // and is docked half a day - work that was done in full, charged as half missed.
  it("makes a full day the shift itself, and half a day half of that", () => {
    const d = shiftDay(shift({ startTime: "09:00", endTime: "13:00" }), ORG(MON));
    expect(d).toMatchObject({ fullDayMinutes: 240, halfDayMinutes: 120, off: false });
  });

  it("lets the shift state either figure itself", () => {
    const both = shiftDay(shift({ startTime: "09:00", endTime: "18:00", fullDayMinutes: 480, halfDayMinutes: 180 }), ORG(MON));
    expect(both).toMatchObject({ fullDayMinutes: 480, halfDayMinutes: 180 });
    // A stated full day still halves into a derived half day.
    const fullOnly = shiftDay(shift({ startTime: "09:00", endTime: "18:00", fullDayMinutes: 420 }), ORG(MON));
    expect(fullOnly.halfDayMinutes).toBe(210);
  });

  it("falls back to the org for grace and flexible hours, and takes the shift's where it has them", () => {
    const orgGrace = orgScheduleOf({ work_days: [1, 2, 3, 4, 5], grace_minutes: 15, flexible_hours: true });
    expect(shiftDay(shift(), orgGrace(MON))).toMatchObject({ graceMinutes: 15, flexible: true });
    expect(shiftDay(shift({ graceMinutes: 0, flexibleHours: false }), orgGrace(MON))).toMatchObject({ graceMinutes: 0, flexible: false });
  });
});

describe("where a cycle is in its rotation", () => {
  it("counts whole weeks from the anchor's own week, so a cycle turns over on a week boundary", () => {
    expect(cycleWeekIndex("2026-06-01", "2026-06-01", 2)).toBe(0);
    expect(cycleWeekIndex("2026-06-05", "2026-06-01", 2)).toBe(0); // same week as the anchor
    expect(cycleWeekIndex("2026-06-08", "2026-06-01", 2)).toBe(1);
    expect(cycleWeekIndex("2026-06-15", "2026-06-01", 2)).toBe(0); // back round
  });

  it("resolves a day BEFORE the anchor rather than indexing off the front of the array", () => {
    // An assignment can be anchored mid-span (a rotation that was already running when it was recorded), and
    // `-1 % 3` is -1 in JavaScript.
    expect(cycleWeekIndex("2026-05-25", "2026-06-01", 3)).toBe(2);
    expect(cycleWeekIndex("2026-05-18", "2026-06-01", 3)).toBe(1);
  });

  it("is always 0 for a one-week pattern, whatever the anchor", () => {
    for (const d of [MON, TUE, SAT, "2026-07-14"]) expect(cycleWeekIndex(d, "2026-06-01", 1)).toBe(0);
  });
});

describe("the three layers, most specific first", () => {
  const day = shift({ id: "day", name: "Day", startTime: "09:00", endTime: "18:00" });
  const morning = shift({ id: "morning", name: "Morning", startTime: "09:00", endTime: "13:00" });
  const night = shift({ id: "night", name: "Night", startTime: "22:00", endTime: "06:00" });
  const shifts = catalog(day, morning, night);

  // Mon/Wed/Fri mornings: the weekday slots hold a shift, the rest are rest days.
  const mwf: PatternDef = {
    id: "p1", name: "Mon/Wed/Fri mornings", cycleWeeks: 1,
    days: [null, "morning", null, "morning", null, "morning", null], // index = weekday, 0=Sun
  };
  const patterns = new Map([[mwf.id, mwf]]);
  const span: PatternSpan = { patternId: "p1", startYmd: "2026-01-01", endYmd: null, anchorYmd: "2026-01-01" };
  const of = (overrides: Record<string, DayOverride> = {}) =>
    employeeScheduleOf({ org: ORG, shifts, patterns, spans: [span], overrides: new Map(Object.entries(overrides)) });

  it("puts a pattern's rest day beyond the reach of the org's working week", () => {
    const sched = of();
    expect(sched(MON).off).toBe(false);
    expect(sched(TUE).off).toBe(true); // a working day for the org, a rest day for this person
    expect(sched(WED).off).toBe(false);
  });

  it("gives a pattern day the shift's own lengths", () => {
    expect(of()(MON)).toMatchObject({ shiftName: "Morning", startMin: 540, endMin: 780, fullDayMinutes: 240, halfDayMinutes: 120 });
  });

  it("lets a roster entry beat the pattern in either direction", () => {
    // Cover on a rest day...
    expect(of({ [TUE]: { shiftId: "day", off: false } })(TUE)).toMatchObject({ off: false, shiftName: "Day" });
    // ...and a day off on a working one.
    expect(of({ [MON]: { shiftId: null, off: true } })(MON).off).toBe(true);
    // ...and a different shift on a working one.
    expect(of({ [WED]: { shiftId: "night", off: false } })(WED)).toMatchObject({ shiftName: "Night", startMin: 1320, endMin: 360 });
  });

  it("falls back to the org where nothing else covers the day", () => {
    const bare = employeeScheduleOf({ org: ORG, shifts, patterns, spans: [], overrides: new Map() });
    expect(bare(TUE)).toMatchObject({ off: false, fullDayMinutes: 480 });
  });

  it("stops applying a pattern the day after its assignment ends", () => {
    const ended: PatternSpan = { ...span, endYmd: TUE };
    const sched = employeeScheduleOf({ org: ORG, shifts, patterns, spans: [ended], overrides: new Map() });
    expect(sched(TUE).off).toBe(true); // still on the pattern: a Tuesday rest day
    expect(sched(WED)).toMatchObject({ off: false, fullDayMinutes: 480 }); // off it: the org's own Wednesday
  });

  // A pattern entry naming a shift the catalogue no longer holds is a rest day, NOT the org's week: the
  // pattern said this day is not an ordinary org day, and falling back would put the person on a five-day week
  // and owe them days their rotation never had.
  it("treats a pattern day naming a missing shift as a rest day", () => {
    const stale: PatternDef = { ...mwf, days: [null, "gone", null, null, null, null, null] };
    const sched = employeeScheduleOf({ org: ORG, shifts, patterns: new Map([[stale.id, stale]]), spans: [span], overrides: new Map() });
    expect(sched(MON).off).toBe(true);
  });
});

describe("what the walks make of it", () => {
  const morning = shift({ id: "morning", startTime: "09:00", endTime: "13:00" });
  const mwf: PatternDef = { id: "p1", name: "MWF", cycleWeeks: 1, days: [null, "morning", null, "morning", null, "morning", null] };
  const sched = employeeScheduleOf({
    org: ORG,
    shifts: catalog(morning),
    patterns: new Map([[mwf.id, mwf]]),
    spans: [{ patternId: "p1", startYmd: "2026-01-01", endYmd: null, anchorYmd: "2026-01-01" }],
    overrides: new Map(),
  });

  it("counts a part-timer's own working days, not the org's", () => {
    // Mon 1 to Sun 7 June: the org works five of them, this person three.
    expect(workingDaysInRange(MON, "2026-06-07", ORG, new Set())).toBe(5);
    expect(workingDaysInRange(MON, "2026-06-07", sched, new Set())).toBe(3);
  });

  it("owes nothing on the rest days between", () => {
    // Every scheduled day worked in full: no loss of pay, and the Tuesdays and Thursdays are never asked about.
    const worked = new Map([[MON, 240], [WED, 240], ["2026-06-05", 240]]);
    expect(lopDayUnits({ startYmd: MON, endYmd: "2026-06-07", schedOf: sched, holidays: new Set(), leaveRanges: [], workedByDay: worked })).toBe(0);
    // The same attendance against the org's week is two absences (Tue and Thu) and three short days.
    expect(lopDayUnits({ startYmd: MON, endYmd: "2026-06-07", schedOf: ORG, holidays: new Set(), leaveRanges: [], workedByDay: worked })).toBe(3.5);
  });

  it("scores a four-hour day on the four-hour shift's own ladder", () => {
    const short = new Map([[MON, 240], [WED, 120], ["2026-06-05", 60]]);
    // 240 = a full day, 120 = exactly the half-day minimum, 60 = too short to earn anything.
    expect(lopDayUnits({ startYmd: MON, endYmd: "2026-06-07", schedOf: sched, holidays: new Set(), leaveRanges: [], workedByDay: short })).toBe(1.5);
  });
});

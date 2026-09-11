import { describe, it, expect } from "vitest";
import { weekdayOf, workingDaysInRange, lopDayUnits, lopAmount, employmentFraction, eventCreditByDay, localDay, utcDay, type WorkEvent } from "../src/domain/attendance";

const WORK = [1, 2, 3, 4, 5]; // Mon-Fri
const FULL = 480; // minutes for a full day
const HALF = 240; // minimum minutes to earn a half day

describe("which day a value names: an instant's is the org's, a date-only column's is UTC", () => {
  // The schema anchors every date-only column at UTC midnight (`period_start`, `holidays.date`,
  // `leave_requests.start_date`, `employees.start_date`...), so the day such a column NAMES is the UTC one.
  // Reading it with `localDay` asks a different question, and west of UTC gets a different answer - which is
  // how payroll and the FnF settlement came to enumerate a window one day off the period, charging the day
  // before it began, never checking the day it ended, and excusing the day before each holiday while docking
  // the holiday itself. The two helpers exist so the distinction is visible at the call site; these are the
  // cases that make the difference concrete.
  const apr1 = Date.parse("2026-04-01T00:00:00Z"); // a date-only column holding "1 April 2026"

  it("reads a date-only column as the day it names, in every timezone", () => {
    expect(utcDay(apr1)).toBe("2026-04-01");
    // utcDay takes no zone precisely because the answer cannot depend on one.
    for (const tz of ["Asia/Kolkata", "America/New_York", "Pacific/Kiritimati", "UTC"]) {
      expect(localDay(apr1, "UTC")).toBe(utcDay(apr1));
      // And this is the reading that was wrong: west of UTC, midnight-Z is the previous evening locally.
      if (tz === "America/New_York") expect(localDay(apr1, tz)).toBe("2026-03-31");
    }
  });

  it("still reads an INSTANT in the org timezone - that half was always right", () => {
    const punch = Date.parse("2026-04-01T20:30:00Z"); // 02:00 on 2 April in IST
    expect(localDay(punch, "Asia/Kolkata")).toBe("2026-04-02");
    expect(localDay(punch, "America/New_York")).toBe("2026-04-01");
  });

  it("the shift is not cosmetic: it moves the weekday composition a working-days proration counts", () => {
    // June 2026 starts on a Monday, so reading it a day early trades a working day (Tue 30 June) for a
    // non-working one (Sun 31 May): a different divisor, and therefore a different proration factor on every
    // partial-period employee's pay. (It does not always change the COUNT - April 2026 trades one weekday for
    // another and comes out level - which is exactly why the bug survived: the window is always wrong, and the
    // arithmetic only sometimes shows it.)
    expect(weekdayOf("2026-06-01")).toBe(1);
    const correct = workingDaysInRange("2026-06-01", "2026-06-30", WORK, new Set());
    const shifted = workingDaysInRange("2026-05-31", "2026-06-29", WORK, new Set());
    expect(shifted).toBe(correct - 1);
  });

  it("the shift is not cosmetic: a holiday keyed a day early excuses the wrong day and docks the holiday", () => {
    const holiday = Date.parse("2026-04-03T00:00:00Z"); // Friday
    const base = {
      startYmd: "2026-04-01", endYmd: "2026-04-03", workDays: WORK, leaveRanges: [],
      workedByDay: new Map<string, number>(), fullDayMinutes: FULL, halfDayMinutes: HALF,
    };
    // Read correctly: Wed + Thu are absences, the Friday holiday is excused.
    expect(lopDayUnits({ ...base, holidays: new Set([utcDay(holiday)]) })).toBe(2);
    // Read a day early (west of UTC): Thursday is excused instead and the holiday itself is charged. Same
    // total here, a different person docked - and the totals diverge the moment the shifted day is a weekend.
    expect(lopDayUnits({ ...base, holidays: new Set([localDay(holiday, "America/New_York")]) })).toBe(2);
    expect(localDay(holiday, "America/New_York")).toBe("2026-04-02");
  });
});

describe("employment fraction (partial-month proration)", () => {
  const P = { periodStartYmd: "2026-01-01", periodEndYmd: "2026-01-31", workDays: WORK, holidays: new Set<string>() };
  it("is 1 for a full-period employee (no start/end)", () => {
    expect(employmentFraction({ ...P, basis: "calendar_days" })).toBe(1);
    expect(employmentFraction({ ...P, basis: "working_days" })).toBe(1);
  });
  it("calendar basis prorates by days employed in the period", () => {
    // Joined Jan 17 -> Jan 17..31 = 15 of 31 calendar days.
    expect(employmentFraction({ ...P, empStartYmd: "2026-01-17", basis: "calendar_days" })).toBeCloseTo(15 / 31, 6);
    // Left Jan 15 -> Jan 1..15 = 15 of 31.
    expect(employmentFraction({ ...P, empEndYmd: "2026-01-15", basis: "calendar_days" })).toBeCloseTo(15 / 31, 6);
  });
  it("working-days basis prorates by scheduled working days", () => {
    // Joined Jan 19 (Mon) -> working days Jan 19..31 over working days in the whole month.
    const whole = workingDaysInRange("2026-01-01", "2026-01-31", WORK, new Set());
    const worked = workingDaysInRange("2026-01-19", "2026-01-31", WORK, new Set());
    expect(employmentFraction({ ...P, empStartYmd: "2026-01-19", basis: "working_days" })).toBeCloseTo(worked / whole, 6);
  });
  it("is 0 when the employee is not employed within the period at all", () => {
    expect(employmentFraction({ ...P, empStartYmd: "2026-02-10", basis: "calendar_days" })).toBe(0);
  });
});

describe("attendance LOP (loss of pay) derivation", () => {
  it("working days in a range exclude weekends and holidays", () => {
    // 2026-06-01 (Mon) .. 2026-06-07 (Sun): Mon-Fri = 5 working days; minus one holiday = 4.
    expect(workingDaysInRange("2026-06-01", "2026-06-07", WORK, new Set())).toBe(5);
    expect(workingDaysInRange("2026-06-01", "2026-06-07", WORK, new Set(["2026-06-03"]))).toBe(4);
  });

  it("weekdayOf maps calendar dates correctly", () => {
    expect(weekdayOf("2026-06-01")).toBe(1); // Monday
    expect(weekdayOf("2026-06-07")).toBe(0); // Sunday
  });

  it("counts unexcused day-units: absent=1, half day=0.5, full day=0; skips weekend/holiday/leave", () => {
    const units = lopDayUnits({
      startYmd: "2026-06-01", // Mon
      endYmd: "2026-06-07", // Sun
      workDays: WORK,
      holidays: new Set(["2026-06-02"]), // Tue holiday
      leaveRanges: [{ start: "2026-06-03", end: "2026-06-03" }], // Wed on leave
      workedByDay: new Map([
        ["2026-06-04", 480], // Thu full day -> 0
        ["2026-06-05", 300], // Fri >= half min, < full -> half day 0.5
      ]),
      fullDayMinutes: FULL,
      halfDayMinutes: HALF,
    });
    // Mon = absent(1) + Tue holiday(skip) + Wed leave(skip) + Thu full(0) + Fri half(0.5) = 1.5
    expect(units).toBe(1.5);
  });

  it("a present day with worked >= full day adds nothing; a no-punch working day is a full absence", () => {
    const base = { startYmd: "2026-06-01", endYmd: "2026-06-01", workDays: WORK, holidays: new Set<string>(), leaveRanges: [], fullDayMinutes: FULL, halfDayMinutes: HALF };
    expect(lopDayUnits({ ...base, workedByDay: new Map([["2026-06-01", 500]]) })).toBe(0); // full
    expect(lopDayUnits({ ...base, workedByDay: new Map([["2026-06-01", 300]]) })).toBe(0.5); // half (>= half min)
    expect(lopDayUnits({ ...base, workedByDay: new Map() })).toBe(1); // absent
  });

  it("a punch below the half-day minimum doesn't earn a half day -> full absence", () => {
    const base = { startYmd: "2026-06-01", endYmd: "2026-06-01", workDays: WORK, holidays: new Set<string>(), leaveRanges: [], fullDayMinutes: FULL, halfDayMinutes: HALF };
    expect(lopDayUnits({ ...base, workedByDay: new Map([["2026-06-01", 239]]) })).toBe(1); // just under half min -> absent
    expect(lopDayUnits({ ...base, workedByDay: new Map([["2026-06-01", 240]]) })).toBe(0.5); // exactly half min -> half day
  });

  it("amount = per-day base x absent days, by basis, clamped + rounded", () => {
    // working_days basis: 30000 / 20 working days * 2 absent = 3000.
    expect(lopAmount(30000, 2, "working_days", 20)).toBe(3000);
    // days_30 basis: 30000 / 30 * 3 = 3000.
    expect(lopAmount(30000, 3, "days_30", 20)).toBe(3000);
    // no absence / no pay => 0.
    expect(lopAmount(30000, 0, "working_days", 20)).toBe(0);
    expect(lopAmount(0, 5, "working_days", 20)).toBe(0);
    // rounds to paise.
    expect(lopAmount(10000, 1, "working_days", 21)).toBe(476.19);
  });
});

describe("attendance.eventCreditByDay", () => {
  const ms = (iso: string) => Date.parse(iso);
  const base = {
    tz: "Asia/Kolkata",
    workDays: [1, 2, 3, 4, 5],
    fullDayMinutes: 480,
    todayYmd: "2026-06-10",
    nowMs: ms("2026-06-10T00:00:00.000Z"),
    punchedDays: new Set<string>(),
    onLeave: () => false,
  };
  // All-day events are date-anchored at UTC midnight, exactly as the events service stores them.
  const allDay = (ymd: string, requiresClockIn = false): WorkEvent => ({
    startMs: ms(`${ymd}T00:00:00.000Z`),
    endMs: ms(`${ymd}T00:00:00.000Z`),
    allDay: true,
    requiresClockIn,
  });

  it("credits a full day for an all-day off-site, with no punch needed", () => {
    const credit = eventCreditByDay({ ...base, events: [allDay("2026-06-01")] });
    expect(credit.get("2026-06-01")).toBe(480);
  });

  it("credits nothing when the event requires a clock-in the employee never made", () => {
    const credit = eventCreditByDay({ ...base, events: [allDay("2026-06-01", true)] });
    expect(credit.size).toBe(0);
  });

  it("credits a requires-clock-in event only on the days actually punched", () => {
    const credit = eventCreditByDay({
      ...base,
      events: [allDay("2026-06-01", true), allDay("2026-06-02", true)],
      punchedDays: new Set(["2026-06-01"]),
    });
    expect(credit.get("2026-06-01")).toBe(480);
    expect(credit.has("2026-06-02")).toBe(false);
  });

  it("credits a timed event its own duration only, not a whole day", () => {
    // 10:00-13:00 IST on the 2nd = 3h. IST is UTC+5:30, so 04:30Z-07:30Z.
    const credit = eventCreditByDay({
      ...base,
      events: [{ startMs: ms("2026-06-02T04:30:00.000Z"), endMs: ms("2026-06-02T07:30:00.000Z"), allDay: false, requiresClockIn: false }],
    });
    expect(credit.get("2026-06-02")).toBe(180);
  });

  it("withholds credit until a timed event has ended", () => {
    const credit = eventCreditByDay({
      ...base,
      nowMs: ms("2026-06-02T06:00:00.000Z"), // mid-event
      events: [{ startMs: ms("2026-06-02T04:30:00.000Z"), endMs: ms("2026-06-02T07:30:00.000Z"), allDay: false, requiresClockIn: false }],
    });
    expect(credit.size).toBe(0);
  });

  it("skips non-working days and on-leave days", () => {
    expect(eventCreditByDay({ ...base, events: [allDay("2026-06-06")] }).size).toBe(0); // Saturday
    expect(eventCreditByDay({ ...base, events: [allDay("2026-06-01")], onLeave: () => true }).size).toBe(0);
  });

  it("withholds all-day credit until the day has fully ended", () => {
    expect(eventCreditByDay({ ...base, todayYmd: "2026-06-01", events: [allDay("2026-06-01")] }).size).toBe(0);
  });

  it("clears the LOP an off-site day would otherwise incur, while a short event still falls short", () => {
    const lopBase = {
      startYmd: "2026-06-01",
      endYmd: "2026-06-01",
      workDays: [1, 2, 3, 4, 5],
      holidays: new Set<string>(),
      leaveRanges: [],
      fullDayMinutes: 480,
      halfDayMinutes: 240,
    };
    // No punch, no event: a full day of loss of pay.
    expect(lopDayUnits({ ...lopBase, workedByDay: new Map() })).toBe(1);
    // The all-day off-site credit is merged into workedByDay by the payroll build, clearing the absence.
    const credited = eventCreditByDay({ ...base, events: [allDay("2026-06-01")] });
    expect(lopDayUnits({ ...lopBase, workedByDay: credited })).toBe(0);
    // A 3h event credits 3h only, which is under the half-day minimum, so the day is still a full absence.
    const short = eventCreditByDay({
      ...base,
      events: [{ startMs: ms("2026-06-01T04:30:00.000Z"), endMs: ms("2026-06-01T07:30:00.000Z"), allDay: false, requiresClockIn: false }],
    });
    expect(short.get("2026-06-01")).toBe(180);
    expect(lopDayUnits({ ...lopBase, workedByDay: short })).toBe(1);
  });
});

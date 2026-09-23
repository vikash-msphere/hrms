import { describe, it, expect } from "vitest";
import { validateSettingValue } from "../src/routes/settings";
import { DEFAULT_ATTENDANCE, localDay } from "../src/domain/attendance";

// settings/attendance decides the org's CALENDAR DAY, the LOP divisor, the wage LOP is docked from and the
// proration basis - and it was the one such key with no validator, while its timezone field is free text in
// the UI. Both halves of that mattered, and the quiet half more:
//
//   - A zone name the runtime refuses makes `Intl.DateTimeFormat` THROW inside `localDay`, which comes out of
//     the attendance clock, the payroll build and every nightly cron subtask that asks for today. Stored, so
//     it persists until someone edits the row back by hand.
//   - A zone name the runtime ACCEPTS that is not a zone (an abbreviation, a fixed offset) errors nowhere and
//     just makes the org's day wrong.
//
// The rest of the blob is checked because it is arithmetic that fails silently rather than loudly.
const attendance = (patch: Record<string, unknown>) => () => validateSettingValue("attendance", patch);

describe("settings/attendance timezone", () => {
  it("accepts the IANA names an org would actually set", () => {
    for (const timezone of ["Asia/Kolkata", "UTC", "America/New_York", "Europe/London", "Australia/Sydney", "America/Argentina/Buenos_Aires"]) {
      expect(attendance({ timezone }), timezone).not.toThrow();
    }
    expect(attendance({ timezone: DEFAULT_ATTENDANCE.timezone })).not.toThrow();
  });

  it("rejects the names the runtime throws on, rather than storing a persistent 500", () => {
    for (const timezone of ["Asia/Bombay", "GMT+5:30", "UTC+5:30", "Asia/Kolkata_"]) {
      expect(attendance({ timezone }), timezone).toThrow();
    }
    // The reason these matter: unvalidated, this is what the day helpers would have done with them.
    expect(() => localDay(0, "GMT+5:30")).toThrow();
  });

  it("rejects abbreviations and fixed offsets, which resolve but are not zones", () => {
    // These are the dangerous ones: ICU accepts them, so nothing errors and the org's day is simply wrong -
    // and a negative fixed offset also moves every date-only comparison in the app (see utcDay).
    for (const timezone of ["IST", "EST", "PST", "GMT"]) {
      expect(() => localDay(0, timezone), `${timezone} resolves, which is why the shape rule is needed`).not.toThrow();
      expect(attendance({ timezone }), timezone).toThrow();
    }
  });

  it("rejects an empty or non-string zone", () => {
    for (const timezone of ["", "   ", 0, [], {}]) {
      expect(attendance({ timezone }), JSON.stringify(timezone)).toThrow();
    }
  });

  it("leaves the key alone when it is absent - a patch need not carry every field", () => {
    expect(attendance({ shift_start: "09:30" })).not.toThrow();
    expect(attendance({})).not.toThrow();
    // `null` is ABSENT here, not invalid, which is the `!= null` convention every validator in the file
    // follows - and it is safe, because the readers fall back to DEFAULT_ATTENDANCE for a nullish field.
    expect(attendance({ timezone: null })).not.toThrow();
  });
});

describe("settings/attendance pay arithmetic", () => {
  it("requires work_days to be a weekday array", () => {
    expect(attendance({ work_days: [1, 2, 3, 4, 5] })).not.toThrow();
    expect(attendance({ work_days: [] })).not.toThrow(); // a legitimate (if unusual) choice
    // Each of these reached `workDays.includes(...)` inside the pure day walk, which is a TypeError for a
    // non-array and silently matches nothing for the wrong element type.
    for (const work_days of ["mon", 5, [7], [-1], ["1"], [1.5]]) {
      expect(attendance({ work_days }), JSON.stringify(work_days)).toThrow();
    }
    expect(attendance({ work_days: null })).not.toThrow(); // absent, like every other nullish field
  });

  it("requires the day-length minutes to be whole minutes inside a day", () => {
    expect(attendance({ full_day_minutes: 480, half_day_minutes: 240 })).not.toThrow();
    // A string here made every comparison in `lopDayUnits` false, so nothing was ever docked - the one
    // failure mode of a payroll guard that reports nothing at all.
    for (const bad of [{ full_day_minutes: "480" }, { half_day_minutes: "abc" }, { full_day_minutes: 1441 }, { half_day_minutes: -1 }, { full_day_minutes: 8.5 }]) {
      expect(attendance(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("refuses a half day worth more than a full one", () => {
    // It inverts the ladder: the 0.5 branch becomes unreachable and every short day is a whole absence.
    expect(attendance({ full_day_minutes: 240, half_day_minutes: 480 })).toThrow();
    expect(attendance({ full_day_minutes: 480, half_day_minutes: 480 })).not.toThrow();
  });

  it("closes the basis vocabularies, so a typo cannot pick the other rule", () => {
    expect(attendance({ lop_basis: "days_30", lop_wage_basis: "basic", proration_basis: "working_days" })).not.toThrow();
    // `days30` silently fell through to the working-days divisor, which is a different amount on every payslip.
    for (const bad of [{ lop_basis: "days30" }, { lop_basis: "30_days" }, { lop_wage_basis: "ctc" }, { proration_basis: "calendar" }, { lop_basis: 30 }]) {
      expect(attendance(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("requires lop_enabled to be a boolean", () => {
    expect(attendance({ lop_enabled: true })).not.toThrow();
    expect(attendance({ lop_enabled: "true" })).toThrow();
  });
});

describe("the validator is actually wired to the key", () => {
  it("an unregistered key still accepts anything (generic settings are free-form)", () => {
    expect(() => validateSettingValue("some-feature", { anything: ["at", "all"] })).not.toThrow();
  });
  it("but `attendance` is registered - this is the wiring the whole file depends on", () => {
    expect(attendance({ timezone: "Not/AZone" })).toThrow();
  });
});

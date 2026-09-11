/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// A DATE-ONLY column's day is read in UTC. An INSTANT's day is read in the org timezone. Nothing may mix them.
//
// WHY THIS IS A GATE AND NOT A CONVENTION. The rule is stated in three places already - services/orgDay.ts
// (`dayStartMs` is the inverse: an org-local day -> the ms a date-only column stores it at),
// domain/attendance.ts (`utcDay` vs `localDay`), and a long comment in
// services/attendanceRegularizations.ts where it was fixed the first time. It was then broken again in two
// more files, and stayed broken, because every symptom of breaking it is invisible in the default
// configuration: Asia/Kolkata is +05:30, so midnight-Z is 05:30 the same morning and the two readings agree.
// West of UTC they do not, and a date-only column read through `localDay` names the PREVIOUS day - so the
// payroll build enumerated a window one day off the pay period (charging the day before it began, never
// checking the day it ended), keyed every holiday a day early (excusing a working day and docking the
// holiday), and moved the weekday composition the `working_days` proration basis divides by. The FnF
// settlement did the same to a leaver's final month.
//
// That is money, it is silent, and no test that runs with the default timezone can see it. So it is checked
// where it is visible: in the source, at the call site.
//
// THE CHECK IS DELIBERATELY NARROW. It bans `localDay(...)` applied to an expression that names a column the
// schema anchors at UTC midnight, and nothing else. `localDay(+deps.clock.now(), tz)`, `localDay(ms, tz)`,
// `localDay(+new Date(s.clockIn), tz)` - a punch is a moment, and its day IS the org's - are all correct and
// all left alone.
const src = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

// Properties that read a DATE-ONLY column (drizzle camel-cases them off the `_ms`-anchored integer columns in
// db/schema.ts). Hand-written, and that is the honest limitation of this gate: a date-only column added under
// a name not listed here is not covered until somebody adds it. It still catches the shape that was shipped
// twice, and the two names that carried it (`periodStart`/`periodEnd`, `startDate`/`endDate`, `date`) are the
// ones every new surface reaches for.
const DATE_ONLY_PROPS = [
  "date",
  "periodStart",
  "periodEnd",
  "payDate",
  "startDate",
  "endDate",
  "dueDate",
  "effectiveFrom",
  "effectiveTo",
  "joinDate",
  "offerDate",
  "expiryDate",
  "probationEndDate",
  "settlementDate",
  "meetingDate",
  "pickByDate",
];

// `localDay(` … `<anything>.<a date-only prop>` … before the argument list closes. The `[^)]*` keeps it on
// one call, so an unrelated later argument cannot trip it.
const OFFENDING = new RegExp(String.raw`localDay\(\s*[^)]*\.(?:${DATE_ONLY_PROPS.join("|")})\b[^)]*\)`, "g");

// domain/attendance.ts DEFINES both helpers and documents the difference, so its prose is allowed to name it.
const OWNER = "src/domain/attendance.ts";

const rel = (path: string) => path.replace(/^\.\.\//, "");

describe("date-only columns are read in UTC, instants in the org timezone", () => {
  it("no source reads a date-only column through localDay", () => {
    const hits: string[] = [];
    for (const [path, text] of Object.entries(src)) {
      const file = rel(path);
      if (file === OWNER) continue;
      for (const line of text.split("\n")) {
        // Comments are where this rule is explained; only code counts.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        for (const m of line.matchAll(OFFENDING)) hits.push(`${file}: ${m[0].trim()}`);
      }
    }
    expect(
      hits,
      "a date-only column is anchored at UTC midnight, so the day it NAMES is the UTC one - use `utcDay(ms)` " +
        "from domain/attendance.ts. `localDay` is for an INSTANT (a punch, `now`), whose day is the org's. " +
        "See services/orgDay.ts#dayStartMs for the same rule stated from the other direction.",
    ).toEqual([]);
  });

  it("the gate would have caught the two call sites that shipped it", () => {
    // The regex is the whole test, so it is worth pinning against the exact lines that were wrong - otherwise
    // a later tidy-up of the pattern can silently stop matching anything and the suite still passes.
    for (const wrong of [
      "  const startYmd = localDay(+new Date(period.periodStart), tz);",
      "      .map((h) => localDay(+new Date(h.date), tz)),",
      "    const empStartYmd = e.startDate ? localDay(+new Date(e.startDate), tz) : null;",
      "    .map((l) => ({ start: localDay(+new Date(l.startDate), tz), end: localDay(+new Date(l.endDate), tz) }));",
    ]) {
      expect([...wrong.matchAll(OFFENDING)].length, wrong).toBeGreaterThan(0);
    }
    // And that it does NOT match the readings that are correct.
    for (const right of [
      "  const todayYmd = localDay(+deps.clock.now(), tz);",
      "    const day = localDay(ms, tz);",
      "      .filter((s) => localDay(+new Date(s.clockIn), tz) === targetYmd);",
      "  const ymd = localDay(+deps.clock.now() - DAY_MS, tz);",
    ]) {
      expect([...right.matchAll(OFFENDING)].length, right).toBe(0);
    }
  });
});

/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { formatDateTime, formatDayTime, formatHHMM, formatTime } from "../web/src/lib/utils";
import { clockOf } from "../src/domain/workSchedule";

// Times read 12-hour everywhere, whatever the viewer's browser locale. Left to the locale, a browser set to UK
// English drew "18:30" on the lock screen and in every list, beside the "6:30 PM" attendance always showed.

// Built from local parts, so the instant is 6:30 PM on this machine's clock whatever its zone.
const evening = new Date(2026, 7, 4, 18, 30);

describe("12-hour time", () => {
  it("formats an instant as h:mm AM/PM", () => {
    expect(formatTime(evening)).toBe("6:30 PM");
    expect(formatTime(new Date(2026, 7, 4, 0, 5))).toBe("12:05 AM");
    expect(formatTime(new Date(2026, 7, 4, 12, 0))).toBe("12:00 PM");
    expect(formatTime("not a time")).toBe("");
  });

  it("pairs the time with the app's day-first date", () => {
    expect(formatDateTime(evening.toISOString())).toBe("4 Aug 2026, 6:30 PM");
    expect(formatDayTime(evening.toISOString())).toBe("Tue 4 Aug, 6:30 PM");
    expect(formatDateTime(undefined)).toBe("-");
  });

  it("reads a stored HH:MM as a wall clock", () => {
    expect(formatHHMM("18:30")).toBe("6:30 PM");
    expect(formatHHMM("09:00")).toBe("9:00 AM");
    expect(formatHHMM("00:00")).toBe("12:00 AM");
    expect(formatHHMM("")).toBe("");
    expect(formatHHMM(undefined)).toBe("");
  });

  it("wraps minutes past midnight rather than printing 25:10", () => {
    expect(clockOf(1510)).toBe("1:10 AM");
    expect(clockOf(-30)).toBe("11:30 PM");
  });
});

// A tripwire for the calls that follow the viewer's locale for the time of day. Route them through
// formatTime / formatDateTime / formatDayTime (lib/utils.ts) instead. Comments are stripped first, so a note
// that names one of these calls is not a finding.
const sources = import.meta.glob("../web/src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const VIEWER_TIME = /toLocaleTimeString\(|timeStyle\s*:|new Date\([^()]*\)\.toLocaleString\(\)/;

describe("no viewer-locale time formatting in the web app", () => {
  it("has none", () => {
    const hits = Object.entries(sources).flatMap(([file, src]) =>
      stripComments(src).split("\n").flatMap((line, i) => (VIEWER_TIME.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [])),
    );
    expect(hits).toEqual([]);
  });
});

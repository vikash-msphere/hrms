/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { STALE_AFTER_DAYS, goalPace } from "../src/domain/goals";
import { STALE_DAYS, isBehind, isOverdue, isQuiet, isTroubled } from "../web/src/lib/goalState";
import type { Goal } from "../web/src/types";

// One definition of "this goal is in trouble", pinned to the server it is derived from - and kept the only one.
//
// `goals` is drawn on seven surfaces (the Goals page's cards, drawer and alignment cascade, the Team goals
// triage, the Performance tab of a profile, the review's goal section, the 1:1 agenda builder). Each had
// written its own predicates, and they had drifted: "at risk" accepted `pace === "behind"` on one page and
// not on another, so one goal was a warning in one place and healthy in the other. lib/goalState.ts is now
// the single copy; this test keeps it single, and keeps it honest about the server.

const goal = (g: Partial<Goal>): Goal => ({ path: "goals/1", title: "g", status: "in_progress", ...g } as Goal);
const ymd = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

describe("the client's goal-trouble rules mirror the server's", () => {
  it("uses the server's silence threshold", () => {
    expect(STALE_DAYS).toBe(STALE_AFTER_DAYS);
  });

  it("catches the overdue goal the server's pace cannot report", () => {
    // `goalPace` clamps the elapsed fraction at 1, so once the due date has gone by `expected` is 100 and the
    // drift is only `progress - 100`. A goal sixty days late at 95% comes back on_track - which is why
    // `isOverdue` is its own question and not something read off `pace`.
    const pace = goalPace({ createdAt: new Date(Date.now() - 120 * 86_400_000), dueDate: new Date(Date.now() - 60 * 86_400_000), progress: 95, status: "in_progress" });
    expect(pace?.state).toBe("on_track");

    const late = goal({ due_date: ymd(-60), progress: 95, pace: "on_track" });
    expect(isBehind(late), "pace alone calls this healthy").toBe(false);
    expect(isQuiet(late), "and it is not silent either").toBe(false);
    expect(isOverdue(late)).toBe(true);
    expect(isTroubled(late), "so trouble has to include the missed date itself").toBe(true);
  });

  it("treats a goal ten points down as behind, not only one twenty-five down", () => {
    expect(isBehind(goal({ pace: "behind" }))).toBe(true);
    expect(isBehind(goal({ pace: "at_risk" }))).toBe(true);
    expect(isBehind(goal({ pace: "on_track" }))).toBe(false);
  });

  it("takes the owner's own call as well as the arithmetic", () => {
    expect(isBehind(goal({ pace: "on_track", confidence: "at_risk" }))).toBe(true);
    expect(isBehind(goal({ pace: "on_track", confidence: "off_track" }))).toBe(true);
    expect(isBehind(goal({ pace: "on_track", confidence: "on_track" }))).toBe(false);
  });

  it("reports nothing about a finished goal", () => {
    // A completed goal has arrived at whatever it arrived at. The server says the same by returning no pace
    // and no stale count for one, and a red chip on delivered work is a permanent accusation.
    for (const status of ["completed", "cancelled"] as const) {
      const done = goal({ status, due_date: ymd(-60), stale_days: 90, pace: "at_risk", confidence: "off_track" });
      expect(isOverdue(done), status).toBe(false);
      expect(isBehind(done), status).toBe(false);
      expect(isQuiet(done), status).toBe(false);
      expect(isTroubled(done), status).toBe(false);
    }
  });

  it("counts silence only once it crosses the threshold", () => {
    expect(isQuiet(goal({ stale_days: STALE_DAYS - 1 }))).toBe(false);
    expect(isQuiet(goal({ stale_days: STALE_DAYS }))).toBe(true);
  });
});

describe("no goal surface keeps its own copy of these rules", () => {
  // The drift this module exists to stop does not come back as a changed rule; it comes back as a new page
  // quietly declaring `const atRisk = g.pace === ...` next to the shared one. Scanning for the shape catches
  // that on the commit that introduces it rather than the quarter someone notices two pages disagreeing.
  // `import.meta.glob`, the way test/responsiveCoverage.test.ts reads the web sources: this suite runs in the
  // worker runtime, where node's `readdirSync` cannot see the project tree.
  const web = import.meta.glob("../web/src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

  // The two modules that are ALLOWED to state these rules.
  const OWNERS = ["/lib/goalState.ts", "/components/common/GoalChips.tsx"];

  // Comments out first. This file's own prose explains the rule it is checking for, and several of the
  // modules it scans carry a note saying which shared predicate replaced their old inline one - a scan that
  // reads those as violations is a scan that punishes writing down why.
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("states the pace and silence rules in one place", () => {
    const offenders: string[] = [];
    for (const [file, raw] of Object.entries(web)) {
      if (OWNERS.some((o) => file.endsWith(o))) continue;
      const src = code(raw);
      // A comparison against a pace/confidence literal, or a hand-rolled staleness threshold.
      if (/\b(pace|confidence)\s*===\s*["'](at_risk|off_track|behind)["']/.test(src)) {
        offenders.push(`${file}: compares pace/confidence itself - use isBehind from lib/goalState`);
      }
      if (/stale_days\s*(\?\?\s*0\s*)?\)?\s*>=\s*\d/.test(src)) {
        offenders.push(`${file}: rolls its own silence threshold - use isQuiet from lib/goalState`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

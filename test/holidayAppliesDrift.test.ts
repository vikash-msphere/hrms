/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// A REGIONAL HOLIDAY FOR ANOTHER LOCATION IS AN ORDINARY WORKING DAY HERE.
//
// `applies` is the server's per-viewer answer to "is this holiday one of yours" (regional holidays are
// configured per location). A consumer that filters holidays on `disabled` alone therefore treats every other
// office's holiday as this viewer's day off - which is why every consuming predicate in the app pairs the two,
// and why pages/Attendance.tsx:274 spells it out: "A regional holiday for another location (`applies ===
// false`) is a normal working day here."
//
// The failures this catches are silent and they are not cosmetic. A holiday the viewer does not observe:
//   - zeroes the org-wide "not clocked in" KPI on the dashboard, with the hint "Holiday today", on a day the
//     rest of the org is working (Dashboard.tsx:838 gates on it);
//   - is named in the Leaves detail note as a day that "doesn't come off the balance", contradicting the
//     server's own charged figure - the note exists to RECONCILE with that figure (Leaves.tsx:180-181).
//
// Scoped to CONSUMERS deliberately. pages/Holidays.tsx and components/holidays/* are the admin surface: they
// list and edit every location's holidays, so filtering by `applies` there would hide the rows an admin came
// to manage. The rule is about the pages that decide whether somebody has a day off.
const pages = import.meta.glob("../web/src/**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const isAdminSurface = (path: string) => /pages\/Holidays\.tsx$/.test(path) || /components\/holidays\//.test(path);

/** Files that read the holidays collection to act on it, rather than to administer it. */
const consumers = Object.entries(pages)
  .filter(([path, src]) => !isAdminSurface(path) && /useCollection<Holiday>/.test(src))
  .map(([path, src]) => [path.replace(/^.*\/web\/src\//, "web/src/"), src] as const);

/** Lines that test a holiday's `disabled` flag. `h` is the loop/predicate variable in every consumer. */
const holidayDisabledLines = (src: string): { line: number; text: string }[] =>
  src
    .split("\n")
    .map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => /\bh\.disabled\b/.test(text));

describe("holidays: consumers honour `applies`", () => {
  it("finds the consumer files (so a rename cannot empty this suite)", () => {
    const names = consumers.map(([p]) => p);
    expect(names.length).toBeGreaterThan(2);
    // The two that decide whether a day is worked at all - if either stops reading holidays, this test is
    // no longer covering what it was written for.
    expect(names).toContain("web/src/pages/Attendance.tsx");
    expect(names).toContain("web/src/pages/Dashboard.tsx");
  });

  it.each(consumers.map(([p]) => p))("%s pairs every holiday `disabled` test with `applies`", (path) => {
    const src = consumers.find(([p]) => p === path)![1];
    const unguarded = holidayDisabledLines(src).filter(({ text }) => !/\bapplies\b/.test(text));
    // Named in the failure, because "somewhere in this file" is not actionable on a 2000-line page.
    expect(unguarded.map(({ line, text }) => `${path}:${line}  ${text.trim()}`)).toEqual([]);
  });
});

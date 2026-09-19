/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// The controls that exist once, kept existing once.
//
// A shared component only stays shared while nobody writes a tenth copy of it, and a copy is never written
// on purpose - it is written because the person needed a pill filter, could not see that one already
// existed, and had the markup to hand. By the time anybody notices, the copies have drifted and the drift is
// what a reader sees walking from page to page.
//
// THE PILL FILTER had drifted into four appearances across nine files before this rule existed:
//
//   Goals, Team goals, Reviews, Holidays, Suggestions  transparent, `hover:bg-accent`
//   Payslips                                           `bg-background`, `hover:bg-muted hover:text-foreground`
//   Announcements                                      `bg-background`, `hover:bg-muted dark:hover:bg-muted`
//   Workflows                                          `bg-card text-foreground`, count in a pill of its own
//
// Nobody chose any of that. It is what one control looks like after being typed out nine times.

const web = import.meta.glob("../web/src/**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const rel = (k: string) => k.replace("../web/src/", "");
// Comments out first: the module that owns a control describes the shape it replaced, and a scan that reads
// that description as a violation is a scan that punishes writing it down.
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** The pill-filter signature: a rounded-full bordered button in the chip's exact metrics. */
const PILL = /rounded-full border px-3 py-1 text-xs font-medium/;

describe("one pill filter", () => {
  it("only FilterChips draws it", () => {
    const offenders = Object.entries(web)
      .filter(([k]) => rel(k) !== "components/common/FilterChips.tsx")
      .filter(([, src]) => PILL.test(code(src)))
      .map(([k]) => `${rel(k)}: draws its own pill filter - use FilterChip from components/common/FilterChips`);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("every page that filters a list uses it", () => {
    // The nine that were converted. Named rather than counted, so deleting the import from one of them fails
    // here instead of quietly restoring a hand-written copy somewhere else in the same file.
    const users = [
      // Goals only: the Team goals page was folded into it as a scope, so one page now draws both chip rows
      // (the scope, and the state filter) over one read.
      "pages/Goals.tsx",
      "pages/Reviews.tsx",
      "pages/Payslips.tsx",
      "pages/Holidays.tsx",
      "pages/Suggestions.tsx",
      "pages/Announcements.tsx",
      "pages/Workflows.tsx",
      "components/common/PostComposer.tsx",
    ];
    const missing = users.filter((f) => !(web[`../web/src/${f}`] ?? "").includes("FilterChip"));
    expect(missing, `stopped using the shared chip:\n${missing.join("\n")}`).toEqual([]);
  });
});

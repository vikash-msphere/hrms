/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// A MULTI-PAGE READ MUST NOT OVERWRITE A NEWER ONE.
//
// `getAllPages` (web/src/api.ts) follows the server cursor, so one call is several SEQUENTIAL round-trips -
// a far wider race window than a single fetch. Called from an effect keyed on a selector the reader can change
// quickly (the week on a roster or a timesheet, the selected record on a detail panel), the slower earlier
// request can resolve last and replace the state the newer one already wrote.
//
// The symptom is not an error. Schedule and Timesheets both key their load on the week and both derive
// everything on screen from that one state - so the page paints one week's rows, and one week's totals, under
// another week's column headers. Each file's own comment already names that outcome ("a roster that is short is
// a roster that is WRONG", "a short read is a wrong timesheet, not a short one"); the cursor-following fixed it
// coming from the server and left it reachable from the client.
//
// A SOURCE SCAN, because there is no React test tooling in this project (web logic is tested where it is
// extracted into plain modules) and because what regresses is a CALL SITE - the next page to add a paged load
// will be written by somebody who never read this file. Same shape as test/listScopeDrift.ts.
const sources = import.meta.glob("../web/src/**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const basename = (path: string) => path.split("/").pop()!.replace(/\.tsx$/, "");

/** Does the file make a cursor-following read at all? */
const usesPagedRead = (src: string) => /\bgetAllPages\s*</.test(src);

/**
 * Does it carry a staleness guard?
 *
 * Two spellings, both already in the codebase and both correct for their situation:
 *   - a GENERATION COUNTER (`reqSeq`), for a loader that is also called directly after a write, where there is
 *     no effect cleanup to hang a flag on (Schedule, Timesheets);
 *   - the CLEANUP FLAG (`let live = true` + `return () => { live = false; }`), for a load that only ever runs
 *     from the effect that owns it (Documents).
 */
const hasStalenessGuard = (src: string) => /\breqSeq\b/.test(src) || /let\s+live\s*=\s*true/.test(src);

/**
 * Files that call `getAllPages` and legitimately need no guard, each with the property that makes it true.
 *
 * The bar is "a stale answer cannot be written over a fresh one", never "this is probably fine".
 *
 *   Interviews - the paged reads run inside the slot-finder, which is invoked from a BUTTON and writes its
 *     result into the dialog that press opened. There is no keyed effect re-firing it as a selector changes,
 *     so there is no newer response for an older one to overwrite.
 */
const EXEMPT = new Set<string>(["Interviews"]);

describe("a cursor-following read cannot overwrite a newer one", () => {
  const paged = Object.entries(sources)
    .map(([path, src]) => ({ name: basename(path), src }))
    .filter(({ src }) => usesPagedRead(src));

  it("found the paged readers (sanity: the matcher still works)", () => {
    expect(paged.length).toBeGreaterThan(2);
  });

  it("guards every paged read against a stale response", () => {
    const unguarded = paged.filter(({ name, src }) => !EXEMPT.has(name) && !hasStalenessGuard(src)).map(({ name }) => name);
    expect(
      unguarded,
      "these pages follow the cursor into component state with no staleness guard - a slower earlier request " +
        "can resolve last and repaint the view with data the reader has already navigated away from",
    ).toEqual([]);
  });

  it("keeps the exemption list honest", () => {
    const stale = [...EXEMPT].filter((name) => !paged.some((f) => f.name === name));
    expect(stale, "listed as exempt but no longer makes a paged read - drop it").toEqual([]);
  });
});

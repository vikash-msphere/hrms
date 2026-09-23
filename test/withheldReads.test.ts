/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { HELDABLE } from "../src/services/withheld";

// Every read over a heldable table calls `notHeld`, or is named here with the reason it does not.
//
// `services/withheld.ts` states the rule and names this file as the thing that watches for it: a held post is
// withheld from EVERYONE, there are a dozen reads over the three tables that carry `held_at`, and one of them
// forgetting is not a cosmetic bug - it is the gate not holding, on the surface where somebody looked. The
// rule is not expressible in the type system (a drizzle query is a chain of method calls, and omitting a
// `where` clause is a valid one), so it is held the way this codebase holds its other unwritable conventions:
// a source scan, in the shape `scopedVerbDrift` already uses.
//
// THREE READS FAILED THIS WHEN IT WAS WRITTEN - `similarSuggestions` rendered a held suggestion's title as
// somebody else's neighbour, and the two review helpers counted a held kudos as evidence. All three were
// written against the pre-gate world and never revisited, which is exactly the drift a scan catches and a
// unit test per function does not.
const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** `announcement-replies` -> `announcementReplies`: the schema object a heldable collection is stored in. */
const schemaNameOf = (collection: string) => collection.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * Reads that deliberately see held rows, by `<path>#<function>`, each with the reason.
 *
 * Two kinds only. THE MODERATION SERVICE owns the state: it asks whether a row is held, it is the one screen
 * that shows held rows, and it is what clears the hold. THE WRITE PATHS reach their rows through their own
 * reads (`services/crud.ts:172-183` argues this at length): an author may still edit or delete what they
 * wrote while it waits, which is the only recourse a held post has.
 */
const ALLOWED = new Map<string, string>([
  ["services/moderation.ts#isHeldPost", "asks the question: whether this row is the one being held"],
  ["services/moderation.ts#liveHosts", "the moderation queue, the one screen that exists to show held rows"],
  ["services/moderation.ts#releasePost", "clears the hold, so it has to read the row that carries it"],
  ["services/moderation.ts#publishBack", "puts a held post back on the wall, and reads it to know whether it ever had a publish"],
  ["services/moderation.ts#authorOf", "tells the author their own post is being held"],
  ["services/moderation.ts#auditAnchor", "audits a decision about a held row"],
  ["services/moderation.ts#hideHost", "a moderator's takedown, which applies to a held row as much as a live one"],
  ["services/announcements.ts#getAnnouncement", "the write paths' own fetch: an author may edit what is held"],
  ["services/announcements.ts#updateAnnouncement", "write path: rewriting the sentence that got the post held"],
  ["services/suggestions.ts#updateSuggestion", "write path: same recourse on the suggestion wall"],
  ["services/suggestions.ts#respondSuggestion", "write path, and the response re-enters the gate"],
  ["services/suggestions.ts#voteSuggestion", "write path; the vote is refused on its own terms, not by a read"],
  ["services/suggestions.ts#mergeSuggestion", "write path: merging is a write over rows by id"],
]);

/**
 * The source with its comments removed.
 *
 * A statement is read as "from `.from(` to the next `;`", and the queries in this codebase carry prose
 * between their clauses - prose that contains semicolons. One of them ("the gate owns held rows; the sweep
 * does not touch them") ended the statement four lines before the `notHeld` it was explaining, so the scan
 * reported a correct query as a violation.
 */
const withoutComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/[^\n]*$/gm, "");

/** A top-level declaration only: `const row = (await ...)` inside a function is a local, not the enclosing
 *  function, and keying a read by it would make the allowance list ambiguous (four `#row`s in one file). */
const TOP_LEVEL_DECL = /^(?:export )?(?:async )?function ([A-Za-z0-9_]+)|^(?:export )?const ([A-Za-z0-9_]+) = (?:async )?\(/gm;

type Read = { key: string; file: string; snippet: string; satisfied: boolean };

/** Every `.from(<heldable table>)` in `src/`, with whether its statement binds the predicate. */
function heldableReads(): Read[] {
  const tables = HELDABLE.map(schemaNameOf);
  const out: Read[] = [];
  for (const [path, raw] of Object.entries(sources)) {
    const file = path.replace(/^\.\.\/src\//, "");
    const src = withoutComments(raw);
    // A query may read the table through a local binding (`const a = schema.announcements;`), which is how
    // the moderation service keeps its joins legible. Those names count as the table they hold.
    const names = new Set(tables.map((t) => `schema.${t}`));
    for (const m of src.matchAll(/\bconst ([A-Za-z0-9_]+) = schema\.([A-Za-z0-9_]+);/g)) {
      if (tables.includes(m[2]!)) names.add(m[1]!);
    }
    for (const m of [...src.matchAll(/\.from\(([A-Za-z0-9_.]+)\)/g)]) {
      if (!names.has(m[1]!)) continue;
      const at = m.index!;
      // The statement, which is the chain the `.from` sits in: drizzle puts `.where` after `.from`, and a
      // statement ends at the first `;`.
      const end = src.indexOf(";", at);
      const stmt = src.slice(at, end < 0 ? src.length : end);
      const before = src.slice(0, at);
      const fn = [...before.matchAll(TOP_LEVEL_DECL)].pop();
      out.push({
        key: `${file}#${fn?.[1] ?? fn?.[2] ?? "<top level>"}`,
        file,
        // A line number would be the COMMENT-STRIPPED one and so point at the wrong line in the editor; the
        // opening of the chain is what a reader needs to find it anyway.
        snippet: stmt.replace(/\s+/g, " ").slice(0, 80),
        // `visibleWhere` is the board's one predicate and calls `notHeld` itself, so a read that binds it has
        // honoured the rule through the helper that exists to stop the board and `:markAllRead` drifting.
        satisfied: /notHeld\(|visibleWhere\(/.test(stmt),
      });
    }
  }
  return out;
}

describe("reads over a held post", () => {
  it("finds the reads at all", () => {
    // A rename that makes the scan match nothing would leave it passing for ever over an empty set.
    const reads = heldableReads();
    expect(reads.length).toBeGreaterThan(10);
    expect(reads.some((r) => r.satisfied)).toBe(true);
  });

  it("covers every table that can be held", () => {
    // A fourth heldable wall enters the scan by being added to HELDABLE, with no second list to remember.
    expect([...HELDABLE].sort()).toEqual(["announcement-replies", "announcements", "suggestions"]);
  });

  it("binds notHeld, or says why not", () => {
    const missing = heldableReads()
      .filter((r) => !r.satisfied && !ALLOWED.has(r.key))
      .map((r) => `${r.key}: ${r.snippet}`);
    // A read here is one that shows held content to somebody. If it is deliberate, name it in ALLOWED with
    // the reason; if it is not, add `notHeld(<table>)` to the query.
    expect(missing).toEqual([]);
  });

  it("has no allowance for a read that now binds the predicate", () => {
    // A stale allowance is an exemption nobody is looking at any more, which is how the next one gets in.
    const reads = heldableReads();
    const unheeded = [...ALLOWED.keys()].filter((k) => !reads.some((r) => r.key === k && !r.satisfied));
    expect(unheeded).toEqual([]);
  });

  it("gives a reason for every allowance", () => {
    for (const [key, reason] of ALLOWED) expect(reason.length, `${key} needs a reason`).toBeGreaterThan(20);
  });
});

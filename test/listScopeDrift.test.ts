/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// EVERY route-level `list` HOOK BINDS THE SCOPE THE MIDDLEWARE DECIDED.
//
// `http/collectionRoute.ts` hands a `list` hook the request context precisely so a scoped list can read
// `c.get("scope")` - the breadth the authz middleware resolved for this caller, plus their per-object shares
// and denies - and bind it with `applyScope`. The generic list in services/crud.ts always does. A hook that
// replaces it and forgets simply answers with the whole table.
//
// FOUR OF THEM DID: event-log, automation-runs, workflow-instances and cron-runs. Nothing caught it, and
// nothing could - the failure is invisible while every seeded grant for those collections is `<collection>.**`
// (breadth `all`, where binding the scope is a no-op), and it only appears the first time an admin authors a
// NARROWER rule through the ACL. At that point the caller's grant says "your department" and the list says
// "everything", which is the one direction this codebase refuses everywhere else: services/listScope.ts fails
// closed on a scope it cannot satisfy, and a hook that never asks for the scope never reaches it.
//
// A SOURCE SCAN rather than a per-route behavioural test, deliberately, and for the same reason
// test/collectionLaneDrift.ts is one: what regressed is a CALL SITE, the set of call sites grows with every new
// collection, and the next hook to forget will be written by somebody who never read this file. Per-route
// assertions (test/listScopeBinding.test.ts) pin the four services that already regressed; this pins the rule.
const sources = import.meta.glob("../src/routes/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const basename = (path: string) => path.split("/").pop()!.replace(/\.ts$/, "");

/** A route file that declares a spec-level `list` hook (the factory's override of the generic list). */
const hasListHook = (src: string) => /^\s*list:\s*(?:async\s*)?\(/m.test(src);

/**
 * Does the file reach for the decided scope at all?
 *
 * Either spelling counts. Most hooks read `c.get("scope")` and pass it to `applyScope`; a few hand it to a
 * service that binds it (`listBoards(deps, user, c.get("scope"), …)`), which is the same thing one call deeper
 * and is what test/listScopeBinding.test.ts asserts behaviourally. What this refuses is a file that mentions
 * neither - a hook that cannot be binding a scope it never obtained.
 */
const bindsScope = (src: string) => /c\.get\("scope"\)/.test(src) || /applyScope\(/.test(src);

/**
 * Files whose `list` hook legitimately needs no scope, each with the property that makes it true.
 *
 * ONE ENTRY, and the bar for a second is the sentence below, not convenience. A collection whose rows are not
 * scoped still costs nothing to bind (`applyScope` at breadth `all` adds no predicate), so "this one is
 * admin-only anyway" is not a reason - it is the exact reasoning that left the four above unbound. An entry
 * owes a statement of why the scope CANNOT apply, never why it does not currently matter.
 *
 *   holidaySelections - the list is hard-pinned to `actor.employeeId` and returns nothing without one
 *     (services/holidaySelections.ts), which is strictly narrower than any breadth a scope can carry. The row
 *     IS the caller's own pick of an optional holiday: `get` and `remove` are owner-only by the same test, and
 *     a per-object share or deny on somebody's own holiday selection has no meaning to express.
 */
const EXEMPT = new Set<string>(["holidaySelections"]);

describe("every route-level list hook binds the middleware's scope", () => {
  const withHook = Object.entries(sources)
    .map(([path, src]) => ({ name: basename(path), src }))
    .filter(({ src }) => hasListHook(src));

  it("found the list hooks (sanity: the regex still matches the route files)", () => {
    expect(withHook.length).toBeGreaterThan(10);
  });

  it("has no list hook that ignores the caller's scope", () => {
    const unbound = withHook.filter(({ name, src }) => !EXEMPT.has(name) && !bindsScope(src)).map(({ name }) => name);
    expect(
      unbound,
      "these route files declare a `list` hook but never read c.get(\"scope\") or call applyScope - " +
        "the hook replaces the generic list, so it answers with the whole table whatever the caller's grant says",
    ).toEqual([]);
  });

  it("keeps the exemption list honest", () => {
    const stale = [...EXEMPT].filter((name) => !withHook.some((f) => f.name === name));
    expect(stale, "listed as exempt but no longer declares a list hook - drop it").toEqual([]);
  });
});

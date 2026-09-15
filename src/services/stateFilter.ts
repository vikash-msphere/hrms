// The LIST half of state-gated visibility.
//
// THE GAP THIS FILLS. `STATE_VISIBILITY` had three consumers and only two of them were general: the item gate
// (domain/access.ts stateReadAllowed) and the search index (db/searchDdl.ts) both build themselves from the
// manifest, while the list filter was hand-written inside `services/announcements.ts` for that collection's two
// boolean columns. So the manifest looked like a mechanism any collection could opt into, and adding a second
// entry would have gated the item lane and the search index while leaving the plain list unfiltered - the
// caller who cannot open a draft would still see it listed, which is the same split-brain the owner key and the
// manager chain each had to close in their own lane.
//
// Mechanical, and decides NOTHING: the middleware already resolved `seeRestricted` from the caller's grant
// (`scopeFor` -> `seeRestrictedFor`), exactly as it resolves breadth. This only maps that verdict onto columns,
// the same contract `applyScope` has.
import { and, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { StateRule } from "../domain/manifests";

/**
 * The predicate that keeps a caller who may not see restricted rows to the PUBLIC ones, or undefined when there
 * is nothing to add (no rule, or a caller who may see everything).
 *
 * `table` is the drizzle table; the rule's keys are its property names. A key the table does not carry is
 * skipped rather than guessed at - the item gate treats a missing column as "not public" and so fails closed on
 * its own, and inventing a predicate for a column that is not there would be a silent always-false list.
 *
 * FAIL-CLOSED ON THE NULL CASE, matching `isPublicState`: a string clause uses `IS NOT NULL AND col IN (...)`,
 * so a row whose status was never set is restricted. A boolean clause keeps the original coercion, where NULL
 * is false and therefore public only when the rule wants `false`.
 */
export function publicStateFilter(rule: StateRule | undefined, table: any, seeRestricted: boolean): SQL | undefined {
  if (!rule || seeRestricted) return undefined;
  const conds: SQL[] = [];
  for (const [prop, want] of Object.entries(rule.public_when)) {
    const c = table[prop] as AnySQLiteColumn | undefined;
    if (!c) continue;
    if (typeof want === "boolean") {
      // `coalesce(col, 0)` so a NULL flag compares as false, which is what `Boolean(null)` does on the item side.
      conds.push(sql`coalesce(${c}, 0) = ${want ? 1 : 0}`);
      continue;
    }
    const wanted = Array.isArray(want) ? want : [want];
    conds.push(and(isNotNull(c), wanted.length === 1 ? eq(c, wanted[0]!) : inArray(c, wanted))!);
  }
  return conds.length ? and(...conds) : undefined;
}

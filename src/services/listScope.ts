import { like, eq, sql, or, and, not, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { ListScope } from "../domain/access";

// Mechanical scope binder - NO access decision. The middleware already decided the breadth (scopeFor over
// the grant) + the caller's per-object shares/denies, and put it on the request context; this only maps
// that to THIS table's columns: (breadth OR code in a shared subtree) AND code NOT in a denied subtree.
// Fail-closed: an unset scope (a list endpoint the middleware did not scope) yields `1 = 0` (nothing), never
// the full table. `code` is the row's hierarchy code; `owner` is the id column for "own". Either may be absent
// (a catalog table has no owner column at all) and the same rule applies: a breadth that needs a column the
// table does not have matches nothing rather than everything.
//
// A per-object share/deny on code C covers C AND its whole subtree (the same `isUnder` the item path decides
// with), bound boundary-safe as `(code = C OR code LIKE 'C-%')`. The trailing '-' is the delimiter guard, so
// a share on `04-002` lists `04-002` + `04-002-*` but NEVER the prefix-collision neighbour `04-0029`. No bare
// prefix match. Codes are server-generated base32 + '-' (no LIKE wildcards), so the pattern needs no escaping.
export function applyScope(
  scope: ListScope | undefined,
  code: AnySQLiteColumn | undefined,
  owner: AnySQLiteColumn | undefined,
): SQL | undefined {
  if (!scope) return sql`1 = 0`; // fail closed: no scope set -> no rows
  const shares = scope.shares ?? [];
  const denies = scope.denies ?? [];

  // Match code C and everything under it (boundary-anchored). Mirrors the engine's isUnder on the item path.
  const subtree = (c: string): SQL => (code ? or(eq(code, c), like(code, `${c}-%`))! : sql`1 = 0`);

  // Breadth predicate (undefined = all rows, no filter). `all` needs no column, so it is the one breadth a
  // table without a code or owner column can still answer.
  let base: SQL | undefined;
  if (scope.breadth === "all") base = undefined;
  else if (scope.breadth === "dept") base = scope.deptCode && code ? like(code, `${scope.deptCode}-%`) : sql`1 = 0`;
  else base = scope.ownerId && owner ? eq(owner, scope.ownerId) : sql`1 = 0`; // own

  // OR in per-object shares (each as its subtree). If breadth is 'all' (base undefined) the caller already
  // sees everything, so shares add nothing.
  let pred = base;
  if (shares.length && base !== undefined) pred = or(base, ...shares.map(subtree));

  // AND NOT per-object denies (deny-wins, even against 'all'): a denied subtree is hidden regardless of breadth.
  //
  // A deny is the one half of this function that must never soften. On a table with NO code column there is
  // nothing to match it against, and expressing it through `subtree` (which answers `1 = 0` for a missing
  // column) inverted to `not(1 = 0)` - always true - so the deny silently evaporated and the row it was meant
  // to hide was listed. Every other branch above fails CLOSED on a missing column; this one failed open, in
  // the direction that leaks. So: no column to bind a deny to means no rows, not no deny.
  if (denies.length) {
    if (!code) return sql`1 = 0`;
    const denied = not(or(...denies.map(subtree))!);
    pred = pred === undefined ? denied : and(pred, denied);
  }

  return pred;
}

import { eq, sql, or, and, not, type SQL } from "drizzle-orm";
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
// with), bound boundary-safe as `(code = C OR code GLOB 'C-*')`. The trailing '-' is the delimiter guard, so
// a share on `04-002` lists `04-002` + `04-002-*` but NEVER the prefix-collision neighbour `04-0029`. No bare
// prefix match. Codes are server-generated base32 + '-' (no glob metacharacters), so no escaping is needed.
//
// GLOB, NOT LIKE, AND THIS IS A PERFORMANCE DECISION, NOT A STYLE ONE. SQLite can only turn a prefix pattern
// into the index range scan it looks like when the comparison is case-SENSITIVE: with the default
// `case_sensitive_like=OFF`, `code LIKE 'C-%'` is a full table SCAN even with `code` uniquely indexed - which
// every `code` column is (schema.ts `codeCol`). D1 exposes no way to set that pragma, so the operator is the
// only lever. `EXPLAIN QUERY PLAN` on the exact predicate this builds:
//
//   code = '04' OR code LIKE '04-%'  ->  SCAN x
//   code = '04' OR code GLOB '04-*'  ->  MULTI-INDEX OR
//                                          SEARCH x USING COVERING INDEX (code=?)
//                                          SEARCH x USING COVERING INDEX (code>? AND code<?)
//
// That is the difference between an indexed lookup and reading the table, on the hottest predicate in the
// app: this runs for `dept` breadth AND for every per-object share and deny - and denies apply even at `all`
// breadth, so an admin's list scanned too. It costs nothing on seeded data and is the first thing to fall
// over on a real `attendance`/`notifications`/`audit_log`/`payslips` table.
//
// GLOB is case-sensitive where LIKE was not, which is strictly tighter and changes no result: codes are
// generated from the lowercase Crockford alphabet in domain/codes.ts, so no code has a case variant to match.
export function applyScope(
  scope: ListScope | undefined,
  code: AnySQLiteColumn | undefined,
  owner: AnySQLiteColumn | undefined,
): SQL | undefined {
  if (!scope) return sql`1 = 0`; // fail closed: no scope set -> no rows
  const shares = scope.shares ?? [];
  const denies = scope.denies ?? [];
  // Subtree GRANTS (`<col>.<code>-*.**`) bind identically to per-object shares - both mean "this code and
  // everything under it" - and differ only in where the middleware got them: a share is a per-object row, a
  // subtree is a pattern in the broad grant. They are kept as separate fields on ListScope because they are
  // loaded differently (one costs a read, the other does not), and joined here because the predicate is the
  // same one.
  const widen = [...shares, ...(scope.subtrees ?? [])];

  // Match code C and everything under it (boundary-anchored). Mirrors the engine's isUnder on the item path.
  const subtree = (c: string): SQL => (code ? or(eq(code, c), sql`${code} glob ${`${c}-*`}`)! : sql`1 = 0`);

  // Breadth predicate (undefined = all rows, no filter). `all` needs no column, so it is the one breadth a
  // table without a code or owner column can still answer.
  //
  // `dept` is the SUBTREE of the department, which includes the department's own row - the same `isUnder`
  // the item path decides with (domain/codes.ts), reached here through the same `subtree` helper the shares
  // use. It used to be a bare `LIKE '<dept>-%'`, i.e. descendants ONLY, so the two halves of one rule
  // disagreed about a row whose code IS the dept code: `GET /v1/departments/<dept>` was allowed by the
  // engine while the list that is supposed to contain it left it out. Only `departments` can have such a row
  // (every other collection's codes are `<dept>-<leaf>`), and it does not currently offer the `dept` tier -
  // so this is closing the gap before something reaches it, not fixing a live symptom.
  let base: SQL | undefined;
  if (scope.breadth === "all") base = undefined;
  else if (scope.breadth === "dept") base = scope.deptCode && code ? subtree(scope.deptCode) : sql`1 = 0`;
  else base = scope.ownerId && owner ? eq(owner, scope.ownerId) : sql`1 = 0`; // own

  // OR in per-object shares and subtree grants (each as its subtree). If breadth is 'all' (base undefined)
  // the caller already sees everything, so they add nothing.
  let pred = base;
  if (widen.length && base !== undefined) pred = or(base, ...widen.map(subtree));

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

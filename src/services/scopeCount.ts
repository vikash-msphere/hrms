// How many RECORDS a scope choice actually reaches - the number the ACL's scope chips show ("All 214 · One
// department 12"), which is the cheapest nudge toward least privilege in the whole UI.
//
// A DIFFERENT QUESTION FROM `:preview`, which answers "how many PEOPLE can do this". Breadth over subjects and
// breadth over records are the two halves of what a rule does, and the modal could state only the first.
//
// BOUNDED, NOT `count(*)`. D1 bills rows read, so counting a whole table is the eager read docs/authz.md and the
// list design both refuse - and `attendance`/`notifications`/`payslips` are exactly the tables where the chip
// matters and the table is largest. So the count stops at CAP and reports `capped: true`, which the UI renders
// as "500+". A reader deciding between org-wide and one department does not need the exact figure; they need to
// see that one is two orders of magnitude bigger than the other, and "500+" says that for the price of 501 rows.
import { and, sql, type SQL } from "drizzle-orm";
import { applyScope } from "./listScope";
import { deleteStateFilter } from "./softDelete";
import { TABLES, listOwnerColumn, uuidToCode } from "../lib/authzResolve";
import type { Deps } from "../deps";
import { invalidArgument } from "../lib/errors";

/** Rows read per count. 501 so the UI can say "500+" without a second query. */
export const SCOPE_COUNT_CAP = 500;

export type ScopeCountBody = { collection?: string; department?: string | null };

export type ScopeCount = { count: number; capped: boolean };
export type ScopeCounts = {
  collection: string;
  /** Org-wide: every record in the collection. */
  all: ScopeCount;
  /**
   * The chosen department's subtree. Absent when no department was named, and when the collection's rows carry
   * no code to match a department against (a flat catalogue) - in which case the tier reaches nothing and a
   * figure of 0 would read as "this department has none" rather than "this scope does not apply here".
   */
  named_dept?: ScopeCount;
};

/**
 * Count the rows a predicate selects, stopping at the cap.
 *
 * `SELECT count(*) FROM (SELECT 1 FROM t WHERE ... LIMIT cap+1)` - the subquery is what bounds the read; a bare
 * `count(*)` with a LIMIT would apply the limit to the single result ROW and read the whole table anyway.
 */
async function cappedCount(deps: Deps, table: any, where: SQL | undefined): Promise<ScopeCount> {
  const inner = deps.db.select({ one: sql`1` }).from(table).where(where).limit(SCOPE_COUNT_CAP + 1);
  const rows = (await deps.db.select({ n: sql<number>`count(*)` }).from(inner.as("capped")))[0];
  const n = Number(rows?.n ?? 0);
  return n > SCOPE_COUNT_CAP ? { count: SCOPE_COUNT_CAP, capped: true } : { count: n, capped: false };
}

/**
 * The record counts for a collection's grantable scopes.
 *
 * ONLY THE TIERS THAT HAVE A WELL-DEFINED NUMBER. `all` and a NAMED department do: they mean the same set of
 * records for everyone. `self` and `dept` are subject-RELATIVE - they mean something different for every holder
 * of the rule - so they are deliberately absent here and the chips keep saying what they mean in words. A figure
 * computed against whoever happens to be authoring the rule would describe the author, not the rule, and a
 * fabricated number on a least-privilege prompt is worse than no number at all.
 */
export async function scopeCounts(deps: Deps, body: ScopeCountBody): Promise<ScopeCounts> {
  const collection = body.collection?.trim();
  if (!collection) throw invalidArgument("collection is required");
  const table = TABLES[collection];
  if (!table) throw invalidArgument(`unknown collection "${collection}"`);

  // Matches what a LIST would return: the trash is excluded, exactly as the default list does, so the chip and
  // the grid a reader opens next agree. A table with no `delete_time` column simply has no filter.
  const live = table.deleteTime ? deleteStateFilter(table.deleteTime, false, false) : undefined;
  const code = table.code;
  const owner = listOwnerColumn(collection, table);
  const scoped = (breadth: "all" | "dept", deptCode: string | null) =>
    and(live, applyScope({ breadth, deptCode, ownerId: null, seeRestricted: true, subtrees: [] }, code, owner));

  const out: ScopeCounts = { collection, all: await cappedCount(deps, table, scoped("all", null)) };

  const deptId = body.department?.split("/").pop();
  if (deptId && code) {
    const deptCode = await uuidToCode(deps, "departments", deptId);
    // An unresolved department is the caller naming one that is gone; answering 0 would read as "it is empty".
    if (!deptCode) throw invalidArgument("department not found");
    out.named_dept = await cappedCount(deps, table, scoped("dept", deptCode));
  }
  return out;
}

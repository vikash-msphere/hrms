// Generic soft-delete helpers shared by every CRUD resource (logic stays in the
// service layer, not in routes). A resource is "soft-deletable" if its table has a
// `deleteTime` column. List filtering hides soft-deleted rows unless showDeleted.
import { and, eq } from "drizzle-orm";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, removedMeta } from "../lib/audit";
import { notFound, aborted, failedPrecondition, isForeignKeyViolation } from "../lib/errors";
import { etagOf } from "../http/serialize";
import { assertNotLocked } from "./lockGuard";

// Drizzle tables are heavily generic; we treat them structurally here.
type Table = any;
type Row = { uuid: string; updatedAt: Date | number; deleteTime?: Date | number | null; locked?: boolean | null; [k: string]: unknown };

/**
 * What a hard purge takes with it, declared once beside the collection rather than open-coded per service.
 *
 * A purge is a real SQL DELETE, and every table that references the row is a foreign key SQLite will refuse
 * the delete over. There are exactly two honest answers to such a reference, and the difference is ownership:
 *
 *  - `remove`: rows that exist only AS PART of this one - a post's reads, reactions, replies, poll options and
 *    votes. They are unreachable once the parent is gone, so they go with it. Listed PARENT-FIRST within the
 *    group where children reference each other (a reaction points at a reply), because the deletes run in the
 *    order given.
 *  - `detach`: a column that merely POINTS at this row from a record with a life of its own - the goal a task
 *    card is linked to, the parent an aligned goal hangs under. Cleared to null so the pointer does not
 *    outlive its target, and the referencing record survives.
 *
 * Anything NOT declared here still blocks the purge, which is the point: an employee with payslips is a row
 * the org may not quietly erase, and that now answers 409 with a reason instead of the 500 it used to.
 */
export type PurgeCascade = {
  remove?: { table: Table; column: Table }[];
  detach?: { table: Table; column: Table }[];
};

/**
 * The TypeScript property a column is reachable under on its table (`cards.goalId`, not `"goal_id"`).
 *
 * `update().set()` is keyed by the drizzle property name while a `PurgeCascade` entry carries the column
 * OBJECT - which is what makes the declaration compile-checked against the schema instead of a string nobody
 * would notice going stale. The table exposes its columns as own properties under exactly those names, so the
 * identity match recovers the key without a second thing to keep in sync.
 */
function columnKey(table: Table, column: Table): string {
  const hit = Object.keys(table).find((k) => table[k] === column);
  if (!hit) throw new Error("purge cascade: column does not belong to the table it was declared with");
  return hit;
}

async function fetchRow(deps: Deps, table: Table, id: string): Promise<Row | undefined> {
  const rows = (await deps.db.select().from(table).where(eq(table.uuid, id)).limit(1)) as Row[];
  return rows[0];
}

function checkEtag(row: Row, ifMatch?: string) {
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
}

/**
 * The version half of every guarded write below: `uuid = ? AND updated_at = <what we read>`.
 *
 * Comparing `ifMatch` against the row we just read (checkEtag) is a read-then-write race, not optimistic
 * concurrency - two callers holding the same ETag both pass it and both write. The version has to be in the
 * WHERE so the DB is the one that decides whether the write still applies. Applies with or without an
 * If-Match header: a caller who sent none asked not to be bothered about a stale read, not to be allowed to
 * delete a row somebody else had just changed.
 */
const atVersion = (table: Table, row: Row) => and(eq(table.uuid, row.uuid), eq(table.updatedAt, new Date(row.updatedAt)));

/** Raised when the guarded write matched nothing: the row moved (409) or is now gone (404). One read, conflict path only. */
async function versionConflict(deps: Deps, table: Table, singular: string, id: string): Promise<never> {
  const still = (await deps.db.select({ uuid: table.uuid }).from(table).where(eq(table.uuid, id)).limit(1))[0];
  if (!still) throw notFound(`${singular} not found`);
  throw aborted("the record changed since it was read; re-read it and try again");
}

/** Filter helper for list services: drop soft-deleted rows unless showDeleted. */
export function visibleByDelete<T extends { deleteTime?: Date | number | null }>(rows: T[], showDeleted: boolean): T[] {
  return showDeleted ? rows : rows.filter((r) => !r.deleteTime);
}

/** Mark a row deleted (idempotent guard: already-deleted -> 404). */
export async function softDeleteRow(
  deps: Deps,
  actor: AppUser,
  table: Table,
  singular: string,
  collection: string,
  id: string,
  ifMatch?: string,
) {
  const row = await fetchRow(deps, table, id);
  if (!row || row.deleteTime) throw notFound(`${singular} not found`);
  checkEtag(row, ifMatch);
  assertNotLocked(row);
  const marked = await deps.db
    .update(table)
    .set({ deleteTime: new Date(), updatedAt: new Date() })
    .where(atVersion(table, row))
    .returning({ uuid: table.uuid });
  if (!marked.length) await versionConflict(deps, table, singular, id);
  // What was removed. A soft delete is recoverable from the row itself, but a PURGE is not, and neither is
  // readable from a trail that records only that something went.
  await audit(deps, actor, `${singular}.delete`, collection, id, removedMeta(row, collection), row);
}

/** Restore a soft-deleted row (only meaningful if currently deleted). */
export async function restoreRow(
  deps: Deps,
  actor: AppUser,
  table: Table,
  singular: string,
  collection: string,
  id: string,
) {
  const row = await fetchRow(deps, table, id);
  if (!row) throw notFound(`${singular} not found`);
  if (!row.deleteTime) throw aborted(`${singular} is not deleted`);
  // Guarded like the others, which also makes restore idempotent under concurrency: of two simultaneous
  // restores only one matches the deleted version, so the loser gets a 409 instead of both reporting success
  // for a row only one of them actually revived.
  const updated = ((await deps.db
    .update(table)
    .set({ deleteTime: null, updatedAt: new Date() })
    .where(atVersion(table, row))
    .returning()) as Row[])[0];
  if (!updated) await versionConflict(deps, table, singular, id);
  // No meta: a restore puts the row back exactly as the matching delete entry recorded it, so the values live
  // there and repeating them here would only invite the two to disagree.
  await audit(deps, actor, `${singular}.restore`, collection, id, undefined, updated);
  return updated;
}

/** Permanently remove a row (super_admin only - enforced at the route). `onPurge`
 *  runs side effects like deleting an R2 object before the DB row is removed. */
export async function purgeRow(
  deps: Deps,
  actor: AppUser,
  table: Table,
  singular: string,
  collection: string,
  id: string,
  ifMatch?: string,
  onPurge?: (row: Row) => Promise<void>,
  cascade?: PurgeCascade,
) {
  const row = await fetchRow(deps, table, id);
  if (!row) throw notFound(`${singular} not found`);
  checkEtag(row, ifMatch);
  assertNotLocked(row);
  // Side effects BEFORE the guarded delete, so an R2 object is never orphaned by a row that then refused to
  // go. The cost of the reverse order on a lost race is a deleted blob whose row is still live - unrecoverable
  // - against an orphaned blob, which is reclaimable.
  if (onPurge) await onPurge(row);
  // Then the declared teardown, in the same bottom-up order the hand-written purges use: clear the pointers
  // that are only pointers, delete the rows that are part of this one, and only then the row itself.
  for (const { table: t, column } of cascade?.detach ?? []) {
    // `updated_at` moves with the clearing, because it IS a change to that record: its etag has to stop
    // matching, or a client holding the pre-detach read would go on offering an If-Match that still passes.
    const set: Record<string, unknown> = { [columnKey(t, column)]: null };
    if (t.updatedAt) set.updatedAt = new Date();
    await deps.db.update(t).set(set).where(eq(column, id));
  }
  for (const { table: t, column } of cascade?.remove ?? []) await deps.db.delete(t).where(eq(column, id));
  let purged: { uuid: string }[];
  try {
    purged = await deps.db.delete(table).where(atVersion(table, row)).returning({ uuid: table.uuid });
  } catch (e) {
    // Something the row does not own still references it. That is a precondition the caller can act on, so it
    // answers 409 with the reason rather than surfacing as an unhandled 500 with a SQL string in the log.
    if (isForeignKeyViolation(e)) throw failedPrecondition(`this ${singular} is still referenced by other records and cannot be permanently deleted`);
    throw e;
  }
  if (!purged.length) await versionConflict(deps, table, singular, id);
  // The row is gone for good after this, so its values survive only here.
  await audit(deps, actor, `${singular}.purge`, collection, id, removedMeta(row, collection), row);
}

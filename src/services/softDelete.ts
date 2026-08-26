// Generic soft-delete helpers shared by every CRUD resource (logic stays in the
// service layer, not in routes). A resource is "soft-deletable" if its table has a
// `deleteTime` column. List filtering hides soft-deleted rows unless showDeleted.
import { and, eq } from "drizzle-orm";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { notFound, aborted } from "../lib/errors";
import { etagOf } from "../http/serialize";
import { assertNotLocked } from "./lockGuard";

// Drizzle tables are heavily generic; we treat them structurally here.
type Table = any;
type Row = { uuid: string; updatedAt: Date | number; deleteTime?: Date | number | null; locked?: boolean | null; [k: string]: unknown };

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
  await audit(deps, actor, `${singular}.delete`, collection, id, undefined, row);
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
) {
  const row = await fetchRow(deps, table, id);
  if (!row) throw notFound(`${singular} not found`);
  checkEtag(row, ifMatch);
  assertNotLocked(row);
  // Side effects BEFORE the guarded delete, so an R2 object is never orphaned by a row that then refused to
  // go. The cost of the reverse order on a lost race is a deleted blob whose row is still live - unrecoverable
  // - against an orphaned blob, which is reclaimable.
  if (onPurge) await onPurge(row);
  const purged = await deps.db.delete(table).where(atVersion(table, row)).returning({ uuid: table.uuid });
  if (!purged.length) await versionConflict(deps, table, singular, id);
  await audit(deps, actor, `${singular}.purge`, collection, id, undefined, row);
}

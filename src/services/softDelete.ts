// Generic soft-delete helpers shared by every CRUD resource (logic stays in the
// service layer, not in routes). A resource is "soft-deletable" if its table has a
// `deleteTime` column. List filtering hides soft-deleted rows unless showDeleted.
import { eq } from "drizzle-orm";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { notFound, aborted } from "../lib/errors";
import { etagOf } from "../http/serialize";
import { assertNotLocked } from "./lifecycle";

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
  await deps.db.update(table).set({ deleteTime: new Date(), updatedAt: new Date() }).where(eq(table.uuid, id));
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
  const updated = ((await deps.db
    .update(table)
    .set({ deleteTime: null, updatedAt: new Date() })
    .where(eq(table.uuid, id))
    .returning()) as Row[])[0];
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
  if (onPurge) await onPurge(row);
  await deps.db.delete(table).where(eq(table.uuid, id));
  await audit(deps, actor, `${singular}.purge`, collection, id, undefined, row);
}

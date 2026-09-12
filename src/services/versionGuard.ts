// Optimistic concurrency, as ONE implementation.
//
// Every editable row in the app carries an ETag derived from `updated_at` (http/serialize.ts etagOf), and the
// SPA sends it back as `If-Match` on every PATCH (web/src/api.ts) with a message ready for the conflict. That
// promise was kept in two places and broken in about thirty: services/crud.ts (the collection factory's
// generic update) and services/softDelete.ts both put the version in the WHERE, while every hand-written
// `overrides.update` did this instead -
//
//     if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
//     ... build `set` ...
//     await deps.db.update(t).set(set).where(eq(t.uuid, id));
//
// - which is a read-then-write race wearing the clothes of optimistic concurrency. Two callers holding the
// same ETag both pass the comparison, both write, both get 200, and the first one's change is gone with
// nothing anywhere saying so. crud.ts has said exactly this in a comment since it was written; the bespoke
// services simply never adopted it, and they include `users` (role and status) and `employees`, which are the
// two most privilege-bearing rows there are.
//
// WHAT IT DOES NOT COVER, stated because the comment this was factored out of overstates it: `updated_at` has
// millisecond granularity and the Workers runtime freezes `Date.now()` between I/O, so two writes inside one
// tick can stamp the SAME version. Two callers that both land on it are then indistinguishable to the WHERE
// exactly as they were to the comparison. That is a limit of the version's resolution, not of where it is
// checked - the difference this makes is for every race whose writes DO land on different versions, which is
// all of them that are separated by any I/O at all.
//
// THE GUARD APPLIES WITH OR WITHOUT AN If-Match. Sending none is a request not to be bothered about a stale
// read; it is not permission to overwrite a change you never saw.
import { and, eq } from "drizzle-orm";
import type { Deps } from "../deps";
import { aborted, notFound } from "../lib/errors";
import { etagOf } from "../http/serialize";

// Drizzle tables are heavily generic; they are treated structurally here exactly as services/softDelete.ts
// does, so the helpers stay usable from every hand-written service without a type gymnastics tax.
type Table = any;
export type VersionedRow = { uuid: string; updatedAt: Date | number; [k: string]: unknown };

/** Refuse a caller whose `If-Match` already disagrees with the row we just read. Cheap, and it gives the
 *  common case the precise error; `updateAtVersion` below is what makes the guarantee true under a race. */
export function checkEtag(row: VersionedRow, ifMatch?: string): void {
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
}

/** `uuid = ? AND updated_at = <the version we read>` - the version half of a guarded write. */
export const atVersion = (table: Table, row: VersionedRow) => and(eq(table.uuid, row.uuid), eq(table.updatedAt, new Date(row.updatedAt)));

/**
 * The guarded write matched nothing, and the two reasons are different answers: the row was hard-purged
 * between the read and the write (404 - it is gone, retrying will not help), or its version moved under us
 * (409 - it is there, re-read and re-apply). One extra read, on the conflict path only, buys the honest
 * status code instead of collapsing both into a guess.
 */
export async function versionConflict(deps: Deps, table: Table, singular: string, id: string): Promise<never> {
  const still = (await deps.db.select({ uuid: table.uuid }).from(table).where(eq(table.uuid, id)).limit(1))[0];
  if (!still) throw notFound(`${singular} not found`);
  throw aborted("the record changed since it was read; re-read it and try again");
}

/**
 * Apply `set` to `row` only if nobody else has written it since it was read, and hand back the updated row.
 *
 * Drop-in for the `(await deps.db.update(t).set(set).where(eq(t.uuid, id)).returning())[0]!` that every
 * bespoke update used to end with - including the non-null assertion, which was itself a small bug: a row
 * purged between the read and the write made that `[0]!` an undefined the caller then read fields off, i.e. a
 * 500 for what is a 404.
 */
export async function updateAtVersion<R extends VersionedRow>(
  deps: Deps,
  table: Table,
  singular: string,
  row: R,
  set: Record<string, unknown>,
): Promise<R> {
  const rows = (await deps.db.update(table).set(set).where(atVersion(table, row)).returning()) as R[];
  const updated = rows[0];
  if (!updated) await versionConflict(deps, table, singular, row.uuid);
  return updated!;
}

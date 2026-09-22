// Generic soft-delete helpers shared by every CRUD resource (logic stays in the
// service layer, not in routes). A resource is "soft-deletable" if its table has a
// `deleteTime` column. List filtering hides soft-deleted rows unless showDeleted.
import { and, eq, isNull, isNotNull, type SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, removedMeta } from "../lib/audit";
import { runBatchChecked, type BatchStmt, type CheckedStmt } from "../lib/dbBatch";
import { notFound, aborted, failedPrecondition, isForeignKeyViolation } from "../lib/errors";
import { assertNotLocked } from "./lockGuard";
import { atVersion, checkEtag, versionConflict } from "./versionGuard";

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
 *
 * `first` is the escape hatch for a GRANDCHILD, which the (table, column) shape cannot express because every
 * entry above matches `column = <the purged id>`: a review's feedback hangs off the REVIEW, not off the cycle
 * being purged, and a card's comments hang off the CARD, not off the board. Those used to be swept by the
 * caller with its own awaited statements before calling in here, which put them outside the transaction and
 * reintroduced the very failure this batch exists to prevent - the sweep committed, the purge then refused,
 * and a 409 had already destroyed every review of the cycle. Pass them here instead, as UNEXECUTED drizzle
 * builders (the caller may read first to find the ids), and they run at the head of the same batch.
 */
export type PurgeCascade = {
  first?: BatchStmt[];
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

// `atVersion`, `checkEtag` and `versionConflict` come from services/versionGuard.ts. They used to live here,
// privately, which is how the thirty hand-written updates across the services came to have no guard at all:
// the only thing that could reach them was this file. One implementation, importable, is the fix for that.

/** Filter helper for list services: drop soft-deleted rows unless showDeleted. */
export function visibleByDelete<T extends { deleteTime?: Date | number | null }>(rows: T[], showDeleted: boolean): T[] {
  return showDeleted ? rows : rows.filter((r) => !r.deleteTime);
}

/**
 * The delete-state condition every list binds, as ONE implementation.
 *
 * `deletedOnly` is a SEPARATE flag from `showDeleted`, and http/collectionRoute.ts says why in as many words:
 * a "Deleted" view is its own fetch rather than a client-side filter over a page of mostly-live rows - which
 * on any list longer than one page would show an empty trash while the deleted rows sat past the cursor. The
 * generic lane (services/crud.ts) has always bound both; the bespoke `list` hooks each re-derived the pair by
 * hand, and between them dropped `deletedOnly` fifteen times and `showDeleted` once, so `?deleted_only=true`
 * answered with live rows mixed in - precisely the page the flag was invented to avoid.
 *
 * Returns `undefined` when no condition is needed (`showDeleted` with no `deletedOnly`), so callers can push
 * it straight into their `conds` array.
 */
export function deleteStateFilter(deleteTimeColumn: unknown, showDeleted?: boolean, deletedOnly?: boolean): SQL | undefined {
  const col = deleteTimeColumn as never;
  if (deletedOnly) return isNotNull(col);
  if (!showDeleted) return isNull(col);
  return undefined;
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

/**
 * Permanently remove a row (super_admin only - enforced at the route).
 *
 * `onPurge` is the escape hatch for a side effect this function cannot know about, run AFTER the row is gone
 * (see the note at the call). It is not how attachments are cleaned up: every `attachments` row and R2 object
 * belonging to the purged record is swept here, generically, because the key is `(collection, object_id)` and
 * both halves are already in hand - see the note by the read below.
 */
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
  // The declared teardown, in the same bottom-up order the hand-written purges use: clear the pointers
  // that are only pointers, delete the rows that are part of this one, and only then the row itself.
  //
  // ALL OF IT IN ONE BATCH, which D1 runs as a single implicit transaction (lib/dbBatch.ts), because the
  // teardown can legitimately FAIL AT THE LAST STATEMENT. Run one statement at a time, the children were
  // already committed by then and nothing puts them back: something UNDECLARED still referencing the row
  // makes the final DELETE a foreign-key violation, and the caller was answered 409 "still referenced" -
  // which reads as "nothing happened" - over a goal whose comments, watchers and contributors had just been
  // destroyed for good. That is not a rare race; an incomplete `purgeCascade` reproduces it every time (the
  // goals declaration was missing two of its seven foreign keys). Batched, the violation aborts the group and
  // the children are still there.
  //
  // The one case the batch cannot undo is the guarded delete matching ZERO rows - a concurrent write between
  // the read above and this write. SQL does not treat that as an error, so the group commits without the row
  // going. It stays guarded anyway (see atVersion): losing that race is a 409 the caller retries, and the
  // window is the microseconds between two statements of one request against a super-admin hard purge.
  // THE OTHER FK-LESS POINTER AT THIS ROW, and it had no sweeper at all. `attachments` is keyed
  // `(collection, object_id)` with `object_id` a bare `text().notNull()` and no `.references()`, exactly like
  // `access_rules.match_code` below - so SQLite never refuses a purge over an attachment, the DELETE succeeds,
  // and test/purgeCascadeDrift (which holds each declaration against the schema's own foreign keys) cannot see
  // the pointer either. `purgeRow` takes an `onPurge` hook documented for precisely this ("runs side effects
  // like deleting an R2 object"), and services/crud.ts passes `undefined` at the only place a factory
  // collection's purge is built - so nothing was calling it.
  //
  // What survived a `DELETE /v1/candidates/<id>?force` was the encrypted object in R2, forever, and the
  // `attachments` row naming it - and that row carries `file_name`, which for a resume is routinely the
  // person's name. Seven soft-deletable collections write here (candidates, referrals, leave-requests,
  // reimbursements, expenses, tax-declarations and employees' identity scans), and a hard purge is the
  // operation reached for to honour an erasure request, which made it the one operation that left the
  // document behind.
  //
  // Done GENERICALLY here rather than as a declaration per collection, the way the access-rules cleanup above
  // already is: `purgeRow` holds both halves of the key, so there is no per-collection decision to get wrong
  // and nothing for the eighth attachment-bearing collection to remember.
  const attached = await deps.db
    .select({ r2Key: schema.attachments.r2Key })
    .from(schema.attachments)
    .where(and(eq(schema.attachments.collection, collection), eq(schema.attachments.objectId, id)));

  const stmts: (BatchStmt | CheckedStmt)[] = [...(cascade?.first ?? [])];
  for (const { table: t, column } of cascade?.detach ?? []) {
    // `updated_at` moves with the clearing, because it IS a change to that record: its etag has to stop
    // matching, or a client holding the pre-detach read would go on offering an If-Match that still passes.
    const set: Record<string, unknown> = { [columnKey(t, column)]: null };
    if (t.updatedAt) set.updatedAt = new Date();
    stmts.push(deps.db.update(t).set(set).where(eq(column, id)));
  }
  for (const { table: t, column } of cascade?.remove ?? []) stmts.push(deps.db.delete(t).where(eq(column, id)));
  // The per-object access rules that named THIS row, which no `PurgeCascade` entry can express: `access_rules`
  // points at an object by its `code`, not by a foreign key, so SQLite never refuses the purge over one and
  // nothing was ever removing them. They outlived their target silently - rendered in the ACL surface as an
  // entry whose object no longer resolves (services/accessRules.ts `_objectUuid` comes back null), and decided
  // nothing, which is why it stayed invisible.
  //
  // EXACT RULES ONLY - `match_code` is set only for `scopeKind: "exact"` (accessRules.ts), so this is precisely
  // the rule that named this one object. A SUBTREE rule (`scope_code` set, `match_code` null) is deliberately
  // left alone: it is a scope an admin declared over a branch of the hierarchy, it may well name a code in
  // another collection's namespace, and with codes no longer recycled (services/codeAlloc.ts) it can never
  // re-bind to a different object - so removing it would be destroying a grant, not tidying a dangling one.
  //
  // Scoped to this collection's namespace because a code is only unique WITHIN a table: a flat catalogue's
  // `01` and a top-level department's `01` are the same string and different objects.
  const purgedCode = typeof row.code === "string" ? row.code : null;
  if (purgedCode) {
    stmts.push(
      deps.db.delete(schema.accessRules).where(and(eq(schema.accessRules.namespace, collection), eq(schema.accessRules.matchCode, purgedCode))),
    );
  }
  // The metadata rows go inside the batch (so a refused purge leaves them exactly where they were); the R2
  // objects they name are deleted AFTER it commits, for the reason the note below the batch spells out.
  if (attached.length) {
    stmts.push(deps.db.delete(schema.attachments).where(and(eq(schema.attachments.collection, collection), eq(schema.attachments.objectId, id))));
  }
  // THE SAME BUG, TWO TABLES FURTHER ON. `ai_suggestions` is keyed `(host_collection, host_record_id)` and
  // `moderation_scans` `(collection, record_id)`, both halves bare `text().notNull()` with no `.references()`
  // - so SQLite never refuses a purge over one, and `test/purgeCascadeDrift` enumerates `cfg.foreignKeys`
  // and cannot see the pointer either. Exactly the shape the attachments note above describes.
  //
  // WHAT SURVIVED `DELETE /v1/<collection>/<id>?force`, in `payload_json`: a candidate's name, email, phone,
  // current employer, job title, years of experience and summary transcribed from their CV; a 400-character
  // excerpt of a moderated post with its hazard codes and anonymity flag; a receipt's vendor, invoice number,
  // amounts and date; the subjects and titles of neighbouring tickets and cards. `candidates` is the
  // collection behind `CONSENTED_PATHS["ats.resumeExtraction"]`, whose stated lawful basis is that the
  // candidate submitted the document FOR THIS PURPOSE - a basis that does not survive the record being
  // erased while the extraction stays.
  //
  // `ai_usage` goes with them: its `subject` is the same `<collection>/<uuid>` string, and the row pairs it
  // with the user who caused the call. `moderation_scans` holds only a hash and matters least; it is in the
  // same sweep for the same reason. All three are generic here, like the attachments one above, so there is
  // no per-collection declaration for the next collection to forget.
  stmts.push(deps.db.delete(schema.aiSuggestions).where(and(eq(schema.aiSuggestions.hostCollection, collection), eq(schema.aiSuggestions.hostRecordId, id))));
  stmts.push(deps.db.delete(schema.moderationScans).where(and(eq(schema.moderationScans.collection, collection), eq(schema.moderationScans.recordId, id))));
  stmts.push(deps.db.delete(schema.aiUsage).where(eq(schema.aiUsage.subject, `${collection}/${id}`)));
  stmts.push({ stmt: deps.db.delete(table).where(atVersion(table, row)).returning({ uuid: table.uuid }), expect: 1, label: "purge" });
  let short: string[];
  try {
    short = await runBatchChecked(deps.db, stmts);
  } catch (e) {
    // Something the row does not own still references it. That is a precondition the caller can act on, so it
    // answers 409 with the reason rather than surfacing as an unhandled 500 with a SQL string in the log.
    if (isForeignKeyViolation(e)) throw failedPrecondition(`this ${singular} is still referenced by other records and cannot be permanently deleted`);
    throw e;
  }
  if (short.length) await versionConflict(deps, table, singular, id);
  // The irreversible side effect (deleting the document's R2 object) runs only once the row is actually gone.
  //
  // It used to run FIRST, on the reasoning that a blob must never be orphaned by a row that then refused to
  // go - but that trades the recoverable failure for the unrecoverable one, and the comment saying so sat
  // directly above the code doing the opposite. A purge CAN be refused at the last statement (an undeclared
  // foreign key, a lost version race), and with the blob already deleted the caller was left holding a live
  // document row, listed and downloadable in the UI, whose file no longer existed - and no way back. In this
  // order the same failure leaves an object in R2 that nothing points at, which costs storage and can be
  // swept. Not awaited into the audit either way: the row is gone, and a failed blob delete must not turn a
  // completed purge into an error.
  if (onPurge) {
    try {
      await onPurge(row);
    } catch (e) {
      console.error(`[purge] ${collection}/${id}: the row is gone but its stored object was not deleted (orphaned, reclaimable)`, e);
    }
  }
  // The stored objects, in the same order and for the same reason: the metadata rows are already gone, so a
  // failure here leaves an object nothing points at (reclaimable) rather than a row pointing at nothing.
  //
  // `photoKey` / `signatureKey` are the only stored objects that hang off a COLUMN rather than off the
  // `attachments` table - services/employeePhoto.ts deletes them when the field is cleared, and nothing
  // deleted them when the row went. Read structurally (the helper is generic over every table), which costs
  // nothing on the tables that have neither.
  const storedKeys = [...attached.map((a) => a.r2Key), ...["photoKey", "signatureKey"].map((k) => row[k]).filter((v): v is string => typeof v === "string" && !!v)];
  for (const key of storedKeys) {
    try {
      await deps.docs.delete(key);
    } catch (e) {
      console.error(`[purge] ${collection}/${id}: the row is gone but stored object "${key}" was not deleted (orphaned, reclaimable)`, e);
    }
  }
  // The row is gone for good after this, so its values survive only here.
  await audit(deps, actor, `${singular}.purge`, collection, id, removedMeta(row, collection), row);
}

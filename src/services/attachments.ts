// Generic encrypted file attachments, reached THROUGH a parent resource's routes (so access inherits the
// parent's gating - this is NOT a directly-addressable collection). One file per (collection, object_id,
// slot); uploading the same slot overwrites. Bytes are encrypted in R2 by the docstore wrapper.
import { and, eq, inArray, type SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { byIdChunks } from "../lib/dbBatch";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { invalidArgument, notFound } from "../lib/errors";
import { genId } from "../lib/idCodec";
import { contentDisposition } from "../http/contentDisposition";
import { documentFileName, isAllowedUpload, storedContentType } from "./documentsCommon";
import { getSettingValue } from "./settings";

const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

// Configurable upload cap (bytes). On free-tier Workers the encrypt CPU scales with size, so this can be
// lowered without a deploy if needed (settings/attachments -> { max_upload_bytes }).
export async function maxUploadBytes(deps: Deps): Promise<number> {
  const v = await getSettingValue<{ max_upload_bytes?: number }>(deps, "attachments", {});
  return typeof v.max_upload_bytes === "number" && v.max_upload_bytes > 0 ? v.max_upload_bytes : DEFAULT_MAX_UPLOAD_BYTES;
}

export async function getAttachment(deps: Deps, collection: string, objectId: string, slot = "") {
  return (await deps.db
    .select()
    .from(schema.attachments)
    .where(and(eq(schema.attachments.collection, collection), eq(schema.attachments.objectId, objectId), eq(schema.attachments.slot, slot)))
    .limit(1))[0];
}

export async function getAttachmentsFor(deps: Deps, collection: string, objectId: string) {
  return deps.db
    .select()
    .from(schema.attachments)
    .where(and(eq(schema.attachments.collection, collection), eq(schema.attachments.objectId, objectId)));
}

// Object ids in `collection` that have a file in `slot` - one query, for list serialization (has_receipt).
//
// CHUNKED, because the caller is a list `decorate` hook and a list page is UP TO 100 ROWS.
//
// `inArray` spends one bound parameter per id and D1 admits 100 per statement (lib/dbBatch.ts PARAM_CAP), and
// the two equalities above the IN take two of them - so this overflowed at 99 ids with
// `D1_ERROR: too many SQL variables`, uncaught, a 500 on the whole list. Six collections decorate through here
// (reimbursements, expenses, leave-requests, candidates, referrals, tax-declarations) and the SPA asks every
// list for `max_page_size=100` by default (web/src/api.ts), so each of those six pages was a hard failure from
// the moment the org had ninety-nine of the thing - working perfectly on every dataset small enough to develop
// against, and on none large enough to matter. `ID_CHUNK` is 90 for exactly this reason: it leaves the
// headroom the surrounding predicates need.
export async function attachedObjectIds(deps: Deps, collection: string, slot = "", objectIds?: string[]): Promise<Set<string>> {
  // Bounded to the rows being answered when the caller knows them (a page, or one item), so the flag costs one
  // query over one page rather than a scan of every attachment the collection has ever had.
  if (objectIds && objectIds.length === 0) return new Set();
  const scope = and(eq(schema.attachments.collection, collection), eq(schema.attachments.slot, slot));
  const select = (where: SQL | undefined) => deps.db.select({ objectId: schema.attachments.objectId }).from(schema.attachments).where(where);
  const rows = objectIds
    ? await byIdChunks(objectIds, (group) => select(and(scope, inArray(schema.attachments.objectId, group))))
    : await select(scope);
  return new Set(rows.map((r) => r.objectId));
}

// Store (or overwrite) the file in a slot. Size + type are validated BEFORE the encrypt/R2 write.
export async function putAttachment(
  deps: Deps,
  actor: AppUser,
  args: { collection: string; objectId: string; slot?: string; bytes: Uint8Array; fileName?: string | null; contentType?: string | null },
) {
  const slot = args.slot ?? "";
  if (!isAllowedUpload(args.fileName ?? undefined, args.contentType ?? undefined)) throw invalidArgument("file type not allowed");
  const max = await maxUploadBytes(deps);
  if (args.bytes.byteLength > max) throw invalidArgument(`file exceeds the ${Math.round(max / 1048576)} MB upload limit`);

  // What the server is willing to CLAIM these bytes are, which is not the same question as whether it will
  // keep them (see storedContentType). Every download route below echoes this column straight into the
  // response's `Content-Type`, so the raw `?content_type=` the caller sent must not be what lands in it.
  const contentType = storedContentType(args.contentType);

  const existing = await getAttachment(deps, args.collection, args.objectId, slot);
  const uuid = existing?.uuid ?? genId();
  const r2Key = existing?.r2Key ?? `attachments/${args.collection}/${args.objectId}/${uuid}`;
  await deps.docs.put(r2Key, args.bytes, contentType); // encrypted by the docstore wrapper
  const meta = { fileName: args.fileName ?? null, contentType, sizeBytes: args.bytes.byteLength, uploadedBy: actor.uuid };
  if (existing) {
    await deps.db.update(schema.attachments).set({ ...meta, updatedAt: new Date() }).where(eq(schema.attachments.uuid, uuid));
  } else {
    await deps.db.insert(schema.attachments).values({ uuid, collection: args.collection, objectId: args.objectId, slot, r2Key, ...meta });
  }
  await audit(deps, actor, "attachment.upload", args.collection, args.objectId, { slot });
  return (await getAttachment(deps, args.collection, args.objectId, slot))!;
}

export async function downloadAttachment(deps: Deps, collection: string, objectId: string, slot = "") {
  const row = await getAttachment(deps, collection, objectId, slot);
  if (!row) throw notFound("attachment not found");
  const bytes = await deps.docs.get(row.r2Key);
  if (!bytes) throw notFound("attachment not found");
  return { bytes, row };
}

/**
 * The `Content-Disposition` header for an attachment download.
 *
 * THE NAME IS NOT OPTIONAL, which is what every route here used to treat it as. Seven of them answered with a
 * bare `Content-Disposition: attachment` - no filename at all - while the row they had just read carries the
 * one the uploader gave it. With no name in the header a browser falls back to the request URL's last segment,
 * which for a custom method is `<wire token>:downloadReceipt`: an extensionless file, named after a token, that
 * the operating system has no idea how to open. The SPA papered over half of it by passing its own name to
 * `download()` - and those are extensionless too (`receipt-<token>`, `proof-<section>`, `resume-<name>`), so a
 * JPEG receipt downloaded as a file nothing would open either way.
 *
 * `fallbackBase` is what the file is called when the row carries no uploaded name (bytes posted by an
 * integration, or an older row): `documentFileName` appends the extension the stored content type implies, so
 * the answer is still something openable rather than "document".
 */
export function attachmentDisposition(row: { fileName?: string | null; contentType?: string | null }, fallbackBase: string): string {
  return contentDisposition("attachment", documentFileName({ ...row, title: fallbackBase }));
}

export async function deleteAttachment(deps: Deps, actor: AppUser, collection: string, objectId: string, slot = "") {
  const row = await getAttachment(deps, collection, objectId, slot);
  if (!row) return;
  await deps.docs.delete(row.r2Key);
  await deps.db.delete(schema.attachments).where(eq(schema.attachments.uuid, row.uuid));
  await audit(deps, actor, "attachment.delete", collection, objectId, { slot });
}

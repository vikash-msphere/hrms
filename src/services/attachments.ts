// Generic encrypted file attachments, reached THROUGH a parent resource's routes (so access inherits the
// parent's gating - this is NOT a directly-addressable collection). One file per (collection, object_id,
// slot); uploading the same slot overwrites. Bytes are encrypted in R2 by the docstore wrapper.
import { and, eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { invalidArgument, notFound } from "../lib/errors";
import { genId } from "../lib/idCodec";
import { isAllowedUpload } from "./documentsCommon";
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
export async function attachedObjectIds(deps: Deps, collection: string, slot = ""): Promise<Set<string>> {
  const rows = await deps.db
    .select({ objectId: schema.attachments.objectId })
    .from(schema.attachments)
    .where(and(eq(schema.attachments.collection, collection), eq(schema.attachments.slot, slot)));
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

  const existing = await getAttachment(deps, args.collection, args.objectId, slot);
  const uuid = existing?.uuid ?? genId();
  const r2Key = existing?.r2Key ?? `attachments/${args.collection}/${args.objectId}/${uuid}`;
  await deps.docs.put(r2Key, args.bytes, args.contentType ?? "application/octet-stream"); // encrypted by the docstore wrapper
  const meta = { fileName: args.fileName ?? null, contentType: args.contentType ?? null, sizeBytes: args.bytes.byteLength, uploadedBy: actor.uuid };
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

export async function deleteAttachment(deps: Deps, actor: AppUser, collection: string, objectId: string, slot = "") {
  const row = await getAttachment(deps, collection, objectId, slot);
  if (!row) return;
  await deps.docs.delete(row.r2Key);
  await deps.db.delete(schema.attachments).where(eq(schema.attachments.uuid, row.uuid));
  await audit(deps, actor, "attachment.delete", collection, objectId, { slot });
}

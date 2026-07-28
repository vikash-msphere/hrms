// Reimbursement categories: a simple org-wide reference collection (mirrors leave-types). Configurable in
// Settings; claims reference one. `requires_receipt` makes a receipt attachment mandatory on those claims.
import { eq } from "drizzle-orm";
import { allocFlatCode } from "./codeAlloc";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, diffMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted } from "../lib/errors";
import { encodeCursor, decodeCursor } from "../http/pagination";
import { etagOf } from "../http/serialize";
import { visibleByDelete, softDeleteRow, restoreRow, purgeRow } from "./softDelete";
import { assertNotLocked } from "./lifecycle";

export type ReimbursementCategoryInput = { display_name?: string; requires_receipt?: boolean };

export async function listReimbursementCategories(deps: Deps, _actor: AppUser, maxPageSize: number, pageToken?: string, showDeleted = false) {
  const all = visibleByDelete(await deps.db.select().from(schema.reimbursementCategories), showDeleted).sort(
    (a, b) => +new Date(a.createdAt) - +new Date(b.createdAt) || a.uuid.localeCompare(b.uuid),
  );
  const cur = decodeCursor(pageToken);
  const start = cur
    ? all.findIndex((e) => +new Date(e.createdAt) > cur.createTimeMs || (+new Date(e.createdAt) === cur.createTimeMs && e.uuid > cur.uid))
    : 0;
  const slice = start < 0 ? [] : all.slice(start, start + maxPageSize);
  const last = slice[slice.length - 1];
  const nextPageToken = start >= 0 && start + maxPageSize < all.length && last ? encodeCursor(+new Date(last.createdAt), last.uuid) : undefined;
  return { items: slice, nextPageToken };
}

export async function getReimbursementCategory(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.reimbursementCategories).where(eq(schema.reimbursementCategories.uuid, id)).limit(1))[0];
  if (!row) throw notFound("reimbursement category not found");
  return row;
}

export async function createReimbursementCategory(deps: Deps, actor: AppUser, input: ReimbursementCategoryInput, id?: string) {
  if (!input.display_name) throw invalidArgument("display_name is required");
  const row = (await deps.db
    .insert(schema.reimbursementCategories)
    .values({
      code: await allocFlatCode(deps, schema.reimbursementCategories),
      ...(id ? { id } : {}),
      name: input.display_name,
      requiresReceipt: input.requires_receipt ?? false,
    })
    .returning())[0]!;
  await audit(deps, actor, "reimbursement_category.create", "reimbursement-categories", row.uuid, undefined, row);
  return row;
}

export async function updateReimbursementCategory(deps: Deps, actor: AppUser, id: string, patch: ReimbursementCategoryInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.reimbursementCategories).where(eq(schema.reimbursementCategories.uuid, id)).limit(1))[0];
  if (!row) throw notFound("reimbursement category not found");
  assertNotLocked(row);
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const has = (k: keyof ReimbursementCategoryInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("display_name")) set.name = patch.display_name;
  if (has("requires_receipt")) set.requiresReceipt = patch.requires_receipt;
  const updated = (await deps.db.update(schema.reimbursementCategories).set(set).where(eq(schema.reimbursementCategories.uuid, id)).returning())[0]!;
  await audit(deps, actor, "reimbursement_category.update", "reimbursement-categories", id, diffMeta(row, updated, set), updated);
  return updated;
}

export async function deleteReimbursementCategory(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await softDeleteRow(deps, actor, schema.reimbursementCategories, "reimbursement_category", "reimbursement-categories", id, ifMatch);
}
export async function restoreReimbursementCategory(deps: Deps, actor: AppUser, id: string) {
  return restoreRow(deps, actor, schema.reimbursementCategories, "reimbursement_category", "reimbursement-categories", id);
}
export async function purgeReimbursementCategory(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await purgeRow(deps, actor, schema.reimbursementCategories, "reimbursement_category", "reimbursement-categories", id, ifMatch);
}

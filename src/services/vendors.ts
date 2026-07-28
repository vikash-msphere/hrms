// Vendor master: who the company pays for operational expenses. Flat reference (soft-delete/disable/lock like
// a category). Expenses optionally reference a vendor; a vendor may carry a default expense category.
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

export type VendorInput = {
  display_name?: string;
  contact_email?: string | null;
  contact_phone?: string | null;
  tax_id?: string | null;
  payment_terms?: string | null;
  bank_details?: string | null;
  default_category?: string | null; // "expense-categories/<id>"
  notes?: string | null;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);

export async function listVendors(deps: Deps, _actor: AppUser, maxPageSize: number, pageToken?: string, showDeleted = false) {
  const all = visibleByDelete(await deps.db.select().from(schema.vendors), showDeleted).sort(
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

export async function getVendor(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.vendors).where(eq(schema.vendors.uuid, id)).limit(1))[0];
  if (!row) throw notFound("vendor not found");
  return row;
}

async function resolveCategory(deps: Deps, path?: string | null): Promise<string | null> {
  if (!path) return null;
  const id = idFromPath(path)!;
  const cat = (await deps.db.select().from(schema.expenseCategories).where(eq(schema.expenseCategories.uuid, id)).limit(1))[0];
  if (!cat || cat.deleteTime) throw invalidArgument("that expense category is unavailable");
  return id;
}

export async function createVendor(deps: Deps, actor: AppUser, input: VendorInput, id?: string) {
  if (!input.display_name) throw invalidArgument("display_name is required");
  const row = (await deps.db
    .insert(schema.vendors)
    .values({
      code: await allocFlatCode(deps, schema.vendors),
      ...(id ? { id } : {}),
      name: input.display_name,
      contactEmail: input.contact_email ?? null,
      contactPhone: input.contact_phone ?? null,
      taxId: input.tax_id ?? null,
      paymentTerms: input.payment_terms ?? null,
      bankDetails: input.bank_details ?? null,
      defaultCategoryId: await resolveCategory(deps, input.default_category),
      notes: input.notes ?? null,
    })
    .returning())[0]!;
  await audit(deps, actor, "vendor.create", "vendors", row.uuid, undefined, row);
  return row;
}

export async function updateVendor(deps: Deps, actor: AppUser, id: string, patch: VendorInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.vendors).where(eq(schema.vendors.uuid, id)).limit(1))[0];
  if (!row) throw notFound("vendor not found");
  assertNotLocked(row);
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const has = (k: keyof VendorInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("display_name")) set.name = patch.display_name;
  if (has("contact_email")) set.contactEmail = patch.contact_email ?? null;
  if (has("contact_phone")) set.contactPhone = patch.contact_phone ?? null;
  if (has("tax_id")) set.taxId = patch.tax_id ?? null;
  if (has("payment_terms")) set.paymentTerms = patch.payment_terms ?? null;
  if (has("bank_details")) set.bankDetails = patch.bank_details ?? null;
  if (has("default_category")) set.defaultCategoryId = await resolveCategory(deps, patch.default_category);
  if (has("notes")) set.notes = patch.notes ?? null;
  const updated = (await deps.db.update(schema.vendors).set(set).where(eq(schema.vendors.uuid, id)).returning())[0]!;
  await audit(deps, actor, "vendor.update", "vendors", id, diffMeta(row, updated, set), updated);
  return updated;
}

export async function deleteVendor(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await softDeleteRow(deps, actor, schema.vendors, "vendor", "vendors", id, ifMatch);
}
export async function restoreVendor(deps: Deps, actor: AppUser, id: string) {
  return restoreRow(deps, actor, schema.vendors, "vendor", "vendors", id);
}
export async function purgeVendor(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await purgeRow(deps, actor, schema.vendors, "vendor", "vendors", id, ifMatch);
}

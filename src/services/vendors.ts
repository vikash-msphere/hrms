// Vendor master: who the company pays for operational expenses. Flat reference (soft-delete/disable/lock like
// a category). Expenses optionally reference a vendor; a vendor may carry a default expense category.
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { invalidArgument } from "../lib/errors";
import { has, type CrudSpec, type SetOf } from "./crud";

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

// A vendor's default category must be a live one: a deleted category would silently stop applying.
async function resolveCategory(deps: Deps, path?: string | null): Promise<string | null> {
  if (!path) return null;
  const id = idFromPath(path)!;
  const cat = (await deps.db.select().from(schema.expenseCategories).where(eq(schema.expenseCategories.uuid, id)).limit(1))[0];
  if (!cat || cat.deleteTime) throw invalidArgument("that expense category is unavailable");
  return id;
}

export const vendorSpec: CrudSpec<VendorInput, typeof schema.vendors> = {
  table: schema.vendors,
  collection: "vendors",
  auditName: "vendor",
  notFound: "vendor not found",
  insert: async (input, deps) => {
    if (!input.display_name) throw invalidArgument("display_name is required");
    return {
      name: input.display_name,
      // Empty string clears, like an omitted field: the SPA sends "" for a text box the user left blank and
      // never puts a null on the wire (web/src/api.ts).
      contactEmail: input.contact_email?.trim() || null,
      contactPhone: input.contact_phone?.trim() || null,
      taxId: input.tax_id?.trim() || null,
      paymentTerms: input.payment_terms?.trim() || null,
      bankDetails: input.bank_details?.trim() || null,
      defaultCategoryId: await resolveCategory(deps, input.default_category),
      notes: input.notes?.trim() || null,
    };
  },
  patch: async (patch, _row, deps) => {
    const set: SetOf<typeof schema.vendors> = {};
    if (has(patch, "display_name")) set.name = patch.display_name;
    if (has(patch, "contact_email")) set.contactEmail = patch.contact_email?.trim() || null;
    if (has(patch, "contact_phone")) set.contactPhone = patch.contact_phone?.trim() || null;
    if (has(patch, "tax_id")) set.taxId = patch.tax_id?.trim() || null;
    if (has(patch, "payment_terms")) set.paymentTerms = patch.payment_terms?.trim() || null;
    if (has(patch, "bank_details")) set.bankDetails = patch.bank_details?.trim() || null;
    if (has(patch, "default_category")) set.defaultCategoryId = await resolveCategory(deps, patch.default_category);
    if (has(patch, "notes")) set.notes = patch.notes?.trim() || null;
    return set;
  },
};


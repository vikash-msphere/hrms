// Asset categories: org-wide reference data (mirrors reimbursement-categories / expense-categories).
// Configurable in Settings; every asset points at one. `tag_code` is the short code that lands in the middle
// of a printed tag (Laptop -> LAP -> MS-LAP-014) and is therefore also the counter the next tag is drawn
// from - so it is kept unique, and defaulted from the name when nobody types one.
import { and, isNull, ne } from "drizzle-orm";
import * as schema from "../db/schema";
import { deriveTagCode } from "../domain/assetTag";
import { invalidArgument } from "../lib/errors";
import type { Deps } from "../deps";
import { has, type CrudSpec, type SetOf } from "./crud";

export type AssetCategoryInput = { display_name?: string; tag_code?: string | null; requires_serial?: boolean };

// Two categories sharing a code would share one tag sequence, so the codes on the stickers would no longer
// say what kind of thing they are stuck to. Case-insensitive; `exceptId` skips the row being updated.
async function assertCodeFree(deps: Deps, tagCode: string, exceptId?: string): Promise<void> {
  const conds = [isNull(schema.assetCategories.deleteTime), ...(exceptId ? [ne(schema.assetCategories.uuid, exceptId)] : [])];
  const rows = await deps.db.select({ tagCode: schema.assetCategories.tagCode }).from(schema.assetCategories).where(and(...conds));
  const key = tagCode.trim().toLowerCase();
  if (rows.some((r) => (r.tagCode ?? "").trim().toLowerCase() === key)) throw invalidArgument(`tag code ${tagCode} is already used by another category`);
}

export const assetCategorySpec: CrudSpec<AssetCategoryInput, typeof schema.assetCategories> = {
  table: schema.assetCategories,
  collection: "asset-categories",
  auditName: "asset_category",
  notFound: "asset category not found",
  insert: async (input, deps) => {
    if (!input.display_name?.trim()) throw invalidArgument("display_name is required");
    const name = input.display_name.trim();
    const tagCode = (input.tag_code?.trim() || deriveTagCode(name)).toUpperCase();
    await assertCodeFree(deps, tagCode);
    return { name, tagCode, requiresSerial: input.requires_serial ?? false };
  },
  patch: async (patch, row, deps) => {
    const set: SetOf<typeof schema.assetCategories> = {};
    if (has(patch, "display_name")) {
      if (!patch.display_name?.trim()) throw invalidArgument("display_name cannot be blank");
      set.name = patch.display_name.trim();
    }
    // Re-coding a category does NOT retag the assets already in it: a tag is a sticker on a physical thing,
    // and rewriting the record would make the sticker lie. New assets in the category take the new code.
    if (has(patch, "tag_code")) {
      const tagCode = (patch.tag_code?.trim() || deriveTagCode(set.name ?? row.name)).toUpperCase();
      await assertCodeFree(deps, tagCode, row.uuid);
      set.tagCode = tagCode;
    }
    if (has(patch, "requires_serial")) set.requiresSerial = patch.requires_serial;
    return set;
  },
  sort: (a, b) => String(a.name).localeCompare(String(b.name)),
};

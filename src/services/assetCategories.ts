// Asset categories: org-wide reference data (mirrors reimbursement-categories / expense-categories).
// Configurable in Settings; every asset points at one. `tag_code` is the short code that lands in the middle
// of a printed tag (Laptop -> LAP -> MS-LAP-014) and is therefore also the counter the next tag is drawn
// from - so it is kept unique, and defaulted from the name when nobody types one.
import { and, isNull, ne } from "drizzle-orm";
import * as schema from "../db/schema";
import { deriveTagCode, freeTagCode } from "../domain/assetTag";
import { alreadyExists, invalidArgument } from "../lib/errors";
import type { Deps } from "../deps";
import { has, type CrudSpec, type SetOf } from "./crud";

export type AssetCategoryInput = { display_name?: string; tag_code?: string | null; requires_serial?: boolean };

/** The codes in use right now, live rows only; `exceptId` skips the row being updated. */
async function codesInUse(deps: Deps, exceptId?: string): Promise<string[]> {
  const conds = [isNull(schema.assetCategories.deleteTime), ...(exceptId ? [ne(schema.assetCategories.uuid, exceptId)] : [])];
  const rows = await deps.db.select({ tagCode: schema.assetCategories.tagCode }).from(schema.assetCategories).where(and(...conds));
  return rows.map((r) => r.tagCode ?? "");
}

/**
 * The code this write should store.
 *
 * Two categories sharing a code would share one tag sequence, so the codes on the stickers would no longer
 * say what kind of thing they are stuck to. A code the author typed therefore has to be free, and is refused
 * when it is not. A code nobody typed is only a default, so it steps aside instead: "Laptop" and "Laptop
 * dock" both derive LAP, and refusing the second over a code its author never saw is a dead end in the
 * settings panel. Case-insensitive, matching how the codes are compared everywhere else.
 */
async function resolveTagCode(deps: Deps, typed: string | null | undefined, name: string, exceptId?: string): Promise<string> {
  const taken = await codesInUse(deps, exceptId);
  const explicit = typed?.trim();
  if (explicit) {
    const code = explicit.toUpperCase();
    const key = code.toLowerCase();
    // A clash is 409, not 400: the code the caller typed is well formed, it is the STATE that refuses it.
    if (taken.some((c) => c.trim().toLowerCase() === key)) throw alreadyExists(`tag code ${code} is already used by another category`);
    return code;
  }
  return freeTagCode(deriveTagCode(name).toUpperCase(), taken);
}

export const assetCategorySpec: CrudSpec<AssetCategoryInput, typeof schema.assetCategories> = {
  table: schema.assetCategories,
  collection: "asset-categories",
  auditName: "asset_category",
  notFound: "asset category not found",
  insert: async (input, deps) => {
    if (!input.display_name?.trim()) throw invalidArgument("display_name is required");
    const name = input.display_name.trim();
    const tagCode = await resolveTagCode(deps, input.tag_code, name);
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
      set.tagCode = await resolveTagCode(deps, patch.tag_code, set.name ?? row.name, row.uuid);
    }
    if (has(patch, "requires_serial")) set.requiresSerial = patch.requires_serial;
    return set;
  },
  sort: (a, b) => String(a.name).localeCompare(String(b.name)),
};

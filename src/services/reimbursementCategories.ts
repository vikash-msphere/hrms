// Reimbursement categories: a simple org-wide reference collection (mirrors leave-types). Configurable in
// Settings; claims reference one. `requires_receipt` makes a receipt attachment mandatory on those claims.
import * as schema from "../db/schema";
import { invalidArgument } from "../lib/errors";
import { crudService, has, type CrudSpec } from "./crud";

export type ReimbursementCategoryInput = { display_name?: string; requires_receipt?: boolean };

export const reimbursementCategorySpec: CrudSpec<ReimbursementCategoryInput> = {
  table: schema.reimbursementCategories,
  collection: "reimbursement-categories",
  auditName: "reimbursement_category",
  notFound: "reimbursement category not found",
  insert: (input) => {
    if (!input.display_name) throw invalidArgument("display_name is required");
    return { name: input.display_name, requiresReceipt: input.requires_receipt ?? false };
  },
  patch: (patch) => {
    const set: Record<string, unknown> = {};
    if (has(patch, "display_name")) set.name = patch.display_name;
    if (has(patch, "requires_receipt")) set.requiresReceipt = patch.requires_receipt;
    return set;
  },
};

export const {
  list: listReimbursementCategories,
  get: getReimbursementCategory,
  create: createReimbursementCategory,
  update: updateReimbursementCategory,
  remove: deleteReimbursementCategory,
  restore: restoreReimbursementCategory,
  purge: purgeReimbursementCategory,
} = crudService(reimbursementCategorySpec);

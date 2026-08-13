// Expense categories: org-wide reference (mirrors reimbursement-categories). Configurable in Settings; expenses
// reference one. `requires_receipt` makes an invoice attachment mandatory; `gl_code` is the accounting code.
import * as schema from "../db/schema";
import { invalidArgument } from "../lib/errors";
import { has, type CrudSpec } from "./crud";

export type ExpenseCategoryInput = { display_name?: string; requires_receipt?: boolean; gl_code?: string | null };

export const expenseCategorySpec: CrudSpec<ExpenseCategoryInput> = {
  table: schema.expenseCategories,
  collection: "expense-categories",
  auditName: "expense_category",
  notFound: "expense category not found",
  insert: (input) => {
    if (!input.display_name) throw invalidArgument("display_name is required");
    return { name: input.display_name, requiresReceipt: input.requires_receipt ?? false, glCode: input.gl_code ?? null };
  },
  patch: (patch) => {
    const set: Record<string, unknown> = {};
    if (has(patch, "display_name")) set.name = patch.display_name;
    if (has(patch, "requires_receipt")) set.requiresReceipt = patch.requires_receipt;
    if (has(patch, "gl_code")) set.glCode = patch.gl_code ?? null;
    return set;
  },
};


// Operational-expense categories. requiresReceipt gates whether an expense in this category must carry an
// invoice attachment. glCode is the accounting general-ledger code.
import { Ctx, T0, q, b, code2, rows } from "../lib";

type ExpenseCategorySeed = { name: string; requiresReceipt: boolean; glCode: string };

const EXPENSE_CATEGORIES: ExpenseCategorySeed[] = [
  { name: "Rent & Facilities", requiresReceipt: true, glCode: "6000" },
  { name: "Utilities", requiresReceipt: true, glCode: "6010" },
  { name: "Software & Subscriptions", requiresReceipt: true, glCode: "6020" },
  { name: "Office Supplies", requiresReceipt: false, glCode: "6030" },
  { name: "Travel & Transport", requiresReceipt: true, glCode: "6040" },
  { name: "Professional Services", requiresReceipt: true, glCode: "6050" },
  { name: "Marketing", requiresReceipt: true, glCode: "6060" },
  { name: "Equipment & Hardware", requiresReceipt: true, glCode: "6070" },
];

export function expenseCategories(ctx: Ctx): string {
  return rows(
    "INSERT INTO expense_categories (uuid,code,name,requires_receipt,gl_code,created_at,updated_at) VALUES",
    EXPENSE_CATEGORIES.map((c, i) =>
      ` (${q(ctx.nid())},${q(code2(i + 1))},${q(c.name)},${b(c.requiresReceipt)},${q(c.glCode)},${T0},${T0})`,
    ),
  );
}

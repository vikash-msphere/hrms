// Reimbursement categories. requiresReceipt gates whether a claim in this category must carry an attachment.
import { type Ctx, T0, q, b, code2, rows } from "../lib";

type ReimbCategorySeed = { name: string; requiresReceipt: boolean };

const REIMBURSEMENT_CATEGORIES: ReimbCategorySeed[] = [
  { name: "Travel", requiresReceipt: true },
  { name: "Accommodation", requiresReceipt: true },
  { name: "Meals", requiresReceipt: false },
  { name: "Equipment", requiresReceipt: true },
  { name: "Internet & Telephone", requiresReceipt: false },
  { name: "Training & Certification", requiresReceipt: true },
  { name: "Medical", requiresReceipt: true },
  { name: "Books & Subscriptions", requiresReceipt: false },
];

export function reimbursementCategories(ctx: Ctx): string {
  return rows(
    "INSERT INTO reimbursement_categories (uuid,code,name,requires_receipt,created_at,updated_at) VALUES",
    REIMBURSEMENT_CATEGORIES.map((c, i) =>
      ` (${q(ctx.nid())},${q(code2(i + 1))},${q(c.name)},${b(c.requiresReceipt)},${T0},${T0})`,
    ),
  );
}

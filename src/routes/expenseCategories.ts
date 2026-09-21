import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { expenseCategorySpec } from "../services/expenseCategories";
import { toExpenseCategoryResource } from "../http/serialize";

const writeSchema = z.object({
  display_name: z.string().min(1).optional(),
  requires_receipt: z.boolean().optional(),
  gl_code: z.string().nullable().optional(),
  // A rated category (mileage, per diem). Null on `rate_kind` clears both, which is how a category stops being
  // rated; the service validates the pair.
  rate_kind: z.enum(["per_km", "per_day"]).nullable().optional(),
  rate: z.number().positive().nullable().optional(),
  // Policy limits, both optional and both cleared with null.
  amount_cap: z.number().positive().nullable().optional(),
  max_age_days: z.number().int().min(0).max(3650).nullable().optional(),
}).strict();

export const expenseCategories = collectionRoutes({
  ...expenseCategorySpec,
  param: "category_id",
  writeSchema,
  serialize: toExpenseCategoryResource,
  lifecycleName: "expense-category",
});

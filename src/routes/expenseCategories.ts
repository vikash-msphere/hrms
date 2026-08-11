import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { expenseCategorySpec } from "../services/expenseCategories";
import { toExpenseCategoryResource } from "../http/serialize";

const writeSchema = z.object({
  display_name: z.string().min(1).optional(),
  requires_receipt: z.boolean().optional(),
  gl_code: z.string().nullable().optional(),
}).strict();

export const expenseCategories = collectionRoutes({
  ...expenseCategorySpec,
  param: "category_id",
  writeSchema,
  serialize: toExpenseCategoryResource,
  lifecycleName: "expense-category",
});

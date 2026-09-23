import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { reimbursementCategorySpec } from "../services/reimbursementCategories";
import { toReimbursementCategoryResource } from "../http/serialize";

const writeSchema = z.object({
  display_name: z.string().min(1).optional(),
  requires_receipt: z.boolean().optional(),
}).strict();

export const reimbursementCategories = collectionRoutes({
  ...reimbursementCategorySpec,
  param: "category_id",
  writeSchema,
  serialize: toReimbursementCategoryResource,
  lifecycleName: "reimbursement-category",
});

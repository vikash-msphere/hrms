import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { assetCategorySpec } from "../services/assetCategories";
import { toAssetCategoryResource } from "../http/serialize";

const writeSchema = z.object({
  display_name: z.string().min(1).optional(),
  tag_code: z.string().max(8).nullable().optional(),
  requires_serial: z.boolean().optional(),
}).strict();

export const assetCategories = collectionRoutes({
  ...assetCategorySpec,
  param: "category_id",
  writeSchema,
  serialize: toAssetCategoryResource,
  lifecycleName: "asset-category",
});

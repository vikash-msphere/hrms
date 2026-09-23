import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { salaryStructureSpec } from "../services/salaryStructures";
import { toSalaryStructureResource } from "../http/serialize";

const lineSchema = z.object({ component: z.string(), rate: z.number().nullable().optional() }).strict();
const writeSchema = z.object({
  display_name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  lines: z.array(lineSchema).optional(),
}).strict();

export const salaryStructures = collectionRoutes({
  ...salaryStructureSpec,
  param: "salary_structure_id",
  writeSchema,
  serialize: toSalaryStructureResource,
  lifecycleName: "salary-structure",
});

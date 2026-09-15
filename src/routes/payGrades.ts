import { z } from "zod";
import { nonNegativeMoney } from "../http/moneyField";
import { collectionRoutes } from "../http/collectionRoute";
import { payGradeSpec } from "../services/payGrades";
import { toPayGradeResource } from "../http/serialize";

const writeSchema = z.object({
  display_name: z.string().min(1).optional(),
  level: z.number().int().optional(),
  band_min: nonNegativeMoney().nullable().optional(),
  band_mid: nonNegativeMoney().nullable().optional(),
  band_max: nonNegativeMoney().nullable().optional(),
  currency_code: z.string().optional(),
  description: z.string().nullable().optional(),
}).strict();

export const payGrades = collectionRoutes({
  ...payGradeSpec,
  param: "pay_grade_id",
  writeSchema,
  serialize: toPayGradeResource,
  lifecycleName: "pay-grade",
});

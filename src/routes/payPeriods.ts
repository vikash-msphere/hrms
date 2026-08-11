import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { payPeriodSpec } from "../services/payPeriods";
import { toPayPeriodResource } from "../http/serialize";

const writeSchema = z.object({
  display_name: z.string().min(1).optional(),
  period_start: z.string().optional(),
  period_end: z.string().optional(),
  pay_date: z.string().optional(),
}).strict();

export const payPeriods = collectionRoutes({
  ...payPeriodSpec,
  param: "pay_period_id",
  writeSchema,
  serialize: toPayPeriodResource,
  lifecycleName: "pay-period",
});

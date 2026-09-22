import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { payPeriodSpec } from "../services/payPeriods";
import { toPayPeriodResource } from "../http/serialize";

const writeSchema = z.object({
  display_name: z.string().min(1).optional(),
  period_start: z.string().optional(),
  period_end: z.string().optional(),
  pay_date: z.string().optional(),
  // Nullable, because clearing an adopted cutoff is an edit: the form sends `null` for an empty box rather
  // than leaving the key out, which would read as "unchanged" (web/src/pages/PayPeriods.tsx). Missing from
  // this schema, the field was refused by `.strict()` before the service ever saw it - and since the form
  // sends the key on EVERY save, that 400 was every create and every edit made from the page.
  input_cutoff_on: z.string().nullable().optional(),
}).strict();

export const payPeriods = collectionRoutes({
  ...payPeriodSpec,
  param: "pay_period_id",
  writeSchema,
  serialize: toPayPeriodResource,
  lifecycleName: "pay-period",
});

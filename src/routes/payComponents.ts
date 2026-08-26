import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { payComponentSpec } from "../services/payComponents";
import { toPayComponentResource } from "../http/serialize";

// Exported so test/payComponentWrite.test.ts can pin it against the column enums in db/schema.ts - a kind or
// method the table stores but this rejects is invisible until a 400 in the UI.
export const writeSchema = z.object({
  display_name: z.string().min(1).optional(),
  // Mirrors the column enums in db/schema.ts: an employer_contribution row (employer PF/ESI/gratuity) is as
  // writable as either employee-side kind, and esi/pt are creatable statutory methods like epf/income_tax.
  kind: z.enum(["earning", "deduction", "employer_contribution"]).optional(),
  method: z.enum(["fixed", "percent_base", "income_tax", "epf", "esi", "pt", "edli", "pf_admin"]).optional(),
  rate: z.number().nullable().optional(),
  cap: z.number().min(0).nullable().optional(),
  regime: z.string().nullable().optional(),
  recurring: z.boolean().optional(),
  in_ctc: z.boolean().optional(), // employer contributions: inside CTC (default) vs over and above it
  pf_wages: z.boolean().optional(), // earnings: counts as PF wages under the "basic_plus" wage basis
  active: z.boolean().optional(),
}).strict();

export const payComponents = collectionRoutes({
  ...payComponentSpec,
  param: "pay_component_id",
  writeSchema,
  serialize: toPayComponentResource,
  lifecycleName: "pay-component",
});

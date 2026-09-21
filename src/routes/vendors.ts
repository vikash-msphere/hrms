import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { vendorSpec } from "../services/vendors";
import { toVendorResource } from "../http/serialize";

const writeSchema = z.object({
  display_name: z.string().min(1).optional(),
  contact_email: z.string().nullable().optional(),
  contact_phone: z.string().nullable().optional(),
  tax_id: z.string().nullable().optional(),
  // A NUMBER of days, not the free text it replaced. This schema is `.strict()`, so leaving the old field
  // here did two things at once: it rejected the `payment_terms_days` the SPA now sends, and it accepted a
  // `payment_terms` string that the service no longer reads - a save that 400s, or one that silently drops
  // what was typed. Neither is visible to tsc, because a zod schema is a runtime value and its output type is
  // not tied to the service's `VendorInput`.
  payment_terms_days: z.number().int().min(0).max(365).nullable().optional(),
  bank_details: z.string().nullable().optional(),
  default_category: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
}).strict();

export const vendors = collectionRoutes({ ...vendorSpec, param: "vendor_id", writeSchema, serialize: toVendorResource });

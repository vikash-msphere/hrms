import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { vendorSpec } from "../services/vendors";
import { toVendorResource } from "../http/serialize";

const writeSchema = z.object({
  display_name: z.string().min(1).optional(),
  contact_email: z.string().nullable().optional(),
  contact_phone: z.string().nullable().optional(),
  tax_id: z.string().nullable().optional(),
  payment_terms: z.string().nullable().optional(),
  bank_details: z.string().nullable().optional(),
  default_category: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
}).strict();

export const vendors = collectionRoutes({ ...vendorSpec, param: "vendor_id", writeSchema, serialize: toVendorResource });

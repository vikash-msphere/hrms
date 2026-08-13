import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { complianceEventSpec, listComplianceEvents } from "../services/complianceEvents";
import { toComplianceEventResource } from "../http/serialize";

// Statutory compliance calendar. NO access checks here - the middleware gates the path by grants (private by
// default; super-only until access is granted via the ACL). Standard CRUD + soft-delete/restore.
const writeSchema = z
  .object({
    title: z.string().min(1).optional(),
    category: z.string().nullable().optional(),
    frequency: z.enum(["one_time", "monthly", "quarterly", "annual"]).optional(),
    due_date: z.string().optional(),
    period_label: z.string().nullable().optional(),
    status: z.enum(["pending", "filed", "waived"]).optional(),
    filed_date: z.string().nullable().optional(),
    reference: z.string().nullable().optional(),
    assignee: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .strict();

export const complianceEvents = collectionRoutes({
  ...complianceEventSpec,
  param: "compliance_event_id",
  writeSchema,
  serialize: toComplianceEventResource,
  list: (c, page) =>
    listComplianceEvents(
      c.get("deps"),
      c.get("scope"),
      page.maxPageSize,
      page.pageToken,
      page.showDeleted,
    ),
});

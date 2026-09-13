import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { complianceEventSpec, listComplianceEvents } from "../services/complianceEvents";
import { toComplianceEventResource } from "../http/serialize";
import { stampOrgToday } from "../services/orgDay";

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
    document: z.string().nullable().optional(), // org-documents/<id>: the challan or receipt that proves it
    assignee: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .strict();

export const complianceEvents = collectionRoutes({
  ...complianceEventSpec,
  param: "compliance_event_id",
  writeSchema,
  serialize: toComplianceEventResource,
  // The `overdue` flag compares `due_date` against today, and the day it means is the ORG's - resolved once
  // per response here, because the serializer has no Deps to read the timezone with (services/orgDay.ts).
  decorate: (deps, _actor, rows) => stampOrgToday(deps, rows),
  list: (c, page) =>
    listComplianceEvents(
      c.get("deps"),
      c.get("scope"),
      page.maxPageSize,
      page.pageToken,
      page.showDeleted,
    ),
});

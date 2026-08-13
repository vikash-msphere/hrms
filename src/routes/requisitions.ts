import { z } from "zod";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { collectionRoutes } from "../http/collectionRoute";
import { listRequisitions, createRequisition, updateRequisition, applicantCountsByRequisition, type RequisitionInput } from "../services/ats";
import { toRequisitionResource } from "../http/serialize";

const writeSchema = z
  .object({
    title: z.string().nullable().optional(),
    department: z.string().nullable().optional(),
    hiring_manager: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    employment_type: z.string().nullable().optional(),
    openings: z.number().int().positive().nullable().optional(),
    description: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    opened_date: z.string().nullable().optional(),
    closed_date: z.string().nullable().optional(),
  })
  .strict();

// Open roles. The applicant count is derived, so it is attached before serializing - one count query per page.
const withCounts = async <T extends { uuid: string }>(deps: Deps, rows: T[]) => {
  const counts = await applicantCountsByRequisition(deps);
  return rows.map((r) => ({ ...r, applicantCount: counts.get(r.uuid) ?? 0 }));
};

export const requisitions = collectionRoutes<RequisitionInput, typeof schema.jobRequisitions>({
  table: schema.jobRequisitions,
  collection: "job-requisitions",
  auditName: "requisition",
  notFound: "requisition not found",
  param: "requisition_id",
  writeSchema,
  serialize: toRequisitionResource,
  decorate: (deps, _actor, rows) => withCounts(deps, rows),
  overrides: {
    create: (deps, actor, input, id) => createRequisition(deps, actor, input, id),
    update: (deps, actor, id, patch, ifMatch) => updateRequisition(deps, actor, id, patch, ifMatch),
  },
  list: (c, page) => listRequisitions(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, c.req.query("status"), page.showDeleted),
});

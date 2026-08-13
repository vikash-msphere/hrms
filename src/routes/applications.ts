import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { listApplications, createApplication, updateApplication, advanceApplication, rejectApplication, type ApplicationInput } from "../services/ats";
import { toApplicationResource } from "../http/serialize";

const writeSchema = z
  .object({
    candidate: z.string().nullable().optional(),
    requisition: z.string().nullable().optional(),
    stage: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    referral: z.string().nullable().optional(),
    applied_date: z.string().nullable().optional(),
  })
  .strict();

// One candidate against one requisition, moving through the configured pipeline. :advance takes the target
// stage and :reject a reason, both as sent - the hand-written route validated neither.
const bodyOf = async (c: { req: { json: () => Promise<unknown> } }) => ((await c.req.json().catch(() => ({}))) as { stage?: string; reason?: string });

export const applications = collectionRoutes<ApplicationInput, typeof schema.applications>({
  table: schema.applications,
  collection: "applications",
  auditName: "application",
  notFound: "application not found",
  param: "application_id",
  writeSchema,
  serialize: toApplicationResource,
  overrides: {
    create: (deps, actor, input, id) => createApplication(deps, actor, input, id),
    update: (deps, actor, id, patch, ifMatch) => updateApplication(deps, actor, id, patch, ifMatch),
  },
  list: (c, page) => {
    return listApplications(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, {
      requisition: c.req.query("requisition"),
      candidate: c.req.query("candidate"),
      stage: c.req.query("stage"),
      status: c.req.query("status"),
      showDeleted: page.showDeleted,
    });
  },
  verbs: {
    advance: { run: async (deps, user, id, _body, c) => advanceApplication(deps, user, id, (await bodyOf(c)).stage) },
    reject: { run: async (deps, user, id, _body, c) => rejectApplication(deps, user, id, (await bodyOf(c)).reason) },
  },
});

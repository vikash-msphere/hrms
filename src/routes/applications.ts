import type { Context } from "hono";
import { z } from "zod";
import * as schema from "../db/schema";
import type { AppEnv } from "../env";
import { collectionRoutes } from "../http/collectionRoute";
import { jsonBody } from "../http/jsonRequest";
import { listApplications, createApplication, updateApplication, advanceApplication, hireApplication, rejectApplication, type ApplicationInput } from "../services/ats";
import { toApplicationResource } from "../http/serialize";

const writeSchema = z
  .object({
    candidate: z.string().nullable().optional(),
    requisition: z.string().nullable().optional(),
    // stage and status are NOT NULL columns (defaults "applied" / "active") that the serializer emits on every
    // response: null is not a value they can hold. Move them with :advance / :reject, or send a new value.
    stage: z.string().optional(),
    status: z.string().optional(),
    source: z.string().nullable().optional(),
    referral: z.string().nullable().optional(),
    applied_date: z.string().nullable().optional(),
  })
  .strict();

// One candidate against one requisition, moving through the configured pipeline. :advance takes the target
// stage and :reject a reason, both as sent - the hand-written route validated neither.
const bodyOf = async (c: Context<AppEnv>) => (await jsonBody<{ stage?: string; reason?: string; notify_candidate?: boolean }>(c));

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
      deletedOnly: page.deletedOnly,
    });
  },
  verbs: {
    advance: { run: async (deps, user, id, _body, c) => advanceApplication(deps, user, id, (await bodyOf(c)).stage) },
    hire: { run: (deps, user, id) => hireApplication(deps, user, id) },
    reject: { run: async (deps, user, id, _body, c) => { const b = await bodyOf(c); return rejectApplication(deps, user, id, b.reason, b.notify_candidate === true); } },
  },
});

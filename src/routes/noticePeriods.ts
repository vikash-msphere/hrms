import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { listNoticePeriods, createNoticePeriod, updateNoticePeriod, type NoticePeriodInput } from "../services/noticePeriods";
import { toNoticePeriodResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";

const writeSchema = z
  .object({
    employee: z.string().nullable().optional(),
    type: z.enum(["resignation", "termination", "retirement", "other"]).optional(),
    notice_date: z.string().optional(),
    last_working_day: z.string().optional(),
    status: z.enum(["serving", "completed", "withdrawn"]).optional(),
    reason: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    start_offboarding: z.boolean().optional(),
    template: z.string().nullable().optional(),
  })
  .strict();

// A departing employee's notice + last working day. Both writes reach past this row - the create can start an
// offboarding transition and link it back, the update keeps that transition in sync and terminates the employee
// when the notice completes - so they stay the service's own. Delete/restore are the shared soft-delete lane.
export const noticePeriods = collectionRoutes<NoticePeriodInput>({
  table: schema.noticePeriods,
  collection: "notice-periods",
  auditName: "notice_period",
  notFound: "notice period not found",
  param: "notice_period_id",
  writeSchema,
  serialize: toNoticePeriodResource,
  overrides: {
    create: (deps, actor, input) => createNoticePeriod(deps, actor, input),
    update: (deps, actor, id, patch, ifMatch) => updateNoticePeriod(deps, actor, id, patch, ifMatch),
  },
  list: (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    // Row visibility was decided in middleware (scopeFor over the grant); `?status` narrows it further.
    return listNoticePeriods(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("status"), c.req.query("show_deleted") === "true");
  },
});

import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import {
  listRegularizations, createRegularization,
  approveRegularization, rejectRegularization, cancelRegularization,
  type RegularizationInput,
} from "../services/attendanceRegularizations";
import { toAttendanceRegularizationResource } from "../http/serialize";

const createSchema = z
  .object({
    employee: z.string().nullable().optional(),
    date: z.string(),
    sessions: z.array(z.object({ clock_in: z.string(), clock_out: z.string() }).strict()),
    reason: z.string().nullable().optional(),
  })
  .strict();

// A request to correct one day's clock times. The create validates the whole intended day (pairs ordered, no
// overlaps) and the approval supersedes that day's punches, so both stay in the service. A filed request is
// answered, never edited, and its table has no delete_time - so no PATCH, no DELETE, no `:restore`.
export const attendanceRegularizations = collectionRoutes<RegularizationInput>({
  table: schema.attendanceRegularizations,
  collection: "attendance-regularizations",
  auditName: "attendance-regularization",
  notFound: "regularization request not found",
  param: "regularization_id",
  createSchema,
  serialize: toAttendanceRegularizationResource,
  overrides: {
    create: (deps, actor, input) => createRegularization(deps, actor, input),
  },
  list: (c, page) => {
    // Row visibility was decided in middleware (scopeFor over the grant); `?state` narrows it further.
    return listRegularizations(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, c.req.query("state"));
  },
  verbs: {
    approve: { run: (deps, user, id) => approveRegularization(deps, user, id) },
    reject: { run: (deps, user, id) => rejectRegularization(deps, user, id) },
    cancel: { run: (deps, user, id) => cancelRegularization(deps, user, id) },
  },
});

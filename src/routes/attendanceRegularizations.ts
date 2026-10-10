import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import {
  listRegularizations, createRegularization,
  approveRegularization, rejectRegularization, cancelRegularization,
  type RegularizationInput,
} from "../services/attendanceRegularizations";
import { toAttendanceRegularizationResource } from "../http/serialize";
import { rejectBody, type RejectBody } from "../http/rejectBody";

const createSchema = z
  .object({
    employee: z.string().nullable().optional(),
    date: z.string(),
    // `clock_out` may be left out of today's last session only ("still clocked in"); the service enforces which.
    sessions: z.array(z.object({ clock_in: z.string(), clock_out: z.string().nullable().optional() }).strict()),
    reason: z.string().nullable().optional(),
  })
  .strict();

// A request to correct one day's clock times. The create validates the whole intended day (pairs ordered, no
// overlaps, only today's last one open) and the approval supersedes that day's punches, so both stay in the service. A filed request is
// answered, never edited, and its table has no delete_time - so no PATCH, no DELETE, no `:restore`.
export const attendanceRegularizations = collectionRoutes<RegularizationInput, typeof schema.attendanceRegularizations>({
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
    // Row visibility was decided in middleware (scopeFor over the grant); `?state` and `?employee` narrow it
    // further. The inbound edge (decodeWireIds) already decoded the query ref to its internal id.
    const emp = c.req.query("employee");
    return listRegularizations(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, c.req.query("state"), emp ? emp.split("/").pop()! : undefined);
  },
  verbs: {
    approve: { run: (deps, user, id, _body, c) => approveRegularization(deps, user, id, c.req.header("If-Match")) },
    reject: { schema: rejectBody, run: (deps, user, id, body: RejectBody, c) => rejectRegularization(deps, user, id, body.reason, c.req.header("If-Match")) },
    cancel: { run: (deps, user, id) => cancelRegularization(deps, user, id) },
  },
});

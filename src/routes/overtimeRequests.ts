import type { Context } from "hono";
import { z } from "zod";
import * as schema from "../db/schema";
import type { AppEnv } from "../env";
import { collectionRoutes } from "../http/collectionRoute";
import { jsonBody } from "../http/jsonRequest";
import {
  listOvertimeRequests, createOvertimeRequest,
  approveOvertimeRequest, rejectOvertimeRequest, cancelOvertimeRequest,
  type OvertimeInput,
} from "../services/overtimeRequests";
import { toOvertimeRequestResource } from "../http/serialize";
import { rejectBody, type RejectBody } from "../http/rejectBody";

const createSchema = z
  .object({
    employee: z.string().nullable().optional(),
    start_time: z.string(),
    end_time: z.string(),
    reason: z.string().nullable().optional(),
  })
  .strict();

// The approver's optional note on an approval, taken as sent. A rejection's reason is required (http/rejectBody.ts).
const noteOf = async (c: Context<AppEnv>) => (await jsonBody<{ note?: string }>(c)).note;

// Overtime requests. The create prices the hours and a decision either queues the payout or closes the request,
// so a filed request is cancelled rather than edited or deleted - and the table has no delete_time.
export const overtimeRequests = collectionRoutes<OvertimeInput, typeof schema.overtimeRequests>({
  table: schema.overtimeRequests,
  collection: "overtime-requests",
  auditName: "overtime_request",
  notFound: "overtime request not found",
  param: "overtime_request_id",
  createSchema,
  serialize: toOvertimeRequestResource,
  overrides: {
    create: (deps, actor, input) => createOvertimeRequest(deps, actor, input),
  },
  list: (c, page) => {
    // Row visibility was decided in middleware; `?employee` narrows it. The inbound edge (decodeWireIds) already
    // decoded the query ref to its internal id.
    const emp = c.req.query("employee");
    return listOvertimeRequests(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, c.req.query("state"), c.req.query("q"), emp ? emp.split("/").pop()! : undefined);
  },
  verbs: {
    approve: { run: async (deps, user, id, _body, c) => approveOvertimeRequest(deps, user, id, await noteOf(c), c.req.header("If-Match")) },
    reject: { schema: rejectBody, run: (deps, user, id, body: RejectBody, c) => rejectOvertimeRequest(deps, user, id, body.reason, c.req.header("If-Match")) },
    cancel: { run: (deps, user, id) => cancelOvertimeRequest(deps, user, id) },
  },
});

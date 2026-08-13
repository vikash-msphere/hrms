import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import {
  listOvertimeRequests, createOvertimeRequest,
  approveOvertimeRequest, rejectOvertimeRequest, cancelOvertimeRequest,
  type OvertimeInput,
} from "../services/overtimeRequests";
import { toOvertimeRequestResource } from "../http/serialize";

const createSchema = z
  .object({
    employee: z.string().nullable().optional(),
    start_time: z.string(),
    end_time: z.string(),
    reason: z.string().nullable().optional(),
  })
  .strict();

// The approver's optional note is taken as sent, exactly as the hand-written route did.
const noteOf = async (c: { req: { json: () => Promise<unknown> } }) => ((await c.req.json().catch(() => ({}))) as { note?: string })?.note;

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
  list: (c, page) => listOvertimeRequests(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, c.req.query("state"), c.req.query("q")),
  verbs: {
    approve: { run: async (deps, user, id, _body, c) => approveOvertimeRequest(deps, user, id, await noteOf(c)) },
    reject: { run: async (deps, user, id, _body, c) => rejectOvertimeRequest(deps, user, id, await noteOf(c)) },
    cancel: { run: (deps, user, id) => cancelOvertimeRequest(deps, user, id) },
  },
});

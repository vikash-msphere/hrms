import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import {
  listLeaveRequests, createLeaveRequest,
  approveLeaveRequest, rejectLeaveRequest, cancelLeaveRequest,
  type LeaveRequestInput,
} from "../services/leaveRequests";
import { toLeaveRequestResource } from "../http/serialize";

const createSchema = z
  .object({
    employee: z.string().nullable().optional(),
    leave_type: z.string(),
    start_date: z.string(),
    end_date: z.string(),
    start_session: z.union([z.literal(1), z.literal(2)]).optional(),
    end_session: z.union([z.literal(1), z.literal(2)]).optional(),
    reason: z.string().nullable().optional(),
  })
  .strict();

// Leave requests. The create reserves the balance and the three decisions consume or release it, so a filed
// request is never edited or deleted - it is cancelled. The table has no delete_time, so no DELETE, no
// `:restore`, and the access hint now offers exactly approve/reject/cancel (it used to claim a phantom
// update+delete pair from the default, for routes that have never existed here).
export const leaveRequests = collectionRoutes<LeaveRequestInput>({
  table: schema.leaveRequests,
  collection: "leave-requests",
  auditName: "leave_request",
  notFound: "leave request not found",
  param: "leave_request_id",
  createSchema,
  serialize: toLeaveRequestResource,
  overrides: {
    create: (deps, actor, input) => createLeaveRequest(deps, actor, input),
  },
  list: (c, page) => listLeaveRequests(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, c.req.query("state"), c.req.query("q")),
  verbs: {
    approve: { run: (deps, user, id) => approveLeaveRequest(deps, user, id) },
    reject: { run: (deps, user, id) => rejectLeaveRequest(deps, user, id) },
    cancel: { run: (deps, user, id) => cancelLeaveRequest(deps, user, id) },
  },
});

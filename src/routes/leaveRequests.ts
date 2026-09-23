import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import {
  listLeaveRequests, getLeaveRequestRow, createLeaveRequest,
  approveLeaveRequest, rejectLeaveRequest, cancelLeaveRequest,
  type LeaveRequestInput,
} from "../services/leaveRequests";
import { putAttachment, downloadAttachment, attachedObjectIds, attachmentDisposition } from "../services/attachments";
import { requireCappedBody } from "../services/documentsCommon";
import { toLeaveRequestResource } from "../http/serialize";

const COL = "leave-requests";
const DOCUMENT = "document"; // the attachment slot for a supporting file (sick note, travel document, …)

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
export const leaveRequests = collectionRoutes<LeaveRequestInput, typeof schema.leaveRequests>({
  table: schema.leaveRequests,
  collection: COL,
  auditName: "leave_request",
  notFound: "leave request not found",
  param: "leave_request_id",
  createSchema,
  serialize: toLeaveRequestResource,
  // Whether a supporting file is attached lives in the attachments table - resolved here, once per page, so
  // every answer (list, get, and each verb's response) carries the flag without a per-row query.
  decorate: async (deps, _actor, rows) => {
    const attached = await attachedObjectIds(deps, COL, DOCUMENT, rows.map((r) => r.uuid));
    return rows.map((r) => ({ ...r, hasDocument: attached.has(r.uuid) }));
  },
  overrides: {
    create: (deps, actor, input) => createLeaveRequest(deps, actor, input),
  },
  list: (c, page) =>
    listLeaveRequests(
      c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken,
      c.req.query("state"), c.req.query("q"), c.req.query("leave_type"), c.req.query("from"), c.req.query("to"),
      c.req.query("employee"),
    ),
  verbs: {
    approve: { run: (deps, user, id, _body, c) => approveLeaveRequest(deps, user, id, c.req.header("If-Match")) },
    reject: { run: (deps, user, id, _body, c) => rejectLeaveRequest(deps, user, id, c.req.header("If-Match")) },
    cancel: { run: (deps, user, id) => cancelLeaveRequest(deps, user, id) },
    // A supporting document (sick note, travel paperwork) goes up as raw bytes against the request that needs
    // it; the answer is the request itself, now flagged as documented. Same slot shape as a claim's receipt.
    upload: {
      run: async (deps, user, id, _body, c) => {
        const bytes = new Uint8Array(await requireCappedBody(c.req.raw));
        await putAttachment(deps, user, { collection: COL, objectId: id, slot: DOCUMENT, bytes, fileName: c.req.query("file_name"), contentType: c.req.query("content_type") });
        return { ...(await getLeaveRequestRow(deps, id)), hasDocument: true };
      },
    },
    download: {
      raw: async (c, id) => {
        const { bytes, row: att } = await downloadAttachment(c.get("deps"), COL, id, DOCUMENT);
        return c.body(bytes, 200, { "Content-Type": att.contentType ?? "application/octet-stream", "Content-Disposition": attachmentDisposition(att, "leave-document") });
      },
    },
  },
});

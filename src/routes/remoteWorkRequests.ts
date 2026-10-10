import type { Context } from "hono";
import { z } from "zod";
import * as schema from "../db/schema";
import type { AppEnv } from "../env";
import { collectionRoutes } from "../http/collectionRoute";
import { jsonBody } from "../http/jsonRequest";
import {
  listRemoteWorkRequests, createRemoteWorkRequest,
  approveRemoteWorkRequest, rejectRemoteWorkRequest, cancelRemoteWorkRequest,
  type RemoteWorkInput,
} from "../services/remoteWorkRequests";
import { toRemoteWorkRequestResource } from "../http/serialize";
import { rejectBody, type RejectBody } from "../http/rejectBody";

const createSchema = z
  .object({
    employee: z.string().nullable().optional(),
    start_date: z.string(),
    end_date: z.string(),
    start_session: z.number().int().optional(),
    end_session: z.number().int().optional(),
    location: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
  })
  .strict();

// The approver's optional note on an approval, taken as sent. A rejection's reason is required (http/rejectBody.ts).
const noteOf = async (c: Context<AppEnv>) => (await jsonBody<{ note?: string }>(c)).note;

// Work-from-home requests. Same shape as leave: filed, then approved, rejected or cancelled - never edited or
// deleted, and the table has no delete_time.
export const remoteWorkRequests = collectionRoutes<RemoteWorkInput, typeof schema.remoteWorkRequests>({
  table: schema.remoteWorkRequests,
  collection: "remote-work-requests",
  auditName: "remote_work_request",
  notFound: "remote work request not found",
  param: "remote_work_request_id",
  createSchema,
  serialize: toRemoteWorkRequestResource,
  overrides: {
    create: (deps, actor, input) => createRemoteWorkRequest(deps, actor, input),
  },
  list: (c, page) => {
    // Row visibility was decided in middleware; `?employee` narrows it. The inbound edge (decodeWireIds) already
    // decoded the query ref to its internal id.
    const emp = c.req.query("employee");
    return listRemoteWorkRequests(
      c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken,
      c.req.query("state"), c.req.query("q"), c.req.query("from"), c.req.query("to"), emp ? emp.split("/").pop()! : undefined,
    );
  },
  verbs: {
    approve: { run: async (deps, user, id, _body, c) => approveRemoteWorkRequest(deps, user, id, await noteOf(c), c.req.header("If-Match")) },
    reject: { schema: rejectBody, run: (deps, user, id, body: RejectBody, c) => rejectRemoteWorkRequest(deps, user, id, body.reason, c.req.header("If-Match")) },
    cancel: { run: (deps, user, id) => cancelRemoteWorkRequest(deps, user, id) },
  },
});

import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import {
  listRemoteWorkRequests, createRemoteWorkRequest,
  approveRemoteWorkRequest, rejectRemoteWorkRequest, cancelRemoteWorkRequest,
  type RemoteWorkInput,
} from "../services/remoteWorkRequests";
import { toRemoteWorkRequestResource } from "../http/serialize";

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

// The approver's optional note is taken as sent, exactly as the hand-written route did.
const noteOf = async (c: { req: { json: () => Promise<unknown> } }) => ((await c.req.json().catch(() => ({}))) as { note?: string })?.note;

// Work-from-home requests. Same shape as leave: filed, then approved, rejected or cancelled - never edited or
// deleted, and the table has no delete_time.
export const remoteWorkRequests = collectionRoutes<RemoteWorkInput>({
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
  list: (c, page) => listRemoteWorkRequests(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, c.req.query("state"), c.req.query("q")),
  verbs: {
    approve: { run: async (deps, user, id, _body, c) => approveRemoteWorkRequest(deps, user, id, await noteOf(c)) },
    reject: { run: async (deps, user, id, _body, c) => rejectRemoteWorkRequest(deps, user, id, await noteOf(c)) },
    cancel: { run: (deps, user, id) => cancelRemoteWorkRequest(deps, user, id) },
  },
});

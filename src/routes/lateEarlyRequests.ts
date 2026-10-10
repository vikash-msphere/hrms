import type { Context } from "hono";
import { z } from "zod";
import * as schema from "../db/schema";
import type { AppEnv } from "../env";
import { collectionRoutes } from "../http/collectionRoute";
import { jsonBody } from "../http/jsonRequest";
import {
  listLateEarlyRequests, createLateEarlyRequest,
  approveLateEarlyRequest, rejectLateEarlyRequest, cancelLateEarlyRequest,
  type LateEarlyInput,
} from "../services/lateEarlyRequests";
import { toLateEarlyRequestResource } from "../http/serialize";
import { rejectBody, type RejectBody } from "../http/rejectBody";

const createSchema = z
  .object({
    employee: z.string().nullable().optional(),
    date: z.string(),
    kind: z.enum(["late_arrival", "early_departure"]),
    at: z.string(),
    reason: z.string().nullable().optional(),
  })
  .strict();

// The approver's optional note, relayed to the requester with the approval. A rejection's reason is required
// (http/rejectBody.ts).
const noteOf = async (c: Context<AppEnv>) => (await jsonBody<{ note?: string }>(c)).note;

// Late arrival / early departure requests. The create runs the org's policy (it may refuse, flag the request as
// past the monthly allowance, or approve it outright) and a decision changes how the day is judged, so a filed
// request is cancelled rather than edited - and the table has no delete_time, so no PATCH, DELETE or :restore.
export const lateEarlyRequests = collectionRoutes<LateEarlyInput, typeof schema.lateEarlyRequests>({
  table: schema.lateEarlyRequests,
  collection: "late-early-requests",
  auditName: "late_early_request",
  notFound: "late arrival / early departure request not found",
  param: "late_early_request_id",
  createSchema,
  serialize: toLateEarlyRequestResource,
  overrides: {
    create: (deps, actor, input) => createLateEarlyRequest(deps, actor, input),
  },
  list: (c, page) => {
    // Row visibility was decided in middleware; the filters narrow it. The inbound edge (decodeWireIds) already
    // decoded the `?employee` ref to its internal id.
    const emp = c.req.query("employee");
    return listLateEarlyRequests(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, {
      state: c.req.query("state"),
      employeeId: emp ? emp.split("/").pop()! : undefined,
      from: c.req.query("from"),
      to: c.req.query("to"),
    });
  },
  verbs: {
    approve: { run: async (deps, user, id, _body, c) => approveLateEarlyRequest(deps, user, id, await noteOf(c), c.req.header("If-Match")) },
    reject: { schema: rejectBody, run: (deps, user, id, body: RejectBody, c) => rejectLateEarlyRequest(deps, user, id, body.reason, c.req.header("If-Match")) },
    cancel: { run: (deps, user, id) => cancelLateEarlyRequest(deps, user, id) },
  },
});

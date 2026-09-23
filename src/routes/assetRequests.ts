import type { Context } from "hono";
import { z } from "zod";
import * as schema from "../db/schema";
import type { AppEnv } from "../env";
import { collectionRoutes } from "../http/collectionRoute";
import { jsonBody } from "../http/jsonRequest";
import {
  listAssetRequests, createAssetRequest,
  approveAssetRequest, rejectAssetRequest, cancelAssetRequest, issueAssetRequest,
  type AssetRequestInput,
} from "../services/assetRequests";
import { toAssetRequestResource } from "../http/serialize";

const createSchema = z
  .object({
    employee: z.string().nullable().optional(),
    category: z.string(), // asset-categories/{id}
    justification: z.string().max(2000).nullable().optional(),
    needed_by: z.string().nullable().optional(),
  })
  .strict();

// `:issue` names the asset being handed over (the inbound edge decodes the ref).
const issueSchema = z.object({ asset: z.string() }).strict();

// The approver's optional note is taken as sent, like the other request collections.
const noteOf = async (c: Context<AppEnv>) => (await jsonBody<{ note?: string }>(c)).note;

// Requests for kit. Filed, then approved, rejected or cancelled - never edited or deleted, and the table has no
// delete_time. An approved request is closed by `:issue`, which hands over an actual asset.
export const assetRequests = collectionRoutes<AssetRequestInput, typeof schema.assetRequests>({
  table: schema.assetRequests,
  collection: "asset-requests",
  auditName: "asset_request",
  notFound: "asset request not found",
  param: "asset_request_id",
  createSchema,
  serialize: toAssetRequestResource,
  overrides: {
    create: (deps, actor, input) => createAssetRequest(deps, actor, input),
  },
  list: (c, page) => {
    // The inbound edge (decodeWireIds) already decoded the query ref to its internal id; just take the id.
    const emp = c.req.query("employee");
    return listAssetRequests(
      c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken,
      c.req.query("state"), c.req.query("q"), emp ? emp.split("/").pop()! : undefined,
    );
  },
  verbs: {
    approve: { run: async (deps, user, id, _body, c) => approveAssetRequest(deps, user, id, await noteOf(c), c.req.header("If-Match")) },
    reject: { run: async (deps, user, id, _body, c) => rejectAssetRequest(deps, user, id, await noteOf(c), c.req.header("If-Match")) },
    cancel: { run: (deps, user, id) => cancelAssetRequest(deps, user, id) },
    issue: { schema: issueSchema, run: (deps, user, id, body: { asset: string }, c) => issueAssetRequest(deps, user, id, body?.asset, c.req.header("If-Match")) },
  },
});

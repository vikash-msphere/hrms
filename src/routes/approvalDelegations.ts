import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { listApprovalDelegations, getApprovalDelegation, createApprovalDelegation, updateApprovalDelegation, deleteApprovalDelegation } from "../services/approvalDelegations";
import { toApprovalDelegationResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";

const COL = "approval-delegations";
const writeSchema = z.object({
  delegator: z.string().nullable().optional(),
  delegate: z.string().nullable().optional(),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
  reason: z.string().nullable().optional(),
}).strict();

export const approvalDelegations = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listApprovalDelegations(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("employee"));
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toApprovalDelegationResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:delegation_id", async (c) => {
    const row = await getApprovalDelegation(c.get("deps"), c.get("user"), c.req.param("delegation_id")!);
    return c.json(withAccess(toApprovalDelegationResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createApprovalDelegation(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(withAccess(toApprovalDelegationResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .patch("/:delegation_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateApprovalDelegation(c.get("deps"), c.get("user"), c.req.param("delegation_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(withAccess(toApprovalDelegationResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .delete("/:delegation_id", async (c) => {
    await deleteApprovalDelegation(c.get("deps"), c.get("user"), c.req.param("delegation_id")!, c.req.header("If-Match"));
    return c.body(null, 204);
  });

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import {
  listOvertimeRequests, getOvertimeRequest, createOvertimeRequest,
  approveOvertimeRequest, rejectOvertimeRequest, cancelOvertimeRequest,
} from "../services/overtimeRequests";
import { toOvertimeRequestResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

const COL = "overtime-requests";

const createSchema = z
  .object({
    employee: z.string().nullable().optional(),
    start_time: z.string(),
    end_time: z.string(),
    reason: z.string().nullable().optional(),
  })
  .strict();

export const overtimeRequests = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listOvertimeRequests(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("state"), c.req.query("q"));
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toOvertimeRequestResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:overtime_request_id", async (c) => {
    const row = await getOvertimeRequest(c.get("deps"), c.get("user"), c.req.param("overtime_request_id"));
    return c.json(withAccess(toOvertimeRequestResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", createSchema), async (c) => {
    const row = await createOvertimeRequest(c.get("deps"), c.get("user"), c.req.valid("json"));
    return c.json(withAccess(toOvertimeRequestResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/:overtime_request_id", async (c) => {
    const { id, verb } = customMethod(c);
    const deps = c.get("deps");
    const user = c.get("user");
    const body = await c.req.json().catch(() => ({} as { note?: string }));
    const hint = (row: { code: string | null } | undefined) => withAccess(toOvertimeRequestResource(row), user, COL, row?.code, c.get("objectGrant"));
    if (verb === "approve") return c.json(hint(await approveOvertimeRequest(deps, user, id, body?.note)));
    if (verb === "reject") return c.json(hint(await rejectOvertimeRequest(deps, user, id, body?.note)));
    if (verb === "cancel") return c.json(hint(await cancelOvertimeRequest(deps, user, id)));
    return c.notFound();
  });

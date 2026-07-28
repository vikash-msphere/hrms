import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import {
  listRemoteWorkRequests, getRemoteWorkRequest, createRemoteWorkRequest,
  approveRemoteWorkRequest, rejectRemoteWorkRequest, cancelRemoteWorkRequest,
} from "../services/remoteWorkRequests";
import { toRemoteWorkRequestResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

const COL = "remote-work-requests";

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

export const remoteWorkRequests = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listRemoteWorkRequests(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("state"), c.req.query("q"));
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toRemoteWorkRequestResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:remote_work_request_id", async (c) => {
    const row = await getRemoteWorkRequest(c.get("deps"), c.get("user"), c.req.param("remote_work_request_id"));
    return c.json(withAccess(toRemoteWorkRequestResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", createSchema), async (c) => {
    const row = await createRemoteWorkRequest(c.get("deps"), c.get("user"), c.req.valid("json"));
    return c.json(withAccess(toRemoteWorkRequestResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/:remote_work_request_id", async (c) => {
    const { id, verb } = customMethod(c);
    const deps = c.get("deps");
    const user = c.get("user");
    const body = await c.req.json().catch(() => ({} as { note?: string }));
    const hint = (row: { code: string | null } | undefined) => withAccess(toRemoteWorkRequestResource(row), user, COL, row?.code, c.get("objectGrant"));
    if (verb === "approve") return c.json(hint(await approveRemoteWorkRequest(deps, user, id, body?.note)));
    if (verb === "reject") return c.json(hint(await rejectRemoteWorkRequest(deps, user, id, body?.note)));
    if (verb === "cancel") return c.json(hint(await cancelRemoteWorkRequest(deps, user, id)));
    return c.notFound();
  });

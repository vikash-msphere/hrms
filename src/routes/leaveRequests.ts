import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import {
  listLeaveRequests, getLeaveRequest, createLeaveRequest,
  approveLeaveRequest, rejectLeaveRequest, cancelLeaveRequest,
} from "../services/leaveRequests";
import { toLeaveRequestResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

const COL = "leave-requests";

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

export const leaveRequests = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listLeaveRequests(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("state"), c.req.query("q"));
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toLeaveRequestResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:leave_request_id", async (c) => {
    const row = await getLeaveRequest(c.get("deps"), c.get("user"), c.req.param("leave_request_id"));
    return c.json(withAccess(toLeaveRequestResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", createSchema), async (c) => {
    const row = await createLeaveRequest(c.get("deps"), c.get("user"), c.req.valid("json"));
    return c.json(withAccess(toLeaveRequestResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  // Custom methods. The wire path is the :verb form; dispatch on the parsed verb.
  .post("/:leave_request_id", async (c) => {
    const { id, verb } = customMethod(c);
    const deps = c.get("deps");
    const user = c.get("user");
    const hint = (row: { code: string | null } | undefined) => withAccess(toLeaveRequestResource(row), user, COL, row?.code, c.get("objectGrant"));
    if (verb === "approve") return c.json(hint(await approveLeaveRequest(deps, user, id)));
    if (verb === "reject") return c.json(hint(await rejectLeaveRequest(deps, user, id)));
    if (verb === "cancel") return c.json(hint(await cancelLeaveRequest(deps, user, id)));
    return c.notFound();
  });

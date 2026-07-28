import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import {
  listRegularizations, getRegularization, createRegularization,
  approveRegularization, rejectRegularization, cancelRegularization,
} from "../services/attendanceRegularizations";
import { toAttendanceRegularizationResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

const COL = "attendance-regularizations";

const createSchema = z
  .object({
    employee: z.string().nullable().optional(),
    date: z.string(),
    sessions: z.array(z.object({ clock_in: z.string(), clock_out: z.string() }).strict()),
    reason: z.string().nullable().optional(),
  })
  .strict();

export const attendanceRegularizations = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listRegularizations(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("state"));
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toAttendanceRegularizationResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:regularization_id", async (c) => {
    const row = await getRegularization(c.get("deps"), c.get("user"), c.req.param("regularization_id"));
    return c.json(withAccess(toAttendanceRegularizationResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", createSchema), async (c) => {
    const row = await createRegularization(c.get("deps"), c.get("user"), c.req.valid("json"));
    return c.json(withAccess(toAttendanceRegularizationResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/:regularization_id", async (c) => {
    const { id, verb } = customMethod(c);
    const deps = c.get("deps");
    const user = c.get("user");
    const hint = (row: { code: string | null } | undefined) => withAccess(toAttendanceRegularizationResource(row), user, COL, row?.code, c.get("objectGrant"));
    if (verb === "approve") return c.json(hint(await approveRegularization(deps, user, id)));
    if (verb === "reject") return c.json(hint(await rejectRegularization(deps, user, id)));
    if (verb === "cancel") return c.json(hint(await cancelRegularization(deps, user, id)));
    return c.notFound();
  });

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import {
  listEncashments, getEncashment, computeAndStoreEncashment,
  approveEncashment, rejectEncashment, cancelEncashment,
} from "../services/leaveEncashments";
import { toLeaveEncashmentResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

const COL = "leave-encashments";

// HR-driven only (gated by grants: only hr_admin holds write). Payout is always via payroll, so there is no
// :pay verb - approved rows are swept into the next run.
const createSchema = z
  .object({
    employee: z.string(),
    leave_type: z.string(),
    days: z.number().positive(),
  })
  .strict();

export const leaveEncashments = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const employeeId = c.req.query("employee") ? c.req.query("employee")!.split("/").pop() : undefined;
    const { items, nextPageToken } = await listEncashments(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("state"), employeeId);
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toLeaveEncashmentResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:encashment_id", async (c) => {
    const row = await getEncashment(c.get("deps"), c.get("user"), c.req.param("encashment_id"));
    return c.json(withAccess(toLeaveEncashmentResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", createSchema), async (c) => {
    const row = await computeAndStoreEncashment(c.get("deps"), c.get("user"), c.req.valid("json"));
    return c.json(withAccess(toLeaveEncashmentResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  // Custom methods. The wire path is the :verb form; dispatch on the parsed verb.
  .post("/:encashment_id", async (c) => {
    const { id, verb } = customMethod(c);
    const deps = c.get("deps");
    const user = c.get("user");
    const hint = (row: any) => withAccess(toLeaveEncashmentResource(row), user, COL, row?.code, c.get("objectGrant"));
    if (verb === "approve") return c.json(hint(await approveEncashment(deps, user, id)));
    if (verb === "reject") return c.json(hint(await rejectEncashment(deps, user, id)));
    if (verb === "cancel") return c.json(hint(await cancelEncashment(deps, user, id)));
    return c.notFound();
  });

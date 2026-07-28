import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { listCheckIns, getCheckIn, createCheckIn, updateCheckIn, deleteCheckIn, restoreCheckIn, purgeCheckIn } from "../services/checkIns";
import { toCheckInResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

const COL = "check-ins";

const actionItem = z.object({ text: z.string(), done: z.boolean().optional() }).strict();
const writeSchema = z.object({
  employee: z.string().nullable().optional(),
  counterpart: z.string().nullable().optional(),
  meeting_date: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  action_items: z.array(actionItem).optional(),
}).strict();

export const checkIns = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listCheckIns(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("employee"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toCheckInResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:check_in_id", async (c) => {
    const row = await getCheckIn(c.get("deps"), c.get("user"), c.req.param("check_in_id")!);
    return c.json(withAccess(toCheckInResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createCheckIn(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(withAccess(toCheckInResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .patch("/:check_in_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateCheckIn(c.get("deps"), c.get("user"), c.req.param("check_in_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(withAccess(toCheckInResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .delete("/:check_in_id", async (c) => {
    const id = c.req.param("check_in_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeCheckIn(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteCheckIn(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:check_in_id", async (c) => {
    const { id, verb } = customMethod(c);
    const user = c.get("user");
    if (verb === "restore") {
      const row = await restoreCheckIn(c.get("deps"), user, id);
      return c.json(withAccess(toCheckInResource(row), user, COL, row?.code as string | null | undefined, c.get("objectGrant")));
    }
    return c.notFound();
  });

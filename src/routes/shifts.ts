import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { listShifts, getShift, createShift, updateShift, deleteShift, restoreShift, purgeShift } from "../services/shifts";
import { toShiftResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

const COL = "shifts";
const writeSchema = z.object({
  name: z.string().min(1).optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  break_minutes: z.number().optional(),
  color: z.string().nullable().optional(),
}).strict();

export const shifts = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listShifts(c.get("deps"), c.get("user"), maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toShiftResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:shift_id", async (c) => {
    const row = await getShift(c.get("deps"), c.get("user"), c.req.param("shift_id")!);
    return c.json(withAccess(toShiftResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createShift(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(withAccess(toShiftResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .patch("/:shift_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateShift(c.get("deps"), c.get("user"), c.req.param("shift_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(withAccess(toShiftResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .delete("/:shift_id", async (c) => {
    const id = c.req.param("shift_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeShift(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteShift(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:shift_id", async (c) => {
    const { id, verb } = customMethod(c);
    if (verb !== "restore") return c.notFound();
    const row = await restoreShift(c.get("deps"), c.get("user"), id);
    return c.json(withAccess(toShiftResource(row), c.get("user"), COL, row?.code as string | null | undefined, c.get("objectGrant")));
  });

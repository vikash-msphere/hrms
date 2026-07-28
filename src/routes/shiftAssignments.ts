import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { listShiftAssignments, getShiftAssignment, createShiftAssignment, updateShiftAssignment, deleteShiftAssignment, restoreShiftAssignment, purgeShiftAssignment } from "../services/shiftAssignments";
import { toShiftAssignmentResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

const COL = "shift-assignments";
const writeSchema = z.object({
  employee: z.string().nullable().optional(),
  shift: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
}).strict();

export const shiftAssignments = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listShiftAssignments(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("employee"), c.req.query("from"), c.req.query("to"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toShiftAssignmentResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:assignment_id", async (c) => {
    const row = await getShiftAssignment(c.get("deps"), c.get("user"), c.req.param("assignment_id")!);
    return c.json(withAccess(toShiftAssignmentResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createShiftAssignment(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(withAccess(toShiftAssignmentResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .patch("/:assignment_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateShiftAssignment(c.get("deps"), c.get("user"), c.req.param("assignment_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(withAccess(toShiftAssignmentResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .delete("/:assignment_id", async (c) => {
    const id = c.req.param("assignment_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeShiftAssignment(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteShiftAssignment(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:assignment_id", async (c) => {
    const { id, verb } = customMethod(c);
    if (verb !== "restore") return c.notFound();
    const row = await restoreShiftAssignment(c.get("deps"), c.get("user"), id);
    return c.json(withAccess(toShiftAssignmentResource(row), c.get("user"), COL, row?.code as string | null | undefined, c.get("objectGrant")));
  });

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import {
  listSprints, getSprint, createSprint, updateSprint, activateSprint, completeSprint,
  deleteSprint, restoreSprint, purgeSprint,
} from "../services/sprints";
import { toSprintResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

const COL = "sprints";

const createSchema = z.object({
  board: z.string().min(1),
  name: z.string().min(1),
  goal: z.string().nullable().optional(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
}).strict();
const updateSchema = z.object({
  name: z.string().min(1).optional(),
  goal: z.string().nullable().optional(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
}).strict();

export const sprints = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const boardId = c.req.query("board") ? c.req.query("board")!.split("/").pop() : undefined;
    const { items, nextPageToken } = await listSprints(c.get("deps"), c.get("user"), maxPageSize, c.req.query("page_token"), boardId, c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toSprintResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:sprint_id", async (c) => {
    const row = await getSprint(c.get("deps"), c.get("user"), c.req.param("sprint_id")!);
    return c.json(withAccess(toSprintResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", createSchema), async (c) => {
    const row = await createSprint(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(withAccess(toSprintResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .patch("/:sprint_id", zValidator("json", updateSchema), async (c) => {
    const row = await updateSprint(c.get("deps"), c.get("user"), c.req.param("sprint_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(withAccess(toSprintResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .delete("/:sprint_id", async (c) => {
    const id = c.req.param("sprint_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeSprint(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteSprint(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:sprint_id", async (c) => {
    const { id, verb } = customMethod(c);
    const deps = c.get("deps");
    const user = c.get("user");
    const hint = (row: any) => withAccess(toSprintResource(row), user, COL, row?.code, c.get("objectGrant"));
    if (verb === "activate") return c.json(hint(await activateSprint(deps, user, id)));
    if (verb === "complete") return c.json(hint(await completeSprint(deps, user, id)));
    if (verb === "restore") return c.json(hint(await restoreSprint(deps, user, id)));
    return c.notFound();
  });

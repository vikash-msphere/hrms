import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { listProjects, getProject, createProject, updateProject, deleteProject, restoreProject, purgeProject } from "../services/projects";
import { toProjectResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

const COL = "projects";
const writeSchema = z.object({
  name: z.string().min(1).optional(),
  client: z.string().nullable().optional(),
  code: z.string().nullable().optional(),
  billable: z.boolean().optional(),
  status: z.enum(["active", "archived"]).optional(),
}).strict();

export const projects = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listProjects(c.get("deps"), c.get("user"), maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toProjectResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:project_id", async (c) => {
    const row = await getProject(c.get("deps"), c.get("user"), c.req.param("project_id")!);
    return c.json(withAccess(toProjectResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createProject(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(withAccess(toProjectResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .patch("/:project_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateProject(c.get("deps"), c.get("user"), c.req.param("project_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(withAccess(toProjectResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .delete("/:project_id", async (c) => {
    const id = c.req.param("project_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeProject(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteProject(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:project_id", async (c) => {
    const { id, verb } = customMethod(c);
    if (verb !== "restore") return c.notFound();
    const row = await restoreProject(c.get("deps"), c.get("user"), id);
    return c.json(withAccess(toProjectResource(row), c.get("user"), COL, row?.code as string | null | undefined, c.get("objectGrant")));
  });

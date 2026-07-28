// SIMPLE route template. Copy for the other simple resources. See docs/03-add-a-resource.md.
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { customMethod } from "../http/customMethod";
import { lifecycleVerb } from "../http/lifecycleRoute";
import * as schema from "../db/schema";
import { listDepartments, getDepartment, createDepartment, updateDepartment, deleteDepartment, restoreDepartment, purgeDepartment } from "../services/departments";
import { toDepartmentResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";

const COL = "departments";
const writeSchema = z.object({ display_name: z.string().min(1).optional(), parent: z.string().nullable().optional(), managers: z.array(z.string()).nullable().optional() }).strict();

export const departments = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listDepartments(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toDepartmentResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:department_id", async (c) => {
    const row = await getDepartment(c.get("deps"), c.get("user"), c.req.param("department_id"));
    return c.json(withAccess(toDepartmentResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createDepartment(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(withAccess(toDepartmentResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .patch("/:department_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateDepartment(c.get("deps"), c.get("user"), c.req.param("department_id"), c.req.valid("json"), c.req.header("If-Match"));
    return c.json(withAccess(toDepartmentResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .delete("/:department_id", async (c) => {
    const id = c.req.param("department_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") {
      await purgeDepartment(c.get("deps"), c.get("user"), id, ifMatch);
    } else {
      await deleteDepartment(c.get("deps"), c.get("user"), id, ifMatch);
    }
    return c.body(null, 204);
  })
  .post("/:department_id", async (c) => {
    const lc = await lifecycleVerb(c, { table: schema.departments, singular: "department", collection: "departments", serialize: toDepartmentResource });
    if (lc) return lc;
    const { id, verb } = customMethod(c);
    if (verb !== "restore") return c.notFound();
    const row = await restoreDepartment(c.get("deps"), c.get("user"), id);
    return c.json(withAccess(toDepartmentResource(row), c.get("user"), COL, row?.code as string | null | undefined, c.get("objectGrant")));
  });

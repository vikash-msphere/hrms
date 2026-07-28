import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { listDependents, getDependent, createDependent, updateDependent, deleteDependent, restoreDependent, purgeDependent } from "../services/dependents";
import { toDependentResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

const COL = "dependents";
const writeSchema = z.object({
  employee: z.string().nullable().optional(),
  name: z.string().min(1).optional(),
  relationship: z.enum(["spouse", "child", "parent", "domestic_partner", "other"]).optional(),
  date_of_birth: z.string().nullable().optional(),
}).strict();

export const dependents = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listDependents(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("employee"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toDependentResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:dependent_id", async (c) => {
    const row = await getDependent(c.get("deps"), c.get("user"), c.req.param("dependent_id")!);
    return c.json(withAccess(toDependentResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createDependent(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(withAccess(toDependentResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .patch("/:dependent_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateDependent(c.get("deps"), c.get("user"), c.req.param("dependent_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(withAccess(toDependentResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .delete("/:dependent_id", async (c) => {
    const id = c.req.param("dependent_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeDependent(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteDependent(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:dependent_id", async (c) => {
    const { id, verb } = customMethod(c);
    if (verb !== "restore") return c.notFound();
    const row = await restoreDependent(c.get("deps"), c.get("user"), id);
    return c.json(withAccess(toDependentResource(row), c.get("user"), COL, row?.code as string | null | undefined, c.get("objectGrant")));
  });

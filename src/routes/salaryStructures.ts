import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { customMethod } from "../http/customMethod";
import { lifecycleVerb } from "../http/lifecycleRoute";
import * as schema from "../db/schema";
import { listSalaryStructures, getSalaryStructure, createSalaryStructure, updateSalaryStructure, deleteSalaryStructure, restoreSalaryStructure, purgeSalaryStructure } from "../services/salaryStructures";
import { toSalaryStructureResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";

const lineSchema = z.object({ component: z.string(), rate: z.number().nullable().optional() }).strict();
const writeSchema = z.object({
  display_name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  lines: z.array(lineSchema).optional(),
}).strict();

export const salaryStructures = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listSalaryStructures(c.get("deps"), c.get("user"), maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toSalaryStructureResource(r), user, "salary-structures", r.code)), next_page_token: nextPageToken });
  })
  .get("/:salary_structure_id", async (c) => {
    const row = await getSalaryStructure(c.get("deps"), c.get("user"), c.req.param("salary_structure_id")!);
    return c.json(toSalaryStructureResource(row));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createSalaryStructure(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(toSalaryStructureResource(row));
  })
  .patch("/:salary_structure_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateSalaryStructure(c.get("deps"), c.get("user"), c.req.param("salary_structure_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(toSalaryStructureResource(row));
  })
  .delete("/:salary_structure_id", async (c) => {
    const id = c.req.param("salary_structure_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") {
      await purgeSalaryStructure(c.get("deps"), c.get("user"), id, ifMatch);
    } else {
      await deleteSalaryStructure(c.get("deps"), c.get("user"), id, ifMatch);
    }
    return c.body(null, 204);
  })
  .post("/:salary_structure_id", async (c) => {
    const lc = await lifecycleVerb(c, { table: schema.salaryStructures, singular: "salary-structure", collection: "salary-structures", serialize: toSalaryStructureResource });
    if (lc) return lc;
    const { id, verb } = customMethod(c);
    if (verb !== "restore") return c.notFound();
    const row = await restoreSalaryStructure(c.get("deps"), c.get("user"), id);
    return c.json(toSalaryStructureResource(row));
  });

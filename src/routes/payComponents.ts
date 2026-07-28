import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { customMethod } from "../http/customMethod";
import { lifecycleVerb } from "../http/lifecycleRoute";
import * as schema from "../db/schema";
import { listPayComponents, getPayComponent, createPayComponent, updatePayComponent, deletePayComponent, restorePayComponent, purgePayComponent } from "../services/payComponents";
import { toPayComponentResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";

const writeSchema = z.object({
  display_name: z.string().min(1).optional(),
  kind: z.enum(["earning", "deduction"]).optional(),
  method: z.enum(["fixed", "percent_base", "rate_qty", "income_tax", "epf"]).optional(),
  rate: z.number().nullable().optional(),
  cap: z.number().min(0).nullable().optional(),
  regime: z.string().nullable().optional(),
  recurring: z.boolean().optional(),
  active: z.boolean().optional(),
}).strict();

export const payComponents = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listPayComponents(c.get("deps"), c.get("user"), maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toPayComponentResource(r), user, "pay-components", r.code)), next_page_token: nextPageToken });
  })
  .get("/:pay_component_id", async (c) => {
    const row = await getPayComponent(c.get("deps"), c.get("user"), c.req.param("pay_component_id")!);
    return c.json(toPayComponentResource(row));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createPayComponent(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(toPayComponentResource(row));
  })
  .patch("/:pay_component_id", zValidator("json", writeSchema), async (c) => {
    const row = await updatePayComponent(c.get("deps"), c.get("user"), c.req.param("pay_component_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(toPayComponentResource(row));
  })
  .delete("/:pay_component_id", async (c) => {
    const id = c.req.param("pay_component_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") {
      await purgePayComponent(c.get("deps"), c.get("user"), id, ifMatch);
    } else {
      await deletePayComponent(c.get("deps"), c.get("user"), id, ifMatch);
    }
    return c.body(null, 204);
  })
  .post("/:pay_component_id", async (c) => {
    const lc = await lifecycleVerb(c, { table: schema.payComponents, singular: "pay-component", collection: "pay-components", serialize: toPayComponentResource });
    if (lc) return lc;
    const { id, verb } = customMethod(c);
    if (verb !== "restore") return c.notFound();
    const row = await restorePayComponent(c.get("deps"), c.get("user"), id);
    return c.json(toPayComponentResource(row));
  });

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { customMethod } from "../http/customMethod";
import { lifecycleVerb } from "../http/lifecycleRoute";
import * as schema from "../db/schema";
import { listPayPeriods, getPayPeriod, createPayPeriod, updatePayPeriod, deletePayPeriod, restorePayPeriod, purgePayPeriod } from "../services/payPeriods";
import { toPayPeriodResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";

const writeSchema = z.object({
  display_name: z.string().min(1).optional(),
  period_start: z.string().optional(),
  period_end: z.string().optional(),
  pay_date: z.string().optional(),
}).strict();

export const payPeriods = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listPayPeriods(c.get("deps"), c.get("user"), maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toPayPeriodResource(r), user, "pay-periods", r.code)), next_page_token: nextPageToken });
  })
  .get("/:pay_period_id", async (c) => {
    const row = await getPayPeriod(c.get("deps"), c.get("user"), c.req.param("pay_period_id")!);
    return c.json(toPayPeriodResource(row));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createPayPeriod(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(toPayPeriodResource(row));
  })
  .patch("/:pay_period_id", zValidator("json", writeSchema), async (c) => {
    const row = await updatePayPeriod(c.get("deps"), c.get("user"), c.req.param("pay_period_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(toPayPeriodResource(row));
  })
  .delete("/:pay_period_id", async (c) => {
    const id = c.req.param("pay_period_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") {
      await purgePayPeriod(c.get("deps"), c.get("user"), id, ifMatch);
    } else {
      await deletePayPeriod(c.get("deps"), c.get("user"), id, ifMatch);
    }
    return c.body(null, 204);
  })
  .post("/:pay_period_id", async (c) => {
    const lc = await lifecycleVerb(c, { table: schema.payPeriods, singular: "pay-period", collection: "pay-periods", serialize: toPayPeriodResource });
    if (lc) return lc;
    const { id, verb } = customMethod(c);
    if (verb !== "restore") return c.notFound();
    const row = await restorePayPeriod(c.get("deps"), c.get("user"), id);
    return c.json(toPayPeriodResource(row));
  });

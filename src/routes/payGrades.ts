import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { customMethod } from "../http/customMethod";
import { lifecycleVerb } from "../http/lifecycleRoute";
import * as schema from "../db/schema";
import { listPayGrades, getPayGrade, createPayGrade, updatePayGrade, deletePayGrade, restorePayGrade, purgePayGrade } from "../services/payGrades";
import { toPayGradeResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";

const writeSchema = z.object({
  display_name: z.string().min(1).optional(),
  level: z.number().int().optional(),
  band_min: z.number().min(0).nullable().optional(),
  band_mid: z.number().min(0).nullable().optional(),
  band_max: z.number().min(0).nullable().optional(),
  currency_code: z.string().optional(),
  description: z.string().nullable().optional(),
}).strict();

export const payGrades = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listPayGrades(c.get("deps"), c.get("user"), maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toPayGradeResource(r), user, "pay-grades", r.code)), next_page_token: nextPageToken });
  })
  .get("/:pay_grade_id", async (c) => {
    const row = await getPayGrade(c.get("deps"), c.get("user"), c.req.param("pay_grade_id")!);
    return c.json(toPayGradeResource(row));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createPayGrade(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(toPayGradeResource(row));
  })
  .patch("/:pay_grade_id", zValidator("json", writeSchema), async (c) => {
    const row = await updatePayGrade(c.get("deps"), c.get("user"), c.req.param("pay_grade_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(toPayGradeResource(row));
  })
  .delete("/:pay_grade_id", async (c) => {
    const id = c.req.param("pay_grade_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") {
      await purgePayGrade(c.get("deps"), c.get("user"), id, ifMatch);
    } else {
      await deletePayGrade(c.get("deps"), c.get("user"), id, ifMatch);
    }
    return c.body(null, 204);
  })
  .post("/:pay_grade_id", async (c) => {
    const lc = await lifecycleVerb(c, { table: schema.payGrades, singular: "pay-grade", collection: "pay-grades", serialize: toPayGradeResource });
    if (lc) return lc;
    const { id, verb } = customMethod(c);
    if (verb !== "restore") return c.notFound();
    const row = await restorePayGrade(c.get("deps"), c.get("user"), id);
    return c.json(toPayGradeResource(row));
  });

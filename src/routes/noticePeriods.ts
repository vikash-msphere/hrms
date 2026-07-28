import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { customMethod } from "../http/customMethod";
import {
  listNoticePeriods, getNoticePeriod, createNoticePeriod, updateNoticePeriod,
  deleteNoticePeriod, restoreNoticePeriod, purgeNoticePeriod,
} from "../services/noticePeriods";
import { toNoticePeriodResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";

const COL = "notice-periods";

const writeSchema = z
  .object({
    employee: z.string().nullable().optional(),
    type: z.enum(["resignation", "termination", "retirement", "other"]).optional(),
    notice_date: z.string().optional(),
    last_working_day: z.string().optional(),
    status: z.enum(["serving", "completed", "withdrawn"]).optional(),
    reason: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    start_offboarding: z.boolean().optional(),
    template: z.string().nullable().optional(),
  })
  .strict();

export const noticePeriods = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listNoticePeriods(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("status"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toNoticePeriodResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:notice_period_id", async (c) => {
    const row = await getNoticePeriod(c.get("deps"), c.get("user"), c.req.param("notice_period_id"));
    return c.json(withAccess(toNoticePeriodResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createNoticePeriod(c.get("deps"), c.get("user"), c.req.valid("json"));
    return c.json(withAccess(toNoticePeriodResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .patch("/:notice_period_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateNoticePeriod(c.get("deps"), c.get("user"), c.req.param("notice_period_id"), c.req.valid("json"), c.req.header("If-Match"));
    return c.json(withAccess(toNoticePeriodResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .delete("/:notice_period_id", async (c) => {
    const id = c.req.param("notice_period_id");
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeNoticePeriod(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteNoticePeriod(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:notice_period_id", async (c) => {
    const { id, verb } = customMethod(c);
    if (verb !== "restore") return c.notFound();
    const row = await restoreNoticePeriod(c.get("deps"), c.get("user"), id);
    return c.json(toNoticePeriodResource(row));
  });

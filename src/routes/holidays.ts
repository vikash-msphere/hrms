import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { customMethod } from "../http/customMethod";
import { lifecycleVerb } from "../http/lifecycleRoute";
import * as schema from "../db/schema";
import {
  listHolidays, getHoliday, createHoliday, updateHoliday, deleteHoliday,
  restoreHoliday, purgeHoliday,
} from "../services/holidays";
import { toHolidayResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";

const writeSchema = z
  .object({ display_name: z.string().min(1).optional(), date: z.string().optional(), kind: z.enum(["fixed", "optional"]).optional() })
  .strict();

export const holidays = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listHolidays(c.get("deps"), c.get("user"), maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toHolidayResource(r), user, "holidays", r.code)), next_page_token: nextPageToken });
  })
  .get("/:holiday_id", async (c) => {
    const row = await getHoliday(c.get("deps"), c.get("user"), c.req.param("holiday_id")!);
    return c.json(toHolidayResource(row));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createHoliday(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(toHolidayResource(row));
  })
  .patch("/:holiday_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateHoliday(c.get("deps"), c.get("user"), c.req.param("holiday_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(toHolidayResource(row));
  })
  .delete("/:holiday_id", async (c) => {
    const id = c.req.param("holiday_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") {
      await purgeHoliday(c.get("deps"), c.get("user"), id, ifMatch);
    } else {
      await deleteHoliday(c.get("deps"), c.get("user"), id, ifMatch);
    }
    return c.body(null, 204);
  })
  .post("/:holiday_id", async (c) => {
    const { id, verb } = customMethod(c);
    const deps = c.get("deps");
    const user = c.get("user");
    // Lifecycle + restore are config.write. (Selecting an optional holiday is now POST /holiday-selections.)
    const lc = await lifecycleVerb(c, { table: schema.holidays, singular: "holiday", collection: "holidays", serialize: toHolidayResource });
    if (lc) return lc;
    if (verb !== "restore") return c.notFound();
    const row = await restoreHoliday(deps, user, id);
    return c.json(toHolidayResource(row));
  });

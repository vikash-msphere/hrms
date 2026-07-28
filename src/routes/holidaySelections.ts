import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import {
  listHolidaySelections,
  getHolidaySelection,
  createHolidaySelection,
  deleteHolidaySelection,
} from "../services/holidaySelections";
import { toHolidaySelectionResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";

const writeSchema = z.object({ holiday: z.string().optional() }).strict();

// An employee's optional-holiday picks. Standard create (select) / delete (deselect).
export const holidaySelections = new Hono<AppEnv>()
  .get("/", async (c) => {
    const { items, nextPageToken } = await listHolidaySelections(c.get("deps"), c.get("user"), clampPageSize(Number(c.req.query("max_page_size")) || undefined), c.req.query("page_token"));
    return c.json({ results: items.map(toHolidaySelectionResource), next_page_token: nextPageToken });
  })
  .get("/:selection_id", async (c) => {
    const row = await getHolidaySelection(c.get("deps"), c.get("user"), c.req.param("selection_id"));
    return c.json(toHolidaySelectionResource(row));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createHolidaySelection(c.get("deps"), c.get("user"), c.req.valid("json").holiday);
    return c.json(toHolidaySelectionResource(row));
  })
  .delete("/:selection_id", async (c) => {
    await deleteHolidaySelection(c.get("deps"), c.get("user"), c.req.param("selection_id"));
    return c.body(null, 204);
  });

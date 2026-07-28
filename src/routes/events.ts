import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { customMethod } from "../http/customMethod";
import {
  listEvents, getEvent, createEvent, updateEvent, deleteEvent, restoreEvent, purgeEvent,
} from "../services/events";
import { toEventResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";

const COL = "events";

const writeSchema = z
  .object({
    title: z.string().min(1).optional(),
    start_time: z.string().optional(),
    end_time: z.string().optional(),
    all_day: z.boolean().optional(),
    count_as_work: z.boolean().optional(),
    color: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    attendees: z.array(z.string()).nullable().optional(),
  })
  .strict();

export const events = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listEvents(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toEventResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:event_id", async (c) => {
    const row = await getEvent(c.get("deps"), c.get("user"), c.req.param("event_id")!);
    return c.json(withAccess(toEventResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createEvent(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(withAccess(toEventResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .patch("/:event_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateEvent(c.get("deps"), c.get("user"), c.req.param("event_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(withAccess(toEventResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .delete("/:event_id", async (c) => {
    const id = c.req.param("event_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") {
      await purgeEvent(c.get("deps"), c.get("user"), id, ifMatch);
    } else {
      await deleteEvent(c.get("deps"), c.get("user"), id, ifMatch);
    }
    return c.body(null, 204);
  })
  .post("/:event_id", async (c) => {
    const { id, verb } = customMethod(c);
    if (verb !== "restore") return c.notFound();
    const row = await restoreEvent(c.get("deps"), c.get("user"), id);
    return c.json(withAccess(toEventResource(row), c.get("user"), COL, (row?.code as string | null) ?? null, c.get("objectGrant")));
  });

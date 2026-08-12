import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { eventSpec, listEvents } from "../services/events";
import { toEventResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";

const writeSchema = z
  .object({
    title: z.string().min(1).optional(),
    start_time: z.string().optional(),
    end_time: z.string().optional(),
    all_day: z.boolean().optional(),
    count_as_work: z.boolean().optional(),
    requires_clock_in: z.boolean().optional(),
    color: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    attendees: z.array(z.string()).nullable().optional(),
  })
  .strict();

export const events = collectionRoutes({
  ...eventSpec,
  param: "event_id",
  writeSchema,
  serialize: toEventResource,
  list: (c) =>
    listEvents(
      c.get("deps"),
      c.get("scope"),
      clampPageSize(Number(c.req.query("max_page_size")) || undefined),
      c.req.query("page_token"),
      c.req.query("show_deleted") === "true",
    ),
});

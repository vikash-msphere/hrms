import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { eventSpec, listEvents, respondToEvent } from "../services/events";
import { toEventResource } from "../http/serialize";

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
    repeat: z.enum(["weekly", "monthly", "yearly"]).nullable().optional(),
  })
  .strict();
const respondSchema = z.object({ response: z.enum(["going", "maybe", "declined"]), note: z.string().max(500).nullable().optional() }).strict();

export const events = collectionRoutes({
  ...eventSpec,
  param: "event_id",
  writeSchema,
  serialize: toEventResource,
  verbs: {
    respond: { schema: respondSchema, run: (deps, user, id, body) => respondToEvent(deps, user, id, body.response, body.note) },
  },
  list: (c, page) =>
    listEvents(
      c.get("deps"),
      c.get("scope"),
      page.maxPageSize,
      page.pageToken,
      page.showDeleted,
      page.deletedOnly,
      c.req.query("q"),
    ),
});

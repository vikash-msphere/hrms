import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { checkInSpec, listCheckIns, type CheckInInput } from "../services/checkIns";
import { toCheckInResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";

const actionItem = z.object({ text: z.string(), done: z.boolean().optional() }).strict();
const writeSchema = z.object({
  employee: z.string().nullable().optional(),
  counterpart: z.string().nullable().optional(),
  meeting_date: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  action_items: z.array(actionItem).optional(),
  cadence: z.enum(["weekly", "biweekly", "monthly"]).nullable().optional(),
}).strict();

// 1:1 check-ins. Plain CRUD plus soft delete/restore, all of it the shared lane; the list is the one part that
// is this collection's own, because a page reads newest-meeting-first and is scoped to what the caller may see.
export const checkIns = collectionRoutes<CheckInInput>({
  ...checkInSpec,
  param: "check_in_id",
  writeSchema,
  serialize: toCheckInResource,
  list: (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    return listCheckIns(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("employee"), c.req.query("show_deleted") === "true");
  },
});

import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { checkInSpec, listCheckIns, type CheckInInput } from "../services/checkIns";
import { toCheckInResource } from "../http/serialize";

const actionItem = z.object({ text: z.string(), done: z.boolean().optional() }).strict();
const writeSchema = z.object({
  employee: z.string().nullable().optional(),
  counterpart: z.string().nullable().optional(),
  meeting_date: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  action_items: z.array(actionItem).optional(),
  cadence: z.enum(["weekly", "biweekly", "monthly"]).nullable().optional(),
  // Whose note this is and whether the pulse may be set are decided by the caller's identity, not by the body
  // (services/checkIns.ts) - so there is deliberately no "side" field to spoof here.
  private_note: z.string().max(4000).nullable().optional(),
  pulse: z.number().int().min(1).max(5).nullable().optional(),
}).strict();

// 1:1 check-ins. Plain CRUD plus soft delete/restore, all of it the shared lane; the list is the one part that
// is this collection's own, because a page reads newest-meeting-first and is scoped to what the caller may see.
export const checkIns = collectionRoutes<CheckInInput, typeof schema.checkIns>({
  ...checkInSpec,
  param: "check_in_id",
  writeSchema,
  serialize: toCheckInResource,
  list: (c, page) => listCheckIns(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, c.req.query("employee"), page.showDeleted, page.deletedOnly),
});

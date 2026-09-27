import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { workPatternAssignmentSpec, listWorkPatternAssignments, type WorkPatternAssignmentInput } from "../services/workPatternAssignments";
import { toWorkPatternAssignmentResource } from "../http/serialize";

const writeSchema = z.object({
  employee: z.string().nullable().optional(),
  pattern: z.string().nullable().optional(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  anchor_date: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
}).strict();

// Who is on which schedule, and when. Plain CRUD plus soft delete/restore - the shared lane; the list is the
// collection's own because the roster asks for one employee and/or a date window, and matches that window by
// overlap rather than containment.
export const workPatternAssignments = collectionRoutes<WorkPatternAssignmentInput, typeof schema.workPatternAssignments>({
  ...workPatternAssignmentSpec,
  param: "assignment_id",
  writeSchema,
  serialize: toWorkPatternAssignmentResource,
  list: (c, page) => listWorkPatternAssignments(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, c.req.query("employee"), c.req.query("from"), c.req.query("to"), page.showDeleted, page.deletedOnly),
});

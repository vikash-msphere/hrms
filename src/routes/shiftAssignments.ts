import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { shiftAssignmentSpec, listShiftAssignments, type ShiftAssignmentInput } from "../services/shiftAssignments";
import { toShiftAssignmentResource } from "../http/serialize";

const writeSchema = z.object({
  employee: z.string().nullable().optional(),
  shift: z.string().nullable().optional(),
  kind: z.enum(["shift", "off"]).nullable().optional(),
  date: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
}).strict();

// The roster: who works which shift on which day. Plain CRUD plus soft delete/restore - the shared lane; the
// list is the collection's own because the schedule view asks for one employee and/or a date window.
export const shiftAssignments = collectionRoutes<ShiftAssignmentInput, typeof schema.shiftAssignments>({
  ...shiftAssignmentSpec,
  param: "assignment_id",
  writeSchema,
  serialize: toShiftAssignmentResource,
  list: (c, page) => listShiftAssignments(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, c.req.query("employee"), c.req.query("from"), c.req.query("to"), page.showDeleted, page.deletedOnly),
});

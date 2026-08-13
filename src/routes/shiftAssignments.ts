import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { shiftAssignmentSpec, listShiftAssignments, type ShiftAssignmentInput } from "../services/shiftAssignments";
import { toShiftAssignmentResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";

const writeSchema = z.object({
  employee: z.string().nullable().optional(),
  shift: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
}).strict();

// The roster: who works which shift on which day. Plain CRUD plus soft delete/restore - the shared lane; the
// list is the collection's own because the schedule view asks for one employee and/or a date window.
export const shiftAssignments = collectionRoutes<ShiftAssignmentInput>({
  ...shiftAssignmentSpec,
  param: "assignment_id",
  writeSchema,
  serialize: toShiftAssignmentResource,
  list: (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    return listShiftAssignments(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("employee"), c.req.query("from"), c.req.query("to"), c.req.query("show_deleted") === "true");
  },
});

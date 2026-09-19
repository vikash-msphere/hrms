import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { listDayMarks, createDayMark, notifyDayMarkChanged, removeDayMark, assertSomebodyElse, type DayMarkInput } from "../services/attendanceDayMarks";
import { toAttendanceDayMarkResource } from "../http/serialize";

const createSchema = z
  .object({
    employee: z.string(),
    date: z.string(),
    credit: z.enum(["full", "half", "absent"]),
    reason: z.string().nullable().optional(),
  })
  .strict();

// WHICH PERSON AND WHICH DAY ARE THE MARK'S IDENTITY, not fields of it. Editing means changing the decision,
// never moving it: `date` is what `assertOwedDay` was checked against and what the one-live-mark-per-day index
// is keyed on, and `employee` is embedded in the row's `code`, which is what the list scope binds to - so a
// patch that moved either would leave a mark validated against one day sitting on another, or one counting
// against a person whose department cannot see it. Both stay out of the patch body, and `.strict()` makes
// sending one a 400 rather than a silent no-op. To move a mark, withdraw it and make another.
export const dayMarkUpdateSchema = createSchema.pick({ credit: true, reason: true }).partial().strict();

// What a day is worth, decided by HR rather than derived from the punches. An HR ACTION and not a request, so
// there is no state machine and no approval verb here: the collection is create / update / delete, and the
// grant that reaches it is what decides who may re-value somebody's day. Removing a mark (DELETE) is how the
// day goes back to being judged on its punches, and the table soft-deletes so the decision stays on the
// record - hence `:restore` from the shared lifecycle lane.
//
// `?employee=` and `?from`/`?to` narrow the list within the caller's scope; the edge already decoded the
// query ref, so the id comes off the tail of the path and is not decoded again.
export const attendanceDayMarks = collectionRoutes<DayMarkInput, typeof schema.attendanceDayMarks>({
  table: schema.attendanceDayMarks,
  collection: "attendance-day-marks",
  auditName: "attendance-day-mark",
  notFound: "day mark not found",
  param: "day_mark_id",
  createSchema,
  updateSchema: dayMarkUpdateSchema,
  serialize: toAttendanceDayMarkResource,
  // Without this the factory mounts no PATCH at all (`canUpdate` is `!!spec.patch`), so a mark could only
  // ever be made and withdrawn - which is not what the editor above it offers.
  patch: (input) => ({
    ...(input.credit !== undefined ? { credit: input.credit as "full" | "half" | "absent" } : {}),
    ...(input.reason !== undefined ? { reason: input.reason?.trim() || null } : {}),
  }),
  // Changing a mark changes somebody's pay exactly as much as making one did, and half -> absent is the
  // bigger of the two. Told once at the original decision and never again, the employee would be reading a
  // notification that no longer says what they will be paid. `afterUpdate` runs after the write has
  // committed and after the audit row, so a lost CAS race sends nothing.
  // The same refusal `createDayMark` makes, on the other way in. A mark cannot be MADE on one's own day; left
  // alone, it could still be re-valued there - somebody else marks the holder's day absent and they patch it
  // to a full day, which is the whole decision the create-side rule exists to keep away from them. `employee`
  // is not patchable, so the row's owner is the one the mark was created for.
  beforeUpdate: (_deps, actor, row) => {
    assertSomebodyElse(actor, row.employeeId);
    return Promise.resolve();
  },
  afterUpdate: (deps, actor, row, before) => notifyDayMarkChanged(deps, actor, row, before),
  overrides: {
    create: (deps, actor, input) => createDayMark(deps, actor, input),
    // The lane has no `afterDelete` hook, so the withdrawal is wrapped rather than hooked - it still runs the
    // shared soft-delete underneath (etag, audit, `delete_time`), then tells the employee their day is back
    // on its clocked hours.
    remove: (deps, actor, id, ifMatch) => removeDayMark(deps, actor, id, ifMatch),
  },
  list: (c, page) => {
    const emp = c.req.query("employee");
    return listDayMarks(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, {
      employeeId: emp ? emp.split("/").pop()! : undefined,
      from: c.req.query("from"),
      to: c.req.query("to"),
      showDeleted: page.showDeleted,
      deletedOnly: page.deletedOnly,
    });
  },
});

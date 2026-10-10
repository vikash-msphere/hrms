import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import {
  listTimeEntries, createTimeEntry, updateTimeEntry,
  submitTimeEntry, approveTimeEntry, rejectTimeEntry,
  type TimeEntryInput,
} from "../services/timeEntries";
import { toTimeEntryResource } from "../http/serialize";
import { rejectBody, type RejectBody } from "../http/rejectBody";

const writeSchema = z.object({
  employee: z.string().nullable().optional(),
  project: z.string().nullable().optional(),
  card: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  hours: z.number().optional(),
  description: z.string().nullable().optional(),
  billable: z.boolean().optional(),
}).strict();

// Timesheet entries. Create and update stay the service's own (an entry is only editable while it is a draft,
// and the hours are checked against the day); the three verbs move it through submit -> approve/reject.
export const timeEntries = collectionRoutes<TimeEntryInput, typeof schema.timeEntries>({
  table: schema.timeEntries,
  collection: "time-entries",
  auditName: "time-entry",
  notFound: "time entry not found",
  param: "entry_id",
  writeSchema,
  serialize: toTimeEntryResource,
  overrides: {
    create: (deps, actor, input, id) => createTimeEntry(deps, actor, input, id),
    update: (deps, actor, id, patch, ifMatch) => updateTimeEntry(deps, actor, id, patch, ifMatch),
  },
  list: (c, page) => listTimeEntries(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, c.req.query("employee"), c.req.query("from"), c.req.query("to"), c.req.query("status"), page.showDeleted, page.deletedOnly),
  verbs: {
    submit: { run: (deps, user, id) => submitTimeEntry(deps, user, id) },
    approve: { run: (deps, user, id, _body, c) => approveTimeEntry(deps, user, id, c.req.header("If-Match")) },
    reject: { schema: rejectBody, run: (deps, user, id, body: RejectBody, c) => rejectTimeEntry(deps, user, id, body.reason, c.req.header("If-Match")) },
  },
});

// Statutory compliance calendar service: flat company-wide CRUD + restore over `compliance_events`. NO access
// control here - the middleware gates the collection by path + grants (private by default). Mirrors the
// holidays service. Status is a simple workflow (pending -> filed | waived); marking a row filed without an
// explicit date stamps today.
import { and, isNull } from "drizzle-orm";
import { keysetPage } from "./keysetPage";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { invalidArgument } from "../lib/errors";
import { has, type CrudSpec, type SetOf } from "./crud";
import { idFromPath } from "./documentsCommon";
import { notify } from "./notifications";

const FREQUENCIES = ["one_time", "monthly", "quarterly", "annual"] as const;
const STATUSES = ["pending", "filed", "waived"] as const;
type Frequency = (typeof FREQUENCIES)[number];
type Status = (typeof STATUSES)[number];

export type ComplianceEventInput = {
  title?: string;
  category?: string | null;
  frequency?: Frequency;
  due_date?: string;
  period_label?: string | null;
  status?: Status;
  filed_date?: string | null;
  reference?: string | null;
  /** `org-documents/<id>`: the challan or acknowledgement PDF that proves the filing. */
  document?: string | null;
  assignee?: string | null;
  notes?: string | null;
};

const parseDate = (s: string, field: string): Date => {
  const ms = Date.parse(s.length <= 10 ? s + "T00:00:00Z" : s);
  if (Number.isNaN(ms)) throw invalidArgument(`${field} must be YYYY-MM-DD`);
  return new Date(ms);
};

export async function listComplianceEvents(deps: Deps, scope: ListScope | undefined, maxPageSize: number, pageToken?: string, showDeleted = false) {
  const where = and(showDeleted ? undefined : isNull(schema.complianceEvents.deleteTime), applyScope(scope, schema.complianceEvents.code, schema.complianceEvents.code));
  return keysetPage(deps, schema.complianceEvents, "compliance-events", where, { max: maxPageSize, pageToken });
}

export const complianceEventSpec: CrudSpec<ComplianceEventInput, typeof schema.complianceEvents> = {
  table: schema.complianceEvents,
  collection: "compliance-events",
  auditName: "compliance-event",
  notFound: "compliance event not found",
  insert: (input) => {
    if (!input.title) throw invalidArgument("title is required");
    if (!input.due_date) throw invalidArgument("due_date is required");
    if (input.frequency && !FREQUENCIES.includes(input.frequency)) throw invalidArgument("invalid frequency");
    if (input.status && !STATUSES.includes(input.status)) throw invalidArgument("invalid status");
    const status = input.status ?? "pending";
    return {
      title: input.title,
      // Empty string clears, like an omitted field (see web/src/api.ts: nothing on the wire is ever null).
      category: input.category?.trim() || null,
      frequency: input.frequency ?? "one_time",
      dueDate: parseDate(input.due_date, "due_date"),
      periodLabel: input.period_label?.trim() || null,
      status,
      // Stamp today when created already-filed without an explicit date.
      filedDate: input.filed_date ? parseDate(input.filed_date, "filed_date") : status === "filed" ? new Date() : null,
      reference: input.reference?.trim() || null,
      documentId: idFromPath(input.document) ?? null,
      assigneeId: idFromPath(input.assignee) ?? null,
      notes: input.notes?.trim() || null,
    };
  },
  patch: (patch, row) => {
    const set: SetOf<typeof schema.complianceEvents> = {};
    if (has(patch, "title")) { if (!patch.title) throw invalidArgument("title cannot be empty"); set.title = patch.title; }
    if (has(patch, "category")) set.category = patch.category?.trim() || null;
    if (has(patch, "frequency")) { if (patch.frequency && !FREQUENCIES.includes(patch.frequency)) throw invalidArgument("invalid frequency"); set.frequency = patch.frequency; }
    if (has(patch, "due_date") && patch.due_date) set.dueDate = parseDate(patch.due_date, "due_date");
    if (has(patch, "period_label")) set.periodLabel = patch.period_label?.trim() || null;
    if (has(patch, "reference")) set.reference = patch.reference?.trim() || null;
    if (has(patch, "document")) set.documentId = idFromPath(patch.document) ?? null;
    if (has(patch, "assignee")) set.assigneeId = idFromPath(patch.assignee) ?? null;
    if (has(patch, "notes")) set.notes = patch.notes?.trim() || null;
    if (has(patch, "status")) {
      if (patch.status && !STATUSES.includes(patch.status)) throw invalidArgument("invalid status");
      set.status = patch.status;
      // Moving to filed without an explicit filed_date stamps today; leaving filed clears the date.
      if (patch.status === "filed" && !has(patch, "filed_date") && !row.filedDate) set.filedDate = new Date();
      if (patch.status && patch.status !== "filed" && !has(patch, "filed_date")) set.filedDate = null;
    }
    if (has(patch, "filed_date")) set.filedDate = patch.filed_date ? parseDate(patch.filed_date, "filed_date") : null;
    return set;
  },
  // Notify the assignee they own this filing (skip self-assignment).
  afterCreate: async (deps, actor, row, input) => {
    if (row.assigneeId && row.assigneeId !== actor.employeeId)
      await notify(deps, { recipient: row.assigneeId, type: "compliance.assigned", title: "Compliance filing assigned", body: `${row.title} - due ${input.due_date}.`, link: "compliance", subject: `compliance-events/${row.uuid}`, actorId: actor.employeeId });
  },
};


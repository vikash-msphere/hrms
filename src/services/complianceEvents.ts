// Statutory compliance calendar service: flat company-wide CRUD + restore over `compliance_events`. NO access
// control here - the middleware gates the collection by path + grants (private by default). Mirrors the
// holidays service. Status is a simple workflow (pending -> filed | waived); marking a row filed without an
// explicit date stamps today.
import { and, eq, isNull } from "drizzle-orm";
import { allocFlatCode } from "./codeAlloc";
import { keysetPage } from "./keysetPage";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, diffMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted } from "../lib/errors";
import { etagOf } from "../http/serialize";
import { softDeleteRow, restoreRow, purgeRow } from "./softDelete";
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
  return keysetPage(deps, schema.complianceEvents, "compliance-events", where, { dir: "asc", max: maxPageSize, pageToken });
}

export async function getComplianceEvent(deps: Deps, id: string) {
  const row = (await deps.db.select().from(schema.complianceEvents).where(eq(schema.complianceEvents.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("compliance event not found");
  return row;
}

export async function createComplianceEvent(deps: Deps, actor: AppUser, input: ComplianceEventInput, id?: string) {
  if (!input.title) throw invalidArgument("title is required");
  if (!input.due_date) throw invalidArgument("due_date is required");
  if (input.frequency && !FREQUENCIES.includes(input.frequency)) throw invalidArgument("invalid frequency");
  if (input.status && !STATUSES.includes(input.status)) throw invalidArgument("invalid status");
  const status = input.status ?? "pending";
  const row = (await deps.db
    .insert(schema.complianceEvents)
    .values({
      code: await allocFlatCode(deps, schema.complianceEvents),
      ...(id ? { uuid: id } : {}),
      title: input.title,
      category: input.category ?? null,
      frequency: input.frequency ?? "one_time",
      dueDate: parseDate(input.due_date, "due_date"),
      periodLabel: input.period_label ?? null,
      status,
      // Stamp today when created already-filed without an explicit date.
      filedDate: input.filed_date ? parseDate(input.filed_date, "filed_date") : status === "filed" ? new Date() : null,
      reference: input.reference ?? null,
      assigneeId: idFromPath(input.assignee) ?? null,
      notes: input.notes ?? null,
    })
    .returning())[0]!;
  await audit(deps, actor, "compliance-event.create", "compliance-events", row.uuid, undefined, row);
  // Notify the assignee they own this filing (skip self-assignment).
  if (row.assigneeId && row.assigneeId !== actor.employeeId)
    await notify(deps, { recipient: row.assigneeId, type: "compliance.assigned", title: "Compliance filing assigned", body: `${row.title} - due ${input.due_date}.`, link: "compliance", subject: `compliance-events/${row.uuid}`, actorId: actor.employeeId });
  return row;
}

export async function updateComplianceEvent(deps: Deps, actor: AppUser, id: string, patch: ComplianceEventInput, ifMatch?: string) {
  const row = await getComplianceEvent(deps, id);
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const has = (k: keyof ComplianceEventInput) => Object.prototype.hasOwnProperty.call(patch, k);
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (has("title")) { if (!patch.title) throw invalidArgument("title cannot be empty"); set.title = patch.title; }
  if (has("category")) set.category = patch.category ?? null;
  if (has("frequency")) { if (patch.frequency && !FREQUENCIES.includes(patch.frequency)) throw invalidArgument("invalid frequency"); set.frequency = patch.frequency; }
  if (has("due_date") && patch.due_date) set.dueDate = parseDate(patch.due_date, "due_date");
  if (has("period_label")) set.periodLabel = patch.period_label ?? null;
  if (has("reference")) set.reference = patch.reference ?? null;
  if (has("assignee")) set.assigneeId = idFromPath(patch.assignee) ?? null;
  if (has("notes")) set.notes = patch.notes ?? null;
  if (has("status")) {
    if (patch.status && !STATUSES.includes(patch.status)) throw invalidArgument("invalid status");
    set.status = patch.status;
    // Moving to filed without an explicit filed_date stamps today; leaving filed clears the date.
    if (patch.status === "filed" && !has("filed_date") && !row.filedDate) set.filedDate = new Date();
    if (patch.status && patch.status !== "filed" && !has("filed_date")) set.filedDate = null;
  }
  if (has("filed_date")) set.filedDate = patch.filed_date ? parseDate(patch.filed_date, "filed_date") : null;
  const updated = (await deps.db.update(schema.complianceEvents).set(set).where(eq(schema.complianceEvents.uuid, id)).returning())[0]!;
  await audit(deps, actor, "compliance-event.update", "compliance-events", id, diffMeta(row, updated, set), updated);
  return updated;
}

export const deleteComplianceEvent = (deps: Deps, actor: AppUser, id: string, ifMatch?: string) =>
  softDeleteRow(deps, actor, schema.complianceEvents, "compliance event", "compliance-events", id, ifMatch);
export const restoreComplianceEvent = (deps: Deps, actor: AppUser, id: string) =>
  restoreRow(deps, actor, schema.complianceEvents, "compliance event", "compliance-events", id);
export const purgeComplianceEvent = (deps: Deps, actor: AppUser, id: string, ifMatch?: string) =>
  purgeRow(deps, actor, schema.complianceEvents, "compliance event", "compliance-events", id, ifMatch);

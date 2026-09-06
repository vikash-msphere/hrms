import { eq, and, gte, lte } from "drizzle-orm";
import { allocOwnedCode, withFreshCode } from "./codeAlloc";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, createdMeta, diffMeta, stateMeta } from "../lib/audit";
import { notify, notifyManager } from "./notifications";
import { invalidArgument, notFound, aborted, failedPrecondition } from "../lib/errors";
import { paginate } from "../http/pagination";
import { etagOf } from "../http/serialize";

type Status = typeof schema.timeEntries.$inferSelect.status;
export type TimeEntryInput = {
  employee?: string | null;
  project?: string | null;
  date?: string | null;
  hours?: number;
  description?: string | null;
  billable?: boolean;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string | null) => (s ? Date.parse(s + "T00:00:00Z") : NaN);

export async function listTimeEntries(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, employee?: string, from?: string, to?: string, status?: string, showDeleted = false) {
  const conds = [applyScope(scope, schema.timeEntries.code, schema.timeEntries.employeeId)];
  const empId = idFromPath(employee);
  if (empId) conds.push(eq(schema.timeEntries.employeeId, empId));
  if (status) conds.push(eq(schema.timeEntries.status, status as Status));
  if (from && !Number.isNaN(dayMs(from))) conds.push(gte(schema.timeEntries.date, new Date(dayMs(from))));
  if (to && !Number.isNaN(dayMs(to))) conds.push(lte(schema.timeEntries.date, new Date(dayMs(to) + 86_399_999)));
  const all = (await deps.db.select().from(schema.timeEntries).where(conds.filter(Boolean).length ? and(...conds.filter(Boolean)) : undefined))
    .filter((e) => showDeleted || !e.deleteTime);
  // Paged on `createdAt`, which is what the cursor carries. It used to page a set pre-sorted by `date` while
  // seeking on `createdAt`: two different orders, so the seek could land past rows that had never been returned
  // and they vanished from the listing (the same defect test/paginateOrder.test.ts pins for the tiebreaker).
  // The worked day is a PRESENTATION order, so it is applied to the page that came back, below.
  const page = paginate(all, maxPageSize, pageToken, (r) => +new Date(r.createdAt), (r) => r.uuid);
  return { ...page, items: page.items.sort((a, b) => +new Date(b.date) - +new Date(a.date) || a.uuid.localeCompare(b.uuid)) };
}


export async function createTimeEntry(deps: Deps, actor: AppUser, input: TimeEntryInput, id?: string) {
  const employeeId = idFromPath(input.employee) ?? actor.employeeId;
  if (!employeeId) throw invalidArgument("employee is required");
  const projectId = idFromPath(input.project);
  if (!projectId) throw invalidArgument("project is required");
  const ms = dayMs(input.date);
  if (Number.isNaN(ms)) throw invalidArgument("date is required");
  if (input.hours != null && (typeof input.hours !== "number" || input.hours < 0 || input.hours > 24)) throw invalidArgument("hours must be between 0 and 24");
  // Allocated inside the retry: a timesheet is filled in a burst of rows (codeAlloc.ts).
  const row = (await withFreshCode(async () => deps.db.insert(schema.timeEntries).values({
    code: await allocOwnedCode(deps, schema.timeEntries, schema.timeEntries.employeeId, employeeId),
    ...(id ? { uuid: id } : {}),
    employeeId,
    projectId,
    date: new Date(ms),
    hours: input.hours ?? 0,
    description: input.description?.trim() || null,
    billable: input.billable ?? true,
  }).returning()))[0]!;
  await audit(deps, actor, "time-entry.create", "time-entries", row.uuid, createdMeta(row, "time-entries"), row);
  return row;
}

export async function updateTimeEntry(deps: Deps, actor: AppUser, id: string, patch: TimeEntryInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.timeEntries).where(eq(schema.timeEntries.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("time entry not found");
  if (row.status === "APPROVED") throw failedPrecondition("an approved entry can't be edited");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: SetOf<typeof schema.timeEntries> = { updatedAt: new Date() };
  const has = (k: keyof TimeEntryInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("project")) { const p = idFromPath(patch.project); if (!p) throw invalidArgument("project is required"); set.projectId = p; }
  if (has("date")) { const ms = dayMs(patch.date); if (Number.isNaN(ms)) throw invalidArgument("date is invalid"); set.date = new Date(ms); }
  if (has("hours")) { if (patch.hours == null || patch.hours < 0 || patch.hours > 24) throw invalidArgument("hours must be between 0 and 24"); set.hours = patch.hours; }
  if (has("description")) set.description = patch.description?.trim() || null;
  if (has("billable")) set.billable = !!patch.billable;
  const updated = (await deps.db.update(schema.timeEntries).set(set).where(eq(schema.timeEntries.uuid, id)).returning())[0]!;
  await audit(deps, actor, "time-entry.update", "time-entries", id, diffMeta(row, updated, set, "time-entries"), updated);
  return updated;
}

// Workflow transitions. submit (DRAFT/REJECTED -> SUBMITTED), approve / reject (SUBMITTED -> APPROVED/REJECTED).
async function transition(deps: Deps, actor: AppUser, id: string, allowedFrom: Status[], to: Status, decided: boolean) {
  const row = (await deps.db.select().from(schema.timeEntries).where(eq(schema.timeEntries.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("time entry not found");
  if (!allowedFrom.includes(row.status)) throw failedPrecondition(`a ${row.status.toLowerCase()} entry can't move to ${to.toLowerCase()}`);
  // Guard the flip on the read status so the transition is EXACTLY-ONCE (0 rows = a concurrent call moved it).
  const updated = (await deps.db.update(schema.timeEntries).set({ status: to, ...(decided ? { decidedBy: actor.uuid } : {}), updatedAt: new Date() }).where(and(eq(schema.timeEntries.uuid, id), eq(schema.timeEntries.status, row.status))).returning())[0];
  if (!updated) throw failedPrecondition(`a ${row.status.toLowerCase()} entry can't move to ${to.toLowerCase()}`);
  await audit(deps, actor, `time-entry.${to.toLowerCase()}`, "time-entries", id, stateMeta(row.status, to, { employee: `employees/${row.employeeId}` }), updated);
  if (to === "APPROVED" || to === "REJECTED") {
    await notify(deps, { recipient: row.employeeId, type: `timesheet.${to.toLowerCase()}`, title: `Timesheet ${to.toLowerCase()}`, body: `Your time entry was ${to.toLowerCase()}.`, link: "timesheets", actorId: actor.employeeId });
  } else if (to === "SUBMITTED") {
    // A submitted timesheet needs the manager's review.
    await notifyManager(deps, row.employeeId, { type: "timesheet.requested", noun: "timesheet" });
  }
  return updated;
}
export const submitTimeEntry = (deps: Deps, actor: AppUser, id: string) => transition(deps, actor, id, ["DRAFT", "REJECTED"], "SUBMITTED", false);
export const approveTimeEntry = (deps: Deps, actor: AppUser, id: string) => transition(deps, actor, id, ["SUBMITTED"], "APPROVED", true);
export const rejectTimeEntry = (deps: Deps, actor: AppUser, id: string) => transition(deps, actor, id, ["SUBMITTED"], "REJECTED", true);


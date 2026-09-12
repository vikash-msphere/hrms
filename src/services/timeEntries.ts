import { eq, and, gte, lte, isNull, type SQL } from "drizzle-orm";
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
import { keysetPage } from "./keysetPage";
import { etagOf } from "../http/serialize";
import { checkEtag, updateAtVersion } from "./versionGuard";

type Status = typeof schema.timeEntries.$inferSelect.status;
export type TimeEntryInput = {
  employee?: string | null;
  project?: string | null;
  card?: string | null; // the board task inside that project, when the work is tracked as one
  date?: string | null;
  hours?: number;
  description?: string | null;
  billable?: boolean;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string | null) => (s ? Date.parse(s + "T00:00:00Z") : NaN);

async function assertActiveProject(deps: Deps, projectId: string) {
  const project = (await deps.db.select().from(schema.projects).where(eq(schema.projects.uuid, projectId)).limit(1))[0];
  if (!project || project.deleteTime) throw invalidArgument("project not found");
  if (project.status === "archived") throw failedPrecondition("can't log time against an archived project");
}

/**
 * The board task an hour went into, if any.
 *
 * Deliberately NOT checked against the project: a card belongs to a board and a board is not tied to a
 * project, so demanding they agree would invent a relationship the data model does not have and reject
 * honest entries. What is checked is that the card exists and is live - a deleted task cannot have received
 * work this morning.
 */
async function assertLiveCard(deps: Deps, cardId: string) {
  const card = (await deps.db.select({ del: schema.cards.deleteTime }).from(schema.cards).where(eq(schema.cards.uuid, cardId)).limit(1))[0];
  if (!card || card.del) throw invalidArgument("task not found");
}

export async function listTimeEntries(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, employee?: string, from?: string, to?: string, status?: string, showDeleted = false) {
  const conds = [applyScope(scope, schema.timeEntries.code, schema.timeEntries.employeeId)];
  const empId = idFromPath(employee);
  if (empId) conds.push(eq(schema.timeEntries.employeeId, empId));
  if (status) conds.push(eq(schema.timeEntries.status, status as Status));
  if (from && !Number.isNaN(dayMs(from))) conds.push(gte(schema.timeEntries.date, new Date(dayMs(from))));
  if (to && !Number.isNaN(dayMs(to))) conds.push(lte(schema.timeEntries.date, new Date(dayMs(to) + 86_399_999)));
  if (!showDeleted) conds.push(isNull(schema.timeEntries.deleteTime));
  // Paged in SQL (services/keysetPage.ts), on `createdAt` - which is what the cursor carries. It used to read
  // EVERY entry the filters matched and slice one page out of it in the isolate, which for a caller with no
  // `?employee` filter is the whole table: `time_entries` grows as headcount x working days, and D1 bills the
  // rows a query reads, so the cost of one 50-row page climbed forever while the answer stayed the same size.
  // The soft-delete filter moved into the WHERE with it, for the same reason - filtering it afterwards still
  // read the deleted rows.
  //
  // The worked day is a PRESENTATION order, applied to the page that came back, below. It must not become the
  // paging order: sorting the set by `date` while seeking on `createdAt` is two different orders, so the seek
  // lands past rows that were never returned and they vanish from the listing (test/paginateOrder.test.ts).
  const page = await keysetPage<typeof schema.timeEntries.$inferSelect>(deps, schema.timeEntries, "time-entries", and(...(conds.filter(Boolean) as SQL[])), { dir: "desc", max: maxPageSize, pageToken });
  return { ...page, items: page.items.sort((a, b) => +new Date(b.date) - +new Date(a.date) || a.uuid.localeCompare(b.uuid)) };
}


export async function createTimeEntry(deps: Deps, actor: AppUser, input: TimeEntryInput, id?: string) {
  const employeeId = idFromPath(input.employee) ?? actor.employeeId;
  if (!employeeId) throw invalidArgument("employee is required");
  const projectId = idFromPath(input.project);
  if (!projectId) throw invalidArgument("project is required");
  await assertActiveProject(deps, projectId);
  const cardId = idFromPath(input.card);
  if (cardId) await assertLiveCard(deps, cardId);
  const ms = dayMs(input.date);
  if (Number.isNaN(ms)) throw invalidArgument("date is required");
  if (input.hours != null && (typeof input.hours !== "number" || input.hours < 0 || input.hours > 24)) throw invalidArgument("hours must be between 0 and 24");
  // Allocated inside the retry: a timesheet is filled in a burst of rows (codeAlloc.ts).
  const row = (await withFreshCode(async () => deps.db.insert(schema.timeEntries).values({
    code: await allocOwnedCode(deps, schema.timeEntries, schema.timeEntries.employeeId, employeeId),
    ...(id ? { uuid: id } : {}),
    employeeId,
    projectId,
    cardId: cardId ?? null,
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
  checkEtag(row, ifMatch);
  const set: SetOf<typeof schema.timeEntries> = { updatedAt: new Date() };
  const has = (k: keyof TimeEntryInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("project")) { const p = idFromPath(patch.project); if (!p) throw invalidArgument("project is required"); await assertActiveProject(deps, p); set.projectId = p; }
  if (has("card")) { const c = idFromPath(patch.card); if (c) await assertLiveCard(deps, c); set.cardId = c ?? null; }
  if (has("date")) { const ms = dayMs(patch.date); if (Number.isNaN(ms)) throw invalidArgument("date is invalid"); set.date = new Date(ms); }
  if (has("hours")) { if (patch.hours == null || patch.hours < 0 || patch.hours > 24) throw invalidArgument("hours must be between 0 and 24"); set.hours = patch.hours; }
  if (has("description")) set.description = patch.description?.trim() || null;
  if (has("billable")) set.billable = !!patch.billable;
  const updated = await updateAtVersion(deps, schema.timeEntries, "time entry", row, set);
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


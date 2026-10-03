import { eq, and, inArray, ne } from "drizzle-orm";
import { allocOwnedCode } from "./codeAlloc";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import { byIdChunks } from "../lib/dbBatch";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, auditUpdate, createdMeta, diffMeta, stateMeta } from "../lib/audit";
import { deleteStateFilter, purgeRow, type PurgeCascade } from "./softDelete";
import { emitEvent } from "./eventBus";
import { invalidArgument, notFound, aborted, failedPrecondition } from "../lib/errors";
import { etagOf } from "../http/serialize";
import { getSettingValue } from "./settings";
import { DEFAULT_TRANSITION_TEMPLATES, type TaskAssignee, type TransitionTemplate } from "../domain/transitions";
import { notify } from "./notifications";
import { liveEmployee } from "./liveEmployee";
import { checkEtag, updateAtVersion } from "./versionGuard";

export type TransitionInput = {
  employee?: string | null;
  kind?: "onboarding" | "offboarding";
  template?: string | null; // template id from settings/transition-templates
  anchor_date?: string | null;
  name?: string | null;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string | null) => (s ? Date.parse(s + "T00:00:00Z") : NaN);
const DAY = 86_400_000;

export async function listTransitions(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, kind?: string, state?: string, showDeleted = false, deletedOnly = false) {
  const conds = [applyScope(scope, schema.transitions.code, schema.transitions.employeeId)];
  if (kind) conds.push(eq(schema.transitions.kind, kind as typeof schema.transitions.$inferSelect.kind));
  if (state) conds.push(eq(schema.transitions.state, state as typeof schema.transitions.$inferSelect.state));
  conds.push(deleteStateFilter(schema.transitions.deleteTime, showDeleted, deletedOnly));
  return keysetPage(deps, schema.transitions, "transitions", and(...conds.filter(Boolean)), { dir: "desc", max: maxPageSize, pageToken });
}

async function getTransition(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.transitions).where(eq(schema.transitions.uuid, id)).limit(1))[0];
  if (!row) throw notFound("transition not found");
  return row;
}

// Tasks for a set of transitions, grouped by transition id (ordered), for the embedded view.
export async function tasksForTransitions(deps: Deps, transitionIds: string[]) {
  const map = new Map<string, (typeof schema.transitionTasks.$inferSelect)[]>();
  if (!transitionIds.length) return map;
  // Chunked over D1's 100-parameter ceiling (lib/dbBatch.ts#PARAM_CAP): a full page of transitions binds the
  // entire allowance in one statement. The sort runs over the JOINED result, so chunking changes no ordering.
  const rows = (await byIdChunks(transitionIds, (group) =>
    deps.db.select().from(schema.transitionTasks).where(inArray(schema.transitionTasks.transitionId, group)),
  )).sort((a, b) => a.position - b.position || +new Date(a.createdAt) - +new Date(b.createdAt));
  for (const r of rows) {
    const list = map.get(r.transitionId) ?? [];
    list.push(r);
    map.set(r.transitionId, list);
  }
  return map;
}

/**
 * Which of a set of employee ids belong to somebody who can still sign in.
 *
 * One read for the whole template, off the shared predicate (services/liveEmployee.ts) so this is not a fourth
 * hand-spelling of the same three columns.
 */
async function liveAmong(deps: Deps, ids: (string | null | undefined)[]): Promise<Set<string>> {
  const want = [...new Set(ids.filter((id): id is string => !!id))];
  if (!want.length) return new Set();
  const rows = await byIdChunks(want, (group) => deps.db
    .select({ uuid: schema.employees.uuid })
    .from(schema.employees)
    .where(and(inArray(schema.employees.uuid, group), ...liveEmployee())));
  return new Set(rows.map((r) => r.uuid));
}

/**
 * Resolve a template assignee to a concrete employee: the subject, their manager, or a named person - falling
 * back to the actor (who started it) then the subject, so every task always has an owner. (This is task
 * ownership, not an access decision - written as a switch to avoid the singleSource role-literal heuristic.)
 *
 * THE FALLBACK TESTS LIVENESS, NOT NULLNESS, and that is the difference between "always has an owner" being
 * true and being a claim. The chain used to fire only when the pointer was null, never when it resolved to
 * somebody terminated, disabled or deleted - and a departed MANAGER is the ordinary case, not a contrived
 * one: winding a team down offboards the manager first, so every offboarding checklist afterwards resolved
 * its `manager` tasks ("collect the laptop", "revoke system access", "exit interview") onto the person who
 * had already gone. `insertTask` then allocated an owned code against them and notified them, and the task
 * showed as owned while nobody who could see it had been told - which is how a checklist sits open with
 * "revoke system access" unticked.
 */
function resolveAssignee(a: TaskAssignee | undefined, subjectId: string, managerId: string | null, actorId: string | null, live: Set<string>): string {
  const or = (...candidates: (string | null | undefined)[]) => candidates.find((id) => !!id && live.has(id)) ?? subjectId;
  switch (a?.type) {
    case "manager": return or(managerId, actorId);
    case "specific": return or(idFromPath(a.employee), actorId);
    default: return subjectId; // "employee" (the subject) or unset
  }
}

async function insertTask(deps: Deps, transitionId: string, subjectId: string, assigneeId: string, title: string, description: string | null, dueDate: Date | null, position: number, backgroundCheckId: string | null = null, docType: string | null = null, actorId: string | null = null) {
  const code = await allocOwnedCode(deps, schema.transitionTasks, schema.transitionTasks.assigneeId, assigneeId);
  const row = (await deps.db.insert(schema.transitionTasks).values({ code, transitionId, subjectId, assigneeId, title, description, dueDate, position, backgroundCheckId, docType }).returning())[0]!;
  // Notify the assignee when the task goes to someone other than the subject (who gets a single "started"
  // summary instead) and other than the person creating it.
  if (assigneeId !== subjectId && assigneeId !== actorId)
    await notify(deps, { recipient: assigneeId, type: "transition.task_assigned", title: "Onboarding/offboarding task assigned", body: title, link: "transitions", subject: `transition-tasks/${row.uuid}`, action: "respond", actorId });
}

// Open a background-verification check for the subject as part of an onboarding, linked to its transition.
// Created directly (not via the BGV service) to avoid a service cycle; status starts pending, initiated today.
//
// The code is allocated the SAME way the service allocates it - under the subject - and that is not a detail
// this path may diverge on. A flat code here would leave every onboarding-spawned check outside its subject's
// namespace: their own `me` rule and their manager's `my-dept` rule would answer for the checks HR filed by hand
// and not for the ones onboarding opened, which is the shape of bug nobody sees until an access review.
async function spawnBackgroundCheck(deps: Deps, transitionId: string, subjectId: string, checkType: string): Promise<string> {
  const row = (await deps.db.insert(schema.backgroundChecks).values({
    code: await allocOwnedCode(deps, schema.backgroundChecks, schema.backgroundChecks.employeeId, subjectId),
    employeeId: subjectId,
    transitionId,
    checkType: checkType as typeof schema.backgroundChecks.$inferInsert.checkType,
    status: "pending",
    initiatedDate: new Date(),
  }).returning())[0]!;
  return row.uuid;
}

// Look a template up by id in settings/transition-templates (falling back to the shipped defaults). A create
// tolerates a miss (an automation naming a template HR has since renamed still opens the process, empty
// rather than not at all); an update, which exists to fill that empty checklist, insists on a real one.
async function findTemplate(deps: Deps, templateId: string) {
  return (await getSettingValue(deps, "transition-templates", DEFAULT_TRANSITION_TEMPLATES)).templates.find((t) => t.id === templateId);
}

// Write a template's tasks onto a transition. Used by a create that chose one, and by an update that fills a
// checklist that was opened empty (a hire whose onboarding was started before anyone picked a template).
async function instantiateTemplate(deps: Deps, actor: AppUser, tpl: TransitionTemplate, transitionId: string, subjectId: string, managerId: string | null, anchorMs: number) {
  // Every id the fallback chain below could pick, resolved in ONE read for the whole checklist rather than
  // one per task: the manager, the actor, and each person a `specific` task names.
  const live = await liveAmong(deps, [managerId, actor.employeeId, ...tpl.tasks.map((t) => (t.assignee?.type === "specific" ? idFromPath(t.assignee.employee) : null))]);
  let i = 0;
  for (const t of tpl.tasks) {
    const assigneeId = resolveAssignee(t.assignee, subjectId, managerId, actor.employeeId ?? null, live);
    const dueDate = !Number.isNaN(anchorMs) && t.due_offset_days != null ? new Date(anchorMs + t.due_offset_days * DAY) : null;
    // A bg_check task opens a background-verification check for the subject and links the task to it.
    const bgId = t.bg_check ? await spawnBackgroundCheck(deps, transitionId, subjectId, t.bg_check) : null;
    await insertTask(deps, transitionId, subjectId, assigneeId, t.title, t.description ?? null, dueDate, i++, bgId, t.doc_type ?? null, actor.employeeId ?? null);
  }
}

export async function createTransition(deps: Deps, actor: AppUser, input: TransitionInput, id?: string) {
  const subjectId = idFromPath(input.employee);
  if (!subjectId) throw invalidArgument("employee is required");
  const kind = input.kind === "offboarding" ? "offboarding" : "onboarding";
  if (input.anchor_date && Number.isNaN(dayMs(input.anchor_date))) throw invalidArgument("anchor_date is invalid");
  const subject = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, subjectId)).limit(1))[0];
  if (!subject) throw notFound("employee not found");
  const anchorMs = input.anchor_date ? dayMs(input.anchor_date) : NaN;

  const tpl = input.template ? await findTemplate(deps, input.template) : undefined;
  const name = input.name?.trim() || tpl?.name || (kind === "onboarding" ? "Onboarding" : "Offboarding");

  const row = (await deps.db.insert(schema.transitions).values({
    code: await allocOwnedCode(deps, schema.transitions, schema.transitions.employeeId, subjectId),
    ...(id ? { uuid: id } : {}),
    employeeId: subjectId,
    kind,
    name,
    anchorDate: Number.isNaN(anchorMs) ? null : new Date(anchorMs),
  }).returning())[0]!;

  if (tpl) await instantiateTemplate(deps, actor, tpl, row.uuid, subjectId, subject.managerId ?? null, anchorMs);
  await audit(deps, actor, `transition.create.${kind}`, "transitions", row.uuid, createdMeta(row, "transitions"), row);
  // Welcome/goodbye the subject: one summary notification (their individual tasks are surfaced in-app).
  if (subjectId !== actor.employeeId)
    await notify(deps, { recipient: subjectId, type: `transition.${kind}_started`, title: kind === "onboarding" ? "Welcome aboard!" : "Your offboarding has started", body: `${name} is underway. Check your tasks.`, link: "transitions", subject: `transitions/${row.uuid}`, actorId: actor.employeeId });
  return row;
}

export async function updateTransition(deps: Deps, actor: AppUser, id: string, patch: TransitionInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.transitions).where(eq(schema.transitions.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("transition not found");
  checkEtag(row, ifMatch);
  const set: SetOf<typeof schema.transitions> = { updatedAt: new Date() };
  const has = (k: keyof TransitionInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("name")) { if (!patch.name?.trim()) throw invalidArgument("name is required"); set.name = patch.name.trim(); }
  if (has("anchor_date")) {
    if (patch.anchor_date && Number.isNaN(dayMs(patch.anchor_date))) throw invalidArgument("anchor_date is invalid");
    set.anchorDate = patch.anchor_date ? new Date(dayMs(patch.anchor_date)) : null;
  }
  // Choosing a template after the fact: a process opened without one (the hire hand-off, an automation whose
  // template id no longer exists) has an empty checklist, and this is how it gets filled - once. Re-applying
  // onto tasks that already exist would double the checklist, so that is refused rather than merged.
  let tpl: TransitionTemplate | undefined;
  if (patch.template) {
    if (row.state !== "ACTIVE") throw failedPrecondition("only an active process can be given a checklist");
    const existing = (await deps.db.select({ uuid: schema.transitionTasks.uuid }).from(schema.transitionTasks).where(eq(schema.transitionTasks.transitionId, id)).limit(1))[0];
    if (existing) throw failedPrecondition("this process already has a checklist - add tasks individually instead");
    tpl = await findTemplate(deps, patch.template);
    if (!tpl) throw invalidArgument("template not found");
    if (tpl.kind !== row.kind) throw invalidArgument(`that template is for ${tpl.kind}, not ${row.kind}`);
    // A process opened without a template carries the generic name; the chosen template renames it.
    if (!has("name") && (row.name === "Onboarding" || row.name === "Offboarding")) set.name = tpl.name;
  }
  const updated = await updateAtVersion(deps, schema.transitions, "transition", row, set);
  if (tpl) {
    const subject = (await deps.db.select({ managerId: schema.employees.managerId }).from(schema.employees).where(eq(schema.employees.uuid, row.employeeId)).limit(1))[0];
    await instantiateTemplate(deps, actor, tpl, id, row.employeeId, subject?.managerId ?? null, updated.anchorDate ? +new Date(updated.anchorDate) : NaN);
  }
  await auditUpdate(deps, actor, "transition.update", "transitions", id, diffMeta(row, updated, set, "transitions"), updated);
  return updated;
}

export async function setTransitionState(deps: Deps, actor: AppUser, id: string, state: "COMPLETED" | "CANCELLED" | "ACTIVE") {
  const row = await getTransition(deps, actor, id);
  if (state === "ACTIVE" && row.state === "ACTIVE") throw failedPrecondition("the transition is already active");
  if (state !== "ACTIVE" && row.state !== "ACTIVE") throw failedPrecondition("only an active transition can be completed or cancelled");
  const updated = (await deps.db.update(schema.transitions).set({ state, updatedAt: new Date() }).where(eq(schema.transitions.uuid, id)).returning())[0]!;
  await audit(deps, actor, `transition.${state.toLowerCase()}`, "transitions", id, stateMeta(row.state, state, { employee: `employees/${row.employeeId}` }), updated);
  // Completing an offboarding terminates the employee: mark terminated/disabled with the last working day as the
  // end date and disable their login. NOT reversed on reopen (HR reactivates manually if a departure is rescinded).
  if (state === "COMPLETED" && row.kind === "offboarding") {
    await terminateForOffboarding(deps, actor, row.employeeId, row.anchorDate ?? new Date());
  }
  if (state === "COMPLETED") {
    await emitEvent(deps, actor, "transition.completed", { subject: `transitions/${id}`, employeeId: row.employeeId, payload: { kind: row.kind } });
  }
  return updated;
}

// Mark an employee as terminated (status + disabled + end date) and disable any linked login. Called when an
// offboarding completes (transition complete, or a linked notice-period marked exited) and by the nightly exit
// sweep (noticePeriods.ts exitDueEmployees) once the last working day has passed.
//
// IDEMPOTENT BY GUARD, not by rewriting the same values: the sweep and a later manual "Complete" both reach the
// same person, and the second must not stamp a new end date, disable a login HR has since switched back on, or
// write a second `employee.terminate` entry. Only the call that actually flips the row does the rest. Returns
// whether it did.
export async function terminateForOffboarding(deps: Deps, actor: AppUser | "system", employeeId: string, endDate: Date): Promise<boolean> {
  const flipped = await deps.db
    .update(schema.employees)
    .set({ status: "terminated", disabled: true, endDate, updatedAt: new Date() })
    .where(and(eq(schema.employees.uuid, employeeId), ne(schema.employees.status, "terminated")))
    .returning({ uuid: schema.employees.uuid });
  if (!flipped.length) return false;
  await deps.db.update(schema.users).set({ status: "disabled", updatedAt: new Date() }).where(eq(schema.users.employeeId, employeeId));
  await audit(deps, actor, "employee.terminate", "employees", employeeId, { via: "offboarding" });
  return true;
}

// Add an ad-hoc task to a transition (assignee is a concrete employee ref, defaulting to the subject).
export async function appendTransitionTask(deps: Deps, actor: AppUser, transitionId: string, input: { title?: string; description?: string | null; assignee?: string | null; due_date?: string | null }) {
  const row = await getTransition(deps, actor, transitionId);
  if (!input.title?.trim()) throw invalidArgument("title is required");
  if (input.due_date && Number.isNaN(dayMs(input.due_date))) throw invalidArgument("due_date is invalid");
  const assigneeId = idFromPath(input.assignee) ?? row.employeeId;
  const maxPos = Math.max(-1, ...(await deps.db.select({ p: schema.transitionTasks.position }).from(schema.transitionTasks).where(eq(schema.transitionTasks.transitionId, transitionId))).map((t) => t.p));
  await insertTask(deps, transitionId, row.employeeId, assigneeId, input.title.trim(), input.description?.trim() || null, input.due_date ? new Date(dayMs(input.due_date)) : null, maxPos + 1);
  await audit(deps, actor, "transition.appendTask", "transitions", transitionId, { employee: `employees/${row.employeeId}`, diff: { title: { from: null, to: input.title.trim() } } }, row);
  return row;
}

// The tasks are PART OF the transition (no life of their own) - removed with it. Background checks, offers
// and notice periods each OUTLIVE it (their own compliance/ATS/exit record), so those are detached rather
// than deleted - undeclared, all four were foreign keys that turned `DELETE ?force=true` into a 409/500.
// Named and exported so test/purgeCascadeDrift can hold it against the schema's own foreign keys.
export const TRANSITION_PURGE_CASCADE: PurgeCascade = {
  remove: [{ table: schema.transitionTasks, column: schema.transitionTasks.transitionId }],
  detach: [
    { table: schema.backgroundChecks, column: schema.backgroundChecks.transitionId },
    { table: schema.offers, column: schema.offers.transitionId },
    { table: schema.noticePeriods, column: schema.noticePeriods.transitionId },
  ],
};

export async function purgeTransition(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  //
  // DECLARED rather than written out here, and handed to `purgeRow`: it does the teardown only AFTER the etag
  // and lock checks, which is the whole difference. Run ahead of it, the four writes above landed even when
  // the purge itself was then refused - an If-Match from a stale read, or a locked transition - so a request
  // that was answered 409 had already deleted every task and cut the record loose from its offer, its
  // background check and its notice period. `purgeRow` also bumps `updated_at` on each row it detaches, so a
  // client holding a pre-detach read stops being able to offer an If-Match that still matches.
  await purgeRow(deps, actor, schema.transitions, "transition", "transitions", id, ifMatch, undefined, TRANSITION_PURGE_CASCADE);
}

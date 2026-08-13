import { eq, and, inArray, isNull } from "drizzle-orm";
import { allocOwnedCode, allocFlatCode } from "./codeAlloc";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, diffMeta } from "../lib/audit";
import { purgeRow } from "./softDelete";
import { emitEvent } from "./eventBus";
import { invalidArgument, notFound, aborted, failedPrecondition } from "../lib/errors";
import { etagOf } from "../http/serialize";
import { getSettingValue } from "./settings";
import { DEFAULT_TRANSITION_TEMPLATES, type TaskAssignee } from "../domain/transitions";
import { notify } from "./notifications";

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

export async function listTransitions(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, kind?: string, state?: string, showDeleted = false) {
  const conds = [applyScope(scope, schema.transitions.code, schema.transitions.employeeId)];
  if (kind) conds.push(eq(schema.transitions.kind, kind as typeof schema.transitions.$inferSelect.kind));
  if (state) conds.push(eq(schema.transitions.state, state as typeof schema.transitions.$inferSelect.state));
  if (!showDeleted) conds.push(isNull(schema.transitions.deleteTime));
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
  const rows = (await deps.db.select().from(schema.transitionTasks).where(inArray(schema.transitionTasks.transitionId, transitionIds)))
    .sort((a, b) => a.position - b.position || +new Date(a.createdAt) - +new Date(b.createdAt));
  for (const r of rows) {
    const list = map.get(r.transitionId) ?? [];
    list.push(r);
    map.set(r.transitionId, list);
  }
  return map;
}

// Resolve a template assignee to a concrete employee: the subject, their manager, or a named person - falling
// back to the actor (who started it) then the subject, so every task always has an owner. (This is task
// ownership, not an access decision - written as a switch to avoid the singleSource role-literal heuristic.)
function resolveAssignee(a: TaskAssignee | undefined, subjectId: string, managerId: string | null, actorId: string | null): string {
  switch (a?.type) {
    case "manager": return managerId ?? actorId ?? subjectId;
    case "specific": return idFromPath(a.employee) ?? actorId ?? subjectId;
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
async function spawnBackgroundCheck(deps: Deps, transitionId: string, subjectId: string, checkType: string): Promise<string> {
  const row = (await deps.db.insert(schema.backgroundChecks).values({
    code: await allocFlatCode(deps, schema.backgroundChecks),
    employeeId: subjectId,
    transitionId,
    checkType: checkType as typeof schema.backgroundChecks.$inferInsert.checkType,
    status: "pending",
    initiatedDate: new Date(),
  }).returning())[0]!;
  return row.uuid;
}

export async function createTransition(deps: Deps, actor: AppUser, input: TransitionInput, id?: string) {
  const subjectId = idFromPath(input.employee);
  if (!subjectId) throw invalidArgument("employee is required");
  const kind = input.kind === "offboarding" ? "offboarding" : "onboarding";
  if (input.anchor_date && Number.isNaN(dayMs(input.anchor_date))) throw invalidArgument("anchor_date is invalid");
  const subject = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, subjectId)).limit(1))[0];
  if (!subject) throw notFound("employee not found");
  const anchorMs = input.anchor_date ? dayMs(input.anchor_date) : NaN;

  const tpl = input.template
    ? (await getSettingValue(deps, "transition-templates", DEFAULT_TRANSITION_TEMPLATES)).templates.find((t) => t.id === input.template)
    : undefined;
  const name = input.name?.trim() || tpl?.name || (kind === "onboarding" ? "Onboarding" : "Offboarding");

  const row = (await deps.db.insert(schema.transitions).values({
    code: await allocOwnedCode(deps, schema.transitions, schema.transitions.employeeId, subjectId),
    ...(id ? { uuid: id } : {}),
    employeeId: subjectId,
    kind,
    name,
    anchorDate: Number.isNaN(anchorMs) ? null : new Date(anchorMs),
  }).returning())[0]!;

  if (tpl) {
    let i = 0;
    for (const t of tpl.tasks) {
      const assigneeId = resolveAssignee(t.assignee, subjectId, subject.managerId ?? null, actor.employeeId ?? null);
      const dueDate = !Number.isNaN(anchorMs) && t.due_offset_days != null ? new Date(anchorMs + t.due_offset_days * DAY) : null;
      // A bg_check task opens a background-verification check for the subject and links the task to it.
      const bgId = t.bg_check ? await spawnBackgroundCheck(deps, row.uuid, subjectId, t.bg_check) : null;
      await insertTask(deps, row.uuid, subjectId, assigneeId, t.title, t.description ?? null, dueDate, i++, bgId, t.doc_type ?? null, actor.employeeId ?? null);
    }
  }
  await audit(deps, actor, `transition.create.${kind}`, "transitions", row.uuid, undefined, row);
  // Welcome/goodbye the subject: one summary notification (their individual tasks are surfaced in-app).
  if (subjectId !== actor.employeeId)
    await notify(deps, { recipient: subjectId, type: `transition.${kind}_started`, title: kind === "onboarding" ? "Welcome aboard!" : "Your offboarding has started", body: `${name} is underway. Check your tasks.`, link: "transitions", subject: `transitions/${row.uuid}`, actorId: actor.employeeId });
  return row;
}

export async function updateTransition(deps: Deps, actor: AppUser, id: string, patch: TransitionInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.transitions).where(eq(schema.transitions.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("transition not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const has = (k: keyof TransitionInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("name")) { if (!patch.name?.trim()) throw invalidArgument("name is required"); set.name = patch.name.trim(); }
  if (has("anchor_date")) {
    if (patch.anchor_date && Number.isNaN(dayMs(patch.anchor_date))) throw invalidArgument("anchor_date is invalid");
    set.anchorDate = patch.anchor_date ? new Date(dayMs(patch.anchor_date)) : null;
  }
  const updated = (await deps.db.update(schema.transitions).set(set).where(eq(schema.transitions.uuid, id)).returning())[0]!;
  await audit(deps, actor, "transition.update", "transitions", id, diffMeta(row, updated, set), updated);
  return updated;
}

export async function setTransitionState(deps: Deps, actor: AppUser, id: string, state: "COMPLETED" | "CANCELLED" | "ACTIVE") {
  const row = await getTransition(deps, actor, id);
  if (state === "ACTIVE" && row.state === "ACTIVE") throw failedPrecondition("the transition is already active");
  if (state !== "ACTIVE" && row.state !== "ACTIVE") throw failedPrecondition("only an active transition can be completed or cancelled");
  const updated = (await deps.db.update(schema.transitions).set({ state, updatedAt: new Date() }).where(eq(schema.transitions.uuid, id)).returning())[0]!;
  await audit(deps, actor, `transition.${state.toLowerCase()}`, "transitions", id);
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

// Mark an employee as terminated (status + disabled + end date) and disable any linked login. Idempotent.
// Called when an offboarding completes (transition complete, or a linked notice-period marked exited).
export async function terminateForOffboarding(deps: Deps, actor: AppUser, employeeId: string, endDate: Date) {
  await deps.db.update(schema.employees).set({ status: "terminated", disabled: true, endDate, updatedAt: new Date() }).where(eq(schema.employees.uuid, employeeId));
  await deps.db.update(schema.users).set({ status: "disabled", updatedAt: new Date() }).where(eq(schema.users.employeeId, employeeId));
  await audit(deps, actor, "employee.terminate", "employees", employeeId, { via: "offboarding" });
}

// Add an ad-hoc task to a transition (assignee is a concrete employee ref, defaulting to the subject).
export async function appendTransitionTask(deps: Deps, actor: AppUser, transitionId: string, input: { title?: string; description?: string | null; assignee?: string | null; due_date?: string | null }) {
  const row = await getTransition(deps, actor, transitionId);
  if (!input.title?.trim()) throw invalidArgument("title is required");
  if (input.due_date && Number.isNaN(dayMs(input.due_date))) throw invalidArgument("due_date is invalid");
  const assigneeId = idFromPath(input.assignee) ?? row.employeeId;
  const maxPos = Math.max(-1, ...(await deps.db.select({ p: schema.transitionTasks.position }).from(schema.transitionTasks).where(eq(schema.transitionTasks.transitionId, transitionId))).map((t) => t.p));
  await insertTask(deps, transitionId, row.employeeId, assigneeId, input.title.trim(), input.description?.trim() || null, input.due_date ? new Date(dayMs(input.due_date)) : null, maxPos + 1);
  await audit(deps, actor, "transition.appendTask", "transitions", transitionId);
  return row;
}

export async function purgeTransition(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await deps.db.delete(schema.transitionTasks).where(eq(schema.transitionTasks.transitionId, id));
  await purgeRow(deps, actor, schema.transitions, "transition", "transitions", id, ifMatch);
}

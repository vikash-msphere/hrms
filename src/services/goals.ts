import { eq, and, isNull } from "drizzle-orm";
import { allocOwnedCode } from "./codeAlloc";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, diffMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted } from "../lib/errors";
import { etagOf } from "../http/serialize";
import { emitEvent } from "./eventBus";
import { notify, managerIdOf } from "./notifications";

// Emit the progress + (when reaching 100 / completed) completion events for a goal row post-write.
async function emitGoalProgress(deps: Deps, actor: AppUser, row: typeof schema.goals.$inferSelect) {
  await emitEvent(deps, actor, "goal.progressUpdated", { subject: `goals/${row.uuid}`, employeeId: row.employeeId, payload: { progress: row.progress, status: row.status } });
  if (row.status === "completed" || row.progress >= 100) {
    await emitEvent(deps, actor, "goal.completed", { subject: `goals/${row.uuid}`, employeeId: row.employeeId, payload: { progress: row.progress } });
    // Tell the report's manager a goal was completed (unless the manager completed it themselves).
    const mgr = await managerIdOf(deps, row.employeeId);
    if (mgr && mgr !== actor.employeeId)
      await notify(deps, { recipient: mgr, type: "goal.completed", title: "Goal completed", body: row.title, link: "goals", subject: `goals/${row.uuid}`, actorId: row.employeeId });
  }
}

export type GoalInput = {
  employee?: string | null;
  title?: string;
  description?: string | null;
  weight?: number;
  progress?: number;
  status?: "not_started" | "in_progress" | "completed" | "cancelled";
  due_date?: string | null;
  parent?: string | null;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);

// Validate an alignment target: the parent must exist (not deleted), not be the goal itself, and not sit
// anywhere below it (walking the candidate's ancestor chain must never reach `selfId`). Depth-capped: a chain
// deeper than the cap is already degenerate and gets rejected as a cycle rather than walked forever.
async function resolveParentId(deps: Deps, selfId: string | null, parent?: string | null): Promise<string | null> {
  const pid = idFromPath(parent);
  if (!pid) return null;
  if (selfId && pid === selfId) throw invalidArgument("a goal cannot align to itself");
  const cols = { uuid: schema.goals.uuid, parentId: schema.goals.parentId, deleteTime: schema.goals.deleteTime };
  const p = (await deps.db.select(cols).from(schema.goals).where(eq(schema.goals.uuid, pid)).limit(1))[0];
  if (!p || p.deleteTime) throw invalidArgument("parent goal not found");
  let cur = p.parentId;
  for (let hops = 0; cur; hops++) {
    if (hops >= 25) throw invalidArgument("alignment chain is too deep");
    if (selfId && cur === selfId) throw invalidArgument("alignment would create a cycle");
    const row = (await deps.db.select(cols).from(schema.goals).where(eq(schema.goals.uuid, cur)).limit(1))[0];
    cur = row?.parentId ?? null;
  }
  return pid;
}
const dayMs = (s?: string | null) => (s ? Date.parse(s + "T00:00:00Z") : NaN);
const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
type Status = typeof schema.goals.$inferSelect.status;

export async function listGoals(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, statusFilter?: string, showDeleted = false) {
  // Visibility was decided in the middleware (scopeFor over the grant); here we only bind it to columns.
  const conds = [applyScope(scope, schema.goals.code, schema.goals.employeeId)];
  if (statusFilter) conds.push(eq(schema.goals.status, statusFilter as Status));
  if (!showDeleted) conds.push(isNull(schema.goals.deleteTime));
  return keysetPage(deps, schema.goals, "goals", and(...conds.filter(Boolean)), { dir: "asc", max: maxPageSize, pageToken });
}


export async function createGoal(deps: Deps, actor: AppUser, input: GoalInput, id?: string) {
  if (!input.title?.trim()) throw invalidArgument("title is required");
  // Default the owner to the caller's own employee record unless an admin/manager specifies one (the
  // middleware's owner-ref check has already confirmed they may create under that employee).
  const employeeId = idFromPath(input.employee) ?? actor.employeeId;
  if (!employeeId) throw invalidArgument("employee is required");
  const due = dayMs(input.due_date);
  if (input.due_date && Number.isNaN(due)) throw invalidArgument("due_date is invalid");
  const parentId = await resolveParentId(deps, id ?? null, input.parent);
  const code = await allocOwnedCode(deps, schema.goals, schema.goals.employeeId, employeeId);
  const row = (await deps.db
    .insert(schema.goals)
    .values({
      code,
      ...(id ? { uuid: id } : {}),
      parentId,
      employeeId,
      title: input.title.trim(),
      description: input.description?.trim() || null,
      weight: input.weight != null ? clampPct(input.weight) : 0,
      progress: input.progress != null ? clampPct(input.progress) : 0,
      status: input.status ?? "not_started",
      dueDate: input.due_date ? new Date(due) : null,
    })
    .returning())[0]!;
  await audit(deps, actor, "goal.create", "goals", row.uuid, undefined, row);
  // A goal assigned TO someone else (a manager setting a report's goal) notifies the owner.
  if (employeeId !== actor.employeeId)
    await notify(deps, { recipient: employeeId, type: "goal.assigned", title: "New goal assigned", body: row.title, link: "goals", subject: `goals/${row.uuid}`, actorId: actor.employeeId });
  return row;
}

export async function updateGoal(deps: Deps, actor: AppUser, id: string, patch: GoalInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.goals).where(eq(schema.goals.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("goal not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const has = (k: keyof GoalInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("title")) {
    if (!patch.title?.trim()) throw invalidArgument("title is required");
    set.title = patch.title.trim();
  }
  if (has("description")) set.description = patch.description?.trim() || null;
  if (has("weight")) set.weight = clampPct(patch.weight ?? 0);
  if (has("progress")) set.progress = clampPct(patch.progress ?? 0);
  if (has("status")) set.status = patch.status;
  if (has("due_date")) {
    const due = dayMs(patch.due_date);
    if (patch.due_date && Number.isNaN(due)) throw invalidArgument("due_date is invalid");
    set.dueDate = patch.due_date ? new Date(due) : null;
  }
  if (has("parent")) set.parentId = await resolveParentId(deps, id, patch.parent);
  const updated = (await deps.db.update(schema.goals).set(set).where(eq(schema.goals.uuid, id)).returning())[0]!;
  await audit(deps, actor, "goal.update", "goals", id, diffMeta(row, updated, set), updated);
  if (has("progress") || has("status")) await emitGoalProgress(deps, actor, updated);
  return updated;
}

// The `updateProgress` verb: move just a goal's progress (and optionally its status), so the org can grant an
// employee progress-only rights on goals whose definition a manager owns - without full edit access.
export async function updateGoalProgress(deps: Deps, actor: AppUser, id: string, progress: number, status?: Status, note?: string) {
  const row = (await deps.db.select().from(schema.goals).where(eq(schema.goals.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("goal not found");
  if (progress == null || Number.isNaN(Number(progress))) throw invalidArgument("progress is required");
  const set: Record<string, unknown> = { progress: clampPct(Number(progress)), updatedAt: new Date() };
  if (status) set.status = status;
  const updated = (await deps.db.update(schema.goals).set(set).where(eq(schema.goals.uuid, id)).returning())[0]!;
  // from/to (+ optional note) land in the audit meta so the activity feed can render a progress history.
  await audit(deps, actor, "goal.updateProgress", "goals", id, { from: row.progress, to: updated.progress, ...(note?.trim() ? { note: note.trim() } : {}) }, updated);
  await emitGoalProgress(deps, actor, updated);
  return updated;
}


import { eq, and, isNull, asc, inArray, sql } from "drizzle-orm";
import { allocOwnedCode } from "./codeAlloc";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, diffMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted } from "../lib/errors";
import { etagOf } from "../http/serialize";
import { emitEvent } from "./eventBus";
import { notify, managerIdOf } from "./notifications";
import { notifyMentions } from "./mentions";

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
  unit?: string | null;
  baseline_value?: number | null;
  target_value?: number | null;
  current_value?: number | null;
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

/**
 * Percent complete DERIVED from a goal's measure, or null when it has no measure to derive from.
 *
 * A goal with a baseline, a target and a current value doesn't need anyone's estimate: 42 of 60 customers is
 * 70%, and it stays 70% whether the owner is feeling optimistic that week or not. The baseline is what makes
 * reduction goals work - churn 8% -> 4% with 6% today is half done, and measuring from zero would call it 75%
 * done on the day it started.
 *
 * Targets equal to the baseline are the one unanswerable case (nothing to travel), so they measure nothing and
 * fall back to the manual number.
 */
export function measuredProgress(m: { baselineValue?: number | null; targetValue?: number | null; currentValue?: number | null }): number | null {
  const { baselineValue: base, targetValue: target, currentValue: current } = m;
  if (target == null || current == null) return null;
  const from = base ?? 0;
  const span = target - from;
  if (span === 0) return null;
  return clampPct(((current - from) / span) * 100);
}
type Status = typeof schema.goals.$inferSelect.status;

export type GoalTaskRollup = { tasks: number; delivered: number; points: number; deliveredPoints: number };

/**
 * Linked-task delivery, per goal, in ONE grouped query for a whole page of goals.
 *
 * A goal card shows "3/5 tasks · 8/13 pts". The client used to compute that by reading the entire `cards`
 * collection and grouping it in the browser - a page of rows to render a chip, and wrong for any goal whose
 * tasks sat past the cursor. The board tasks are already the server's business (it re-derives goal progress
 * from them on every link and delivery), so the rollup is answered here and rides the goal resource.
 */
export async function linkedTaskRollup(deps: Deps, goalIds: string[]): Promise<Map<string, GoalTaskRollup>> {
  const out = new Map<string, GoalTaskRollup>();
  if (!goalIds.length) return out;
  const rows = (await deps.db
    .select({
      goalId: schema.cards.goalId,
      tasks: sql<number>`count(*)`,
      delivered: sql<number>`coalesce(sum(case when ${schema.cards.deliveredAt} is not null then 1 else 0 end), 0)`,
      points: sql<number>`coalesce(sum(coalesce(${schema.cards.size}, 0)), 0)`,
      deliveredPoints: sql<number>`coalesce(sum(case when ${schema.cards.deliveredAt} is not null then coalesce(${schema.cards.size}, 0) else 0 end), 0)`,
    })
    .from(schema.cards)
    .where(and(inArray(schema.cards.goalId, goalIds), isNull(schema.cards.deleteTime)))
    .groupBy(schema.cards.goalId)) as { goalId: string | null; tasks: number; delivered: number; points: number; deliveredPoints: number }[];
  for (const r of rows) {
    if (!r.goalId) continue;
    out.set(r.goalId, { tasks: Number(r.tasks ?? 0), delivered: Number(r.delivered ?? 0), points: Number(r.points ?? 0), deliveredPoints: Number(r.deliveredPoints ?? 0) });
  }
  return out;
}

export async function listGoals(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, statusFilter?: string, showDeleted = false) {
  // Visibility was decided in the middleware (scopeFor over the grant); here we only bind it to columns.
  const conds = [applyScope(scope, schema.goals.code, schema.goals.employeeId)];
  if (statusFilter) conds.push(eq(schema.goals.status, statusFilter as Status));
  if (!showDeleted) conds.push(isNull(schema.goals.deleteTime));
  return keysetPage(deps, schema.goals, "goals", and(...conds.filter(Boolean)), { max: maxPageSize, pageToken });
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
      unit: input.unit?.trim() || null,
      baselineValue: input.baseline_value ?? null,
      targetValue: input.target_value ?? null,
      currentValue: input.current_value ?? null,
      // A measured goal's progress is its measure, from the first save: an owner who typed "0 of 60 customers"
      // must not also have to say "0%".
      ...(measuredProgress({ baselineValue: input.baseline_value, targetValue: input.target_value, currentValue: input.current_value }) != null
        ? { progress: measuredProgress({ baselineValue: input.baseline_value, targetValue: input.target_value, currentValue: input.current_value })! }
        : {}),
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
  const set: SetOf<typeof schema.goals> = { updatedAt: new Date() };
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
  if (has("unit")) set.unit = patch.unit?.trim() || null;
  if (has("baseline_value")) set.baselineValue = patch.baseline_value ?? null;
  if (has("target_value")) set.targetValue = patch.target_value ?? null;
  if (has("current_value")) set.currentValue = patch.current_value ?? null;
  // A goal that measures something reports the measure, not an opinion: any write that touches the numbers
  // recomputes progress, and an explicit `progress` in the same patch loses to them. Clearing the target hands
  // the goal back to manual progress, keeping whatever the measure last computed as the starting point.
  const measured = measuredProgress({
    baselineValue: has("baseline_value") ? patch.baseline_value : row.baselineValue,
    targetValue: has("target_value") ? patch.target_value : row.targetValue,
    currentValue: has("current_value") ? patch.current_value : row.currentValue,
  });
  if (measured != null && (has("baseline_value") || has("target_value") || has("current_value"))) set.progress = measured;
  // Reaching the target completes the goal, the same way dragging the slider to 100 does. Nothing auto-reopens
  // a completed goal: closing one is a decision, and a corrected number should not undo it.
  if (set.progress === 100 && row.status !== "completed" && !has("status")) set.status = "completed";
  const updated = (await deps.db.update(schema.goals).set(set).where(eq(schema.goals.uuid, id)).returning())[0]!;
  await audit(deps, actor, "goal.update", "goals", id, diffMeta(row, updated, set), updated);
  if (has("progress") || has("status") || set.progress != null) await emitGoalProgress(deps, actor, updated);
  return updated;
}

// A goal plus its comments, oldest first - the item Get and the answer to `:comment`.
export async function getGoalWithComments(deps: Deps, id: string) {
  const row = (await deps.db.select().from(schema.goals).where(eq(schema.goals.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("goal not found");
  const comments = await deps.db.select().from(schema.goalComments).where(eq(schema.goalComments.goalId, id)).orderBy(asc(schema.goalComments.createdAt));
  return { ...row, _comments: comments };
}

// The `comment` verb: a note on the goal that both sides can read, which is what a quarterly goal actually
// needs - the owner's progress note only ever travelled one way, into the audit trail.
export async function commentGoal(deps: Deps, actor: AppUser, id: string, body?: string | null) {
  const row = (await deps.db.select().from(schema.goals).where(eq(schema.goals.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("goal not found");
  const text = (body ?? "").trim();
  if (!text) throw invalidArgument("a comment body is required");
  await deps.db.insert(schema.goalComments).values({ goalId: id, authorId: actor.employeeId ?? null, authorEmail: actor.email, body: text });
  await audit(deps, actor, "goal.comment", "goals", id);
  // The other party is told, because a comment nobody sees is a comment nobody answers: the owner hears from a
  // manager, and the manager hears from their report.
  const other = actor.employeeId === row.employeeId ? await managerIdOf(deps, row.employeeId) : row.employeeId;
  if (other && other !== actor.employeeId)
    await notify(deps, { recipient: other, type: "goal.comment", title: `Comment on “${row.title}”`, body: text.slice(0, 140), link: "goals", subject: `goals/${id}`, actorId: actor.employeeId });
  await notifyMentions(deps, actor, { subject: `goals/${id}`, link: "goals", type: "goal.mention", body: text, title: row.title });
  return getGoalWithComments(deps, id);
}

// The `updateProgress` verb: move just a goal's progress (and optionally its status), so the org can grant an
// employee progress-only rights on goals whose definition a manager owns - without full edit access.
export async function updateGoalProgress(deps: Deps, actor: AppUser, id: string, progress: number, status?: Status, note?: string) {
  const row = (await deps.db.select().from(schema.goals).where(eq(schema.goals.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("goal not found");
  if (progress == null || Number.isNaN(Number(progress))) throw invalidArgument("progress is required");
  const set: SetOf<typeof schema.goals> = { progress: clampPct(Number(progress)), updatedAt: new Date() };
  if (status) set.status = status;
  const updated = (await deps.db.update(schema.goals).set(set).where(eq(schema.goals.uuid, id)).returning())[0]!;
  // from/to (+ optional note) land in the audit meta so the activity feed can render a progress history.
  await audit(deps, actor, "goal.updateProgress", "goals", id, { from: row.progress, to: updated.progress, ...(note?.trim() ? { note: note.trim() } : {}) }, updated);
  await emitGoalProgress(deps, actor, updated);
  return updated;
}


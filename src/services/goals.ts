import { eq, ne, and, isNull, asc, desc, inArray, lte, sql } from "drizzle-orm";
import { allocOwnedCode } from "./codeAlloc";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, createdMeta, diffMeta, stateMeta } from "../lib/audit";
import { byIdChunks, chunk, insertBatches, runBatch } from "../lib/dbBatch";
import { invalidArgument, notFound, aborted, failedPrecondition } from "../lib/errors";
import { etagOf } from "../http/serialize";
import { emitEvent } from "./eventBus";
import { notify, notifyMany, managerIdOf } from "./notifications";
import { notifyMentions } from "./mentions";
import { softDeleteRow, restoreRow } from "./softDelete";
import { getSettingValue } from "./settings";
import { DEFAULT_PERFORMANCE, type PerformanceFramework } from "../domain/performance";
import { round2 } from "../domain/money";
import { checkEtag, updateAtVersion } from "./versionGuard";

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
  kind?: "objective" | "key_result";
  due_date?: string | null;
  parent?: string | null;
  cycle?: string | null;
  confidence?: "on_track" | "at_risk" | "off_track" | null;
  confidence_note?: string | null;
  blocked_by?: string | null;
  retro?: string | null;
  department?: string | null;
  unit?: string | null;
  baseline_value?: number | null;
  target_value?: number | null;
  current_value?: number | null;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);

/** How deep an alignment or waiting-on chain may go. Deeper than this is degenerate, and treated as a cycle. */
const CHAIN_CAP = 25;

/**
 * Every id reachable from `startId` by following one self-referencing column, in ONE statement.
 *
 * WHY A RECURSIVE CTE AND NOT A LOOP. This is the cycle check for `parent` and for `blocked_by`, and both used
 * to walk the chain a query at a time: up to 25 D1 reads, inside a create or an update that also allocates a
 * code, writes the row, audits it, emits an event and rolls up an objective. A D1 query is a subrequest, and
 * the per-invocation budget is 50 on the free plan - so the deeper an org's alignment tree got, the closer an
 * ordinary goal edit came to failing outright, on work that answers one yes/no question. One statement answers
 * it whatever the depth.
 *
 * `column` is one of two literals chosen here, never caller input - it is interpolated as raw SQL because a
 * column name cannot be a bound parameter.
 *
 * The chain is capped IN SQL at one past the limit, so "too deep" is detectable without reading an unbounded
 * number of rows. Deleted ancestors are walked THROUGH rather than stopping the walk, which is what the loop
 * did: a soft-deleted goal in the middle of a chain still links the two ends of it, and a cycle hiding behind
 * one is still a cycle.
 */
async function followChain(deps: Deps, startId: string, column: "parent_id" | "blocked_by_id"): Promise<string[]> {
  const col = sql.raw(`"${column}"`);
  const rows = await deps.db.all<{ id: string | null }>(sql`
    with recursive chain(id, depth) as (
      select ${col}, 1 from "goals" where "uuid" = ${startId}
      union all
      select g.${col}, c.depth + 1 from "goals" g join chain c on g."uuid" = c.id
      where c.id is not null and c.depth <= ${CHAIN_CAP}
    )
    select id from chain where id is not null
  `);
  return rows.map((r) => r.id).filter((id): id is string => !!id);
}

// Validate an alignment target: the parent must exist (not deleted), not be the goal itself, and not sit
// anywhere below it (walking the candidate's ancestor chain must never reach `selfId`). Depth-capped: a chain
// deeper than the cap is already degenerate and gets rejected as a cycle rather than walked forever.
async function resolveParentId(deps: Deps, selfId: string | null, parent?: string | null): Promise<string | null> {
  const pid = idFromPath(parent);
  if (!pid) return null;
  if (selfId && pid === selfId) throw invalidArgument("a goal cannot align to itself");
  const p = (await deps.db
    .select({ uuid: schema.goals.uuid, deleteTime: schema.goals.deleteTime })
    .from(schema.goals)
    .where(eq(schema.goals.uuid, pid))
    .limit(1))[0];
  if (!p || p.deleteTime) throw invalidArgument("parent goal not found");
  const chain = await followChain(deps, pid, "parent_id");
  if (chain.length > CHAIN_CAP) throw invalidArgument("alignment chain is too deep");
  if (selfId && chain.includes(selfId)) throw invalidArgument("alignment would create a cycle");
  return pid;
}
// Validate the review cycle a goal is being set for: it has to exist and not be deleted. A CLOSED cycle is
// still a legal target - HR closes a cycle and then finds a goal that belonged in it, and refusing the link
// would leave that goal unattributable forever.
async function resolveCycleId(deps: Deps, cycle?: string | null): Promise<string | null> {
  const cid = idFromPath(cycle);
  if (!cid) return null;
  const row = (await deps.db
    .select({ uuid: schema.reviewCycles.uuid, deleteTime: schema.reviewCycles.deleteTime })
    .from(schema.reviewCycles)
    .where(eq(schema.reviewCycles.uuid, cid))
    .limit(1))[0];
  if (!row || row.deleteTime) throw invalidArgument("review cycle not found");
  return cid;
}
/**
 * Validate a "blocked by" link: the goal has to exist, must not be the goal itself, and must not already be
 * waiting on it. A pair of goals each waiting on the other describes a deadlock nobody can act on, and the
 * chain is walked (depth-capped) for the same reason alignment is.
 */
async function resolveBlockedBy(deps: Deps, selfId: string | null, blockedBy?: string | null): Promise<string | null> {
  const bid = idFromPath(blockedBy);
  if (!bid) return null;
  if (selfId && bid === selfId) throw invalidArgument("a goal cannot wait on itself");
  const target = (await deps.db
    .select({ uuid: schema.goals.uuid, deleteTime: schema.goals.deleteTime })
    .from(schema.goals)
    .where(eq(schema.goals.uuid, bid))
    .limit(1))[0];
  if (!target || target.deleteTime) throw invalidArgument("that goal was not found");
  const chain = await followChain(deps, bid, "blocked_by_id");
  if (chain.length > CHAIN_CAP) throw invalidArgument("this waiting-on chain is too deep");
  if (selfId && chain.includes(selfId)) throw invalidArgument("those two goals would be waiting on each other");
  return bid;
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

/**
 * How many ids one of the grouped page reads below may bind at a time.
 *
 * D1 binds AT MOST 100 parameters per statement (lib/dbBatch.ts#PARAM_CAP), and a goals page is up to 100
 * rows (http/pagination.ts#clampPageSize) - so an `inArray` over a full page sits exactly ON the cap and any
 * filter beside it goes over: `loggedHoursFor` bound 101 (the ids plus `status = 'APPROVED'`) and
 * `objectivesWithKeyResults` 102, which is `D1_ERROR: too many SQL variables` - a 500 on the goals list of
 * any org with a hundred goals. Chunking BELOW the cap is what the rest of the app does with a caller-sized
 * id list (payroll, settlements, assets all chunk at 90); a page needs two statements at this width, which is
 * still one round trip's worth of work and cannot be pushed over by adding a condition later.
 */
const ID_CHUNK = 90;

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
  for (const ids of chunk(goalIds, ID_CHUNK)) {
    const rows = (await deps.db
      .select({
        goalId: schema.cards.goalId,
        tasks: sql<number>`count(*)`,
        delivered: sql<number>`coalesce(sum(case when ${schema.cards.deliveredAt} is not null then 1 else 0 end), 0)`,
        points: sql<number>`coalesce(sum(coalesce(${schema.cards.size}, 0)), 0)`,
        deliveredPoints: sql<number>`coalesce(sum(case when ${schema.cards.deliveredAt} is not null then coalesce(${schema.cards.size}, 0) else 0 end), 0)`,
      })
      .from(schema.cards)
      .where(and(inArray(schema.cards.goalId, ids), isNull(schema.cards.deleteTime)))
      .groupBy(schema.cards.goalId)) as { goalId: string | null; tasks: number; delivered: number; points: number; deliveredPoints: number }[];
    for (const r of rows) {
      if (!r.goalId) continue;
      out.set(r.goalId, { tasks: Number(r.tasks ?? 0), delivered: Number(r.delivered ?? 0), points: Number(r.points ?? 0), deliveredPoints: Number(r.deliveredPoints ?? 0) });
    }
  }
  return out;
}

/**
 * Hours booked against each goal, through the projects pointed at it - one grouped query for a whole page.
 *
 * Effort and outcome have always been two separate stories in this app: hours live on timesheets, progress
 * lives on goals, and nothing put them side by side. "140 hours logged, goal at 30%" is the sentence that
 * catches work being poured into something that is not moving, and it costs one join.
 *
 * Only APPROVED time counts. A draft or rejected entry is somebody's intention, not effort the org has agreed
 * was spent, and letting it inflate the number would make the pairing worthless in exactly the situation it
 * exists for.
 */
export async function loggedHoursFor(deps: Deps, goalIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!goalIds.length) return out;
  for (const ids of chunk(goalIds, ID_CHUNK)) {
    const rows = (await deps.db
      .select({ goalId: schema.projects.goalId, hours: sql<number>`coalesce(sum(${schema.timeEntries.hours}), 0)` })
      .from(schema.timeEntries)
      .innerJoin(schema.projects, eq(schema.projects.uuid, schema.timeEntries.projectId))
      .where(and(
        inArray(schema.projects.goalId, ids),
        eq(schema.timeEntries.status, "APPROVED"),
        isNull(schema.timeEntries.deleteTime),
      ))
      .groupBy(schema.projects.goalId)) as { goalId: string | null; hours: number }[];
    // `round2`, and the same `round2` the card's own hours go through (services/cards.ts): rounding the same
    // timesheet sum to one place here and two places there made a task read 7.5 on the goal and 7.53 on the
    // card. Hours are a `real` column under the money rounding rule (domain/money.ts) - one helper, one answer.
    for (const r of rows) if (r.goalId) out.set(r.goalId, round2(Number(r.hours ?? 0)));
  }
  return out;
}

/**
 * When each goal was last COMMENTED on, in one grouped query for a whole page.
 *
 * Silence is what the staleness signal measures, and a comment breaks silence as surely as a progress move
 * does - a manager writing "what's blocking this?" is the goal being alive. It does not touch the goal row
 * (deliberately: a comment must not move the etag out from under an open edit form), so `updated_at` alone
 * would report an actively-discussed goal as three weeks dead.
 */
export async function lastCommentAtFor(deps: Deps, goalIds: string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (!goalIds.length) return out;
  for (const ids of chunk(goalIds, ID_CHUNK)) {
    const rows = (await deps.db
      .select({ goalId: schema.goalComments.goalId, at: sql<number>`max(${schema.goalComments.createdAt})` })
      .from(schema.goalComments)
      .where(inArray(schema.goalComments.goalId, ids))
      .groupBy(schema.goalComments.goalId)) as { goalId: string; at: number | null }[];
    for (const r of rows) if (r.at) out.set(r.goalId, new Date(Number(r.at)));
  }
  return out;
}

export async function listGoals(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, statusFilter?: string, showDeleted = false, cycleFilter?: string, withBurnup = false, stageFilter?: string) {
  // Visibility was decided in the middleware (scopeFor over the grant); here we only bind it to columns.
  const conds = [applyScope(scope, schema.goals.code, schema.goals.employeeId)];
  if (statusFilter) conds.push(eq(schema.goals.status, statusFilter as Status));
  // `?cycle=review-cycles/{id}` narrows to one cycle's goals; `?cycle=none` to the ones set outside any cycle,
  // which is how the Goals page offers "assign these to the cycle" without reading every row to find them.
  if (cycleFilter === "none") conds.push(isNull(schema.goals.cycleId));
  else if (cycleFilter) conds.push(eq(schema.goals.cycleId, idFromPath(cycleFilter)!));
  // `?stage=PROPOSED` is the manager's approval queue: the goals waiting on them, without reading everyone's.
  if (stageFilter) conds.push(eq(schema.goals.stage, stageFilter as Stage));
  if (!showDeleted) conds.push(isNull(schema.goals.deleteTime));
  const page = await keysetPage(deps, schema.goals, "goals", and(...conds.filter(Boolean)), { max: maxPageSize, pageToken });
  // `?cycle=<path>&burnup=true` adds the cycle's attainment curve to the answer. It rides the list rather than
  // living at its own endpoint because it is the same question, over the same rows, under the same scope: a
  // caller who may not see a goal must not see it move the line either.
  if (!withBurnup || !cycleFilter || cycleFilter === "none") return page;
  return { ...page, extra: { burnup: await cycleBurnup(deps, scope, idFromPath(cycleFilter)!) } };
}

export type BurnupPoint = { at: string; attained: number; expected: number };

/** How many points a burnup carries. A calibration meeting reads a shape, not a daily log. */
const MAX_BURNUP_POINTS = 30;

/**
 * Weighted attainment across a cycle's goals, week by week, against the straight line it should have followed.
 *
 * A review reports one number at the end. That number cannot distinguish the team that climbed steadily from
 * the one that sat at zero and then wrote 90% into every goal on the last Friday - and those are not the same
 * quarter, however identical the final score. The series comes out of the audit trail, which has been
 * recording every progress move since the feature shipped.
 *
 * Weekly points, capped: a calibration meeting reads a shape, not a daily log. Scoped like the list it rides
 * on, so a manager's curve is drawn from their own team's goals and HR's from everybody's.
 */
export async function cycleBurnup(deps: Deps, scope: ListScope, cycleId: string): Promise<BurnupPoint[]> {
  const goals = (await deps.db
    .select({ uuid: schema.goals.uuid, weight: schema.goals.weight, status: schema.goals.status, createdAt: schema.goals.createdAt })
    .from(schema.goals)
    .where(and(
      applyScope(scope, schema.goals.code, schema.goals.employeeId),
      eq(schema.goals.cycleId, cycleId),
      isNull(schema.goals.deleteTime),
      ne(schema.goals.status, "cancelled"), // dropped whole, exactly as the attainment score drops them
    ))) as { uuid: string; weight: number; status: string; createdAt: Date }[];
  if (!goals.length) return [];
  const cycle = (await deps.db.select().from(schema.reviewCycles).where(eq(schema.reviewCycles.uuid, cycleId)).limit(1))[0];
  if (!cycle?.periodStart || !cycle?.periodEnd) return [];

  const DAY = 86_400_000;
  const start = +new Date(cycle.periodStart);
  const end = +new Date(cycle.periodEnd) + DAY;
  // `deps.clock`, not `Date.now()` - this decides where the curve stops, and every other "now" that decides
  // something in this app comes from the injected clock so a test can state what day it is.
  const last = Math.min(+deps.clock.now(), end); // no line drawn into a future nobody has lived yet

  // Every recorded move for these goals up to the end of the period, oldest first - then replayed forward.
  //
  // Bounded by the WINDOW, not by a row count. A row limit cannot be made safe here in either direction: the
  // replay reads each goal's last move at or before a point, so dropping the oldest rows loses the baseline of
  // a goal that moved early and then sat, and dropping the newest (which an `asc` limit does) flattens the
  // recent end of the curve - the half a calibration meeting is actually looking at. `at <= end` removes every
  // row that cannot affect any point, and what is left is proportional to the progress actually recorded
  // against ONE cycle's goals, on a query the caller opted into with `?burnup=true`.
  const ids = goals.map((g) => g.uuid);
  const series = new Map<string, { at: number; progress: number }[]>(ids.map((id) => [id, []]));
  for (const idChunk of chunk(ids, ID_CHUNK - 3)) { // -3: the entity, the two actions and the window bound
    const moves = (await deps.db
      .select({ id: schema.auditLog.entityId, at: schema.auditLog.at, action: schema.auditLog.action, meta: schema.auditLog.meta })
      .from(schema.auditLog)
      .where(and(
        eq(schema.auditLog.entity, "goals"),
        inArray(schema.auditLog.entityId, idChunk),
        inArray(schema.auditLog.action, ["goal.updateProgress", "goal.update"]),
        lte(schema.auditLog.at, new Date(end)),
      ))
      .orderBy(asc(schema.auditLog.at))) as { id: string | null; at: Date; action: string; meta: string | null }[];
    for (const m of moves) {
      if (!m.id) continue;
      let meta: Record<string, unknown> = {};
      try { meta = m.meta ? JSON.parse(m.meta) : {}; } catch { continue; }
      const diff = (meta.diff ?? {}) as Record<string, { to?: unknown }>;
      const to = m.action === "goal.updateProgress" ? meta.to : diff.progress?.to;
      if (typeof to !== "number" || Number.isNaN(to)) continue;
      series.get(m.id)!.push({ at: +new Date(m.at), progress: Math.max(0, Math.min(100, to)) });
    }
  }

  // The sampling interval is DERIVED from the period, so the curve always spans the whole of it. A fixed week
  // with a 30-point cap drew an annual cycle up to about month seven and then stopped - a line that looks like
  // a quarter that died in July rather than a year still being worked. Weekly stays weekly for anything up to
  // ~7 months; a longer cycle widens the step instead of losing its second half.
  // Weighted only when EVERY goal in the cycle carries a weight - the same all-or-nothing rule the review
  // score uses (domain/performance.ts#goalAttainment), so the curve and the number it ends on are computed the
  // same way. Under the old Σweight > 0 test a cycle where one goal was weighted and the rest were left at the
  // default 0 drew a line for that one goal and silently left every other goal out of the shape.
  const weighted = goals.every((g) => Math.max(0, g.weight || 0) > 0);
  const weightTotal = weighted ? goals.reduce((s, g) => s + Math.max(0, g.weight || 0), 0) : 0;
  const step = Math.max(7 * DAY, Math.ceil((last - start) / (MAX_BURNUP_POINTS - 1) / DAY) * DAY);
  const out: BurnupPoint[] = [];
  for (let t = start; ; t += step) {
    const at = Math.min(t, last);
    // Each goal as it stood at `at`: the last recorded move before that moment, or 0 if it had not moved (or
    // did not exist yet - a goal added mid-cycle drags the curve down from its own start, which is honest).
    let earned = 0;
    let sum = 0;
    let counted = 0;
    for (const g of goals) {
      const w = Math.max(0, g.weight || 0);
      const points = series.get(g.uuid)!;
      let progress = 0;
      for (const p of points) {
        if (p.at > at) break;
        progress = p.progress;
      }
      earned += w * progress;
      sum += progress;
      counted++;
    }
    const attained = weightTotal > 0 ? Math.round(earned / weightTotal) : counted ? Math.round(sum / counted) : 0;
    const expected = Math.round(Math.max(0, Math.min(1, (at - start) / (end - start))) * 100);
    out.push({ at: new Date(at).toISOString().slice(0, 10), attained, expected });
    if (at >= last || out.length >= MAX_BURNUP_POINTS) break;
  }
  return out;
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
  const kind: Kind = input.kind ?? "objective";
  // A key result is one of the numbers under an objective, so it has to hang off one. A KR with no parent is
  // an objective that has been mislabelled, and it would never roll up into anything.
  if (kind === "key_result" && !parentId) throw invalidArgument("a key result needs an objective to sit under");
  if (kind === "key_result") await assertObjective(deps, parentId);
  const cycleId = await resolveCycleId(deps, input.cycle);
  // Where the goal starts on the agreement ladder. With approval off, setting a goal IS agreeing it. With it
  // on, only a goal somebody writes for THEMSELVES needs submitting - a manager writing one for a report is
  // the approver, and asking them to approve their own instruction is ceremony with no reader.
  const stage: Stage = (await goalApprovalOn(deps)) && employeeId === actor.employeeId ? "DRAFT" : "AGREED";
  const code = await allocOwnedCode(deps, schema.goals, schema.goals.employeeId, employeeId);
  const row = (await deps.db
    .insert(schema.goals)
    .values({
      code,
      ...(id ? { uuid: id } : {}),
      parentId,
      cycleId,
      employeeId,
      title: input.title.trim(),
      description: input.description?.trim() || null,
      weight: input.weight != null ? clampPct(input.weight) : 0,
      progress: input.progress != null ? clampPct(input.progress) : 0,
      status: input.status ?? "not_started",
      kind,
      stage,
      ...(stage === "AGREED" ? { agreedAt: new Date(), agreedById: actor.employeeId ?? null } : {}),
      dueDate: input.due_date ? new Date(due) : null,
      confidence: input.confidence ?? null,
      confidenceNote: input.confidence_note?.trim() || null,
      blockedById: await resolveBlockedBy(deps, id ?? null, input.blocked_by),
      departmentId: idFromPath(input.department) ?? null,
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
  await audit(deps, actor, "goal.create", "goals", row.uuid, createdMeta(row, "goals"), row);
  // A new key result changes what its objective adds up to, immediately.
  if (kind === "key_result") await recomputeObjectiveProgress(deps, actor, parentId);
  // A goal assigned TO someone else (a manager setting a report's goal) notifies the owner.
  if (employeeId !== actor.employeeId)
    await notify(deps, { recipient: employeeId, type: "goal.assigned", title: "New goal assigned", body: row.title, link: "goals", subject: `goals/${row.uuid}`, actorId: actor.employeeId });
  return row;
}

export async function updateGoal(deps: Deps, actor: AppUser, id: string, patch: GoalInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.goals).where(eq(schema.goals.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("goal not found");
  checkEtag(row, ifMatch);
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
  if (has("kind")) set.kind = patch.kind;
  if (has("parent")) set.parentId = await resolveParentId(deps, id, patch.parent);
  // The SAME rule create enforces: a key result is one of the numbers under an objective, so it has to hang
  // off one. Checked against the row as it will STAND after this patch, because either half can arrive on its
  // own - `{kind: "key_result"}` on a top-level goal, or `{parent: null}` on an existing key result - and both
  // produced a key result that rolls up into nothing and is invisible to every objective's roll-up.
  const kindAfter = has("kind") ? patch.kind : row.kind;
  const parentAfter = has("parent") ? (set.parentId as string | null) : row.parentId;
  if (kindAfter === "key_result" && !parentAfter) throw invalidArgument("a key result needs an objective to sit under");
  // Whether this goal has key results of its own - needed twice below, so read once.
  const rolledUp = await hasKeyResults(deps, id);
  if (kindAfter === "key_result") {
    await assertObjective(deps, parentAfter);
    // The same rule from BELOW. A key result is a leaf by definition, so a goal that already has key results
    // of its own cannot become one - and that half is reachable: `{kind: "key_result"}` on an objective that
    // has three KRs under it built a KR->KR chain from the other end.
    if (rolledUp) throw invalidArgument("this goal has key results of its own, so it cannot become one");
  }
  // An objective with key results does not carry a typed percentage - theirs is the answer. Silently ignored
  // rather than refused, the same way a measured goal ignores one: the next roll-up would overwrite it anyway,
  // and a 400 on a field the form happens to send is a worse trade than dropping it.
  if (rolledUp && has("progress")) delete (set as { progress?: number }).progress;
  if (has("cycle")) set.cycleId = await resolveCycleId(deps, patch.cycle);
  if (has("confidence")) set.confidence = patch.confidence ?? null;
  if (has("confidence_note")) set.confidenceNote = patch.confidence_note?.trim() || null;
  if (has("blocked_by")) set.blockedById = await resolveBlockedBy(deps, id, patch.blocked_by);
  if (has("department")) set.departmentId = idFromPath(patch.department) ?? null;
  // The retro is the goal's closing sentence, so it is only meaningful once the goal is closing: writing one
  // on a live goal is fine (people draft them), but it is never cleared behind the owner's back.
  if (has("retro")) set.retro = patch.retro?.trim() || null;
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
  const updated = await updateAtVersion(deps, schema.goals, "goal", row, set);
  await audit(deps, actor, "goal.update", "goals", id, diffMeta(row, updated, set, "goals"), updated);
  if (has("progress") || has("status") || set.progress != null) await emitGoalProgress(deps, actor, updated);
  // A key result that moved (or moved house) re-rolls the objective(s) it left and joined.
  if (updated.kind === "key_result") {
    await recomputeObjectiveProgress(deps, actor, updated.parentId);
    if (row.parentId && row.parentId !== updated.parentId) await recomputeObjectiveProgress(deps, actor, row.parentId);
  }
  // A confidence call is worth a rule whichever door it came through, so the edit form announces it exactly as
  // the `setConfidence` verb does.
  if (has("confidence") && updated.confidence !== row.confidence) await emitConfidence(deps, actor, row.confidence, updated);
  return updated;
}

// Announce a confidence call: the event a rule watches ("tell me when a goal turns off track"), plus the
// manager notification for the turn that actually matters. Only a MOVE is announced - re-affirming on_track
// weekly is not news, and would train everyone to ignore the alert that counts.
async function emitConfidence(deps: Deps, actor: AppUser, from: string | null, row: typeof schema.goals.$inferSelect) {
  await emitEvent(deps, actor, "goal.confidenceChanged", {
    subject: `goals/${row.uuid}`,
    employeeId: row.employeeId,
    payload: { confidence: row.confidence ?? "", previous: from ?? "", progress: row.progress },
  });
  if (row.confidence !== "off_track" && row.confidence !== "at_risk") return;
  const mgr = await managerIdOf(deps, row.employeeId);
  // A goal turning at-risk is the single most useful thing a watcher can hear: whoever is waiting on it can
  // re-plan while there is still time, which is the whole reason to watch somebody else's goal.
  await notifyGoalWatchers(deps, actor, row, {
    type: "goal.at_risk",
    title: row.confidence === "off_track" ? `Off track: ${row.title}` : `At risk: ${row.title}`,
    body: row.confidenceNote?.trim() ? row.confidenceNote.trim().slice(0, 160) : row.title,
  }, [mgr, row.employeeId]);
  if (!mgr || mgr === actor.employeeId) return;
  await notify(deps, {
    recipient: mgr,
    type: "goal.at_risk",
    title: row.confidence === "off_track" ? "Goal flagged off track" : "Goal flagged at risk",
    body: row.confidenceNote?.trim() ? `${row.title} - ${row.confidenceNote.trim().slice(0, 160)}` : row.title,
    link: "goals",
    subject: `goals/${row.uuid}`,
    actorId: row.employeeId,
  });
}

type Stage = typeof schema.goals.$inferSelect.stage;
type Kind = typeof schema.goals.$inferSelect.kind;

/**
 * Re-derive an objective's progress from its key results.
 *
 * An objective is a sentence; its key results are the numbers that prove it. So the objective's percentage is
 * theirs, weighted - never typed. Before this, the parent rollup was computed in the BROWSER over the children
 * the viewer happened to be able to see, which meant a manager and HR read two different figures for the same
 * objective and the review scored whichever one the server had stored.
 *
 * Cancelled key results drop out whole (the same rule attainment uses), and an objective whose KRs are all
 * cancelled keeps whatever it last had rather than being zeroed by somebody else's decision. Runs after any
 * write to a key result; best-effort, exactly like the card roll-up, because the write that triggered it has
 * already committed.
 */
export async function recomputeObjectiveProgress(deps: Deps, actor: AppUser, objectiveId: string | null | undefined) {
  if (!objectiveId) return;
  try {
    const objective = (await deps.db
      .select({ del: schema.goals.deleteTime, kind: schema.goals.kind, progress: schema.goals.progress, status: schema.goals.status })
      .from(schema.goals)
      .where(eq(schema.goals.uuid, objectiveId))
      .limit(1))[0];
    if (!objective || objective.del) return;
    const krs = (await deps.db
      .select({ weight: schema.goals.weight, progress: schema.goals.progress, status: schema.goals.status })
      .from(schema.goals)
      .where(and(
        eq(schema.goals.parentId, objectiveId),
        eq(schema.goals.kind, "key_result"),
        isNull(schema.goals.deleteTime),
        ne(schema.goals.status, "cancelled"),
      ))) as { weight: number; progress: number; status: string }[];
    if (!krs.length) return; // no key results -> the objective owns its own progress again
    // Weighted only when EVERY key result carries a weight, the same all-or-nothing rule the review score uses
    // (domain/performance.ts#goalAttainment). `weight` defaults to 0, so on the old Σweight > 0 test one
    // weighted KR beside three unweighted ones made the objective read that single KR's progress and drop the
    // other three - and the objective's number is what a review then scores.
    const weightOf = (k: { weight: number }) => Math.max(0, k.weight || 0);
    const progress = krs.every((k) => weightOf(k) > 0)
      ? Math.round(krs.reduce((s, k) => s + weightOf(k) * clampPct(k.progress || 0), 0) / krs.reduce((s, k) => s + weightOf(k), 0))
      : Math.round(krs.reduce((s, k) => s + clampPct(k.progress || 0), 0) / krs.length);
    if (progress === objective.progress) return; // nothing moved; don't write an audit entry saying so
    const status = progress >= 100 ? "completed" : progress > 0 && objective.status === "not_started" ? "in_progress" : undefined;
    await updateGoalProgress(deps, actor, objectiveId, progress, status as Status | undefined, undefined, true);
  } catch (err) {
    // Best-effort: the key-result write already committed, and a roll-up failure must not undo it. But it is
    // NOT nothing - the objective is now quoting a figure its key results no longer support, and a review
    // scores that figure - so it is logged rather than swallowed in silence. The cron subtask wrapper and the
    // error tracker both read console.error, which is what makes a run of these visible.
    console.error(`[goals] objective roll-up failed for ${objectiveId}; its progress is now stale`, err);
  }
}

export type ContributorInput = { employee: string; share?: number; note?: string | null };

/**
 * Set a goal's contributors: who else worked on it, and how much of it was theirs.
 *
 * Replaces the whole set rather than patching one row, because the shares are only meaningful together - "40%
 * was Sam's" is a statement about the split, and editing it one line at a time produces splits that add up to
 * 170% in between saves.
 *
 * Capped at 100% in total, and the OWNER is never a contributor to their own goal: their share is whatever the
 * contributors do not take. Anything over the cap is refused rather than silently scaled, because a manager
 * who typed 60/60 meant something and the app should not guess which half.
 */
export async function setGoalContributors(deps: Deps, actor: AppUser, id: string, contributors: ContributorInput[]) {
  const row = await loadOpenGoal(deps, id);
  const seen = new Set<string>();
  const rows: { employeeId: string; share: number; note: string | null }[] = [];
  for (const c of contributors) {
    const employeeId = idFromPath(c.employee);
    if (!employeeId) throw invalidArgument("each contributor needs an employee");
    if (employeeId === row.employeeId) throw invalidArgument("the goal's owner is not one of its contributors - their share is what the others do not take");
    if (seen.has(employeeId)) throw invalidArgument("that person is listed twice; one share each");
    seen.add(employeeId);
    rows.push({ employeeId, share: clampPct(c.share ?? 0), note: c.note?.trim() || null });
  }
  const total = rows.reduce((s, r) => s + r.share, 0);
  if (total > 100) throw invalidArgument(`the shares add up to ${total}% - a goal cannot credit more than itself`);

  // Every named person has to BE a live employee. The ids arrive as wire refs the caller chose, and nothing
  // here checked them: a share could be credited to a soft-deleted employee, or to an id that names nobody at
  // all. That is not harmless - the share still comes off the owner's review weight (services/reviews.ts
  // #ownedSnapshot), so credit was being taken away from one person and given to a row that cannot be scored,
  // and the notification below addressed the same nobody. One chunked read for the whole set.
  if (rows.length) {
    const ids = rows.map((r) => r.employeeId);
    const live = new Set(
      (await byIdChunks(ids, (group) =>
        deps.db
          .select({ uuid: schema.employees.uuid })
          .from(schema.employees)
          .where(and(inArray(schema.employees.uuid, group), isNull(schema.employees.deleteTime))),
      )).map((e) => e.uuid),
    );
    const missing = ids.filter((i) => !live.has(i));
    if (missing.length) throw invalidArgument(`${missing.length === 1 ? "one contributor is" : `${missing.length} contributors are`} not a current employee`);
  }

  // ONE atomic batch: the clear and every insert land together or not at all. A loop of awaits made the
  // replace non-atomic in the one place that cannot afford it - a failure partway through left the goal with
  // the old split deleted and the new one half-written, which is a credit split that adds up to nothing - and
  // it spent a subrequest per contributor, so a full set of twenty plus the fan-out below ran past the
  // per-invocation budget and failed the request that was trying to save them. See lib/dbBatch.ts.
  await runBatch(deps.db, [
    deps.db.delete(schema.goalContributors).where(eq(schema.goalContributors.goalId, id)),
    ...insertBatches(rows.map((r) => ({ goalId: id, ...r })), (group) => deps.db.insert(schema.goalContributors).values(group)),
  ]);
  await audit(deps, actor, "goal.setContributors", "goals", id, {
    employee: `employees/${row.employeeId}`,
    fields: rows.map((r) => `employees/${r.employeeId}`).slice(0, 12),
    note: rows.length ? `${rows.length} contributor${rows.length === 1 ? "" : "s"} sharing ${total}%` : "contributors cleared",
  }, row);
  // Everyone named gets told: a share of somebody else's goal turns up in YOUR review, and finding that out
  // at review time is not the moment for it. Through `notifyMany`, which resolves every recipient's prefs and
  // owner code in one read and writes them in chunked multi-row inserts - the per-recipient read+read+insert
  // that a loop does is the fan-out shape this app does not do (see notifications.ts#notifyMany). That is why
  // the body names the goal rather than each person's own percentage: the split itself is on the goal, which
  // is where the notification sends them.
  await notifyMany(deps, rows.map((r) => r.employeeId).filter((e) => e !== actor.employeeId), {
    type: "goal.contributor",
    title: "Credited on a goal",
    body: `${row.title} - you have been credited a share of this goal`,
    link: "goals",
    subject: `goals/${id}`,
    actorId: actor.employeeId,
  });
  return getGoalWithComments(deps, id);
}

/** The contributors on a page of goals, in one query - the goal resource carries them. */
export async function contributorsFor(deps: Deps, goalIds: string[]): Promise<Map<string, { employeeId: string; share: number; note: string | null }[]>> {
  const out = new Map<string, { employeeId: string; share: number; note: string | null }[]>();
  if (!goalIds.length) return out;
  for (const ids of chunk(goalIds, ID_CHUNK)) {
    const rows = await deps.db
      .select({ goalId: schema.goalContributors.goalId, employeeId: schema.goalContributors.employeeId, share: schema.goalContributors.share, note: schema.goalContributors.note })
      .from(schema.goalContributors)
      .where(inArray(schema.goalContributors.goalId, ids));
    for (const r of rows) (out.get(r.goalId) ?? out.set(r.goalId, []).get(r.goalId)!).push({ employeeId: r.employeeId, share: r.share, note: r.note });
  }
  return out;
}

/**
 * Tell a goal's watchers something moved.
 *
 * Excludes the actor and anyone the event already told directly (the owner, their manager), so watching a goal
 * you are already in the loop on does not double every notification. Low priority: this is the "keep me
 * posted" channel, and it digests where the recipient has a digest.
 */
async function notifyGoalWatchers(
  deps: Deps,
  actor: AppUser,
  goal: { uuid: string; title: string },
  what: { type: string; title: string; body: string },
  alreadyTold: (string | null | undefined)[] = [],
) {
  const rows = await deps.db
    .select({ employeeId: schema.goalWatchers.employeeId })
    .from(schema.goalWatchers)
    .where(eq(schema.goalWatchers.goalId, goal.uuid));
  const skip = new Set([actor.employeeId, ...alreadyTold].filter(Boolean) as string[]);
  // Through the BROADCAST path, not a notify per watcher. Nothing caps how many people follow one goal - a
  // company objective is exactly the goal everybody watches - and a loop here paid two reads and an insert
  // each, inside the request that merely flagged the goal at risk. `notifyMany` resolves the whole set in one
  // read plus chunked multi-row inserts, which is what makes the fan-out independent of the audience size.
  await notifyMany(deps, rows.map((r) => r.employeeId).filter((e) => !skip.has(e)), {
    type: what.type,
    title: what.title,
    body: what.body,
    link: "goals",
    subject: `goals/${goal.uuid}`,
    priority: "low",
    actorId: actor.employeeId,
  });
}

/**
 * Watch / unwatch a goal: hear about somebody else's goal that your own plans turn on.
 *
 * The cases are specific and were all silent: the owner of a goal BLOCKED BY this one, a contributor credited
 * with a share of it, a skip-level who cares. Idempotent both ways, unaudited (reading along is not a change
 * to the goal), and open to anyone who can read the goal, because the verb is authorized on the goal itself.
 */
export async function watchGoal(deps: Deps, actor: AppUser, id: string, on: boolean) {
  const row = (await deps.db.select({ uuid: schema.goals.uuid, del: schema.goals.deleteTime }).from(schema.goals).where(eq(schema.goals.uuid, id)).limit(1))[0];
  if (!row || row.del) throw notFound("goal not found");
  if (!actor.employeeId) throw invalidArgument("only an employee can watch a goal");
  if (on) {
    await deps.db.insert(schema.goalWatchers).values({ goalId: id, employeeId: actor.employeeId }).onConflictDoNothing();
  } else {
    await deps.db.delete(schema.goalWatchers).where(and(eq(schema.goalWatchers.goalId, id), eq(schema.goalWatchers.employeeId, actor.employeeId)));
  }
  return getGoalWithComments(deps, id);
}

/** The watchers on a page of goals, in one query - the goal resource carries the count and the caller's own state. */
export async function goalWatchersFor(deps: Deps, goalIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!goalIds.length) return out;
  for (const ids of chunk(goalIds, ID_CHUNK)) {
    const rows = await deps.db
      .select({ goalId: schema.goalWatchers.goalId, employeeId: schema.goalWatchers.employeeId })
      .from(schema.goalWatchers)
      .where(inArray(schema.goalWatchers.goalId, ids));
    for (const r of rows) (out.get(r.goalId) ?? out.set(r.goalId, []).get(r.goalId)!).push(r.employeeId);
  }
  return out;
}

export type SuggestedContributor = { employeeId: string; share: number; deliveredPoints: number; deliveredTasks: number };

/**
 * The split the linked tasks already imply: who DELIVERED the work on each goal, and what percentage of the
 * delivered work was theirs - one grouped query for a whole page of goals.
 *
 * Contributor shares are typed by hand, which is the right place for the decision and the wrong place to
 * start from: the goal's own board already records who was assigned each delivered task and how big it was,
 * so making a manager derive percentages from it with a calculator is asking them to re-enter data the app
 * holds. This suggests the arithmetic; `:setContributors` still takes the decision.
 *
 * `share` is a percentage of the goal's DELIVERED work, using the same weighting as the card roll-up (story
 * points where any linked task carries a size, otherwise one point per task). Delivered-work share is the
 * figure that composes with review scoring: a contributor line scores `weight x share x progress`, so a share
 * measured against the goal's total work instead would apply the same shortfall twice.
 *
 * The OWNER is included in the denominator and excluded from the result: their credit is whatever the
 * contributors do not take, exactly as `setGoalContributors` states. Unassigned delivered tasks and anything
 * not yet delivered therefore fall into that remainder rather than inflating anybody's share.
 */
export async function suggestedContributorsFor(
  deps: Deps,
  goals: { uuid: string; employeeId: string }[],
): Promise<Map<string, SuggestedContributor[]>> {
  const out = new Map<string, SuggestedContributor[]>();
  if (!goals.length) return out;
  const ownerOf = new Map(goals.map((g) => [g.uuid, g.employeeId]));
  type LinkedCard = { goalId: string | null; assigneeId: string | null; size: number | null; delivered: Date | null };
  const cards: LinkedCard[] = [];
  for (const ids of chunk([...ownerOf.keys()], ID_CHUNK)) {
    cards.push(...(await deps.db
      .select({ goalId: schema.cards.goalId, assigneeId: schema.cards.assigneeId, size: schema.cards.size, delivered: schema.cards.deliveredAt })
      .from(schema.cards)
      .where(and(inArray(schema.cards.goalId, ids), isNull(schema.cards.deleteTime)))) as LinkedCard[]);
  }

  const byGoal = new Map<string, LinkedCard[]>();
  for (const c of cards) {
    if (!c.goalId) continue;
    (byGoal.get(c.goalId) ?? byGoal.set(c.goalId, []).get(c.goalId)!).push(c);
  }

  for (const [goalId, linked] of byGoal) {
    // Same weighting the roll-up uses, so a suggested share and the delivery chip never disagree.
    const anySized = linked.some((c) => (c.size ?? 0) > 0);
    const weight = (c: { size: number | null }) => (anySized ? c.size ?? 1 : 1);
    const deliveredTotal = linked.reduce((s, c) => s + (c.delivered ? weight(c) : 0), 0);
    if (!deliveredTotal) continue; // nothing delivered yet: no credit to suggest, which is not a suggestion of 0%

    const per = new Map<string, { points: number; tasks: number }>();
    for (const c of linked) {
      if (!c.delivered || !c.assigneeId) continue;
      const acc = per.get(c.assigneeId) ?? per.set(c.assigneeId, { points: 0, tasks: 0 }).get(c.assigneeId)!;
      acc.points += weight(c);
      acc.tasks += 1;
    }

    const owner = ownerOf.get(goalId);
    const rows: SuggestedContributor[] = [];
    for (const [employeeId, acc] of per) {
      if (employeeId === owner) continue; // the owner's share is the remainder, never a contributor row
      const share = Math.round((acc.points / deliveredTotal) * 100);
      if (share > 0) rows.push({ employeeId, share, deliveredPoints: acc.points, deliveredTasks: acc.tasks });
    }
    rows.sort((a, b) => b.share - a.share || b.deliveredPoints - a.deliveredPoints);

    // Rounding each share independently can add up to 101% on a split like 3 x 33.5%, and a suggestion the
    // service would then refuse is worse than no suggestion. The excess comes off the largest share, which is
    // the one whose rounding created it and the one least distorted by losing a point.
    let over = rows.reduce((s, r) => s + r.share, 0) - 100;
    for (const r of rows) {
      if (over <= 0) break;
      const cut = Math.min(over, r.share);
      r.share -= cut;
      over -= cut;
    }
    const kept = rows.filter((r) => r.share > 0);
    if (kept.length) out.set(goalId, kept);
  }
  return out;
}

/**
 * Soft-delete / restore a goal, then re-roll the objective above it.
 *
 * Removing a key result changes the objective's percentage as surely as moving one does, and the shared
 * lifecycle lane knows nothing about that relationship - so a deleted KR used to leave its objective quoting
 * a figure derived from a goal that no longer exists.
 */
export async function deleteGoal(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  const row = (await deps.db.select({ kind: schema.goals.kind, parentId: schema.goals.parentId }).from(schema.goals).where(eq(schema.goals.uuid, id)).limit(1))[0];
  await softDeleteRow(deps, actor, schema.goals, "goal", "goals", id, ifMatch);
  if (row?.kind === "key_result") await recomputeObjectiveProgress(deps, actor, row.parentId);
}

export async function restoreGoal(deps: Deps, actor: AppUser, id: string) {
  const restored = await restoreRow(deps, actor, schema.goals, "goal", "goals", id);
  const row = restored as { kind?: string; parentId?: string | null } | undefined;
  if (row?.kind === "key_result") await recomputeObjectiveProgress(deps, actor, row.parentId ?? null);
  return restored;
}

/**
 * Which of these goals are objectives whose progress is being derived from key results, in one query.
 *
 * The page needs it per row (to hide a slider that would be overwritten), and asking per row would be a query
 * per card.
 */
export async function objectivesWithKeyResults(deps: Deps, goalIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!goalIds.length) return out;
  for (const ids of chunk(goalIds, ID_CHUNK)) {
    const rows = await deps.db
      .selectDistinct({ parentId: schema.goals.parentId })
      .from(schema.goals)
      .where(and(
        inArray(schema.goals.parentId, ids),
        eq(schema.goals.kind, "key_result"),
        isNull(schema.goals.deleteTime),
        ne(schema.goals.status, "cancelled"),
      ));
    for (const r of rows) if (r.parentId) out.add(r.parentId);
  }
  return out;
}

/**
 * The parent a key result is being hung on has to be an OBJECTIVE.
 *
 * "A key result needs an objective to sit under" was enforced as "needs a parent", which let a key result hang
 * off another key result. Two things followed. The roll-up recurses: a KR write re-derives its parent, and if
 * that parent is itself a KR the write re-derives ITS parent in turn, several D1 reads per level against a
 * per-invocation subrequest budget. And the model stops meaning anything - a key result is the number that
 * proves an objective, so a key result of a key result proves nothing and appears in no objective's roll-up.
 * A KR is a leaf, and this is the rule that makes the tree exactly two deep.
 */
async function assertObjective(deps: Deps, parentId: string | null | undefined): Promise<void> {
  if (!parentId) return; // the caller has already refused a key result with no parent at all
  const parent = (await deps.db.select({ kind: schema.goals.kind }).from(schema.goals).where(eq(schema.goals.uuid, parentId)).limit(1))[0];
  if (parent?.kind === "key_result") throw invalidArgument("a key result cannot sit under another key result - align it to the objective instead");
}

/** Whether this goal's progress belongs to its key results rather than to whoever is typing. */
async function hasKeyResults(deps: Deps, goalId: string): Promise<boolean> {
  const kr = (await deps.db
    .select({ uuid: schema.goals.uuid })
    .from(schema.goals)
    .where(and(eq(schema.goals.parentId, goalId), eq(schema.goals.kind, "key_result"), isNull(schema.goals.deleteTime), ne(schema.goals.status, "cancelled")))
    .limit(1))[0];
  return !!kr;
}

/** Whether this org runs the goal-setting handshake at all (settings/performance). Off by default. */
export async function goalApprovalOn(deps: Deps): Promise<boolean> {
  const framework = await getSettingValue<PerformanceFramework>(deps, "performance", DEFAULT_PERFORMANCE);
  return framework.goal_approval === "required";
}

// Move one goal along the agreement ladder, guarded on the stage the caller validated so a double-clicked
// approve fires its notification once (the same exactly-once shape the review stages use).
async function applyStage(deps: Deps, id: string, from: Stage, set: SetOf<typeof schema.goals>) {
  const updated = (await deps.db
    .update(schema.goals)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(schema.goals.uuid, id), eq(schema.goals.stage, from)))
    .returning())[0];
  if (!updated) throw failedPrecondition("this goal has already moved past that stage");
  return updated;
}

async function loadOpenGoal(deps: Deps, id: string) {
  const row = (await deps.db.select().from(schema.goals).where(eq(schema.goals.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("goal not found");
  return row;
}

/**
 * The `propose` verb: hand a draft goal to the manager to agree.
 *
 * The bookend the module was missing. A review now scores people against their goals, and until this existed
 * nothing recorded that the goals had ever been accepted by the person doing the scoring - the attainment
 * figure rested on a set one party had typed alone.
 */
export async function proposeGoal(deps: Deps, actor: AppUser, id: string) {
  const row = await loadOpenGoal(deps, id);
  if (row.stage !== "DRAFT") throw failedPrecondition("only a draft goal can be submitted for approval");
  if (!row.title.trim()) throw invalidArgument("give the goal a title before submitting it");
  const updated = await applyStage(deps, id, "DRAFT", { stage: "PROPOSED" });
  await audit(deps, actor, "goal.propose", "goals", id, stateMeta("DRAFT", "PROPOSED", { employee: `employees/${row.employeeId}` }), updated);
  await emitEvent(deps, actor, "goal.proposed", { subject: `goals/${id}`, employeeId: row.employeeId, payload: { title: row.title, weight: row.weight } });
  const mgr = await managerIdOf(deps, row.employeeId);
  if (mgr && mgr !== actor.employeeId)
    await notify(deps, { recipient: mgr, type: "goal.proposed", title: "Goal waiting for your approval", body: row.title, link: "goals", subject: `goals/${id}`, action: "respond", actorId: row.employeeId });
  return updated;
}

/**
 * The `approve` verb: the manager accepts the goal, and the record says who agreed it and when.
 *
 * Only from PROPOSED, symmetrically with `proposeGoal` (DRAFT only) and `requestGoalChanges` (PROPOSED only).
 * The guard used to be `stage !== "AGREED"` alone, which let DRAFT -> AGREED through: a goal the owner was
 * still writing could be agreed out from under them, stamped `agreed_by`, and then scored in their review as
 * something they had signed up to. Nothing legitimately needs that hop - a goal a MANAGER sets for a report
 * is born AGREED in `createGoal`, and the drawer only offers "Agree this goal" on a PROPOSED one.
 */
export async function approveGoal(deps: Deps, actor: AppUser, id: string) {
  const row = await loadOpenGoal(deps, id);
  if (row.stage === "AGREED") throw failedPrecondition("this goal is already agreed");
  if (row.stage !== "PROPOSED") throw failedPrecondition("only a proposed goal can be agreed - the owner submits it first");
  const updated = await applyStage(deps, id, row.stage, { stage: "AGREED", agreedAt: new Date(), agreedById: actor.employeeId ?? null });
  await audit(deps, actor, "goal.approve", "goals", id, stateMeta(row.stage, "AGREED", { employee: `employees/${row.employeeId}` }), updated);
  await emitEvent(deps, actor, "goal.agreed", { subject: `goals/${id}`, employeeId: row.employeeId, payload: { title: row.title, weight: row.weight } });
  if (row.employeeId !== actor.employeeId)
    await notify(deps, { recipient: row.employeeId, type: "goal.agreed", title: "Goal agreed", body: row.title, link: "goals", subject: `goals/${id}`, actorId: actor.employeeId });
  return updated;
}

/**
 * The `requestChanges` verb: send a proposed goal back, with the reason on the goal itself.
 *
 * The note goes in as a comment rather than into a field of its own: "make this measurable" is the start of a
 * conversation the goal already has a thread for, and a rejection reason that lives somewhere the reply cannot
 * reach is a rejection nobody answers.
 */
export async function requestGoalChanges(deps: Deps, actor: AppUser, id: string, note?: string | null) {
  const row = await loadOpenGoal(deps, id);
  if (row.stage !== "PROPOSED") throw failedPrecondition("only a proposed goal can be sent back");
  const text = (note ?? "").trim();
  if (!text) throw invalidArgument("say what needs changing");
  const updated = await applyStage(deps, id, "PROPOSED", { stage: "DRAFT" });
  await deps.db.insert(schema.goalComments).values({ goalId: id, authorId: actor.employeeId ?? null, authorEmail: actor.email, body: text });
  await audit(deps, actor, "goal.requestChanges", "goals", id, stateMeta("PROPOSED", "DRAFT", { employee: `employees/${row.employeeId}`, note: text.slice(0, 140) }), updated);
  await notify(deps, { recipient: row.employeeId, type: "goal.changes_requested", title: "Goal sent back", body: `${row.title} - ${text.slice(0, 140)}`, link: "goals", subject: `goals/${id}`, action: "respond", actorId: actor.employeeId });
  return updated;
}

/**
 * The `setConfidence` verb: say whether this lands, without opening the edit form.
 *
 * Narrow on purpose, exactly like `updateProgress`: an owner may have to report on a goal whose DEFINITION
 * (title, weight, target) is their manager's to change, and asking for full edit rights to admit a goal is
 * slipping is how orgs end up with nobody admitting it.
 */
export async function setGoalConfidence(
  deps: Deps,
  actor: AppUser,
  id: string,
  confidence: "on_track" | "at_risk" | "off_track",
  note?: string | null,
) {
  const row = (await deps.db.select().from(schema.goals).where(eq(schema.goals.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("goal not found");
  if (row.status === "completed" || row.status === "cancelled") throw invalidArgument("this goal is already closed");
  const set: SetOf<typeof schema.goals> = { confidence, updatedAt: new Date() };
  if (note !== undefined) set.confidenceNote = note?.trim() || null;
  const updated = (await deps.db.update(schema.goals).set(set).where(eq(schema.goals.uuid, id)).returning())[0]!;
  await audit(deps, actor, "goal.setConfidence", "goals", id, {
    employee: `employees/${row.employeeId}`,
    diff: { confidence: { from: row.confidence, to: confidence } },
    ...(set.confidenceNote ? { note: set.confidenceNote as string } : {}),
  }, updated);
  if (updated.confidence !== row.confidence) await emitConfidence(deps, actor, row.confidence, updated);
  return updated;
}

export type GoalHistoryPoint = { at: Date; progress: number };

/**
 * How this goal's progress actually moved, read back out of the audit trail.
 *
 * Every progress write already records `{from, to}` (`goal.updateProgress`) or a `progress` field diff
 * (`goal.update`, including the ones the linked-task rollup makes), so the series has been accumulating since
 * the feature shipped and nobody has ever read it. Without it, "crawled to 90% in the last three days of the
 * quarter" and "climbed steadily all quarter" are the same goal at review time.
 *
 * Derived rather than stored: a progress-history table would be a second copy of the audit log, and one that
 * could disagree with it. Capped, and read only on the item Get - the wall of cards asks for none of this.
 */
export async function goalHistory(deps: Deps, id: string, createdAt: Date | number, opening = 0): Promise<GoalHistoryPoint[]> {
  const rows = (await deps.db
    .select({ at: schema.auditLog.at, action: schema.auditLog.action, meta: schema.auditLog.meta })
    .from(schema.auditLog)
    .where(and(
      eq(schema.auditLog.entity, "goals"),
      eq(schema.auditLog.entityId, id),
      inArray(schema.auditLog.action, ["goal.updateProgress", "goal.update"]),
    ))
    // NEWEST first under the cap, then flipped back. Every card linked to or delivered against this goal
    // re-rolls its progress and writes a `goal.update`, so a goal on a busy board passes 200 recorded moves
    // inside a year - and an `asc` cap keeps that goal's first fortnight while dropping the quarter anybody
    // is looking at. Nothing is lost by trimming the far end instead: the opening point below is synthesized
    // from the goal's own creation value, so the line still starts at the beginning either way.
    .orderBy(desc(schema.auditLog.at))
    .limit(200)) as { at: Date; action: string; meta: string | null }[];
  rows.reverse();
  // Where the goal started: its creation value, so a line drawn from these points begins at the beginning
  // rather than at whatever the first recorded move happened to leave behind.
  const points: GoalHistoryPoint[] = [{ at: new Date(createdAt), progress: opening }];
  for (const r of rows) {
    let meta: Record<string, unknown> = {};
    try { meta = r.meta ? JSON.parse(r.meta) : {}; } catch { continue; }
    // Two meta shapes: the verb writes {from, to}; an update writes a field diff.
    const diff = (meta.diff ?? {}) as Record<string, { from?: unknown; to?: unknown }>;
    const to = r.action === "goal.updateProgress" ? meta.to : diff.progress?.to;
    if (typeof to !== "number" || Number.isNaN(to)) continue;
    points.push({ at: new Date(r.at), progress: Math.max(0, Math.min(100, to)) });
  }
  return points;
}

// A goal plus its comments (oldest first) and its progress history - the item Get and the answer to
// `:comment`. Both are the OPEN goal's business: a page of cards reads neither.
export async function getGoalWithComments(deps: Deps, id: string) {
  const row = (await deps.db.select().from(schema.goals).where(eq(schema.goals.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("goal not found");
  const [comments, history] = await Promise.all([
    deps.db.select().from(schema.goalComments).where(eq(schema.goalComments.goalId, id)).orderBy(asc(schema.goalComments.createdAt)),
    goalHistory(deps, id, row.createdAt),
  ]);
  return { ...row, _comments: comments, _history: history };
}

// The `comment` verb: a note on the goal that both sides can read, which is what a quarterly goal actually
// needs - the owner's progress note only ever travelled one way, into the audit trail.
export async function commentGoal(deps: Deps, actor: AppUser, id: string, body?: string | null) {
  const row = (await deps.db.select().from(schema.goals).where(eq(schema.goals.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("goal not found");
  const text = (body ?? "").trim();
  if (!text) throw invalidArgument("a comment body is required");
  await deps.db.insert(schema.goalComments).values({ goalId: id, authorId: actor.employeeId ?? null, authorEmail: actor.email, body: text });
  await audit(deps, actor, "goal.comment", "goals", id, { employee: `employees/${row.employeeId}`, note: text.length > 140 ? `${text.slice(0, 140)}…` : text }, row);
  // The other party is told, because a comment nobody sees is a comment nobody answers: the owner hears from a
  // manager, and the manager hears from their report.
  const other = actor.employeeId === row.employeeId ? await managerIdOf(deps, row.employeeId) : row.employeeId;
  if (other && other !== actor.employeeId)
    await notify(deps, { recipient: other, type: "goal.comment", title: `Comment on “${row.title}”`, body: text.slice(0, 140), link: "goals", subject: `goals/${id}`, actorId: actor.employeeId });
  await notifyMentions(deps, actor, { subject: `goals/${id}`, link: "goals", type: "goal.mention", body: text, title: row.title });
  await notifyGoalWatchers(deps, actor, row, {
    type: "goal.comment",
    title: `Comment on “${row.title}”`,
    body: text.slice(0, 140),
  }, [other, row.employeeId]);
  return getGoalWithComments(deps, id);
}

// The `updateProgress` verb: move just a goal's progress (and optionally its status), so the org can grant an
// employee progress-only rights on goals whose definition a manager owns - without full edit access.
export async function updateGoalProgress(deps: Deps, actor: AppUser, id: string, progress: number, status?: Status, note?: string, fromRollup = false) {
  const row = (await deps.db.select().from(schema.goals).where(eq(schema.goals.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("goal not found");
  if (progress == null || Number.isNaN(Number(progress))) throw invalidArgument("progress is required");
  // An objective's percentage belongs to its key results. `fromRollup` is the roll-up itself writing it.
  if (!fromRollup && (await hasKeyResults(deps, id)))
    throw failedPrecondition("this objective's progress comes from its key results - move one of those instead");
  const set: SetOf<typeof schema.goals> = { progress: clampPct(Number(progress)), updatedAt: new Date() };
  if (status) set.status = status;
  const updated = (await deps.db.update(schema.goals).set(set).where(eq(schema.goals.uuid, id)).returning())[0]!;
  // from/to (+ optional note) land in the audit meta so the activity feed can render a progress history.
  await audit(deps, actor, "goal.updateProgress", "goals", id, { from: row.progress, to: updated.progress, ...(note?.trim() ? { note: note.trim() } : {}) }, updated);
  await emitGoalProgress(deps, actor, updated);
  // Watchers hear a real move, not a re-save at the same number - and not a roll-up, which is the same news
  // arriving from the key result they are already watching.
  if (!fromRollup && updated.progress !== row.progress) {
    await notifyGoalWatchers(deps, actor, updated, {
      type: "goal.progress",
      title: updated.status === "completed" ? `Completed: ${updated.title}` : `Progress on “${updated.title}”`,
      body: `${row.progress}% → ${updated.progress}%${note?.trim() ? ` - ${note.trim().slice(0, 140)}` : ""}`,
    }, [updated.employeeId]);
  }
  if (updated.kind === "key_result") await recomputeObjectiveProgress(deps, actor, updated.parentId);
  return updated;
}


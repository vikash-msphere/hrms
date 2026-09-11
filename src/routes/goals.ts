import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { objectivesWithKeyResults, setGoalContributors, contributorsFor, suggestedContributorsFor, watchGoal, goalWatchersFor, loggedHoursFor, listGoals, createGoal, updateGoal, updateGoalProgress, setGoalConfidence, proposeGoal, approveGoal, requestGoalChanges, getGoalWithComments, commentGoal, deleteGoal, restoreGoal, linkedTaskRollup, lastCommentAtFor, type GoalInput } from "../services/goals";
import { toGoalResource } from "../http/serialize";

const statusEnum = z.enum(["not_started", "in_progress", "completed", "cancelled"]);
const confidenceEnum = z.enum(["on_track", "at_risk", "off_track"]);
const createSchema = z
  .object({
    employee: z.string().nullable().optional(),
    parent: z.string().nullable().optional(),
    cycle: z.string().nullable().optional(),
    title: z.string().min(1),
    description: z.string().nullable().optional(),
    weight: z.number().optional(),
    progress: z.number().optional(),
    status: statusEnum.optional(),
    kind: z.enum(["objective", "key_result"]).optional(),
    due_date: z.string().nullable().optional(),
    // The owner's forward-looking call. Also settable on its own through `:setConfidence`, which is the door
    // somebody with progress-only rights uses.
    confidence: confidenceEnum.nullable().optional(),
    confidence_note: z.string().max(500).nullable().optional(),
    blocked_by: z.string().nullable().optional(),
    retro: z.string().max(4000).nullable().optional(),
    department: z.string().nullable().optional(),
    // The measure. With a target and a current value set, `progress` is computed from them and anything sent
    // in `progress` is ignored - see services/goals.ts#measuredProgress.
    unit: z.string().max(24).nullable().optional(),
    baseline_value: z.number().nullable().optional(),
    target_value: z.number().nullable().optional(),
    current_value: z.number().nullable().optional(),
  })
  .strict();
const updateSchema = createSchema.partial().strict();
const progressSchema = z.object({ progress: z.number(), status: statusEnum.optional(), note: z.string().max(500).optional() }).strict();
const commentSchema = z.object({ body: z.string().min(1).max(4000) }).strict();
const confidenceSchema = z.object({ confidence: confidenceEnum, note: z.string().max(500).nullable().optional() }).strict();
const changesSchema = z.object({ note: z.string().min(1).max(2000) }).strict();
const contributorsSchema = z.object({
  contributors: z.array(z.object({
    employee: z.string(),
    share: z.number().min(0).max(100).optional(),
    note: z.string().max(200).nullable().optional(),
  }).strict()).max(20),
}).strict();

// Goals and OKRs. Create and update stay the service's own (a goal rolls its progress up to its parent, and an
// aligned child re-weights its siblings); :updateProgress is the narrow move for someone who may report
// progress without full edit rights. Delete/restore are the shared soft-delete lane.
export const goals = collectionRoutes<GoalInput, typeof schema.goals>({
  table: schema.goals,
  collection: "goals",
  auditName: "goal",
  notFound: "goal not found",
  param: "goal_id",
  createSchema,
  updateSchema,
  // The viewer's own id rides along so the serializer can answer `watching` - the state of the watch button -
  // rather than shipping the watcher list for a client to match against itself.
  serialize: (row, user) => toGoalResource(Object.assign(row, { _viewerEmployeeId: user?.employeeId ?? null })),
  // A hard purge takes the goal's conversation with it, and cuts the two links that point AT the goal without
  // being part of it: a child goal aligned under it, and a task card linked to it. Both records have a life of
  // their own and outlive the goal with the pointer cleared - unlike the comments, which are unreachable once
  // the goal is gone. Undeclared, all three were foreign keys that turned `DELETE ?force=true` into a 500.
  purgeCascade: {
    remove: [
      { table: schema.goalComments, column: schema.goalComments.goalId },
      // Watchers and credited shares are only meaningful about a goal that exists; both are unreachable once
      // it is gone, so a hard purge takes them rather than leaving foreign keys that 409 the delete.
      { table: schema.goalWatchers, column: schema.goalWatchers.goalId },
      { table: schema.goalContributors, column: schema.goalContributors.goalId },
    ],
    detach: [
      { table: schema.goals, column: schema.goals.parentId },
      { table: schema.cards, column: schema.cards.goalId },
      // The other two pointers AT a goal, both missing until the purge was found to answer 409 over them
      // after the comments were already gone: the goal this one was blocking, and a project delivering it.
      // Same argument as the parent link - the blocked goal and the project outlive this one with the
      // pointer cleared, so they are detached rather than removed.
      { table: schema.goals, column: schema.goals.blockedById },
      { table: schema.projects, column: schema.projects.goalId },
    ],
  },
  // Two grouped queries for a whole page: the linked-task delivery rollup ("3/5 tasks · 8/13 pts"), and when
  // each goal was last commented on - which is half of the silence the serializer reports, the other half
  // being the row's own `updated_at`. Both are answered here rather than by a client reading and grouping
  // whole collections to render a chip.
  decorate: async (deps, _actor, rows) => {
    const ids = rows.map((r) => r.uuid);
    const [roll, commented, rolledUp, contributors, suggested, watchers, hours] = await Promise.all([
      linkedTaskRollup(deps, ids), lastCommentAtFor(deps, ids), objectivesWithKeyResults(deps, ids), contributorsFor(deps, ids),
      // The split the linked tasks already imply, so the contributor editor opens on the board's own numbers
      // instead of an empty form somebody fills in from a calculator.
      suggestedContributorsFor(deps, rows.map((r) => ({ uuid: r.uuid, employeeId: r.employeeId }))),
      // Watchers ride the list as well as the item: the eye is on the goal card, and a read per card is
      // exactly the shape this app does not do.
      goalWatchersFor(deps, ids),
      loggedHoursFor(deps, ids),
    ]);
    return rows.map((r) => ({
      ...r,
      _tasks: roll.get(r.uuid),
      _lastCommentAt: commented.get(r.uuid),
      _rolledUp: rolledUp.has(r.uuid),
      _contributors: contributors.get(r.uuid) ?? [],
      _suggestedContributors: suggested.get(r.uuid) ?? [],
      _watchers: watchers.get(r.uuid) ?? [],
      _hours: hours.get(r.uuid),
    }));
  },
  overrides: {
    create: (deps, actor, input, id) => createGoal(deps, actor, input, id),
    update: (deps, actor, id, patch, ifMatch) => updateGoal(deps, actor, id, patch, ifMatch),
    // The item Get carries the comment thread and the progress history; the list carries neither (one goal's
    // conversation and its shape over time, read when it is actually open).
    get: (deps, _actor, id) => getGoalWithComments(deps, id),
    // Deleting or restoring a KEY RESULT changes what its objective adds up to, so both re-roll it. The shared
    // soft-delete lane still does the deleting; these only add the roll-up after it.
    remove: (deps, actor, id, ifMatch) => deleteGoal(deps, actor, id, ifMatch),
    restore: (deps, actor, id) => restoreGoal(deps, actor, id),
  },
  list: (c, page) => listGoals(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, c.req.query("status"), page.showDeleted, c.req.query("cycle"), c.req.query("burnup") === "true", c.req.query("stage")),
  verbs: {
    updateProgress: { schema: progressSchema, run: (deps, user, id, body) => updateGoalProgress(deps, user, id, body.progress, body.status, body.note) },
    setConfidence: { schema: confidenceSchema, run: (deps, user, id, body) => setGoalConfidence(deps, user, id, body.confidence, body.note) },
    // The goal-setting handshake: the owner submits, the manager agrees or sends it back with a reason.
    propose: { run: (deps, user, id) => proposeGoal(deps, user, id) },
    approve: { run: (deps, user, id) => approveGoal(deps, user, id) },
    requestChanges: { schema: changesSchema, run: (deps, user, id, body) => requestGoalChanges(deps, user, id, body.note) },
    // Who else worked on it, and how much of it was theirs. Replaces the whole set: the shares only mean
    // anything together.
    setContributors: { schema: contributorsSchema, run: (deps, user, id, body) => setGoalContributors(deps, user, id, body.contributors) },
    comment: { schema: commentSchema, run: (deps, user, id, body) => commentGoal(deps, user, id, body.body) },
    // Follow somebody else's goal your own plans turn on. Idempotent both ways.
    watch: { run: (deps, user, id) => watchGoal(deps, user, id, true) },
    unwatch: { run: (deps, user, id) => watchGoal(deps, user, id, false) },
  },
});

import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { listGoals, createGoal, updateGoal, updateGoalProgress, getGoalWithComments, commentGoal, linkedTaskRollup, type GoalInput } from "../services/goals";
import { toGoalResource } from "../http/serialize";

const statusEnum = z.enum(["not_started", "in_progress", "completed", "cancelled"]);
const createSchema = z
  .object({
    employee: z.string().nullable().optional(),
    parent: z.string().nullable().optional(),
    title: z.string().min(1),
    description: z.string().nullable().optional(),
    weight: z.number().optional(),
    progress: z.number().optional(),
    status: statusEnum.optional(),
    due_date: z.string().nullable().optional(),
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
  serialize: toGoalResource,
  // The linked-task delivery rollup ("3/5 tasks · 8/13 pts"), resolved once per page rather than per row - and
  // so a client can render it without reading the whole `cards` collection to group it itself.
  decorate: async (deps, _actor, rows) => {
    const roll = await linkedTaskRollup(deps, rows.map((r) => r.uuid));
    return rows.map((r) => ({ ...r, _tasks: roll.get(r.uuid) }));
  },
  overrides: {
    create: (deps, actor, input, id) => createGoal(deps, actor, input, id),
    update: (deps, actor, id, patch, ifMatch) => updateGoal(deps, actor, id, patch, ifMatch),
    // The item Get carries the comment thread; the list does not (one goal's conversation, read when it's open).
    get: (deps, _actor, id) => getGoalWithComments(deps, id),
  },
  list: (c, page) => listGoals(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, c.req.query("status"), page.showDeleted),
  verbs: {
    updateProgress: { schema: progressSchema, run: (deps, user, id, body) => updateGoalProgress(deps, user, id, body.progress, body.status, body.note) },
    comment: { schema: commentSchema, run: (deps, user, id, body) => commentGoal(deps, user, id, body.body) },
  },
});

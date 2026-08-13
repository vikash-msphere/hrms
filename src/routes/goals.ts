import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { listGoals, createGoal, updateGoal, updateGoalProgress, type GoalInput } from "../services/goals";
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
  })
  .strict();
const updateSchema = createSchema.partial().strict();
const progressSchema = z.object({ progress: z.number(), status: statusEnum.optional(), note: z.string().max(500).optional() }).strict();

// Goals and OKRs. Create and update stay the service's own (a goal rolls its progress up to its parent, and an
// aligned child re-weights its siblings); :updateProgress is the narrow move for someone who may report
// progress without full edit rights. Delete/restore are the shared soft-delete lane.
export const goals = collectionRoutes<GoalInput>({
  table: schema.goals,
  collection: "goals",
  auditName: "goal",
  notFound: "goal not found",
  param: "goal_id",
  createSchema,
  updateSchema,
  serialize: toGoalResource,
  overrides: {
    create: (deps, actor, input, id) => createGoal(deps, actor, input, id),
    update: (deps, actor, id, patch, ifMatch) => updateGoal(deps, actor, id, patch, ifMatch),
  },
  list: (c, page) => listGoals(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, c.req.query("status"), page.showDeleted),
  verbs: {
    updateProgress: { schema: progressSchema, run: (deps, user, id, body) => updateGoalProgress(deps, user, id, body.progress, body.status, body.note) },
  },
});

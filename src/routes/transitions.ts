import { z } from "zod";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { collectionRoutes } from "../http/collectionRoute";
import {
  listTransitions, createTransition, updateTransition,
  setTransitionState, appendTransitionTask, tasksForTransitions, purgeTransition,
  type TransitionInput,
} from "../services/transitions";
import { toTransitionResource } from "../http/serialize";

const writeSchema = z.object({
  employee: z.string().nullable().optional(),
  kind: z.enum(["onboarding", "offboarding"]).optional(),
  template: z.string().nullable().optional(),
  anchor_date: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
}).strict();

const appendTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  assignee: z.string().nullable().optional(),
  due_date: z.string().nullable().optional(),
}).strict();

// A transition always answers with its checklist attached, so every read and every write hangs the tasks on
// the row first - one query per page, one per single row.
const withTasks = async <T extends { uuid: string }>(deps: Deps, rows: T[]) => {
  const tasks = await tasksForTransitions(deps, rows.map((r) => r.uuid));
  return rows.map((r) => Object.assign(r, { _tasks: tasks.get(r.uuid) ?? [] }));
};

// Onboarding / offboarding runs. Create and update stay the service's own (a create instantiates the chosen
// template's tasks; an update can move the anchor date and every task's due date with it), and the three
// state moves plus appendTask are the verbs. Delete/restore are the shared soft-delete lane.
export const transitions = collectionRoutes<TransitionInput, typeof schema.transitions>({
  table: schema.transitions,
  collection: "transitions",
  auditName: "transition",
  notFound: "transition not found",
  param: "transition_id",
  writeSchema,
  serialize: toTransitionResource,
  decorate: (deps, _actor, rows) => withTasks(deps, rows),
  overrides: {
    create: (deps, actor, input, id) => createTransition(deps, actor, input, id),
    update: (deps, actor, id, patch, ifMatch) => updateTransition(deps, actor, id, patch, ifMatch),
    // A hard purge has to take the transition's tasks with it - they carry the FK.
    purge: (deps, actor, id, ifMatch) => purgeTransition(deps, actor, id, ifMatch),
  },
  list: (c, page) =>
    listTransitions(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, c.req.query("kind"), c.req.query("state"), page.showDeleted),
  verbs: {
    complete: { run: (deps, user, id) => setTransitionState(deps, user, id, "COMPLETED") },
    cancel: { run: (deps, user, id) => setTransitionState(deps, user, id, "CANCELLED") },
    reopen: { run: (deps, user, id) => setTransitionState(deps, user, id, "ACTIVE") },
    appendTask: { schema: appendTaskSchema, run: (deps, user, id, body) => appendTransitionTask(deps, user, id, body) },
  },
});

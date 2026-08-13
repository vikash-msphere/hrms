import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { listSprints, createSprint, updateSprint, activateSprint, completeSprint, purgeSprint, type SprintInput } from "../services/sprints";
import { toSprintResource } from "../http/serialize";

const createSchema = z.object({
  board: z.string().min(1),
  name: z.string().min(1),
  goal: z.string().nullable().optional(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
}).strict();
const updateSchema = z.object({
  name: z.string().min(1).optional(),
  goal: z.string().nullable().optional(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
}).strict();

// Scrum sprints on a board. :activate starts one (only one at a time) and :complete rolls unfinished cards on.
export const sprints = collectionRoutes<SprintInput>({
  table: schema.sprints,
  collection: "sprints",
  auditName: "sprint",
  notFound: "sprint not found",
  param: "sprint_id",
  createSchema,
  updateSchema,
  serialize: toSprintResource,
  overrides: {
    create: (deps, actor, input, id) => createSprint(deps, actor, input, id),
    update: (deps, actor, id, patch, ifMatch) => updateSprint(deps, actor, id, patch, ifMatch),
    // A hard purge has to detach the sprint's cards first - they carry the FK.
    purge: (deps, actor, id, ifMatch) => purgeSprint(deps, actor, id, ifMatch),
  },
  list: (c, page) => {
    // A sprint is visible through its board, so the list scopes by the caller rather than by a code filter.
    const board = c.req.query("board");
    return listSprints(c.get("deps"), c.get("user"), page.maxPageSize, page.pageToken, board ? board.split("/").pop() : undefined, page.showDeleted);
  },
  verbs: {
    activate: { run: (deps, user, id) => activateSprint(deps, user, id) },
    complete: { run: (deps, user, id) => completeSprint(deps, user, id) },
  },
});

import { z } from "zod";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { collectionRoutes } from "../http/collectionRoute";
import { listBoards, createBoard, updateBoard, configureBoard, boardMetrics, cardCountsFor, purgeBoard, type BoardInput } from "../services/boards";
import { toBoardResource } from "../http/serialize";

const modeEnum = z.enum(["kanban", "scrum"]);
const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
  task_prefix: z.string().optional(),
  mode: modeEnum.optional(),
  columns: z.array(z.any()).optional(),
  swimlane_mode: z.string().optional(),
  swimlanes: z.array(z.any()).optional(),
  labels: z.array(z.any()).optional(),
}).strict();
const updateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
  task_prefix: z.string().optional(),
  mode: modeEnum.optional(),
}).strict();
const configureSchema = z.object({
  columns: z.array(z.any()).optional(),
  swimlane_mode: z.string().optional(),
  swimlanes: z.array(z.any()).optional(),
  labels: z.array(z.any()).optional(),
  hide_empty_lanes: z.boolean().optional(),
  reassign_lane_on_move: z.boolean().optional(),
  no_lane_label: z.string().nullable().optional(),
}).strict();

// A board always reports how many cards it holds: one count query per page, one per single row.
const withCounts = async <T extends { uuid: string }>(deps: Deps, rows: T[]) => {
  const counts = await cardCountsFor(deps, rows.map((r) => r.uuid));
  return rows.map((r) => Object.assign(r, { _cardCount: counts.get(r.uuid) ?? 0 }));
};

// Kanban / scrum boards. :configure owns the column, swimlane and label layout (a PATCH edits the board's
// identity, not its shape); :metrics answers with flow analytics rather than the board resource.
export const boards = collectionRoutes<BoardInput>({
  table: schema.boards,
  collection: "boards",
  auditName: "board",
  notFound: "board not found",
  param: "board_id",
  createSchema,
  updateSchema,
  serialize: toBoardResource,
  decorate: (deps, _actor, rows) => withCounts(deps, rows),
  overrides: {
    create: (deps, actor, input, id) => createBoard(deps, actor, input, id),
    update: (deps, actor, id, patch, ifMatch) => updateBoard(deps, actor, id, patch, ifMatch),
    // A hard purge tears the board's children down bottom-up (movements, then cards) before the row itself.
    purge: (deps, actor, id, ifMatch) => purgeBoard(deps, actor, id, ifMatch),
  },
  // Board visibility follows membership and department, so the list scopes by the caller.
  list: (c, page) => listBoards(c.get("deps"), c.get("user"), page.maxPageSize, page.pageToken, page.showDeleted),
  verbs: {
    configure: { schema: configureSchema, run: (deps, user, id, body) => configureBoard(deps, user, id, body) },
    metrics: {
      raw: async (c, id) => c.json(await boardMetrics(c.get("deps"), c.get("user"), id, Number(c.req.query("days")) || undefined) as object),
    },
  },
});

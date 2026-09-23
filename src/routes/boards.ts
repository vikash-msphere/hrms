import { z } from "zod";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { collectionRoutes } from "../http/collectionRoute";
import { listBoards, createBoard, updateBoard, configureBoard, boardMetrics, cardCountsFor, purgeBoard, type BoardInput } from "../services/boards";
import { boardDuplicates } from "../services/cardDuplicateSweep";
import { narrateBoard } from "../services/boardNarrate";
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
export const boards = collectionRoutes<BoardInput, typeof schema.boards>({
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
  // Scoped by the caller exactly as the generic list is: `c.get("scope")` carries the breadth the middleware
  // decided AND the caller's per-object shares/denies, and the service binds it with `applyScope`.
  list: (c, page) => listBoards(c.get("deps"), c.get("user"), c.get("scope"), page.maxPageSize, page.pageToken, page.showDeleted, page.deletedOnly),
  verbs: {
    configure: { schema: configureSchema, run: (deps, user, id, body) => configureBoard(deps, user, id, body) },
    metrics: {
      raw: async (c, id) => c.json(await boardMetrics(c.get("deps"), c.get("user"), id, Number(c.req.query("days")) || undefined) as object),
    },
    // What changed on this board, in a sentence. Arithmetic finds the movements; the model only writes them
    // up, and a sentence carrying a number nobody computed is discarded in favour of the plain one.
    narrate: {
      raw: async (c, id) => c.json(await narrateBoard(c.get("deps"), c.get("user")!, id, Number(c.req.query("days")) || undefined)),
    },
    // What the nightly sweep found on this board: pairs of open cards that look like the same work.
    //
    // A read of OTHER cards, so it binds the caller's own card list scope (SCOPE_READING_VERBS) - both halves
    // of every pair are re-checked, and a pair with a card they cannot list is dropped rather than half-shown.
    duplicates: {
      raw: async (c, id) => c.json({ duplicates: await boardDuplicates(c.get("deps"), c.get("scope"), id) }),
    },
  },
});

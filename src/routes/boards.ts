import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv, AppUser } from "../env";
import {
  listBoards, getBoard, createBoard, updateBoard, configureBoard, boardMetrics,
  deleteBoard, restoreBoard, purgeBoard, cardCountsFor,
} from "../services/boards";
import { toBoardResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";
import type { Grant } from "../domain/permissions";

const COL = "boards";

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

async function serialize(deps: any, user: AppUser, row: any, grant?: Grant) {
  const counts = await cardCountsFor(deps, [row.uuid]);
  row._cardCount = counts.get(row.uuid) ?? 0;
  return withAccess(toBoardResource(row), user, COL, row?.code, grant);
}

export const boards = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listBoards(c.get("deps"), c.get("user"), maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    const counts = await cardCountsFor(c.get("deps"), items.map((r) => r.uuid));
    const results = items.map((r) => {
      (r as any)._cardCount = counts.get(r.uuid) ?? 0;
      return withAccess(toBoardResource(r), user, COL, r.code);
    });
    return c.json({ results, next_page_token: nextPageToken });
  })
  .get("/:board_id", async (c) => {
    const row = await getBoard(c.get("deps"), c.get("user"), c.req.param("board_id")!);
    return c.json(await serialize(c.get("deps"), c.get("user"), row, c.get("objectGrant")));
  })
  .post("/", zValidator("json", createSchema), async (c) => {
    const row = await createBoard(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(await serialize(c.get("deps"), c.get("user"), row, c.get("objectGrant")));
  })
  .patch("/:board_id", zValidator("json", updateSchema), async (c) => {
    const row = await updateBoard(c.get("deps"), c.get("user"), c.req.param("board_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(await serialize(c.get("deps"), c.get("user"), row, c.get("objectGrant")));
  })
  .delete("/:board_id", async (c) => {
    const id = c.req.param("board_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeBoard(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteBoard(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:board_id", async (c) => {
    const { id, verb } = customMethod(c);
    const deps = c.get("deps");
    const user = c.get("user");
    const out = (row: any) => serialize(deps, user, row, c.get("objectGrant")).then((r) => c.json(r));
    if (verb === "configure") {
      const body = configureSchema.parse(await c.req.json().catch(() => ({})));
      return out(await configureBoard(deps, user, id, body));
    }
    if (verb === "metrics") {
      const days = Number(c.req.query("days")) || undefined;
      return c.json(await boardMetrics(deps, user, id, days));
    }
    if (verb === "restore") return out(await restoreBoard(deps, user, id));
    return c.notFound();
  });

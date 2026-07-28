import { eq, inArray } from "drizzle-orm";
import { allocFlatCode } from "./codeAlloc";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, diffMeta, fieldDiff } from "../lib/audit";
import { invalidArgument, notFound, aborted } from "../lib/errors";
import { encodeCursor, decodeCursor } from "../http/pagination";
import { etagOf } from "../http/serialize";
import { visibleByDelete, softDeleteRow, restoreRow, purgeRow } from "./softDelete";
import {
  DEFAULT_BOARD_COLUMNS, DEFAULT_SCRUM_COLUMNS, normalizeColumns, normalizeSwimlanes, normalizeLabels,
  normalizePrefix, derivePrefix, parseColumns, type SwimlaneMode, SWIMLANE_MODES,
} from "../domain/boards";
import { computeBoardMetrics } from "../domain/boardMetrics";

export type BoardInput = {
  name?: string;
  description?: string | null;
  task_prefix?: string;
  mode?: "kanban" | "scrum";
  columns?: unknown;
  swimlane_mode?: string;
  swimlanes?: unknown;
  labels?: unknown;
  hide_empty_lanes?: boolean;
  reassign_lane_on_move?: boolean;
  no_lane_label?: string | null;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const asArgError = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    throw invalidArgument((e as Error).message);
  }
};

export async function listBoards(deps: Deps, _actor: AppUser, maxPageSize: number, pageToken?: string, showDeleted = false) {
  const all = visibleByDelete(await deps.db.select().from(schema.boards), showDeleted).sort(
    (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt) || a.uuid.localeCompare(b.uuid),
  );
  const cur = decodeCursor(pageToken);
  const start = cur
    ? all.findIndex((e) => +new Date(e.createdAt) < cur.createTimeMs || (+new Date(e.createdAt) === cur.createTimeMs && e.uuid > cur.uid))
    : 0;
  const slice = start < 0 ? [] : all.slice(start, start + maxPageSize);
  const last = slice[slice.length - 1];
  const nextPageToken = start >= 0 && start + maxPageSize < all.length && last ? encodeCursor(+new Date(last.createdAt), last.uuid) : undefined;
  return { items: slice, nextPageToken };
}

export async function getBoard(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.boards).where(eq(schema.boards.uuid, id)).limit(1))[0];
  if (!row) throw notFound("board not found");
  return row;
}

// How many (non-deleted) cards each board holds - for the wire `card_count`, in one query.
export async function cardCountsFor(deps: Deps, boardIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!boardIds.length) return map;
  const rows = await deps.db.select({ b: schema.cards.boardId, del: schema.cards.deleteTime }).from(schema.cards).where(inArray(schema.cards.boardId, boardIds));
  for (const r of rows) if (!r.del) map.set(r.b, (map.get(r.b) ?? 0) + 1);
  return map;
}

export async function createBoard(deps: Deps, actor: AppUser, input: BoardInput, id?: string) {
  if (!input.name?.trim()) throw invalidArgument("name is required");
  const mode = (input.swimlane_mode ?? "none") as SwimlaneMode;
  if (!SWIMLANE_MODES.includes(mode)) throw invalidArgument("swimlane_mode is invalid");
  const columns = input.columns != null ? asArgError(() => normalizeColumns(input.columns)) : input.mode === "scrum" ? DEFAULT_SCRUM_COLUMNS : DEFAULT_BOARD_COLUMNS;
  const swimlanes = asArgError(() => normalizeSwimlanes(input.swimlanes ?? []));
  const row = (await deps.db
    .insert(schema.boards)
    .values({
      code: await allocFlatCode(deps, schema.boards),
      ...(id ? { uuid: id } : {}),
      name: input.name.trim(),
      description: input.description?.trim() || null,
      taskPrefix: input.task_prefix != null ? normalizePrefix(input.task_prefix) : derivePrefix(input.name.trim()),
      mode: input.mode === "scrum" ? "scrum" : "kanban",
      columnsJson: JSON.stringify(columns),
      swimlaneMode: mode,
      swimlanesJson: JSON.stringify(swimlanes),
      labelsJson: JSON.stringify(input.labels != null ? asArgError(() => normalizeLabels(input.labels)) : []),
    })
    .returning())[0]!;
  await audit(deps, actor, "board.create", "boards", row.uuid, undefined, row);
  return row;
}

export async function updateBoard(deps: Deps, actor: AppUser, id: string, patch: BoardInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.boards).where(eq(schema.boards.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("board not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const has = (k: keyof BoardInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("name")) {
    if (!patch.name?.trim()) throw invalidArgument("name is required");
    set.name = patch.name.trim();
  }
  if (has("description")) set.description = patch.description?.trim() || null;
  if (has("task_prefix")) set.taskPrefix = normalizePrefix(patch.task_prefix);
  if (has("mode")) set.mode = patch.mode === "scrum" ? "scrum" : "kanban";
  const updated = (await deps.db.update(schema.boards).set(set).where(eq(schema.boards.uuid, id)).returning())[0]!;
  await audit(deps, actor, "board.update", "boards", id, diffMeta(row, updated, set), updated);
  return updated;
}

// The `configure` verb: replace the board's structural config (columns / WIP / policies / swimlanes / classes /
// goal roll-up) in one edit. Kept off the plain PATCH so the config is an explicit, grantable action.
export async function configureBoard(deps: Deps, actor: AppUser, id: string, input: BoardInput) {
  const row = await getBoard(deps, actor, id);
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const has = (k: keyof BoardInput) => Object.prototype.hasOwnProperty.call(input, k);
  if (has("columns")) set.columnsJson = JSON.stringify(asArgError(() => normalizeColumns(input.columns)));
  if (has("swimlane_mode")) {
    const mode = input.swimlane_mode as SwimlaneMode;
    if (!SWIMLANE_MODES.includes(mode)) throw invalidArgument("swimlane_mode is invalid");
    set.swimlaneMode = mode;
  }
  if (has("swimlanes")) set.swimlanesJson = JSON.stringify(asArgError(() => normalizeSwimlanes(input.swimlanes)));
  if (has("labels")) set.labelsJson = JSON.stringify(asArgError(() => normalizeLabels(input.labels)));
  if (has("hide_empty_lanes")) set.hideEmptyLanes = !!input.hide_empty_lanes;
  if (has("reassign_lane_on_move")) set.reassignLaneOnMove = !!input.reassign_lane_on_move;
  if (has("no_lane_label")) set.noLaneLabel = (input.no_lane_label ?? "").toString().trim() || null;
  const updated = (await deps.db.update(schema.boards).set(set).where(eq(schema.boards.uuid, row.uuid)).returning())[0]!;
  // Log only the fields that ACTUALLY changed value (not every field the form submitted). Scalars (toggles,
  // mode, label) carry a from→to so the feed shows "hide empty lanes: no → yes"; the large JSON blobs
  // (columns/swimlanes/labels) are name-only — a from→to of them would be unreadable.
  const BLOBS = new Set(["columnsJson", "swimlanesJson", "labelsJson"]);
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  const changed: string[] = [];
  for (const [k, v] of Object.entries(fieldDiff(row, updated, Object.keys(set)))) {
    if (BLOBS.has(k)) changed.push(k);
    else diff[k] = v;
  }
  const meta = Object.keys(diff).length || changed.length ? { ...(Object.keys(diff).length ? { diff } : {}), ...(changed.length ? { changed } : {}) } : undefined;
  await audit(deps, actor, "board.configure", "boards", row.uuid, meta, updated);
  return updated;
}

// The `metrics` verb: flow analytics (CFD + lead/cycle time + throughput) over the board's cards + movement
// log. `days` is the CFD/throughput window (default 30). Computation is pure (domain/boardMetrics); here we
// only fetch the rows. Read-gated by the board's access (the route decides), so it exposes only aggregates.
export async function boardMetrics(deps: Deps, actor: AppUser, id: string, days = 30) {
  const board = await getBoard(deps, actor, id);
  const cols = parseColumns(board.columnsJson).map((c) => ({ key: c.key, label: c.label }));
  const cardRows = await deps.db
    .select({ committedAt: schema.cards.committedAt, startedAt: schema.cards.startedAt, deliveredAt: schema.cards.deliveredAt })
    .from(schema.cards)
    .where(eq(schema.cards.boardId, id));
  const moveRows = await deps.db
    .select({ cardId: schema.cardMovements.cardId, toColumn: schema.cardMovements.toColumn, at: schema.cardMovements.at })
    .from(schema.cardMovements)
    .where(eq(schema.cardMovements.boardId, id));
  return computeBoardMetrics(
    cols,
    cardRows.map((c) => ({ committedAt: c.committedAt ? +new Date(c.committedAt) : null, startedAt: c.startedAt ? +new Date(c.startedAt) : null, deliveredAt: c.deliveredAt ? +new Date(c.deliveredAt) : null })),
    moveRows.map((m) => ({ cardId: m.cardId, toColumn: m.toColumn, at: +new Date(m.at) })),
    { days: Math.max(1, Math.min(180, days)) },
  );
}

export async function deleteBoard(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await softDeleteRow(deps, actor, schema.boards, "board", "boards", id, ifMatch);
}
export async function restoreBoard(deps: Deps, actor: AppUser, id: string) {
  return restoreRow(deps, actor, schema.boards, "board", "boards", id);
}
export async function purgeBoard(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  // Tear down children bottom-up (FKs): movements, then cards, then the board.
  await deps.db.delete(schema.cardMovements).where(eq(schema.cardMovements.boardId, id));
  await deps.db.delete(schema.cards).where(eq(schema.cards.boardId, id));
  await purgeRow(deps, actor, schema.boards, "board", "boards", id, ifMatch);
}

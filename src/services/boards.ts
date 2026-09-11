import { and, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { allocFlatCode, withFreshCode } from "./codeAlloc";
import { chunk, ID_CHUNK } from "../lib/dbBatch";
import * as schema from "../db/schema";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import type { ListScope } from "../domain/access";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import { audit, createdMeta, diffMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted } from "../lib/errors";
import { etagOf } from "../http/serialize";
import { softDeleteRow, restoreRow, purgeRow, type PurgeCascade } from "./softDelete";
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

// THE CALLER'S SCOPE IS BOUND HERE, like every other list in the app.
//
// This used to take the actor and ignore it (`_actor`), reading the whole table and paging it in JS. The
// breadth was harmless while `boards` is granted to nobody but super_admin - but `scope` carries more than a
// breadth: the middleware resolves the caller's per-object shares and DENIES onto it for every
// collection-level list (middleware/authz.ts), and `applyScope` is the only thing that binds them. So a
// per-object deny on a board simply evaporated, on a list, in the one direction that leaks. Deny-wins has to
// mean everywhere.
//
// `boards` has no owner column (it is a flat catalog with a `code`), so an own-scoped caller correctly gets
// nothing - the same fail-closed answer the generic list gives, rather than the whole table.
export async function listBoards(deps: Deps, _actor: AppUser, scope: ListScope | undefined, maxPageSize: number, pageToken?: string, showDeleted = false) {
  const conds: (SQL | undefined)[] = [applyScope(scope, schema.boards.code, undefined)];
  if (!showDeleted) conds.push(isNull(schema.boards.deleteTime));
  return keysetPage<typeof schema.boards.$inferSelect>(deps, schema.boards, "boards", and(...conds.filter(Boolean) as SQL[]), {
    max: maxPageSize,
    pageToken,
  });
}

async function getBoard(deps: Deps, _actor: AppUser, id: string) {
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
  const name = input.name.trim();
  const mode = (input.swimlane_mode ?? "none") as SwimlaneMode;
  if (!SWIMLANE_MODES.includes(mode)) throw invalidArgument("swimlane_mode is invalid");
  const columns = input.columns != null ? asArgError(() => normalizeColumns(input.columns)) : input.mode === "scrum" ? DEFAULT_SCRUM_COLUMNS : DEFAULT_BOARD_COLUMNS;
  const swimlanes = asArgError(() => normalizeSwimlanes(input.swimlanes ?? []));
  // The code is allocated inside the retry, so a board created at the same moment as somebody else's takes
  // the next number instead of failing (services/codeAlloc.ts withFreshCode).
  const row = (await withFreshCode(async () => deps.db
    .insert(schema.boards)
    .values({
      code: await allocFlatCode(deps, schema.boards),
      ...(id ? { uuid: id } : {}),
      name,
      description: input.description?.trim() || null,
      taskPrefix: input.task_prefix != null ? normalizePrefix(input.task_prefix) : derivePrefix(name),
      mode: input.mode === "scrum" ? "scrum" : "kanban",
      columnsJson: JSON.stringify(columns),
      swimlaneMode: mode,
      swimlanesJson: JSON.stringify(swimlanes),
      labelsJson: JSON.stringify(input.labels != null ? asArgError(() => normalizeLabels(input.labels)) : []),
    })
    .returning()))[0]!;
  await audit(deps, actor, "board.create", "boards", row.uuid, createdMeta(row, "boards"), row);
  return row;
}

export async function updateBoard(deps: Deps, actor: AppUser, id: string, patch: BoardInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.boards).where(eq(schema.boards.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("board not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: SetOf<typeof schema.boards> = { updatedAt: new Date() };
  const has = (k: keyof BoardInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("name")) {
    if (!patch.name?.trim()) throw invalidArgument("name is required");
    set.name = patch.name.trim();
  }
  if (has("description")) set.description = patch.description?.trim() || null;
  if (has("task_prefix")) set.taskPrefix = normalizePrefix(patch.task_prefix);
  if (has("mode")) set.mode = patch.mode === "scrum" ? "scrum" : "kanban";
  const updated = (await deps.db.update(schema.boards).set(set).where(eq(schema.boards.uuid, id)).returning())[0]!;
  await audit(deps, actor, "board.update", "boards", id, diffMeta(row, updated, set, "boards"), updated);
  return updated;
}

// The `configure` verb: replace the board's structural config (columns / WIP / policies / swimlanes / classes /
// goal roll-up) in one edit. Kept off the plain PATCH so the config is an explicit, grantable action.
export async function configureBoard(deps: Deps, actor: AppUser, id: string, input: BoardInput) {
  const row = await getBoard(deps, actor, id);
  const set: SetOf<typeof schema.boards> = { updatedAt: new Date() };
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
  // Log only the fields that ACTUALLY changed value (not every field the form submitted). Scalars carry a
  // from→to so the feed reads "hide empty lanes: no → yes"; the columns/swimlanes/labels blobs used to be
  // recorded name-only here, because a from→to of a whole JSON array is unreadable - lib/audit now expands
  // those three into per-key entries (`columns.in_progress`, `columns.order`), so a rename or a reorder is
  // legible and this needs no special case of its own.
  await audit(deps, actor, "board.configure", "boards", row.uuid, diffMeta(row, updated, set, "boards"), updated);
  return updated;
}

// The `metrics` verb: flow analytics (CFD + lead/cycle time + throughput) over the board's cards + movement
// log. `days` is the CFD/throughput window (default 30). Computation is pure (domain/boardMetrics); here we
// only fetch the rows. Read-gated by the board's access (the route decides), so it exposes only aggregates.
// A DELETED CARD IS NOT WORK, and every other count on this board already agrees: `cardCountsFor` above reads
// `delete_time` to exclude it from `card_count`, and the nudge metrics filter it in SQL
// (services/scheduledMetrics.ts). This read did not, so a deleted card went on contributing its lead time,
// its cycle time and its delivery to throughput - and, worse, never LEFT the CFD: the diagram reconstructs
// each card's column from its last move at or before a day boundary, so a card deleted a year ago was still
// being counted into whatever column it was sitting in, on every day of every window, forever.
//
// The movement log is filtered with it. `card_movements` carries no `delete_time` of its own (the soft delete
// stamps the card, not its history), so the live card ids are what say which movements still describe work -
// filtered in memory against the set, because the ids are already in hand and an `IN` list of a whole board's
// cards is past D1's bound-parameter cap anyway (lib/dbBatch.ts).
export async function boardMetrics(deps: Deps, actor: AppUser, id: string, days = 30) {
  const board = await getBoard(deps, actor, id);
  const cols = parseColumns(board.columnsJson).map((c) => ({ key: c.key, label: c.label }));
  const cardRows = (await deps.db
    .select({ uuid: schema.cards.uuid, committedAt: schema.cards.committedAt, startedAt: schema.cards.startedAt, deliveredAt: schema.cards.deliveredAt })
    .from(schema.cards)
    .where(and(eq(schema.cards.boardId, id), isNull(schema.cards.deleteTime))));
  const live = new Set(cardRows.map((c) => c.uuid));
  const moveRows = await deps.db
    .select({ cardId: schema.cardMovements.cardId, toColumn: schema.cardMovements.toColumn, at: schema.cardMovements.at })
    .from(schema.cardMovements)
    .where(eq(schema.cardMovements.boardId, id));
  return computeBoardMetrics(
    cols,
    cardRows.map((c) => ({ committedAt: c.committedAt ? +new Date(c.committedAt) : null, startedAt: c.startedAt ? +new Date(c.startedAt) : null, deliveredAt: c.deliveredAt ? +new Date(c.deliveredAt) : null })),
    moveRows.filter((m) => live.has(m.cardId)).map((m) => ({ cardId: m.cardId, toColumn: m.toColumn, at: +new Date(m.at) })),
    { days: Math.max(1, Math.min(180, days)) },
  );
}

// The board's one-hop children. Named and exported so test/purgeCascadeDrift can hold it against the foreign
// keys the schema declares - a hand-written purge is exactly where an unlisted reference hides.
export const BOARD_PURGE_CASCADE: PurgeCascade = {
  remove: [
    { table: schema.cardMovements, column: schema.cardMovements.boardId },
    { table: schema.cards, column: schema.cards.boardId },
    { table: schema.sprints, column: schema.sprints.boardId },
  ],
};

export async function purgeBoard(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  // Tear down bottom-up (FKs). The one-hop children of the board - movements, cards, sprints - are DECLARED,
  // so `purgeRow` runs them in order and turns anything still referencing the board into a 409. What it cannot
  // reach is a GRANDCHILD: a comment, a to-do or a watcher hangs off a CARD, and the cascade is keyed by the
  // purged row's id, so those are swept here first, exactly as `purgeCard` sweeps them for one card.
  //
  // The grandchild sweep is DECLARED as `first` rather than awaited here, so it lands in the same transaction
  // as the purge. Run ahead of it, every comment, to-do and watcher on every card of the board was already
  // gone if the purge itself was then refused - and the refusal says "still referenced by other records",
  // which reads as though nothing happened.
  const cardIds = (await deps.db.select({ uuid: schema.cards.uuid }).from(schema.cards).where(eq(schema.cards.boardId, id))).map((c) => c.uuid);
  const now = new Date();
  const first = chunk(cardIds, ID_CHUNK).flatMap((group) => [
    deps.db.delete(schema.cardComments).where(inArray(schema.cardComments.cardId, group)),
    deps.db.delete(schema.cardTodos).where(inArray(schema.cardTodos.cardId, group)),
    deps.db.delete(schema.cardWatchers).where(inArray(schema.cardWatchers.cardId, group)),
    // Two pointers from records with a life of their own: a card on ANOTHER board blocked by one of these, and
    // a booked hour, which outlives the task it was booked against (see `purgeCard`). Cut, not removed - and
    // `updated_at` moves with the cut so a client holding the pre-detach read stops matching on If-Match.
    deps.db.update(schema.cards).set({ blockedById: null, updatedAt: now }).where(inArray(schema.cards.blockedById, group)),
    deps.db.update(schema.timeEntries).set({ cardId: null, updatedAt: now }).where(inArray(schema.timeEntries.cardId, group)),
  ]);
  await purgeRow(deps, actor, schema.boards, "board", "boards", id, ifMatch, undefined, { ...BOARD_PURGE_CASCADE, first });
}

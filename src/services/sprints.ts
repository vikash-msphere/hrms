import { eq, and, isNull, type SQL } from "drizzle-orm";
import { allocFlatCode, withFreshCode } from "./codeAlloc";
import * as schema from "../db/schema";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import type { ListScope } from "../domain/access";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import { audit, createdMeta, diffMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted, failedPrecondition } from "../lib/errors";
import { etagOf } from "../http/serialize";
import { softDeleteRow, restoreRow, purgeRow, type PurgeCascade } from "./softDelete";
import { emitEvent } from "./eventBus";
import { checkEtag, updateAtVersion } from "./versionGuard";

export type SprintInput = {
  board?: string;
  name?: string;
  goal?: string | null;
  start_date?: string | null;
  end_date?: string | null;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string | null) => (s ? Date.parse(s + "T00:00:00Z") : NaN);
const dateOrNull = (s?: string | null) => (s ? new Date(Date.parse(s + "T00:00:00Z")) : null);

// THE CALLER'S SCOPE IS BOUND HERE. This used to take the actor and ignore it (`_actor`) while its route
// claimed the list "scopes by the caller" - it read every sprint in the org and filtered the board in JS. The
// breadth was the lesser half: `scope` also carries the caller's per-object shares and DENIES (resolved by
// middleware/authz.ts for every collection-level list), and `applyScope` is the only thing that binds them, so
// a per-object deny on a sprint had no effect on the list at all.
//
// `sprints` is a flat catalog with a `code` and no owner column, so an own-scoped caller gets nothing -
// fail-closed, the same answer the generic list gives. The board filter moves into SQL with it (there is an
// index on `board_id`), so a board's sprints cost a seek rather than a read of the table.
export async function listSprints(deps: Deps, _actor: AppUser, scope: ListScope | undefined, maxPageSize: number, pageToken?: string, boardId?: string, showDeleted = false) {
  const conds: (SQL | undefined)[] = [applyScope(scope, schema.sprints.code, undefined)];
  if (boardId) conds.push(eq(schema.sprints.boardId, boardId));
  if (!showDeleted) conds.push(isNull(schema.sprints.deleteTime));
  return keysetPage<typeof schema.sprints.$inferSelect>(deps, schema.sprints, "sprints", and(...conds.filter(Boolean) as SQL[]), {
    max: maxPageSize,
    pageToken,
  });
}

async function getSprint(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.sprints).where(eq(schema.sprints.uuid, id)).limit(1))[0];
  if (!row) throw notFound("sprint not found");
  return row;
}

export async function createSprint(deps: Deps, actor: AppUser, input: SprintInput, id?: string) {
  if (!input.name?.trim()) throw invalidArgument("name is required");
  const boardId = idFromPath(input.board);
  if (!boardId) throw invalidArgument("board is required");
  const board = (await deps.db.select().from(schema.boards).where(eq(schema.boards.uuid, boardId)).limit(1))[0];
  if (!board || board.deleteTime) throw notFound("board not found");
  for (const k of ["start_date", "end_date"] as const) if (input[k] && Number.isNaN(dayMs(input[k]))) throw invalidArgument(`${k} is invalid`);
  const name = input.name.trim();
  // Allocated inside the retry (codeAlloc.ts): planning day is several boards starting a sprint at once.
  const row = (await withFreshCode(async () => deps.db
    .insert(schema.sprints)
    .values({
      code: await allocFlatCode(deps, schema.sprints),
      ...(id ? { uuid: id } : {}),
      boardId,
      name,
      goal: input.goal?.trim() || null,
      startDate: dateOrNull(input.start_date),
      endDate: dateOrNull(input.end_date),
    })
    .returning()))[0]!;
  await audit(deps, actor, "sprint.create", "sprints", row.uuid, createdMeta(row, "sprints"), row);
  return row;
}

export async function updateSprint(deps: Deps, actor: AppUser, id: string, patch: SprintInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.sprints).where(eq(schema.sprints.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("sprint not found");
  checkEtag(row, ifMatch);
  const set: SetOf<typeof schema.sprints> = { updatedAt: new Date() };
  const has = (k: keyof SprintInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("name")) {
    if (!patch.name?.trim()) throw invalidArgument("name is required");
    set.name = patch.name.trim();
  }
  if (has("goal")) set.goal = patch.goal?.trim() || null;
  if (has("start_date")) set.startDate = dateOrNull(patch.start_date);
  if (has("end_date")) set.endDate = dateOrNull(patch.end_date);
  const updated = await updateAtVersion(deps, schema.sprints, "sprint", row, set);
  await audit(deps, actor, "sprint.update", "sprints", id, diffMeta(row, updated, set, "sprints"), updated);
  return updated;
}

// planning -> active. At most one active sprint per board (reject if one is already running).
export async function activateSprint(deps: Deps, actor: AppUser, id: string) {
  const row = await getSprint(deps, actor, id);
  if (row.state !== "planning") throw failedPrecondition("only a planning sprint can be started");
  const active = (await deps.db.select({ uuid: schema.sprints.uuid }).from(schema.sprints).where(and(eq(schema.sprints.boardId, row.boardId), eq(schema.sprints.state, "active"), isNull(schema.sprints.deleteTime))));
  if (active.length) throw failedPrecondition("another sprint on this board is already active");
  // Guard the flip on planning so activation is EXACTLY-ONCE (0 rows = a concurrent call already started it).
  const updated = (await deps.db.update(schema.sprints).set({ state: "active", updatedAt: new Date() }).where(and(eq(schema.sprints.uuid, id), eq(schema.sprints.state, "planning"))).returning())[0];
  if (!updated) throw failedPrecondition("only a planning sprint can be started");
  await audit(deps, actor, "sprint.activate", "sprints", id, { from: "planning", to: "active" });
  await emitEvent(deps, actor, "sprint.started", { subject: `sprints/${id}`, payload: { board: `boards/${row.boardId}`, name: updated.name } });
  return updated;
}

// active -> completed. Sweep unfinished (undelivered) cards back to the product backlog (sprintId = null).
export async function completeSprint(deps: Deps, actor: AppUser, id: string) {
  const row = await getSprint(deps, actor, id);
  if (row.state !== "active") throw failedPrecondition("only an active sprint can be completed");
  // Claim the completion EXACTLY-ONCE (guarded on active) BEFORE sweeping cards, so a concurrent complete
  // doesn't run the backlog sweep twice (0 rows = already completed).
  const updated = (await deps.db.update(schema.sprints).set({ state: "completed", updatedAt: new Date() }).where(and(eq(schema.sprints.uuid, id), eq(schema.sprints.state, "active"))).returning())[0];
  if (!updated) throw failedPrecondition("only an active sprint can be completed");
  // Sweep unfinished (undelivered) cards back to the product backlog (sprintId = null).
  await deps.db
    .update(schema.cards)
    .set({ sprintId: null, updatedAt: new Date() })
    .where(and(eq(schema.cards.sprintId, id), isNull(schema.cards.deliveredAt), isNull(schema.cards.deleteTime)));
  await audit(deps, actor, "sprint.complete", "sprints", id, { from: "active", to: "completed" });
  await emitEvent(deps, actor, "sprint.completed", { subject: `sprints/${id}`, payload: { board: `boards/${row.boardId}`, name: updated.name } });
  return updated;
}

// A card outlives the sprint it was planned into, so the pointer is cut, not the card. DECLARED rather than
// done by hand first: run as its own statement ahead of the purge, the detach committed even when the purge
// was then refused, so a 409 had already emptied a sprint of its cards.
export const SPRINT_PURGE_CASCADE: PurgeCascade = {
  detach: [{ table: schema.cards, column: schema.cards.sprintId }],
};

export async function purgeSprint(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await purgeRow(deps, actor, schema.sprints, "sprint", "sprints", id, ifMatch, undefined, SPRINT_PURGE_CASCADE);
}

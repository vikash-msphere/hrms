import { and, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { allocUnderPrefix, withFreshCode } from "./codeAlloc";
import { BOARD_VISIBILITIES, VISIBILITY_SEG, visibilityOfCode, type BoardMember, type BoardVisibility } from "../domain/boardAccess";
import { assertMayFileUnder, departmentManagerUsers, normalizeMembers, parseMembers, recodeBoard, resolveMemberAccounts, syncBoardShares } from "./boardShares";
import { oneOf } from "../lib/errors";
import { freshBoardAccessLevel } from "../lib/objectAccess";
import { chunk, ID_CHUNK } from "../lib/dbBatch";
import * as schema from "../db/schema";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import type { ListScope } from "../domain/access";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import { audit, auditUpdate, createdMeta, diffMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted } from "../lib/errors";
import { etagOf } from "../http/serialize";
import { deleteStateFilter, softDeleteRow, restoreRow, purgeRow, type PurgeCascade } from "./softDelete";
import {
  DEFAULT_BOARD_COLUMNS, DEFAULT_SCRUM_COLUMNS, DEFAULT_TASK_TYPES, normalizeColumns, requireEntryColumn, normalizeSwimlanes, normalizeLabels,
  normalizeTaskTypes, TASK_TYPE_DISPLAYS, type TaskTypeDisplay, cleanPrefix, normalizePrefix, derivePrefix, parseColumns, type SwimlaneMode, SWIMLANE_MODES,
} from "../domain/boards";
import { computeBoardMetrics } from "../domain/boardMetrics";
import { checkEtag, updateAtVersion } from "./versionGuard";

export type BoardInput = {
  name?: string;
  description?: string | null;
  department?: string | null;
  visibility?: BoardVisibility;
  members?: unknown;
  task_prefix?: string;
  mode?: "kanban" | "scrum";
  columns?: unknown;
  swimlane_mode?: string;
  swimlanes?: unknown;
  labels?: unknown;
  task_types?: unknown;
  task_type_display?: TaskTypeDisplay;
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
export async function listBoards(deps: Deps, _actor: AppUser, scope: ListScope | undefined, maxPageSize: number, pageToken?: string, showDeleted = false, deletedOnly = false) {
  const conds: (SQL | undefined)[] = [applyScope(scope, schema.boards.code, undefined)];
  conds.push(deleteStateFilter(schema.boards.deleteTime, showDeleted, deletedOnly));
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

// Every member names a real account or role: a share on a subject that does not exist grants nothing and would
// sit in the list looking like access somebody has.
async function assertMembersExist(deps: Deps, members: BoardMember[]) {
  const users = members.filter((m) => m.kind === "user").map((m) => m.subject);
  const roles = members.filter((m) => m.kind === "role").map((m) => m.subject);
  if (users.length) {
    const found = new Set((await deps.db.select({ uuid: schema.users.uuid }).from(schema.users).where(inArray(schema.users.uuid, users))).map((r) => r.uuid));
    if (users.some((u) => !found.has(u))) throw invalidArgument("a member names a user that does not exist");
  }
  if (roles.length) {
    const found = new Set((await deps.db.select({ name: schema.roles.name }).from(schema.roles).where(inArray(schema.roles.name, roles))).map((r) => r.name));
    if (roles.some((r) => !found.has(r))) throw invalidArgument("a member names a role that does not exist");
  }
}

export async function createBoard(deps: Deps, actor: AppUser, input: BoardInput, id?: string) {
  if (!input.name?.trim()) throw invalidArgument("name is required");
  const name = input.name.trim();
  const mode = (input.swimlane_mode ?? "none") as SwimlaneMode;
  if (!SWIMLANE_MODES.includes(mode)) throw invalidArgument("swimlane_mode is invalid");
  const columns = input.columns != null ? asArgError(() => requireEntryColumn(normalizeColumns(input.columns))) : input.mode === "scrum" ? DEFAULT_SCRUM_COLUMNS : DEFAULT_BOARD_COLUMNS;
  const swimlanes = asArgError(() => normalizeSwimlanes(input.swimlanes ?? []));
  const departmentId = idFromPath(input.department) ?? null;
  await assertMayFileUnder(deps, actor, departmentId, true);
  // Seen and worked by everyone unless the creator says otherwise - what every board was before visibility.
  const visibility = input.visibility ? oneOf(input.visibility, BOARD_VISIBILITIES, "visibility must be edit, view or private") : "edit";
  // The creator manages what they made: without this a creator who manages no department (HR) could not so
  // much as rename their own board. They are an ordinary entry, removable in Sharing like any other. Only a real
  // account is put on the list - a system actor (an automation) has none to share with.
  const creatorIsAccount = !!actor.uuid && !!(await deps.db.select({ uuid: schema.users.uuid }).from(schema.users).where(eq(schema.users.uuid, actor.uuid)).limit(1))[0];
  const members = normalizeMembers([
    ...(input.members == null ? [] : await resolveMemberAccounts(deps, normalizeMembers(input.members))),
    ...(creatorIsAccount ? [{ kind: "user" as const, subject: actor.uuid, level: "manage" as const }] : []),
  ]);
  await assertMembersExist(deps, members);
  // The code is allocated inside the retry, so a board created at the same moment as somebody else's takes
  // the next number instead of failing (services/codeAlloc.ts withFreshCode).
  const row = (await withFreshCode(async (attempt) => deps.db
    .insert(schema.boards)
    .values({
      code: await allocUnderPrefix(deps, schema.boards, VISIBILITY_SEG[visibility], undefined, attempt > 1),
      ...(id ? { uuid: id } : {}),
      departmentId,
      sharesJson: JSON.stringify(members),
      name,
      description: input.description?.trim() || null,
      taskPrefix: input.task_prefix != null ? asArgError(() => normalizePrefix(input.task_prefix)) : derivePrefix(name),
      mode: input.mode === "scrum" ? "scrum" : "kanban",
      columnsJson: JSON.stringify(columns),
      swimlaneMode: mode,
      swimlanesJson: JSON.stringify(swimlanes),
      labelsJson: JSON.stringify(input.labels != null ? asArgError(() => normalizeLabels(input.labels)) : []),
      taskTypesJson: JSON.stringify(input.task_types != null ? asArgError(() => normalizeTaskTypes(input.task_types)) : DEFAULT_TASK_TYPES),
      ...(input.task_type_display ? { taskTypeDisplay: oneOf(input.task_type_display, TASK_TYPE_DISPLAYS, "task_type_display must be icon, label or both") } : {}),
    })
    .returning()))[0]!;
  await syncBoardShares(deps, actor, row.uuid);
  await audit(deps, actor, "board.create", "boards", row.uuid, createdMeta(row, "boards"), row);
  // The creator's manage rules were written just now, after the request loaded their grant.
  return Object.assign(row, { _myAccess: await freshBoardAccessLevel(deps, actor, row.code) });
}

export async function updateBoard(deps: Deps, actor: AppUser, id: string, patch: BoardInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.boards).where(eq(schema.boards.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("board not found");
  checkEtag(row, ifMatch);
  const set: SetOf<typeof schema.boards> = { updatedAt: new Date() };
  const has = (k: keyof BoardInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("name")) {
    if (!patch.name?.trim()) throw invalidArgument("name is required");
    set.name = patch.name.trim();
  }
  if (has("description")) set.description = patch.description?.trim() || null;
  // A board saved before prefixes had to start with a letter keeps its prefix through a save that resends it.
  if (has("task_prefix") && cleanPrefix(patch.task_prefix) !== row.taskPrefix) set.taskPrefix = asArgError(() => normalizePrefix(patch.task_prefix));
  if (has("mode")) set.mode = patch.mode === "scrum" ? "scrum" : "kanban";
  // Moving the board to another department moves who manages it. Clearing it is allowed (whoever manages the
  // board through its sharing list keeps it); naming one is held to the rule a create is.
  const moved = has("department") && (idFromPath(patch.department) ?? null) !== row.departmentId;
  if (moved) {
    const next = idFromPath(patch.department) ?? null;
    await assertMayFileUnder(deps, actor, next, false);
    set.departmentId = next;
  }
  const updated = await updateAtVersion(deps, schema.boards, "board", row, set);
  if (moved) await syncBoardShares(deps, actor, id);
  await auditUpdate(deps, actor, "board.update", "boards", id, diffMeta(row, updated, set, "boards"), updated);
  // A department move may have added or taken away the caller's own manage rules.
  return moved ? Object.assign(updated, { _myAccess: await freshBoardAccessLevel(deps, actor, updated.code) }) : updated;
}

/**
 * The `share` verb: who may see and work the board. `visibility` moves the board to another code segment
 * (edit = everyone works it, view = everyone sees it, private = only its list); `members` replaces the sharing
 * list. Either may be sent alone. Held by whoever manages the board.
 */
export async function shareBoard(deps: Deps, actor: AppUser, id: string, input: { visibility?: BoardVisibility; members?: unknown }) {
  const row = (await deps.db.select().from(schema.boards).where(eq(schema.boards.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("board not found");
  const before = { visibility: visibilityOfCode(row.code), members: parseMembers(row.sharesJson).length };
  if (input.members !== undefined) {
    const members = await resolveMemberAccounts(deps, normalizeMembers(input.members));
    await assertMembersExist(deps, members);
    await deps.db.update(schema.boards).set({ sharesJson: JSON.stringify(members), updatedAt: new Date() }).where(eq(schema.boards.uuid, id));
  }
  if (input.visibility !== undefined) await recodeBoard(deps, row, oneOf(input.visibility, BOARD_VISIBILITIES, "visibility must be edit, view or private"));
  await syncBoardShares(deps, actor, id);
  const updated = (await deps.db.select().from(schema.boards).where(eq(schema.boards.uuid, id)).limit(1))[0]!;
  await audit(deps, actor, "board.share", "boards", id, {
    visibility: { from: before.visibility, to: visibilityOfCode(updated.code) },
    members: { from: before.members, to: parseMembers(updated.sharesJson).length },
  }, updated);
  // The caller may have just added or dropped themselves, or moved the board out of a segment they reach.
  return Object.assign(updated, { _myAccess: await freshBoardAccessLevel(deps, actor, updated.code) });
}

/**
 * The `sharing` verb: the board's sharing as its managers see it - visibility, the list with names, and who
 * manages it through its department (read-only here; it follows the department's managers).
 */
export async function boardSharing(deps: Deps, _actor: AppUser, id: string) {
  const row = await getBoard(deps, _actor, id);
  const members = parseMembers(row.sharesJson);
  const userIds = members.filter((m) => m.kind === "user").map((m) => m.subject);
  const managerUsers = await departmentManagerUsers(deps, row.departmentId);
  const people = [...new Set([...userIds, ...managerUsers])];
  const named = people.length
    ? await deps.db
      .select({ uuid: schema.users.uuid, email: schema.users.email, employeeId: schema.users.employeeId, first: schema.employees.firstName, last: schema.employees.lastName })
      .from(schema.users)
      .leftJoin(schema.employees, eq(schema.employees.uuid, schema.users.employeeId))
      .where(inArray(schema.users.uuid, people))
    : [];
  const byUser = new Map(named.map((u) => [u.uuid, u]));
  const nameOf = (uuid: string) => {
    const u = byUser.get(uuid);
    return u ? ([u.first, u.last].filter(Boolean).join(" ") || u.email) : uuid;
  };
  const roleNames = members.filter((m) => m.kind === "role").map((m) => m.subject);
  const roles = roleNames.length ? await deps.db.select({ name: schema.roles.name, label: schema.roles.label }).from(schema.roles).where(inArray(schema.roles.name, roleNames)) : [];
  const labelOf = new Map(roles.map((r) => [r.name, r.label]));
  return {
    visibility: visibilityOfCode(row.code),
    department: row.departmentId ? `departments/${row.departmentId}` : null,
    // Shaped as `share` takes them back (a user as a `users/<id>` ref), so the dialog can edit the list in place.
    members: members.map((m) => (m.kind === "user"
      ? { kind: "user", subject: `users/${m.subject}`, employee: byUser.get(m.subject)?.employeeId ? `employees/${byUser.get(m.subject)!.employeeId}` : null, name: nameOf(m.subject), level: m.level }
      : { kind: "role", subject: m.subject, name: labelOf.get(m.subject) ?? m.subject, level: m.level })),
    managers: managerUsers.map((u) => ({
      user: `users/${u}`,
      employee: byUser.get(u)?.employeeId ? `employees/${byUser.get(u)!.employeeId}` : null,
      name: nameOf(u),
    })),
  };
}

// The `configure` verb: replace the board's structural config (columns / WIP / policies / swimlanes / classes /
// goal roll-up) in one edit. Kept off the plain PATCH so the config is an explicit, grantable action.
export async function configureBoard(deps: Deps, actor: AppUser, id: string, input: BoardInput) {
  const row = await getBoard(deps, actor, id);
  const set: SetOf<typeof schema.boards> = { updatedAt: new Date() };
  const has = (k: keyof BoardInput) => Object.prototype.hasOwnProperty.call(input, k);
  if (has("columns")) set.columnsJson = JSON.stringify(asArgError(() => requireEntryColumn(normalizeColumns(input.columns))));
  if (has("swimlane_mode")) {
    const mode = input.swimlane_mode as SwimlaneMode;
    if (!SWIMLANE_MODES.includes(mode)) throw invalidArgument("swimlane_mode is invalid");
    set.swimlaneMode = mode;
  }
  if (has("swimlanes")) set.swimlanesJson = JSON.stringify(asArgError(() => normalizeSwimlanes(input.swimlanes)));
  if (has("labels")) set.labelsJson = JSON.stringify(asArgError(() => normalizeLabels(input.labels)));
  if (has("task_types")) set.taskTypesJson = JSON.stringify(asArgError(() => normalizeTaskTypes(input.task_types)));
  if (has("task_type_display")) set.taskTypeDisplay = oneOf(input.task_type_display, TASK_TYPE_DISPLAYS, "task_type_display must be icon, label or both");
  if (has("hide_empty_lanes")) set.hideEmptyLanes = !!input.hide_empty_lanes;
  if (has("reassign_lane_on_move")) set.reassignLaneOnMove = !!input.reassign_lane_on_move;
  if (has("no_lane_label")) set.noLaneLabel = (input.no_lane_label ?? "").toString().trim() || null;
  const updated = (await deps.db.update(schema.boards).set(set).where(eq(schema.boards.uuid, row.uuid)).returning())[0]!;
  // Log only the fields that ACTUALLY changed value (not every field the form submitted). Scalars carry a
  // from→to so the feed reads "hide empty lanes: no → yes"; the columns/swimlanes/labels blobs used to be
  // recorded name-only here, because a from→to of a whole JSON array is unreadable - lib/audit now expands
  // those three into per-key entries (`columns.in_progress`, `columns.order`), so a rename or a reorder is
  // legible and this needs no special case of its own.
  await auditUpdate(deps, actor, "board.configure", "boards", row.uuid, diffMeta(row, updated, set, "boards"), updated);
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

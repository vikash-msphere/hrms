import { eq, and, isNull, asc, inArray } from "drizzle-orm";
import { allocOwnedCode, withFreshCode } from "./codeAlloc";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, createdMeta, fieldDiff } from "../lib/audit";
import { getDefaultDepartmentId } from "./settings";
import { invalidArgument, notFound, aborted, failedPrecondition, oneOf, isCodeCollision, isCardSeqCollision } from "../lib/errors";
import { etagOf } from "../http/serialize";
import { softDeleteRow, restoreRow, purgeRow } from "./softDelete";
import { emitEvent } from "./eventBus";
import { updateGoalProgress } from "./goals";
import { notify } from "./notifications";
import { notifyMentions } from "./mentions";
import { parseColumns, commitmentIndex, columnIndex, normalizeLabelKeys, CARD_PRIORITIES, type CardPriority } from "../domain/boards";

// Notify a card's assignee when they are newly assigned it (not a re-save to the same person, not self-assign).
async function notifyCardAssigned(deps: Deps, actor: AppUser, card: typeof schema.cards.$inferSelect, prevAssigneeId: string | null) {
  const to = card.assigneeId;
  if (!to || to === prevAssigneeId || to === actor.employeeId) return;
  const key = card.keyPrefix && card.seq ? `${card.keyPrefix}-${card.seq}: ` : "";
  await notify(deps, { recipient: to, type: "board.card_assigned", title: "Task assigned to you", body: `${key}${card.title}`, link: "boards", subject: `cards/${card.uuid}`, action: "respond", actorId: actor.employeeId });
}

export type CardInput = {
  board?: string;
  sprint?: string | null;
  employee?: string | null;
  department?: string | null; // the card's department; omit to default to the org default, null to clear
  column_key?: string;
  swimlane_key?: string | null;
  rank?: number;
  title?: string;
  description?: string | null;
  assignee?: string | null;
  priority?: CardPriority;
  labels?: unknown;
  documents?: string[]; // org-document refs to link (link-only; replaces the whole set on patch)
  size?: number | null;
  due_date?: string | null;
  goal?: string | null;
  initial_todos?: string[]; // checklist items to seed at creation (create dialog: custom items + any template)
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string | null) => (s ? Date.parse(s + "T00:00:00Z") : NaN);

// Cards in a board column (non-deleted), for WIP counting + rank append. Optionally excluding one card.
async function columnCards(deps: Deps, boardId: string, columnKey: string) {
  return deps.db
    .select({ uuid: schema.cards.uuid, rank: schema.cards.rank, assigneeId: schema.cards.assigneeId })
    .from(schema.cards)
    .where(and(eq(schema.cards.boardId, boardId), eq(schema.cards.columnKey, columnKey), isNull(schema.cards.deleteTime)));
}

export async function listCards(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, boardId?: string, showDeleted = false) {
  const conds = [applyScope(scope, schema.cards.code, schema.cards.employeeId)];
  if (boardId) conds.push(eq(schema.cards.boardId, boardId));
  if (!showDeleted) conds.push(isNull(schema.cards.deleteTime));
  const page = await keysetPage<typeof schema.cards.$inferSelect>(deps, schema.cards, "cards", and(...conds.filter(Boolean)), { max: maxPageSize, pageToken });
  // Attach compact checklist progress (done/total) per row so the board tile shows it without loading items.
  // One grouped read over just this page's cards keeps it cheap.
  const ids = page.items.map((r) => r.uuid);
  if (ids.length) {
    const todoRows = await deps.db.select({ cardId: schema.cardTodos.cardId, done: schema.cardTodos.done }).from(schema.cardTodos).where(inArray(schema.cardTodos.cardId, ids));
    const agg = new Map<string, { total: number; done: number }>();
    for (const r of todoRows) {
      const a = agg.get(r.cardId) ?? { total: 0, done: 0 };
      a.total++;
      if (r.done) a.done++;
      agg.set(r.cardId, a);
    }
    for (const row of page.items) {
      const a = agg.get(row.uuid);
      (row as typeof row & { todoTotal: number; todoDone: number }).todoTotal = a?.total ?? 0;
      (row as typeof row & { todoTotal: number; todoDone: number }).todoDone = a?.done ?? 0;
    }
  }
  return page;
}

export async function getCard(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.cards).where(eq(schema.cards.uuid, id)).limit(1))[0];
  if (!row) throw notFound("card not found");
  return row;
}

// A card plus its threaded comments + checklist (both oldest-first), for the Get route + after a mutation.
export async function getCardWithComments(deps: Deps, actor: AppUser, id: string) {
  const row = await getCard(deps, actor, id);
  const comments = await deps.db.select().from(schema.cardComments).where(eq(schema.cardComments.cardId, id)).orderBy(asc(schema.cardComments.createdAt));
  const todos = await deps.db.select().from(schema.cardTodos).where(eq(schema.cardTodos.cardId, id)).orderBy(asc(schema.cardTodos.createdAt));
  return { ...row, _comments: comments, _todos: todos };
}

export async function commentCard(deps: Deps, actor: AppUser, id: string, body?: string | null) {
  const card = await getCard(deps, actor, id); // gate + existence (the middleware already authorized the verb on this card)
  const text = (body ?? "").trim();
  if (!text) throw invalidArgument("a comment body is required");
  await deps.db.insert(schema.cardComments).values({ cardId: id, authorId: actor.employeeId ?? null, authorEmail: actor.email, body: text });
  await audit(deps, actor, "card.comment", "cards", id, { note: text.length > 140 ? `${text.slice(0, 140)}…` : text }, card);
  // Naming someone in a comment is how work gets handed over on a board, so it tells them. A mention is a
  // notification and nothing more: if they cannot see this board, they still cannot - see services/mentions.ts.
  await notifyMentions(deps, actor, { subject: `cards/${id}`, link: "boards", type: "board.mention", body: text, title: card.title });
  return getCardWithComments(deps, actor, id);
}

// Touch the card's update_time so checklist activity surfaces it as recently active, mirroring comments.
async function touchCard(deps: Deps, id: string) {
  await deps.db.update(schema.cards).set({ updatedAt: new Date() }).where(eq(schema.cards.uuid, id));
}

// Add one or more checklist items. The web sends a single item from the input box, or a whole predefined
// checklist's item texts when one is applied - snapshotted onto the card either way. Applying a template is
// gated upstream (the picker only lists ticket-checklists the caller can read), so no template lookup here.
export async function addCardTodos(deps: Deps, actor: AppUser, id: string, texts?: string[]) {
  await getCard(deps, actor, id); // gate + existence
  const items = (texts ?? []).map((s) => (s ?? "").trim()).filter(Boolean);
  if (!items.length) throw invalidArgument("a checklist item is required");
  await deps.db.insert(schema.cardTodos).values(items.map((text) => ({ cardId: id, text })));
  await touchCard(deps, id);
  await audit(deps, actor, "card.addTodos", "cards", id, { fields: items.slice(0, 12) });
  return getCardWithComments(deps, actor, id);
}

export async function toggleCardTodo(deps: Deps, actor: AppUser, id: string, todoId?: string | null, done?: boolean) {
  await getCard(deps, actor, id);
  const tid = todoId ? todoId.split("/").pop()! : "";
  if (!tid) throw invalidArgument("a checklist item id is required");
  const item = (await deps.db.select().from(schema.cardTodos).where(and(eq(schema.cardTodos.uuid, tid), eq(schema.cardTodos.cardId, id))).limit(1))[0];
  if (!item) throw notFound("checklist item not found");
  await deps.db.update(schema.cardTodos).set({ done: !!done, updatedAt: new Date() }).where(eq(schema.cardTodos.uuid, tid));
  await touchCard(deps, id);
  await audit(deps, actor, "card.toggleTodo", "cards", id, { note: item.text, diff: { done: { from: item.done, to: !!done } } });
  return getCardWithComments(deps, actor, id);
}

export async function removeCardTodo(deps: Deps, actor: AppUser, id: string, todoId?: string | null) {
  await getCard(deps, actor, id);
  const tid = todoId ? todoId.split("/").pop()! : "";
  if (!tid) throw invalidArgument("a checklist item id is required");
  const item = (await deps.db.select().from(schema.cardTodos).where(and(eq(schema.cardTodos.uuid, tid), eq(schema.cardTodos.cardId, id))).limit(1))[0];
  if (!item) throw notFound("checklist item not found");
  await deps.db.delete(schema.cardTodos).where(eq(schema.cardTodos.uuid, tid));
  await touchCard(deps, id);
  await audit(deps, actor, "card.removeTodo", "cards", id, { note: item.text });
  return getCardWithComments(deps, actor, id);
}

export async function createCard(deps: Deps, actor: AppUser, input: CardInput, id?: string) {
  if (!input.title?.trim()) throw invalidArgument("title is required");
  const title = input.title.trim();
  const boardId = idFromPath(input.board);
  if (!boardId) throw invalidArgument("board is required");
  const board = (await deps.db.select().from(schema.boards).where(eq(schema.boards.uuid, boardId)).limit(1))[0];
  if (!board || board.deleteTime) throw notFound("board not found");
  const cols = parseColumns(board.columnsJson);
  if (!cols.length) throw failedPrecondition("the board has no columns yet");
  const columnKey = input.column_key ?? cols[0]!.key;
  if (columnIndex(cols, columnKey) < 0) throw invalidArgument("column_key is not a column on this board");
  const employeeId = idFromPath(input.employee) ?? actor.employeeId;
  if (!employeeId) throw invalidArgument("employee is required");
  // Department: explicit value (incl. null) wins; when the key is omitted, fall back to the org default.
  const departmentId = "department" in input ? (idFromPath(input.department) ?? null) : await getDefaultDepartmentId(deps);
  if (input.priority && !CARD_PRIORITIES.includes(input.priority)) throw invalidArgument("priority is invalid");
  const due = dayMs(input.due_date);
  if (input.due_date && Number.isNaN(due)) throw invalidArgument("due_date is invalid");
  // Append to the end of the target column unless a rank was supplied.
  const existing = await columnCards(deps, boardId, columnKey);
  const rank = input.rank ?? (existing.reduce((m, r) => Math.max(m, r.rank), 0) + 1024);
  // Both of the card's allocated numbers are read-then-write max+1: its `code` and the per-board `seq` behind
  // the human key (MS-1, MS-2…). Two people filing a task on the same board at the same moment therefore
  // compose the same pair, and the unique indexes fail the loser rather than let two tasks answer to MS-4.
  // Allocating INSIDE the retry is what makes that recoverable: the second look sees the winner's row and
  // takes the next numbers. Prefix is copied from the board so the key survives a later prefix change.
  const row = (await withFreshCode(async () => {
    const seqRows = await deps.db.select({ seq: schema.cards.seq }).from(schema.cards).where(eq(schema.cards.boardId, boardId));
    const seq = seqRows.reduce((m, r) => Math.max(m, r.seq ?? 0), 0) + 1;
    const code = await allocOwnedCode(deps, schema.cards, schema.cards.employeeId, employeeId);
    return deps.db
    .insert(schema.cards)
    .values({
      code,
      ...(id ? { uuid: id } : {}),
      boardId,
      seq,
      keyPrefix: board.taskPrefix || null,
      sprintId: idFromPath(input.sprint) ?? null,
      employeeId,
      columnKey,
      departmentId,
      swimlaneKey: idFromPath(input.swimlane_key) ?? (input.swimlane_key?.trim() || null),
      rank,
      title,
      description: input.description?.trim() || null,
      assigneeId: idFromPath(input.assignee) ?? null,
      priority: input.priority ?? "medium",
      labelsJson: JSON.stringify(normalizeLabelKeys(input.labels ?? [])),
      documentsJson: JSON.stringify((input.documents ?? []).map((p) => idFromPath(p)).filter(Boolean)),
      size: input.size ?? null,
      dueDate: input.due_date ? new Date(due) : null,
      goalId: idFromPath(input.goal) ?? null,
    })
    .returning();
  }, (e) => isCodeCollision(e) || isCardSeqCollision(e)))[0]!;
  await deps.db.insert(schema.cardMovements).values({ cardId: row.uuid, boardId, fromColumn: null, toColumn: columnKey, actorId: actor.employeeId ?? null });
  // Optional checklist seeded at creation (custom items and/or a template the dialog expanded to texts).
  const initialTodos = (input.initial_todos ?? []).map((s) => (s ?? "").trim()).filter(Boolean);
  if (initialTodos.length) await deps.db.insert(schema.cardTodos).values(initialTodos.map((text) => ({ cardId: row.uuid, text })));
  await audit(deps, actor, "card.create", "cards", row.uuid, createdMeta(row, "cards"), row);
  await notifyCardAssigned(deps, actor, row, null);
  await emitEvent(deps, actor, "card.created", { subject: `cards/${row.uuid}`, employeeId, payload: { board: `boards/${boardId}`, column: columnKey, priority: row.priority } });
  await recomputeGoalProgress(deps, actor, row.goalId); // a new linked task lowers its goal's delivered share
  return row;
}

export async function updateCard(deps: Deps, actor: AppUser, id: string, patch: CardInput, ifMatch?: string) {
  const row = await getCard(deps, actor, id);
  if (row.deleteTime) throw notFound("card not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: SetOf<typeof schema.cards> = { updatedAt: new Date() };
  const has = (k: keyof CardInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("title")) {
    if (!patch.title?.trim()) throw invalidArgument("title is required");
    set.title = patch.title.trim();
  }
  if (has("description")) set.description = patch.description?.trim() || null;
  if (has("swimlane_key")) set.swimlaneKey = patch.swimlane_key || null;
  if (has("department")) set.departmentId = idFromPath(patch.department) ?? null;
  if (has("sprint")) set.sprintId = idFromPath(patch.sprint) ?? null; // move a card between the backlog and a sprint
  if (has("assignee")) set.assigneeId = idFromPath(patch.assignee) ?? null;
  if (has("priority")) {
    if (patch.priority && !CARD_PRIORITIES.includes(patch.priority)) throw invalidArgument("priority is invalid");
    set.priority = patch.priority;
  }
  if (has("labels")) set.labelsJson = JSON.stringify(normalizeLabelKeys(patch.labels ?? []));
  if (has("documents")) set.documentsJson = JSON.stringify((patch.documents ?? []).map((p) => idFromPath(p)).filter(Boolean));
  if (has("size")) set.size = patch.size ?? null;
  if (has("due_date")) {
    const due = dayMs(patch.due_date);
    if (patch.due_date && Number.isNaN(due)) throw invalidArgument("due_date is invalid");
    set.dueDate = patch.due_date ? new Date(due) : null;
  }
  if (has("goal")) set.goalId = idFromPath(patch.goal) ?? null;
  const oldGoalId = row.goalId;
  const updated = (await deps.db.update(schema.cards).set(set).where(eq(schema.cards.uuid, id)).returning())[0]!;
  const diff = fieldDiff(row, updated, Object.keys(set));
  await audit(deps, actor, "card.update", "cards", id, Object.keys(diff).length ? { diff } : undefined);
  if (has("assignee")) await notifyCardAssigned(deps, actor, updated, row.assigneeId);
  // Recompute the new goal (size/reassign may change its roll-up) and, if the link moved, the old goal too.
  await recomputeGoalProgress(deps, actor, updated.goalId);
  if (oldGoalId && oldGoalId !== updated.goalId) await recomputeGoalProgress(deps, actor, oldGoalId);
  return updated;
}

// The pull action. Moves a card to `toColumn` (optionally a swimlane + explicit rank), enforcing the destination
// column's WIP limit server-side, stamping the commitment/started/delivery timestamps the first time the card
// crosses those points, appending a movement, and (if the board opts in) rolling a delivered card up to its goal.
export async function moveCard(
  deps: Deps,
  actor: AppUser,
  id: string,
  toColumn: string,
  toSwimlane?: string | null,
  rank?: number,
  toAssignee?: string | null,
  toGoal?: string | null,
  toPriority?: string | null,
  toDepartment?: string | null,
  toSprint?: string | null,
) {
  const row = await getCard(deps, actor, id);
  if (row.deleteTime) throw notFound("card not found");
  const board = (await deps.db.select().from(schema.boards).where(eq(schema.boards.uuid, row.boardId)).limit(1))[0];
  if (!board) throw notFound("board not found");
  const cols = parseColumns(board.columnsJson);
  const destIdx = columnIndex(cols, toColumn);
  if (destIdx < 0) throw invalidArgument("toColumn is not a column on this board");
  const dest = cols[destIdx]!;
  const changingColumn = toColumn !== row.columnKey;

  // WIP: block pulling INTO a column that is already at its limit (moving within/out is always allowed).
  // Board-wide by default; per-assignee counts only the moving card's assignee's cards in that column.
  if (changingColumn && dest.wipLimit != null) {
    const inCol = await columnCards(deps, row.boardId, toColumn);
    const perAssignee = dest.limitScope === "assignee";
    const count = perAssignee ? inCol.filter((c) => (c.assigneeId ?? null) === (row.assigneeId ?? null)).length : inCol.length;
    if (count >= dest.wipLimit) {
      throw failedPrecondition(
        perAssignee
          ? `${row.assigneeId ? "the assignee" : "unassigned work"} already has ${dest.wipLimit} card(s) in "${dest.label}"`
          : `"${dest.label}" is at its WIP limit (${dest.wipLimit})`,
      );
    }
  }

  const now = new Date();
  const set: SetOf<typeof schema.cards> = { columnKey: toColumn, updatedAt: now };
  if (toSwimlane !== undefined) set.swimlaneKey = idFromPath(toSwimlane) ?? toSwimlane ?? null;
  // Derived swimlanes (assignee/goal) are real card fields — dragging a card into another such lane reassigns them.
  const changingAssignee = toAssignee !== undefined && (idFromPath(toAssignee) ?? null) !== (row.assigneeId ?? null);
  const changingGoal = toGoal !== undefined && (idFromPath(toGoal) ?? null) !== (row.goalId ?? null);
  if (toAssignee !== undefined) set.assigneeId = idFromPath(toAssignee) ?? null;
  if (toGoal !== undefined) set.goalId = idFromPath(toGoal) ?? null;
  // priority is a required enum - a NONE lane drop leaves it unchanged
  if (toPriority) set.priority = oneOf(toPriority, CARD_PRIORITIES, "priority is invalid");
  if (toDepartment !== undefined) set.departmentId = idFromPath(toDepartment) ?? null;
  // Backlog <-> sprint in the same atomic move (null = backlog), same semantics as PATCH `sprint`.
  if (toSprint !== undefined) set.sprintId = idFromPath(toSprint) ?? null;
  if (rank != null) set.rank = rank;
  else if (changingColumn) set.rank = (await columnCards(deps, row.boardId, toColumn)).reduce((m, r) => Math.max(m, r.rank), 0) + 1024;

  // Flow timestamps (stamped once, the first crossing). committed = at/after the commitment column; started =
  // past the commitment column (real work); delivered = the delivery column.
  const commitIdx = commitmentIndex(cols);
  let justCommitted = false;
  let justDelivered = false;
  if (!row.committedAt && commitIdx >= 0 && destIdx >= commitIdx) {
    set.committedAt = now;
    justCommitted = true;
  }
  if (!row.startedAt && commitIdx >= 0 && destIdx > commitIdx) set.startedAt = now;
  if (!row.deliveredAt && dest.delivery) {
    set.deliveredAt = now;
    justDelivered = true;
  }

  const updated = (await deps.db.update(schema.cards).set(set).where(eq(schema.cards.uuid, id)).returning())[0]!;
  if (changingColumn) {
    await deps.db.insert(schema.cardMovements).values({ cardId: id, boardId: row.boardId, fromColumn: row.columnKey, toColumn, actorId: actor.employeeId ?? null });
  }
  await audit(deps, actor, "card.move", "cards", id, changingColumn ? { from: row.columnKey, to: toColumn } : { reordered: true });
  if (changingAssignee) {
    await audit(deps, actor, "card.assign", "cards", id, { from: row.assigneeId ? `employees/${row.assigneeId}` : null, to: updated.assigneeId ? `employees/${updated.assigneeId}` : null });
    await notifyCardAssigned(deps, actor, updated, row.assigneeId);
  }

  if (changingColumn) await emitEvent(deps, actor, "card.moved", { subject: `cards/${id}`, employeeId: updated.employeeId, payload: { board: `boards/${row.boardId}`, from: row.columnKey, to: toColumn } });
  if (justCommitted) await emitEvent(deps, actor, "card.committed", { subject: `cards/${id}`, employeeId: updated.employeeId, payload: { board: `boards/${row.boardId}`, column: toColumn } });
  if (justDelivered) await emitEvent(deps, actor, "card.delivered", { subject: `cards/${id}`, employeeId: updated.employeeId, payload: { board: `boards/${row.boardId}`, column: toColumn, goal: updated.goalId ? `goals/${updated.goalId}` : null } });
  await recomputeGoalProgress(deps, actor, updated.goalId); // delivery (or any move) shifts the linked goal's roll-up
  if (changingGoal && row.goalId) await recomputeGoalProgress(deps, actor, row.goalId); // the goal it left also re-rolls up
  return updated;
}

// Recompute a goal's progress from its linked tasks: share of delivered work, weighted by story points (`size`);
// when no linked task carries a size, fall back to a plain count. Reuses the `updateProgress` verb (audit +
// goal.progressUpdated/completed events). Best-effort. Only runs when the goal still has ≥1 linked task, so an
// unlinked/manual goal is never zeroed. This is the whole card→goal roll-up (no per-card % or per-board flag).
export async function recomputeGoalProgress(deps: Deps, actor: AppUser, goalId: string | null | undefined) {
  if (!goalId) return;
  try {
    const goal = (await deps.db.select({ del: schema.goals.deleteTime }).from(schema.goals).where(eq(schema.goals.uuid, goalId)).limit(1))[0];
    if (!goal || goal.del) return;
    const linked = await deps.db
      .select({ size: schema.cards.size, delivered: schema.cards.deliveredAt })
      .from(schema.cards)
      .where(and(eq(schema.cards.goalId, goalId), isNull(schema.cards.deleteTime)));
    if (!linked.length) return; // no linked tasks → leave the goal's (manual) progress untouched
    // Weight by story points where estimates exist; a card with no size still counts as 1 point (never 0) so
    // that delivering it always moves the goal - and the total matches the web "delivered/total tasks" count.
    const anySized = linked.some((c) => (c.size ?? 0) > 0);
    const weight = (c: { size: number | null }) => (anySized ? c.size ?? 1 : 1);
    const total = linked.reduce((s, c) => s + weight(c), 0);
    const done = linked.reduce((s, c) => s + (c.delivered ? weight(c) : 0), 0);
    const progress = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
    const status = progress >= 100 ? "completed" : progress > 0 ? "in_progress" : undefined;
    await updateGoalProgress(deps, actor, goalId, progress, status);
  } catch {
    // best-effort: the triggering card change already committed; a roll-up failure must not undo it.
  }
}

export async function setCardBlocked(deps: Deps, actor: AppUser, id: string, blocked: boolean, reason?: string | null, blockedBy?: string | null) {
  const row = await getCard(deps, actor, id);
  if (row.deleteTime) throw notFound("card not found");
  const blockerId = blocked ? idFromPath(blockedBy) ?? null : null;
  if (blockerId === id) throw invalidArgument("a task can't be blocked by itself");
  const updated = (await deps.db
    .update(schema.cards)
    .set({ blocked, blockReason: blocked ? reason?.trim() || null : null, blockedById: blockerId, updatedAt: new Date() })
    .where(eq(schema.cards.uuid, id))
    .returning())[0]!;
  await audit(deps, actor, blocked ? "card.block" : "card.unblock", "cards", id, blocked ? { reason: updated.blockReason, blockedBy: blockerId ? `cards/${blockerId}` : null } : undefined);
  if (blocked) await emitEvent(deps, actor, "card.blocked", { subject: `cards/${id}`, employeeId: updated.employeeId, payload: { board: `boards/${row.boardId}`, reason: updated.blockReason, blockedBy: blockerId ? `cards/${blockerId}` : null } });
  // Alert the assignee their task is now blocked (they own unblocking it).
  if (blocked && updated.assigneeId && updated.assigneeId !== actor.employeeId)
    await notify(deps, { recipient: updated.assigneeId, type: "board.card_blocked", title: "Your task was blocked", body: `${updated.keyPrefix && updated.seq ? `${updated.keyPrefix}-${updated.seq}: ` : ""}${updated.title}${updated.blockReason ? ` - ${updated.blockReason}` : ""}`, link: "boards", subject: `cards/${id}`, priority: "high", actorId: actor.employeeId });
  return updated;
}

export async function assignCard(deps: Deps, actor: AppUser, id: string, assignee?: string | null) {
  const row = await getCard(deps, actor, id);
  if (row.deleteTime) throw notFound("card not found");
  const updated = (await deps.db.update(schema.cards).set({ assigneeId: idFromPath(assignee) ?? null, updatedAt: new Date() }).where(eq(schema.cards.uuid, id)).returning())[0]!;
  await audit(deps, actor, "card.assign", "cards", id, { from: row.assigneeId ? `employees/${row.assigneeId}` : null, to: updated.assigneeId ? `employees/${updated.assigneeId}` : null });
  await notifyCardAssigned(deps, actor, updated, row.assigneeId);
  return updated;
}

export async function prioritizeCard(deps: Deps, actor: AppUser, id: string, priority: CardPriority) {
  if (!CARD_PRIORITIES.includes(priority)) throw invalidArgument("priority is invalid");
  const row = await getCard(deps, actor, id);
  if (row.deleteTime) throw notFound("card not found");
  const updated = (await deps.db.update(schema.cards).set({ priority, updatedAt: new Date() }).where(eq(schema.cards.uuid, id)).returning())[0]!;
  await audit(deps, actor, "card.prioritize", "cards", id, { from: row.priority, to: priority });
  return updated;
}

export async function deleteCard(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  const goalId = (await getCard(deps, actor, id)).goalId;
  await softDeleteRow(deps, actor, schema.cards, "card", "cards", id, ifMatch);
  await recomputeGoalProgress(deps, actor, goalId); // removing a linked task shifts the goal's roll-up
}
export async function restoreCard(deps: Deps, actor: AppUser, id: string) {
  const restored = await restoreRow(deps, actor, schema.cards, "card", "cards", id);
  await recomputeGoalProgress(deps, actor, (restored as { goalId?: string | null } | undefined)?.goalId);
  return restored;
}
export async function purgeCard(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  const goalId = (await getCard(deps, actor, id)).goalId;
  await deps.db.delete(schema.cardComments).where(eq(schema.cardComments.cardId, id));
  await deps.db.delete(schema.cardTodos).where(eq(schema.cardTodos.cardId, id));
  await deps.db.delete(schema.cardMovements).where(eq(schema.cardMovements.cardId, id));
  await deps.db.update(schema.cards).set({ blockedById: null }).where(eq(schema.cards.blockedById, id)); // clear dangling blockers
  await purgeRow(deps, actor, schema.cards, "card", "cards", id, ifMatch);
  await recomputeGoalProgress(deps, actor, goalId);
}

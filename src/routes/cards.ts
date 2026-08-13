import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import {
  listCards, getCardWithComments, createCard, updateCard, moveCard, setCardBlocked, assignCard, prioritizeCard,
  commentCard, addCardTodos, toggleCardTodo, removeCardTodo, deleteCard, restoreCard, purgeCard,
  type CardInput,
} from "../services/cards";
import { toCardResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";
import { CARD_PRIORITIES } from "../domain/boards";
const priorityEnum = z.enum(CARD_PRIORITIES);

const createSchema = z.object({
  board: z.string().min(1),
  sprint: z.string().nullable().optional(),
  employee: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
  column_key: z.string().optional(),
  swimlane_key: z.string().nullable().optional(),
  rank: z.number().optional(),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  assignee: z.string().nullable().optional(),
  priority: priorityEnum.optional(),
  labels: z.array(z.string()).optional(),
  documents: z.array(z.string()).optional(),
  size: z.number().nullable().optional(),
  due_date: z.string().nullable().optional(),
  goal: z.string().nullable().optional(),
  initial_todos: z.array(z.string()).optional(),
}).strict();
const updateSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  sprint: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
  swimlane_key: z.string().nullable().optional(),
  assignee: z.string().nullable().optional(),
  priority: priorityEnum.optional(),
  labels: z.array(z.string()).optional(),
  documents: z.array(z.string()).optional(),
  size: z.number().nullable().optional(),
  due_date: z.string().nullable().optional(),
  goal: z.string().nullable().optional(),
}).strict();
const moveSchema = z.object({ to_column: z.string().min(1), to_swimlane: z.string().nullable().optional(), rank: z.number().optional(), to_assignee: z.string().nullable().optional(), to_goal: z.string().nullable().optional(), to_priority: z.string().nullable().optional(), to_department: z.string().nullable().optional(), to_sprint: z.string().nullable().optional() }).strict();
const blockSchema = z.object({ reason: z.string().nullable().optional(), blocked_by: z.string().nullable().optional() }).strict();
const assignSchema = z.object({ assignee: z.string().nullable().optional() }).strict();
const prioritizeSchema = z.object({ priority: priorityEnum }).strict();
const commentSchema = z.object({ body: z.string() }).strict();
const todosSchema = z.object({ texts: z.array(z.string()) }).strict();
const toggleTodoSchema = z.object({ todo: z.string(), done: z.boolean() }).strict();
const removeTodoSchema = z.object({ todo: z.string() }).strict();

// Kanban cards. Every write past the row is the service's own: a create seeds the checklist, a delete or
// restore re-rolls the parent goal's progress, and a purge tears down comments, todos, movements and any
// "blocked by this card" links. What the lane supplies is one paging/If-Match/hint implementation and the verb
// dispatch - eleven of them, which is most of what a card is.
export const cards = collectionRoutes<CardInput>({
  table: schema.cards,
  collection: "cards",
  auditName: "card",
  notFound: "card not found",
  param: "card_id",
  createSchema,
  updateSchema,
  serialize: toCardResource,
  overrides: {
    // The item read carries the card's comment thread.
    get: (deps, actor, id) => getCardWithComments(deps, actor, id),
    create: (deps, actor, input, id) => createCard(deps, actor, input, id),
    update: (deps, actor, id, patch, ifMatch) => updateCard(deps, actor, id, patch, ifMatch),
    remove: (deps, actor, id, ifMatch) => deleteCard(deps, actor, id, ifMatch),
    restore: (deps, actor, id) => restoreCard(deps, actor, id),
    purge: (deps, actor, id, ifMatch) => purgeCard(deps, actor, id, ifMatch),
  },
  list: (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const board = c.req.query("board");
    return listCards(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), board ? board.split("/").pop() : undefined, c.req.query("show_deleted") === "true");
  },
  verbs: {
    move: {
      schema: moveSchema,
      run: (deps, user, id, b) => moveCard(deps, user, id, b.to_column, b.to_swimlane, b.rank, b.to_assignee, b.to_goal, b.to_priority, b.to_department, b.to_sprint),
    },
    block: { schema: blockSchema, run: (deps, user, id, b) => setCardBlocked(deps, user, id, true, b.reason, b.blocked_by) },
    unblock: { run: (deps, user, id) => setCardBlocked(deps, user, id, false) },
    assign: { schema: assignSchema, run: (deps, user, id, b) => assignCard(deps, user, id, b.assignee) },
    prioritize: { schema: prioritizeSchema, run: (deps, user, id, b) => prioritizeCard(deps, user, id, b.priority) },
    comment: { schema: commentSchema, run: (deps, user, id, b) => commentCard(deps, user, id, b.body) },
    addTodos: { schema: todosSchema, run: (deps, user, id, b) => addCardTodos(deps, user, id, b.texts) },
    toggleTodo: { schema: toggleTodoSchema, run: (deps, user, id, b) => toggleCardTodo(deps, user, id, b.todo, b.done) },
    removeTodo: { schema: removeTodoSchema, run: (deps, user, id, b) => removeCardTodo(deps, user, id, b.todo) },
  },
});

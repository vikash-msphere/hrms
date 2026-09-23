import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import {
  listCards, getCardWithComments, createCard, updateCard, moveCard, setCardBlocked, assignCard, prioritizeCard,
  commentCard, addCardTodos, toggleCardTodo, removeCardTodo, promoteCardTodo, watchCard, deleteCard, restoreCard, purgeCard,
  type CardInput,
} from "../services/cards";
import { suggestCardTriage, suggestGoalForCard, suggestStepsForCard } from "../services/cardTriage";
import { cardFlowFor } from "../services/cardFlow";
import { toCardResource } from "../http/serialize";
import { MAX_RICH_COMMENT } from "../domain/richText";
import { CARD_PRIORITIES } from "../domain/boards";
// A card's checklist and a ticket's are the same thing seeded from the same catalogue, so they share the cap.
import { MAX_CHECKLIST_ITEMS, MAX_CHECKLIST_ITEM_LEN } from "../domain/tickets";
const priorityEnum = z.enum(CARD_PRIORITIES);
// Repeating work. Same vocabulary as a recurring 1:1, plus the quarterly rhythm operational chores run on.
const cadenceEnum = z.enum(["weekly", "biweekly", "monthly", "quarterly"]);

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
  cadence: cadenceEnum.nullable().optional(),
  initial_todos: z.array(z.string().max(MAX_CHECKLIST_ITEM_LEN)).max(MAX_CHECKLIST_ITEMS).optional(),
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
  cadence: cadenceEnum.nullable().optional(),
}).strict();
const moveSchema = z.object({ to_column: z.string().min(1), to_swimlane: z.string().nullable().optional(), rank: z.number().optional(), to_assignee: z.string().nullable().optional(), to_goal: z.string().nullable().optional(), to_priority: z.string().nullable().optional(), to_department: z.string().nullable().optional(), to_sprint: z.string().nullable().optional() }).strict();
const blockSchema = z.object({ reason: z.string().nullable().optional(), blocked_by: z.string().nullable().optional() }).strict();
const assignSchema = z.object({ assignee: z.string().nullable().optional() }).strict();
const prioritizeSchema = z.object({ priority: priorityEnum }).strict();
const commentSchema = z.object({ body: z.string().max(MAX_RICH_COMMENT) }).strict();
const todosSchema = z.object({ texts: z.array(z.string().max(MAX_CHECKLIST_ITEM_LEN)).max(MAX_CHECKLIST_ITEMS) }).strict();
const toggleTodoSchema = z.object({ todo: z.string(), done: z.boolean() }).strict();
const removeTodoSchema = z.object({ todo: z.string() }).strict();
// Promote: `assignee` omitted inherits the parent card's, an explicit null leaves the new card unassigned.
const promoteTodoSchema = z.object({ todo: z.string(), assignee: z.string().nullable().optional() }).strict();

// Kanban cards. Every write past the row is the service's own: a create seeds the checklist, a delete or
// restore re-rolls the parent goal's progress, and a purge tears down comments, todos, movements and any
// "blocked by this card" links. What the lane supplies is one paging/If-Match/hint implementation and the verb
// dispatch - eleven of them, which is most of what a card is.
export const cards = collectionRoutes<CardInput, typeof schema.cards>({
  table: schema.cards,
  collection: "cards",
  auditName: "card",
  notFound: "card not found",
  param: "card_id",
  createSchema,
  updateSchema,
  // The viewer's own id rides along so the serializer can answer `watching` - the state of the watch button -
  // instead of shipping the watcher list for a client to match against itself.
  serialize: (row, user) => toCardResource(Object.assign(row, { _viewerEmployeeId: user?.employeeId ?? null })),
  overrides: {
    // The item read carries the card's comment thread.
    get: (deps, actor, id) => getCardWithComments(deps, actor, id),
    create: (deps, actor, input, id) => createCard(deps, actor, input, id),
    update: (deps, actor, id, patch, ifMatch) => updateCard(deps, actor, id, patch, ifMatch),
    remove: (deps, actor, id, ifMatch) => deleteCard(deps, actor, id, ifMatch),
    restore: (deps, actor, id) => restoreCard(deps, actor, id),
    purge: (deps, actor, id, ifMatch) => purgeCard(deps, actor, id, ifMatch),
  },
  list: (c, page) => {
    const board = c.req.query("board");
    const assignee = c.req.query("assignee");
    return listCards(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, board ? board.split("/").pop() : undefined, page.showDeleted, page.deletedOnly, assignee ? assignee.split("/").pop() : undefined);
  },
  verbs: {
    move: {
      schema: moveSchema,
      // A key the body omitted arrives as `undefined`, which the service reads as "this move does not touch
      // that field"; an explicit null means "clear it". That is how a lane drop reassigns without wiping the
      // sprint, and how a backlog drop clears the sprint without touching the assignee.
      run: (deps, user, id, b, c) => moveCard(deps, user, id, {
        column: b.to_column,
        swimlane: b.to_swimlane,
        rank: b.rank,
        assignee: b.to_assignee,
        goal: b.to_goal,
        priority: b.to_priority,
        department: b.to_department,
        sprint: b.to_sprint,
      }, c.req.header("If-Match")),
    },
    block: { schema: blockSchema, run: (deps, user, id, b) => setCardBlocked(deps, user, id, true, b.reason, b.blocked_by) },
    unblock: { run: (deps, user, id) => setCardBlocked(deps, user, id, false) },
    assign: { schema: assignSchema, run: (deps, user, id, b) => assignCard(deps, user, id, b.assignee) },
    prioritize: { schema: prioritizeSchema, run: (deps, user, id, b) => prioritizeCard(deps, user, id, b.priority) },
    comment: { schema: commentSchema, run: (deps, user, id, b) => commentCard(deps, user, id, b.body) },
    addTodos: { schema: todosSchema, run: (deps, user, id, b) => addCardTodos(deps, user, id, b.texts) },
    toggleTodo: { schema: toggleTodoSchema, run: (deps, user, id, b) => toggleCardTodo(deps, user, id, b.todo, b.done) },
    removeTodo: { schema: removeTodoSchema, run: (deps, user, id, b) => removeCardTodo(deps, user, id, b.todo) },
    // The checklist item that turned out to be real work: files it as a card on the same board and ticks the
    // item, so the board and the checklist never disagree about what is outstanding.
    promoteTodo: { schema: promoteTodoSchema, run: (deps, user, id, b) => promoteCardTodo(deps, user, id, b.todo, Object.prototype.hasOwnProperty.call(b, "assignee") ? b.assignee : undefined) },
    // Follow a task without being the one doing it. Both directions are idempotent, so a double press is a
    // double press rather than an error.
    watch: { run: (deps, user, id) => watchCard(deps, user, id, true) },
    unwatch: { run: (deps, user, id) => watchCard(deps, user, id, false) },
    // The steps comparable DELIVERED work actually took, in the board's own words. Evidence where the draft
    // button has to imagine, and free where the draft costs a generation.
    suggestSteps: {
      raw: async (c, id) => c.json({ steps: await suggestStepsForCard(c.get("deps"), c.get("scope"), id) }),
    },
    // The goal this card is probably serving, so `deliveryAdvancesGoal` has something to roll up into.
    //
    // Registered in SCOPE_READING_VERBS against GOALS, not cards: everything it answers with is a goal.
    suggestGoal: {
      raw: async (c, id) => c.json({ goals: await suggestGoalForCard(c.get("deps"), c.get("scope"), id) }),
    },
    // How long work like this takes on this board, from the board's own movement log.
    //
    // No model and no feature flag - this is arithmetic over rows the board already writes - but the same
    // scope rule as `triage`, and for the same reason: the percentiles are computed from OTHER cards, so the
    // corpus is the set this caller could have listed (SCOPE_READING_VERBS in middleware/authz.ts).
    flow: {
      raw: async (c, id) => c.json({ flow: await cardFlowFor(c.get("deps"), c.get("scope"), id) }),
    },
    // What comparable delivered work says about this card, and whether it is already on the board twice.
    //
    // `raw`, so it owns its response: there is no card row to serialize here, and passing the analysis
    // through the resource serializer would mean inventing a resource that does not exist.
    //
    // The caller's own list scope goes in and the service re-decides every neighbour against it - which is
    // why this verb is registered in SCOPE_READING_VERBS (middleware/authz.ts). A card the caller could not
    // list contributes nothing: not a link, not a vote.
    triage: {
      raw: async (c, id) => {
        const triage = await suggestCardTriage(c.get("deps"), c.get("scope"), id);
        return c.json({ triage });
      },
    },
  },
});

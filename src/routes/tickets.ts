import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import {
  listTickets, getTicketWithComments, createTicket,
  transitionTicket, assignTicket, routeTicket, setTicketPriority, commentTicket,
  addTodos, toggleTodo, removeTodo,
  type TicketInput,
} from "../services/tickets";
import { toTicketResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";

const createSchema = z
  .object({
    employee: z.string().optional(), // on-behalf requester ref; middleware gates cross-owner (default: caller)
    category: z.string(),
    department: z.string().nullable().optional(), // servicing dept override; defaults to the category's dept
    subject: z.string(),
    description: z.string().nullable().optional(),
    priority: z.enum(["low", "medium", "high"]).optional(),
    initial_todos: z.array(z.string()).optional(), // optional checklist to seed (custom items and/or a copied checklist)
  })
  .strict();

// Verbs that carry a JSON body. Other verbs are bodyless state transitions.
const assignSchema = z.object({ assignee: z.string().nullable().optional() }).strict();
const routeSchema = z.object({ department: z.string().nullable().optional() }).strict();
const prioritySchema = z.object({ priority: z.enum(["low", "medium", "high"]) }).strict();
const commentSchema = z.object({ body: z.string() }).strict();
const addTodosSchema = z.object({ texts: z.array(z.string()) }).strict();
const toggleTodoSchema = z.object({ todo: z.string(), done: z.boolean() }).strict();
const removeTodoSchema = z.object({ todo: z.string() }).strict();

// Helpdesk tickets. A ticket is never edited or deleted through the API - it moves through its state machine
// and accumulates comments - so there is no PATCH and, despite the table's delete_time (which exists for the
// requester cascade), `softDelete: false` keeps DELETE and `:restore` unmounted.
export const tickets = collectionRoutes<TicketInput>({
  table: schema.tickets,
  collection: "tickets",
  auditName: "ticket",
  notFound: "ticket not found",
  param: "ticket_id",
  createSchema,
  serialize: toTicketResource,
  softDelete: false,
  overrides: {
    // The item read carries the ticket's comment thread; the create seeds the checklist and routes to a dept.
    get: (deps, actor, id) => getTicketWithComments(deps, actor, id),
    create: (deps, actor, input) => createTicket(deps, actor, input),
  },
  list: (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    return listTickets(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("state"), c.req.query("assignee"), c.get("user"), c.req.query("department"), c.req.query("q"));
  },
  verbs: {
    // The five bodyless moves through the state machine; the service validates which are legal from where.
    start: { run: (deps, user, id) => transitionTicket(deps, user, id, "start") },
    resolve: { run: (deps, user, id) => transitionTicket(deps, user, id, "resolve") },
    close: { run: (deps, user, id) => transitionTicket(deps, user, id, "close") },
    reopen: { run: (deps, user, id) => transitionTicket(deps, user, id, "reopen") },
    cancel: { run: (deps, user, id) => transitionTicket(deps, user, id, "cancel") },
    assign: { schema: assignSchema, run: (deps, user, id, body) => assignTicket(deps, user, id, body.assignee) },
    route: { schema: routeSchema, run: (deps, user, id, body) => routeTicket(deps, user, id, body.department) },
    prioritize: { schema: prioritySchema, run: (deps, user, id, body) => setTicketPriority(deps, user, id, body.priority) },
    comment: { schema: commentSchema, run: (deps, user, id, body) => commentTicket(deps, user, id, body.body) },
    addTodos: { schema: addTodosSchema, run: (deps, user, id, body) => addTodos(deps, user, id, body.texts) },
    toggleTodo: { schema: toggleTodoSchema, run: (deps, user, id, body) => toggleTodo(deps, user, id, body.todo, body.done) },
    removeTodo: { schema: removeTodoSchema, run: (deps, user, id, body) => removeTodo(deps, user, id, body.todo) },
  },
});

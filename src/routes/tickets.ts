import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import {
  listTickets, getTicketWithComments, createTicket,
  transitionTicket, assignTicket, routeTicket, setTicketPriority, commentTicket,
  addTodos, toggleTodo, removeTodo,
} from "../services/tickets";
import { toTicketResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

const COL = "tickets";

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

export const tickets = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listTickets(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("state"), c.req.query("assignee"), c.get("user"), c.req.query("department"), c.req.query("q"));
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toTicketResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:ticket_id", async (c) => {
    const row = await getTicketWithComments(c.get("deps"), c.get("user"), c.req.param("ticket_id"));
    return c.json(withAccess(toTicketResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", createSchema), async (c) => {
    const row = await createTicket(c.get("deps"), c.get("user"), c.req.valid("json"));
    return c.json(withAccess(toTicketResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  // Custom methods. The wire path is the :verb form; dispatch on the parsed verb.
  .post("/:ticket_id", async (c) => {
    const { id, verb } = customMethod(c);
    const deps = c.get("deps");
    const user = c.get("user");
    const hint = (row: { code: string | null } | undefined) => withAccess(toTicketResource(row), user, COL, row?.code, c.get("objectGrant"));
    if (verb === "start" || verb === "resolve" || verb === "close" || verb === "reopen" || verb === "cancel") {
      return c.json(hint(await transitionTicket(deps, user, id, verb)));
    }
    if (verb === "assign") {
      const { assignee } = assignSchema.parse(await c.req.json().catch(() => ({})));
      return c.json(hint(await assignTicket(deps, user, id, assignee)));
    }
    if (verb === "route") {
      const { department } = routeSchema.parse(await c.req.json().catch(() => ({})));
      return c.json(hint(await routeTicket(deps, user, id, department)));
    }
    if (verb === "prioritize") {
      const { priority } = prioritySchema.parse(await c.req.json().catch(() => ({})));
      return c.json(hint(await setTicketPriority(deps, user, id, priority)));
    }
    if (verb === "comment") {
      const { body } = commentSchema.parse(await c.req.json().catch(() => ({})));
      return c.json(hint(await commentTicket(deps, user, id, body)));
    }
    if (verb === "addTodos") {
      const { texts } = addTodosSchema.parse(await c.req.json().catch(() => ({})));
      return c.json(hint(await addTodos(deps, user, id, texts)));
    }
    if (verb === "toggleTodo") {
      const { todo, done } = toggleTodoSchema.parse(await c.req.json().catch(() => ({})));
      return c.json(hint(await toggleTodo(deps, user, id, todo, done)));
    }
    if (verb === "removeTodo") {
      const { todo } = removeTodoSchema.parse(await c.req.json().catch(() => ({})));
      return c.json(hint(await removeTodo(deps, user, id, todo)));
    }
    return c.notFound();
  });

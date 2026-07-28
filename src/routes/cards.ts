import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import {
  listCards, getCard, getCardWithComments, createCard, updateCard, moveCard, setCardBlocked, assignCard, prioritizeCard,
  commentCard, addCardTodos, toggleCardTodo, removeCardTodo, deleteCard, restoreCard, purgeCard,
} from "../services/cards";
import { toCardResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";
import { CARD_PRIORITIES } from "../domain/boards";

const COL = "cards";
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
  size: z.number().nullable().optional(),
  due_date: z.string().nullable().optional(),
  goal: z.string().nullable().optional(),
}).strict();
const moveSchema = z.object({ to_column: z.string().min(1), to_swimlane: z.string().nullable().optional(), rank: z.number().optional(), to_assignee: z.string().nullable().optional(), to_goal: z.string().nullable().optional(), to_priority: z.string().nullable().optional(), to_department: z.string().nullable().optional() }).strict();
const blockSchema = z.object({ reason: z.string().nullable().optional(), blocked_by: z.string().nullable().optional() }).strict();
const assignSchema = z.object({ assignee: z.string().nullable().optional() }).strict();
const prioritizeSchema = z.object({ priority: priorityEnum }).strict();
const commentSchema = z.object({ body: z.string() }).strict();
const todosSchema = z.object({ texts: z.array(z.string()) }).strict();
const toggleTodoSchema = z.object({ todo: z.string(), done: z.boolean() }).strict();
const removeTodoSchema = z.object({ todo: z.string() }).strict();

export const cards = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const boardId = c.req.query("board") ? c.req.query("board")!.split("/").pop() : undefined;
    const { items, nextPageToken } = await listCards(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), boardId, c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toCardResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:card_id", async (c) => {
    const row = await getCardWithComments(c.get("deps"), c.get("user"), c.req.param("card_id")!);
    return c.json(withAccess(toCardResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", createSchema), async (c) => {
    const row = await createCard(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(withAccess(toCardResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .patch("/:card_id", zValidator("json", updateSchema), async (c) => {
    const row = await updateCard(c.get("deps"), c.get("user"), c.req.param("card_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(withAccess(toCardResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .delete("/:card_id", async (c) => {
    const id = c.req.param("card_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeCard(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteCard(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:card_id", async (c) => {
    const { id, verb } = customMethod(c);
    const deps = c.get("deps");
    const user = c.get("user");
    const hint = (row: any) => withAccess(toCardResource(row), user, COL, row?.code, c.get("objectGrant"));
    if (verb === "move") {
      const { to_column, to_swimlane, rank, to_assignee, to_goal, to_priority, to_department } = moveSchema.parse(await c.req.json().catch(() => ({})));
      return c.json(hint(await moveCard(deps, user, id, to_column, to_swimlane, rank, to_assignee, to_goal, to_priority, to_department)));
    }
    if (verb === "block") {
      const { reason, blocked_by } = blockSchema.parse(await c.req.json().catch(() => ({})));
      return c.json(hint(await setCardBlocked(deps, user, id, true, reason, blocked_by)));
    }
    if (verb === "unblock") return c.json(hint(await setCardBlocked(deps, user, id, false)));
    if (verb === "assign") {
      const { assignee } = assignSchema.parse(await c.req.json().catch(() => ({})));
      return c.json(hint(await assignCard(deps, user, id, assignee)));
    }
    if (verb === "prioritize") {
      const { priority } = prioritizeSchema.parse(await c.req.json().catch(() => ({})));
      return c.json(hint(await prioritizeCard(deps, user, id, priority)));
    }
    if (verb === "comment") {
      const { body } = commentSchema.parse(await c.req.json().catch(() => ({})));
      return c.json(hint(await commentCard(deps, user, id, body)));
    }
    if (verb === "addTodos") {
      const { texts } = todosSchema.parse(await c.req.json().catch(() => ({})));
      return c.json(hint(await addCardTodos(deps, user, id, texts)));
    }
    if (verb === "toggleTodo") {
      const { todo, done } = toggleTodoSchema.parse(await c.req.json().catch(() => ({})));
      return c.json(hint(await toggleCardTodo(deps, user, id, todo, done)));
    }
    if (verb === "removeTodo") {
      const { todo } = removeTodoSchema.parse(await c.req.json().catch(() => ({})));
      return c.json(hint(await removeCardTodo(deps, user, id, todo)));
    }
    if (verb === "restore") return c.json(hint(await restoreCard(deps, user, id)));
    return c.notFound();
  });

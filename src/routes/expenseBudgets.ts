import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { customMethod } from "../http/customMethod";
import { lifecycleVerb } from "../http/lifecycleRoute";
import * as schema from "../db/schema";
import {
  listExpenseBudgets, getExpenseBudget, createExpenseBudget,
  updateExpenseBudget, deleteExpenseBudget, restoreExpenseBudget, purgeExpenseBudget,
} from "../services/expenseBudgets";
import { toExpenseBudgetResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";

const COL = "expense-budgets";
const writeSchema = z.object({
  department: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  period_type: z.enum(["monthly", "quarterly", "yearly"]).optional(),
  period_key: z.string().min(1).optional(),
  amount: z.number().positive().optional(),
}).strict();

export const expenseBudgets = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listExpenseBudgets(c.get("deps"), c.get("user"), maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toExpenseBudgetResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:budget_id", async (c) => {
    const row = await getExpenseBudget(c.get("deps"), c.get("user"), c.req.param("budget_id")!);
    return c.json(toExpenseBudgetResource(row));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createExpenseBudget(c.get("deps"), c.get("user"), c.req.valid("json"));
    return c.json(toExpenseBudgetResource(row));
  })
  .patch("/:budget_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateExpenseBudget(c.get("deps"), c.get("user"), c.req.param("budget_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(toExpenseBudgetResource(row));
  })
  .delete("/:budget_id", async (c) => {
    const id = c.req.param("budget_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeExpenseBudget(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteExpenseBudget(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:budget_id", async (c) => {
    const lc = await lifecycleVerb(c, { table: schema.expenseBudgets, singular: "expense-budget", collection: COL, serialize: toExpenseBudgetResource });
    if (lc) return lc;
    const { id, verb } = customMethod(c);
    if (verb !== "restore") return c.notFound();
    const row = await restoreExpenseBudget(c.get("deps"), c.get("user"), id);
    return c.json(toExpenseBudgetResource(row));
  });

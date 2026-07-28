import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { customMethod } from "../http/customMethod";
import { lifecycleVerb } from "../http/lifecycleRoute";
import * as schema from "../db/schema";
import {
  listExpenseCategories, getExpenseCategory, createExpenseCategory,
  updateExpenseCategory, deleteExpenseCategory, restoreExpenseCategory, purgeExpenseCategory,
} from "../services/expenseCategories";
import { toExpenseCategoryResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";

const COL = "expense-categories";
const writeSchema = z.object({
  display_name: z.string().min(1).optional(),
  requires_receipt: z.boolean().optional(),
  gl_code: z.string().nullable().optional(),
}).strict();

export const expenseCategories = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listExpenseCategories(c.get("deps"), c.get("user"), maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toExpenseCategoryResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:category_id", async (c) => {
    const row = await getExpenseCategory(c.get("deps"), c.get("user"), c.req.param("category_id")!);
    return c.json(toExpenseCategoryResource(row));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createExpenseCategory(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(toExpenseCategoryResource(row));
  })
  .patch("/:category_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateExpenseCategory(c.get("deps"), c.get("user"), c.req.param("category_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(toExpenseCategoryResource(row));
  })
  .delete("/:category_id", async (c) => {
    const id = c.req.param("category_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeExpenseCategory(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteExpenseCategory(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:category_id", async (c) => {
    const lc = await lifecycleVerb(c, { table: schema.expenseCategories, singular: "expense-category", collection: COL, serialize: toExpenseCategoryResource });
    if (lc) return lc;
    const { id, verb } = customMethod(c);
    if (verb !== "restore") return c.notFound();
    const row = await restoreExpenseCategory(c.get("deps"), c.get("user"), id);
    return c.json(toExpenseCategoryResource(row));
  });

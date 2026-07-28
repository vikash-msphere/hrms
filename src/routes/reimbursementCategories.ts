import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { customMethod } from "../http/customMethod";
import { lifecycleVerb } from "../http/lifecycleRoute";
import * as schema from "../db/schema";
import {
  listReimbursementCategories, getReimbursementCategory, createReimbursementCategory,
  updateReimbursementCategory, deleteReimbursementCategory, restoreReimbursementCategory, purgeReimbursementCategory,
} from "../services/reimbursementCategories";
import { toReimbursementCategoryResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";

const COL = "reimbursement-categories";
const writeSchema = z.object({
  display_name: z.string().min(1).optional(),
  requires_receipt: z.boolean().optional(),
}).strict();

export const reimbursementCategories = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listReimbursementCategories(c.get("deps"), c.get("user"), maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toReimbursementCategoryResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:category_id", async (c) => {
    const row = await getReimbursementCategory(c.get("deps"), c.get("user"), c.req.param("category_id")!);
    return c.json(toReimbursementCategoryResource(row));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createReimbursementCategory(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(toReimbursementCategoryResource(row));
  })
  .patch("/:category_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateReimbursementCategory(c.get("deps"), c.get("user"), c.req.param("category_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(toReimbursementCategoryResource(row));
  })
  .delete("/:category_id", async (c) => {
    const id = c.req.param("category_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeReimbursementCategory(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteReimbursementCategory(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:category_id", async (c) => {
    const lc = await lifecycleVerb(c, { table: schema.reimbursementCategories, singular: "reimbursement-category", collection: COL, serialize: toReimbursementCategoryResource });
    if (lc) return lc;
    const { id, verb } = customMethod(c);
    if (verb !== "restore") return c.notFound();
    const row = await restoreReimbursementCategory(c.get("deps"), c.get("user"), id);
    return c.json(toReimbursementCategoryResource(row));
  });

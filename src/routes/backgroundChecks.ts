import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { customMethod } from "../http/customMethod";
import {
  listBackgroundChecks, getBackgroundCheck, createBackgroundCheck, updateBackgroundCheck,
  deleteBackgroundCheck, restoreBackgroundCheck, purgeBackgroundCheck,
} from "../services/backgroundChecks";
import { toBackgroundCheckResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";

// Background-verification tracking. NO access checks - the middleware gates the path by grants (private by
// default; sensitive). Standard CRUD + soft-delete/restore.
const writeSchema = z
  .object({
    employee: z.string().optional(),
    check_type: z.enum(["identity", "address", "education", "employment", "criminal", "reference", "credit", "other"]).optional(),
    status: z.enum(["pending", "in_progress", "clear", "discrepancy", "failed"]).optional(),
    vendor: z.string().nullable().optional(),
    reference_no: z.string().nullable().optional(),
    initiated_date: z.string().nullable().optional(),
    completed_date: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .strict();

export const backgroundChecks = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listBackgroundChecks(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toBackgroundCheckResource(r), user, "background-checks", r.code)), next_page_token: nextPageToken });
  })
  .get("/:background_check_id", async (c) => {
    const row = await getBackgroundCheck(c.get("deps"), c.req.param("background_check_id")!);
    return c.json(withAccess(toBackgroundCheckResource(row), c.get("user"), "background-checks", row.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createBackgroundCheck(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(toBackgroundCheckResource(row));
  })
  .patch("/:background_check_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateBackgroundCheck(c.get("deps"), c.get("user"), c.req.param("background_check_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(toBackgroundCheckResource(row));
  })
  .delete("/:background_check_id", async (c) => {
    const id = c.req.param("background_check_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeBackgroundCheck(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteBackgroundCheck(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:background_check_id", async (c) => {
    const { id, verb } = customMethod(c);
    if (verb !== "restore") return c.notFound();
    const row = await restoreBackgroundCheck(c.get("deps"), c.get("user"), id);
    return c.json(toBackgroundCheckResource(row));
  });

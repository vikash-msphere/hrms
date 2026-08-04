import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import {
  listGoals, getGoal, createGoal, updateGoal, updateGoalProgress,
  deleteGoal, restoreGoal, purgeGoal,
} from "../services/goals";
import { toGoalResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

const COL = "goals";

const statusEnum = z.enum(["not_started", "in_progress", "completed", "cancelled"]);
const createSchema = z
  .object({
    employee: z.string().nullable().optional(),
    parent: z.string().nullable().optional(),
    title: z.string().min(1),
    description: z.string().nullable().optional(),
    weight: z.number().optional(),
    progress: z.number().optional(),
    status: statusEnum.optional(),
    due_date: z.string().nullable().optional(),
  })
  .strict();
const updateSchema = createSchema.partial().strict();

export const goals = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listGoals(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("status"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toGoalResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:goal_id", async (c) => {
    const row = await getGoal(c.get("deps"), c.get("user"), c.req.param("goal_id")!);
    return c.json(withAccess(toGoalResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", createSchema), async (c) => {
    const row = await createGoal(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(withAccess(toGoalResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .patch("/:goal_id", zValidator("json", updateSchema), async (c) => {
    const row = await updateGoal(c.get("deps"), c.get("user"), c.req.param("goal_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(withAccess(toGoalResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .delete("/:goal_id", async (c) => {
    const id = c.req.param("goal_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeGoal(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteGoal(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  // Custom methods. The wire path is the :verb form; dispatch on the parsed verb.
  .post("/:goal_id", async (c) => {
    const { id, verb } = customMethod(c);
    const user = c.get("user");
    const hint = (row: { code: string | null } | undefined) => withAccess(toGoalResource(row), user, COL, row?.code, c.get("objectGrant"));
    if (verb === "updateProgress") {
      const { progress, status, note } = z.object({ progress: z.number(), status: statusEnum.optional(), note: z.string().max(500).optional() }).strict().parse(await c.req.json().catch(() => ({})));
      return c.json(hint(await updateGoalProgress(c.get("deps"), user, id, progress, status, note)));
    }
    if (verb === "restore") return c.json(hint((await restoreGoal(c.get("deps"), user, id)) as unknown as { code: string | null }));
    return c.notFound();
  });

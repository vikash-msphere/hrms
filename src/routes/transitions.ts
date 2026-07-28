import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv, AppUser } from "../env";
import {
  listTransitions, getTransition, createTransition, updateTransition,
  setTransitionState, appendTransitionTask, deleteTransition, restoreTransition, purgeTransition, tasksForTransitions,
} from "../services/transitions";
import { toTransitionResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";
import type { Grant } from "../domain/permissions";

const COL = "transitions";
type Task = typeof import("../db/schema").transitionTasks.$inferSelect;

const writeSchema = z.object({
  employee: z.string().nullable().optional(),
  kind: z.enum(["onboarding", "offboarding"]).optional(),
  template: z.string().nullable().optional(),
  anchor_date: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
}).strict();

function serialize(user: AppUser, row: any, tasks: Task[], grant?: Grant) {
  row._tasks = tasks;
  return withAccess(toTransitionResource(row), user, COL, row?.code, grant);
}

export const transitions = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listTransitions(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("kind"), c.req.query("state"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    const taskMap = await tasksForTransitions(c.get("deps"), items.map((r) => r.uuid));
    return c.json({ results: items.map((r) => serialize(user, r, taskMap.get(r.uuid) ?? [])), next_page_token: nextPageToken });
  })
  .get("/:transition_id", async (c) => {
    const row = await getTransition(c.get("deps"), c.get("user"), c.req.param("transition_id")!);
    const taskMap = await tasksForTransitions(c.get("deps"), [row.uuid]);
    return c.json(serialize(c.get("user"), row, taskMap.get(row.uuid) ?? [], c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const user = c.get("user");
    const row = await createTransition(c.get("deps"), user, c.req.valid("json"), c.req.query("id"));
    const taskMap = await tasksForTransitions(c.get("deps"), [row.uuid]);
    return c.json(serialize(user, row, taskMap.get(row.uuid) ?? [], c.get("objectGrant")));
  })
  .patch("/:transition_id", zValidator("json", writeSchema), async (c) => {
    const user = c.get("user");
    const row = await updateTransition(c.get("deps"), user, c.req.param("transition_id")!, c.req.valid("json"), c.req.header("If-Match"));
    const taskMap = await tasksForTransitions(c.get("deps"), [row.uuid]);
    return c.json(serialize(user, row, taskMap.get(row.uuid) ?? [], c.get("objectGrant")));
  })
  .delete("/:transition_id", async (c) => {
    const id = c.req.param("transition_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeTransition(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteTransition(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:transition_id", async (c) => {
    const { id, verb } = customMethod(c);
    const deps = c.get("deps");
    const user = c.get("user");
    const out = async (row: any) => c.json(serialize(user, row, (await tasksForTransitions(deps, [row.uuid])).get(row.uuid) ?? [], c.get("objectGrant")));
    if (verb === "complete") return out(await setTransitionState(deps, user, id, "COMPLETED"));
    if (verb === "cancel") return out(await setTransitionState(deps, user, id, "CANCELLED"));
    if (verb === "reopen") return out(await setTransitionState(deps, user, id, "ACTIVE"));
    if (verb === "appendTask") {
      const body = z.object({ title: z.string().min(1), description: z.string().nullable().optional(), assignee: z.string().nullable().optional(), due_date: z.string().nullable().optional() }).strict().parse(await c.req.json().catch(() => ({})));
      return out(await appendTransitionTask(deps, user, id, body));
    }
    if (verb === "restore") return out(await restoreTransition(deps, user, id));
    return c.notFound();
  });

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { listTransitionTasks, getTransitionTask, completeTransitionTask, reopenTransitionTask, uploadTransitionTaskDocument } from "../services/transitionTasks";
import { toTransitionTaskResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

const COL = "transition-tasks";

export const transitionTasks = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listTransitionTasks(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("status"), c.req.query("transition"));
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toTransitionTaskResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:task_id", async (c) => {
    const row = await getTransitionTask(c.get("deps"), c.get("user"), c.req.param("task_id")!);
    return c.json(withAccess(toTransitionTaskResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/:task_id", async (c) => {
    const { id, verb } = customMethod(c);
    const user = c.get("user");
    const hint = (row: { code: string | null } | undefined) => withAccess(toTransitionTaskResource(row), user, COL, row?.code, c.get("objectGrant"));
    if (verb === "complete") {
      const { note } = z.object({ note: z.string().nullable().optional() }).strict().parse(await c.req.json().catch(() => ({})));
      return c.json(hint(await completeTransitionTask(c.get("deps"), user, id, note)));
    }
    if (verb === "reopen") return c.json(hint(await reopenTransitionTask(c.get("deps"), user, id)));
    if (verb === "upload") {
      const bytes = await c.req.arrayBuffer();
      return c.json(hint(await uploadTransitionTaskDocument(c.get("deps"), user, id, bytes, { fileName: c.req.query("file_name"), contentType: c.req.query("content_type") })));
    }
    return c.notFound();
  });

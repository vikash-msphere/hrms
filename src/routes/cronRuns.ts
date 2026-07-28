import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { AppEnv } from "../env";
import { toCronRunResource } from "../http/serialize";
import { notFound } from "../lib/errors";
import { clampPageSize } from "../http/pagination";

// Recorded cron ticks (see schema.cronRuns / runScheduled). Admin-only: the collection is private by
// default - no role's grant names `cron-runs`, so only super_admin reaches it via the `**` wildcard. This
// route therefore makes no access decision; the authz middleware gates it. Newest tick first.
export const cronRuns = new Hono<AppEnv>()
  .get("/", async (c) => {
    const limit = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const rows = await c.get("deps").db
      .select()
      .from(schema.cronRuns)
      .orderBy(desc(schema.cronRuns.startedAt))
      .limit(limit);
    return c.json({ results: rows.map(toCronRunResource), next_page_token: undefined });
  })
  .get("/:cron_run", async (c) => {
    const row = (await c.get("deps").db.select().from(schema.cronRuns).where(eq(schema.cronRuns.uuid, c.req.param("cron_run"))).limit(1))[0];
    if (!row) throw notFound("cron run not found");
    return c.json(toCronRunResource(row));
  });

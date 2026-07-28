import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { AppEnv } from "../env";
import { toAutomationRunResource } from "../http/serialize";
import { notFound } from "../lib/errors";
import { clampPageSize } from "../http/pagination";
import { isSuperGrant } from "../domain/grants";

// Recorded automation firings (observability, like cron-runs). Read-only; admin-only (private by default).
// Newest first; optional `?automation=` filter (an automation's own run history).
export const automationRuns = new Hono<AppEnv>()
  .get("/", async (c) => {
    const limit = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const automation = c.req.query("automation");
    const q = c.get("deps").db.select().from(schema.automationRuns);
    const rows = automation
      ? await q.where(eq(schema.automationRuns.automationId, automation)).orderBy(desc(schema.automationRuns.startedAt)).limit(limit)
      : await q.orderBy(desc(schema.automationRuns.startedAt)).limit(limit);
    const redact = !isSuperGrant(c.get("user").grant);
    return c.json({ results: rows.map((r) => toAutomationRunResource(r, redact)), next_page_token: undefined });
  })
  .get("/:run", async (c) => {
    const row = (await c.get("deps").db.select().from(schema.automationRuns).where(eq(schema.automationRuns.uuid, c.req.param("run")!)).limit(1))[0];
    if (!row) throw notFound("automation run not found");
    return c.json(toAutomationRunResource(row, !isSuperGrant(c.get("user").grant)));
  });

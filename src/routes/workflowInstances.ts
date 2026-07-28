import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { AppEnv } from "../env";
import { toWorkflowInstanceResource } from "../http/serialize";
import { notFound } from "../lib/errors";
import { clampPageSize } from "../http/pagination";

// Suspended / finished durable workflows (see services/automationEngine.ts waitFor). Read-only; admin-only
// (private by default). Newest first; optional `?status=` filter (e.g. waiting).
export const workflowInstances = new Hono<AppEnv>()
  .get("/", async (c) => {
    const limit = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const status = c.req.query("status");
    const q = c.get("deps").db.select().from(schema.workflowInstances);
    const rows = status
      ? await q.where(eq(schema.workflowInstances.status, status as "waiting" | "done" | "expired" | "error")).orderBy(desc(schema.workflowInstances.createdAt)).limit(limit)
      : await q.orderBy(desc(schema.workflowInstances.createdAt)).limit(limit);
    return c.json({ results: rows.map(toWorkflowInstanceResource), next_page_token: undefined });
  })
  .get("/:instance", async (c) => {
    const row = (await c.get("deps").db.select().from(schema.workflowInstances).where(eq(schema.workflowInstances.uuid, c.req.param("instance")!)).limit(1))[0];
    if (!row) throw notFound("workflow instance not found");
    return c.json(toWorkflowInstanceResource(row));
  });

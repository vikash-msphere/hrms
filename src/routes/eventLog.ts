import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { AppEnv } from "../env";
import { toEventLogResource } from "../http/serialize";
import { notFound } from "../lib/errors";
import { clampPageSize } from "../http/pagination";
import { isSuperGrant } from "../domain/grants";

// The domain event log (see services/eventBus.ts). Read-only observability; admin-only (private by default -
// HR + super reach it via their grant). This route makes no access decision; the authz middleware gates it.
// Newest event first; optional `?type=` filter.
export const eventLog = new Hono<AppEnv>()
  .get("/", async (c) => {
    const limit = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const type = c.req.query("type");
    const q = c.get("deps").db.select().from(schema.eventLog);
    const rows = type
      ? await q.where(eq(schema.eventLog.type, type)).orderBy(desc(schema.eventLog.occurredAt)).limit(limit)
      : await q.orderBy(desc(schema.eventLog.occurredAt)).limit(limit);
    const redact = !isSuperGrant(c.get("user").grant);
    return c.json({ results: rows.map((r) => toEventLogResource(r, redact)), next_page_token: undefined });
  })
  .get("/:event", async (c) => {
    const row = (await c.get("deps").db.select().from(schema.eventLog).where(eq(schema.eventLog.uuid, c.req.param("event")!)).limit(1))[0];
    if (!row) throw notFound("event not found");
    return c.json(toEventLogResource(row, !isSuperGrant(c.get("user").grant)));
  });

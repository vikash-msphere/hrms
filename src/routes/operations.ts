import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { AppEnv } from "../env";
import { toOperationResource } from "../http/serialize";
import { notFound, invalidArgument } from "../lib/errors";
import { applyScope } from "../services/listScope";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";
import { runJob } from "../cron";

// AEP-151 operations endpoints. Paths are matched by the linter, so they are exactly
// /v1/operations and /v1/operations/{operation}. Operations are employee-owned (like leave-requests):
// access is the middleware's path-based grant. List rows are scoped by ctx.scope (own / all); item-GET of
// another's operation is denied by the middleware (operations.me), so this route makes no access decision.
export const operations = new Hono<AppEnv>()
  .get("/", async (c) => {
    const limit = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const rows = await c.get("deps").db
      .select()
      .from(schema.jobs)
      .where(applyScope(c.get("scope"), schema.jobs.code, schema.jobs.employeeId))
      .orderBy(desc(schema.jobs.createdAt))
      .limit(limit);
    return c.json({ results: rows.map(toOperationResource), next_page_token: undefined });
  })
  .get("/:operation", async (c) => {
    const job = (await c.get("deps").db.select().from(schema.jobs).where(eq(schema.jobs.uuid, c.req.param("operation"))).limit(1))[0];
    if (!job) throw notFound("operation not found");
    return c.json(toOperationResource(job));
  })
  // Custom method `operations/{id}:run` - run a single job on demand (queued / errored / orphaned). The
  // middleware resolves this to the custom key operations.<code>.run; no role's grant allows it, so only
  // super_admin reaches it via the `**` wildcard (the Operations UI is super-only too).
  .post("/:operation", async (c) => {
    const { id, verb } = customMethod(c);
    if (verb !== "run") throw invalidArgument(`unknown method ":${verb}"`);
    const job = await runJob(c.get("deps"), id);
    if (!job) throw notFound("operation not found");
    return c.json(toOperationResource(job));
  });

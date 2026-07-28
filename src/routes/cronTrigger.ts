import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { AppEnv } from "../env";
import { startCronRun, finishCronRun, KNOWN_CRONS } from "../cron";
import { invalidArgument, notFound } from "../lib/errors";
import { toCronRunResource } from "../http/serialize";

const bodySchema = z.object({ cron: z.string() }).strict();

// Collection-level custom method `cron-runs:run` - fire a scheduled task on demand (e.g. drain the job
// queue now instead of waiting for the next tick). Mounted at the full colon path in index.ts (Hono's
// collection mount does not bind a `:verb` without a preceding id). Super-only: the authz middleware
// resolves this to the custom key `cron-runs.run`, which no role's grant names, so only super_admin
// reaches it via the `**` wildcard. The same recording (a cron_runs row) happens as a real tick.
export const cronTrigger = new Hono<AppEnv>().post("/", async (c) => {
  const parsed = bodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw invalidArgument("body must be { cron }");
  const { cron } = parsed.data;
  if (!(KNOWN_CRONS as readonly string[]).includes(cron)) throw invalidArgument(`unknown cron "${cron}"`);

  const deps = c.get("deps");
  // Create the run row now (cheap) and return the "running" row immediately; do the actual work - which for
  // the nightly cron iterates every employee and can exceed the request CPU/subrequest budget - in the
  // background via waitUntil, stamping done/error on the same row. Poll cron-runs to see the outcome.
  const { runId, start } = await startCronRun(cron, deps);
  c.executionCtx.waitUntil(finishCronRun(cron, deps, runId, start, false));
  const row = (await deps.db.select().from(schema.cronRuns).where(eq(schema.cronRuns.uuid, runId)).limit(1))[0];
  if (!row) throw notFound("cron run not found");
  return c.json(toCronRunResource(row));
});

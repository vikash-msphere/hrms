import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { AppEnv } from "../env";
import { startCronRun, finishCronRun, KNOWN_CRONS } from "../cron";
import { invalidArgument, notFound } from "../lib/errors";
import { jsonBody } from "../http/jsonRequest";
import { toCronRunResource } from "../http/serialize";

const bodySchema = z.object({ cron: z.string() }).strict();

// Collection-level custom method `cron-runs:run` - fire a scheduled task on demand (e.g. drain the job
// queue now instead of waiting for the next tick). Mounted at the full colon path in index.ts (Hono's
// collection mount does not bind a `:verb` without a preceding id). Super-only: the authz middleware
// resolves this to the custom key `cron-runs.run`, which no role's grant names, so only super_admin
// reaches it via the `**` wildcard. A manual run is always recorded (a cron_runs row), even when it finds
// nothing to do: somebody asked for it and is waiting to see what happened.
export const cronTrigger = new Hono<AppEnv>().post("/", async (c) => {
  const parsed = bodySchema.safeParse(await jsonBody(c));
  if (!parsed.success) throw invalidArgument("body must be { cron }");
  const { cron } = parsed.data;
  if (!(KNOWN_CRONS as readonly string[]).includes(cron)) throw invalidArgument(`unknown cron "${cron}"`);

  const deps = c.get("deps");
  // Create the run row now (cheap) and return the "running" row immediately; do the actual work - which for
  // the nightly cron iterates every employee and can exceed the request CPU/subrequest budget - in the
  // background via waitUntil, stamping done/error on the same row. Poll cron-runs to see the outcome.
  const { runId, start } = await startCronRun(cron, deps);
  // `c.executionCtx` THROWS when the context has none (the test runner, and any in-process dispatch) rather
  // than returning undefined, so it cannot be read inline - the same guard middleware/auth.ts and
  // routes/batch.ts already carry, and this was the one place that read it bare. Without an execution context
  // there is nothing to hand the promise to, so the work is awaited instead: the caller waits, which is
  // slower than a real trigger and is the only honest alternative to dropping the run on the floor.
  const work = finishCronRun(cron, deps, runId, start, false);
  let scheduled = false;
  try {
    c.executionCtx.waitUntil(work);
    scheduled = true;
  } catch {
    /* no execution context */
  }
  if (!scheduled) await work;
  const row = (await deps.db.select().from(schema.cronRuns).where(eq(schema.cronRuns.uuid, runId)).limit(1))[0];
  if (!row) throw notFound("cron run not found");
  return c.json(toCronRunResource(row));
});

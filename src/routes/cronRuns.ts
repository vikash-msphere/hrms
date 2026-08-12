import { desc } from "drizzle-orm";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { toCronRunResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";

// Recorded cron ticks (see schema.cronRuns / runScheduled). Admin-only: the collection is private by
// default - no role's grant names `cron-runs`, so only super_admin reaches it via the `**` wildcard. This
// route therefore makes no access decision; the authz middleware gates it. Newest tick first.
export const cronRuns = collectionRoutes({
  table: schema.cronRuns,
  collection: "cron-runs",
  auditName: "cron_run",
  notFound: "cron run not found",
  param: "cron_run",
  serialize: toCronRunResource,
  list: async (c) => ({
    items: await c
      .get("deps")
      .db.select()
      .from(schema.cronRuns)
      .orderBy(desc(schema.cronRuns.startedAt))
      .limit(clampPageSize(Number(c.req.query("max_page_size")) || undefined)),
    nextPageToken: undefined,
  }),
});

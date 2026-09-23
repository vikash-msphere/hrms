import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { keysetPage } from "../services/keysetPage";
import { applyScope } from "../services/listScope";
import { toCronRunResource } from "../http/serialize";

// Recorded cron ticks (see schema.cronRuns / runScheduled). Admin-only: the collection is private by
// default - no role's grant names `cron-runs`, so only super_admin reaches it via the `**` wildcard. This
// route therefore makes no access decision; the authz middleware gates it. Newest tick first.
//
// PAGED, through the same keyset cursor every other list uses, and ordered on `started_at` (NOT NULL, indexed,
// and the order the page reads in). It used to answer the newest `max_page_size` rows with no
// `nextPageToken` at all - a hard wall at 100 with no way past it and no `hasMore` for the table to admit the
// truncation with. That is the same defect routes/eventLog.ts describes and fixes for its three siblings;
// cron-runs is the fourth table somebody opens only once something has already gone wrong, and it was the one
// left behind.
//
// The middleware's decided scope is bound here too - see the note in routes/eventLog.ts for what ignoring it
// cost. `cron_runs` carries no owner column, so a breadth it cannot satisfy answers no rows rather than the
// whole table (services/listScope.ts).
export const cronRuns = collectionRoutes({
  table: schema.cronRuns,
  collection: "cron-runs",
  auditName: "cron_run",
  notFound: "cron run not found",
  param: "cron_run",
  serialize: toCronRunResource,
  list: async (c, page) =>
    keysetPage<typeof schema.cronRuns.$inferSelect>(
      c.get("deps"),
      schema.cronRuns,
      "cron-runs",
      applyScope(c.get("scope"), schema.cronRuns.code, undefined),
      {
        max: page.maxPageSize,
        pageToken: page.pageToken,
        order: { expr: sql`${schema.cronRuns.startedAt}`, value: (r) => +new Date(r.startedAt) },
      },
    ),
});

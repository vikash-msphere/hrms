import { desc, eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { toAutomationRunResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";
import { isSuperGrant } from "../domain/grants";

// Recorded automation firings (observability, like cron-runs). Read-only; admin-only (private by default).
// Newest first; optional `?automation=` filter (an automation's own run history).
export const automationRuns = collectionRoutes({
  table: schema.automationRuns,
  collection: "automation-runs",
  auditName: "automation_run",
  notFound: "automation run not found",
  param: "run",
  // A run records the event payload it fired on, so it is redacted below super like the event log itself.
  serialize: (row, user) => toAutomationRunResource(row, !isSuperGrant(user!.grant)),
  list: async (c) => {
    const limit = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const automation = c.req.query("automation");
    const q = c.get("deps").db.select().from(schema.automationRuns);
    const items = automation
      ? await q.where(eq(schema.automationRuns.automationId, automation)).orderBy(desc(schema.automationRuns.startedAt)).limit(limit)
      : await q.orderBy(desc(schema.automationRuns.startedAt)).limit(limit);
    return { items, nextPageToken: undefined };
  },
});

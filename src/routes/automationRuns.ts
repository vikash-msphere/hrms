import { eq, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { keysetPage } from "../services/keysetPage";
import { toAutomationRunResource } from "../http/serialize";
import { isSuperGrant } from "../domain/grants";

// Recorded automation firings (observability, like cron-runs). Read-only; admin-only (private by default).
// Newest first; optional `?automation=` filter (an automation's own run history).
//
// Paged on `started_at` (NOT NULL, and the order the page reads in) through the shared keyset cursor - see the
// note in routes/eventLog.ts for why a hard stop at the first page was the wrong answer for the tables you
// only open when something has already gone wrong.
export const automationRuns = collectionRoutes({
  table: schema.automationRuns,
  collection: "automation-runs",
  auditName: "automation_run",
  notFound: "automation run not found",
  param: "run",
  // A run records the event payload it fired on, so it is redacted below super like the event log itself.
  serialize: (row, user) => toAutomationRunResource(row, !isSuperGrant(user!.grant)),
  list: async (c, page) => {
    const automation = c.req.query("automation");
    return keysetPage<typeof schema.automationRuns.$inferSelect>(
      c.get("deps"),
      schema.automationRuns,
      "automation-runs",
      automation ? eq(schema.automationRuns.automationId, automation) : undefined,
      {
        max: page.maxPageSize,
        pageToken: page.pageToken,
        order: { expr: sql`${schema.automationRuns.startedAt}`, value: (r) => +new Date(r.startedAt) },
      },
    );
  },
});

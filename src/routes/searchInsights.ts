import { and, gte } from "drizzle-orm";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { keysetPage } from "../services/keysetPage";
import { applyScope } from "../services/listScope";
import { toSearchInsightResource } from "../http/serialize";

// Daily ⌘K usage counters (see schema.searchInsights / services/searchInsights.ts). Read-only and private by
// default: no role's grant names `search-insights`, so only super_admin reaches it via `**`, and this route makes
// no access decision of its own - the authz middleware gates it, and the decided scope is bound below exactly as
// routes/cronRuns.ts binds it. Newest first.
//
// `?since=YYYY-MM-DD` narrows to the days an insights view is about, so it reads a week rather than the table.
export const searchInsights = collectionRoutes({
  table: schema.searchInsights,
  collection: "search-insights",
  auditName: "search_insight",
  notFound: "search insight not found",
  param: "search_insight",
  serialize: toSearchInsightResource,
  list: async (c, page) => {
    const since = c.req.query("since");
    const day = since && /^\d{4}-\d{2}-\d{2}$/.test(since) ? since : undefined;
    return keysetPage<typeof schema.searchInsights.$inferSelect>(
      c.get("deps"),
      schema.searchInsights,
      "search-insights",
      and(applyScope(c.get("scope"), schema.searchInsights.code, undefined), day ? gte(schema.searchInsights.day, day) : undefined),
      { max: page.maxPageSize, pageToken: page.pageToken },
    );
  },
});

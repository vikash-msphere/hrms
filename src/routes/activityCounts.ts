import { Hono } from "hono";
import type { AppEnv } from "../env";
import { activityCounts, parseTabs } from "../services/activityCounts";

// Virtual collection: `GET /v1/activity-counts?tabs=<collection>[@others]:<sinceEpochMs>,...` answers "how many
// rows have appeared in each of these collections since the given moment" - the workspace tab bar's "new" badges.
//
// `activity-counts` is not a resource: it holds no data and grants nothing. Like `/v1/search` and
// `/v1/dashboard-summary`, the ENVELOPE is open to any authenticated caller and access is decided per
// collection by the middleware, which leaves the verdicts on `searchScopes`. This route makes no access
// decision of its own, exactly like every list route.
export const activityCountsRoute = new Hono<AppEnv>().get("/", async (c) => {
  const counts = await activityCounts(
    c.get("deps"),
    c.get("user")!,
    c.get("searchScopes") ?? new Map(),
    parseTabs(c.req.query("tabs")),
  );
  return c.json({ counts });
});

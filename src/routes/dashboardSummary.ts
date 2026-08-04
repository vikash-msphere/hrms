import { Hono } from "hono";
import type { AppEnv } from "../env";
import { dashboardSummary } from "../services/dashboardSummary";

// Virtual collection: `GET /v1/dashboard-summary?keys=a,b,c` returns aggregated KPI counts for the dashboard.
// Like `/v1/search`, it is a TRANSPORT that owns no data and grants nothing: the middleware decides, per
// backing collection, whether the caller may list it (the same decision a real GET /v1/<collection> gets) and
// leaves the verdicts on `summaryScopes`; the service only binds them to COUNT/SUM queries. A KPI whose
// collection the caller may not list is simply absent from the response.
export const dashboardSummaryRoute = new Hono<AppEnv>().get("/", async (c) => {
  const kpis = await dashboardSummary(c.get("deps"), c.get("user")!, c.get("summaryScopes") ?? new Map(), c.req.query("keys"));
  return c.json({ kpis });
});

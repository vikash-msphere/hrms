import { Hono } from "hono";
import type { AppEnv } from "../env";
import { payrollForecast } from "../services/payrollForecast";

// Virtual collection: `GET /v1/payroll-forecast` answers what payroll is already COMMITTED to over the next
// twelve months - the number somebody asks for every time headcount is discussed, and the one the app has
// always answered by exporting to a spreadsheet.
//
// A TRANSPORT that owns no data and grants nothing, like /v1/expense-close beside it. The gating is the
// caller's own `compensation` list verdict, resolved by the middleware and bound in the service, so a manager
// sees their reports' committed cost and finance the organisation's - and a caller who may list nobody's gets
// an empty forecast rather than a refusal on a page.
//
// COMMITTED, not predicted: salary already agreed, including future-dated revisions and known leavers, and
// nothing about hiring or raises nobody has approved. A month here is a floor.
export const payrollForecastRoute = new Hono<AppEnv>().get("/", async (c) => {
  const f = await payrollForecast(c.get("deps"), c.get("scope"));
  // The one camelCase name in the answer, spelled for the wire here rather than in the domain.
  return c.json({
    horizon_months: f.horizon_months,
    total: f.total,
    months: f.months.map((m) => ({ month: m.month, cost: m.cost, people: m.people, by_department: m.byDepartment })),
  });
});

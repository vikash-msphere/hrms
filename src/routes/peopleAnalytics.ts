import { Hono } from "hono";
import type { AppEnv } from "../env";
import { peopleAnalytics } from "../services/peopleAnalytics";

// Virtual collection: `GET /v1/people-analytics?from=&to=&department=&max_people=` returns one row per person
// with their measures over the window - attendance and punctuality, leave, tasks, goals, performance, time.
//
// Like `/v1/search` and `/v1/dashboard-summary` it is a TRANSPORT that owns no data and grants nothing: the
// middleware decides, per backing collection, whether the caller may list it (the same decision a real
// GET /v1/<collection> gets) and leaves the verdicts on `analyticsScopes`; the service only binds them to
// grouped aggregates. A measure whose collection the caller may not list is absent from the answer, and the
// people in it are exactly the employees their own directory list would have returned.
export const peopleAnalyticsRoute = new Hono<AppEnv>().get("/", async (c) => {
  const today = new Date(c.get("deps").clock.now().getTime()).toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;
  const maxPeople = Number(c.req.query("max_people"));
  const result = await peopleAnalytics(c.get("deps"), c.get("analyticsScopes") ?? new Map(), {
    from: c.req.query("from") || monthStart,
    to: c.req.query("to") || today,
    // `?department=departments/<token>` / `?employee=employees/<token>`: the inbound edge
    // (middleware/decodeWireIds.ts) already turned the wire token into the internal id, so all that is left is
    // to take the id off the ref.
    departmentId: c.req.query("department")?.split("/").pop() || undefined,
    employeeId: c.req.query("employee")?.split("/").pop() || undefined,
    series: c.req.query("series") === "true",
    maxPeople: Number.isFinite(maxPeople) && maxPeople > 0 ? maxPeople : undefined,
  });
  return c.json(result);
});

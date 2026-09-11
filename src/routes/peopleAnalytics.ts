import { Hono } from "hono";
import type { AppEnv } from "../env";
import { peopleAnalytics } from "../services/peopleAnalytics";
import { orgToday } from "../services/orgDay";

// Virtual collection: `GET /v1/people-analytics?from=&to=&department=&max_people=` returns one row per person
// with their measures over the window - attendance and punctuality, leave, tasks, goals, performance, time.
//
// Like `/v1/search` and `/v1/dashboard-summary` it is a TRANSPORT that owns no data and grants nothing: the
// middleware decides, per backing collection, whether the caller may list it (the same decision a real
// GET /v1/<collection> gets) and leaves the verdicts on `analyticsScopes`; the service only binds them to
// grouped aggregates. A measure whose collection the caller may not list is absent from the answer, and the
// people in it are exactly the employees their own directory list would have returned.
export const peopleAnalyticsRoute = new Hono<AppEnv>().get("/", async (c) => {
  // The default window is the month SO FAR, so both ends are "today" questions and both come from the org's
  // timezone (services/orgDay), never from UTC. The SPA always sends `from`/`to`, so a UTC-derived default
  // only ever bit the callers with no page behind them - an API key, a script - and bit them silently: asked
  // on the 1st before the org day and UTC agree, it answered for the whole of the PREVIOUS month.
  const today = await orgToday(c.get("deps"));
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

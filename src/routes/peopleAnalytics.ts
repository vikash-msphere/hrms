import { Hono } from "hono";
import type { AppEnv } from "../env";
import { peopleAnalytics } from "../services/peopleAnalytics";
import { narrateAnalytics } from "../services/analyticsNarrate";
import { jsonBody } from "../http/jsonRequest";
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

// Collection-level custom method `people-analytics:narrate` - the same report's TEAM aggregates compared with
// the preceding window of equal length, written up.
//
// Its OWN mount at `/v1/people-analytics:narrate`, not a `/narrate` path on the route above. The difference
// is not cosmetic: `resolveRequest` reads a path segment after the collection as an ITEM ID, so `/narrate`
// would be gated as a read of a record called "narrate" rather than as a custom method, and the authz
// decision would be about the wrong thing.
//
// Same gate and same scopes as the GET, because it is the same data: a measure the caller may not list is
// absent from both runs and therefore cannot be narrated. Nothing per-person is involved - the comparison is
// over team totals - so the prompt carries measure labels and numbers and no people at all.
export const peopleAnalyticsNarrate = new Hono<AppEnv>()
  .post("/", async (c) => {
    const today = await orgToday(c.get("deps"));
    const monthStart = `${today.slice(0, 7)}-01`;
    const body = (await jsonBody(c).catch(() => ({}))) as Record<string, unknown>;
    const str = (k: string): string | undefined => (typeof body[k] === "string" ? (body[k] as string) : undefined);
    const out = await narrateAnalytics(c.get("deps"), c.get("user")!, c.get("analyticsScopes") ?? new Map(), {
      from: str("from") || monthStart,
      to: str("to") || today,
      departmentId: str("department")?.split("/").pop() || undefined,
    });
    return c.json(out);
  });

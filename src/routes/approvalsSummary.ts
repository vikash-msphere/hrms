import { Hono } from "hono";
import type { AppEnv } from "../env";
import { approvalsSummary } from "../services/approvalsSummary";

// Virtual collection: `GET /v1/approvals-summary` returns how many items in each approval queue are waiting
// for this caller's decision. Like `/v1/search` and `/v1/dashboard-summary` it is a TRANSPORT that owns no data
// and grants nothing: the middleware decides, per queue, whether the caller may APPROVE in it (the same
// decision a real `<collection>/<id>:approve` gets) and leaves the verdicts on `approvalScopes`; the service
// only binds them to COUNT queries. A queue the caller cannot approve in is simply absent from the response.
export const approvalsSummaryRoute = new Hono<AppEnv>().get("/", async (c) => {
  const summary = await approvalsSummary(c.get("deps"), c.get("approvalScopes") ?? new Map(), c.get("taxVerificationsReadable") === true);
  return c.json(summary);
});

import { Hono } from "hono";
import type { AppEnv } from "../env";
import { approvalsSummary } from "../services/approvalsSummary";
import { isBlockedSelfDecision } from "../services/decisionGuard";

// Virtual collection: `GET /v1/approvals-summary` returns how many items in each approval queue are waiting
// for this caller's decision. Like `/v1/search` and `/v1/dashboard-summary` it is a TRANSPORT that owns no data
// and grants nothing: the middleware decides, per queue, whether the caller may APPROVE in it (the same
// decision a real `<collection>/<id>:approve` gets) and leaves the verdicts on `approvalScopes`; the service
// only binds them to COUNT queries. A queue the caller cannot approve in is simply absent from the response.
export const approvalsSummaryRoute = new Hono<AppEnv>().get("/", async (c) => {
  const deps = c.get("deps");
  const user = c.get("user");
  // The caller's own requests are not waiting for their decision - the server refuses it (services/
  // decisionGuard.ts) - so they are not counted as if they were, unless the org allows self-approval.
  const exclude = (await isBlockedSelfDecision(deps, user, user.employeeId)) ? user.employeeId! : null;
  const summary = await approvalsSummary(deps, c.get("approvalScopes") ?? new Map(), c.get("taxVerificationsReadable") === true, exclude);
  return c.json(summary);
});

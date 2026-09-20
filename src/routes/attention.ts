import { Hono } from "hono";
import type { AppEnv } from "../env";
import { attentionFor } from "../services/attention";

// Virtual collection: `GET /v1/attention` answers "what needs me?" across the caller's goals, board cards and
// reviews.
//
// Like `/v1/search` and `/v1/dashboard-summary`, it is a TRANSPORT that owns no data and grants nothing. The
// middleware decides, per backing collection, whether the caller may list it - the same decision a real
// `GET /v1/<collection>` gets - and leaves the verdicts on `attentionScopes`; the service only binds them. A
// collection the caller may not list contributes nothing to the answer rather than refusing it, which is what
// lets one surface serve an employee, a manager and an admin without any of them being told what they cannot
// see.
export const attentionRoute = new Hono<AppEnv>().get("/", async (c) => {
  const out = await attentionFor(c.get("deps"), c.get("user")!, c.get("attentionScopes") ?? new Map());
  return c.json(out);
});

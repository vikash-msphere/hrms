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
//
// `?summary=1` asks for the one-line written summary on top of the list. It is a separate request rather than
// part of the load because it costs a generation: at ~120 neurons against a daily ceiling of 7,000, running
// it on every dashboard load is 58 people a day before the org's whole allocation is gone - and the
// moderation gate, which fails closed, spends the same ceiling. See `summarise` in services/attention.ts.
export const attentionRoute = new Hono<AppEnv>().get("/", async (c) => {
  const summary = c.req.query("summary") === "1" || c.req.query("summary") === "true";
  const out = await attentionFor(c.get("deps"), c.get("user")!, c.get("attentionScopes") ?? new Map(), { summary });
  return c.json(out);
});

import { Hono } from "hono";
import type { AppEnv } from "../env";
import { jsonBody } from "../http/jsonRequest";
import { invalidArgument } from "../lib/errors";
import { isModerationAction, MODERATION_ACTIONS } from "../domain/moderation";
import { decideModeration, listModerationQueue } from "../services/moderation";

// GET /v1/moderation - public posts a guard model objected to, awaiting a person's decision.
//
// Virtual capability (no table of its own): the authz middleware gates this as `moderation.read`, and it is
// private-by-default, so only super holds it until an org grants it through the ACL - the same shape as
// `tax-verifications` and for the same reason. The rows it returns are assembled from `ai_suggestions` joined
// to the two public walls, which is why there is no collection here to scope.
//
// WHY THE QUEUE IS NOT SCOPED PER COLLECTION. Moderating is an org-wide job: somebody who may act on a
// flagged announcement may not otherwise be able to read the suggestion wall, and a queue narrowed to what
// each moderator could already see would make coverage depend on an unrelated grant. `moderation.read` is
// therefore the whole of the decision, which is exactly why it grants nothing by default.
export const moderationRoute = new Hono<AppEnv>().get("/", async (c) => {
  const results = await listModerationQueue(c.get("deps"));
  return c.json({ results });
});

// POST /v1/moderation:decide - uphold a flag (hide the post) or dismiss it (leave it alone).
//
// Its own mount, not a `/decide` path on the route above: `resolveRequest` reads a path segment after the
// collection as an ITEM ID, so `/decide` would be gated as a read of a record called "decide" and the authz
// decision would be about the wrong thing. The same reasoning as `people-analytics:narrate`.
export const moderationDecide = new Hono<AppEnv>().post("/", async (c) => {
  const body = (await jsonBody(c).catch(() => ({}))) as Record<string, unknown>;
  const host = typeof body.host === "string" ? body.host : "";
  if (!host) throw invalidArgument('host is required, as "<collection>/<id>"');
  if (!isModerationAction(body.action)) {
    throw invalidArgument(`action must be one of: ${MODERATION_ACTIONS.join(", ")}`);
  }
  const out = await decideModeration(c.get("deps"), c.get("user")!, host, body.action);
  return c.json(out);
});

import { Hono } from "hono";
import type { AppEnv } from "../env";
import { jsonBody } from "../http/jsonRequest";
import { invalidArgument } from "../lib/errors";
import { isModerationAction, isUnhideMode, MODERATION_ACTIONS, UNHIDE_MODES } from "../domain/moderation";
import { decideModeration, hideManually, listModerationQueue, unhideModeration } from "../services/moderation";

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
  // `?state=decided` reads the history instead of the queue - what was hidden or released, by whom. Same
  // capability: it is the same posts and the same quotes, one screen later. Anything but the two known
  // values reads as the queue rather than erroring, because a mistyped filter should show a moderator the
  // work waiting on them, not a 400.
  const state = c.req.query("state") === "decided" ? "decided" : "pending";
  return c.json(await listModerationQueue(c.get("deps"), state));
});

// POST /v1/moderation:decide - uphold a flag (hide the post) or dismiss it (leave it alone).
//
// Its own mount, not a `/decide` path on the route above: `resolveRequest` reads a path segment after the
// collection as an ITEM ID, so `/decide` would be gated as a read of a record called "decide" and the authz
// decision would be about the wrong thing. The same reasoning as `people-analytics:narrate`.
// POST /v1/moderation:hide - take a post down because a person objected. No flag required.
//
// Its own verb (`moderation.hide`) so an org can hand out the queue work and the power to reach onto the
// wall independently. The middleware gates it; nothing below tests a role.
export const moderationHide = new Hono<AppEnv>().post("/", async (c) => {
  const body = (await jsonBody(c).catch(() => ({}))) as Record<string, unknown>;
  const host = typeof body.host === "string" ? body.host : "";
  if (!host) throw invalidArgument('host is required, as "<collection>/<id>"');
  return c.json(await hideManually(c.get("deps"), c.get("user")!, host));
});

// POST /v1/moderation:unhide - put a post a moderator hid back, and reopen its flag.
//
// Its own mount and its own verb (`moderation.unhide`), for the same reason `:decide` is separate from the
// queue read: the authz middleware gates each custom method by name, so an org can grant reviewing, or
// deciding, or reversing a decision, independently. Nothing in the handler or the service tests a role.
//
// `mode` picks WHERE it lands - back to its author as a draft, or straight onto the wall - and is not a
// second grant. Both are the same act, reversing a takedown, and an org that trusts somebody to undo a
// colleague's decision is not thereby saying they may only undo it halfway. It defaults to `draft`, the
// cautious one and the only thing this verb used to do.
export const moderationUnhide = new Hono<AppEnv>().post("/", async (c) => {
  const body = (await jsonBody(c).catch(() => ({}))) as Record<string, unknown>;
  const host = typeof body.host === "string" ? body.host : "";
  if (!host) throw invalidArgument('host is required, as "<collection>/<id>"');
  if (body.mode !== undefined && !isUnhideMode(body.mode)) {
    throw invalidArgument(`mode must be one of: ${UNHIDE_MODES.join(", ")}`);
  }
  return c.json(await unhideModeration(c.get("deps"), c.get("user")!, host, body.mode ?? "draft"));
});

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

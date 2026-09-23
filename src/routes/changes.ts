import { Hono } from "hono";
import type { AppEnv } from "../env";
import { changedSince } from "../services/changes";
import { authzVersion } from "../domain/authzVersion";

// Virtual collection: `GET /v1/changes?since=<epochMs>` names the collections written to since that moment, so
// a client can keep everything else it has stored instead of re-reading it.
//
// `changes` is not a resource - it owns no data and grants nothing. Like `/v1/search` and the summaries, the
// ENVELOPE is open to any authenticated caller and the real gating happens per collection: the middleware
// decides which collections this caller may list and leaves the set on `listableCollections`, and a collection
// they cannot list is never named here. This route makes no access decision of its own.
//
// `unknown_window: true` means "there is no reference point I can answer against" (a first visit, or cleared
// storage) - the client then revalidates the ordinary way rather than trusting its stored copies.
export const changes = new Hono<AppEnv>().get("/", async (c) => {
  const since = Number(c.req.query("since") ?? 0);
  const answer = await changedSince(c.get("deps"), since);
  // What the caller may currently do, as one short stamp (domain/authzVersion.ts). A client whose stored value
  // differs gives up EVERYTHING it has stored for this identity, because a stored row carries the access hints
  // and field redactions computed under the old rights - and a collection they have just lost is filtered out
  // of `collections` below, so it could never be named. Comes off the grant the auth read already loaded.
  const user = c.get("user");
  const authz_version = authzVersion(user.grant, user.employeeCode);
  if (answer.collections === null) return c.json({ now: answer.now, unknown_window: true, authz_version });
  const listable = c.get("listableCollections") ?? new Set<string>();
  return c.json({ now: answer.now, collections: answer.collections.filter((col) => listable.has(col)), authz_version });
});

import { Hono } from "hono";
import type { AppEnv } from "../env";
import { changedSince } from "../services/changes";

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
  if (answer.collections === null) return c.json({ now: answer.now, unknown_window: true });
  const listable = c.get("listableCollections") ?? new Set<string>();
  return c.json({ now: answer.now, collections: answer.collections.filter((col) => listable.has(col)) });
});

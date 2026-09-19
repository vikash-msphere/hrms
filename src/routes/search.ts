import { Hono } from "hono";
import type { AppEnv } from "../env";
import { globalSearch } from "../services/globalSearch";
import { redactionGateFor } from "../http/fieldAccess";

// Virtual collection: `GET /v1/search?q=...` returns cross-collection hits for the command palette. `search`
// is not a resource - it holds no data of its own and grants nothing. It is the read-side twin of
// `/v1/batch:run`: the envelope is a transport, and access is decided per collection. The middleware does that
// deciding and leaves the verdicts on `searchScopes`; this route makes no access decision, exactly like every
// other list route. The field gate it hands over is the same shape: `redactionGateFor` closes over the
// caller's grant so the service can ask a decision it is not allowed to make itself, one row at a time.
//
// `name` is the standard `<collection>/<id>` resource ref, so the outbound wire edge tokenizes the id like
// every other response and the SPA routes on it with the same resourceRoute() it uses for the activity feed.
export const search = new Hono<AppEnv>().get("/", async (c) => {
  const hits = await globalSearch(c.get("deps"), c.get("user")!, c.get("searchScopes") ?? new Map(), c.req.query("q") ?? "", redactionGateFor(c.get("user")!));
  return c.json({
    results: hits.map((h) => ({ name: `${h.collection}/${h.id}`, collection: h.collection, title: h.title, subtitle: h.subtitle })),
  });
});

import { Hono } from "hono";
import type { AppEnv } from "../env";
import { listActivity, listAllActivity } from "../services/activity";
import { toActivityResource } from "../http/serialize";

// GET /v1/activity — the audit trail, newest-first, keyset-paged (`page_token` = the `at` epoch-ms of the
// last row seen). Two modes, both gated in the authz middleware (single source):
//   • ?resource=<entity>/<id>  — one entity's trail; gated by READ on that entity (everyone-held `activity`).
//   • no resource              — the ORG-WIDE feed across every collection; gated by the `audit` capability
//                                 (super-only by default). Extra filters: ?entity=<collection>, ?actor= and
//                                 ?api_key=<api-keys/id> (everything one credential did).
// The inbound edge already decoded any `<entity>/<token>` ref to an internal id.
export const activity = new Hono<AppEnv>().get("/", async (c) => {
  const before = Number(c.req.query("page_token")) || undefined;
  const limit = Number(c.req.query("max_page_size")) || undefined;
  const q = c.req.query("q");
  const tone = c.req.query("tone");
  const resource = c.req.query("resource") ?? "";

  if (resource) {
    const slash = resource.indexOf("/");
    const entity = slash >= 0 ? resource.slice(0, slash) : "";
    const id = slash >= 0 ? resource.slice(slash + 1) : "";
    const { items, nextBefore } = await listActivity(c.get("deps"), entity, id, { limit, before, q, tone });
    return c.json({ results: items.map(toActivityResource), next_page_token: nextBefore ? String(nextBefore) : undefined });
  }

  // `?actor` may be an employee ref (`employees/<id>`, already decoded to an internal id by the inbound edge)
  // for an exact actor filter, or free text for an email-substring match.
  const actorRaw = c.req.query("actor") || undefined;
  const actorId = actorRaw?.startsWith("employees/") ? actorRaw.slice("employees/".length) : undefined;
  // `?api_key=api-keys/<id>` (the inbound edge already decoded the token) narrows the feed to everything that
  // ONE credential did. It rides the org-wide branch on purpose: a key's trail spans every collection, so it
  // must not be readable by someone who cannot read the org-wide feed.
  const keyRaw = c.req.query("api_key") || undefined;
  const apiKeyId = keyRaw?.startsWith("api-keys/") ? keyRaw.slice("api-keys/".length) : keyRaw;
  const { items, nextBefore } = await listAllActivity(c.get("deps"), {
    limit, before, q, tone,
    entity: c.req.query("entity") || undefined,
    actor: actorId ? undefined : actorRaw,
    actorId,
    apiKeyId,
  });
  return c.json({ results: items.map(toActivityResource), next_page_token: nextBefore ? String(nextBefore) : undefined });
});

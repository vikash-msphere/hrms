import { Hono } from "hono";
import type { AppEnv } from "../env";
import { listActivity, listAllActivity } from "../services/activity";
import { caseMembers } from "../services/activityCase";
import { toActivityResource } from "../http/serialize";
import { queryParam } from "../http/query";

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
  // READ THROUGH http/query.ts, because the AUTHZ MIDDLEWARE ALSO READS THIS ONE.
  //
  // `?resource` is what picks the gate this request gets (READ on the named entity, or the org-wide `audit`
  // capability when it is absent), and middleware/authz.ts decides that from `new URL(c.req.url)`. Hono's
  // own parser scans from the first `?` to the end of the string, so the two once disagreed about a query
  // smuggled past a `#` - which is exactly how `#?force=true` was gated as a soft delete and executed as a
  // hard purge. `force` was moved to the shared reader then; this parameter was missed. The hono pin makes
  // the two agree today, but a version range is a promise about a dependency and this is a property of the
  // code: whatever the gate reads, the handler reads the same way. See the header of http/query.ts.
  const resource = queryParam(c, "resource") ?? "";

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
  const subjectRaw = c.req.query("subject") || undefined;
  // `?case=<collection>/<id>` - one long-running STORY (a hire, an onboarding), assembled by walking the links
  // the schema already carries rather than from a stored case id. Org-wide branch like the others: a case
  // spans collections, so reading it whole needs the org-wide grant, not read on one record in it.
  const caseRaw = c.req.query("case") || undefined;
  const caseResult = caseRaw ? await caseMembers(c.get("deps"), caseRaw.split("/")[0]!, caseRaw.split("/").pop()!) : undefined;
  const caseIds = caseResult?.members;
  // A root that resolves to nothing must answer with nothing, not with the whole org-wide feed.
  if (caseRaw && !caseIds?.length) return c.json({ results: [] });
  const keyRaw = c.req.query("api_key") || undefined;
  const apiKeyId = keyRaw?.startsWith("api-keys/") ? keyRaw.slice("api-keys/".length) : keyRaw;
  // `?correlation=<id>` narrows to ONE act: every entry a single request (or cron tick) wrote. Rides the
  // org-wide branch for the same reason the api-key filter does - an act spans collections, so reading it whole
  // must require the org-wide grant rather than read on whichever record happens to anchor one of its entries.
  const { items, nextBefore } = await listAllActivity(c.get("deps"), {
    limit, before, q, tone,
    entity: c.req.query("entity") || undefined,
    actor: actorId ? undefined : actorRaw,
    actorId,
    apiKeyId,
    correlationId: c.req.query("correlation") || undefined,
    // `?subject=employees/<id>` (the inbound edge already decoded the token). Org-wide branch DELIBERATELY: a
    // person's cross-collection timeline is strictly more revealing than any single record in it, so it must
    // require the `audit` capability rather than read on whichever record happens to anchor one of its entries.
    subjectId: subjectRaw?.startsWith("employees/") ? subjectRaw.slice("employees/".length) : undefined,
    sessionId: c.req.query("session") || undefined,
    entityIds: caseIds,
  });
  return c.json({
    results: items.map(toActivityResource),
    next_page_token: nextBefore ? String(nextBefore) : undefined,
    // Say so when the case was cut short, rather than letting a partial money trail pass for a complete one.
    ...(caseResult?.truncated ? { case_truncated: true } : {}),
  });
});

# Architectural gaps plan (SonicJS comparison)

Seven capabilities SonicJS has architecturally that HRMS does not. Ordered by value-to-cost, and by
dependency: phase 6 is nearly free once 1 and 2 land, phase 5 is expensive unless 2 lands first.

Each phase is independently shippable. Nothing here changes access-control semantics: the middleware stays
the single source of authorization, and every new lane resolves to a principal that the existing engine
already understands.

## Status (2026-08-16)

| Phase | State |
|---|---|
| 1 - Machine principals (API keys) | **DONE.** `routes/apiKeys.ts`, `services/apiKeys.ts`, `domain/keyScope.ts`; a key acts as its owning user with a narrowed grant. `test/apiKeys.test.ts` + `test/keyScope.test.ts` |
| 2a/2b - Collection factory | **DONE.** `http/collectionRoute.ts` + `services/crud.ts`; 78 of 106 route files on the lane, the rest are not collections. `test/collectionLaneDrift.test.ts` gates it. Full account in `collection-factory-plan.md` |
| 2c - Generate OpenAPI from the specs | **NOT STARTED.** `openapi.yaml` is still 557KB by hand; `openapiRoutesDrift` / `customMethodsDrift` keep it honest meanwhile |
| 3 - KV cache tier | **NOT STARTED**, and now contested: the app added a client-side resource store, a batch endpoint and `dbBatch.ts` prefetching, so cold-isolate D1 reads are a smaller share of the budget than when this was written. Re-measure before building |
| 4 - Revision history and restore | **NOT STARTED.** No `revisions` table |
| 5 - Custom fields | **NOT STARTED.** Schema is still fixed at compile time (100 tables) |
| 6 - MCP server | **NOT STARTED.** No `/mcp` endpoint. Its two prerequisites (1 and 2) are now in place, so the estimate of ~1 day holds |
| 7 - Semantic search | **NOT STARTED.** Global search is FTS5 with per-collection scoping (`domain/searchIndex.ts`, `db/searchDdl.ts`), which shipped after this plan was written and covers the practical need |

Phase text below is the original design, unchanged except where a status line says otherwise.

---

## Phase 1 - Machine principals (scoped API keys)

**Gap.** Auth is human-only. `src/middleware/auth.ts` accepts a Cloudflare Access JWT or a Google-OIDC
session cookie and nothing else. There is no way for a script, a CI job, an integration, or an agent to call
the API. The only `API_KEY` in the codebase is outbound (`src/env.ts:44`, email vendor). This blocks phase 6
outright and is the single highest-value gap.

**Design.** A key is not a new kind of principal. It belongs to an existing user and resolves to that user's
`AppUser`, so role grants, user rules, dept scope, and object ACLs all work unchanged. A key may carry an
optional narrowing grant that is **intersected** with the owner's grant, never unioned - a key can only ever
be weaker than the human who minted it.

New table `api_keys`:

| column | purpose |
| --- | --- |
| `uuid`, `code` | standard identity + wire code |
| `name` | human label |
| `owner_user_id` | the principal the key acts as |
| `prefix` | indexed lookup key, first 8 chars of the token |
| `hash` | HMAC-SHA256 of the secret under `AUTH_SESSION_KEY` (not a bare digest, so a DB leak alone is not a credential) |
| `mode` | `read` (default) or `write` |
| `scope_json` | optional narrowing grant, intersected with owner's |
| `expires_at`, `revoked_at`, `last_used_at` | lifecycle |

Token format `hrms_<prefix>_<secret>`, presented as `Authorization: Bearer …`. Secret shown once at
creation, never retrievable.

**Changes.**

- `src/middleware/auth.ts` - new branch ahead of the Access/Google split: parse bearer, look up by `prefix`,
  constant-time compare the HMAC, reject revoked/expired, load the owner exactly as today, intersect the
  scope. Write `last_used_at` only when it is older than ~15 min (D1 write budget).
- `src/middleware/csrf.ts` - bearer auth is not ambient, so the CSRF check must be skipped for key callers
  and **only** for key callers.
- `src/lib/viewAs.ts` - reject `X-View-As` from a key principal. Simulation is a human affordance.
- `src/lib/audit.ts` - record the acting key id alongside the actor, so the trail distinguishes "Priya" from
  "Priya's CI key".
- `src/routes/apiKeys.ts` + `src/services/apiKeys.ts` - CRUD, super-only create, `:revoke` verb.
- `openapi.yaml`, serializers, web Settings page for key management.

**Tests** (`test/apiKeys.test.ts`): unknown/expired/revoked/malformed prefix all 401; disabled owner 403;
scope intersection provably cannot exceed the owner's grant; `mode:read` key rejected on POST/PATCH/DELETE;
audit row carries the key id; `X-View-As` from a key is rejected; CSRF skip does not leak to cookie callers.

**Risk.** This is a new authentication path. Review it as security-sensitive: run `/security-review` on the
diff before merge.

**Effort.** ~1 day.

---

## Phase 2 - Collection factory

**Gap.** 106 route files in `src/routes/`, 111 services in `src/services/`, a 63KB `src/http/serialize.ts`,
and a hand-maintained 536KB `openapi.yaml`. Adding one collection touches roughly ten registries. Most of
that is not domain logic. `src/routes/holidays.ts` is 59 lines of pure shape: list with `clampPageSize` +
`withAccess`, get, post with `?id`, patch with `If-Match`, delete with `?force`, then `lifecycleVerb` plus
`restore`. Around forty collections are that exact shape modulo table, zod schema, and serializer.

**Design.** `src/http/collectionRoute.ts`:

```ts
collectionRoutes({
  table, collection: "holidays", singular: "holiday",
  writeSchema, serialize: toHolidayResource,
  service?,            // defaults to generic CRUD
  verbs?,              // extra custom methods
})
```

The default service is a new `src/services/crud.ts` composed from helpers that already exist:
`visibleByDelete` / `softDeleteRow` / `restoreRow` / `purgeRow` (`services/softDelete.ts`),
`assertNotLocked` (`services/lifecycle.ts`), `encodeCursor` / `decodeCursor` (`http/pagination.ts`),
`audit` + `diffMeta` (`lib/audit.ts`), `allocFlatCode` (`services/codeAlloc.ts`).

The factory returns a Hono app so a collection can chain extra handlers onto it. Nothing forces a
collection into the generic path; payroll, settlements, ATS, boards keep their bespoke services.

**Sequencing.**

- **2a** - build the factory, convert three collections (`holidays`, `pay-grades`, `expense-categories`),
  measure LOC delta. Existing per-collection tests are the safety net and must pass **unchanged** - that is
  the whole proof of equivalence. Stop and reassess if the delta is unconvincing.
- **2b** - convert the remaining plain-CRUD collections, a few per PR.
- **2c** - generate OpenAPI path items from the same specs. This is the second-order win: it retires the
  bulk of the hand-maintained 536KB file, and `openapiRoutesDrift` / `customMethodsDrift` already gate
  correctness. Keep bespoke paths hand-written.

**Effort.** 2a ~1 day. 2b incremental. 2c ~2 days.

---

## Phase 3 - KV cache tier

**Gap.** `src/lib/cache.ts` is an in-isolate `Map` with a TTL, and `wrangler.toml` declares no KV namespace
at all. Every cold isolate pays full D1 reads for the role grant, user grant, and policy manifest on its
first request. That is directly against the free-plan read budget the app is otherwise shaped around.

**Design.** Three tiers, memory then KV then D1, write-through on load.

Invalidation is the interesting part. KV deletes are eventually consistent across colos, so do not rely on
them. Instead put a monotonic `policy_version` in KV and fold it into the cache key
(`grant:v42:<role>`). Any write to `access_rules` or `policy` bumps the version, which orphans every stale
key instantly and correctly, rather than waiting out a TTL. `clearCache` / `clearCachePrefix` keep working
for the memory tier and for tests.

Memory tier still absorbs the hot path, so KV reads only happen on cold isolates - well inside free-tier KV
limits.

**Changes.** `src/lib/cache.ts`, `src/lib/policyLoad.ts` (versioned keys), `src/env.ts` (`CACHE:
KVNamespace`), `wrangler.toml` (both default and `[env.staging]` - staging does not inherit),
`test/cache.test.ts` extended with a fake KV and a version-bump case.

**Effort.** ~half a day. Best value-per-hour in the plan.

---

## Phase 4 - Revision history and restore

**Gap.** There is soft-delete plus restore, an append-only `audit_log`, and per-entity workflow states
(`requisitions` draft to open, `offers` draft to approved, `org_documents.ack_version`). What is missing is a
generic "show previous versions of this row, restore one". The audit log records that a field changed, not
enough to reconstruct and revert a row.

**Design.** One table, `revisions`: `collection`, `entity_uuid`, `version`, `snapshot_json` (post-image),
`actor_id`, `key_id`, `created_at`. Written from `src/lib/audit.ts`, which is already the single choke point
that receives the updated row. Opt-in per collection via a `REVISIONED_COLLECTIONS` set - not everything
needs it, and every snapshot is a D1 write.

Restore validates the snapshot against the current write schema and applies it as an ordinary PATCH, which
records a **new** revision. History is never rewritten. Gate it behind a `restoreVersion` verb so it appears
in the access UI like every other capability.

Retention: keep the last N revisions per entity, prune in the existing 02:00 nightly cron.

UI: a "Versions" tab beside the existing `ActivityFeed`, same lazy mount-on-open pattern, field-level diff,
restore button behind the verb.

**Effort.** ~2 days.

---

## Phase 5 - Custom fields

**Gap.** `src/db/schema.ts` is 2072 lines fixed at compile time. An org cannot add a field or a form without
a code deploy. This is the gap that bites the moment a second customer wants one column.

**Design.** `custom_field_defs` (`collection`, `key`, `label`, `type`, `options_json`, `required`) plus a
`custom_json` column on each participating host table. JSON column, **not** EAV - keeps reads at one row and
keeps the free-plan read shape intact.

At request time, build a dynamic zod fragment from the cached defs and merge it into the collection's write
schema. This is why phase 2 comes first: with the factory, this is one change in one place; without it, it
is forty.

Custom fields must plug into the existing field mask in `src/http/fieldAccess.ts`, so a custom field can be
restricted exactly like a built-in one. Web side: a generic `FieldRenderer` driven by defs, and a Settings
editor. That also subsumes SonicJS's drag-and-drop form builder as a rendering concern rather than a
separate subsystem.

**Effort.** ~4 days. Do not start before phase 2b.

---

## Phase 6 - MCP server

**Gap.** No MCP endpoint. The OpenAPI surface is AEP-conformant and therefore already agent-legible, but
nothing exposes it as tools, and until phase 1 there is no credential an agent could hold.

**Design.** A `/mcp` streamable-HTTP endpoint authenticated by phase-1 keys. Tools are generated from the
phase-2 collection specs, so the tool list is not a third hand-maintained registry - it is the same source
that produces the routes and the OpenAPI. Every call runs through the normal authz middleware, so an agent
is bounded by its key's scope by construction, with nothing to re-implement.

Default to read-only tools. Writes only for `mode:write` keys.

**Effort.** ~1 day given phases 1 and 2. Multiple days without them.

---

## Phase 7 - Semantic search

**Gap.** `GET /v1/search` is FTS5 keyword matching over generated sync triggers. No embeddings, no
natural-language query.

**Design.** Vectorize binding plus Workers AI embeddings over the same rows the FTS5 triggers already track.
Embed on write asynchronously through the existing 5-minute cron LRO drain, never inline on the request
path. Hybrid rank FTS5 and vector results, then filter through the same per-collection `ctx.searchScopes`
the middleware already computes, so semantic hits cannot leak rows a keyword search would have hidden.

**Effort.** ~3 days. Lowest value of the seven; the keyword search is not currently a complaint.

---

## Not doing

- **Password / OTP / magic-link auth.** Federated-only is a deliberate decision. Phase 1 covers the actual
  need, which is machine callers.
- **Non-Cloudflare portability.** `src/ports/` already provides the seam if it ever matters. The D1-shaped
  batch strategy in `src/lib/dbBatch.ts` is load-bearing for the free-plan subrequest budget and is not
  worth abstracting speculatively.
- **Plugin marketplace / `definePlugin` SDK.** The automation engine plus event bus already covers
  data-driven extension. A code-level plugin registry has no second consumer.
- **Migration versioning.** The single-squashed-migration policy is correct while nothing is deployed.
  Revisit the day a live instance exists that cannot be reseeded.

## Recommended start (superseded - see Status above)

Phases 1 and 2 were taken first and are done. Of what remains, phase 6 (MCP) is the cheapest real
capability now that both its prerequisites exist; phase 3 should be re-measured before it is believed; and
phase 4 is the one users would notice. Original ordering advice below.



Phase 3 first if you want a same-day win, phase 1 first if you want the unblocking one. Phase 1 then 3 then
2a is the sequence I would take.

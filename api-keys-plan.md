# Phase 1 - Scoped API keys (implementation plan)

**Status: implemented.** The reference for how this works now lives in `docs/authz.md` section 5.1; this
file is the plan it was built from, kept for the reasoning behind the design. Where the implementation
differs from what is written below, see "What changed during implementation" at the end.

Give the API a machine-caller lane. Today `src/middleware/auth.ts` accepts a Cloudflare Access JWT or a
Google-OIDC session cookie and nothing else, so no script, CI job, integration, or agent can call `/v1/*`.

## Security invariants

These are the properties the tests must prove. Everything below exists to serve them.

1. **A key is never stronger than its owner.** A key acts as an existing user and may only narrow that
   user's authority. There is no path by which a key grants access the owner does not have.
2. **Bearer is authoritative.** If `Authorization: Bearer hrms_…` is present, the request is a key request.
   It succeeds as that key or fails 401. It never falls back to the session cookie. (This is what makes the
   CSRF skip safe - see below.)
3. **Revocation is immediate.** The key row is read live from D1 on every request and is never cached.
4. **Keys cannot simulate.** `X-View-As` from a key principal is rejected.
5. **The trail names the key.** Audit rows record the acting key alongside the owner, so "Priya" and
   "Priya's CI key" are distinguishable.

---

## 1. Scope model

A key's narrowing is deliberately **not** an arbitrary grant. Intersecting two pattern grants
(`Grant = { levels, allow, deny }` in `src/domain/permissions.ts:46`) requires pattern algebra over `me` /
`my-dept` / `<prefix>-*`, which is where an authorization bug would hide. Instead a scope is three plain
facts, each of which intersects exactly:

```ts
type KeyScope = {
  collections: string[] | "*";  // namespace allowlist (first pattern token)
  maxLevel: Level;              // read | write | admin, clamps every granted level
  verbs: string[] | "*";        // custom-method allowlist
};
```

`collections` maps onto the first pattern token, which is exactly what `access_rules.namespace` already
stores and what `deriveNarrowing` (`src/domain/compileGrants.ts:31`) computes. No new concept.

`maxLevel` subsumes a read/write flag, so there is no separate `mode` column. One concept, not two.

### `narrowGrant(grant, scope): Grant`

New pure function in `src/domain/keyScope.ts`:

- **levels** - for each `[pattern, level]`: take `ns = pattern.split(".")[0]`. If `ns` is `**` or `*`
  (super's `{ levels: { "**": "admin" } }`), expand it to one `<col>.**` entry per allowed collection; if
  `collections` is `"*"`, keep the pattern as-is. Otherwise keep only when `collections` includes `ns`.
  Clamp every surviving level to `min(level, maxLevel)` on the `LVL` ladder.
- **allow** - same namespace filter, plus the pattern's last token (the verb) must be in `verbs`. Expand
  `**` the same way.
- **deny** - keep every entry unconditionally. Deny only ever reduces access.

Pure, no I/O, exhaustively unit-testable. A read-only key owned by super collapses `**` into
`{ "employees.**": "read", "leave-requests.**": "read" }`, which is precisely the useful case.

---

## 2. Where the ceiling is enforced (two places, deliberately)

**Narrowing `user.grant` at auth time is not sufficient by itself.** `src/middleware/authz.ts:190` and
`:232` load per-object exception rules and `mergeGrants` them onto `user.grant` at decision time. That merge
can re-widen past the ceiling. So:

**(a) Narrow the grant in `auth.ts`.** Set `user.grant = narrowGrant(mergeGrants(roleGrant, userGrant), scope)`.
This makes everything derived from `user.grant` correct for free: the `listable` filter at
`authz.ts:132`, `searchScopes`, `summaryScopes`, and the `access.can` hints from `capabilitiesOf`. Without
this, `GET /v1/search` would happily return rows from collections outside the key's scope.

**(b) Gate the resolved request in `authz.ts`.** At the top of the middleware, after `resolveRequest`
produces `{ resource, level | verb }` and before any lane runs: if `user.apiKey` is set and the resource's
first token is outside `collections`, or the level exceeds `maxLevel`, or the verb is outside `verbs`, throw
`forbidden("outside api key scope")`. One check, one place, covering the standard lane, the object lane, and
every custom verb. `authz` is the sole gate for all of `/v1/*` (`src/index.ts:159`) and it re-runs for each
`/v1/batch:run` sub-request, so batch is covered with no extra work.

(a) makes the answers right. (b) makes them safe. Keep both.

---

## 3. Data model

New table in `src/db/schema.ts`:

```ts
export const apiKeys = sqliteTable("api_keys", {
  uuid: pk(),
  code: codeCol(),
  name: text("name").notNull(),
  ownerUserId: text("owner_user_id").notNull().references(() => users.uuid, { onDelete: "cascade" }),
  prefix: text("prefix").notNull().unique(),   // indexed lookup key
  hash: text("hash").notNull(),                // HMAC-SHA256 of the secret, base64
  scopeJson: text("scope_json").notNull(),     // KeyScope
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  createdBy: text("created_by").references(() => users.uuid),
  createdAt: created(),
  updatedAt: updated(),
});
```

`onDelete: "cascade"` on the owner: deleting a user must not leave a live credential behind.

Migration per the squash rule: delete `src/db/migrations/0000_*.sql` plus `meta/`, empty the journal, run
`npm run db:generate`. One migration, always.

---

## 4. Token format and hashing

`hrms_<prefix>_<secret>` where `prefix` is 8 random base32 chars (the indexed lookup handle) and `secret` is
`base64url(crypto.getRandomValues(24 bytes))`.

Stored as `HMAC-SHA256(secret)` under a key derived from `FIELD_ENCRYPTION_KEY` via HKDF with
`info="api-key-hmac"` - the same derivation shape the wire-id codec and encryptor already use. Rationale:
`AUTH_SESSION_KEY` is optional (Google mode only, `src/env.ts`), so it cannot be the source; `FIELD_ENCRYPTION_KEY`
is always present; HKDF with a distinct label avoids reusing one key for two purposes. No new required
secret means no deploy-time change.

HMAC not a bare SHA-256 digest, so a database leak alone is not a set of working credentials.

Verification uses `crypto.subtle.verify`, which is constant-time. Never `===` on a MAC - `src/lib/session.ts`
already carries this rule in a comment; follow it.

New file `src/lib/apiKeyToken.ts`: `mintToken()`, `parseToken(header)`, `verifyToken(secret, hash)`.

---

## 5. `auth.ts` changes

Insert a branch before the dev-bypass / Google / Access split (`src/middleware/auth.ts:36-61`):

```
const bearer = parseToken(c.req.header("Authorization"));
if (bearer) { ...key lane...; await next(); return; }   // never falls through
```

The key lane:

1. `SELECT` from `api_keys` by `prefix` (unique index, 1 read). Missing → 401.
2. `verifyToken` → mismatch 401. Check `revokedAt` and `expiresAt` → 401.
3. Load the owner by `users.uuid`. The existing users⋈employees join at `:69-81` selects on `email`;
   extract it into `resolveUserRow(deps, by)` taking email **or** uuid so both lanes share it.
4. **Skip auto-provisioning entirely.** A key can never mint a user. The `:83-114` block is email-lane only.
5. `status !== "active"` → 403, same as today.
6. Load `roleGrant` + `userGrant` as today, merge, then `narrowGrant(merged, scope)`.
7. Set `user.apiKey = { uuid, code, name, scope }` on the `AppUser`.
8. Touch `last_used_at` only when null or older than 15 minutes, inside `c.executionCtx.waitUntil` so it is
   off the response path. Skip it in the `__sharedCtx` batch sub-request path.

The key row is intentionally **not** cached, so revocation bites on the next request. Cost is one extra
indexed D1 read per key request. That is the right trade for a credential.

`src/env.ts`: add `apiKey?: { uuid: string; code: string; name: string; scope: KeyScope }` to `AppUser`,
next to `simulatedBy`.

---

## 6. Interactions to get right

**CSRF.** `src/middleware/csrf.ts` runs *before* `auth` (`src/index.ts:158`), so it cannot know whether a key
is valid. It must skip the `X-Requested-By` check when an `Authorization: Bearer hrms_` header is present.
That is safe **only** because of invariant 2: a present-but-invalid bearer 401s rather than falling through
to the cookie. Without the no-fallback rule this is a CSRF hole - an attacker sets a junk bearer to suppress
the CSRF check and rides the victim's cookie. Write that reasoning into the code comment; it is not obvious
to the next reader.

(The alternative, moving `csrf` after `auth`, is cleaner in principle but reorders 401 and 403 responses
across the whole surface. Not worth it here.)

**View-as.** `src/lib/viewAs.ts` must return early for a key principal. Simulation is an interactive
human affordance and would let a key act as an arbitrary employee.

**Batch.** `/v1/batch:run` reuses the resolved user via `__sharedCtx` and re-runs `authz` per sub-request.
Since the ceiling lives in both the narrowed grant and the authz gate, sub-requests inherit it. No change
needed. Add a test anyway.

**Audit.** `src/lib/audit.ts:writeAudit` builds the actor from `AppUser`. Add `via_api_key` to `meta` when
`actor.apiKey` is set, mirroring how `viewing_as` is attached for simulation at `:72`. Add `keyId` to the
`audit_log` schema only if you want it queryable; `meta` is enough to start.

---

## 7. Collection surface

Standard collection, following `add-collection-checklist`:

- `src/db/schema.ts` - table above, then regenerate the single migration.
- `src/services/apiKeys.ts` - list / get / create / revoke / delete. Create mints the token, returns the
  plaintext **once**, stores only the HMAC.
- `src/routes/apiKeys.ts` - mount at `/v1/api-keys` in `src/index.ts`.
- `src/http/serialize.ts` - `toApiKeyResource`. Never serializes `hash`. Emits `prefix` and a masked
  `hrms_ab12cd34_…` display form. The plaintext secret appears only in the create response body.
- `src/lib/authzResolve.ts` `TABLES` - `"api-keys": schema.apiKeys`.
- `src/middleware/encodeWireIds.ts` `ENCODABLE` - add it (mandatory for anything in `TABLES`, gated by
  `wireRegistry.test`).
- `src/domain/collections.ts` `COLLECTIONS` - add it (gated by `policyValidate.test`).
- `openapi.yaml` - `x-aep-resource` with kebab-case `api-key` / `api-keys`, List/Get/Create/Delete plus the
  `:revoke` custom method, and a `bearerAuth` security scheme. Then `npm run api:types`.
- **Access: nothing in `grants.ts` or `seed.sql`.** Private by default means only super's `**` reaches it,
  which is the correct initial posture for a credential-minting collection. `seedDrift` stays green.

Web: `web/src/types.ts`, a Settings page (list, create dialog that shows the secret once with a copy
control and a "you will not see this again" warning, revoke, last-used column), `web/src/nav.ts` gated on
`perm: "api-keys.read"`.

**Expiry policy.** Default 90 days, offer 30/90/365, allow never but mark it clearly in the UI. Surface
`expires_at` in the list so stale keys are visible.

---

## 8. Tests

`test/keyScope.test.ts` (pure, fast, the real proof of invariant 1):

- `narrowGrant` on super's `{ "**": "admin" }` with a two-collection read scope yields exactly two `read`
  entries and nothing else.
- Level clamping in both directions; a scope cannot *raise* a level.
- Namespace filter drops non-listed collections including `**`-expanded ones.
- Verb filter drops non-listed custom methods.
- Deny entries always survive.
- Property-style check: for a spread of resolved requests, `decide(narrowed, r)` implies `decide(original, r)`.
  That is invariant 1 stated executably.

`test/apiKeys.test.ts` (integration):

- Unknown prefix, malformed token, wrong secret, expired, revoked → 401.
- Disabled owner → 403.
- Read-scoped key: GET allowed, POST/PATCH/DELETE 403 with `outside api key scope`.
- Collection-scoped key: in-scope collection 200, out-of-scope 403.
- `GET /v1/search` with a scoped key returns hits only from in-scope collections (guards the `searchScopes`
  path specifically - this is the one that would silently leak).
- `GET /v1/dashboard-summary` likewise for `summaryScopes`.
- Per-object exception rules do not let a key exceed its ceiling (the `authz.ts:190/232` merge path -
  guards the finding that motivated the two-place design).
- `X-View-As` with a key → rejected.
- Key auth over `/v1/batch:run` inherits the ceiling on every sub-request.
- Invalid bearer plus a valid session cookie → 401, not a cookie-authenticated success (invariant 2, and
  the thing that makes the CSRF skip sound).
- Mutation with a valid key and no `X-Requested-By` → succeeds.
- Audit row carries `via_api_key` and the owner's identity.
- Key creation is super-only; the plaintext secret appears exactly once and never on a subsequent GET.
- Deleting the owner removes the key (cascade).

Run `npm run verify` (spectral, typecheck, vitest) and `/security-review` on the diff before merge. This is
a new authentication path; treat the review as mandatory rather than optional.

---

## 9. Order of work

1. `src/domain/keyScope.ts` + `test/keyScope.test.ts`. Pure, no dependencies, and it is where the security
   argument lives. Land it green first.
2. Schema + migration squash + `src/lib/apiKeyToken.ts`.
3. Service + routes + registries + OpenAPI. Collection is reachable by super, no auth lane yet.
4. `auth.ts` key branch, `csrf.ts` skip, `viewAs.ts` reject, `audit.ts` `via_api_key`.
5. `authz.ts` ceiling gate.
6. `test/apiKeys.test.ts`.
7. Web Settings page.

Roughly one day for 1-6, half a day for 7.

## 10. Out of scope

- **Rate limiting.** A key is a durable credential and deserves a request budget, but that wants
  Cloudflare rate-limiting rules or a Durable Object, not a D1 counter. Separate piece of work.
- **Self-service keys.** Super-only creation to start, matching the existing super-only posture on
  automation `apiCall` authoring. Widen later by granting `api-keys` write, with a rule that a non-super
  may only mint keys owned by themselves.
- **OAuth client credentials / JWT-bearer service accounts.** Static keys first; revisit if a third party
  ever needs delegated access.
- **Key rotation UX.** Create-new-then-revoke-old works without extra machinery. Add a rotate verb only if
  it is asked for.

---

## What changed during implementation

Six things the plan did not anticipate, or got slightly wrong.

1. **Two rules a scope cannot express, so the service enforces them.** A key may not mint another key (a
   narrow key with write on `api-keys` could otherwise mint an unrestricted one for its own owner and walk
   out of its ceiling), and only a super admin may mint a key owned by someone else ("give me a key that
   acts as the CEO" is the escalation-shaped operation).

2. **View-as is refused in the auth lane, not in `viewAs.ts`.** The key lane returns before
   `resolveViewAs` ever runs, so a guard inside that function would have made `X-View-As` silently
   *ignored* rather than refused - the request would succeed as the key's owner while the caller believed
   they were reading as someone else. The check moved to `authenticateApiKey`, which throws. (The guard in
   `viewAs.ts` stays as defence in depth.)

3. **No transport exemption.** The plan left open whether `search` / `dashboard-summary` / `activity` /
   `batch` should bypass the collection axis. They do not: a collection-scoped key cannot use them at all.
   That also makes the "search leaks out-of-scope rows" failure impossible by construction rather than by
   correct wiring.

4. **`c.executionCtx` throws when absent** rather than returning undefined, so the throttled `last_used_at`
   write cannot be an optional chain. It falls back to settling inline when there is no execution context.

5. **The scope crosses both boundaries in one shape.** `scope_json` stores the same snake_case form the wire
   uses, so there is one external shape and one internal (camelCase) shape, never a third. `parseScope`
   deliberately rejects camelCase, so a typo'd `maxLevel` fails loudly instead of silently producing a
   different scope.

6. **A pre-existing lint failure went away.** The spec had no security declarations at all, which
   `spectral` was flagging on every operation (15 errors, 10 warnings). Declaring the three schemes and a
   top-level `security` block fixed those as a side effect: `npm run api:lint` now exits 0.

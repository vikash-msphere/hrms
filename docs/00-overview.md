# 00 — Overview (architecture & stack)

**Goal:** an internal HRMS for a single organization, hosted entirely on Cloudflare's free tier, with
Google sign-in and a strict AEP resource-oriented JSON API.

## Stack (locked)

| Concern | Choice |
|---|---|
| Compute | Cloudflare Workers (TypeScript, V8 — not WASM) |
| API framework | Hono |
| DB | Cloudflare D1 (SQLite) via Drizzle ORM |
| Validation | Zod (+ @hono/zod-validator) |
| Object storage | Cloudflare R2 (documents + payslip PDFs) |
| Config/cache | D1 + short-TTL in-isolate cache (NO KV) |
| Auth | Google, in one of two modes (below); the Worker resolves the caller on every request |
| API design | AEP (aep.dev); OpenAPI 3.1 source of truth; official `@aep_dev/aep-openapi-linter` |
| PDF | pdf-lib (pure JS) |
| Email | Resend (behind an EmailSender port) |
| Frontend | React + Vite + TypeScript (SPA) |
| Tests | Vitest + @cloudflare/vitest-pool-workers |
| Background work | Cron Triggers + a D1 `jobs` table (NO Queues — paid) |

## Architecture (light Clean Architecture)

Dependencies point inward; the API contract is enforced at a serializer boundary, not in storage.

```
Browser SPA ──HTTPS──> [ Cloudflare Access JWT | Worker's own Google OIDC + session cookie ]
                                   │
                                   ▼
                         Worker (Hono, /v1/*)
   routes  ──>  services  ──>  domain (pure)         lib/http/middleware are adapters
      │             │
      ▼             ▼
   serialize.ts   Drizzle ──> D1            R2 (docs/payslips)     Cron ──> jobs table
```

## Two auth modes (configuration picks one)

- **Access mode (default).** Cloudflare Access fronts the app and the Worker verifies the
  `Cf-Access-Jwt-Assertion` JWT. Requires `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD`. Free for 50 users.
- **Google mode.** Setting `GOOGLE_CLIENT_ID` selects it: the Worker runs its own Google-OIDC sign-in
  (`/auth/login` → `/auth/callback`, JWKS signature + audience + nonce + `email_verified` checks) and
  issues a signed HttpOnly session cookie (`AUTH_SESSION_KEY`, 12h). No per-seat Access cost, and
  `ALLOWED_EMAIL_DOMAINS` becomes the org perimeter, so it is never safe to leave unset.

Either way, identity only says **who**; what they may do is the authz middleware's decision. Machine
callers use API keys, which act as their owning user with a narrowed grant. Setup for both modes is in
`docs/deploy.md` §3.

The same identity check gates the app's own code. Every path except the media reaches the Worker first, and
`src/http/staticSite.ts` serves the shell and the JS/CSS chunks only to a verified session. A signed-out
navigation gets a bare 302 to sign-in and any other request a bare 401, so a signed-out browser never
receives the bundle. The media (fonts, images, pdf.js data) skips the Worker to stay off the daily request
quota, and is guarded by a WAF rule on a shared cookie instead. See `docs/deploy-security.md` §5a.

- **domain/** — pure functions: payroll math, leave, and the **authz engine** (`permissions.ts` matcher
  + decision ladder, `codes.ts` hierarchical-scope matching incl. `ancestorsOf`, `compileGrants.ts`
  grant<->`access_rules` rows, `collections.ts` + `policyValidate.ts` write-time guards, `grants.ts`/
  `manifests.ts` typed policy defaults, `access.ts` list-scope). No I/O, unit-tested.
- **services/** — use cases; orchestrate domain + DB + ports. They make **no access decisions**
  (`test/singleSource.test.ts` fails if one ever does).
- **routes/** — mostly collection *specs*, not handlers: `http/collectionRoute.ts` + `services/crud.ts`
  generate the AEP standard-method lane (list with cursor paging, get, create with `?id`, merge-patch with
  `If-Match`, delete with `?force`, the shared lifecycle verbs, `:restore`) from a spec, so 78 of 106 route
  files carry only what is genuinely their own. Bespoke handlers (payroll, settlements, letters, batch,
  search) validate with Zod → call a service → serialize.
- **http/serialize.ts** — maps DB rows (camelCase, internal `uuid`, `createdAt`) to AEP wire resources
  (`path`, snake_case, `create_time`, `etag`). The DB is never exposed directly.
- **lib/** + **db/** — adapters (crypto, `idCodec` wire tokens, email, R2, cache, Drizzle).

## Access control (the single most important invariant)

**The `authz` middleware is the single source of access control.** No service or route makes an access
decision. Policy is **data** in D1 (`roles`, `grants`, `policy` tables), not code; the engine in `domain/`
only interprets it. Authority is **compiled** to an `access_rules` table: the caller's role grant is
reconstructed from it (cached per role, short TTL) and any per-object exceptions are narrowed by exact
ancestor-code `IN` - the DB only narrows by exact code, never a SQL prefix, and the tested engine is the
sole authority. Everything is **private by default, fail-closed**: an unresolved path, missing grant, or
unset list-scope denies, never opens. List breadth is decided in the middleware (`ctx.scope`) and only
*applied* by a service via `applyScope(...)`, which binds columns and decides nothing. Roles are data too
(`Role = string`, FK to the `roles` table), editable at runtime via the management endpoints
(roles/grants/policy/grant-exceptions) - nothing about who-can-do-what is hardcoded. Full end-to-end
reference: **`docs/authz.md`**.

## Identity (three ids, one on the wire)

- **`uuid`** — compact random internal PK/FK (base32, ~13 chars). Internal only, never serialized.
- **`code`** — hierarchical scope key the middleware matches on (e.g. `04-002-001`). Internal only.
- **wire token** — `idCodec.encode(collection, uuid)`: an opaque, encrypted, tamper-evident ~26-char id,
  the **only** identifier on the wire (in `path` and references). Encode/decode are pure compute, so wire
  ids cost zero DB reads.

## Free-tier guardrails (designed around)

- Cloudflare Access is free for 50 users; past that it is per-seat, which is why Google mode exists.
- No first-party transactional email → Resend (or Brevo / SendGrid / Postmark / Mailgun).
- No KV (its write cap and eventual consistency don't fit); config served from D1 + in-isolate cache.
- No Queues (paid) → async work is a `jobs` table drained by cron and surfaced as AEP Operations.
- 50 subrequests per invocation → DB access is whole-table prefetch plus one atomic `db.batch` write group
  (`src/lib/dbBatch.ts`), never a query per row.
- The one thing the free plan cannot do is CPU: its fixed 10ms cap breaks server-side PDF rendering, so
  payslips, letters, Form 16 and e-sign stamping need Workers Standard (`docs/deploy.md` §0).

The full rationale (KV exclusion, Clean Architecture scope, payroll boundaries) is in
`architecture-decisions.md`.

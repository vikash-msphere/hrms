# 00 — Overview (architecture & stack)

**Goal:** an internal HRMS for a single organization, hosted entirely on Cloudflare's free tier, with
Google login offloaded to Cloudflare Access, and a strict AEP resource-oriented JSON API.

## Stack (locked)

| Concern | Choice |
|---|---|
| Compute | Cloudflare Workers (TypeScript, V8 — not WASM) |
| API framework | Hono |
| DB | Cloudflare D1 (SQLite) via Drizzle ORM |
| Validation | Zod (+ @hono/zod-validator) |
| Object storage | Cloudflare R2 (documents + payslip PDFs) |
| Config/cache | D1 + short-TTL in-isolate cache (NO KV) |
| Auth | Cloudflare Access + Google; the Worker verifies the Access JWT |
| API design | AEP (aep.dev); OpenAPI 3.1 source of truth; official `@aep_dev/aep-openapi-linter` |
| PDF | pdf-lib (pure JS) |
| Email | Resend (behind an EmailSender port) |
| Frontend | React + Vite + TypeScript (SPA) |
| Tests | Vitest + @cloudflare/vitest-pool-workers |
| Background work | Cron Triggers + a D1 `jobs` table (NO Queues — paid) |

## Architecture (light Clean Architecture)

Dependencies point inward; the API contract is enforced at a serializer boundary, not in storage.

```
Browser SPA ──HTTPS──> Cloudflare Access ──Google OIDC──> (signed JWT)
                                   │
                                   ▼
                         Worker (Hono, /v1/*)
   routes  ──>  services  ──>  domain (pure)         lib/http/middleware are adapters
      │             │
      ▼             ▼
   serialize.ts   Drizzle ──> D1            R2 (docs/payslips)     Cron ──> jobs table
```

- **domain/** — pure functions: payroll math, leave, and the **authz engine** (`permissions.ts` matcher
  + decision ladder, `codes.ts` hierarchical-scope matching incl. `ancestorsOf`, `compileGrants.ts`
  grant<->`access_rules` rows, `collections.ts` + `policyValidate.ts` write-time guards, `grants.ts`/
  `manifests.ts` typed policy defaults, `access.ts` list-scope). No I/O, unit-tested.
- **services/** — use cases; orchestrate domain + DB + ports. They make **no access decisions**.
- **routes/** — Hono handlers: validate (Zod) → call service → serialize to an AEP resource.
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

- Cloudflare Access is free for 50 users; beyond that, per-seat or DIY OIDC.
- No first-party transactional email → Resend/SES.
- No KV (its write cap and eventual consistency don't fit); config served from D1 + in-isolate cache.
- No Queues (paid) → async work is a `jobs` table drained by cron and surfaced as AEP Operations.

The full rationale (KV exclusion, Clean Architecture scope, payroll boundaries) is in
`architecture-decisions.md`.

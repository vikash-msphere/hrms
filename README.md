# HRMS Starter Kit

A complete, buildable starter for an internal **HR Management System** on Cloudflare's free tier,
authenticated by Google (via Cloudflare Access), with a strictly **AEP (aep.dev) resource-oriented** API.

This kit is written so a coding model can build the whole system by following the docs **in order**
and filling in the clearly-marked gaps. The load-bearing pieces (auth, field encryption, payroll math,
the API contract) are already written and verified.

## Features

**People**
- Employee directory with profiles, departments, and manager hierarchy.
- Per-employee employment fields: start date and a **probation period** (`probation_end_date`, defaulted from an org setting).
- **Bank details** per employee (bank name, account holder, account number, branch, IFSC/routing code, currency) — stored AES-GCM encrypted; the account number is only ever returned **masked** (`•••• 1234`). Access is the owner (self-service) plus whoever policy grants the sensitive sub-resource (super_admin by default), enforced by the authz middleware.
- **Documents** as two resources — **org-documents** (company-wide) and **personal-documents** (employee-owned) — with file upload (type-aware icons, server-enforced file types). Access is the middleware's code-scoped grant: personal docs are private to the owner; org docs follow the org grant.

**Time off**
- **Leave types** (paid/unpaid, accrual days/year, available-during-probation flag).
- **Leave requests** with an approve / reject / cancel workflow.
- **Prorated monthly leave accrual**: 1/12 of the annual allowance each month, joining month prorated by days worked; restricted types don't accrue or become requestable until probation ends.
- **Leave balances** surfaced on the profile and leave pages.
- **Holiday calendar** with fixed and optional holidays; employees pick from the optional list up to a configurable cap.

**Payroll** (single jurisdiction; no tax engine, no money movement)
- **Pay components** (earnings/deductions, fixed / %-of-base / rate×qty methods).
- **Pay periods** and **payroll runs** with a `DRAFT → REVIEW → APPROVED → LOCKED → PUBLISHED` state machine.
- **Approval authority is policy**: only **super_admin** can approve a run (a grant `deny` on `:approve` for everyone else); locked/published runs are immutable.
- **Payslips** generated as PDFs via a background Operation (LRO) and downloadable by the owner.

**Announcements** with draft/publish.

**Platform**
- **Access control** is the `authz` middleware as the single source: policy is **data** in D1, the tested engine only interprets it (everything private by default, fail-closed, nothing hardcoded). Grants compile to an `access_rules` table (the engine `decide()` is unchanged and remains the sole authority; the DB only narrows by exact code, never a SQL prefix), and policy is managed at runtime via the `roles` / `grants` / `policy` / `grant-exceptions` endpoints (incl. per-object + verb-specific shares/denies).
- **Lifecycle on every record**: soft delete + restore, permanent delete (super_admin only), enable/disable, lock/unlock, draft/publish — surfaced as a single **State** column.
- **Per-user data-table preferences**: column show/hide selector, drag-reorder, resize, page size — saved per user via `/v1/preferences`.
- **Org settings** (`/v1/settings`), **audit log**, AES-GCM field encryption, RFC 9457 errors, cursor pagination.
- **Cron**: nightly leave accrual + reminders (probation ending, document expiry, work anniversaries).
- Contract-first: all routes are defined in `openapi.yaml` (passes the official AEP linter) and exercised behind a **Prism** contract-validation proxy in dev.

## What's in here

```
.
├─ README.md                  <- you are here
├─ openapi.yaml               the API contract — SOURCE OF TRUTH (passes the official AEP linter, zero findings)
├─ docs/
│  ├─ 00-overview.md          architecture + stack + access-control & identity model, condensed
│  ├─ 01-aep-guidelines.md    STRICT resource-oriented API rules (the contract) — read before any route
│  ├─ 02-build-guide.md       build phases (complete) + the NEVER/ALWAYS hard rules + acceptance checks
│  ├─ 03-add-a-resource.md    copy-paste recipe to add a resource (incl. making it middleware-scoped)
│  ├─ 04-testing.md           vitest setup + the current test suite
│  ├─ authz.md                the authorization system end to end (engine, grants, scope, BOLA)
│  └─ architecture-decisions.md   the full "why" (KV, Clean Architecture, payroll scope, etc.)
├─ src/                       the Cloudflare Worker (Hono + Drizzle), TypeScript
│  ├─ env.ts deps.ts index.ts cron.ts
│  ├─ ports/  lib/  http/  middleware/  domain/  services/  routes/  db/
├─ test/                      verified unit tests (payroll math, FSM, crypto)
├─ web/                       React SPA scaffold (key files + how-to)
└─ config files              package.json, tsconfig.json, wrangler.toml, drizzle.config.ts, vitest.config.ts, .spectral.yaml
```

## How a model should use this kit

1. Read the **active trio** - `PLAN.md` + `PROGRESS.md` + `STATE.json` (root) - for the current backlog and
   where to resume (the build + authz work are complete; what remains is docs reconciliation + optional
   follow-ons). Then `docs/00-overview.md` (architecture + access-control + identity), then
   **`docs/01-aep-guidelines.md` in full** (the API rules are strict and non-obvious).
2. `docs/02-build-guide.md` documents the build phases (now complete) and the binding NEVER/ALWAYS rules.
   Do any **[human]** cloud-setup steps by emitting a checklist and waiting.
3. After every change run **`npm run verify`** (api:lint + typecheck + tests); it must pass before moving on.
4. To add a resource, use `docs/03-add-a-resource.md` (including how to make it middleware-scoped - access
   control is never written in services/routes).
5. **Surviving crashes / token limits / compaction:** while a multi-step effort is in flight, keep a
   `PLAN.md`/`PROGRESS.md`/`STATE.json` trio at root - do one small step per commit, run `npm run verify`,
   tick the box, update `STATE.json`, commit; on resume reconcile against `git log` + `npm run verify`
   (reality wins). When the effort completes, archive the trio with a README row.

## Status

**Built & verified:** the OpenAPI contract for all resources (AEP-lint clean); AES-GCM field encryption;
the Access-JWT auth middleware; RFC 9457 error model; pagination cursors; opaque encrypted wire ids
(`idCodec`) + hierarchical scope codes; the **policy-as-data authz middleware** (single source of access
control, fail-closed, BOLA-hardened; authority compiled to `access_rules` + runtime management endpoints - complete); the payroll math + run state machine;
soft-delete/lifecycle; per-user table preferences; prorated leave accrual; all backend resources
(`employees`, `departments`, `leave-types`, `leave-requests`, `leave-balances`, `holidays`,
`announcements`, `pay-components`, `pay-periods`, `payroll-runs`, `payslips`, `org-documents`,
`personal-documents`, `users`, `settings`, `preferences`, `operations`); the cron jobs; and the full React
SPA. `npm run verify` (api:lint + typecheck + tests) is green.

**Remaining (mostly [human] cloud setup):** provision Cloudflare Access (Google IdP), create the D1
database / R2 buckets, and set production secrets. In particular **`FIELD_ENCRYPTION_KEY` must be a
real 32-byte base64 key** (`wrangler secret put FIELD_ENCRYPTION_KEY`) or field encryption will fail.

### Running locally

```
npm install
npm run db:migrate:local           # apply migrations to the local D1
npm run dev        # worker on :8787      (terminal 1)
npm run dev:proxy  # Prism contract proxy on :4010 -> :8787   (terminal 2)
npm run dev:web    # Vite SPA on :5173 -> :4010              (terminal 3)
```

Open the SPA on **:5173** (it proxies through the contract validator on **:4010**; never hit the worker
on :8787 directly). Local auth is faked via `DEV_FAKE_EMAIL` in `.dev.vars`; change it to test roles.

> Scope guard: this builds **compensation & payslips** for a single jurisdiction. It does **not** compute
> statutory tax, move money, or file with authorities — see `docs/architecture-decisions.md`.

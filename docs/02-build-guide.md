# 02 — Build Guide (execute in order)

Follow these phases top to bottom. Tasks are **[model]** (write code/run commands) or **[human]**
(cloud setup you cannot do — emit a checklist and wait). After every step run
`npm run verify` (a single gate = `api:lint` at --fail-severity=warn, then `typecheck`, then `test`); it must pass before continuing.

This kit already contains the contract (`openapi.yaml`), all config, the DB schema, the verified
libraries, and fully-worked `employees`, `departments`, `leave-requests`, `payroll-runs`, `operations`
routes. Your job is to wire the environment, stamp out the remaining resources, finish two cron jobs,
and build the SPA.

> **Status (2026-06):** Phases 0-5 are complete; this guide is the reference for the project's conventions
> and the NEVER/ALWAYS hard rules. The access-control design - the `authz` middleware as the single source,
> with policy stored as data (compiled to `access_rules`) - lives in **`docs/authz.md`**.

## Hard rules

NEVER:
- Put business logic in a route handler or the frontend (it goes in `services/` and `domain/`).
- Store `national_id` / `bank_details` / salary in plaintext — always field-encrypt (`deps.encryptor`).
- Compute statutory tax, move money, or generate bank payment files. Statutory deduction amounts are
  INPUT lines summed like any other; `net = sum(earnings) - sum(deductions)`.
- Edit a payroll run once `LOCKED`/`PUBLISHED`; corrections are new adjusting items in a new run.
- Hardcode payroll approval in a service: approval is **super-only**, expressed as a grant `deny` (policy
  data).
- Put an access check in a service or route, or trust the client: **every** access decision lives in the
  `authz` middleware (single gate, fail-closed, private by default). Lists call `applyScope(ctx.scope)`;
  the middleware decides breadth.
- Use KV, Cloudflare Queues (paid), or any localStorage for auth tokens.
- Add/modify an endpoint without first updating `openapi.yaml` and passing `npm run api:lint`.
- Return an unbounded list, invent non-AEP paths, emit non-RFC-9457 errors, or expose DB-only/`*Enc` fields.
- Put a comma inside an inline `{ }` description in the OpenAPI file (it crashes the linter — see docs/01).

ALWAYS:
- Validate every request with Zod; resolve the caller (Access JWT) before handling any `/v1` request.
- Emit AEP resources via `src/http/serialize.ts` (`path`/`create_time`/`update_time`/`etag`, snake_case;
  the `path` id is the opaque wire token).
- Write an `audit_log` row for every create/update/delete and every payroll run transition.
- Batch heavy work (payslips, big reports) through the `jobs` table + cron (surface as an Operation).

## Phase 0 — Human setup [human]
Emit this checklist and wait for values:
1. `wrangler login`; `wrangler d1 create hrms` (copy `database_id` into `wrangler.toml`); `wrangler r2 bucket create hrms`.
2. A custom domain on Cloudflare (e.g. `hr.yourcompany.com`); not `*.workers.dev`.
3. Google Cloud OAuth client (Web) — used by Cloudflare Access, not our code.
4. Zero Trust → Access: add Google as a login method; create a self-hosted Access app for the hostname;
   policy = allow `@yourcompany.com`; copy the **Application Audience (AUD)** and the **team domain**.
5. Email provider account (Resend/Brevo/SendGrid/Postmark/Mailgun) → API key + verified `From`.
6. Generate the field key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
7. Set secrets: `wrangler secret put CF_ACCESS_AUD`, `... FIELD_ENCRYPTION_KEY`, `... EMAIL_API_KEY`.
   Put `CF_ACCESS_TEAM_DOMAIN`, `EMAIL_PROVIDER` and `EMAIL_FROM` as `[vars]` in `wrangler.toml`. For local dev, copy
   `.dev.vars.example` to `.dev.vars` and set `DEV_FAKE_EMAIL` (LOCAL ONLY).

## Phase 1 — Boot [model]
1. `git init && git add -A && git commit -m "kit baseline"` — REQUIRED: the resume/progress protocol (`PROGRESS.md` + `STATE.json` reconciled against `git log`) and the pre-commit hook depend on a git history.
2. `npm install` (its `prepare` script installs the Husky pre-commit hook).
3. `npm run api:lint` (the shipped spec passes at warn severity).
4. `npm run api:types` (generates `src/http/openapi.d.ts`).
5. `npm run db:generate` then `npm run db:migrate:local`.
6. `npm run verify` (lint at --fail-severity=warn, typecheck, the two domain/crypto tests) — must pass.
7. `npm run dev`; hit `/v1/users/me` (with `DEV_FAKE_EMAIL` set) → returns your user record.
8. Bootstrap the first admin once the user row exists:
   `wrangler d1 execute hrms --remote --command "UPDATE users SET role='super_admin' WHERE email='you@yourcompany.com'"`.
✅ `git` history exists; `npm run verify` green; `/v1/users/me` works; employees/departments/leave-requests/payroll-runs respond.

## Phase 2 — Stamp out remaining resources [model]
Using `docs/03-add-a-resource.md`, create these (the contract + serializers already exist):
- Simple (copy `departments`): `holidays`, `announcements`, `leave-types`, `pay-components`, `pay-periods`.
- File (copy `departments` + add R2 + `:download`): `documents`, `payslips` (payslips: list/get/`:preview`/`:download` only).
Mount each in `src/index.ts`.
✅ Each new collection: List paginated, CRUD works, non-admin gets a 403 problem, `api:lint` clean.

## Phase 3 — Finish cron [model]
In `src/cron.ts`: implement `accrueLeave` (monthly `accrualDaysPerYear/12` per active employee) and
`sendReminders` (probation-end, `documents.expireTime`, anniversaries → `deps.email.send`).
✅ A manual invocation updates balances and (in dev) attempts a send.

## Phase 4 — Frontend [model]
Build the SPA from `web/` (scaffold + key files). Role-aware nav; pages per resource following the
Directory example. The SPA stores no token; on 401 redirect to `/` (Access re-challenges).
✅ Login works end to end; directory lists employees; create/update via the API.

## Phase 5 — Harden / ship [model + human]
- [human] Add a Cloudflare WAF rate-limit rule on `/v1/*` (e.g. 600 req/min/IP).
- Confirm D1 Time Travel; schedule `wrangler d1 export` to R2 for long-term backups.
- `npm run deploy`.

## Definition of Done
- [ ] `npm run verify` green (lint fails on warnings, typecheck, tests); deploys.
- [ ] Whole app behind Access + Google; Worker verifies the Access JWT on every `/v1` request.
- [ ] All resources present; List paginated; Update merge-patch; errors RFC 9457; mutations honor If-Match.
- [ ] `national_id`/`bank_details`/salary encrypted; never serialized or logged.
- [ ] Payroll: approval super-only (grant `deny`); LOCKED/PUBLISHED immutable; payslips via Operation;
      employees see only their own (middleware scope).
- [ ] No KV, no Queues, no client-stored tokens; CSRF header required; rate limit configured.

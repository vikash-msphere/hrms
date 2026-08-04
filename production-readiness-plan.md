# Production-readiness plan

Punch list from a 6-dimension audit (security, robustness, correctness/data-integrity, ops/deploy,
tests, web). Ranked by launch risk. `file:line` refs verified against source at audit time.

## Status: ALL P0/P1/P2 items implemented ✅

`npm run verify` green — spectral lint (0 errors/warnings), tsc clean, **594 tests pass** (incl. 3 new:
deleteRun release-on-delete, leave no-overdraw, HTTP auth→authz→wire-id). `wrangler deploy --dry-run`
clean. Migrations re-squashed to a single file. Remaining launch tasks are OPERATIONAL, not code:
create the staging D1/R2 and set `database_id`; put production secrets (incl. optional `ESIGN_SIGNYU_*`);
add the Cloudflare WAF rate-limit rules (documented in `docs/deploy-security.md §1`); wire the scheduled
D1 export cron in CI (documented in `docs/deploy.md`).

## Meta-finding: no transactions anywhere

There are **zero** `db.batch()` calls or transactions in `src/`. Every multi-row write is a sequence
of independent writes with no rollback. This is the root cause behind most P1 data-integrity bugs
below. Decide up front whether to add a batch-write helper (D1 `db.batch([...])` for atomic groups +
a conditional-update convention: `UPDATE ... WHERE status=<expected>`, treat 0 rows affected as
already-done) before patching these one by one — the individual fixes all lean on that pattern.

---

## P0 — DONE

- [x] **E2E suite dead.** `test/workflowsE2E.test.ts:6` imported `0000_outgoing_stick.sql?raw`, which
  the migration squash removed → whole `npm test` / `verify` / `precommit` went red. Fixed: the suite
  now globs `../src/db/migrations/*.sql` (sorted, concatenated), so squashing/renaming/adding
  migrations can never break it again. Verified: 11 E2E scenarios pass.

---

## P1 — fix before launch

### Money / data integrity (irreversible payouts)

All four share one fix pattern: guard the state-transition write with a conditional
`UPDATE ... WHERE status=<expected>`, treat 0 rows affected as already-done, and batch the related
writes so a crash can't leave a half-applied payout.

- [ ] **payroll.ts:360 `deleteRun`** — resets only reimbursements; leaves bonuses, encashments,
  loans, overtime, and comp arrears stamped `paidRunId=<deleted-run>` → never repaid (employee
  underpaid; encashed leave already debited and lost). Worse, `loan_repayments.runId` is a NOT-NULL FK
  to `payrollRuns` with no cascade → the delete FK-fails or orphans ledger rows. Fix: call every
  `reset*PaidByRun` (encashments, bonuses, loans, overtime, arrears) that `buildRunItems` applies,
  before deleting the run.
- [ ] **referrals.ts:117 `awardOne`** (+ bonuses.ts:38) — not idempotent across cron retries:
  `recordBonus` inserts a bonus row (no dedup key) then flips the referral to `eligible`. Crash
  between the two → status stays `pending` → next daily cron re-awards → **duplicate bonus paid**.
  `awardReferralBonuses` swallows per-row errors, widening the window. Fix: conditional status flip
  guarded on `bonusStatus='pending'`, or dedup bonuses by referral key.
- [ ] **cron.ts:193 `carryForwardLeave`** — creates an APPROVED auto-encashment, then stamps
  balance + `lastCarryForwardYear` as a separate write. Crash between → un-stamped for `year` → next
  run rolls over again → **duplicate auto-encashment payout**. Fix: stamp year atomically with (or
  before) creating the encashment, or dedup auto-encashments by (employee, type, year).
- [ ] **ats.ts:555 `acceptOffer`** — check-then-write with 4 sequential unguarded writes
  (createEmployee → application → referral → offer). Concurrent/double accept both pass the
  `extended→accepted` check → two `createEmployee` calls; partial failure leaves an employee created
  but the offer still `extended` and application not `hired`, no rollback. Fix: guard the offer UPDATE
  with `WHERE status='extended'`, treat 0 rows as already-accepted, batch the writes.

### E-sign integration (new external-call surface)

- [ ] **signyu.ts:41,69,102** — the three vendor `fetch` calls (createRequest, getStatus,
  fetchSignedPdf) have no timeout / `AbortSignal`. A hung or slow SignYu endpoint holds the Worker
  request open and burns the subrequest/CPU budget; `letterGenerate` blocks on it synchronously. Fix:
  `signal: AbortSignal.timeout(10_000)` on each fetch, try/catch → clean `failedPrecondition`/502.
- [ ] **callback.ts:18 + signyu.ts:40** — silent data-integrity failure: `fetchSignedPdf` returns
  `undefined` on any non-OK response, but `parseWebhook`/`getStatus` still return `status:"signed"`.
  `applyEsignEvent` then sets `signedTime`/`esignSignedAt`/`locked=true` while writing the PDF only
  `if (evt.signedPdf)` — so the document is marked signed and locked while R2 still holds the
  **unsigned** bytes. Fix: treat `signed` with no `signedPdf` as an error; leave pending so the poll
  fallback (`refreshEsign`) retries.
- [ ] **letterGenerate.ts:59-100** — the personal-document row is created and the PDF written to R2
  before `provider.createRequest`. If the vendor call throws, the `update` at :96 never runs → orphan
  LETTER document with no esign fields, no rollback. Fix: call `createRequest` before creating the
  row, or delete/mark-failed the row in a catch.

### Ops / observability (blind in prod)

- [ ] **wrangler.toml** — no `[observability]` block → Workers Logs not persisted → every
  `console.error(... non-fatal)` is only visible in live `wrangler tail` and otherwise lost. Add
  `[observability]\nenabled = true`.
- [ ] **errorHandler.ts:6** — unhandled (non-`AppError`/non-Zod) errors map to a generic 500 but are
  never logged. Combined with no observability, a 500 leaves zero trace. Fix: `console.error(err)`
  with `c.req.method`/`path` before returning the problem body.
- [ ] **deps.ts:35 / env.ts** — no startup/secret validation. A missing or non-32-byte
  `FIELD_ENCRYPTION_KEY` / `WIRE_ID_KEY` throws a generic per-request 500 deep in crypto. Fix:
  validate required secrets exist and keys decode to 32 bytes in `makeDeps`, fail fast with a clear
  error.
- [ ] **wrangler.toml** — no staging environment; CI deploys `main` straight to prod and runs
  `db:migrate:remote` against the prod D1 with no rehearsal target. Add `[env.staging]` +
  `[env.production]` with separate D1/R2, deploy staging first (or enforce the required-reviewer gate
  the docs mention).
- [ ] **wrangler.toml:7** — `[assets]` uses `not_found_handling = "single-page-application"` with a
  `main` Worker but no `run_worker_first`. SPA fallback can intercept `/v1/*` and `/esign/*` and serve
  `index.html` instead of the Worker (whole API returns the SPA shell). Verify on first deploy (step-10
  smoke test catches it); set `run_worker_first = ["/v1/*", "/esign/*"]`.

### Web

- [ ] **main.tsx:6** — no React ErrorBoundary anywhere. Any uncaught render error in a lazy-loaded
  page white-screens the entire SPA with no recovery. Fix: wrap `<App/>` (and the per-route
  `<Suspense>`) in an ErrorBoundary with a fallback + reload button.

### Tests (money-critical blind spots)

- [ ] No HTTP/integration test drives a real request through the mounted Hono app + authz middleware +
  wire-id edge codec — all coverage is direct domain-fn calls. Runtime wiring (middleware mounted,
  runs before handlers, wire-id decoded at the edge) is unguarded. Add `SELF.fetch`/`app.request`
  route tests.
- [ ] Service-layer untested: `payroll.ts` (run persist / statutory+loan+tax fold / finalize
  idempotency), `settlements.ts`, `leaveEncashments.ts`, `esign/callback.ts` orchestration
  (idempotency on repeat delivery, 400 on bad sig, PDF apply). Domain math is well-tested; assembly +
  persistence are not.

---

## P2 — soon after launch

### Data
- [ ] Money stored as SQLite `REAL` (IEEE-754 float) schema-wide (`principal`, `repaid`, `amount`,
  gross/net/tax, `employeeCost`, leave `balanceDays`, ...). Per-op `round2` mitigates, but aggregates
  summing many rows can drift sub-cent. Consider integer minor units (paise) + fixed-scale days, or
  document + always-round2 aggregate reads.
- [ ] `payrollRunItems` has only `rri_run_idx`, no unique `(runId, employeeId)`. Two concurrent builds
  delete-then-insert → **duplicate line items → doubled totals**. Add `uniqueIndex`, make etag/ifMatch
  mandatory on build.
- [ ] Leave-balance double-spend: balance check and `adjustLeaveBalance` (read-modify-write) are
  separate non-atomic steps (`leaveRequests.ts:117`, `leaveEncashments.ts:209`). Concurrent approvals
  over-draw. Fix: conditional decrement `WHERE balance_days >= days`, fail on 0 rows.
- [ ] `recordLoanRepayment` (loans.ts:125) advances `loans.repaid` but writes no `loan_repayments`
  ledger row → untracked, `resetLoanRepaymentsByRun` can't undo, manual + payroll EMI in one cycle can
  double-count. Fix: write a ledger row (nullable/`manual` runId) for manual repayments.
- [ ] `getSettingValue` (settings.ts:31) and `refreshEsign` (callback.ts:67) do bare `JSON.parse` with
  no try/catch → raw 500 on a malformed blob (wide blast radius — backs esign/tax/letter config). Fix:
  fall back to default on parse failure; route `refreshEsign` through the hardened reader.

### Security (defense-in-depth — core is solid, no P0/P1)
- [ ] No rate limit on the public `/esign/*` webhook (only unauthenticated endpoint). Add a CF
  rate-limit rule.
- [ ] `fetchSignedPdf` (signyu.ts:40) fetches a vendor-supplied `signed_file_url` with no SSRF guard
  (`assertPublicHttpsUrl` exists) and no size cap on `arrayBuffer()`. Vendor is HMAC-trusted so low
  risk, but unbounded.
- [ ] `securityHeaders` is scoped to `/v1/*`; `/esign` webhook responses carry no security headers.
  Apply app-wide or to `/esign/*` too.
- [ ] Webhook has no timestamp/nonce replay protection — a captured valid `signed` delivery can be
  replayed (mitigated, not eliminated, by `signedTime` idempotency). If SignYu sends a timestamp,
  reject stale deliveries.

### Ops
- [ ] No `/healthz` (liveness) / `/readyz` (D1 `SELECT 1`) — everything under `/v1` needs an Access
  JWT, so uptime monitors have nothing to hit. Add unauthenticated health routes.
- [ ] DR is aspirational: docs claim D1 Time Travel + scheduled `wrangler d1 export` to R2, but no
  such export exists (not cron, not CI) and deploy.md has no backup step. Add a real scheduled export
  + a backup/restore section.
- [ ] `cronTrigger.ts:17` runs `runScheduled` synchronously in-request (manual `cron-runs:run`); the
  nightly job iterates all employees and can exceed the request CPU/subrequest budget. Use
  `ctx.waitUntil` / async, return run id immediately.
- [ ] `.dev.vars.example` missing `WIRE_ID_KEY`, `ESIGN_SIGNYU_*`, `ALLOW_DEV_AUTH`; deploy.md step 4
  omits the e-sign secret bootstrap; `makeDeps` always builds `esignSecrets.signyu` with `undefined`
  fields. Fix the example + docs; only populate the `signyu` map when its keys are present.
- [ ] No per-request correlation id (the `trace` field in Deps is workflow-scoped only) — a
  user-reported 500 can't be tied to a log line. Mint a request id in middleware, log + return it.
- [ ] No `[limits] cpu_ms` for CPU-heavy PDF/Form-16 generation.

### Web
- [ ] `useMe.ts:13` `.catch(()=>null)` collapses all `/users/me` failures (500/network/CORS) into
  `null` → renders "Session expired" even when authenticated but the server erred. Only treat true 401
  as unauthenticated.
- [ ] `api.ts:27` (+ :161 `download`) — on 401 hard-redirects `window.location.href="/"` for CF Access
  re-challenge. With no CF Access (local/self-host) → reload loop. Guard the redirect.
- [ ] `Approvals.tsx:282` `(r: any)` on heterogeneous approvables — the one real frontend type hole;
  field renames won't fail tsc. Type as a union of approvable row types.
- [ ] `Schedule.tsx:32`, `LettersTab.tsx:161` read lookup collections via `useCollection` but never
  reference `state`/`error` → selectors render silently empty on fetch failure. Surface the error.
- [ ] Index chunk 542 kB (160 kB gzip) trips Vite's warning (`xlsx`/`native` already lazy-split).
  Optional `manualChunks` for vendor/radix.

---

## Verified solid (no action)

Secrets hygiene (all env/`wrangler secret`, none committed); Aadhaar/PII never logged or persisted;
webhook HMAC-SHA256 + timing-safe compare, verified before any DB read, idempotent apply; authz
fail-closed on every `/v1` route + double-gated dev bypass (`DEV_FAKE_EMAIL` AND `ALLOW_DEV_AUTH`);
Drizzle bound params everywhere (no injection); upload size cap + extension allow-list + SVG refusal;
AES-256-GCM at rest with per-op IV; strict CSP on `/v1` + SPA shell. Cron tick writes `cron_runs`
(running→done/error, stale reclaim, per-subtask catch). Payroll `buildRunItems` *rebuild* is
idempotent (the gap is `deleteRun`). Backend has no stub markers, no console.log, no swallowed
load-bearing errors. Frontend tsc + vite build both pass clean. Strong static drift guards
(`openapiRoutesDrift`, `parity`, `singleSource`, `seedDrift`, `customMethodsDrift`, `wireRegistry`).

---

## Suggested launch gate

P1 only: 4 money atomicity/idempotency bugs + 3 esign robustness fixes + 5 ops-visibility items +
ErrorBoundary + the two test gaps. ~1-2 days. Decide the batch-write-helper direction first — it ties
the money bugs together.

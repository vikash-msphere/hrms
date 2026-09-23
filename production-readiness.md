# Production readiness

The current release-readiness state of the app, and the punch list between this repo and a payroll-ready
instance. This is the file `docs/security-review.md`, `docs/deploy-security.md` and
`docs/architecture-decisions.md` point at for the live posture; the security review itself is an archived
2026-07-04 snapshot, kept for the record of what was found and fixed.

Last verified against the working tree on **2026-09-12**.

## Build gates

| Gate | Result |
|------|--------|
| `npm run test:gate` (vitest + count assertion) | 2791 tests across 236 files, 0 failures |
| `npm run typecheck` | 0 errors (api + web + e2e) |
| `npm run lint` (eslint, `--max-warnings 0`) | 0 issues |
| `npm run api:lint` (spectral) | 0 errors (23 infos) |
| `npm run preflight` | **2 blocking errors** + 5 warnings — see below |
| `npm run build:web` | ok |
| `npm audit --omit=dev` | 0 vulnerabilities (dev toolchain: 9, none critical — see below) |
| migrations | exactly one, `src/db/migrations/0000_*.sql` |

Both preflight ERRORs are the same shape: a deployment-environment fact the repo cannot hold, which the gate
refuses to assume. Not code defects — but they ARE blocking, so they belong on the launch list rather than in
an "all green" table.

- `WAF_RATE_LIMIT_CONFIRMED` — configure the Cloudflare rate-limiting rules (`docs/deploy-security.md` §1) and
  record the date you last checked them. `/auth/*` and the e-sign callback have no limit without it, and
  `/diag` has only the isolate-local floor.
- `HSTS_CONFIRMED` — the app deliberately sends no `Strict-Transport-Security` of its own (see
  `web/public/_headers` for why it cannot), so until HSTS is on at the zone there is no transport pinning
  anywhere. Enable it in Cloudflare (SSL/TLS → Edge Certificates → HSTS) and record the date.

The five warnings are "an optional thing is off, or a value cannot be checked from here": the staging D1
placeholder, no `SENTRY_AUTH_TOKEN` (so no source maps), no `SENTRY_RELEASE`, the SPA reporting a `-dirty`
release because the working tree has uncommitted changes, and no frozen migration yet — the last of those is
harmless until the first production deploy and is discharged by step 7a of `docs/deploy.md`, which runs
`scripts/freezeMigrations.ts` as part of the release. Confirm the income-tax slab vintage against the
financial year you are running before anyone sees a salary annexure — see the launch list below.

## What blocks a launch

None of these are code defects. They are configuration, provisioning and org data — the things a repo cannot
hold. `docs/deploy.md` is the runbook; this is the ordered list, and the order is a real dependency chain.

**Ship the code**

1. Commit the working tree, untracked source included, and clear the strays. `web/web/dist/` in particular
   is a build run from the wrong directory that `.gitignore` does not cover — delete it, do not ignore it.
2. Open a PR to `dev` so `verify.yml` proves a clean `npm ci` and a clean `api:types` regeneration on
   neutral ground. The `e2e` workflow runs on the same push.
3. Create `prod`, the release branch. `deploy.yml` triggers on push to it, and the branch does not exist
   yet: `git checkout -b prod && git push -u origin prod`. A release branch separate from the `dev` trunk
   (rather than retargeting the workflow at `dev`) is what lets production be frozen through a monthly
   payroll cutover while work keeps merging.
4. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repo secrets under a `production` environment
   (scopes: Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit). Both `deploy.yml` and `d1-backup.yml`
   need them. Application secrets stay on the Worker and must not be added to CI.

**Stand up the instance**

5. Decide the production hostname. `wrangler.toml` declares no route, so today the app answers on
   `*.workers.dev`. It is baked into the OAuth redirect URI and into every bookmark, so it comes first.
6. Create the Google OAuth client (redirect `https://<host>/auth/callback`). `ALLOWED_EMAIL_DOMAINS` is
   already set; MFA and device policy are enforced in the Google Workspace admin console.
7. Verify the email sending domain with DKIM and SPF. Unverified, every notification, letter and workflow
   email is rejected at send time while the app looks healthy.
8. Set the six missing Worker secrets — `FIELD_ENCRYPTION_KEY`, `WIRE_ID_KEY`, `AUTH_SESSION_KEY`,
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `EMAIL_API_KEY`. Generate fresh values; never reuse
   `.dev.vars`. Keep `ALLOW_DEV_AUTH` and `DEV_FAKE_EMAIL` unset. **Escrow `FIELD_ENCRYPTION_KEY` outside
   Cloudflare while you are there** — every document body in R2 is encrypted under it, so a backup without
   the key restores nothing.
9. Migrate remote D1, apply `bootstrap/bootstrap.sql`, then grant super to the break-glass identity
   (`docs/deploy.md` §9). The bootstrap is outside CI because it applies exactly once and would collide on
   re-run. Never apply `bootstrap/demo.sql` or `scripts/seed.sql` to production — they create predictable
   accounts.

**Make it your company**

10. Replace the placeholder `organization` settings row. Until it is filled in, every letter, payslip header
    and outbound email carries "Your Company Pvt Ltd" and an empty address. Currency is deliberately
    single-valued, so `INR` has to be right the first time.
11. Grant the `letterheads` collection to HR in Access Management. It ships with zero seeded rules
    (private-by-default), so an HR admin cannot list or design a letterhead and the letterhead picker comes
    back empty for them. Do it as data, not in code. Confirm the same for anything added since the last
    grant sweep.
12. **Confirm the income-tax slabs for the financial year you are running.** `DEFAULT_TAX_FY_START_YEAR` in
    `src/domain/incomeTax.ts` stamps which Budget the loaded table encodes, and `npm run preflight` warns
    when that is behind the current FY. Withholding itself is safe either way — the FY window is derived
    from each payroll period's own dates, never from the stamp — but the RATES applied are the stamped
    year's. Update the slabs and the stamp together, then regenerate `bootstrap.sql`. Confirm the
    professional-tax slabs against the state of registration, and whether employer PF/ESI belongs inside
    CTC, before anyone sees a salary annexure.
13. Load the org: departments and designations, reporting lines, pay grades and salary structures, leave
    balances, live loans, and — for a mid-year go-live — year-to-date earnings and TDS already deducted.
    There is no employee CSV import in the codebase (`batchCreate` is for assets), so budget real time.
14. Rehearse a payroll run end to end against real data and reconcile it by hand: gross, PF, ESI,
    professional tax, TDS, loan recovery, net. Run a full-and-final settlement for one leaver too, since
    the settlement path snapshots its own figures. Editable runs flag themselves stale when inputs change,
    so rebuild after any correction.

## Decisions to take around the launch

Each of these leaves production working but weaker.

- **Workers Standard ($5/mo).** `wrangler.toml` ships `[limits] cpu_ms = 60000`, a paid-plan feature. On
  Free, the fixed 10ms CPU cap breaks every server-side render — payslips, letters, Form 16, e-sign
  stamping — and D1 is capped at 100k reads/day. Preflight reporting `plan=paid` is **not** evidence: it is
  the default `CF_PLAN` value, and the check only asserts that the flag and the `[limits]` block agree.
  Confirm the plan in the dashboard.
- **WAF rate limits.** The code-side limiter is a FLOOR, not the control: `src/lib/isolateRate.ts` counts in
  one isolate's memory, so a caller spread over enough colos gets one allowance per isolate. It covers the
  unauthenticated lanes per route and `/v1` per caller (`src/middleware/rateLimit.ts` — four budgets: PDF
  rendering at 40/min, the cross-collection fan-outs at 120, the batch transport at 6000 sub-reads, and a
  3000 runaway detector over everything else). The limit across the fleet is still the WAF rule.
  `docs/deploy-security.md` §1 carries a table per plan tier; on Free you get one rule, so spend it on
  `/auth/*`.
- **Sentry release wiring.** Set `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` in the deploy
  environment, plus `VITE_APP_VERSION` and a matching `SENTRY_RELEASE`, or the uploaded source maps match
  no event. Then set alert routing, or nobody reads the issues.
- **Staging, or delete the file.** `database_id` in `wrangler.staging.toml` is still
  `REPLACE_WITH_STAGING_D1_ID`, and neither the bucket nor the `hrms-search-staging` index exists. All three
  are free to create, and staging is the only place to rehearse a migration, a restore or a payroll run —
  which matters more now that the migration freeze (`docs/deploy.md` §7a) makes a schema change unrepeatable.
  Deploy it with `npm run deploy:staging`. If it will never be used, delete `wrangler.staging.toml` rather
  than leaving it to fail on first use.
- **Backups: enable R2 versioning on `hrms` and create `hrms-backup`.** D1 is recoverable two ways; without
  those two steps the documents are recoverable zero ways. See `docs/deploy.md` "Backups & disaster
  recovery" — the workflow is written, the buckets and the R2 S3 API token are not.
- **Session recording notice.** The report-a-problem flow records the screen, and error-triggered replay
  uploads the run-up to a crash. Both need a written notice, a retention period and a named viewer list:
  `docs/session-recording-notice.md` has the text and the three open decisions.
- **Zone configuration**, if a custom domain is chosen: DNS record, the route in `wrangler.toml`, HSTS at
  the zone rather than in `_headers`. Confirm no Cloudflare Access application sits in front of the
  hostname — Access is the legacy auth path and would put a second login in front of the Google one.
- **Post-deploy checks.** Confirm the deployed host emits `web/public/_headers`; smoke-test sign-in from a
  fresh profile including an address outside the allowed domain; confirm both cron triggers appear on the
  Worker; verify the Worker's `VAPID_PRIVATE_KEY` actually pairs with the built-in `VITE_VAPID_PUBLIC_KEY`
  (preflight proves the public key is well-formed, not that it matches).
- **Aadhaar e-sign stays off** until it is configured. The app ships with in-app signature signing and no
  external dependency; choosing "Aadhaar e-Sign" without `ESIGN_CASHFREE_CLIENT_ID` /
  `ESIGN_CASHFREE_CLIENT_SECRET` is refused with a precondition naming the missing secrets. The CCA India
  2022 root is pinned, so validity stamps work as shipped.

## Accepted risks, with the mitigation that shipped

- **Money is stored in `real` columns**, not integer paise. 59 float columns, 41 of them currency. Integer
  paise was designed and rejected: it touches every money column, every domain calculation and every money
  test, to close a gap no test or incident has shown. The mitigation is `round2` / `sum2` discipline, and it
  is **enforced** rather than documented — `test/moneyDrift.test.ts` fails on an arithmetic money-column
  write that did not come through `round2`/`sum2`, and on a new `real` column it cannot classify as money or
  not.
- **Sessions are stateless**, 12h TTL, no per-session revocation list. Narrower than it reads: the auth
  middleware loads the `users` row on every request and throws on a non-active status, and re-reads the role
  rules, so disabling a user or demoting them takes effect on their next call. Rotating `AUTH_SESSION_KEY`
  is the blanket "sign everyone out" lever and destroys no data. Written up as the break-glass in
  `docs/deploy-security.md` §3c.
- **The automation dispatch budget is 50 per originating action.** A correct runaway guard; when it trips it
  now writes one `dropped` `automation_runs` row (once per action, naming no rule, because none was loaded),
  so it surfaces in the Workflows UI instead of only in Workers Logs.
- **Automation actions run as the system principal, and `hr_admin` may author rules.** That is the reason
  `apiCall` / `webhook` / `email` / `emailAudience` are super-only to write - authoring one is equivalent to
  holding super. The same gate now covers every act that decides whether such a rule runs: `:enable`,
  `:disable` and delete ask it of the STORED actions, because `bootstrap/bootstrap.sql` ships privileged rules
  disabled on purpose and arming one is not a lesser act than writing it. The hop around it is closed too:
  `emitEvent` is deliberately not privileged, so a rule an hr_admin wrote can relay an event - but that
  relayed event cannot trigger a rule holding a privileged action, because the event would carry a subject the
  relayer chose into a path the privileged rule templates (`POST /v1/{{subject}}:approve` is a shipped seed).
  Trust is a column (`automations.super_authored`), stamped from the author on every write and carried through
  a `wait` / `waitFor` continuation; a refused hop is a `skipped` `automation_runs` row, not a silence.
  Pinned by `test/automationRelayTrust.test.ts`.
- **`/readyz` is unauthenticated and touches D1.** A READY answer is cached in the isolate for 5 seconds, so
  a flood costs one D1 read per isolate per window. A failing probe is deliberately not cached, so an
  outage is still reported on the first call after it starts.
- **No bulk employee import.** Deliberate for a first release: an import that silently mis-maps a salary or
  a reporting line is worse than data entry. It is the main reason step 13 takes real time.

- **Nine `npm audit` advisories, all in the dev toolchain, none in the deployed Worker.**
  `npm audit --omit=dev` is **0 vulnerabilities** — nothing the Worker bundles or the browser downloads is
  affected. What remains is the build and test toolchain, and the critical one is already closed: `vitest` is
  pinned at 3.2.7, past the 3.2.6 that fixes GHSA-5xrq-8626-4rwp (arbitrary file read and execution while the
  `vitest --ui` server is listening), which also cleared the two nested-`wrangler` advisories. Until then,
  `npm run test:e2e:ui` / `vitest --ui` was a live local file-read surface for anyone who could reach the port.

  The rest need a major move the harness does not currently survive, so they are carried rather than fixed:

  | Advisory | Fix requires | Why it is carried |
  |---|---|---|
  | `@vitest/mocker` path traversal (moderate) | `vitest` ≥ 4.1.11 | vitest 4 needs `@cloudflare/vitest-pool-workers` ≥ 0.22, which **removes `isolatedStorage`**. Every file in `test/` applies the migrations in its own `beforeAll` and needs a fresh D1 per file; without it the second file dies on `table access_rules already exists`. Measured: 161 of 2791 tests fail across 17 files. Reworking how all 236 files obtain a database is its own change, with its own verified pass. |
  | `vite` path traversal / `fs.deny` bypass (high), `esbuild` (moderate) | `vite` ≥ 7 | Needs `@vitejs/plugin-react` 5 and a Node floor of 20.19+. Both are dev-server-only issues: they need an attacker able to reach `vite dev`, which is never exposed — production is static assets served by Cloudflare from `web/dist`. |
  | `@esbuild-kit/*` via `drizzle-kit` (moderate) | `drizzle-kit` ≥ 0.31 | Only ever run by hand for `db:generate`. A major bump there can change generated migration SQL, and this repo keeps exactly one frozen migration — so it is done deliberately, alongside a regeneration diff, not as an audit sweep. |

  Nothing here is a reason to hold a launch; all of it is a reason not to run a dev server or `vitest --ui` on
  an untrusted network. Re-check with `npm audit --omit=dev` (must stay at zero) before each release.

## Where the detail lives

- `docs/deploy.md` — the numbered runbook, environment reference, CI wiring, backups and recovery.
- `docs/deploy-security.md` — WAF tables per plan tier, secrets and rotation, the session break-glass, CSP,
  telemetry, the e-sign trust store.
- `docs/session-recording-notice.md` — the employee notice for screen recording, and what to decide first.
- `docs/security-review.md` — the archived 2026-07-04 review and its remediation ledger.
- `client-storage.md` — what the SPA keeps in the browser, what makes a stored copy trustworthy, and what is
  purged when. Relevant to a launch on two counts: it is the app's data-at-rest surface outside the org's
  control, and conditional revalidation is what keeps a session inside the free plan's read budget.
- `scripts/preflight.ts` — the pre-deploy gate itself, and why each check exists.
- `bootstrap/bootstrap.sql` — exactly what a fresh production database starts with.

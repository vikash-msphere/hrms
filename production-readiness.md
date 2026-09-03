# Production readiness

The current release-readiness state of the app, and the punch list between this repo and a payroll-ready
instance. This is the file `docs/security-review.md`, `docs/deploy-security.md` and
`docs/architecture-decisions.md` point at for the live posture; the security review itself is an archived
2026-07-04 snapshot, kept for the record of what was found and fixed.

Last verified against the working tree on **2026-09-03**.

## Build gates

All green, run locally on the working tree:

| Gate | Result |
|------|--------|
| `npm test` (vitest) | 2139 tests across 177 files, 0 failures |
| `npm run typecheck` | 0 errors (api + web + e2e) |
| `npm run api:lint` (spectral) | 0 errors |
| `npm run preflight` | ok, 4 warnings (all deliberate — see below) |
| `npm run build:web` | ok |
| migrations | exactly one, `src/db/migrations/0000_*.sql` |

The four preflight warnings are all "an optional thing is off, or a value cannot be checked from here":
the staging D1 placeholder, no `SENTRY_AUTH_TOKEN` (so no source maps), no `VITE_APP_VERSION` (so no Sentry
release), and the income-tax slab vintage being a year behind the current financial year. The last one is a
launch item, below.

## What blocks a launch

None of these are code defects. They are configuration, provisioning and org data — the things a repo cannot
hold. `docs/deploy.md` is the runbook; this is the ordered list, and the order is a real dependency chain.

**Ship the code**

1. Commit the working tree, untracked source included, and clear the strays. `web/web/dist/` in particular
   is a build run from the wrong directory that `.gitignore` does not cover — delete it, do not ignore it.
2. Open a PR to `dev` so `verify.yml` proves a clean `npm ci` and a clean `api:types` regeneration on
   neutral ground. The `e2e` workflow runs on the same push.
3. Create `main`. `deploy.yml` triggers on push to `main`, and the branch does not exist yet. A release
   branch (rather than retargeting the workflow at `dev`) is what lets production be frozen through a
   monthly payroll cutover while work keeps merging.
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
- **WAF rate limits.** There is no code-side limiter. `docs/deploy-security.md` §1 carries a table per plan
  tier; on Free you get one rule, so spend it on `/auth/*`.
- **Sentry release wiring.** Set `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` in the deploy
  environment, plus `VITE_APP_VERSION` and a matching `SENTRY_RELEASE`, or the uploaded source maps match
  no event. Then set alert routing, or nobody reads the issues.
- **Staging, or delete the env block.** `env.staging.database_id` is still `REPLACE_WITH_STAGING_D1_ID` and
  the bucket does not exist. Both are free to create, and staging is the only place to rehearse a migration,
  a restore or a payroll run. If it will never be used, delete the `[env.staging]` blocks rather than
  leaving them to fail on first use.
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
- **`/readyz` is unauthenticated and touches D1.** A READY answer is cached in the isolate for 5 seconds, so
  a flood costs one D1 read per isolate per window. A failing probe is deliberately not cached, so an
  outage is still reported on the first call after it starts.
- **No bulk employee import.** Deliberate for a first release: an import that silently mis-maps a salary or
  a reporting line is worse than data entry. It is the main reason step 13 takes real time.

## Where the detail lives

- `docs/deploy.md` — the numbered runbook, environment reference, CI wiring, backups and recovery.
- `docs/deploy-security.md` — WAF tables per plan tier, secrets and rotation, the session break-glass, CSP,
  telemetry, the e-sign trust store.
- `docs/session-recording-notice.md` — the employee notice for screen recording, and what to decide first.
- `docs/security-review.md` — the archived 2026-07-04 review and its remediation ledger.
- `scripts/preflight.ts` — the pre-deploy gate itself, and why each check exists.
- `bootstrap/bootstrap.sql` — exactly what a fresh production database starts with.

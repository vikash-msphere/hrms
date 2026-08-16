# Production readiness check

Audit run on 2026-08-14 against the working tree of `feat/collection-factory` (local `dev` = `f8d9c2a`).
Everything below was verified by running the gates and reading the code, not inferred from docs.

## Gates: all green

| Gate | Result |
| --- | --- |
| `npm run test` | exit 0, 110 files, 1252 passed |
| `npm run typecheck` | exit 0 (`api:types` + root `tsc` + web `tsc`) |
| `npm run api:lint` | exit 0, 0 errors / 0 warnings (11 `information` hints on optional request bodies) |
| `npm run build:web` | exit 0, built in 5.5s |

Re-run green after the fixes in items 4, 5 and 7 below.

Note: the first test run failed with `EPERM open '/Users/vikash/git/hrms/.dev.vars'`. That is the local
command sandbox denying the file, not a suite failure. Unsandboxed it is green.

## Security posture: solid

Verified directly, no gaps found:

- Authz is one fail-closed middleware on `/v1/*` (`src/index.ts:162`); null / error / unmatched deny.
- CSRF: `X-Requested-By` required on every mutation, API-key bearers exempt, and the exemption is
  sound only because auth never falls back from bearer to cookie. Both rules documented as one mechanism
  (`src/middleware/csrf.ts`).
- Response headers on `/v1/*`, `/auth/*`, `/esign/*` and `/found/*`; SPA shell CSP in `web/public/_headers`
  with no remote origin anywhere in the policy (fonts are self-hosted).
- Errors are RFC 9457 problem+json with no stack or field-path leakage; 5xx logged with a request id
  (`src/middleware/errorHandler.ts`), `[observability]` on so the log survives.
- PII encrypted at rest under `FIELD_ENCRYPTION_KEY`: national id, bank details, tax declarations,
  personal / identity details, and every R2 document body (`src/lib/docstore.ts`).
- API keys stored as HMAC verifiers under an HKDF-derived subkey, never the raw secret.
- Session cookie is `HttpOnly` + `Secure` + `SameSite=Lax`, 12h TTL; OAuth nonce ties the id token to the
  browser that started the login.
- Dev auth bypass needs BOTH `DEV_FAKE_EMAIL` and `ALLOW_DEV_AUTH=true`; `ALLOWED_EMAIL_DOMAINS` is
  fail-closed and `makeDeps` refuses to boot Google mode without it.
- No SQL injection surface. The one `sql.raw` over a list (`src/services/globalSearch.ts:51`) interpolates
  registry-derived collection names, and the FTS match expression is stripped to letters and digits.
- `/healthz` (liveness) and `/readyz` (D1 ping) are unauthenticated probes.
- DR: nightly `d1-backup.yml` exports D1 to R2 plus a 30-day GitHub artifact, on top of D1 Time Travel.

## Blockers

### 1. The production deploy pipeline never fires

`.github/workflows/deploy.yml` triggers on `push: branches: [main]`. There is no `main` branch: local
branches are `dev` and `feat/collection-factory`, and `git ls-remote --heads origin` returns only
`refs/heads/dev`. As configured, nothing ever deploys.

Fix: point the trigger at the real trunk, or create `main` as the release branch.

### 2. CI has never seen the current code

`origin/dev` is at `b12d009`; local `dev` is at `f8d9c2a`, 316 files changed. Every gate above ran on this
machine only. Push and let `verify.yml` confirm it on a clean `npm ci` before treating the suite as a
release gate.

### 3. Unmerged work in the tree

5 modified files plus untracked `web/src/lib/ticketWorkflow.ts` and `test/ticketWorkflowDrift.test.ts` sit
on `feat/collection-factory`. Tests are green with them in the tree; they are not on `dev`.

### 4. 5.1 MB render-blocking stylesheet - FIXED

`web/dist/assets/index-*.css` was 5,378,377 bytes (345 KB gzipped) across 48,723 rules. Cause was the
colour-pattern safelist in `web/tailwind.config.js`, which reads like ~1k utilities but is not: Tailwind
expands a safelisted colour across every opacity step as well, so each family x prefix produced 242 rules
(11 shades x 22 opacity steps), doubled again by `variants: ["dark"]`.

Nothing needed it. `KudosCardBody` / `PostCardBody` are React components the scanner already reads, rich
text renders to React nodes rather than an HTML string (no `dangerouslySetInnerHTML` anywhere in the app,
see `web/src/lib/richText.tsx`), no seed or settings blob carries a Tailwind class, and no card-template
entity exists in the schema at all. The one place that builds class names by interpolation,
`web/src/lib/notificationMeta.tsx`, already keeps them scannable with its own literal `_KEEP` string.

Removed the pattern, kept the small explicit list. **5,378,377 bytes to 104 KB (18.6 KB gzipped)**, a 50x
cut, with the interpolated notification-chip classes (including the non-standard `/15` opacity step and the
`dark:` pair) and the kudos-card decoration utilities all verified still present in the rebuilt CSS.

### 5. A 7.6 MB zip ships in the deployed bundle - FIXED

`web/public/assets/illustrations.zip` was gitignored but present on disk, so Vite copied it to
`web/dist/assets/illustrations.zip`, uploaded and publicly downloadable on top of the 25 MB of
already-extracted illustrations. Moved out of `web/public` (nothing in the build, app or scripts referenced
it), and `.gitignore` now records why it must not go back there.

With item 4, the deployed bundle drops from 52 MB to 38 MB.

### 6. Plan tier contradiction, and it breaks PDFs

`docs/deploy-security.md` §1 states "This deployment is on the Cloudflare Free plan", while `wrangler.toml`
ships `[limits] cpu_ms = 60000`, which is a Workers Standard (paid) feature. On the free plan the fixed
10 ms CPU cap breaks server-side PDF generation, which is payslips, letters, Form-16 and e-sign stamping,
all core features (documented at `docs/deploy.md:11-16`).

Resolve before launch: pay for Workers Standard (the docs' own recommendation, $5/mo), or accept losing
PDF generation and comment out `[limits]`.

## Should fix

### 7. Nine nightly cron subtasks swallow their errors - FIXED

`src/cron.ts` defines `bestEffort()` at line 73 precisely so a failure "must also not vanish - a silently
failing bonus award or e-sign reconcile is money/documents stuck with no trace". Lines 91-109 then used a
bare `.catch(() => 0)` with no log for `generateComplianceOccurrences`, `awardReferralBonuses`,
`sendReminders`, `emitScheduledEvents`, `runScheduledAutomations`, `flushDigests`,
`generateRecurringExpenses`, `checkBudgetThresholds` and `reconcilePendingEsign`. Four of those move money
or documents.

All nine now go through `bestEffort`, so a failure keeps the tick alive and lands in Workers Logs named.

### 8. A throw in accrual takes the whole nightly tick with it - FIXED

`carryForwardLeave` and `accrueLeave` were unwrapped, so a failure there skipped the 12 subtasks after them.

Both now go through the same best-effort runner as the rest, and the loudness moved somewhere better than an
abort: the runner records the name of every failed subtask, and `finishCronRun` stamps the `cron_runs` row
`error` listing them instead of `done` with a zero count. A failed accrual is now a red row on the Operations
page (which already renders a `StatusBadge` from it) rather than a green one that quietly did nothing. The
runner is per-tick state, so a manual trigger overlapping the schedule cannot borrow the other's failures.

### 9. Errored jobs are never retried and never alert - FIXED

`drainJobs` selects only `status = "queued"` plus stale `running` rows, and `processOneJob` parked a failure
at `status = "error"` on the FIRST error, where nothing picked it up again. A transient D1 blip during
payslip generation left that run's payslips undelivered until a human noticed and called `operations:run`.

`processOneJob` now requeues while attempts remain (backoff 1m / 5m / 15m / 60m, capped at 5 attempts) and
parks at `error` only at the cap - that terminal state is the dead letter, already listed on the Operations
page with a Retry button, so a human keeps the last word. The delay rides the existing `jobs.run_after`
column that the drain already honours, so there is no new column and no new query. Terminal failure of a job
someone is waiting on (`payslip.generateRun`) notifies its owner; engine-internal kinds
(`automation.action`, `workflow.timer`) deliberately do not, since the employee a rule happens to be about is
not the person who can fix a broken rule.

One bug found while writing this: the payslip LRO's self-requeue did not clear `run_after`, so a run that
failed once and then resumed normally would have inherited the hour-long backoff. It now clears it.

`test/jobQueue.test.ts` covers the retry ladder, the cap, the drain honouring `run_after`, who gets notified,
and a failed nightly subtask turning its run red while the rest of the tick continues.

### 10. Staging cannot be deployed

`wrangler.toml` still has `database_id = "REPLACE_WITH_STAGING_D1_ID"` under `[[env.staging.d1_databases]]`.
Needs `wrangler d1 create hrms-staging` + `r2 bucket create hrms-staging`, then the id filled in. Without
it there is no target to rehearse migrations or a restore against, which the DR section of `docs/deploy.md`
assumes exists.

### 11. R2 documents have no automated backup

Only D1 is exported nightly. `docs/deploy.md` says documents "should likewise be covered by R2 bucket
versioning / lifecycle rules", which is aspirational, not configured. Signed letters, payslip PDFs and
uploaded identity documents currently have one copy. Turn on R2 versioning, or extend `d1-backup.yml` to
sync `DOCS`.

### 12. Rate limiting exists only as a runbook step

There is no code-side limiter anywhere. `docs/deploy-security.md` §1 specifies the WAF rules to create by
hand, and on the free plan only ONE rule is available. Unauthenticated surfaces that need it: `/auth/*`,
`/found/*`, `/esign/*`, `/healthz`, `/readyz`. Configure it in the dashboard before launch and record that
it is done.

## Accepted risks, no action required

- **Money stored as `real`.** 55 float columns; the mitigation is `round2` / `sum2` discipline at 160 call
  sites across 21 files, stated as the monetary invariant at `src/db/schema.ts:6`. Phase 3 of
  `pre-prod-review.md` (integer paise / centidays) is still open, and what shipped is the harden-only
  alternative that the plan text says was rejected. The discipline is documented but not enforced by a
  test; a drift test asserting no money write bypasses `round2` would close the gap cheaply.
- **Stateless sessions.** No per-session revocation list, so a stolen cookie stays valid for up to 12h.
  Narrower than it first looks: `auth.ts` loads the user row on every request and throws on
  `status !== "active"` (`auth.ts:98`), and re-reads the role grant, so disabling a user or changing their
  role takes effect on the next call. Rotating `AUTH_SESSION_KEY` is the blanket break-glass, and the runbook
  already says so.
- **Automation dispatch cap.** `MAX_TOTAL_DISPATCHES = 50` per request drops further events with a
  `console.warn` (`src/services/automationEngine.ts:41`). Correct as a runaway guard; invisible to the user
  if it ever trips in earnest.

## Verdict

The application itself is production ready: gates green, security controls real and fail-closed, DR for the
database automated, 1244 tests including drift tripwires for the registries that would otherwise rot.

Fixed in this pass: items 4, 5, 7, 8 and 9. The deployed bundle lost 14 MB (a 50x smaller stylesheet plus the
stray zip), the nightly tick can no longer lose a money-moving subtask in silence or report a failed one as
success, and a failed background job now retries into a visible dead letter instead of dying on its first
error.

What remains is the release path, and none of it is code. Items 1, 2, 3 and 6 must be settled before a first
deploy, because nothing currently deploys, CI has not validated the code, and the plan tier decides whether
PDF generation works at all. Items 10 through 12 are the ops configuration that turns a working deploy into
an operable one.

## Changed in this pass

- `src/cron.ts` - every nightly subtask (including carry-forward and accrual) runs through a per-tick
  best-effort runner that records failures; `finishCronRun` marks the `cron_runs` row `error` naming them.
  Job failures retry with backoff to a 5-attempt cap, park terminal as a dead letter, notify the owner of a
  user-facing job, and no longer leave a stale `run_after` on a healthy LRO resume.
- `test/jobQueue.test.ts` - new, 8 cases over the retry ladder, the cap, `run_after`, notification audience
  and the red nightly run.
- `web/tailwind.config.js` - colour-pattern safelist removed, with the reasoning kept in place.
- `web/public/assets/illustrations.zip` - moved out of the published directory.
- `.gitignore` - records why the zip must stay out of `web/public`.

## Recommendations for what is left

One recommendation per open item, decided rather than optioned. Effort estimates are for one person.

### 1. Make `main` the release branch, keep `dev` as integration (5 min)

`deploy.yml` already points at `main`; the missing piece is the branch. Create it and deploy from it, rather
than retargeting the workflow at `dev`.

```bash
git checkout -b main && git push -u origin main
```

Reason to prefer this over single-trunk for THIS app: payroll has monthly high-stakes cutovers. A release
branch lets you keep merging work into `dev` while production is frozen mid-run, which single-trunk cannot
express. `verify.yml` already runs on every push and PR, so `dev` stays gated either way.

### 2. Push behind a PR, not straight to the trunk (15 min)

316 files have never been through `npm ci` on a clean machine. Open `feat/collection-factory` as a PR to
`dev` so `verify.yml` runs on neutral ground before the trunk moves. The secrets question is already handled -
`vitest.config.ts` injects test-only bindings precisely because CI has no `.dev.vars` - so what is being
proven here is a clean install and a clean `api:types` regeneration, not the environment.

### 3. Land the working tree as one commit, and deal with the loose root files (20 min)

The 5 modified files plus `web/src/lib/ticketWorkflow.ts` and `test/ticketWorkflowDrift.test.ts` are one
coherent change (ticket workflow moved behind a drift-tested module) - commit them together.

Separately, `logo.svg`, `logo.png`, `logo-dark.svg`, `logo-light.svg`, `ms-logo-dark.svg`, `ms-logo-light.svg`
are untracked at the repo root. Brand assets belong under `web/public/assets` (where the app can serve them)
or in `misc/` (already gitignored). Do not leave them loose at the root, where the next `git add -A` commits
6 binaries nobody meant to ship. `.mcp.json` is local tool wiring: gitignore it unless the whole team wants
the same MCP servers.

### 4. Pay for Workers Standard, then fix the docs that assume Free (10 min, $5/mo)

This is the single highest-value decision left. On Free, the fixed 10 ms CPU cap breaks every server-side PDF
path - payslips, letters, Form-16, e-sign stamping - which is a large share of what an HRMS is FOR. Free also
caps D1 at 100k reads/day, which a real org will cross.

After upgrading: `[limits] cpu_ms = 60000` in `wrangler.toml` applies as written (no change needed), and
`docs/deploy-security.md` §1 must lose the "This deployment is on the Cloudflare Free plan" premise. That
section currently designs around the free WAF's one-rule limit; on paid you can implement its full table.

### 5. Make a failed nightly subtask turn the run red - DONE

Implemented; see item 8 above.

### 6. Retry errored jobs with backoff; terminal failures are the dead letter - DONE

Implemented; see item 9 above.

### 7. Create the staging D1 + R2, or delete the staging env (30 min, free)

Create it. Both resources are free, and it is the only place to rehearse a migration or a restore, which the
DR section of `docs/deploy.md` already assumes exists.

```bash
npx wrangler d1 create hrms-staging      # paste the id over REPLACE_WITH_STAGING_D1_ID
npx wrangler r2 bucket create hrms-staging
```

If you decide you will never use it, delete the `[env.staging]` blocks instead. A half-configured environment
that fails on first use is worse than no environment.

### 8. Back up R2, and treat it as higher priority than its number suggests (1 h)

D1 is recoverable two ways; documents are recoverable zero ways. A generated payslip can be rebuilt, but a
signed letter carrying an employee's e-signature and an uploaded identity document cannot - if an object is
deleted or overwritten, it is gone. Enable R2 object versioning on the `hrms` bucket now (dashboard, 5 min),
then add a weekly object sync into a separate `hrms-backup` bucket alongside `d1-backup.yml`. Note that
document bodies are encrypted at rest under `FIELD_ENCRYPTION_KEY`, so the backup is only as recoverable as
that secret: store it where it survives the loss of the Cloudflare account.

### 9. Configure the WAF rate limit before the first real user (15 min)

There is no code-side limiter, so until a rule exists every unauthenticated path is unmetered. On Free you
get one rule: spend it on `/auth/*` at ~20 requests / 10s per IP (that is the path that mints sessions). On
paid, implement the full table in `docs/deploy-security.md` §1 and add `/found/*` second - it is
unauthenticated, hits the DB, and is exactly the shape a token-guessing sweep would hammer.

One extra target that section does not list: `/readyz` runs `SELECT 1` against D1 on every call, with no
auth. Unmetered, that is a cheap way to burn a D1 read quota. Either rate-limit it with the same rule, or
cache the result for a few seconds.

### 10. Do NOT do Phase 3 (integer paise) now; spend an hour on the tripwire instead (1 h)

Recommendation: keep `real` storage and the `round2` / `sum2` discipline. The rounding rule lives in exactly
one module, 1244 tests cover the money flows end to end (EMI recovery, settlement, statutory, tax), and no
test currently demonstrates an actual drift. Converting 55 columns plus every domain math site and the
serializer is a large, regression-prone change to make while trying to launch, in exchange for closing a
theoretical gap.

What is worth doing is enforcing the discipline that already works: a drift test in the style of the ones
this repo already has (`serializerContractDrift`, `collectionLaneDrift`) that scans `src/domain` and
`src/services` for writes to known money columns and fails when the value did not come from `round2` /
`sum2` / a bound parameter. That converts a documented convention into a gate.

Also correct `pre-prod-review.md`: its Phase 3 text records a locked decision to do the full integer
conversion, while what shipped is the harden-only alternative. Right now the plan and the code disagree,
which is the kind of thing that gets re-litigated in six months.

### 11. Accept the stateless session; document the break-glass (10 min)

Revocation is better than it first looks: `auth.ts` loads the user row on every request and throws on
`status !== "active"` (`auth.ts:98`), and the role grant is re-read per request too. So disabling a user or
changing their role takes effect on the next call, not in 12 hours. The only uncovered case is a stolen
cookie on an account that stays enabled, bounded by the 12h TTL.

Document "disable the user" as the break-glass in the runbook and move on. If you later want per-session
revocation, it is cheap precisely because the user row is already loaded: a `sessions_valid_after` column
compared against the sealed `iat` costs zero extra reads.

### 12. Make a tripped automation budget visible (15 min)

When the 50-dispatch cap trips, `automationEngine` only warns to the log. Write an `automation_runs` row with
a `dropped` status as well, so it shows up in the Workflows UI where someone will actually see it. The cap
itself is correct; keep it.

## Suggested order

1. Commit the working tree, PR to `dev`, get `verify.yml` green (items 2, 3).
2. Upgrade to Workers Standard and correct the two docs that assume Free (item 4).
3. Create `main`; confirm `deploy.yml` fires on it (item 1).
4. Create staging D1 + R2; rehearse `db:migrate:remote` and an export restore against it (item 7).
5. WAF rules + R2 versioning (items 8, 9).
6. Deploy production, then grant the break-glass super admin per `docs/deploy.md` §9.
7. After launch: the money tripwire (recommendation 10), then the two small visibility fixes
   (recommendations 11, 12). Job retry and red nightly runs (recommendations 5, 6) are already done.

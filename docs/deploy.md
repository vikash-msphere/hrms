# Deploying to Cloudflare Workers

End-to-end steps to stand up a fresh production instance. The Worker (`src/index.ts`) serves both the API
and the built SPA (`web/dist`) as static assets. Storage is D1 (SQL) + R2 (documents); identity is the
Worker's own **Google sign-in** (OIDC — `/auth/login` → Google → signed session cookie; no per-seat cost,
unlimited users). Security controls that live outside this flow (WAF rate limits, secret rotation,
dev-bypass rules) are in `docs/deploy-security.md` — follow both.

## 0. Prerequisites

- A Cloudflare account with Workers Paid or Free tier (D1 + R2 both work on Free).
  - **Free tier:** every data flow fits (DB access is batched for the 50-subrequests-per-invocation budget),
    but the fixed 10ms CPU cap breaks server-side PDF generation (payslips, letters, Form-16, e-sign
    stamping) — those requests will error, and both cron ticks overrun the 50-subrequest budget (see the
    note above `[limits]` in `wrangler.toml`). **This is the plan in use:** `[limits]` (a paid feature) is
    commented out in both `wrangler.toml` and `wrangler.staging.toml`, and `deploy.yml` defaults to
    `CF_PLAN=free` so the preflight check agrees. Locally, deploy with `CF_PLAN=free npm run deploy`.
  - **Paid ($5/mo Workers Standard):** everything works. To switch: uncomment `[limits]` in both wrangler
    configs and set `CF_PLAN=paid` in the `production` GitHub environment.
- A Google Cloud project (any — it only hosts the OAuth client; free) and, in practice, Google Workspace
  for your org domain (sign-in works with any Google account, but the domain allow-list expects org
  addresses, and MFA/device policy is enforced in the Workspace admin console).
- Node 20+ and the repo installed: `npm ci`.
- Wrangler authenticated to your account: `npx wrangler login`.
- A transactional email account + verified sending domain. Supported providers: Resend (default), Brevo,
  SendGrid, Postmark, Mailgun. Pick one via `EMAIL_PROVIDER`; its API key goes in `EMAIL_API_KEY`.

## 1. Provision the backing resources

Create the D1 database and the R2 bucket the Worker binds to.

```bash
npx wrangler d1 create hrms          # prints a database_id — copy it
npx wrangler r2 bucket create hrms
```

## 2. Configure `wrangler.toml`

Edit the committed `wrangler.toml`:

- `[[d1_databases]].database_id` — paste the id from step 1.
- `[vars].ALLOWED_EMAIL_DOMAINS` — your org domain(s), comma-separated (e.g. `acme.com`). **Required**:
  with Google sign-in it is the org perimeter — the only thing stopping any Google account from signing in
  and being auto-provisioned as an employee. Leave it empty and the Worker refuses to serve (`makeDeps`
  throws) and the OAuth callback returns 500.
- `[vars].EMAIL_PROVIDER` — `resend` (default) | `brevo` | `sendgrid` | `postmark` | `mailgun`.
- `[vars].EMAIL_FROM` — the verified sender, e.g. `hr@acme.com` (or `Acme HR <hr@acme.com>`).
- `[vars].EMAIL_REGION` — provider-specific; the Mailgun sending domain. Omit for other providers.
- `[vars].ATTENDANCE_ALLOWED_IPS` — optional network fence on the attendance clock. Comma-separated
  individual IPs and/or CIDR blocks, IPv4 and IPv6 mixed freely (`203.0.113.7, 198.51.100.0/24,
  2001:db8::/32`): the office egress addresses and the VPN. Unset or empty means no fence — employees punch
  from anywhere. When set, `attendance/me:clockIn` and `:clockOut` from any other address are `403`, and so
  is a punch whose client IP can't be established; only `cf-connecting-ip` counts, never the spoofable
  `x-forwarded-for`. An **approved** remote-work request eases the fence for exactly its dates (half-days
  included), so working-from-home stays a normal punch once it's been agreed. HR
  attendance-regularizations are **not** fenced, so a missed punch is still correctable from anywhere. A
  malformed entry is a startup error, not a silently narrowed fence.

Do **not** put secrets here — `wrangler.toml` is committed. The bindings (`DB`, `DOCS`) and cron triggers
are already declared; leave them as-is.

**Staging is a second file, not a section.** `wrangler.staging.toml` is a standalone config for the
`hrms-staging` Worker, reached with `--config` (`npm run deploy:staging`, `npm run db:migrate:staging`,
`wrangler secret put <NAME> --config wrangler.staging.toml`). It used to be an `[env.staging]` block here,
which required every top-level binding and var to be repeated inside it and failed *silently* when one was
missed — a config with no `[env.staging.vars]` deploys with no vars rather than erroring. Three keys have to
stay in step across the two files and `npm run preflight` checks all three: `compatibility_date`,
`run_worker_first` and the `[limits]` block. Everything else is deliberately per-environment — its own D1,
R2 bucket, Vectorize index and AI Gateway id — because sharing any of those would have a rehearsal write
into production's data.

## 3. Set up Google sign-in

The Worker runs its own Google-OIDC flow (`src/routes/authRoutes.ts` / `src/middleware/auth.ts`):
`/auth/login` redirects to Google, `/auth/callback` verifies the ID token (JWKS signature, audience, nonce,
`email_verified`, domain allow-list) and sets a signed HttpOnly session cookie. Sessions last 12h
(`SESSION_TTL_MS` in `src/routes/authRoutes.ts`); re-auth through Google SSO is a silent redirect.

1. [Google Cloud console](https://console.cloud.google.com/apis/credentials) → **Credentials → Create
   credentials → OAuth client ID** → type **Web application**.
2. Authorized redirect URI: `https://<your-app-hostname>/auth/callback` (add the staging hostname too).
3. Copy the client ID + secret — they become the `GOOGLE_*` secrets in step 4. Setting `GOOGLE_CLIENT_ID`
   is what selects Google sign-in mode at runtime.
4. Confirm `ALLOWED_EMAIL_DOMAINS` is set (step 2) — it is the org perimeter for who may sign in.
5. Enforce MFA / device policy in the **Google Workspace admin console** — with sign-in delegated to
   Google, that is where those controls live.
6. Add a WAF rate-limit rule covering `/auth/*` (see `docs/deploy-security.md` §1).

## 4. Set production secrets

Generate FRESH values (never reuse `.dev.vars` / `.dev.vars.example`). Set each with `wrangler secret put`:

```bash
npx wrangler secret put FIELD_ENCRYPTION_KEY   # openssl rand -base64 32
npx wrangler secret put WIRE_ID_KEY            # openssl rand -base64 32
npx wrangler secret put AUTH_SESSION_KEY       # openssl rand -base64 32 (signs the session cookie)
npx wrangler secret put GOOGLE_CLIENT_ID       # from step 3 (also what turns Google sign-in on)
npx wrangler secret put GOOGLE_CLIENT_SECRET   # from step 3
npx wrangler secret put EMAIL_API_KEY          # from your EMAIL_PROVIDER's console
```

- `FIELD_ENCRYPTION_KEY` and `WIRE_ID_KEY` must be exactly 32 bytes base64. A wrong `FIELD_ENCRYPTION_KEY`
  breaks all field/document encryption. `AUTH_SESSION_KEY` must be ≥32 bytes base64; rotating it signs
  everyone out (stateless sessions), which is also the break-glass session-revocation lever.
- Never set `ALLOW_DEV_AUTH` or `DEV_FAKE_EMAIL` in production — they enable the local auth bypass. See
  `docs/deploy-security.md` §3.
- Rotation caveats (re-encryption for `FIELD_ENCRYPTION_KEY`, token invalidation for `WIRE_ID_KEY`) — see
  `docs/deploy-security.md` §2.

Optional — only if you enable the Cashfree Aadhaar e-sign provider (see `docs/05-add-esign-provider.md`):

```bash
npx wrangler secret put ESIGN_CASHFREE_CLIENT_ID
npx wrangler secret put ESIGN_CASHFREE_CLIENT_SECRET   # also signs the webhook (no separate webhook secret)
```

These are unset by default (the app ships with in-app signature signing, no external dependency). Do not
choose "Aadhaar e-Sign" as the method on any template/document until both are set, or signing throws.

**Production 2FA (`X-Cf-Signature`).** Cashfree production accounts require an `x-cf-signature` header on every
verification API call, in addition to the client id/secret. When you enable public-key 2FA in the Secure ID
dashboard, Cashfree gives you a public key; set it as a secret:

```bash
npx wrangler secret put ESIGN_CASHFREE_PUBLIC_KEY      # Cashfree's public key (PEM or base64 SPKI)
```

The driver (`src/services/esign/cashfree.ts`) then adds the header to every call automatically. The signature
is `base64(RSA-OAEP-SHA1(clientId + "." + <unix-seconds>))` encrypted with **Cashfree's public key** — it is
an *encryption*, not a private-key signature; Cashfree decrypts and checks the id + timestamp. Two operational
requirements:

- Leave `ESIGN_CASHFREE_PUBLIC_KEY` **unset** in sandbox / for accounts still on client-id/secret only — the
  header is then omitted and calls work as before. Set it only once the account is in public-key 2FA mode.
- The Worker clock is Cloudflare's (NTP-synced), so timestamp skew is not a concern in production; if you ever
  proxy these calls through your own host, that host must be NTP-synced (Cashfree rejects skew > 5 min).

Then register the e-sign webhook in the Cashfree dashboard, pointing at:

```
POST https://<your-worker-host>/esign/callback/cashfree
```

This route is public (outside `/v1`) and authenticated solely by Cashfree's HMAC signature, verified with
`ESIGN_CASHFREE_CLIENT_SECRET`. Full setup + troubleshooting: `docs/05-add-esign-provider.md`.

## 5. Build the web app

```bash
npm run build:web    # → web/dist, served by the Worker's [assets]
```

`web/public/_headers` (CSP) is copied into `web/dist` at build and honored by Workers Assets.

## 6. Apply schema migrations to remote D1

```bash
npm run db:migrate:remote    # wrangler d1 migrations apply hrms --remote
```

## 7. Seed the production catalog (NOT the demo seed)

Apply `bootstrap/bootstrap.sql` — the India-statutory catalog + config for a fresh org (roles, access rules,
leave types, holidays, pay components, compliance rules, settings, templates). It seeds **no employees, no
users, no logins**.

```bash
npx wrangler d1 execute hrms --remote --file=bootstrap/bootstrap.sql
```

Apply it exactly once to an empty database. Do **NOT** apply `scripts/seed.sql` or `bootstrap/demo.sql` —
those create predictable demo accounts (e.g. `super@example.com`) and must never touch production
(`docs/deploy-security.md` §4).

If you bumped `HOLIDAY_YEAR` / `FY_START_YEAR`, regenerate first: `node --import ./scripts/tsResolve.mjs bootstrap/genBootstrap.ts >
bootstrap/bootstrap.sql`.

## 7a. Freeze the applied migrations (once, at launch)

```bash
node --import ./scripts/tsResolve.mjs scripts/freezeMigrations.ts
git add src/db/migrations/meta/_frozen.json && git commit -m "chore: freeze the launch migration"
```

Up to this point the schema has been kept as a single migration that `npm run db:generate` re-squashes in
place, under the same `0000_*` tag. That is fine while nothing is deployed and **silently wrong** the moment a
real database has run it: `wrangler d1 migrations apply` records migrations by **tag** and compares nothing
about their contents, so a re-squashed `0000_*` is *skipped*. The file changes, the deploy is green, and the
remote schema never moves — the failure surfaces days later as a query against a column that does not exist.

`freezeMigrations.ts` records the sha256 of every migration file. From then on `npm run preflight` fails the
deploy if one of them changes, and the rule is: **an applied migration is immutable — every schema change is
a new numbered migration.** Re-run the script after each later deploy that applies one.

Until it has been run, preflight emits a warning saying exactly this.

## 8. Deploy the Worker

```bash
npm run deploy            # preflight -> verify -> build -> wrangler deploy
CF_PLAN=free npm run deploy   # same, on the free plan (see Prerequisites)
```

This uploads the Worker + static assets and registers the cron triggers (`*/5 * * * *` LRO drain,
`0 2 * * *` nightly accrual/reminders) from `wrangler.toml`.

The first two steps are gates, not formalities:

- **`npm run preflight`** catches the mistakes a build cannot see — a `REPLACE_WITH_*` placeholder still
  sitting in the environment being deployed, a `[limits]` block that contradicts `CF_PLAN`, a build about
  to ship with the eSign *sandbox* roots trusted. Those fail the deploy. It also *warns* about choices that
  are legitimate but easy to make by accident: no `VITE_VAPID_PUBLIC_KEY` (push ships inert, and since Vite
  bakes it in at build time no later secret can switch it on), and an empty `PROD_ROOT_PEMS` (every signed
  document displays amber "validity unknown"). Run it on its own any time: `npm run preflight`.
- **`npm run verify`** is lint + typecheck + the full test suite. Deploying past a red suite now takes a
  deliberate `wrangler deploy`.

## 9. Grant the break-glass super admin

Every first login auto-provisions the caller as a plain `employee`. Promote your break-glass identity to
`super_admin` once:

1. Have that person sign in with Google once (creates their `users` row).
2. Promote them:

```bash
npx wrangler d1 execute hrms --remote \
  --command "UPDATE users SET role='super_admin' WHERE lower(email)='admin@acme.com';"
```

Match on `lower(email)`, and give the address in lower case. The column is plain `TEXT` with no `NOCASE`
collation, so a bare `=` is case-sensitive: typed with the capitalisation a person uses in their signature, the
statement reports success and updates nothing, and the break-glass account is left at `employee`.

From there, the super admin provisions departments, employees, and role assignments in-app.

## 10. Post-deploy hardening & verification

- **WAF rate limits** — the Worker enforces none. Add the rules in `docs/deploy-security.md` §1 before
  going live (PDF/upload/batch/cron endpoints).
- **CSP headers** — confirm the deployed host emits the `_headers` policy (`docs/deploy-security.md` §5).
- **Smoke test** — open the app URL in a fresh browser profile; confirm the sign-in screen leads through
  Google and back authenticated, that an account outside `ALLOWED_EMAIL_DOMAINS` is refused, and that the
  super admin can reach admin surfaces.
- **Cron** — verify both triggers appear under the Worker's **Triggers** tab.
- **Webhooks** — automation `webhook`/`apiCall` egress stays off unless explicitly wired
  (`docs/deploy-security.md` §6).

## 11. Optional: the AI layer

Everything above deploys the app with no AI. The layer ships switched off and stays that way — no binding, no
index, no feature enabled — so skipping this leaves the app working exactly as this document describes.

To turn any of it on, follow `docs/deploy-ai.md`: it covers creating the Vectorize index, what to do about
staging, migrating and deploying, the per-feature switches in Settings, the three capabilities nothing seeds,
how to check it is actually working, and how to turn it off again. Note that `npm run preflight` does **not**
check any of it.

## Automating deploys (CI/CD)

Steps 0-4, 7, and 9 are **one-time setup** — run them once by hand. Everything per-commit (build → migrate →
deploy, steps 5, 6, 8) is automated by `.github/workflows/deploy.yml`, which runs on every push to **`prod`**
(and via manual **Run workflow**).

`prod` is the release branch; `dev` is the trunk. Work merges to `dev` continuously, and a deploy happens
only when `dev` is merged into `prod`. Keeping them apart is what lets production be frozen through a
monthly payroll cutover while development carries on - retargeting the workflow at `dev` would make every
merge a production deploy. `npm run verify` runs in CI only when somebody asks for it: `verify.yml` is manual
only (Actions → verify → Run workflow, on any branch), and `deploy.yml` does not run it. Run `verify.yml` on
the commit being released before pushing it to `prod` - the deploy ships whatever it is given.

The workflow runs, in order: `npm run preflight`, `npm run build:web`, `npm run db:migrate:remote`, then
`npx wrangler deploy`. That is the `npm run deploy` chain minus `verify`, with the SPA build hoisted ahead of
the migration, because wrangler validates
`[assets].directory` on *every* subcommand - a missing `web/dist` fails `d1 migrations apply`. Remote
migrations are idempotent - wrangler skips any already recorded in D1 - so re-runs are safe. The bootstrap
catalog (step 7) is deliberately **not** in CI: it applies exactly once to an empty database and would
collide on re-run.

That idempotence is by **tag**, not by content, which is why step 7a exists: once a migration has been
applied, editing it is a no-op against the remote schema that no deploy reports. The preflight step is what
catches it, and it can only do so for migrations listed in `src/db/migrations/meta/_frozen.json` - so run
`scripts/freezeMigrations.ts` and commit its output after any deploy that applies a new migration.

The preflight step reads `CF_PLAN` from a **variable** (not a secret) in the `production` environment,
defaulting to `free` - the plan in use, with `[limits]` commented out to match. On moving to the paid plan,
set `CF_PLAN=paid` there and uncomment `[limits]` in both wrangler configs; preflight fails a deploy where
the two disagree. Note what this check does and does not prove: it asserts only that
`CF_PLAN` and the `[limits]` block agree with each other. It cannot see the account, so `plan=paid` in the
output is not evidence the account is on Workers Standard - confirm that in the dashboard.

**Enable it:** create a Cloudflare API token (My Profile → API Tokens) with `Workers Scripts:Edit`,
`D1:Edit`, and `Workers R2 Storage:Edit`, then add two GitHub repo secrets under a `production`
environment:

- `CLOUDFLARE_API_TOKEN` — the token above.
- `CLOUDFLARE_ACCOUNT_ID` — your account id (`npx wrangler whoami`).

Application secrets (`FIELD_ENCRYPTION_KEY`, `WIRE_ID_KEY`, `AUTH_SESSION_KEY`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `EMAIL_API_KEY`) live on the Worker via `wrangler secret put` (step 4) — they
persist across deploys and must **not** be added to CI.

Gate the `production` environment with required reviewers if you want a manual approval before each deploy.

## Environment reference

The complete set the Worker reads (from `src/env.ts` `Bindings`). All values come from the Worker
environment only — **nothing is read from a file at runtime**. `binding` and `var` are declared in the
committed `wrangler.toml`; `secret` is set with `wrangler secret put` (step 4) and never committed. There is
no `.env`/config file in production; `.dev.vars` exists for **local dev only** and is gitignored.

| Name | Type | Required | Purpose |
|------|------|----------|---------|
| `DB` | binding | **yes** | D1 database |
| `DOCS` | binding | **yes** | R2 document bucket |
| `EMAIL_PROVIDER` | var | optional | `resend` (default) \| `brevo` \| `sendgrid` \| `postmark` \| `mailgun` |
| `EMAIL_FROM` | var | **yes** | Transactional sender address (verified sending domain) |
| `EMAIL_REGION` | var | optional | Provider-specific; the Mailgun sending domain. Ignored by other providers |
| `GOOGLE_CLIENT_ID` | secret | **yes** | OAuth client id; setting it is what selects Google sign-in at runtime |
| `GOOGLE_CLIENT_SECRET` | secret | **yes** | OAuth client secret (code exchange happens server-side only) |
| `AUTH_SESSION_KEY` | secret | **yes** | ≥32-byte base64 HMAC key signing the stateless session cookie |
| `FIELD_ENCRYPTION_KEY` | secret | **yes** | 32-byte base64; field/document encryption |
| `WIRE_ID_KEY` | secret | **yes** | 32-byte base64; wire-id tokenization |
| `EMAIL_API_KEY` | secret | **yes** | Transactional email provider API key |
| `ALLOWED_EMAIL_DOMAINS` | var | **yes** | Comma-separated allow-list of org domains permitted to sign in / auto-provision (e.g. `acme.com`). The org perimeter in Google mode, so an empty list is refused at startup rather than treated as "no restriction" |
| `ATTENDANCE_ALLOWED_IPS` | var | optional | Comma-separated IPs / CIDR blocks (IPv4 + IPv6) the attendance clock punches are accepted from. Unset/empty = no fence; malformed = startup error |
| `ESIGN_CASHFREE_CLIENT_ID` | secret | optional | Cashfree Aadhaar e-sign client id; unset unless the provider is enabled |
| `ESIGN_CASHFREE_CLIENT_SECRET` | secret | optional | Cashfree client secret; also the webhook HMAC key |
| `ESIGN_CASHFREE_PUBLIC_KEY` | secret | optional | Cashfree public key for the production `X-Cf-Signature` 2FA header; unset in sandbox / client-id+secret-only mode |
| `ALLOW_DEV_AUTH`, `DEV_FAKE_EMAIL` | var | **never in prod** | Local auth bypass — see `docs/deploy-security.md` §3 |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | var/secret | legacy | Cloudflare Access mode, used only when `GOOGLE_CLIENT_ID` is unset (`src/middleware/auth.ts`). Not the documented path |

**Required for production**, in one place: the two bindings (`DB`, `DOCS`), the two vars (`EMAIL_FROM`,
`ALLOWED_EMAIL_DOMAINS`), and the six secrets (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`AUTH_SESSION_KEY`, `FIELD_ENCRYPTION_KEY`, `WIRE_ID_KEY`, `EMAIL_API_KEY`). Everything else is optional
(e-sign) or local-only (dev bypass).

**Not Worker env — CI/CD only:** the GitHub deploy + backup workflows need two GitHub repo secrets,
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (see "Automating deploys" above). These live on GitHub, not
the Worker.

## Backups & disaster recovery

Two layers, both required:

1. **D1 Time Travel** — Cloudflare retains a restorable history of the D1 database for the last **30 days**
   automatically. To restore: `npx wrangler d1 time-travel restore hrms --timestamp <ISO8601>` (or
   `--bookmark`). Use `... time-travel info hrms` to list restore points. This covers accidental
   writes/deletes within the window; it is NOT a substitute for exports.

2. **Scheduled export to R2** (retention beyond 30 days / off-platform copy) — Time Travel alone is a 30-day
   window. Take a periodic logical export and keep it:

   ```bash
   npx wrangler d1 export hrms --remote --output=hrms-$(date +%F).sql
   # then upload to a retained bucket / off-site store
   ```

   This runs from CI, not the Worker (the Workers runtime has no D1 export API): the
   **`.github/workflows/d1-backup.yml`** workflow does it nightly (03:30 UTC) and on `workflow_dispatch` —
   `wrangler d1 export` → `wrangler r2 object put hrms/backups/db/<date>.sql`. It uses the same
   `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets as the deploy workflow. The dump is never stored
   on GitHub (no artifact): it is the whole database in plain SQL, and a repo artifact is downloadable by
   everyone with read access. Set retention with an R2 lifecycle rule on the `backups/` prefix of `hrms`.

3. **Weekly R2 document sync** — the documents need their own answer, because they are the part nothing can
   rebuild. A payslip can be regenerated from its payroll run; a letter carrying an employee's e-signature,
   an uploaded identity document and a signed policy acknowledgement cannot be regenerated by anything.
   Two layers again:

   - **Versioning on the live bucket**, enabled in the dashboard (R2 → `hrms` → Settings). Covers an
     overwrite or a delete.
   - **`.github/workflows/r2-backup.yml`**, Sundays 04:00 UTC and on `workflow_dispatch`: `aws s3 sync` from
     `hrms` into a separate `hrms-backup` bucket. Covers losing the bucket. It leaves out `backups/`, so
     the D1 dumps are not copied. It runs `--delete`-free on purpose, so a document deleted in the app
     stays in the backup. It needs an R2 **S3 API token** —
     `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`, a different credential from `CLOUDFLARE_API_TOKEN` —
     because `wrangler r2 object` cannot list a bucket and so cannot sync one. Setup steps are at the top of
     the workflow file.

> **The backups are only as recoverable as `FIELD_ENCRYPTION_KEY`.** Every document body in R2 is encrypted
> under it, and encrypted fields in the D1 export are too. Escrow the key somewhere outside Cloudflare when
> you first set it (§4): a complete backup plus a lost key restores nothing. Rotating it in place has the
> same effect — see `docs/deploy-security.md` §2.

To rehearse a restore, apply the export to the **staging** D1 (`wrangler d1 execute hrms-staging --remote
--config wrangler.staging.toml --file=<export>.sql`) and smoke-test before trusting it against production. Confirm the first nightly D1
export and the first weekly R2 sync actually landed, rather than assuming a green workflow means a usable
copy.

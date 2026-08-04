# Deployment security runbook

Operational controls that live outside the application code. Complete these before the first production deploy.
Code-level findings and their fixes are tracked in `docs/security-review.md`.

## 1. Rate limiting (WAF)

The Worker enforces no volumetric limits.

**This deployment is on the Cloudflare Free plan**, whose WAF rate limiting is tightly bounded:

- **one** rate-limiting rule total (not one per path class);
- a **fixed 10-second** counting window (no per-minute periods);
- **block** action only;
- counting **by IP only** (per-identity characteristics need Pro+).

Given a single rule, spend it on the surfaces with **no auth gate in front**: the `/auth/*` sign-in flow and
the public e-sign webhook. Everything under `/v1/*` already requires a valid session, so identity-gating is
the primary control there; per-endpoint volumetric limits on those paths need Pro+ and are deferred until
the plan is upgraded.

**The one free-plan rule:**

| Field            | Value                                                                 |
|------------------|-----------------------------------------------------------------------|
| Match expression | `starts_with(http.request.uri.path, "/auth/") or http.request.uri.path contains "/esign/callback/"` |
| Count by         | IP source address (the only free-plan characteristic)                 |
| Period           | 10 seconds (fixed)                                                    |
| Requests         | **20** per 10s (≈120/min) — above any real sign-in or vendor retry rate |
| Action           | Block                                                                 |

`/auth/callback` does real work per request (a Google token exchange + JWKS verify) and `/esign/callback/*`
runs a provider lookup + HMAC compute before its signature check rejects, so this IP bound blunts a flood
before either path burns budget.

**When you upgrade to Pro+**, add the per-identity rules below (per-minute windows):

| Path (method)                                   | Why                                   | Suggested limit          |
|-------------------------------------------------|---------------------------------------|--------------------------|
| `POST /v1/*:generateLetter`, `:generateForm16`, `:previewLetter`, `:previewPayslip` | PDF rendering is CPU-heavy | ~10 / min / user |
| `POST /v1/*:upload`, `:uploadForm16`, `:uploadPhoto` | file buffering + AES + R2 write | ~30 / min / user |
| `POST /v1/batch:run`                            | fan-out amplifier                     | ~60 / min / user         |
| `POST /v1/cron-runs:run`                        | triggers full scheduled jobs (super)  | ~5 / min                 |
| `POST /v1/automations/*:test`                   | rule dry-run                          | ~30 / min / user         |

## 2. Secrets

- Generate FRESH, distinct production values; never reuse the local `.dev.vars` or `.dev.vars.example` keys.
  - `FIELD_ENCRYPTION_KEY` — 32 random bytes, base64. `openssl rand -base64 32`.
  - `WIRE_ID_KEY` — 32 random bytes, base64. `openssl rand -base64 32`.
  - `AUTH_SESSION_KEY` — 32 random bytes, base64. `openssl rand -base64 32`. Signs the sign-in session cookie.
  - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — from the Google Cloud console OAuth client.
  - `EMAIL_API_KEY` — from your `EMAIL_PROVIDER`'s console.
- Set them with `wrangler secret put <NAME>` (never in `wrangler.toml`, which is committed).
- Rotation caveats:
  - Rotating `FIELD_ENCRYPTION_KEY` makes every already-encrypted field/document undecryptable — plan a
    re-encryption migration, don't rotate in place.
  - Rotating `WIRE_ID_KEY` invalidates every wire token already handed to clients (they 404 until reload).
  - Rotating `AUTH_SESSION_KEY` signs every user out (stateless sessions) — harmless, and deliberately the
    break-glass "revoke all sessions" lever.

## 3. Dev auth bypass — never in production

The local auth bypass in `src/middleware/auth.ts` engages only when BOTH `DEV_FAKE_EMAIL` and
`ALLOW_DEV_AUTH=true` are set. Production must set NEITHER. `ALLOW_DEV_AUTH` exists only in `.dev.vars`
(git-ignored). Do not add it to any deployed environment or CI secret store.

## 3a. Identity perimeter — the domain allow-list

Sign-in is the Worker's own Google-OIDC flow, and `src/middleware/auth.ts` auto-provisions a first-time
caller (any Google-verified email) as an `employee`-role user. **`ALLOWED_EMAIL_DOMAINS` is therefore the
org perimeter**: set it (comma-separated, in `wrangler.toml [vars]`) to the domains permitted to sign in.
It is enforced twice — at the OAuth callback (outsiders never get a session) and again at first-login
provisioning (no user row is ever created for an outside email). An empty list would mean "any Google
account on the internet", not "no restriction", so it is refused rather than honored: `makeDeps` throws at
startup and the OAuth callback returns 500. MFA and device posture are enforced in the Google Workspace
admin console, not here.

## 4. Demo / seed fixtures — never in production

`scripts/seed.sql` and `bootstrap/demo.sql` create predictable accounts (e.g. `super@example.com` as
`super_admin`) for local development and demos. Do NOT apply them to a production D1 database. Production
should start from migrations only (`wrangler d1 migrations apply hrms --remote`) plus the real
bootstrap in `bootstrap/bootstrap.sql`, and grant super to the actual break-glass identity.

## 5. SPA Content-Security-Policy

The API responses set their own strict CSP (`src/middleware/securityHeaders.ts`). The static app shell is
covered by `web/public/_headers` (copied to `web/dist` at build), which serves a `script-src 'self'` policy —
no inline scripts (the theme bootstrap is `web/public/theme-init.js`; the module-preload polyfill is disabled
in `web/vite.config.ts`). Verify the deployed static host actually emits these headers (Cloudflare Workers
Assets / Pages honor `_headers`). `style-src` retains `'unsafe-inline'` for React inline styles, and
`frame-src` allows `blob:` so the in-app PDF viewers (payslip preview, letter-template preview) can frame bytes
the app fetched itself; `object-src` stays `'none'`.

Two remote origins are named, and they are the only ones: `https://fonts.googleapis.com` on `style-src` and
`https://fonts.gstatic.com` on `font-src`, for the webfont `@import` in `web/src/index.css` (the org wordmark and
the typefaces a post can be set in). Neither can deliver script — `script-src` and `connect-src` remain `'self'`.
To drop them, self-host the woff2 files under `web/public` and remove the `@import`.

## 6. Webhook egress (if enabled later)

Automation `webhook` actions are OFF unless a `WebhookSender` is wired into `makeDeps`. Before enabling it,
keep the destination guard in `src/lib/urlGuard.ts` (https-only, public host) and consider an explicit
per-tenant allowlist. Authoring `webhook`/`apiCall` actions is already restricted to `super_admin`.

# Deployment security runbook

Operational controls that live outside the application code. Complete these before the first production deploy.
Current code-level posture and the open pre-launch items are in `production-readiness.md` (root);
`docs/security-review.md` is the archived 2026-07-04 review that preceded it.

## 1. Rate limiting (WAF)

The Worker enforces no volumetric limits.

**Plan tier decides which set of rules you get, and it is not only a rate-limiting question.**
`wrangler.toml` ships `[limits] cpu_ms = 60000`, which is a Workers Standard (paid) feature. On the Free
plan the fixed 10ms CPU cap breaks every server-side PDF path - payslips, letters, Form 16, e-sign stamping
- so deploying on Free means commenting that block out and losing those features (`docs/deploy.md` §0).
Decide the tier before launch, then follow the matching section below.

### Free plan

Its WAF rate limiting is tightly bounded:

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

Three more unauthenticated surfaces deserve a rule the moment you have more than one: `/found/*` (the public
asset-tag lookup, which hits D1 on every call and is exactly the shape a token-guessing sweep would hammer),
`/calendar/holidays/*` (the subscribable holiday feed - same shape, and calendar clients poll it on their own
schedule) and `/readyz` (an unauthenticated `SELECT 1` against D1, so an easy way to burn read quota). On Free,
fold `/found/*` and `/calendar/*` into the single rule's match expression if either is enabled publicly.

### Pro+ / Workers Standard

Add the per-identity rules below (per-minute windows) alongside the sign-in rule:

| Path (method)                                   | Why                                   | Suggested limit          |
|-------------------------------------------------|---------------------------------------|--------------------------|
| `POST /v1/*:generateLetter`, `:generateForm16`, `:previewLetter`, `:previewPayslip` | PDF rendering is CPU-heavy | ~10 / min / user |
| `POST /v1/*:upload`, `:uploadForm16`, `:uploadPhoto` | file buffering + AES + R2 write | ~30 / min / user |
| `POST /v1/batch:run`                            | fan-out amplifier                     | ~60 / min / user         |
| `POST /v1/cron-runs:run`                        | triggers full scheduled jobs (super)  | ~5 / min                 |
| `POST /v1/automations/*:test`                   | rule dry-run                          | ~30 / min / user         |
| `GET /found/*`, `GET /calendar/holidays/*`, `GET /readyz` | unauthenticated, each touches D1 | ~30 / min / IP     |

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

**No remote origin appears anywhere in the policy.** Every typeface — the UI font, the org wordmark and the
faces a board post can be set in — is self-hosted from `@fontsource` and ships as a same-origin bundled asset,
so `font-src` and `style-src` name no external host and `connect-src` stays `'self'`.

`script-src` carries one extra token, `'wasm-unsafe-eval'`. It is the narrow permission to *compile*
WebAssembly and grants nothing else — in particular it is **not** `'unsafe-eval'`, so `eval` and
`new Function` remain blocked. pdf.js needs it: JBIG2 and JPEG2000 image decoding (the formats office
scanners produce) and its colour engine are wasm modules, and Chromium refuses to compile a module without
this token whenever a `script-src` is present. Without it, scanned documents render with missing images.
pdf.js's PDF-JavaScript engine (`quickjs-eval.wasm`) is deliberately not shipped — see
`web/src/lib/pdfjs.ts`.

Caching is set in the same file: `/assets/*` is content-hashed and pinned `immutable` for a year, the
un-hashed pdf.js sidecar data under `/assets/pdfjs/*` revalidates daily, and the shell (`/`, `index.html`,
the manifest, the service worker, `theme-init.js`) is `no-cache` so a deploy reaches open tabs.

### HSTS belongs to the zone, not to `_headers`

Turn HSTS on in the Cloudflare dashboard — **SSL/TLS → Edge Certificates → HSTS** — not by adding a
`Strict-Transport-Security` line to `web/public/_headers`. Two reasons, and the second one bites immediately:

- The zone setting covers **every** response on the domain, including the Worker's `/v1` JSON. `_headers`
  only governs static assets, so an HSTS policy set there is full of holes.
- `_headers` cannot condition a header on the request being HTTPS, so the header also goes out over plain
  HTTP. RFC 6797 §7.2 forbids that, and it breaks local development in a way that is hard to recognise:
  `wrangler dev` serves the app over `http://localhost`, Chrome pins the host to HTTPS, and the next
  service-worker registration fails with *"An unknown error occurred when fetching the script"* because the
  script fetch was upgraded to `https://localhost`, where nothing is listening. The page itself keeps
  working, which sends you looking in the wrong place.

If a machine has already been pinned this way, removing the header is not enough — clear the pin at
`chrome://net-internals/#hsts` → *Delete domain security policies* → `localhost`.

## 6. Webhook egress (if enabled later)

Automation `webhook` actions are OFF unless a `WebhookSender` is wired into `makeDeps`. Before enabling it,
keep the destination guard in `src/lib/urlGuard.ts` (https-only, public host) and consider an explicit
per-tenant allowlist. Authoring `webhook`/`apiCall` actions is already restricted to `super_admin`.

## 7. SheetJS (`xlsx`) — installed from the vendor, not npm

`package.json` pins `xlsx` to a **tarball URL**, not a registry version:

```
"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"
```

This is deliberate and must stay that way. SheetJS stopped publishing to npm at **0.18.5**, and that
abandoned copy carries two high-severity advisories that will never be fixed there — prototype pollution
([GHSA-4r6h-8v6p-xvw6](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6), fixed upstream in 0.19.3) and
ReDoS ([GHSA-5pgg-2g8v-p4x9](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9), fixed in 0.20.2). Anyone
"tidying up" the dependency back to `"xlsx": "^0.18.5"` silently reintroduces both. Upgrade by bumping the
version in the URL; the vendor's releases and checksums are at <https://cdn.sheetjs.com/>.

Almost all use is *writing* (`XLSX.write` in `src/services/statutoryReport.ts`, `src/services/bankFile.ts`,
`web/src/lib/exportTable.ts`). There is exactly one parse of caller-supplied bytes —
`web/src/pages/BankFormats.tsx`, reading an uploaded bank template to detect its columns — and it stays
hardened independently of the installed version, because a main-thread parse of a user file deserves it:

- the bytes must begin with the ZIP magic `PK\x03\x04` and stay under the 5 MB `MAX_TEMPLATE_BYTES` ceiling,
  both checked before the parser is handed anything (mirroring `src/services/bankFormats.ts`);
- `XLSX.read` runs with `cellFormula`, `cellHTML` and `cellStyles` off — the narrowest path that still
  yields the header grid;
- the sheet is read with `{ header: 1 }`, which yields arrays rather than objects keyed by header text, so
  no attacker-controlled string is ever used as an object key.

## 8. eSign trust store — the anchor that decides green vs amber

`web/src/lib/ccaRoots.ts` holds the CA roots a signed PDF's certificate chain must terminate at for
`SignedPdfViewer` to show a green "signature valid" instead of amber "validity unknown". It currently pins
one production anchor:

**CCA India 2022** — Root Certifying Authority of India, RSA 4096 / SHA-256, `CA:TRUE` + `keyCertSign`,
valid 2022-02-02 → 2042-02-02, serial `762433ebdb26765a8560cd0aa82fe117`.
SHA-256 `9A:3F:D3:17:67:98:E8:42:DD:CB:12:C2:62:F1:1C:FA:CC:A7:0A:8B:84:C6:EA:6F:DA:30:84:2A:95:A9:4C:D8`

This is the only value in the codebase where being wrong means **showing a forgery as genuine**, so it is
pinned by fingerprint in `test/ccaRoots.test.ts`. Changing the certificate fails the suite; the only way
through is to update the expected SHA-256 on purpose, which forces a reviewer to look.

Two properties worth remembering:

- **Integrity does not depend on this.** Tamper detection is pure cryptography and works with an empty
  trust store — an edited document shows red "invalid" either way. The roots decide only whether the
  *signer's identity* can be attested.
- **Chains are validated as of SIGNING time**, not now (`pdfSignature.ts`), because eSign certificates are
  deliberately short-lived. Retiring a superseded root therefore breaks every document signed under it —
  when CCA rotates, *add* the new root alongside the old ones rather than replacing them.

To rotate or add one: run `node --import ./scripts/tsResolve.mjs scripts/esignChain.ts <signed.pdf>` against
a real signed document to learn the exact issuer the chain terminates at, download that certificate from
<https://cca.gov.in> → Repository, verify its published SHA-256 against a second independent source (Adobe
carries CCA roots via AATL, so an Acrobat install is a usable cross-check), then add the PEM and its
fingerprint to the pin test.

Sandbox roots (eMudhra's test hierarchy) are trusted **only** when `import.meta.env.DEV` is set or the build
opts in with `VITE_ESIGN_ALLOW_SANDBOX=true`. Preflight fails a build that sets that flag.

# Serve no app code to a signed-out browser

## Context

Production runs in **Google mode** (`GOOGLE_CLIENT_ID` set, docs/deploy.md). In that mode nothing sits in front
of the static assets: `wrangler.toml` `run_worker_first` sends only `/v1`, `/auth`, `/found`, `/calendar`,
`/esign`, `/diag`, `/__scheduled` to the Worker, so Cloudflare's asset layer answers `/`, `/index.html` and
every `/assets/*.js` chunk to anyone. A signed-out visitor downloads the whole SPA (route names, page chunks,
admin screens, API paths, field names) before `/v1/users/me` comes back 401 and `api.ts#redirectToLogin`
bounces them to `/auth/login`.

The proposed fix (tiny JS loader that checks the session, then pulls the rest) does not close the hole. The
chunks would still be public files on the CDN. Anyone who learns one filename (an ex-employee, a proxy log, a
browser cache, a pasted error) fetches it straight, and the entry chunk lists every other chunk. The check
belongs on the **server, on every request for app code**, not in JavaScript.

**Recommended:** send every request through the Worker (`run_worker_first = true`) and gate non-public paths on
the existing stateless session cookie before calling `env.ASSETS.fetch`. A signed-out **navigation** gets a
`302 /auth/login` with no HTML body, so the browser never sees a script tag, never mind a bundle. A signed-out
**subresource** request (`/assets/*`) gets a bare `401`. The cookie is already `HttpOnly; Secure;
SameSite=Lax; Path=/`, so browsers send it on script, module-preload, font, wasm and worker fetches. And
`lib/session.ts#openSession` is HMAC + expiry only: **zero D1 reads**, one `crypto.subtle.verify` per request.

What it does NOT do: it stops outsiders, not insiders. Every signed-in employee still downloads the admin
screens' code. That is fine because authz is enforced server-side on every `/v1` call. Splitting the bundle by
role would add a lot of complexity for no security gain.

## Design

### Request flow (Worker, `src/index.ts`)

The existing worker-owned mounts stay as they are. A new final GET/HEAD handler for everything else (a
`src/middleware/assetGate.ts` helper, called from `index.ts`):

1. **Public allowlist**, served with no session: `/favicon.svg`, `/apple-touch-icon.png`, `/icon-*.png`,
   `/manifest.webmanifest`, `/push-sw.js`.
   - The manifest must stay public because browsers fetch it with `credentials: omit`.
   - `push-sw.js` must stay public so a push service-worker update check made while signed out cannot fail.
   - None of these files says anything about the app beyond its name.
2. **Gate on/off.** The gate runs only when `GOOGLE_CLIENT_ID` is set and the dev bypass is off, using the same
   condition as `middleware/auth.ts:282-285`.
   - Access mode already has Cloudflare Access covering the whole hostname at the edge.
   - Local dev and e2e serve the bundle from Vite, so the Worker is not in that path at all.
3. **Verify** with `getCookie(c, SESSION_COOKIE)` and then `openSession(token, AUTH_SESSION_KEY, Date.now())`.
   Reuse `SESSION_COOKIE` from `routes/authRoutes.ts` and `openSession` from `lib/session.ts`. Do not re-implement
   either.
4. **No session:**
   - **Navigation** (`Sec-Fetch-Mode: navigate`, or no `Sec-Fetch-*` and the path is not `LOOKS_LIKE_A_FILE`):
     `302 /auth/login`.
   - **Anything else:** `401` with an empty body.
   - Both responses carry `Cache-Control: no-store` and the `securityHeaders` set.
5. **Session OK:** `const res = await c.env.ASSETS.fetch(c.req.raw)`.
   - If the asset exists, return it. `_headers` still applies through the binding, as it already does for the
     shell today (`index.ts:435`).
   - On a 404, fall through to the existing `notFound` logic: an honest 404 for a file, the shell for an app
     route. That logic moves into this handler unchanged. Worker-owned prefixes still 404 as they do now.

The gate checks the signature and expiry only. It does not check `users.sessions_valid_from`, because that
costs a D1 read per asset (see `d1-read-minimization`). Result: a cookie revoked by "sign out everywhere" can
still download code until it expires (12h at most), but it gets **no data**. `/v1` auth still enforces the
revocation stamp.

### Config

- **`wrangler.toml` + `wrangler.staging.toml`:** `run_worker_first = true` in both, kept in step. This removes the
  three-list drift that `test/spaFallback.test.ts:31` guards. `WORKER_OWNED_PREFIXES` stays, because it still
  decides which misses 404 and it still drives the Vite proxy test.
- **`scripts/preflight*`:** preflight compares `run_worker_first` between the two files. Update that comparison
  for a boolean value.
- **`web/public/_headers`:** change `/assets/*` from `public, max-age=31536000, immutable` to
  `private, max-age=31536000, immutable`.
  - `public` lets a shared cache (a corporate proxy, a CDN layer) keep a copy and hand it to someone with no
    cookie.
  - `private` keeps the browser-only forever-cache, which is also what holds down the request count below.
  - Set the same on `/assets/pdfjs/*` (`private, max-age=86400, must-revalidate`) and on the shell/`theme-init.js`
    (`private, no-cache`).

### Client: mid-session expiry must not lose a form

Today a lazy chunk that fails to load is retried once (`web/src/lib/lazyPage.tsx#retryingImport`). After that
the ErrorBoundary offers a reload. With the gate in place, an expired cookie makes chunk fetches 401. A reload
would then take the user to Google and **throw away the half-typed form** that the `SessionExpiredDialog`
(App.tsx:~230) exists to keep.

Fix: when `retryingImport` hits a chunk-load error, probe `GET /v1/users/me` first. On a 401, call the
registered session-expired handler (`api.ts#setSessionExpiredHandler`, exported for this) and wait for it to
resolve before re-importing. On any other result, keep the current behaviour.

### Optional, same change: return to the page they asked for

Today every sign-in lands on `/`, so a deep link from an email or push notification loses its target. The gate
already knows the path, so:

1. On the navigation 302, park it in a `hrms_return_to` cookie, using the `OAUTH_COOKIE` shape (path `/auth`,
   600s).
2. `/auth/callback` redirects there instead of `/`, but only if it is a same-origin path: starts with `/`, is not
   `//` or `/\`, and parses to this origin, the same check `push-sw.js` does. Otherwise it redirects to `/`.

## Critical files

- `src/index.ts`: the catch-all asset handler; the `notFound` shell logic moves into it.
- `src/middleware/assetGate.ts` (new): the public allowlist, the mode check, and the navigation vs subresource
  answer.
- `src/routes/authRoutes.ts`: `/callback` honours `hrms_return_to` (optional part).
- `wrangler.toml`, `wrangler.staging.toml`: `run_worker_first = true`. Rewrite the comments above both blocks.
- `web/public/_headers`: `private` caching.
- `web/src/lib/lazyPage.tsx`, `web/src/api.ts`: chunk 401 goes to the session-expired dialog, not a reload.
- `test/spaFallback.test.ts`: replace the `run_worker_first` list-matching test with a check that both configs
  set `true`.
- `test/assetGate.test.ts` (new).
- Docs that describe the asset layer: `docs/00-overview.md`, `docs/deploy-security.md`.

## Risk to check before merging

**Free-plan request budget.** With `run_worker_first = true`, every asset request counts as a Worker request
against the free plan's 100k/day.

- It costs one request per asset, per device, per deploy. `private, immutable` means repeat visits don't ask
  again, and the cookie-less public icons are few.
- Measure a cold load with DevTools (number of requests) × headcount × deploys per day before shipping to
  production. Staging first.
- If the budget is tight, `run_worker_first` also accepts a list with `!` exclusions, so the public icons can
  skip the Worker (`["/*", "!/favicon.svg", …]`). That is a small saving, not a change in design.

## Verification

1. **`test/assetGate.test.ts`** drives `app.fetch` with a mocked `ASSETS`, the same pattern as
   `spaFallback.test.ts:101`, in Google mode. Cookies are minted with `sealSession`, as `e2e/fixtures.ts` does.
   Cases:
   - `/`, `/leave`, `/index.html`, `/assets/x.js` with no cookie: 302 for navigations, 401 for subresources, and
     `ASSETS.fetch` is **never called**.
   - An expired cookie and a cookie with a bad signature get the same answers.
   - With a valid cookie: the asset is served, a missing file is 404, an app route gets the shell.
   - The public allowlist is served without a cookie.
   - Access mode and the dev bypass do not gate.
   - `/v1`, `/found`, `/calendar`, `/auth` behave exactly as they do today.
2. Update `spaFallback.test.ts` and run both suites plus `./node_modules/.bin/tsc` (then check `$?`).
3. Run the relevant e2e specs only (session-expiry / lazy-route specs, by name via
   `npm run test:e2e -- <spec>`). E2E serves through Vite, so it covers the client change, not the gate.
4. Deploy to staging, then check with curl:
   - `curl -sI https://<staging>/` gives `302 → /auth/login`, with no body.
   - `curl -sI https://<staging>/assets/index-*.js` gives `401`.
   - Sign in, confirm the app loads and the chunks come back `private, immutable`.
   - Let the cookie expire, or delete it in DevTools, then navigate to a route not loaded yet. The Signed-out
     dialog should appear, not a reload to Google.

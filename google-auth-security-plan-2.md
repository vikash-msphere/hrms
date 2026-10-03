# Serve no app code to a signed-out browser

## Context

Production runs in Google mode (`GOOGLE_CLIENT_ID` set). Nothing sits in front of the static assets:
`run_worker_first` in `wrangler.toml:57` sends only the worker-owned prefixes to the Worker, so Cloudflare's asset
layer serves `/`, `/theme-init.js`, `/manifest.webmanifest` and every `/assets/*` chunk to anyone.

A signed-out visitor downloads the shell, then the entry chunk. Of that chunk and its static imports, 5 files
(0.90 MB) load at once. The entry chunk also contains the names of 21 lazy chunks. Only after all that does
`/v1/users/me` return 401 and `web/src/api.ts:38` send the visitor to `/auth/login`.

**Why a loader script does not fix it.** The chunks would still be public files. Anyone who has one URL can fetch
it and read the next URLs from it: an ex-employee, a proxy log, a pasted stack trace, a web archive. Only a
server-side refusal hides the chunks, and once the server refuses them, a loader adds nothing.

**Recommendation.** Put the Worker in front of every path except a short list of public icons. Before any
request touches the asset store, the Worker checks the caller's identity **with the same function `/v1` auth
uses**.

- A signed-out **navigation** gets a bare `302` to Google sign-in. No HTML is sent, not even a script tag.
- A signed-out **file request** gets a bare `401`, whether or not the file exists.
- A signed-in request gets exactly what it gets today.

The check costs no database read. `lib/session.ts#openSession` verifies the HMAC and the expiry. The session
cookie is already `HttpOnly; Secure; SameSite=Lax; Path=/`, and the built `index.html` loads scripts and fonts
with `crossorigin` (anonymous), which sends cookies on same-origin requests. So every script, preload, font,
wasm and worker fetch carries the cookie with no client change.

## What a signed-out visitor gets afterwards

| Request, with no valid session | Answer |
|---|---|
| A navigation to `/` or `/leave/123` | `302 /auth/login?next=%2Fleave%2F123`, then Google. Empty body. |
| `/assets/*`, `/theme-init.js`, `/manifest.webmanifest`, or any other path | `401`, empty body. The same answer for existing and missing files, because the gate runs before the asset lookup. |
| `/favicon.svg`, `/apple-touch-icon.png`, `/icon-192.png`, `/icon-512.png`, `/icon-maskable-512.png`, `/push-sw.js` | Served by the asset layer. The Worker is never invoked. |
| `/v1/*` | Unchanged. Middleware answers before routing, so paths cannot be enumerated. |
| `/auth/*`, `/found/*`, `/calendar/*`, `/esign/*`, `/diag`, `/healthz`, `/readyz` | Unchanged. |
| Access mode with no valid Access JWT | `401` for everything, navigations included. In Access mode `/auth/login` bounces to `/`, so a redirect there would loop. |

Why the icons and `push-sw.js` stay public:
- Home-screen installers, WebAPK icon fetches and notification icons fetch these without a guaranteed session.
- The files hold only the brand mark and two push handlers.
- The shell is gated, so nothing links a signed-out visitor to them.

## Design

### 1. Routing config: both wrangler files

- Set `run_worker_first = ["/*", "!/favicon.svg", "!/apple-touch-icon.png", "!/icon-192.png", "!/icon-512.png", "!/icon-maskable-512.png", "!/push-sw.js"]`.
  - Checked in wrangler 4.131: `parseStaticRouting` accepts `!/` rules.
  - The miniflare router matches negative rules first and sends them straight to the asset worker.
  - `/*` must be the only positive rule, because wrangler rejects any rule that a trailing-`*` rule makes
    redundant.
  - Keep it **on one line**. Both `scripts/preflight.ts:111`'s `value()` regex and the spaFallback regex read a
    single line.
- Set `preview_urls = false`.
  - Every uploaded version, including every build from before the gate, is otherwise served at
    `<version-prefix>-hrms.<subdomain>.workers.dev`, and those versions have no gate.
  - Neither toml file sets this today. `getSubdomainValues` leaves it `undefined`, so the live value is whatever
    the dashboard holds.
- Rewrite both `[assets]` comments. `WORKER_OWNED_PREFIXES` (`src/index.ts:157`) stays: it still decides "404
  here" and drives the Vite proxy test. It no longer mirrors `run_worker_first`, so rewrite its comment too.
- Add `export const PUBLIC_FILES` next to `WORKER_OWNED_PREFIXES`. It is the single source for the negative
  rules, and a test pins both toml files to it.

### 2. Worker

**One identity function.** Extract `src/middleware/auth.ts:270-324` unchanged into
`export async function resolveBrowserIdentity(c): Promise<{ email: string; sessionIat: number | null }>`.

- It covers the dev bypass, then the Google cookie, then the Access JWT.
- It throws the same `unauthenticated(...)` errors as today.
- `auth` calls it. The gate calls it too, so the two can never disagree about which mode is on.
- API-key bearers are deliberately not accepted, because machines don't need the SPA.

Also cache the imported HMAC `CryptoKey` per isolate in `lib/session.ts`. Today every `openSession` call
re-imports it, and the gate calls it on every asset request.

**The static-site handler**, `src/http/staticSite.ts`. It is called from `app.notFound`, which already catches
everything the routes don't claim, for every method:

1. A worker-owned prefix gets a 404 problem+json, as today.
2. A path in `PUBLIC_FILES` goes to `ASSETS.fetch`. With the config above this is never reached; it is here so
   that a config change cannot break the icons.
3. Call `resolveBrowserIdentity(c)`. If it throws anything, refuse:
   - It is a navigation if `Sec-Fetch-Mode === "navigate"`. When that header is missing, it is a navigation if
     the method is GET or HEAD and `Accept` includes `text/html`.
   - A navigation gets a 302 to `/auth/login?next=…` (no `next` for `/`). Anything else gets a 401.
   - In Access mode the answer is always a 401.
   - Both carry `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`,
     with an empty body.
4. Any method other than GET or HEAD gets a `405` with `Allow: GET, HEAD`. Today it gets the shell.
5. Otherwise call `ASSETS.fetch(c.req.raw)`. Passing the raw request lets `If-None-Match` and `Range` through,
   so revalidations get a 304.
   - If the answer is not a 404, return `new Response(res.body, res)`. The binding's headers are immutable, and
     `requestId` still adds one. This is the same re-wrap the shell path does at `index.ts:441`.
6. A 404 on a path that `LOOKS_LIKE_A_FILE` gets a 404 problem+json, as today.
7. Anything else gets the shell, as today, with its status passed through.

`_headers` still applies to every response that comes out of the binding. `index.ts:435` already relies on this.

### 3. Headers: `web/public/_headers` and `web/index.html`

- **`/assets/*`:** `private, max-age=31536000, immutable`. `public` lets a shared cache hand a copy to someone
  with no cookie, for example a TLS-inspecting corporate proxy.
- **`/assets/pdfjs/*`:** `private, max-age=86400, must-revalidate`.
- **The shell, `theme-init.js` and the manifest:** `private, no-cache`.
- **`<link rel="manifest" … crossorigin="use-credentials">`:** browsers fetch the manifest without cookies unless
  told otherwise, so without this it would get a 401 and the app could not be installed.

### 4. Land on the page they asked for

Today every sign-in lands on `/`, because `redirectToLogin` passes no path.

1. `/auth/login` stores `safeNext(query.next)` in an `hrms_oauth_next` cookie with the `OAUTH_COOKIE` shape.
2. `/auth/callback` reads it, deletes it, and redirects there, or to `/`.
3. `safeNext` accepts a value only if all of these hold. It returns the normalised `pathname + search`.
   - It is a string of at most 2048 characters.
   - It starts with `/`, and its second character is not `/` or `\`.
   - It contains no control characters.
   - `new URL(v, origin).origin === origin`.
   - The path is not under `/auth/`, which prevents loops.
4. The SPA's `redirectToLogin` (`api.ts:38`) and the "Session expired" link (`App.tsx:499`) pass
   `next=location.pathname + location.search`.

### 5. Client: a chunk that fails while signed out

Today, a lazy chunk that 401s shows the ErrorBoundary's "This tab is out of date" message
(`ErrorBoundary.tsx:59`), and its Reload button goes to Google. Both are wrong for this case. The fix:

- **In `api.ts`:**
  - Add `sessionLapsed()`. It sends a raw `GET /v1/users/me` and returns true only on a 401; a network error
    counts as false. Concurrent calls share one request.
  - Add `waitForSignIn()`. It raises the existing session-expired handler once, and resolves when the dialog's
    check succeeds. `App.tsx:783` `onSignedIn` calls a new `notifySignedIn()`.
- **In `lazyPage.tsx#retryingImport`:** on a chunk-load error, run
  `if (await sessionLapsed()) { await waitForSignIn(); return load(); }`. Otherwise keep the current 300ms retry.
  - The Suspense fallback waits behind the dialog, and the page loads after sign-in with no reload.
  - A stale-deploy chunk still takes today's "out of date" path, because the probe tells the two causes apart.
    The probe runs only when a chunk fails.
- **Raw `import()`s** (xlsx, charts, pdf.js, zxing, replay) keep their own handling. They normally run after an
  API call has already raised the dialog.

### 6. The same browser after sign-out

- **Logout clears the cache.** Add `Clear-Site-Data: "cache"` to the `POST /auth/logout` response.
  - This drops the year-long cached bundle from that browser. Storage is already wiped
    (`UserMenu.tsx:46 purgeAll`) and API responses are already `no-store`.
  - Don't use `"storage"`: it would unregister `push-sw.js`.
  - Cost: that device downloads the bundle again on its next sign-in, and only after an explicit sign-out.
- **Back must not restore the old page.** On `pageshow` with `event.persisted`, call `sessionLapsed()`, and
  `location.reload()` if it returns true. The gate then turns the reload into a sign-in.
  - Without this, pressing Back after sign-out can bring the previous user's rendered page back from the
    back/forward cache.
- **Invariant, written into the `push-sw.js` comment:** the service worker must never get a caching `fetch`
  handler. A cached shell would bypass the gate.

## Things this cannot fix, and what to do about them

- **Builds published before the gate** were public. They may sit in web archives or caches: check
  `web.archive.org/web/*/<host>/*`. Preview URLs are closed by section 1.
- **`workers.dev`** is off: both wrangler files set `workers_dev = false`, so the custom domain is the only
  entry point, and preflight refuses a config without it.
- **The exported repository:** if the repository `exportProd.sh` pushes to is public, the source is public
  whatever this change does.
- **Visible by design:** the `/auth/login` redirect (client id, hostname), `/v1` 401 bodies, the health
  endpoints, and the token-guarded public pages.
- **Insiders:** every signed-in employee still gets every chunk, admin screens included.
  - Authz is enforced server-side on every `/v1` call.
  - Gating chunks by role would need a role read per chunk and a chunk-to-capability map that drifts. Not worth
    it.

## Deliberately not done

- **Cloudflare Access over the whole hostname:** it costs per seat beyond 50 users, which is why Google mode
  exists.
- **Checking `sessions_valid_from` in the gate:** that is a D1 read per asset. As a result, a revoked cookie can
  still fetch code for up to 12h, but it gets no data.
- **A WAF cookie-presence rule:** a cookie being present does not mean it is valid. The rule would only save
  invocations from scanners, which can no longer learn file names.

## Cost and risk

**Request budget.** Gated requests now count against the free plan's 100k Worker requests a day.

- **Cold load**, counted from the current `web/dist/index.html`: the shell, `theme-init`, 1 entry chunk, 4
  modulepreloads, 1 stylesheet, 2 preloaded fonts and the manifest. That is **11 gated requests** before the
  landing page's own chunks, fonts and illustrations.
- **Warm full page load**, with everything immutable already cached: about **3** (the shell, `theme-init` and
  the manifest revalidate, mostly as 304s).
- **In-app navigation:** only chunks never fetched before.
- **Daily estimate:** about `users × full loads × 3 + devices × deploys × cold-load size`. Measure the cold-load
  size on staging, and compare the total with today's `/v1` volume in the dashboard before going to production.

**When the quota runs out**, the router answers Worker-bound traffic with Cloudflare's 429 page (the
`limitedAssetsOnly` branch in the miniflare router). Today the shell would still load and every API call would
fail. After this change the shell is the 429 page too. It is the same outage with a different page.

**Latency** goes up by one warm Worker hop per asset, with an in-colo `ASSETS` fetch behind it. An isolate cold
start moves from the first `/v1` call to the shell request.

**Blast radius:** a gate bug blanks the app for everyone. Tests and staging go first. Rollback is
`wrangler rollback`; the version carries its own assets config.

## Files

- **Worker:** `src/middleware/auth.ts` (extract `resolveBrowserIdentity`), `src/lib/session.ts` (key cache),
  `src/http/staticSite.ts` (new), `src/index.ts` (`notFound` delegates, `PUBLIC_FILES`, comments),
  `src/routes/authRoutes.ts` (`next` cookie, `safeNext`, `Clear-Site-Data`).
- **Config:** `wrangler.toml` and `wrangler.staging.toml` (`run_worker_first`, `preview_urls`, comments),
  `scripts/preflight.ts` (message wording).
- **Web:** `web/public/_headers`, `web/index.html`, `web/src/api.ts`, `web/src/App.tsx`
  (`notifySignedIn`, `next` link, `pageshow`), `web/src/lib/lazyPage.tsx`, `web/public/push-sw.js` (invariant
  comment).
- **Tests:** `test/staticSite.test.ts` (new), `test/spaFallback.test.ts`, `test/googleAuth.test.ts`,
  `e2e/sessionExpiry.spec.ts`.
- **Docs:** `docs/00-overview.md` (request flow), `docs/deploy-security.md` (asset exposure, preview URLs),
  `docs/deploy.md` (`preview_urls` and `workers_dev`), a ledger entry in `docs/security-review.md`. Record the
  decision with `repowise decision add`.

## Verification

1. **`test/staticSite.test.ts`** drives `app.fetch` with a spy `ASSETS` in Google mode, using cookies from
   `sealSession`.
   - With no cookie, an expired one, a tampered one, one signed with another key, or one whose `iat` is in the
     future:
     - `GET /` and `GET /leave?x=1` as navigations get a 302 with the right `next`.
     - `GET /assets/a.js`, `/theme-init.js`, `/manifest.webmanifest`, `HEAD /` and `POST /leave` get the refusal.
     - The spy is **never called**.
   - With no `Sec-Fetch-*` headers, `Accept: text/html` gets a 302 and `*/*` gets a 401.
   - With a valid cookie: assets pass through with their headers, a missing file gets a 404, an app route gets
     the shell, and `POST /leave` gets a 405.
   - The dev bypass passes. Access mode with no JWT gets a 401 even for a navigation.
   - `/v1/users/me`, `/found/bad`, `/auth/login` and `/healthz` behave as they do today.
2. **`test/spaFallback.test.ts`:**
   - The existing shell cases now need an identity; mint a cookie.
   - The config test checks three things: both toml files have an identical one-line `run_worker_first`, it is
     `/*` plus negatives equal to `PUBLIC_FILES`, and `preview_urls = false`.
   - Using `import.meta.glob` over `web/public`: every `PUBLIC_FILES` entry exists, and every top-level public
     file is either listed, deliberately gated (`theme-init.js`), or unpublished (`_headers`, `.assetsignore`).
3. **`test/googleAuth.test.ts`:**
   - Run a `safeNext` table covering `/x`, `//evil`, `/\evil`, `https://evil`, `/auth/login`, control characters
     and an over-long value.
   - `/login` stores only a safe `next`.
   - Logout carries `Clear-Site-Data`.
4. **Type check and tests:**
   - Run `./node_modules/.bin/tsc` for the root and for `web`, and check `$?`.
   - Run vitest on the touched suites (this needs the sandbox bypass).
   - Run `npm run preflight`.
5. **E2E:** `npm run test:e2e -- e2e/sessionExpiry.spec.ts`, with a new case:
   - Clear the cookies and fulfil the next route's module request with a 401.
   - Expect "Signed out", not "This tab is out of date".
   - Restore the cookie and press continue. The route should render with no reload.
6. **Staging**, after `npm run deploy:staging`:
   - `curl -sI /` returns a 302 to `/auth/login`. `curl -sI /assets/<entry>.js` returns a 401. `/favicon.svg`
     returns a 200.
   - Signed in, the app loads, chunks come back `private, immutable`, and the shell carries no `Link` header.
     With Early Hints on, a `Link` header would replay chunk names to anyone.
   - A deep link after sign-in lands on its page.
   - Deleting the cookie in DevTools and then clicking to a route not loaded yet shows the dialog.
   - Sign out, then press Back: the page reloads into sign-in.
   - Count the gated requests in a cold load and in a warm load for the budget sum.
   - In the dashboard, preview URLs are off for both Workers.
7. **Production** deploy goes ahead only after the budget check passes. Then do the archive check.

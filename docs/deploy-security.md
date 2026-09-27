# Deployment security runbook

Operational controls that live outside the application code. Complete these before the first production deploy.
Current code-level posture and the open pre-launch items are in `production-readiness.md` (repo root);
`docs/security-review.md` is the archived 2026-07-04 review that preceded it, and predates both the scoped
API-key lane and direct Google sign-in.

## 1. Rate limiting (WAF)

The Worker enforces no volumetric limits.

**`npm run deploy` blocks until you say these rules exist.** `scripts/preflight.ts` cannot read the zone's WAF
config, so it requires a dated acknowledgement instead:

```
WAF_RATE_LIMIT_CONFIRMED=2026-09-10 npm run deploy
```

The date is the day you last verified the rules below in the dashboard. It is an error to omit it for a
production deploy, an error if it is not an ISO date or is in the future, and a warning once it is more than a
year old — a rule deleted in a later cleanup should not stay covered by a claim made before it existed. Named
preview environments (any config other than `wrangler.toml` — `--config wrangler.staging.toml`) get a
warning rather than a block.

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
| Match expression | `starts_with(http.request.uri.path, "/auth/") or http.request.uri.path contains "/esign/callback/" or http.request.uri.path eq "/diag"` |
| Count by         | IP source address (the only free-plan characteristic)                 |
| Period           | 10 seconds (fixed)                                                    |
| Requests         | **20** per 10s (≈120/min) — above any real sign-in or vendor retry rate |
| Action           | Block                                                                 |

`/auth/callback` does real work per request (a Google token exchange + JWKS verify) and `/esign/callback/*`
runs a provider lookup + HMAC compute before its signature check rejects, so this IP bound blunts a flood
before either path burns budget.

`/diag` is in that expression for a reason of its own: it is unauthenticated, accepts up to 1 MB, and makes an
OUTBOUND request per call. The envelope's DSN is pinned to this project so it cannot be used to relay anywhere
else (`src/routes/diag.ts`), but nothing in the Worker stops a flood from burning the Sentry event quota or the
Worker's own egress. It is the only unauthenticated surface here that spends money per request.

Three more unauthenticated surfaces deserve a rule the moment you have more than one: `/found/*` (the public
asset-tag lookup, which hits D1 on every call and is exactly the shape a token-guessing sweep would hammer),
`/calendar/holidays/*` (the subscribable holiday feed - same shape, and calendar clients poll it on their own
schedule) and `/readyz`. On Free, fold `/found/*` and `/calendar/*` into the single rule's match expression if
either is enabled publicly.

`/readyz` is the least urgent of the three: it is an unauthenticated `SELECT 1` against D1, but `src/index.ts`
caches a READY answer in the isolate for 5 seconds, so a flood costs at most one D1 read per isolate per
window rather than one per request. A failing probe is deliberately NOT cached - an outage is still reported
on the first call after it starts, and recovery on the first call after it ends. A WAF rule on it is still
worth having once rules are not scarce; it is no longer a quota risk on its own.

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
| `POST /diag`                                    | unauthenticated; 1 MB in, outbound fetch out | ~60 / min / IP    |

### What the app enforces on its own

The Worker carries an **isolate-local floor** under both the unauthenticated lanes (`lib/isolateRate.ts`) and,
per caller, inside `/v1` (`middleware/rateLimit.ts`). Neither is the rate limit and neither replaces the rules
above: a Worker cannot see traffic an edge rule blocks, and a counter living in one isolate's memory is not a
limit across a fleet of them — a caller spread over enough colos gets one allowance per isolate.

What the `/v1` floor does buy is that authentication no longer implies *unlimited*. It is keyed on the API key
where there is one and on the user otherwise (so a busy integration cannot spend its owner's browsing budget),
it skips batch sub-requests (they were already charged to the envelope), and it refuses with `429` plus
`Retry-After`. Four budgets, per caller per isolate-minute:

| Budget    | Covers                                                                          | Limit |
|-----------|---------------------------------------------------------------------------------|-------|
| `render`  | `:generateLetter`, `:generateForm16`, `:previewLetter`, `:previewTemplate`, `:bankFile`, `:statutoryReport` | 40 |
| `fan-out` | `/v1/search`, `/v1/people-analytics`, `/v1/dashboard-summary`, `/v1/approvals-summary`, `/v1/activity-counts`, `table-views/*:run`, `cron-runs:run` | 120 |
| `batch`   | `POST /v1/batch:run`                                                             | 600 |
| `api`     | everything else under `/v1`                                                      | 3000 |

They are sized so a person driving the UI hard never reaches one — they bound automation and accidents, not
people. The catch-all is deliberately very loose (50 req/s sustained from one credential is not a person):
cost concentrates in the first two rows, and the budget is per *caller*, which the browser suite exercises as
a single user against one isolate. Tighten them at the WAF, not here, if a real limit is what is wanted.

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

## 3b. Network fence on the attendance clock — optional

`ATTENDANCE_ALLOWED_IPS` (`wrangler.toml [vars]`, comma-separated individual IPs and/or CIDR blocks, IPv4
and IPv6 mixed freely) restricts `attendance/me:clockIn` / `:clockOut` to the listed networks — the office
egress addresses and the VPN — so an employee cannot punch in from home. Unset or empty means no fence.

Three properties make it a control rather than a hint. The client address is read **only** from
`cf-connecting-ip`, the address Cloudflare itself observed; `x-forwarded-for` is client-supplied and is
trusted for the audit trail but never for this decision. A punch whose client IP cannot be established is
refused, so the fence fails closed. And a malformed entry throws at `makeDeps` rather than matching
nothing, because a silently narrowed fence locks the whole office out with no explanation.

**Approved remote work eases it, for that period only.** The fence asks "are you at work?", and an APPROVED
`remote-work-requests` row is the sanctioned answer "no, and that was agreed" — so an off-network punch is
admitted for exactly the approved dates and is fenced again the moment they end. Only `APPROVED` counts:
were `PENDING` enough, filing a request would be a self-service bypass. Half-day sessions are honored (an
afternoon-only approval does not excuse a 09:00 punch), and the punch is placed on its **org-timezone** day —
the same timezone that decides a punch's calendar day everywhere else. The lookup runs only after the IP
misses, so an in-office punch still costs no extra read.

It fences the two self-service punches only. HR attendance-regularizations are deliberately unfenced — a
missed punch stays correctable from anywhere, which is what keeps the fence from becoming an attendance
outage.

## 3c. Cutting off a session — the break-glass

Sessions are **stateless**: the cookie is `payload.HMAC` signed with `AUTH_SESSION_KEY`, nothing is stored
server-side, and there is no per-session revocation list. Read on its own that sounds like "a stolen cookie
is good for 12 hours" (`SESSION_TTL_MS` in `src/routes/authRoutes.ts`). The real exposure is much narrower,
because the cookie proves only *which email* is calling - never what that email may do:

- `src/middleware/auth.ts` loads the `users` row on **every** request and throws `forbidden("user disabled")
  ` when `status !== "active"`. So setting a user inactive takes effect on their **next call**, live cookie
  or not.
- Role and access rules are re-read on every request too (behind a seconds-long cache), so a demotion lands
  just as fast. A cookie cannot carry stale authority, only a stale identity.
- The scoped API-key lane goes through the same check against the key's **owner**, so disabling a person
  kills every key they own, with no separate revocation step.

**Cut off one person** (the normal case, effective immediately):

```bash
npx wrangler d1 execute hrms --remote \
  --command "UPDATE users SET status='disabled' WHERE email='leaver@acme.com';"
```

Do it in the app (Users → set inactive) when you can; the SQL is for when the app is what you have lost
access to. Revoke their Google Workspace account as well, or they can sign in again and be re-provisioned.

**Cut off everyone** (suspected `AUTH_SESSION_KEY` compromise, or an unknown session to invalidate):

```bash
npx wrangler secret put AUTH_SESSION_KEY   # a fresh `openssl rand -base64 32`
```

Every existing cookie fails its HMAC check at once and every user signs in again. It is the blanket lever,
it costs nothing but a re-login, and unlike the other two key rotations in §2 it destroys no data.

The gap that genuinely remains: a stolen cookie belonging to a user who **should stay enabled** cannot be
singled out - the choice is disable that user briefly, or rotate the key and sign everybody out. Both are
seconds of work. A revocation list would close it at the cost of a D1 read on every request, which is the
trade this design deliberately declines.

## 3d. App lock: the PIN, and the last-resort reset

A person can protect HRMS on their devices with a 4 or 6 digit PIN (design: `app-lock-plan.md`). While a browser
is locked, every `/v1` call from it answers `401 /errors/app-locked`, and a new sign-in starts locked, so
signing out and back in does not get past it. The server holds the lock: `app_locks` is joined into the auth
read (`src/middleware/auth.ts`, `src/services/appLock.ts`), and a browser is open only while it carries a valid
`hrms_unlock` proof cookie.

- The PIN is stored as HMAC-SHA256 under a key derived from `FIELD_ENCRYPTION_KEY`, so the table alone cannot be
  guessed offline. Rotating `FIELD_ENCRYPTION_KEY` therefore invalidates every PIN (and every browser's
  encrypted local store) as well as the PII it already protects.
- Wrong PINs: five free tries, then waits of 30 s, 1 min, 5 min, 15 min and one hour per try. The owner is
  notified at the third, and each threshold is audited as `user.pinFailed`.
- A forgotten PIN is reset by an admin: Settings → Users → Reset app PIN (`POST /v1/users/{id}:resetPin`,
  super admin by default, grantable in the ACL). It signs the person out everywhere and moves the key their
  browsers encrypt under. There is no self-service reset, because Google sign-in is usually one click on the
  very machine the lock protects.

**The last super admin forgot their PIN** (nobody left who can reset it in the app):

```bash
npx wrangler d1 execute hrms --remote \
  --command "UPDATE app_locks SET pin_hash=NULL, pin_length=NULL, failures=0, blocked_until=NULL, key_epoch=key_epoch+1 WHERE user_id=(SELECT uuid FROM users WHERE email='admin@acme.com');"
```

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

**No remote origin appears anywhere in the policy.** Every typeface - the UI font, the org wordmark and the
faces a board post can be set in - is self-hosted from `@fontsource` and ships as a same-origin bundled asset,
so `font-src` and `style-src` name no external host. The error tracker is reached the same way: the browser
posts every envelope to `/diag` on our own origin and the Worker forwards it (`src/routes/diag.ts`), so
`connect-src` stays `'self'`.

### Why telemetry goes through the Worker

The SPA used to POST straight to `https://o<org>.ingest.<region>.sentry.io`. That host is on the default
blocklist of every ad and tracking blocker (uBlock, AdGuard, Brave shields, Ghostery) and of most corporate
DNS/MITM filters. A blocked cross-origin POST comes back with no `access-control-allow-origin`, so the browser
reports `CORS Failed` and the SDK drops the event - **silently**. The failure mode is not "some reports are
missing", it is "an unknown share of your users report nothing and no one finds out".

Relaying through our own origin puts nothing blockable in the page's traffic. The path is `/diag` and says
nothing about the vendor on purpose: blockers match paths as readily as hosts, and Sentry's own documented
`/sentry-tunnel` is already a filter rule.

The relay is the app's only unauthenticated write-shaped surface - it makes an outbound request on an
anonymous caller's say-so - so it is written as one, and `test/diagRelay.test.ts` tests the refusals rather
than the happy path:

- **One destination.** The envelope's own `dsn` header is checked against the Worker's `SENTRY_DSN`, on host
  *and* project id. Anything else is a 403. Without that check this is an open relay: a stranger's envelope
  would be forwarded with our egress, at our quota, or bounced at a third party.
- **A body cap** (1 MB), so it cannot be used as a general upload endpoint. Replay segments sit well under it.
- **An isolate-local ceiling** (600 relays per minute per isolate), counted before the body is read so a
  throttled call costs neither the buffer nor the outbound request, and answered with 429 + `Retry-After`,
  which is what the SDK already backs off on. It is a **floor, not the control**: a Worker cannot see traffic
  an edge rule blocked, and a per-isolate counter is not a limit across a fleet of them. The WAF rule in §1 is
  still the mechanism, and `npm run preflight` still blocks a production deploy until it is confirmed. What
  this buys is that the sharpest of the unauthenticated routes is not *unbounded* while that is outstanding -
  the DSN it forwards under is baked into the public bundle, so burning the org's event quota needs no
  credential.
- **No client IP.** The relayed request presents the Worker, so the tracker records that rather than the
  employee's address. Deliberate: an error report never needed one, and adding `X-Forwarded-For` would be
  choosing to send staff IPs to a third party.
- **Only the rate-limit headers come back** (`X-Sentry-Rate-Limits`, `Retry-After`) - the two the SDK reads to
  honour a 429. Nothing else upstream returns reaches the browser.
- **Off unless configured.** No `SENTRY_DSN` on the Worker and the route 404s.

`SENTRY_DSN` is a plain `[vars]` entry, not a secret: a DSN only permits *writing* events and the same string
is already baked into the bundle as `VITE_SENTRY_DSN`. The two must match, or the relay refuses what the SPA
sends.

`worker-src 'self' blob:` (and `child-src`, which is what Safari <= 15.4 reads instead) is there for the same
SDK: session replay compresses its recording in a Web Worker constructed from a blob URL, and under
`default-src 'self'` that constructor throws somewhere nothing catches it - replay silently records nothing
while looking configured. The widening is small, because building a blob Worker already requires script
execution in the page and `script-src` still governs that. Self-hosting the worker (`workerUrl`) would avoid
the token at the cost of an unhashed asset in `web/public` plus a copy step.

### Error tracking beyond the browser

**The Worker reports too.** `src/index.ts` wraps its handler in `withSentry` from `@sentry/cloudflare`, so an
unhandled throw anywhere on the server becomes an issue instead of a bare 500 nobody sees. It stays inert when
`SENTRY_DSN` is unset (that is the SDK's documented way of switching off), so local development is unchanged.
Because the browser already sends `sentry-trace` on every `/v1` call, one trace now spans the click, the API
request and the D1 work behind it. `sendDefaultPii: false`: request bodies here are payroll and personal data,
and nothing needs them to report an error.

**The nightly cron has a check-in.** `withMonitor` opens a Sentry check-in around the `0 2 * * *` run - leave
accrual, reminders, digests - and closes it ok or error. That alerts on a run that FAILS and, more usefully, on
one that never arrives: a scheduled job that silently stops has no error to catch, and the symptom otherwise is
a wrong leave balance noticed weeks later. The 5-minute drain is deliberately not monitored - it is
self-correcting, and a missed one is made up by the next.

**Source maps are uploaded and then deleted.** `web/vite.config.ts` runs `sentryVitePlugin` when
`SENTRY_AUTH_TOKEN` is present, and map generation is tied to the same condition. That pairing is load-bearing:
generating maps unconditionally left them sitting in `web/dist`, which is exactly what gets uploaded to
Cloudflare, so a build without a token would have served the entire unminified source to anyone who asked.
Maps are emitted `hidden` (no `sourceMappingURL` comment), uploaded, then removed by
`filesToDeleteAfterUpload`.

`SENTRY_RELEASE` (Worker) and `VITE_APP_VERSION` (SPA) must be the SAME string, or the maps are uploaded
against a release no event claims and traces stay minified with nothing to explain why. `npm run preflight`
warns when either is missing.

**A last-resort scrub.** `beforeSend`/`beforeBreadcrumb` in `web/src/instrument.ts` redact PAN, IFSC, Aadhaar
and bare account-number shapes from message text, exception values and breadcrumb URLs. Masking governs the
screen; this governs the text of an event, which masking never touches - a validation error quoting the value
it rejected, a URL with an account number in it. The patterns are narrow on purpose: a greedy "looks like
digits" rule would redact dates and counts and make every issue unreadable, which is its own way of losing the
data. It is a net under the deny-list, not a replacement for it.

### What session replay can and cannot see

> Recording staff working inside an HR system needs a **written notice to employees**, a stated retention
> period on the tracker, and a named list of who may watch a replay - none of which are engineering
> controls. `docs/session-recording-notice.md` carries the notice text to publish and the three decisions to
> take before launch. This section is the mechanism behind it.

Replay records the DOM. The masking policy lives in one object, `REPLAY_PRIVACY` in
`web/src/instrument.ts`, and it is **unmask-by-default**: text, inputs and media are recorded, and only what is
listed there is hidden.

That is the opposite of the SDK's default, and it is a deliberate trade. A replay where every label reads
`*****` shows the shape of a page and nothing about what went wrong on it. **The failure mode inverts with
it:** under mask-by-default, forgetting to tag a field leaked nothing; here, forgetting leaks it. The list is
therefore built out of things that do not depend on anyone remembering:

- **Three routes, not fifteen.** `<main>` carries `data-page="<route key>"` (App.tsx) and `SENSITIVE_PAGES`
  masks the container subtree for `payslips`, `payroll-runs` and `documents` - the pages where practically
  everything on screen is a value.

  It used to be fifteen, including expenses, vendors, compliance, reimbursements, background checks, settings
  and the employee profile, and that was the mistake. Masking those masked their headings, hints, statuses,
  dates and category names: ordinary business data that tells you what a person was looking at. The replays
  came out unreadable everywhere without being meaningfully safer, because route masking is the wrong
  instrument for a page that is mostly chrome around a few numbers. Add a route only when masking the whole
  page loses nothing worth reading.

  Within those three, `unmask` puts the structure back - rrweb resolves each text node by DISTANCE, the nearer
  of a matching `mask` and `unmask` ancestor winning - for headings, `th`, `label`, `button`, `nav` (the
  workspace tab strip), `#page-description`, `[role="tab"]`, `[role="alert"]` and `[data-sentry-unmask]`
  (which `EmptyState` carries: "No payslips yet" is standing copy, and the emptiness is often the bug).

- **The sensitive panels and dialogs, named individually.** What replaced the other twelve routes lives closer
  to the data: the seven profile sections carry `sentry-mask` on both the panel and its editing dialog -
  `EmployeeBankDetails`, `EmployeeCompensation`, `EmployeeTaxDetails`, `EmployeeSettlement`,
  `EmployeeBonuses`, `EmployeeIdentityDetails`, `EmployeePersonalDetails`. A dialog needs its own tag because
  it renders through a PORTAL, as a child of `<body>`, where no ancestor says which page it was opened over.

  Per-panel means somebody has to remember, and forgetting fails SILENTLY - the panel works, the replay
  records, the account number is simply in it - so `test/replayMaskCoverage.test.ts` asserts the tag on all
  seven and that `instrument.ts` still masks on that class, while `e2e/replayMasking.spec.ts` proves the class
  masks at all and that its neighbours are untouched.

- **Attribute conventions, not class names.** `data-sentry-mask` (text hidden, layout kept) and
  `data-sentry-block` (element replaced) survive a restyle in a way a CSS class does not. Use them on anything
  showing money, an identity number, a bank account, a medical detail or a document that can appear OUTSIDE
  those routes - a dialog opened from the dashboard, a drawer on a board.
- **Field shape.** `input[type=password]`, `autocomplete="cc-*"`, and name matches for account/IFSC/PAN/
  Aadhaar/UAN - matched on what the browser already knows about a field rather than on app markup, because
  those attributes exist for the password manager and are stable. Fixed-format identifiers, worth something to
  whoever reads them, and impossible to change once leaked.

  `amount`, `salary` and `ctc` were on that list and are not any more: they matched an input on nearly every
  form in the app - expenses, reimbursements, loans, bonuses, budgets - so an ordinary expense claim recorded
  as a row of labels around one box of asterisks. Money where it IS the point is covered by the three masked
  routes and by the compensation panel; a figure someone typed into an expense claim is not the same class of
  secret as their PAN.
- **Authored copy is never masked, wherever it sits.** Masking hid the things WE wrote as readily as the
  things a person entered, which is what made a masked panel unreadable rather than merely discreet - a form
  of `***` labels around `***` boxes. Three fixes, all in shared primitives so they hold everywhere:
  `maskAttributes: []` (the SDK defaults to masking `title`, `placeholder` and `aria-label`, none of which
  carries a value of anybody's); `data-sentry-unmask` on `Field`'s hint and on `CardTitle`/`CardDescription`,
  which are `<div>`s and so are reached by no heading rule; and `dt` on the unmask list, because a
  definition-list TERM is the label and the `<dd>` beside it is the value.

- **`iframe` and `canvas` are blocked outright.** Neither is text, so masking would not touch them, and every
  iframe this app creates is a rendered PDF - a payslip, a letter, a Form 16.
- **Keystrokes** in search and file inputs are never recorded (`ignore`): what someone types into a search box
  is often the thing they would never put in a ticket.

The residual exposure is real and worth stating: on any route NOT in `SENSITIVE_PAGES`, a replay shows what
was on screen, verbatim - names, email addresses, ticket text, board cards, announcements, chat-like
comments. That is the point of the change, and it is also its cost.
- Network bodies and headers stay off (`networkDetailAllowUrls` unset, `networkCaptureBodies: false`). URL,
  method, status and byte counts are recorded; the `/v1` JSON is not.
- `replaysSessionSampleRate: 0` with `replaysOnErrorSampleRate: 1` - nothing is uploaded while the app is
  working. The SDK holds recent activity in memory and discards it at session end; an error flushes it.
  Continuously recording a share of all sessions was rejected deliberately: it is surveillance of people doing
  their HR admin, and it is not needed to reproduce a crash.

A replay therefore leaves the browser in exactly two cases. The first is an unhandled error. The second is a
person deciding it should, through **Report a problem** (the top bar's support menu, the command palette, or
the phone create menu). That dialog - `web/src/components/common/ReportProblemDialog.tsx` - is the only place
that calls `captureSessionReplay()` to flush the buffer. Every report made through it carries a recording -
there is no per-report toggle, because a toggle mostly produced reports with the useful half missing - and the
dialog says so on its face, in a line naming what is and is not in the recording. Stated, not asked: the
people recorded are employees looking at their own salary and identity documents, and a recording they were
not told about is monitoring rather than debugging. Raising an ordinary support ticket never captures one.

**The flush happens when the dialog OPENS, not when it is sent**, and that timing is the feature. The buffer
is not a rolling 60-second window. rrweb takes a full snapshot every 60 seconds and the SDK clears the buffer
on each one, so what is held is everything since the last snapshot: a sawtooth between 0 and 60 seconds,
averaging 30. A flush landing just after a checkout keeps only a few seconds no matter how long the person had
been working - so every second spent reading the dialog and typing into it is a second of the fault lost, and
capturing at submit reliably produced a recording of someone filling in a form. Opening the dialog keeps the minute that led to "something is wrong".
**"Record the problem" is the manual mode.** It sits under the fields, at the foot of the dialog: the form
hides, a `Recording · 0:47` countdown appears in the top bar with a Stop button, and the person goes and
reproduces the fault. At zero, or on Stop, the form comes back with everything they had typed still in it.
Below the fields rather than above them because the form is what most people came to fill in, and an action
that empties the screen sitting above the first input reads as the thing to do first.

**The disclosure lives on the success toast, not in the dialog.** Sending says "Problem reported - Screen
recording attached", or "The recording was too short to include" when there was nothing to send. It moved
there because the dialog is a form and standing text above a button is text people stop seeing; the toast
lands at the moment the thing actually happens, and it says which of the two happened rather than describing
the feature in general. The requester also sees the recording on their own ticket, where the drawer renders
it as a "Session recording" link.

What is NOT acceptable is neither: a screen recording sent with no indication to the person recorded is
monitoring rather than debugging, whatever the intent. `e2e/reportProblem.spec.ts` asserts the toast text for
that reason, so it cannot quietly disappear in a later edit. Nothing extra is
switched on for it - the flush below already put the recorder in continuous mode under one replay id, so this
is a UI state, and what the ticket links to is one recording holding the run-up, the form and the
demonstration. Bounded at two minutes and shown as a live countdown on purpose. Two rather than one because reproducing a
fault usually means navigating somewhere, filling something in and waiting for a response, and a timer that
expires mid-demonstration wastes the attempt and the recording together; bounded and visible because an
indefinite "you are being recorded" pill is the kind of thing people stop noticing, and this is not an app to
stop noticing it in. Doing
nothing is still the default - a report made without touching it behaves exactly as before.

**Recording stops when the flush happens.** `captureSessionReplay()` flushes with `continueRecording: false`
and immediately restarts the buffer, which leaves the app where it began: the last minute in memory, nothing
uploaded, waiting for the next error or report. At its default the flush would convert the recorder to session
mode and never stop - the whole rest of that browser session recorded continuously, for someone whose only act
was to report a bug. It was configured that way for a while, on the reasoning that support's first question is
"can you reproduce it?"; what it actually produced was open-ended recording of people who had reported one
thing, which is not a trade worth making silently.

**Continuous recording happens in exactly one place**: the two minutes of a demonstration the person started
themselves, between `startManualRecording()` and `finishManualRecording()`.

The window survives a reload. The SDK's replay session is sticky (`sessionStorage`), so a refresh
mid-demonstration leaves the recorder running, and the countdown chip used to be React state a reload threw
away - a recording continuing with nothing on screen saying so and no way to stop it, which is the one state
this feature must never reach. The deadline is stored beside the SDK's own session, so the chip comes back with
the time actually remaining; past the deadline the recorder is stopped on mount.

That window is a REPLAY OF ITS OWN. `start()` always creates a new session, so the recording begins when Record
is pressed and holds nothing else; `stop()` flushes the final segment and ends it, and buffering resumes.
Converting the existing session with `flush()` was tried first and is wrong twice over: the demonstration was
glued onto the run-up and the dialog being read, with no boundary marking where the person started
demonstrating, and the recorder had been running continuously since the page loaded. Buffer mode cannot serve
the window either - it clears on a full snapshot every 60 seconds, so a two-minute reproduction would arrive
missing its first half.

The demonstration is what the ticket links to: it holds the fault happening on purpose, which is worth more
than the minute before somebody decided to report it. **Unless it was too short to exist** - the SDK discards a
replay under `minReplayDuration` (5s), so a window stopped straight away would leave the ticket pointing at a
recording Sentry threw away. Below that floor the run-up captured when the dialog opened is kept instead: a
real recording of something beats a dead link to a better one.

**Breadcrumbs carry the long history instead of video.** `maxBreadcrumbs: 300` (up from the default 100):
every click, navigation, fetch and console line for the whole session, timestamped and attached to the issue.
The replay covers at most the minute before a report; this is what answers "what were they doing before that",
and it costs nothing in quota and collects nothing that was not already being collected.

The 60s window is not a tuning choice. `BUFFER_CHECKOUT_TIME` is a hardcoded constant in `@sentry/replay`, so
buffer mode holds one minute and no more. A longer window is only reachable by switching replay to session
mode, which records continuously from page load and uploads as it goes - every session of every user, whether
or not anything is ever reported. That is a different product decision (and a different legal one) than
keeping a minute in memory against the chance it is asked for.

The resulting id is stored on the ticket (`tickets.session_replay_id`, validated server-side as 32 hex so a
URL cannot be smuggled in) and rendered in the ticket drawer as a link to the Sentry console - which needs a
Sentry login, so being able to read the ticket is not the same as being able to watch the recording.

The residual exposure is what the layout itself tells you - which page someone was on, which fields a form
has, roughly how long a value was - plus request URLs, which carry record ids. Treat replays as
restricted-access data in Sentry accordingly.

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

## 5a. Who can download the app

A signed-out browser receives none of the app's code. The shell, every JS/CSS chunk and every client-side
route reach the Worker first (`run_worker_first = ["/*", ...]`), and `src/http/staticSite.ts` answers them
only for a verified session - the same credential check `/v1` starts with, at no D1 read:

| Request, no valid session | Answer |
|---|---|
| A navigation (`/`, `/leave/123`) | `302 /auth/login?next=<path>`, empty body - no HTML, so not even a script tag |
| Any other gated path (`/assets/*.js`, `*.css`, `/index.html`) | `401`, empty body - the same whether the file exists or not |
| Access mode, no Access JWT | `401` for everything (its `/auth/login` bounces to `/`, so a redirect would loop) |

A loader script that checks the session before fetching the rest would not do this: the chunks would still be
public files, and one known name (a proxy log, a pasted stack trace, an ex-employee's history) leads to the
entry chunk's list of all the others. Only a refusal before the asset store is asked closes it.

What the gate does not check, deliberately: the user's revocation stamp (`sessions_valid_from`), which is a D1
read per request. A cookie that was signed out elsewhere can still fetch code for the rest of its 12 hours,
but it gets no data - `/v1` does check the stamp.

**The media tier.** Fonts, images, icons, illustrations, stickers and pdf.js data (`EDGE_PATHS` in
`src/http/assetPaths.ts`) are served by the asset layer WITHOUT the Worker, because each Worker invocation
counts against the Free plan's 100,000 requests a day and these are the bulk of the files - 2,036 of the 2,084
in a build, against 45 code files. A WAF **custom rule** guards them instead: Block, for this app's hostname
and those paths, unless the request carries the `hrms_edge` cookie. The Worker hands that cookie to every
signed-in browser (30 days, re-issued when stale, deleted on sign-out).

This tier is weaker on purpose, and the trade is only made for files that carry nothing of the application:

- The Free plan's rule language cannot verify a signature: `matches` (regex) is Business+,
  `is_timed_hmac_valid_v0` and the `http.request.cookies` map are Pro+. What is left - `http.cookie
  contains`, `wildcard`, `in` - can only compare one shared value.
- So `EDGE_KEY` is a single random value every signed-in browser holds, and a former holder keeps it until it
  is rotated. It is still unguessable from outside (43 characters of base64url), and the media's hashed names
  are referenced only from gated code, so the key alone does not say what exists.
- Custom rules are a separate allowance from the one Free-plan rate-limiting rule in §1 (five of them), so
  this does not compete with the sign-in rate limit.
- The rule only reaches hostnames in a Cloudflare zone. On `*.workers.dev`, media is unguarded (the code is
  still gated there) - another reason for `workers_dev = false` once the custom domain is live.

Setup and rotation are `npm run edge:rule` (`scripts/edgeRule.ts` explains both); the steps, and why the Worker
must get the key a day BEFORE the rule is switched on, are in `docs/deploy.md` step 10. Rotate after someone
leaves who should lose it: `--rotate` makes the rule accept both keys while browsers pick up the new one, and
`--drop-previous` a few days later retires the old. `npm run preflight` warns until `EDGE_RULE_CONFIRMED` is set
to the date the rule was verified; it cannot block, since the rule can only go on after a deploy.

**What else stays visible, by design:** the `/auth/login` redirect (the Google client id and the hostname),
`/v1` 401 bodies (the middleware answers before routing, so paths cannot be enumerated), the health probes and
the token-guarded public pages. A signed-in employee still downloads every chunk, admin screens included -
authorization is enforced by `/v1`, not by hiding code, and gating chunks per role would need a role read per
chunk and a chunk-to-capability map that drifts.

**Other doors to the same bytes:**

- `preview_urls = false` in both wrangler files, because every uploaded version - including builds from
  before this gate - is otherwise served at its own public version URL.
- `/assets/*` is cached `private`, never `public`, so a shared cache (a TLS-inspecting corporate proxy) cannot
  keep a copy for the next person.
- Sign-out sends `Clear-Site-Data: "cache"`, so the year-long cached bundle does not outlive the session on a
  shared machine, and a page restored from the back/forward cache re-checks its session and reloads into
  sign-in.
- `web/public/push-sw.js` must never gain a caching `fetch` handler: a cached shell would be served to whoever
  opens the browser next, without reaching the gate.
- Builds served before the gate went live were public, and may sit in web archives or caches
  (`web.archive.org/web/*/<host>/*`). The gate protects every build from here on; it cannot recall those.

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

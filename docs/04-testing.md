# 04 — Testing

`npm test` runs the whole suite with Vitest under `@cloudflare/vitest-pool-workers`: **165 files, 1974
tests**. Pure-domain files need no Worker runtime and are the fastest signal; service, route and flow files
run against the real `workerd` with live D1 and R2 bindings, applying the migrations from
`src/db/migrations/` into a fresh database per file.

`npm run verify` (`api:lint` → `typecheck` → `test`) is the only gate that matters. It runs as a pre-commit
hook (`.husky/pre-commit`, installed by `npm install`) and in CI (`.github/workflows/verify.yml`).

> **A false green to know about.** If the local command sandbox denies `.dev.vars`, the pool fails to build
> its Miniflare options, vitest reports `Test Files no tests` and still **exits 0**. A run that says "no
> tests" has not tested anything. Rerun outside the sandbox and confirm the counts.

## The suite by family

**Authz engine** (pure, fast, the heart of the system) - `permissions` (path matcher `*` / `**` / `me` /
`my-dept` / `<prefix>-*`, the read < write < admin ladder, deny-wins, fail-closed on unknown), `codes`
(hierarchical compose/parse, boundary match), `grants`, `manifests`, `access` (list scope), `compileGrants`,
`policyValidate`, `ruleLogic`, `loadGrant`, `authzResolve` (request path → permission key), `keyScope`.

**Access enforcement over real requests** - `bola` (cross-employee and cross-dept denial), `parity`
(route × role), `listScope` and `usersListScope` (breadth binding, fail-closed on unset), `createGate`,
`fieldAccess` (protected fields), `grantExceptions`, `roleObjectRules`, `accessRuleScope`, `accessLifecycle`,
`accessPreview`, `accessHint`, `collectionVerbGrant`, `auditAccess`, `ticketShares`, `viewAs`, `apiKeys`,
`sessionBinding`, `googleAuth`, `cache`.

**Invariant / drift gates** (these are what keep conventions true without anyone remembering them):

| Test | What it fails on |
|---|---|
| `singleSource` | any access decision found in a service or route (the DoD #1 gate) |
| `collectionLaneDrift` | a hand-rolled standard method, or a bespoke purge nothing calls |
| `openapiRoutesDrift` / `customMethodsDrift` | code and `openapi.yaml` disagreeing on paths or verbs |
| `serializerContractDrift` / `requiredReadOnlyDrift` | serializer output drifting from the contract |
| `wireRegistry` | a collection reachable by authz that is not wire-tokenized |
| `seedDrift` / `manifestSeedDrift` / `searchDdlDrift` / `payslipTemplateDrift` / `ticketWorkflowDrift` | a generated artifact (seed rows, policy manifest, FTS DDL, templates, ticket workflow) not regenerated after its source changed |
| `manifestCompleteness` / `webAccessCoverage` | a collection missing policy entries, or a page missing its access affordance |
| `reparenting` | a hierarchical table missing from the code-cascade set |

**Money and payroll** - `payroll` (totals, rounding, run state machine), `money`, `currency`, `moneyFlow`,
`statutory`, `incomeTax`, `taxProjection`, `compensation`, `payComponentWrite`, `settlement`, `encashment`,
`carryForward`, `loanRepayment`, `attendanceLop`, `bankFormats`, `letters`, `payslipTemplate`.

**Feature flows** (workerd + D1, end to end through the HTTP app) - `ats`, `cardsFlow`, `expensesFlow`,
`reviewFlow`, `workflowsE2E`, `automations`, `scheduledAutomations`, `bootstrapAutomations`, `jobQueue`
(retry ladder, attempt cap, `run_after`, who gets notified, a failed nightly subtask turning its cron run
red), `documentAck`, `esign`, `employeeSignature`, `attendanceRegularizationFlow`, `checkInRecurrence`,
`complianceRecurrence`, `expenseBudgetRecurring`, `referrals`, `goalAlignment`, `kudos`, `kudosSelf`,
`boardEngagement`, `announcementDraft` / `announcementReadBy` / `announcementSticker`, `ticketRouting`,
`foundPage`, `assetTags`, `assetBatchCreate` (a delivery: quantity + serial list, one contiguous tag run),
`assetBulk` (the paste/scan parsing behind it), `globalSearch`, `dashboardSummary`,
`celebrations`, `listTruncation`, `employeeNumber`, `employeeCompleteness`, `profileCompleteness`.

**Platform** - `crypto` (field encryption round-trip, ciphertext ≠ plaintext), `idCodec` (round-trip,
determinism, collection binding, tamper and length rejection), `encodeWireIds` / `decodeWireIds`,
`stateMachines`, `richText`, `illustration`, `silhouette`, `activitySerialize`, `collectionFactory` (the
lane itself: paging, `?id`, `If-Match`, `?force`, lifecycle verbs, overrides, decorate).

**`productionReadiness`** is the cross-cutting safety net: payroll `deleteRun` releasing every paid-by-run
payout, leave reservation refusing to overdraw, the real auth + middleware + wire-id chain over
`/v1/users/me`, the `code` uniqueness backstop, and `ALLOWED_EMAIL_DOMAINS` gating first-login
auto-provisioning.

## The browser lane

`npm run test:e2e` runs the Playwright specs in `e2e/`. It is **not** part of `npm run verify` and never runs
on pre-commit: `verify` is the gate on every commit and has to stay fast and trustworthy, while a browser
lane fails for reasons a unit suite never does. CI runs it as its own workflow
(`.github/workflows/e2e.yml`), so "the code is wrong" and "the app did not behave" stay separate signals.

It exists because nothing else executes the React app. `tsc` checks the types, the vitest files above drive
the Worker, and the source scans (`responsiveCoverage`, `confirmCoverage`, `writeDialogCoverage`,
`webAccessCoverage`, `webReadDiscipline`) pin the front-end conventions **in the source**. None of them can
see a component that throws on mount, a dialog that posts the wrong payload, a list that never refreshes
after a write, or a page that logs an error.

**The stack** is `scripts/e2eStack.sh`, which Playwright starts itself. It differs from `scripts/start.sh` in
three ways that all matter:

- **Google cookie mode, dev bypass off.** The dev bypass resolves every request to the one `DEV_FAKE_EMAIL`
  identity, so a two-role test is impossible under it. Instead the Worker runs with `GOOGLE_CLIENT_ID` set
  and `ALLOW_DEV_AUTH=false` (overrides from `e2e/e2e.vars`, applied as `wrangler dev --var` so nobody's
  `.dev.vars` is touched), and each test mints its own signed `hrms_session` cookie with the app's own
  `sealSession` (`e2e/fixtures.ts`). One server, five roles, real cookie lane, real authz.
  `e2e/globalSetup.ts` refuses to run the specs unless an unauthenticated read really is 401 - otherwise a
  bypass leak would silently collapse the roles into one and the access assertions would pass for the wrong
  reason.
- **Vite in front, `/v1` through Prism.** The stack is the dev stack's shape, so `/v1` is validated against
  `openapi.yaml` as the specs provoke it: a request or response that drifts from the contract fails the
  browser test where it happens, not just the drift gates in `npm test`. Binary custom methods (`:download`,
  `:previewLetter`, …) bypass the proxy - Prism re-encodes a binary body and corrupts the file - and so do the
  Worker's non-`/v1` routes, which are not in the contract at all; both lists live in `web/vite.config.ts`.
  `e2e/globalSetup.ts` refuses to run the specs when nothing is listening on the Prism port, because Vite's
  proxy would otherwise answer by falling over and the contract validation would be silently gone.
- **Its own database**, `.wrangler/e2e-state`, reset and reseeded from `scripts/seed.sql` on each boot. Your
  own `.wrangler/state` is never touched. Port 8788, never 8787, so a running dev stack cannot be mistaken
  for this one.

`E2E_KEEP_DB=1` keeps the database as the last run left it while iterating. The specs are
written to survive that - they count what is there rather than assuming a number, name what they create, and
clean up after themselves where a rerun would otherwise collide (the leave spec cancels the employee's own
upcoming leave first, because the form refuses an overlapping range and a retry would fail on its own
leftovers). The suite passes three times in a row against one un-reset database.

**What the specs assert.** Only what a browser is required to observe. Business logic belongs in the vitest
suite, where it is cheaper and stricter, and is deliberately not re-asserted here.

| Spec | What only a browser shows |
|---|---|
| `boot` | the shell mounts and the router lands for all five seeded roles, with a clean console; and hide-never-disable live - a page the caller cannot read is neither offered in the nav nor served when the URL is typed |
| `writeDialog` | a create appears in the table without the page reloading (proved by a marker on the live JS context, which a document load would destroy) and survives one; and a lost race says so in the form and lets the second press through |
| `approval` | a decision verb really opens its confirmation, backing out really abandons it, and approving settles the row out of the queue |
| `leaveTwoRoles` | two people, two browsers, one request: the employee files it, their manager finds it in their own queue and decides it, and the employee's page tells the truth afterwards |
| `search` | `⌘K` opens, typing reaches the index (a seeded person, not just the static page list), and Enter lands on what was picked |
| `export` | CSV and xlsx are really built in the browser and handed over - the Excel path lazy-imports SheetJS, so the bytes are the only proof the chunk loads |
| `letterPdf` | a generated letter comes back through the blob/`<a download>` chain as a file that starts `%PDF-` |
| `kanban` | a card moves column through its actions menu and is still there after a reload |
| `sessionExpiry` | a session that dies mid-form gets the in-place "Signed out" overlay, with what was typed still in the form |
| `phone` (phone project) | six routes do not scroll sideways at 390px, the bottom bar opens the drawer and navigates from it, and a dialog's submit is wholly on screen at a real touch size |
| `requestBudget` | how MANY times the app talks to the server: a cold load and a page change stay inside a ceiling, boot reads go through `/v1/batch:run` rather than collection by collection, every role's dashboard stays inside the budget, and the audit trail is not read until somebody opens it |
| `theme` | a theme choice repaints, survives a reload from the local cache, and reaches a second browser through the per-user preference row - the cross-device half of the feature |
| `clock` | the top bar, the dashboard card and the Attendance page are one clock: punching in on one is immediately true on the others, with no reload |
| `notifications` | a request filed by one person raises the unread count in their manager's bell, and the bell says what happened |
| `bulkApproval` | the selection bar counts what is ticked, a batch asks once naming the number, and both requests leave the queue |
| `undo` | a soft delete (which deliberately does not ask first) really offers an Undo, and the Undo puts the row back |
| `tableState` | sort lives in the URL, a reload restores it, and a pasted link opens the sender's view |
| `offline` | losing the network says so, and getting it back re-reads what is on screen instead of leaving a wall of failed panels |
| `shortcuts` | the global key layer: `g`+letter jumps, `]` walks the workspace tabs, `?` explains them - and, more importantly, that the chords are NOT eaten by a field somebody is typing in or by an open dialog |
| `settingsSheet` | a page's gear opens its own settings panel inline (the lazy panel chunk really renders), the open panel is deep-linked as `?setting=`, and a caller who may not configure the page is not offered the gear |
| `quickCreate` | the top bar's "+" navigates AND hands the target page an intent it picks up on mount, so a create flow really opens from anywhere; and the menu offers nothing the caller could not write |
| `kpiFocus` | a clickable metric narrows the queue, writes `?focus=` so the narrowed page is shareable, survives a reload, and clears from the same tile - while the metrics keep counting the whole queue |
| `draftGuard` | a half-filled dialog does not evaporate: Esc asks first and keeps what was typed, an untouched one closes at once, and the back press closes the dialog (guarded the same way) rather than the page |
| `viewAs` | an admin simulating an employee gets that person's nav and that person's refusal when the URL is typed anyway, and the pill is the only exit |

Every page handed out by the `as` fixture fails its test if the app logs an error or throws. A spec that
provokes one on purpose opts out narrowly with `allowConsoleErrors(page, /…/)`.

Anything that decides a request **files its own first** (`fileLeave` in `e2e/fixtures.ts`). The seed ships a
queue, but a spec that consumes it is only repeatable until it runs out - so the approval specs bring their
own work and count what is actually there rather than assuming a number.

Traps worth knowing before writing another one:

- **A toast is not `getByRole("status")`.** That role matches the screen-reader announcer Radix renders
  alongside, whose text is cleared again moments later - so an assertion against it is a race that happens to
  win, and an Undo button inside it is not there at all. Use the `toast(page, text)` helper, which finds the
  real toast in Radix's labelled region.

- **An unknown route key renders the dashboard** rather than failing, and the dashboard offers shortcuts
  ("Request leave", "New reimbursement") with the same names as the buttons on the pages they lead to - so a
  spec can drive a whole flow from the wrong page and still pass. Pass the page's `<h1>` to `gotoRoute` where
  that could bite.
- **A clickable table row is `role="button"`**, not `row` (DataTable makes it keyboard-operable), which takes
  it out of the table's accessibility tree. Reach for `tbody tr` on those tables; `getByRole("row")` finds
  only the header.

Still ad hoc, not yet specs: the full multi-viewport sweep and the layout measurements `scripts/uiShots.mjs`
takes (this lane checks page-level overflow at one phone size, not every control at six widths), payroll -
nothing in `scripts/seed.sql` seeds a run, and building one through the UI would be a long, brittle flow.

## Writing a new test

- Pure domain logic: no runtime imports, no DB. Keep it in the fast lane.
- Anything touching a route: go through `app.fetch` so the middleware chain (auth, authz, wire ids, CSRF)
  runs. A service called directly proves nothing about access.
- New collection, new drift risk: prefer a gate that fails on the whole class over one example test. Every
  drift test above exists because a conversion or a copy-paste silently dropped behaviour once.
- A browser spec (`e2e/`) only for something a browser is REQUIRED to observe: it renders, it navigates, the
  list refreshes, a file is generated client-side, the layout holds, the console is clean. If the same fact
  can be asserted through `app.fetch`, it belongs in `test/` instead.

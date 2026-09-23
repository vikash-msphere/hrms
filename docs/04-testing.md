# 04 — Testing

`npm test` runs the whole suite with Vitest under `@cloudflare/vitest-pool-workers`: **232 files, 2744
tests**. Pure-domain files need no Worker runtime and are the fastest signal; service, route and flow files
run against the real `workerd` with live D1 and R2 bindings, applying the migrations from
`src/db/migrations/` into a fresh database per file.

`npm run verify` (`api:lint` → `lint` → `typecheck` → `test:gate`) is the only gate that matters. It runs as a
pre-commit hook (`.husky/pre-commit`, installed by `npm install`), in a local `npm run deploy` (chained
after `preflight`), and on demand in CI (`.github/workflows/verify.yml`, manual only - nothing starts it on a
push or a pull request). The CI deploy (`.github/workflows/deploy.yml`) does not run it.

> **Why the gate runs `test:gate` and not `test`.** Vitest can exit **0 having run no tests**: when the
> workers pool fails while building its Miniflare options — `parseProjectOptions` reads `wrangler.toml` and
> `.dev.vars` through wrangler, so a denied file (the local command sandbox does exactly this), a malformed
> config or a wrangler bump can throw there — it prints the error, collects nothing, and still succeeds. On
> the one check standing between a payroll change and production, that is the failure mode that looks like a
> pass.
>
> `scripts/testGate.mjs` runs the same vitest and then asserts the JSON summary: the run succeeded, and it
> contained tests — at least `MIN_TESTS`/`MIN_FILES`, a floor set well under the real totals so it stays quiet
> while tests are added and fires the moment the suite collapses. `npm test` stays the bare `vitest run` for
> the edit/run loop, where `-t`, a file path or `--watch` should not have to argue with a floor.

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
| `reparenting` | an owned-coded table missing from the code-cascade set (scanned from every `allocOwnedCode` call site, so the check runs in the direction that actually drifts), and a mixed owned/flat table cascading without an `ownedWhen` discriminator |
| `changesEmbeds` | a serializer embedding another collection's rows without declaring it, which leaves the outer collection's stored copy stale in every browser forever |

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

**Scale limits** - the two failures a dev database can never show, because both need real volume:

| Suite | What it holds |
|---|---|
| `searchFilterParamCap` | the text filter's id list, when a query matches more rows than D1 can bind |
| `idListParamCap` | every other id-keyed read and multi-row insert: a page of board posts whose replies outnumber the cap, a full 100-id page of reads / reactions / poll tallies, a nightly purge of more expired access rules than one `DELETE` can name, and checklists longer than one `INSERT` can hold |

D1 binds at most 100 parameters per statement (`lib/dbBatch.ts` `PARAM_CAP`), and a page is `clampPageSize` =
100 ids — the cap exactly, with nothing left for the predicate beside it or for a scoped caller's own bound
parameters. Every one of these read fine on an empty database and answered `D1_ERROR: too many SQL variables`
in production. Chunk with `byIdChunks`, build multi-row inserts with `insertBatches`, and add a case here
rather than trusting the next reader to remember the cap.

`goalTemplates` carries the sibling rule for the SUBREQUEST budget: `:apply` must cost the same number of D1
round trips whether it names three people or two hundred, because every round trip is a subrequest and the
ceiling is 1,000 per invocation. It also compares an applied goal against one `createGoal` writes, field by
field — that drift is the price of the verb not going through it.

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

**Two runs at once.** A run owns three ports and a database, so a second one started while the first is going
shares all four: two suites writing one D1 file, tearing down each other's Worker, and emptying each other's
`test-results/`. It fails as a scatter of unrelated flaky specs, and reads as a broken app rather than a
broken arrangement. `E2E_LANE` moves the whole set together - ten ports up, its own `.wrangler/e2e-state-<n>`,
its own `tmp/e2e-*-<n>.log`, its own `test-results-<n>/`:

```
npm run test:e2e                      # lane 0: 5174 / 8788 / 4011, as always
E2E_LANE=1 npm run test:e2e           # alongside it, sharing nothing
```

Lane 0 is the historical stack, so nothing already in anybody's fingers changes. The arithmetic lives in
`e2e/lane.ts` and is mirrored in `scripts/e2eStack.sh`. Both lanes are still one machine, though: the Worker
is a single `wrangler dev` process per lane and the box has one CPU budget, so a second lane at full width is
how you find the ceiling rather than how you go faster.

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
| `phone` (phone project) | six routes do not scroll sideways at 390px, the top bar's Menu button opens the drawer and navigates from it, and a dialog's submit is wholly on screen at a real touch size |
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
| `orgChart` | the chart as a management surface: a re-parent through the picker redraws the subtree and survives a reload, and the picker will not offer a node its own descendant (a guard computed from the tree the browser built) |
| `charts` | the charting library is fetched by the first page that actually draws a chart and not before, paints real SVG, and keeps the numbers in the `sr-only` table that IS the chart for anyone who cannot see it |
| `documentUpload` | a file picked in the dialog really becomes a document - the row appears, and downloading it hands back bytes that start `%PDF-`, which is the only proof the File was read and posted |
| `savedViews` | a named table view is saved and pinned, and a SECOND browser opens the table on it from the server's copy - the cross-device half of table preferences |
| `activityTrail` | a record's trail renders the change the form beside it just made, as "old → new" - the whole chain of form write, audited diff and feed rendering |
| `signature` | a signature uploaded on a profile comes back through the POST-to-blob-URL path and paints, survives a reload, and removing it clears it without a stale refetch |
| `assetTagPdf` | the sticker sheet is drawn client-side to exact geometry by a lazy-imported pdf-lib and handed over as a file |
| `combobox` | the picker every form is built from: it filters as it is typed, Enter takes the highlighted row, Escape leaves the field as it was, and its label really names it |
| `boardReply` | two people, one post: the thread is not rendered until it is opened, a colleague's reply lands in it without a reload, and the author finds it under their post |
| `dashboardLayout` | a personal section order and a hidden section redraw the page (measured, since the order is CSS-only) and survive a reload |
| `accessMode` | switching access-management mode on really grows the key icons on a rendered page, one opens the rule editor scoped to its own collection, and switching off leaves an ordinary table |
| `feedback360` | three browsers on one review: the manager nominates from the card (through a picker that will not offer the reviewee), the colleague finds the request in their own queue and answers it, and the answer lands back on the manager's card as "<author> · Submitted" - the cross-session half of an embedded collection |
| `calibration` | the distribution HR calibrates on: counted, averaged and bucketed in the browser from the cycle's shared ratings, against the org's own scale, and narrowed to one department |
| `payrollStale` | a built run saying its inputs moved, on the breakdown dialog where the run is actually read - naming what moved, and clearing it through the rebuild offered on the banner without leaving the dialog |
| `backgroundCheckFlow` | a check's whole status machine, which is a rendering decision and nothing else: each status offers only its own moves and a closed check offers none - plus the form warning, computed from the rows on the page, that this check is already open |
| `complianceRules` | a recurrence read back as DATES before it is saved, re-read when the frequency changes (and the anchor month appearing only when it means something) - then the year of occurrences the rule generated, each marked as a rule's and each saying that editing it changes only itself |
| `foundPage` | the one page a stranger is meant to see: the public `/found/<wire-id>` sticker lookup answering 200 with no session at all, carrying the tag and a return contact but neither the holder's name nor the serial, refusing a forged token, and going back to 404 when the org turns it off |
| `requisitionClone` | the two things the job form says while a role is being duplicated: what the status it is about to be saved with actually does, and that a live requisition of the same name already exists with a funnel this copy would split |
| `workflowFires` | the only place the builder meets the engine: a rule composed through three editors, saved live, and then matched against a real event - fenced by a condition on a category only this run's ticket carries |

**The sweeps.** `everyPage`, `everySetting`, `everyTab`, `profileTabs` and `everyChart` are the floor under everything above: the first walks every route `renderPage()` can render (checked against `App.tsx`, so a page shipped without a line in the table fails the spec), the second every org settings panel in `settings/registry.ts`, the third every tab on every tabbed page, the fourth every tab on an employee record (checked against `EmployeeProfile.tsx`), and the fifth every chart on every page that draws one (checked against the source, and asserting the `sr-only` table as well as the picture). They all ask the same things per surface - it mounted, it landed where it claims to, it stayed inside the window, and it logged nothing - and the employee sweep additionally requires every route to answer with either the page or the access wall. They are how "a page nobody opened in a week" stops being where breakage hides.

| Spec | What only a browser shows |
|---|---|
| `everyPage` | every route renders for an admin, on its own `<h1>`, inside the window and with a clean console; and for an ordinary employee each route answers with the page or the access wall, never a blank frame |
| `everySetting` | every org settings panel opens on its own heading (each is a lazy chunk), the hub finds a panel by a synonym, and a caller without settings access gets the wall |
| `profileTabs` | every tab on an employee record mounts on a panel with something in it, the open tab rides in the URL (so a record link lands on the section somebody meant), and a tab segment the viewer has no tab for falls back to Profile rather than drawing an empty one |
| `everyTab` | every tab on every tabbed page: it opened, it drew something, it stayed inside the window, it logged nothing - the panels behind the first tab being where breakage hides |
| `reimbursements` | an employee's claim, the form's future-date refusal, the queue it lands in for the claims desk, and their own tabs agreeing afterwards |
| `expenses` | a company expense through the approve and pay QUEUES - each step asking first, each moving it out of one tab and into the next |
| `loans` | the borrower's form previewing what will be taken each month before they commit, then payroll's approve → disburse → record-repayment, one affordance at a time |
| `taxDeclarations` | the section cap warning (the mistake people actually make) and payroll verifying a DIFFERENT figure from the one claimed |
| `payroll` | the run state machine end to end - quick run, build, review the numbers, submit, approve - and the approval withheld from the person who ran it |
| `overtime` | the shared start/end range control: a day, a start, a quick-set chip that moves the end, and the live duration between them |
| `remoteWork` | the form counting the days it is asking for, and recounting when an end is halved |
| `attendanceCorrection` | a wrong day carries its own correction affordance, seeded with what the day says now |
| `holidays` | the clash guard on the date field, an optional holiday taken and given back (which asks first), and the calendar leaving as a real `.ics` |
| `schedule` | the roster grid: an empty cell names its person and day, a shift is minted from inside the dialog that assigns it, and the cell reads it back |
| `timesheets` | the week grid: a cell knows its project and day, the quarter-hour steppers, the week total, and submitting FREEZING the cells |
| `goals` | progress is a slider that does not commit as it moves - the save appears with room for the note that explains the jump |
| `checkIns` | the cadence preview (the dates a repeat will produce, before it is saved) and the 1:1 reaching the other side |
| `reviews` | launching split into create → pick → PREVIEW, and the review then appearing on the reviewee's own page |
| `ats` | the hiring chain across four pages, and an advance button that names the stage it is about to move somebody into |
| `interviews` | an interview attached to a person on a job, its window composed, and the scorecard the panel owes |
| `offers` | draft → approved → extended, with the verbs appearing one at a time and the candidate-facing one asking first |
| `suggestions` | anonymity kept on the card, and HR's triage answer reaching the card the submitter reads |
| `tickets` | the duplicate-subject warning, and a status control that offers STATES with a reason when one is unreachable |
| `onboarding` | a process started for a person, with its checklist on the page |
| `delegations` | the form stating what it will do ("X receives your approvals for N days") and warning when those days are already covered |
| `events` | the RSVP on the row beside the count it changes - and an employee, who holds no `respond` grant, being offered no answer to give |
| `benefits` | a dependent added and put on the cover, and the plan card changing from "enrol" to "change" |
| `compliance` | an obligation added to the calendar with its due date |
| `backgroundChecks` | the switch that turns "add a check" into "add the standard set", with the button counting what it will create |
| `workflows` | the builder blank (with the reason it cannot be saved), a recipe filling it, and the preview reading the rule back as a sentence |
| `directory` | server-side search finding one person past the first page, and the profile deep-linking to a section from cold |
| `kudos` | the quick-create menu's kudos entry navigating AND handing the board an intent it picks up on mount |
| `assets` | assigning moves the asset out of stock by itself, and the register says it is waiting on the holder's scan rather than "done" |
| `operations` | a scheduled task forced by hand, and the card reading back the tick it produced instead of still saying "never run" |
| `payslipDesign` | the payslip block editor: stock design restored, a block added, the PDF preview re-rendered, saved and taken back out |
| `letterTemplates` | a letter type written block by block, previewed as a real PDF against an employee, then deleted |
| `bankFormats` | a bank's blank .xlsx parsed IN THE BROWSER into columns, each mapped, and the employer's debit account reading back masked |
| `stocktakes` | a count opened with a scope, a tag logged into it by wedge/keyboard, and closing it leaving a frozen report |
| `analytics` | the team report's window guard, its per-person panel, and recruiting numbers opening the lists they counted |
| `compensation` | a CTC revision read back off the timeline in the unit it was entered in, and a bonus recorded against the person |
| `profilePii` | an org declares an identity field, its OWNER fills it in, and a joiner's previous-employer income moves the tax projection |
| `boardsAdvanced` | a WIP limit set in the board's own settings panel, read back on the column, said in the task editor - plus swimlanes and the flow metrics |
| `payslips` | the far side of a published run: an employee's own payslip list, the PDF handed over as a file, and the same slips on their record for payroll |
| `referrals` | what each referral status means for the bonus, said beside the picker, and the hand-off that turns a referral into a candidate |
| `employeeRecord` | a hire numbered by the org's own ID format, and bank details captured by their owner behind the double-entry check |
| `ticketWork` | the conversation and the checklist ON a ticket - the side tables that roll up onto the row the requester watches |
| `cardWork` | the same for a board card: an item added, ticked, a comment posted, all still there on a reload |
| `announcementPoll` | a poll composed from the shared post composer, voted on with one press, and the tally moving for the asker |
| `apiKeys` | a machine credential minted, shown exactly once (and argued with on the way out), then revoked |
| `trashRestore` | the delete somebody did last week: deleted rows fetched by the State filter, and put back |
| `assetRequests` | asking for kit from your own profile, and the ask arriving in the approver's queue |
| `settlement` | a leaver's full & final: HR's three judgement inputs, the itemised breakdown, and the stored snapshot coming back from cold |
| `letterheads` | the company page documents print on, designed against a live PDF preview of itself |
| `personalDetails` | contact and emergency details kept by their owner (`OWN_PII`), as two cards on the Profile tab |
| `timesheetApproval` | the far side of a submitted week: the manager's own page carries the queue, and a decision asks before it commits |
| `rejection` | saying NO, across kinds: the reject dialog, the note the API relays, and the row leaving the inbox - one spec because it is one shared row |
| `loanLifecycle` | approve, disburse, record a repayment - each offered only in the state it belongs to, and the ledger moving |
| `offerOutcome` | the endings an extended offer can have (accepted, declined) plus the offer letter as a real PDF |
| `transitionTasks` | the onboarding checklist as work: ticked, put back, added to, and the process closed with a way back |
| `suggestionVotes` | opening the box to `everyone` with an ACL, then the arrows: a vote, a vote withdrawn, and the score other readers see |
| `form16` | the official TRACES copy refused unless it is a PDF, uploaded, badged as the one to file - and the generated copy for that year marked superseded beside it |
| `insuranceCard` | the health-insurance e-card filed from the Documents tab and landing in the list, and the owner - who holds `personal-documents` read only - not offered the control at all |
| `employeeDocumentsFilter` | the profile Documents card's search + type picker over a file long enough to need them: crossed, counted ("Showing N of M"), and cleared from the empty state |
| `mentions` | `@` offered from the caret (and not inside an email address), the name written around it, the chip that links to the person, and their bell |
| `makeTask` | a checklist item promoted onto a board, carrying a line back to the ticket - and still on the ticket afterwards |
| `roleHistory` | a promotion as history: what the change moves ("Engineer → Senior Engineer"), a backdate refused, and one row current |
| `profileNudges` | the completeness meter as a nudge that can be followed - a chip opens the section it names, and filling it in makes the chip go away |
| `holidayBulk` | a pasted year previewed line by line (including the line that cannot be read), and a year copied forward with its dates editable |
| `tabBadges` | "new since you last looked": a workspace tab and a page's own sub-tab counting what arrived, and the visit clearing it |
| `teamTimeline` | the dashboard's heaviest widget: mounted only when scrolled to, a filed leave on the person's row, and the fortnight paged |
| `sprints` | the scrum board: planned out of the backlog, started, the burndown drawn once tasks are estimated, and completing it returning the unfinished work |
| `postSticker` | the picture on a post: suggestions matched to the words, the two dials, the catalogue behind Browse, and the art on the card |
| `attendanceViews` | the same window as a list or a month grid, several days ticked for ONE correction, the view remembered, the manager's team panel and the per-person log it drills into, the attendance tab on an employee's record (read-only, and the chart `everyChart` cannot reach), and HR marking what a day counts as - set, changed, read back and withdrawn, with the employee able to read the decision and not make one |
| `workflowLog` | the read-only half of Workflows - runs, waiting workflows and the event log, each its own lazy read - and an action taken now appearing in the log on Refresh |
| `pendingCorrections` | the correction queue drawn on the approver's OWN attendance page: named, dated, asking first, and gone when answered - and absent for somebody who decides nothing |
| `announcementDraft` | a post staged rather than sent: the publishing chips rename the submit, the draft lands on its own list, and it is invisible to everyone else until Publish is pressed |
| `goalTaskLink` | a goal scored off the board: tasks linked from its drawer, the points read back, and delivering one moving the number without anybody typing a percentage |
| `readReceipts` | "has anybody read this?" - a receipt raised in the reader's browser and answered on the author's card, with the names behind the count |
| `reviewStages` | the far side of a launch: the self-assessment, the manager's ratings beside it, the guard on sharing an incomplete review, and the employee's acknowledgement |
| `kpiVisibility` | who sees which KPI card: the org's per-card audience and its whole-band switch taking a card off an employee's dashboard and giving it back, and the reader's own hide-and-restore, which nobody else's dashboard feels |
| `notificationPrefs` | silencing a category for yourself: the user-scoped panel behind the bell page's gear (its own lazy chunk), the unsaved-changes banner clearing on Save, and the mute being true in a SECOND browser - the half that makes it a row on the server rather than a browser preference |
| `announcementSolo` | the pop-out: a post on a page of its own, with the board's other post, heading and composer absent - and standing up from cold, which is what a pasted link is |
| `searchScope` | what ⌘K OFFERS, which is a different gate from what it finds: an employee is offered neither the page nor the settings panel they may not open, while the same keystroke still offers their own pages |
| `paletteRecent` | the palette learns: a never-used one offers no Recent group, what was picked leads the next open, and the memory is written down rather than held in the page |
| `recordStepping` | the record pager built from the cached list: an arrow really moves to the neighbour, one place along its own counter, and the way out is the directory |
| `tablePaging` | the shared table's pager: the arrows move a page at a time with the footer counting where you are, searching from page two lands on page one of what was searched for, and a search that matches nothing offers the way back out instead of a create nobody asked for |
| `sidebarRail` | the nav's own persisted state: collapsing leaves an icon rail that still navigates and survives a reload, and a folded group hides its pages except the one being read |
| `orgChartFocus` | `org-chart/<id>` opening on that person's subtree with the trail back out, and the search counting its matches and stepping through them |
| `dashboardMyDay` | the self-scoped band of the dashboard: the caller's own tile renders with a number in it, and it drills through to the page it summarises |
| `postPin` | a pinned post leading the board - an assertion about ORDER, still true after a reload rather than only in the page's copy of the list - and unpinning giving the card back |
| `routedTabs` | the third URL-state mechanism (after `?focus=` and `?setting=`): a request page's sub-tab written to the hash, read back from cold, and answering the same way on another page of the same shared shell |
| `leaveDuration` | what a request costs, said before it is sent: the sessions control charging a morning as half a day, and leave already booked on those dates named in the form with the submit refused |
| `budgetViews` | the same caps answered three ways - the table, the rollup (regrouped on demand, its first column saying which question was asked) and the year grid - plus the spend figure opening the view that explains it |
| `directoryViews` | the people list as cards: the toggle, the department grouping computed in the page, and the choice remembered by the browser |
| `celebrations` | a joiner whose anniversary is days away appearing on the dashboard's celebrations card, with the reason in words |
| `compensationCorrect` | a revision corrected in place: the affordance on the row it corrects, the dialog pre-filled from that row, and the timeline restating rather than growing a second entry |
| `goalAlignment` | the alignment picker refusing to offer a goal its own descendant (or itself) - a cycle guard computed from the tree the browser built - while still offering the parent above it |
| `assetBulkAdd` | a delivery counted before it is written: the submit naming how many a quantity or a pasted serial list will create, and the paste landing as one record per line |
| `everyChart` | the wide version of `charts`: every page that draws one, every figure on it painting real SVG and carrying the same numbers in a captioned table - the half a sighted reviewer never sees |
| `suggestionMerge` | a duplicate folded into another suggestion: the picker of what it could be a duplicate of, the sentence saying where its votes go, the submit changing from answering to merging, and the folded row naming where its idea went |
| `interviewLifecycle` | the verbs a row offers by state: a scheduled interview can be mailed, completed or called off, a finished one offers none of them, and the scorecard it still owes stays |
| `goalComment` | the coaching thread on a goal: posted from the owner's manager, attributed, and read by the person whose goal it is in their own browser |
| `workflowDryRun` | trying a rule out before letting it loose: a sample event that misses the condition, one that matches and names the steps, and a payload that is not JSON refused by the form |
| `boardMarkAllRead` | a reader clearing the board in one press: the affordance offered only while something is unread, the dot fading without a refetch, and the receipt still true from cold |
| `assetReissueTag` | invalidating a sticker: the question naming what stops working, backing out really backing out, and going through with it putting the asset back in the print queue |
| `employeePhoto` | the crop that happens in the browser: the picker, the preview that proves the decode, the save landing a marker on the record, and the removal asking first |
| `copyEmail` | the app's one clipboard affordance, read back off the real clipboard: hover-revealed, and copying the address alone |
| `calendarFeed` | the personal holiday subscription: a URL composed against the origin it is served from, offered as selectable text, and really answering with a calendar |
| `ticketTriage` | the three pickers on a ticket, each its own verb and grant: assigned, routed into a department's queue, prioritised - each committing on its own and read back from cold |
| `regularizationCancel` | the requester's own way out: a pending correction withdrawn from their attendance page, asked the way every decision is asked, and the row settling with the affordance gone |
| `postEdit` | the composer in its second mood: an edit arriving carrying the post, a submit that says "Save changes" rather than "Publish", and the board showing the correction without a reload |
| `goalCarryOver` | the quarter that ended with work left: one press composing the successor and closing the original, so neither a duplicate nor an orphan is left behind |
| `stocktakeAbandon` | a count's other ending: the destructive twin of Close, the question that distinguishes them (the sightings stay; the report does not), and the count leaving the list |
| `everyQuickAction` | the whole "+"/⌘K registry walked: each action landing on its own page AND the page picking up the intent it fired, with the two that write on a shared record excused by name |
| `reviewNudge` | the two escape hatches on a stalled review, drawn only for a viewer it is not waiting on: the reminder reaching that person's inbox, and the skip moving the review on after saying what skipping costs |
| `offerRescind` | the third ending of an extended offer: the question naming what it does to the candidate, backing out leaving the offer standing, and the row afterwards offering none of the endings that have gone |
| `checkInScheduleNext` | the continuity of a 1:1 series: the next meeting composed from the last one, carrying what is still open and leaving behind what was ticked |
| `timesheetReject` | the other answer on the hours queue: offered beside Approve, asked the way every decision is asked, and the entry leaving the queue as REJECTED rather than sitting there undecided |
| `feedbackDecline` | saying no to a 360 request: the refusal beside Submit, the card leaving the nominee's queue, and the nomination recorded as declined rather than as silence |
| `candidateResume` | the CV both ways: picked through the row's own affordance, the row then offering to read and to replace rather than to attach, and the bytes coming back as a real PDF |
| `payrollPublish` | the press that pays everybody, on a month of its own: the verb offered only in APPROVED, the question naming what cannot be undone, backing out leaving the run approved, and the row saying it is generating payslips while the background job runs |
| `accessFourEyes` | a permission change that needs two people: the request landing as pending, reading as "awaiting approval" in the rules UI, and going live only once a second admin approves it |
| `documentRemind` | who has NOT signed the policy: the progress dialog reachable from the row, the pending list by name, and the chase reaching that person's notifications |
| `assetCustody` | custody claimed without a camera: the wedge box a USB scanner types into, a tag that names another asset refused in the form, and the right one recording the sighting |
| `esignProvider` | the external signing lane's edges: the vendor's settings rendered from the server's own driver registry, the form refusing an acknowledgement with no signature box, and a vendor request that cannot go through failing readably and leaving nothing half-made |
| `everyViewport` | every route at four widths (390 / 768 / 1024 / 1280), measured once the layout has SETTLED: the document itself never scrolls sideways, while the things that are meant to (tables, boards) scroll inside their own box |
| `truncationNotice` | a view admitting it is showing a window: the notice a non-table view draws when its collection is truncated (injected into the read, not manufactured from a hundred rows), what it tells the reader to do, and its absence when the collection fits |
| `leaveCalendarPick` | the month grid inside the request dialog: a range opened and closed by pressing days, reaching the date inputs, banded and named for a reader who cannot see the tint, and re-priced as it changes |
| `fileDrop` | the third way every file field takes a file - a real `DataTransfer` drop, the `dragover` the field must prevent (or the browser navigates away from the app), the file named in place of the invitation, and taken back off |
| `errorBoundary` | the white screen that does not happen: a lazy chunk refused mid-session draws the out-of-date panel with a way forward, the nav survives beside it, and the offered reload really recovers |
| `failedRead` | the third branch of every list - one collection's read broken in the browser while the rest of the page stays healthy: the panel says the read failed rather than showing an empty table, and "Try again" recovers it in place |
| `eventInvite` | a department expanded into named attendees in the composer, one of them taken back out, and exactly that list landing on the event |
| `delegationEnd` | ending a redirect of somebody's approvals: the question naming both sides, and the delegation really stopping rather than the row merely leaving the page |
| `navMatrix` | the whole sidebar against the capabilities the server actually issued, for all five roles - gates read out of `web/src/nav.ts` and answered with the app's own `hasCapability`, so an entry offered to somebody who gets a wall (or hidden from somebody who holds it) fails; plus every hidden entry refused when its URL is typed |
| `createGates` | the button half of hide-never-disable: every "New X" and custom-method button on fourteen pages is present exactly when the caller holds the capability `AccessAction` gates it on, for all five roles - with an admin sweep that fails if the table names a button the app no longer renders |
| `aclUserGrant` | the Users tab of the rule editor, end to end: the person picker, the grant sentence, the level, the trash and its confirm - and the granted person's OWN browser gaining the page and losing it again |
| `aclCustomMethodGrant` | the other path through the same modal: a method chip drills the editor into one verb, one person is allowed it, and the button that verb belongs to appears on their page while the create button stays hidden |
| `aclScopeAndExpiry` | the two dimensions that are neither who nor how much - the scope chips (narrowest first, and tiers never conflated in one list) reaching the rule as `scope: self`, and a temporary role grant reading as "expires …" with the date on the row |
| `subjectPermissions` | one person's whole permission sheet from Settings › Users: the collection filter, the level cell, the inherited-from-role line, the confirm that only appears when access is taken away, and the rule showing up on the "All rules" tab |
| `everyoneRole` | the "allow everyone" primitive pressed for real: granting the reserved `everyone` row widens a bystander's live capability set without naming them, and revoking narrows it again |
| `accessModeGating` | who is offered the keys at all - the access-management toggle appears exactly for `access-rules.write`, no key icons exist without it, and an admin can open the rules that govern who manages access |
| `viewAsReadOnly` | the rail that makes simulation safe: mid-simulation the create buttons the admin would otherwise keep are gone, and a write carrying the view-as header is refused as read-only before it reaches a handler |
| `disabledAccountRefused` | the promise the disable confirm makes, held to a live session: a working browser is locked out on its very next request, with no shell and no data behind it |
| `piiTabAccess` | the field-precise split, from four other people's browsers: nobody but the owner and super is offered a colleague's Identity or Bank tabs or the personal/contact/emergency cards on their Profile tab, the URL is not a way round the tab bar, and the reads behind them refuse |
| `rowScoping` | the half of access that is not "may I open this page": an employee's claims and expenses are theirs alone on the page AND on the wire, while finance can read the row they cannot |
| `approvalScope` | a manager's inbox is their own team's: a request from outside every department is not in it, and asking for that row by path is refused - approve included |
| `virtualCapabilityGates` | the two capabilities that are not a collection - the Export control following `export.read` for every role, and the per-record activity icon appearing only once the independent activity gate is granted |
| `settingsPanelGating` | Settings is not one permission: each panel's own capability decides its hub card AND its deep link, and a caller without `settings.write` gets the wall either way |
| `apiKeyScope` | the scope the mint form promised, kept by the credential it produced - one request per control (collections, level ceiling, the off-by-default actions box), and a purged key refused on the very next call |
| `documentAccessGates` | one shelf, two collections, three gates: Upload follows `org-documents.write` and Generate letter follows `personal-documents.write` for every role, and an employee cannot list a colleague's file |
| `rowActionGates` | the finest gate there is, two cards on one board for one reader: the author's own kudo carries edit and delete, a colleague's post carries neither, the row hint the UI read says the same, and the edit is refused when asked for by path |
| `permissionsMatrix` | the org-wide grid is a control, not a read-out: a cell writes the same rule the modal writes, reads back, opens that collection's editor from the key beside it, and takes the access away again |
| `aclDenyTintAndPresets` | the two things the access UI draws purely to be looked at - the red key (and its tooltip) appearing over a target an explicit deny covers and going again when it is lifted, and a one-press preset authoring the whole Everyone bundle, readable and reversible as an ordinary rule |
| `quickActionGates` | the "+" menu offers nobody an action they cannot perform (checked one-directionally, since the org also configures the menu), and every row on it is a registry action |

Every page handed out by the `as` fixture fails its test if the app logs an error or throws. A spec that
provokes one on purpose opts out narrowly with `allowConsoleErrors(page, /…/)`.

Anything that decides a request **files its own first** (`fileLeave` in `e2e/fixtures.ts`). The seed ships a
queue, but a spec that consumes it is only repeatable until it runs out - so the approval specs bring their
own work and count what is actually there rather than assuming a number. `fileLeave` dates its request a few
years out where nothing real lives; pass `{ from }` only for a surface that draws a WINDOW of the calendar
(the dashboard's team timeline is two weeks wide), where a placeholder day would be filed correctly and drawn
nowhere.

A spec that opens somebody's own record asks the API which person that is (`personPath` / `personId`, by the
email the role signs in with). The id in `employees/<id>` is a WIRE id the edge decodes per request, so it
cannot be taken from `scripts/seed.sql`, and matching on a first name is one seeded joiner away from driving
the wrong person's record.

**An access-control spec practises on a person of its own.** The five seeded logins are load-bearing for
every other spec in the lane, so a rule granted to `emp@example.com` - even for the second it takes to read
it back - changes what another worker's browser is being asked to prove at that moment. `makeThrowawayPerson`
creates an employee (whose login is provisioned with it), `as({ email })` signs in as them through the same
cookie lane the five roles use, `userPath` turns their email into the `users/<id>` an access rule names, and
`retireThrowawayPerson` soft-deletes them afterwards - never `?force=true`, because the login beside them is
an undeclared reference the purge would refuse. The rules themselves are swept in a `finally`, by subject,
so a spec that dies mid-grant does not leave one behind. Pick the target collection with the same care: an
`everyone` grant on a collection that owns a sidebar entry would change what `navMatrix` sees mid-run.

**Expectations come from the server, not from `grants.ts`.** The seeded grant table is data, and it moves.
An access spec reads `/v1/users/me` (`capabilitiesOf`) and answers with the app's own `hasCapability` -
imported from `web/src/lib/perm.ts` rather than re-implemented - so what is asserted is that the RENDERED
page agrees with the capabilities the caller actually holds. Gate tables are parsed out of the source they
belong to (`web/src/nav.ts`, `web/src/settings/registry.ts`) for the same reason `everySetting` parses the
settings registry: an entry added tomorrow is judged tomorrow.

Traps worth knowing before writing another one:

- **A toast is not `getByRole("status")`.** That role matches the screen-reader announcer Radix renders
  alongside, whose text is cleared again moments later - so an assertion against it is a race that happens to
  win, and an Undo button inside it is not there at all. Use the `toast(page, text)` helper, which finds the
  real toast in Radix's labelled region.

- **A toast is the weakest thing to assert on.** It is on screen for a few seconds and it is the first thing a
  busy render drops - under sixteen workers several specs have watched one never appear at all. Assert what
  the write DID instead: the write dialog closed (a failed write keeps it open with the reason pinned), the
  row landed, the state moved. Keep the toast assertion only where the toast IS the feature (the Undo in
  `undo`, the recording chip in `reportProblem`).

- **Matching a role by name is a SUBSTRING match** unless `exact: true` is passed. "Acknowledge" also matches
  the review card's own accordion header (its accessible name carries the stage rail "… Shared
  Acknowledged"), so the click folds the card and nothing happens - the failure then looks like a broken
  verb. Pass `exact` wherever one label is a prefix of another.

- **A `?force=true` purge is an admin's to make.** As HR it comes back 403 and `purge` swallows it, so a spec
  that tidies up as HR silently leaves its rows behind and breaks its own next run (this happened to
  `holidays`, `holidayBulk` and `reviewStages`). Take a `super` page for the housekeeping.

- **Navigating inside the app re-reads nothing.** A link click, a `navigate()` and a `gotoRoute` to a route
  the page can reach without leaving the document all keep the SPA's cached rows and its cached capabilities -
  so a write made in another person's session is invisible. Use `page.reload()` when the point of the
  assertion is that somebody ELSE's write arrived; the specs that need it say so at the call.

- **An unknown route key renders the dashboard** rather than failing, and the dashboard offers shortcuts
  ("Request leave", "New reimbursement") with the same names as the buttons on the pages they lead to - so a
  spec can drive a whole flow from the wrong page and still pass. Pass the page's `<h1>` to `gotoRoute` where
  that could bite.
- **A clickable table row is `role="button"`**, not `row` (DataTable makes it keyboard-operable), which takes
  it out of the table's accessibility tree. Reach for `tbody tr` on those tables; `getByRole("row")` finds
  only the header.

**What is deliberately still un-driven**, and why - two entries, both of them things a browser in this lane
physically cannot do:

- the CAMERA itself: reading a QR sticker through a device camera (asset custody, the stocktake scanner) and
  the vendor-hosted Aadhaar signing page, which lives on somebody else's domain and wants a real identity.
  Everything on this side of both is covered - `assetCustody` drives the same custody dialog through its
  wedge box (what a USB scanner types) and proves a tag that names another asset is refused; `stocktakes`
  logs a tag into a count the same way; `esignProvider` pins the guards around the vendor lane: the form
  refusing an acknowledgement with no signature box placed, and a signing request that cannot go through
  coming back as a readable precondition rather than a 500 with a half-made copy behind it;
- the per-CONTROL layout measurements `scripts/uiShots.mjs` takes: `everyViewport` now walks every route at
  four widths and `phone` measures the touch rendering, but neither asks whether a particular button is the
  right size at six breakpoints - that is still a pair of eyes on a screenshot.

Things that USED to be on this list and are not any more, because the way to drive them safely turned out to
exist: publishing a payroll run from the page (`payrollPublish` claims a fresh long-past month each run, since
publishing is one-way), four-eyes on access changes (`accessFourEyes` holds the org-wide switch on for exactly
two API calls, and drives the approve on a rule for a role nobody holds), and ack reminders
(`documentRemind` composes the policy over the wire and chases one person from the progress dialog).

Everything else that a person can press has a spec, and six drift-gated sweeps keep it that way: a new route
fails `everyPage` and `everyViewport`, a new settings panel fails `everySetting`, a new tab fails `everyTab`
or `profileTabs`, a new chart fails `everyChart`, and a new quick action fails `everyQuickAction`.

Where a spec signs in as a particular role, that is the seeded policy talking, not a preference: HR decides
reimbursement claims (managers are deliberately not in that loop), only super holds both rights the quick
payroll run needs, the suggestion box and delegations are granted to HR/super until an org opens them wider,
and `events.respond` is an HR/super verb. Referrals and stocktakes ship private with no seeded role grants at
all, so only super drives those; HR awards a bonus while payroll only reads them; and PII (bank, identity,
tax) is `OWN_PII` - self-service and super, which is why those specs are written from the owner's browser
rather than HR's. A spec using a role that does not hold the grant would be testing an org this seed does not
describe.

## The AI layer, against a model on your machine

Neither AI dependency can be emulated by the platform, and both fail in a way that costs money rather than
erroring:

- `wrangler dev` honours `[ai]` from `wrangler.toml` and proxies it to the real service. Its own log warns
  that *"AI bindings always access remote resources, and so may incur usage charges even in local dev"*.
- Miniflare's Vectorize plugin has no local implementation at all, only a remote proxy client. A `VEC`
  binding locally is **production's index**, so a local run's upserts land under production's ids.

So there was no local AI lane: exercising a feature spent the account's daily neuron allowance and wrote into
the live index. The browser lane's AI specs were originally written pressing the buttons and made real
inference calls on every run before that was caught.

`AI_LOCAL_URL` replaces both with a model running on this machine. `src/deps.ts` prefers it over the
bindings, so with it set **there is no remaining code path to Workers AI** - which is a stronger guarantee
than remembering to leave the feature switches off.

### Setting it up

```bash
ollama serve
```

Any instruct model answers the generative half - use `ollama list` and take what you have. **No chat model is
an embedding model**, though, and four of the eight features need one:

```bash
ollama pull all-minilm
```

`all-minilm` is **384-wide, the same as `@cf/baai/bge-small-en-v1.5`**, so the local lane rehearses
production's vector width. `embeddinggemma` and `nomic-embed-text` work too, at 768.

In `.dev.vars`, with the chat model named as `ollama list` prints it, tag included:

```
AI_LOCAL_URL=http://127.0.0.1:11434
AI_LOCAL_CHAT_MODEL=gemma4:26b-a4b-it-q8_0
AI_LOCAL_EMBED_MODEL=all-minilm
```

**A reasoning model is fine.** `src/lib/aiLocal.ts` sends `think: false` on every generation, and that is
load-bearing rather than tidy: reasoning tokens are generated, so they spend `num_predict`. Without the flag,
the moderation prompt at its usual 64-token budget spent all of it deliberating and returned an empty answer,
which `parseVerdict` reads as nothing - indistinguishable from the model finding the post acceptable. Every
call site sizes `maxTokens` for an answer, because neither production model reasons.

**Only loopback is accepted.** `assertLoopback` (`src/lib/aiLocal.ts`) throws for any other host, and
`npm run preflight` refuses a deploy that sets the var at all. That is not politeness about configuration:
`domain/aiPolicy.ts` keeps a model allowlist because the `AI` binding will proxy external providers given a
provider-prefixed id, and a second transport taking a URL from config would be a way around it.

The browser lane sets the same three vars in `e2e/e2e.vars`, for the same reason the `EMAIL_*` block is there.

### Driving the features

Four of the eight ride the five-minute cron - the embed drain, ticket triage, suggestion clustering and the
moderation scan - and waiting five minutes per iteration is not a workflow. `wrangler dev --test-scheduled`
exposes the trigger over HTTP (the flag is required; without it the path 404s):

```bash
curl "http://127.0.0.1:8787/__scheduled?cron=*/5+*+*+*+*"
```

`scripts/e2eStack.sh` passes that flag, and `runCron(page)` in `e2e/fixtures.ts` is the browser lane's way in.

**It returns when the event is dispatched, not when the work is done.** The worker log is unambiguous:
`GET /__scheduled 200 OK (1ms)` while the drain behind it embeds hundreds of rows against a model. A spec
must wait for the *effect* - the semantic-search test polls the search API until its row is indexed, firing
another tick each round. Asserting straight after `runCron` returns makes a test pass or fail on timing, and
it looks exactly like a flake.

`cron_runs.summary_json` records `embedded` and `moderated` per tick, so the effect is readable rather than
guessed at. The other four are request-time and just need the feature switched on in
**Settings → Access & security → AI features** (`docs/deploy-ai.md` has the table).

Two tests exercise this lane, and **both skip themselves when Ollama is down** - so a green run does not mean
they ran, and the skip count is the thing to read:

- `test/aiLocalIntegration.test.ts` - **opt-in, `npm run test:ai`**, and excluded from `npm run test` on
  purpose. It is the only test that loads a language model into memory, and the chat models people actually
  install are tens of gigabytes. Run beside the other 309 files it does not merely go slowly, it saturates
  the machine and the damage lands elsewhere: one measured run had it take 250s and blow its own two-minute
  timeouts while `rateLimit` failed on a one-second-stale `Retry-After` and `moderation` timed out at five
  seconds - three red files, one cause, no defects. **Unload the model afterwards** (`ollama stop <model>`);
  Ollama's keep-alive holds it for minutes, and a `npm run verify` started in that window crawls.

  It holds the two assertions a fake cannot make: that embeddings actually **discriminate** (a query sharing
  no words with a row still ranks it first, which is the entire reason the semantic half exists), and that a
  real generation comes back in a shape the strict parsers accept. It takes the two model names from
  `.dev.vars` and, failing that, picks the **smallest** of each kind from Ollama's inventory and **prints
  which two it used**. Smallest is for reproducibility, not speed: taking Ollama's own order picked a 24 GB
  model on one run and a 28 GB one on the next, and a test whose subject changes between runs is not a test.
- `e2e/aiFeatures.spec.ts`, last two describes - the affordances pressed in a browser: a draft written into
  the composer, the narration badge, a CV read into the candidate form, and a ticket found by semantic search
  through a query sharing **no word** with it. The first two describes assert the controls are absent when
  off and present when on, and must keep passing with nothing local running. All four are one file on
  purpose: the switches are one org-wide settings row, and Playwright runs different files in parallel, so
  split across files they raced and the retries hid it.

  The semantic-search test carries its own control - the same record and the same wordless query with the
  feature off, which must find nothing. That pairing is the only thing that distinguishes "the vector index
  answered" from "the search box matches everything".

  **A flagged post rendering on the moderation queue is deliberately not covered.** Producing one means
  getting a model to judge content unacceptable, and a local model is not Llama Guard - asserting on a
  stand-in's verdict would claim exactly what the table below refuses to claim.
  `e2e/moderationQueue.spec.ts` covers what a browser can settle there: the queue is private by default, and
  the nav item and the endpoint agree about who may see it.

### What a local pass proves, and what it does not

| Provable locally | Only the real service can answer |
|---|---|
| Feature switches gate what they claim to | Whether `gemma-4-26b-a4b-it` drafts usefully |
| Budget accounting and the `ai_usage` ledger | Whether `llama-guard-3-8b` judges content correctly |
| `ai_cache` hits (the model *not* being called) | Real neuron cost per call, which `BUDGET` is guessed from |
| Prompt construction, fencing, identifier scrubbing | Vectorize `topK` semantics and `$in` metadata filtering |
| Output parsing and coercion | Vectorize upsert consistency timing |
| Every fallback and refusal path | AI Gateway behaviour and its payload suppression |
| Drain rotation, sweep order, orphan cleanup | |
| The UI affordances and the moderation queue flow | |

The second column is why this does not replace a production smoke - it shrinks it. The moderation test here
deliberately asserts on the **format** of a verdict and never on the verdict itself, because Llama Guard's
judgement is not a thing a local Gemma can stand in for. That distinction is the bug this layer already had
once: moderation called the instruct model by mistake, it answered in prose, the strict parser rejected every
answer, and the feature flagged nothing while looking healthy.

## After a suite run: reap the workers

`@cloudflare/vitest-pool-workers` starts one workerd per test file. A run that **exits cleanly takes them with
it** - a full green gate went from 311 processes to 0 unaided. A run that is **interrupted, or dies on a
timeout, does not**: a session of failing and abandoned runs left **310 alive with their parent gone**.

They hide in the obvious place. Each holds only ~14 MB resident, so nothing stands out in `ps` - but each also
holds a much larger set of swapped-out pages, and the accumulated set had pushed swap to **32 GB of a 34 GB
swap file**. Reaping them took it to 2.8 GB. Nothing reclaims them on their own; they sit until somebody
notices the RAM is gone.

`npm test`, `npm run test:gate` and `npm run test:ai` now reap on the way out (`posttest*` hooks). By hand:

```bash
npm run cleanup:workerd
```

It kills only processes that are **both** miniflare's own workerd binary **and** reparented to init, which is
what keeps it from touching a running `wrangler dev` (a different binary, under `node_modules/wrangler/`) or a
vitest run in another terminal (children whose parent is still alive).

**Unload the model too, after `npm run test:ai`** - `ollama stop <model>`. Ollama's keep-alive holds a
multi-gigabyte model for minutes, and a `npm run verify` started in that window crawls or stalls outright.

## Writing a new test

- Pure domain logic: no runtime imports, no DB. Keep it in the fast lane.
- Anything touching a route: go through `app.fetch` so the middleware chain (auth, authz, wire ids, CSRF)
  runs. A service called directly proves nothing about access.
- New collection, new drift risk: prefer a gate that fails on the whole class over one example test. Every
  drift test above exists because a conversion or a copy-paste silently dropped behaviour once.
- A browser spec (`e2e/`) only for something a browser is REQUIRED to observe: it renders, it navigates, the
  list refreshes, a file is generated client-side, the layout holds, the console is clean. If the same fact
  can be asserted through `app.fetch`, it belongs in `test/` instead.

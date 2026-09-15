# Frontend defects

Pre-production review of `web/src`. Source read directly; no gates run, no docs consulted.

Findings are ordered worst first within each section. Each one names the file and line so it can be
checked against the code rather than taken on trust.

## Status

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | PDF signature coverage check is skipped when the file holds a second `/ByteRange` match | security | fixed |
| 2 | Four surfaces the app calls too sensitive to store are recorded in Sentry replay | security | fixed |
| 3 | A failed review submit deletes the manager's draft write-up and ratings grid | data loss | fixed |
| 4 | Goal carry-over silently drops the measure, kind, department and blocked-by | correctness | fixed |
| 5 | `settingsStore.fetchAll()` writes `etags` outside the generation guard | correctness | fixed |
| 6 | A manager cycle is creatable, and then org-chart search hangs the tab | correctness | fixed |
| 7 | Snooze wake-up fires N invalidating PATCHes | request storm | fixed |
| 8 | `RequestLeaveDialog` upload-failure path leaves `restored` set | cosmetic | fixed |
| 9 | ACL dead-rule lint calls a `create` grant redundant when it is not | correctness | fixed |
| 10 | Bank-file action is hidden from any caller who is not `super_admin` by role | correctness | fixed |
| 11 | "Paid this month" is bounded by the viewer's calendar month, not the org's | correctness | fixed |
| 12 | Another location's holiday zeroes the org-wide "not clocked in" KPI | correctness | fixed |
| 13 | A saved ticket workflow is not picked up until the tab is reloaded | correctness | fixed |
| 14 | Workflow action bodies coerce numeric-looking strings on every edit | correctness | fixed |
| 15 | Three settings strings render raw `\uXXXX` escapes on screen | user-visible | fixed |
| 16 | Every memo guarding DataTable's filter/sort pass is invalidated each render | performance | fixed, in part |
| 17 | `personName` is a linear scan used as a column accessor | performance | fixed |
| 18 | Board re-filters and re-sorts every card once per column-lane cell, twice | performance | fixed |
| 19 | `startClippedTitles()` runs unconditionally in production | performance | decided: it ships |

### What each fix was

1. `verifyPdfSignatures` decides `isLast` over the furthest raw that actually parses as a PKCS#7 `SignedData`
   (`parsesAsSignedData`), so a stray `/ByteRange` match can no longer take the last position and spare the
   real signature its append check. Backed by a property of the FILE - nothing but whitespace after the
   furthest `c + d` of any raw - which no single match can displace.
2. `data-sentry-block` on the minted API key (field and curl line) and on the holiday feed URL;
   `data-sentry-mask` on `MyCompensation`'s card content, the shared `ApprovalRow` summary/context lines (which
   covers Approvals, Dashboard, Leaves, Expenses and LeaveCalendar at once), the tax-verification queue rows,
   the candidate contact line and notes, the referral candidate email, and the dashboard's approval `desc`;
   `loans` added to `SENSITIVE_PAGES`. `test/replayMaskDrift.test.ts` passes, with one new exemption
   (`GenerateLetterDialog`, which renders a document NAME and an `<iframe>` replay already blocks).
3. `Reviews.tsx#act` returns a boolean like `Tickets.tsx#act`, and both submit paths drop their drafts only
   on `true`.
4. Carry-over sends the same field set the edit form does: `kind`, the whole measure, `department`,
   `blocked_by`.
5. `fetchAll` returns `{ values, etags }`; every call site adopts both inside its existing generation guard.
6. Three parts: the visited-set guard on the org chart's third parent walk;
   `services/employees.ts#assertNoManagerCycle`, one recursive CTE, refusing the write for every caller
   including the API; and both manager pickers excluding `reportsUnder` rather than just self.
7. `skipInvalidation` on each wake-up PATCH, then one `broadcastInvalidation` when they settle - the shape
   `markManyRead` in the same file already used.
8. `setRestored(false)` on the attachment-failure path.
9. `covers()` treats `create` as its own dimension. `denyBlocking` inherits it, which is the answer
   `buildPattern` gives. Pinned by `test/aclCreateScopeLint.test.ts`.
10. The role gate is gone; `bank-formats` is read unconditionally and `run.access.can` decides.
11. Org-local `YYYY-MM` comparison, shared by the tile and its drill-through; `periodKeyOf`'s latent local
    fallback now goes through `todayStr()`.
12. `applies !== false` on `isHolidayToday`, and on `Leaves.tsx`'s holiday-name map (which
    `test/holidayAppliesDrift.test.ts` found).
13. `rehydrateTicketWorkflow` + a `subscribeInvalidations` on `settings`, plus a listener set so mounted
    `useTicketWorkflow` callers take the new table without remounting.
14. `parseValue` coerces only when the text round-trips exactly and the result is finite. Moved with its two
    neighbours into `web/src/components/workflows/bodyValue.ts` so it can be tested without a DOM
    (`test/workflowBodyRoundTrip.test.ts`).
15. The three escapes are the characters themselves.
16. Partly, and the limit is written at the call site. `managedIds` is keyed on an id signature, which makes
    `orderedManaged` stable and stops the layout-persist effect stringifying the prefs payload every render;
    `filtered` keeps its previous array identity when the result is unchanged, so nothing downstream churns.
    The filter/sort pass itself still runs per render, deliberately: a column accessor closes over data the
    page loaded separately, and freezing the memo on a column-ID signature would keep sorting through an empty
    directory long after the cells beside it rendered the names. The pass was made cheap instead (17).
17. `personName` takes a prepared `Map`, built once by `personIndex`; the six pages that wrap it as `empName`
    now pass one.
18. `useCardFilter`'s `match` is a `useCallback` with a pre-lowered needle, `visible` is memoized, and every
    column-lane cell is built in one bucketing pass.
19. It ships, and the call site now says why and what it costs.

---

## 1. PDF signature coverage check is skipped when the file holds a second `/ByteRange` match

`web/src/lib/pdfSignature.ts:314-320` (`verifyPdfSignatures`), deciding `verifyOne`'s `isLast` at `:275`

The append check is the load-bearing half of this module. Its own docstring on `coversDocument` says why:
a PKCS#7 verifies over the bytes the signer *named*, and "an incremental update can supersede every visible
page while leaving the original trailer, `/ByteRange` and `/Contents` untouched, and the PKCS#7 still
verifies perfectly - over bytes that are no longer what the document shows". So:

```ts
const coversDocument = raw.tilesFile && (isLast ? raw.reachesEnd : true);
```

`reachesEnd` - the thing that catches an append - is required **only of the last signature**, which is
correct for a countersigned PDF where earlier signers legitimately stop short. But `isLast` is decided by
counting regex matches, not signatures:

```ts
const raws = extractRawSignatures(pdfBin);            // regex over the whole file, no PDF parsing
for (let i = 0; i < raws.length; i++) out.push(await verifyOne(pdfBin, raws[i]!, i === raws.length - 1));
```

`extractRawSignatures` scans the raw bytes for `/ByteRange [ n n n n ]` and keeps any match whose gap holds
a `<…>` with at least one hex digit. That pattern is not confined to real signature dictionaries - it can
occur inside a content stream, a string, or an embedded file, and a PDF that carries another PDF as an
attachment is the ordinary case. Such a match parses to junk, so `verifyOne` throws and reports it amber -
harmless on its own. What is not harmless is that it now occupies the last position, so the **real**
signature is verified with `isLast` false and its append check is skipped entirely.

**Failure:** a signed document that has been appended to after signing renders its signature widget with the
green "Signature valid" stamp and the signer's name. The note that would have said "the document was changed
after it was signed (content was appended)" is suppressed, because `coverageNote` is gated on the same
`isLast`. The stamp over the widget is the thing a reader reads, and it is asserting the one thing this
module exists to refuse to assert.

Partly mitigated, and worth stating plainly: the toolbar's `overall` badge (`SignedPdfViewer.tsx:130-134`)
goes amber because the junk entry is `unknown`, and that entry also renders as an extra unexplained chip. A
reader who notices the mismatch between an amber header and a green stamp has a signal; the design does not
depend on them noticing.

**Fix:** `isLast` should be decided over signatures, not over regex matches - carry the parsed
`SignedData` (or a parse-succeeded flag) out of `verifyOne` and treat only those entries as positions in the
revision chain. A cheap second belt: require that the bytes after the furthest `c + d` across all raws are
whitespace, which is a property of the file rather than of any one match.

`test/pdfSignatureCoverage.test.ts` already pins the coverage arithmetic; this is the caller that decides
which arithmetic applies, and it is not covered by that test.

## 2. Four surfaces the app calls too sensitive to store are recorded in Sentry replay

Against `web/src/instrument.ts:100-130` and `:310-311`.

**The app already keeps the list.** `lib/resourceStore.ts:55-83` maintains `MEMORY_ONLY` - collections whose
rows may never be written to disk - and states the test: "a copy of the most sensitive data the system holds,
in plaintext, on a machine the org may not own". That is the same judgement replay masking makes, about the
same data, one hop further out: a replay ships it to a third party with retention attached.

Cross-referencing `MEMORY_ONLY` against what is actually masked gives a derivable gap list rather than a
matter of taste. Four collections are on one list and not the other:

| Collection (`MEMORY_ONLY`) | Where it renders | Masked? |
|---|---|---|
| `api-keys` | `ApiKeysPanel` mint dialog (Settings) | no - **2a** |
| `compensation` | `MyCompensation` (Profile) | no - **2b** |
| `tax-verifications`, `loans` | `Approvals` inbox | no - **2c** |
| `candidates` | `Candidates`, `CandidateProfile` | almost none - **2d** |

The rest line up: `payslips`, `payroll-runs`, `offers`, `tax-declarations`, `background-checks`,
`personal-documents` and `document-acknowledgements` all sit on `SENSITIVE_PAGES` routes; `settlements`,
`bonuses` and the identity collections have masked dialogs; `dependents`/`benefit-enrollments` are masked in
`Benefits.tsx`.

**Sampling, first, because it bounds all of them:** `replaysSessionSampleRate: 0` but
`replaysOnErrorSampleRate: 1`. Ordinary sessions are not recorded - but *every* session that hits an error
is, at 100%, and on-error replay ships the buffered window preceding the error. So any error in the same
sitting captures whatever was on screen before it.

`instrument.ts` runs replay **unmask-by-default** (`maskAllText: false`, `maskAllInputs: false`) and masks
only what is listed: `.sentry-mask` / `[data-sentry-mask]`, the `SENSITIVE_PAGES` route selectors,
`input[type="password"]`, `input[autocomplete*="cc-"]`, and `input[name*="account"|"ifsc"|"pan"|"aadhaar"|"uan"]`.

### 2a. The minted API key secret

`web/src/components/common/ApiKeysPanel.tsx:732-770`

The mint dialog shows the secret twice, and neither rendering matches any mask rule:

```tsx
<Input readOnly value={minted ?? ""} className="font-mono text-xs" … />          // :743
const curlSnippet = `curl -H "Authorization: Bearer ${minted ?? "<key>"}" \\…`;  // :292, rendered as plain text
```

- The input is plain text with no `name` and no `type` - no rule matches it.
- The curl line is not an input at all; it is DOM text, so even `maskAllInputs: true` would not cover it.
- API keys live under Settings, which is not in `SENSITIVE_PAGES`.
- And a route mask could not reach it anyway. `instrument.ts` says so: "A dialog renders through a PORTAL,
  as a child of `<body>`, so it sits outside `<main data-page="…">` and the route mask above cannot reach it".

`grep sentry ApiKeysPanel.tsx` returns nothing.

**Impact:** the panel's own copy is the severity statement - "A machine credential that acts as you"
(`:475`). The secret is shown once and is unrecoverable, so there is no rotation prompted by discovery; it
leaves for a third party and is retained there, and anyone with Sentry access has a live credential acting as
the person who minted it.

### 2b. The employee's own salary, on the Profile page

`web/src/components/common/MyCompensation.tsx`, mounted inline at `pages/Profile.tsx:233`

No `sentry-mask` or `sentry-block` anywhere in the file, and it renders:

- `:93` annual CTC, as the card's headline figure;
- `:96` the pending arrears amount;
- `:110`, `:122` every line of the CTC build-up;
- `:164` the full salary-revision history - every past CTC the employee has been on.

This one is not an oversight against a silent rule; `instrument.ts` states the rule and names this page:
"`profile` and `employees` are deliberately NOT on that list (masking them hid the headings, statuses and
dates that make a replay readable while the values that matter are in a handful of panels). So a panel added
to the profile is recorded unless it says otherwise: give it `sentry-mask`". `MyCompensation` is such a
panel and never said otherwise.

More routine than 2a, and that is the point: minting an API key is rare, opening your own profile is not. The
exposure is the viewer's *own* pay rather than someone else's, so this is "this person's salary history went
to a third party", not a cross-user leak - still a compensation figure leaving the building with retention
attached.

**Covered, for contrast:** `PayrollBonuses.tsx` also renders money with no mask, but it mounts inline at
`PayrollRuns.tsx:578` and `payroll-runs` *is* in `SENSITIVE_PAGES`, so the route mask reaches it. Nothing to
do there.

### 2c. Other people's loans and prior-employer income, in the Approvals inbox

`web/src/pages/Approvals.tsx` - no mask attribute anywhere in the file

This is the worst of the four, because it is the only **cross-person** one. The others expose the viewer's
own data or a credential they just minted; a manager's Approvals inbox renders several other employees':

- `:107` - the tax-verification queue: `Income {money(v.prior_employer_income)} · TDS {money(v.prior_employer_tds)}`,
  by name. `tax-verifications` is `MEMORY_ONLY`, and the *same figures* on the Tax declarations page are
  masked, because `tax-declarations` is on `SENSITIVE_PAGES`. One page masks them, the other does not.
- `:213` - `sumLoan`: each person's loan principal and instalment count.
- `:209`, `:212`, `:222` - reimbursement amounts with descriptions, encashment payouts, expense amounts with
  invoice numbers.

So one replay from one approver's session discloses a slice of several colleagues' financial records.

### 2d. Candidates' personal contact details

`web/src/pages/Candidates.tsx` (no mask at all), `pages/CandidateProfile.tsx:234` (one attribute)

`Candidates.tsx:189` renders `{[c.email, c.phone].filter(Boolean).join(" · ")}` on every row - personal
email and phone, plus free-text notes elsewhere on the page.

`resourceStore.ts:79-83` argues this case better than I can, and it is already the reason these rows are
never written to disk: "Candidates are the one collection here whose subjects are not employees: name,
personal email, phone and free-text notes on people OUTSIDE the org, who never agreed to anything and cannot
ask for it back."

`CandidateProfile` is the sharpest illustration of the underlying problem: it carries exactly **one**
`data-sentry-mask`, on the offer's `base_comp` at `:234`. Someone did consider masking on this page, picked
the salary figure, and left the candidate's email, phone and notes recorded. That is "applied by
remembering" in its purest form.

### Why the existing test does not catch any of them

`test/replayMaskCoverage.test.ts` asserts a hand-written
`SENSITIVE_DIALOGS` list of nine components, all employee PII, and globs only
`web/src/components/common/*.tsx`. Both `ApiKeysPanel` and `MyCompensation` are in that directory and simply
are not on the list - and note that `EmployeeCompensation`, the HR-facing twin of `MyCompensation`, *is*. The
test's own comment names this exact failure mode: "Per-dialog means someone has to remember, which is
exactly the kind of thing that gets forgotten in a refactor and fails SILENTLY: the dialog still works, the
replay still records, and the account number is simply in it."

The convention itself is well understood in this codebase - `ActivityFeed.tsx` is the model, putting
`data-sentry-mask` on every diff value, the IP, the user agent and the raw meta blob while deliberately
leaving field *names* readable (`:51-53`, `:210`). These two components are the ones that did not get it.

It is the same structural trap `resourceStore.ts:73-78` documents for `MEMORY_ONLY` - "it was persistable
only because the rule above was applied by remembering, and the test that pins this set asserts a
hand-written allowlist, so nothing caught it."

**Fix, per surface:** `sentry-mask` on `MyCompensation`'s card, on the Approvals queue rows, on the
candidate contact line, and on the minted-secret dialog - with `data-sentry-block` for the key specifically,
since block removes the element from the recording rather than substituting characters. Add `approvals`,
`candidates` and `loans` to `SENSITIVE_PAGES` if the route-level answer is preferred for those three; the
`unmask` list already keeps headings, columns and buttons readable on a masked route, so the cost is the
values only.

**Worth more than any of the four fixes:** derive the requirement instead of restating it. `MEMORY_ONLY` and
the replay-mask set encode the same judgement about the same data, and they are maintained by hand,
separately, so they drifted apart in four places. A test that walks `MEMORY_ONLY`, resolves each collection
to the components that render it, and asserts a mask or a `SENSITIVE_PAGES` route would have failed on all
four - and would keep failing for the next collection someone adds to either list.

Failing that, the minimum is to invert the existing test: `replayMaskCoverage.test.ts` enumerates the
components that must opt in, so it cannot fail for a component nobody remembered - which is exactly what
happened four times. Scanning for the *rendering* and requiring a mask or a reviewed exemption fails closed.
`resourceStore.ts:73-78` documents the identical trap catching `MEMORY_ONLY` itself: "it was persistable only
because the rule above was applied by remembering, and the test that pins this set asserts a hand-written
allowlist, so nothing caught it."

**Secondary, same class, lower value:** `Holidays.tsx:358` renders
`${origin}/calendar/holidays/${me.holiday_feed_token}` as copyable text on an unmasked route. That token is a
bearer credential for one person's holiday feed - far less valuable than an API key, but it is a secret in
plain DOM text and the same one-attribute fix applies.

**Deliberately not flagged:** `AssetTagPrinter.tsx:397` and `Assets.tsx:122-130` put `tag_secret` into a QR
payload and a scan URL. Those secrets are printed on physical stickers stuck to the asset by design, so a
replay showing one discloses nothing the object does not already show to anyone in the room.

## 3. A failed review submit deletes the manager's draft write-up and ratings grid

`web/src/pages/Reviews.tsx:172-180` (`act`), `:758-767` and `:947` (the two submit handlers)

`act` is the shared verb runner for this page, and it **swallows**:

```tsx
async function act(r: Review, verb: string, body?: Record<string, unknown>) {
  try {
    await invoke(`reviews/${idOf(r.path)}`, verb, undefined, body);
    toast({ title: REVIEW_TOAST[verb] ?? "Review updated", variant: "success" });
    reloadAll();
  } catch (e) {
    toast({ title: "Couldn't update review", description: (e as Error).message, variant: "destructive" });
  }
}
```

Both submit paths are `act` (`:546` self, `:547` manager) and both clear their drafts on the line after the
await:

```tsx
await onSubmitManager({ ratings, overall_rating: overall, manager_comment: mgrComment.trim(), … });
clearDraftFor("manager"); clearDraftFor("ratings"); clearDraftFor("overall"); clearDraftFor("goalRatings");
```

Because `act` never rejects, that runs on a **refused** submit too.

**Failure:** the manager sees "Couldn't update review: …", and their written assessment, every competency
rating, the overall rating and every per-goal verdict have been deleted from the draft store. The form still
shows the values, because component state is untouched and the failure path skips `reloadAll()` - so nothing
on screen says anything was lost. Navigate away or reload and the whole thing is gone, under a label that has
been reading "Draft saved on this device" the entire time (`:950`, `:1040`).

Reachable on any refusal: a 409 when someone else moved the stage, a 403 after a grant narrowed, a 429 on
cycle-deadline day, a dropped connection. The self-assessment path (`:947`) has the identical shape.

The file's own comments are what make this worth ranking high - `:630-633` ("Long-form review text survives
navigating away") and `:644-645` ("losing it silently while 'Draft saved on this device' showed was the worst
of both") both describe exactly the outcome the code now produces.

**Not a general pattern - the repo already has both fixes elsewhere.** `PostComposer.tsx:646-647` puts
`clearDraft` *inside* the `try`, after the awaited write, so a throw skips it. And `Tickets.tsx:917-950` has
a helper with the same name doing the other half correctly:

```tsx
async function act(verb: string, …): Promise<boolean> {   // returns the outcome
  try { … return true; } catch (e) { … return false; }
}
const sendReply = async () => { if (await act("comment", { body: reply.trim() })) setReply(""); };
```

Reviews is the outlier, and the difference is entirely that its `act` swallows and returns `void`.

**Fix:** make Reviews' `act` return a boolean the way Tickets' does and gate both call sites on it, or move
the `clearDraftFor` calls inside `act`'s `try` the way PostComposer does. Either restores the invariant that
a draft is only dropped once the server has the work.

## 4. Goal carry-over silently drops the measure, kind, department and blocked-by

`web/src/pages/Goals.tsx:575-592`

Carry-over clones an open past-quarter goal into next quarter and cancels the original. The clone is built
from nine fields:

```tsx
const copy = await create<Goal>("goals", {
  title, description, weight, progress, status,
  due_date: nextQuarterEndStr(),
  ...(g.employee ? { employee: … } : {}),
  ...(g.parent ? { parent: … } : {}),
  ...(nextCycleRef ? { cycle: nextCycleRef } : {}),
});
```

`GoalInput` (`src/services/goals.ts:35-55`) accepts seven more that the page's own edit form
(`Goals.tsx:429-448`) already sends, and carry-over sends none of them:

- `unit`, `baseline_value`, `target_value`, `current_value` - the whole measure;
- `kind` - so a `key_result` comes back as an `objective`;
- `department`, `blocked_by`.

**Failure:** carrying over a measured key result produces a goal with no measure. `measuredPct`
(`lib/goalMeasure.ts`) returns null, the drawer's measure control disappears, and the goal silently becomes a
manual-progress goal that happens to be carrying the old percentage. It is worse than a clean loss, because
the number that feeds weighted attainment in a review - and through `review-cycles:award`, variable pay -
survives while the thing that produced it does not. Nothing on screen says the measure went.

**Fix:** carry the same field set the edit form sends. A shared `goalBody(g)` used by both is the version
that cannot drift again.

## 5. `settingsStore.fetchAll()` writes `etags` outside the generation guard

`web/src/lib/settingsStore.ts:128`

Every call site guards the *values* against a superseded fetch (lines 175-183, 193-199, 211-217, each
`if (generation !== gen) return`). But `fetchAll` assigns the module-level `etags` map as a side effect
before it returns, so that assignment is not guarded by anything.

```ts
// settingsStore.ts:128, inside fetchAll()
etags = new Map(rows.flatMap((s) => (s.etag ? [[s.key, s.etag] as [string, string]] : [])));
return new Map(rows.map((s) => [s.key, s.value]));
```

A stale fetch that resolves after a newer one has its values discarded and its etags kept. `etags` then
describes a different snapshot than the one `loaded` holds, which breaks the invariant stated at line 29
("in step with `loaded`/`stored` at all times") and the whole point of the guard `saveSetting` exists for.

**Failure:** `getSetting` returns a fresh `value` with a stale `version`. `saveSetting` sends that as
`If-Match`. The server refuses a save that should have succeeded. Recovery works, because the catch at
line 275 calls `invalidateSettings`, so it surfaces as an intermittent "someone else changed this" on the
first Save press with the second press succeeding.

**Fix:** return `{ values, etags }` from `fetchAll` and assign both inside the same generation guard that
adopts the values.

## 6. A manager cycle is creatable, and then org-chart search hangs the tab

Two halves, each harmless alone.

**Half one - nothing stops the cycle being written.** The org chart's drag path guards properly
(`OrgChart.tsx:385-394`): `targetId === id` is refused, and `descendantsOf(id).has(targetId)` refuses a move
into your own subtree. But it is the only write path that checks. The two manager pickers exclude **self and
nothing else**:

```tsx
// Directory.tsx:803-806
...rows.filter((e) => !e.delete_time && (!editing || e.path !== editing.path))
// EmployeeProfile.tsx:688
...employees.filter((e) => !e.disabled && idOf(e.path) !== id)
```

So A's own report B is an offered option for A's manager. And the server does not check either -
`src/services/employees.ts:271` is a bare `set.managerId = idFromPath(patch.manager) ?? null`. The codebase
knows the shape of this guard: `src/services/goals.ts:58-65` runs a recursive CTE with a `CHAIN_CAP` for
exactly this, on `parent` *and* `blocked_by`. Employee `manager` got none.

Reaching it takes one ordinary edit. Mid-reorg, "Priya now reports to Sam" while Sam still reports to Priya
is a state an HR admin passes through on the way to the intended shape.

**Half two - the search box then spins forever.** `OrgChart.tsx:203-211` walks each match's ancestor chain
with no visited set:

```tsx
for (const id of matches) { let p = nodes.get(id)?.parentId ?? null; while (p) { forceOpen.add(p); p = nodes.get(p)?.parentId ?? null; } }
```

Its two siblings a hundred lines below both guard the identical walk - `:342`
(`while (p && !trail.includes(p))`) and `:363` (`while (id && !trail.includes(id))`). This one does not, and
it runs inside a `useMemo` during render, so typing a term that matches anyone inside the cycle freezes the
tab outright rather than rendering slowly.

**Bounded, and worth saying so:** this is a client hang, not a server one. There is no recursive manager-chain
walk server-side - approval routing resolves the direct manager in one hop
(`src/services/notifications.ts:303`) - so a cycle there means A approves B and B approves A, which is a
policy oddity rather than a loop.

**Fix, in order of value:** add the visited-set guard at `:208` to match its two siblings (that removes the
freeze whatever the data does); add the cycle check to `updateEmployee` server-side, where it holds for every
write path including the API; and have both pickers exclude `descendantsOf` rather than just self, so the UI
stops offering a move it will refuse.

**Also worth noting:** `OrgChart.tsx:55` reads employees with `{ all: true }`, whose `ALL_CAP` is 1000
(`hooks/useCollection.ts:10`). Past that the tree is partial, so even the drag path's `descendantsOf` can
miss a descendant and pass a move it should refuse - another reason the check belongs on the server.

## 7. Snooze wake-up fires N invalidating PATCHes

`web/src/lib/notifications.tsx:299-302`

```tsx
for (const n of woken) {
  publish(NOTIF_TOPIC, { op: "reminded", path: n.path });
  void patch(`notifications/${idOf(n.path)}`, { snooze_until_time: null }).catch(() => {});
}
```

No `skipInvalidation`. Each PATCH runs `withInvalidation` (`api.ts:322`) which calls
`invalidateCollections(["notifications"])`, and the provider is always subscribed, so every one forces a
re-read of the whole feed. `patchRows` also stamps `patchedAt`, so a forced read already in flight when the
next write lands fails the `e.patchedAt >= startedAt` check in `resourceStore.ts:543` and is discarded and
rescheduled rather than adopted.

This is the same shape, in the same file, that `markManyRead` (lines 384-411) was written to avoid, with
the reasoning spelled out in its docstring.

**Fix:** pass `{ skipInvalidation: true }` on each PATCH, then a single
`broadcastInvalidation(invalidateCollections(["notifications"]))` once they settle.

## 8. `RequestLeaveDialog` upload-failure path leaves `restored` set

`web/src/components/common/RequestLeaveDialog.tsx:566-571`

The success path clears the flag (line 576); the attachment-failure path does not, though it otherwise does
the same cleanup (clears the draft, resets the form, closes the dialog).

The dialog closes with `restored === true`, so a caller that keeps the component mounted shows
"Picked up where you left off" with a Start over link, over an empty form, for a draft that was just
deleted. `Leaves.tsx:1161` mounts it as `{open && <RequestLeaveDialog …/>}` so the remount hides it there;
it is a trap for the next mount site rather than a live bug today.

**Fix:** `setRestored(false)` alongside the other resets on the failure path.

## 9. ACL dead-rule lint calls a `create` grant redundant when it is not

`web/src/components/access/ruleLogic.ts:71-76`, used by `ruleFlags` at `:133-147`

`covers(a, b)` answers "does rule a reach everything rule b reaches":

```ts
function covers(a: AccessRule, b: AccessRule): boolean {
  if (a.scope === "all") return true;
  if (a.scope !== b.scope) return false;
  …
}
```

`create` is not another tier of the same axis - it is a separate dimension. `src/domain/policyValidate.ts:55`
says so outright: "scope=create gates collection-level creation; it takes no field or verb". `targetCovers`
just above already handles the other separate dimension explicitly (line 93, "the standard ladder and a
custom method are different dimensions"); `covers` has no equivalent guard, so `a.scope === "all"` returns
true against a `create` rule.

`create` is also absent from `BREADTH`, so `BREADTH["create"] ?? 0` is 0 and the breadth test passes
trivially. The `shadowed` branch therefore fires whenever one subject holds **both** an `all`-scope allow at
`write` or `admin` **and** a `create` allow on the same collection - which is what a full-admin role on any
catalog looks like.

**Failure:** the modal badges the create rule "Already covered by a broader rule (write access to all leave
types), so this one adds nothing". Deleting it - which is what a lint saying "adds nothing" exists to invite
- revokes the ability to add records. A lint that gives wrong advice in the direction of removing a grant is
worse than no lint.

Not reachable from the two built-in presets: `openBox` (`AclModal.tsx:469`) pairs `create:write` with
`all:read`, and `1 >= 2` fails the level test; `selfService` (`:470`) pairs it with `self:write`, where
`covers` returns false. It is the hand-authored admin shape that trips it.

**Fix:** make the dimension explicit in `covers`, before the `all` shortcut:

```ts
if ((a.scope === "create") !== (b.scope === "create")) return false;
```

`denyBlocking` (`:158-165`) shares `covers` and would want the same answer decided deliberately: whether an
org-wide deny also bars creation is a question about the engine, not about this lint.

## 10. Bank-file action is hidden from any caller who is not `super_admin` by role

`web/src/pages/PayrollRuns.tsx:246-256`, consumed at `:478`

```tsx
const [banks, setBanks] = useState<string[]>([]);
useEffect(() => {
  if (!isSuperAdmin) return;          // isSuperAdmin = me.role === "super_admin"  (line 101)
  get<{ results: BankFormat[] }>("bank-formats") …
}, [isSuperAdmin]);
…
const canBankFile = run.access?.can?.includes("bankFile") && [...] && banks.length > 0;
```

`bankFile` is one of the candidate verbs `accessHint` computes for this collection
(`src/http/accessHint.ts:57`), so `run.access.can` already carries it exactly when the caller may invoke it.
The row then hides the action anyway, because `banks` is empty for anyone whose **role** is not
`super_admin` - and a role is not a permission.

This is the same defect the same file documents having fixed one screen above, for Approve
(`PayrollRuns.tsx:467-475`): "Asking `me.role === "super_admin"` here instead asked about a ROLE rather than
a PERMISSION, and cost two things: a finance director granted `payroll-runs.*.approve` by an access rule
still saw no button (the only remedy being an edit to grants.ts, which is the thing access rules exist to
avoid)". Identical sentence, identical remedy, `bankFile` was not in that pass.

The role gate also buys nothing it claims to: the fetch's own `.catch(() => {})` already swallows a 403, so
a caller without `bank-formats.read` ends up with an empty list either way.

**Fix:** drop the role gate and read `bank-formats` unconditionally (or gate on
`usePermission("bank-formats.read")`). The action then appears for exactly the callers who hold both the
verb and the list - which is also worth stating somewhere, because granting `bankFile` without
`bank-formats.read` leaves a verb the UI cannot drive.

## 11. "Paid this month" is bounded by the viewer's calendar month, not the org's

`web/src/pages/Expenses.tsx:312`, read at `:313-317` and `:333`

```tsx
const monthStart = useMemo(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1).getTime(); }, []);
```

Local parts, browser clock. `lib/orgDay.ts`'s header names this exact shape as the thing it exists to
remove, and every other date in this file already goes through `todayStr()` (`:325`, `:430`). It drives two
things: the "Paid this month" money tile (`:1119`, `money(sum(paidThisMonth))`) and the KPI drill-through
that narrows the ledger by the same boundary (`:333`).

**Failure:** the figure differs per viewer. For an org on IST and an approver reading from New York, an
expense paid at 02:00 IST on the 1st sits before the reader's month start and drops out of the total; west
of UTC it goes the other way and late-previous-month payments are counted in. `useMemo(…, [])` also freezes
it at mount, so a tab left open across a month boundary keeps reporting the old month.

**Fix:** compare org-local months - `orgDayOf(r.paid_time).slice(0, 7) === thisMonthStr()` - which is the
form used elsewhere, and drop the frozen millisecond boundary.

`periodKeyOf` (`:85`) carries a latent copy of the same fallback (`dateStr ? … : new Date()`). It is
unreachable today because both callers pass `q.incurred_on || todayStr()`, but it is one call site away.

## 12. Another location's holiday zeroes the org-wide "not clocked in" KPI

`web/src/pages/Dashboard.tsx:430`, gating `:838` and `:879`

```tsx
const upcomingHolidays = useMemo(
  // `applies === false` is a regional holiday for another location - not this viewer's day off.
  () => holidays.filter((h) => h.date >= today && !h.disabled && h.applies !== false)…
const isHolidayToday = useMemo(() => holidays.some((h) => h.date === today && !h.disabled), [holidays, today]);
```

The `applies !== false` clause, and the comment explaining why it is required, sit one line above. The
`isHolidayToday` line drops it.

Every other reader in the app applies it: `Attendance.tsx:274-275` ("A regional holiday for another
location (`applies === false`) is a normal working day here"), `LeaveCalendar.tsx:258`,
`TeamTimeline.tsx:353`, and four places in `Holidays.tsx`. `Dashboard.tsx:430` is the only omission.

**Failure:**

```tsx
const notClockedIn = isHolidayToday ? 0 : Math.max(0, headcountV - clockedIn - onLeaveV - remoteTodayV);
```

Configure a regional holiday for one office and the whole org's "Not clocked in" KPI reads **0**, with the
hint "Holiday today" (`:879`), on a day that is an ordinary working day for everyone else. The attendance
gap an ops dashboard exists to surface is suppressed precisely when there is one to see, and the hint
asserts a reason that is false for most of the org.

**Fix:** add `&& h.applies !== false`, matching the line above it. (`!h.delete_time` is not needed - this
page reads `holidays` without `showDeleted`, so deleted rows never arrive.)

## 13. A saved ticket workflow is not picked up until the tab is reloaded

`web/src/lib/ticketWorkflow.ts:32-55`

The module mirrors `settings/ticket-workflow` into a synchronous module variable, memoized for the life of
the page:

```ts
let active: StateMachine = DEFAULT_TICKET_WORKFLOW;
let hydrating: Promise<StateMachine> | null = null;
export function hydrateTicketWorkflow(): Promise<StateMachine> {
  hydrating ??= readSetting<StateMachine>("ticket-workflow").then(…);
  return hydrating;
}
```

Nothing ever clears `hydrating`. Its sibling mirrors all do: `lib/orgDay.ts:61-71` exports
`rehydrateOrgTimezone` and subscribes to `subscribeInvalidations`, and `lib/clock.tsx:102-109` re-reads on
the same signal. `ticketWorkflow.ts` imports neither, and is the only one of the three that does not.

**Failure:** after an admin saves a customised workflow, every open tab - the admin's own included - keeps
the table it booted with. The board renders the old columns and the move menu offers transitions the server
will now refuse, until somebody reloads.

That is verbatim the symptom this file's own header says it was written to remove: "this file rendered the
default's columns and the default's move menu while the server accepted a different set, offering moves it
would refuse and hiding custom states entirely" (`:12-16`). Reading the org's table fixed the boot case and
left the after-save case.

`orgDay.ts:52-64` states the general rule in as many words: "Read it AGAIN, because the memo above is settled
for the life of the page … Without this the SPA kept the timezone it booted with for the rest of the session
- so straight after the save the two disagreed."

**Fix:** the four lines `orgDay.ts` already has - a `rehydrateTicketWorkflow` that nulls `hydrating`, plus
`subscribeInvalidations((c) => c.includes("settings") && void rehydrateTicketWorkflow())`. `useTicketWorkflow`
would need to re-run on that signal too, since it snapshots into state on mount.

## 14. Workflow action bodies coerce numeric-looking strings on every edit

`web/src/components/workflows/ActionList.tsx:275-282`

`parseValue` turns a body row's text back into a JSON value. Its own header states the invariant it exists to
hold - "THE ROUND-TRIP HAS TO BE LOSSLESS" - and describes the bug it was written to fix: arrays and objects
were being written back as strings, and "editing any row re-serialises all of them, so touching an unrelated
field was enough". Arrays, objects, `null`, booleans and templates all got a branch. The last line is the
one that still breaks the invariant, in the other direction:

```ts
return v !== "" && !Number.isNaN(Number(v)) ? Number(v) : v;
```

A field whose value is the **string** `"0042"` round-trips to the **number** `42`. Three cases, all silent:

- leading zeros are lost (`"0042"` → `42`), which matters for any code or identifier stored as text;
- `"Infinity"` and `"-Infinity"` become the numbers, and `JSON.stringify` then writes them as `null` - so a
  body field holding that word arrives at the server as a null;
- `" "` (whitespace only) passes the `v !== ""` guard and `Number(" ")` is `0`, not `NaN`, so it becomes `0`.

Templates are correctly exempt (`v.includes("{{")` returns the string), which covers the common case and is
probably why this has not been noticed.

**Reachability, stated honestly:** a string-valued numeric field has to get into the body first, which means
the JSON hatch (`WorkflowBuilder.tsx:38-46`) or a rule seeded server-side. After that, opening the guided
editor and touching *any* row re-serialises all of them - the same amplification the header comment
describes. So it is narrow to author and easy to trip once authored.

**Fix:** the row needs to carry the value's original JSON type rather than re-inferring it from the rendered
text. Failing that, only coerce when the text round-trips exactly (`String(Number(v)) === v.trim()`), which
rejects `"0042"`, `" "` and `"Infinity"` while still accepting `"42"` and `"4.5"`.

## 15. Three settings strings render raw `\uXXXX` escapes on screen

`web/src/pages/Settings.tsx:1282`, `:1288`, `:1289`

The three attribute values in the source each contain a backslash-u escape sequence written directly inside
a double-quoted JSX attribute: the timezone `hint` has one around the word "today" (left and right curly
quotes), and the combobox `placeholder` and `searchPlaceholder` each end with one for an ellipsis. Run
`rg -n '\\u[0-9a-fA-F]' web/src/pages/Settings.tsx` to see them exactly as written.

A double-quoted JSX attribute is JSX text, not a JavaScript string literal, so a backslash-u sequence is not
an escape there - it is six literal characters. The Attendance settings panel therefore renders the word
"today" wrapped in visible backslash-u codes, and the two combobox placeholders end in a visible backslash-u
code instead of an ellipsis.

These are the only three in the frontend. `rg -n '\\u[0-9a-fA-F]{4}' web/src` finds one other hit,
`lib/getCoalescer.ts:65`, which is inside a template literal and is therefore correct.

**Fix:** type the characters directly in the attribute, or wrap the value in braces so it becomes a real
string literal and the escapes are interpreted.

---

## 16. Every memo guarding DataTable's filter/sort pass is invalidated each render

`web/src/components/common/DataTable.tsx:215-220`, `462-494`

Pages build their `columns` array as a fresh literal in the render body:

```tsx
// pages/Assets.tsx:353, pages/Directory.tsx:476, and the rest
const columns: Column<Asset>[] = [ … ];
```

So `colById = React.useMemo(…, [columns])` takes a new identity every render, and `filtered` depends on
`colById`. The same holds for `managed`, `trailing`, `managedIds`, `orderedManaged`, `visibleColumns`,
`renderCols` and `sumCols`.

The `useDeferredValue` split at lines 445-460 therefore does the opposite of what its comment claims. A
keystroke in a column filter runs the full filter and sort pass **twice**: once in the urgent render (with
the old `deferredFilters` but a new `colById`), once in the deferred render. The intent was zero and one.
The comment at lines 490-493 explicitly refuses to list `columns` in the dependency array to avoid exactly
this, then depends on `colById`, which is derived from `columns`.

Two more per-render costs ride along:

- the layout-persist effect (line 432) `JSON.stringify`s the whole prefs payload on every render, because
  `orderedManaged` is in its dependency array;
- the bulk-selection prune effect (line 503) rebuilds `new Set(filtered.map(getRowId))` on every render,
  because `filtered` is in its dependency array.

**Fix:** either `useMemo` the `columns` array in each page, or key DataTable's internal memos on a stable
signature such as `columns.map((c) => c.id).join("\u0000")`. The second is one change instead of forty and
cannot be forgotten by a new page.

## 17. `personName` is a linear scan used as a column accessor

`web/src/lib/utils.ts:27-36`

```ts
export function personName(people, ref, unknown = "Someone"): string {
  if (!ref) return "";
  const person = people.find((p) => idOf(p.path) === idOf(ref));
  …
}
```

Six pages wrap it as `empName` and hand it straight to DataTable as a column accessor:
`Leaves.tsx:504` and `:653`, `Overtime.tsx:210`, plus `RemoteWork.tsx:65`, `Delegations.tsx:42`,
`NoticePeriods.tsx:97`, `BackgroundChecks.tsx:99`. Those pages read `employees` with `{ all: true }`, so the
scanned array is up to `ALL_CAP` (1000) rows.

Sorting a 100-row leave table by Employee in a 500-person org is roughly 660 `compare` calls, two accessor
calls each, a 500-element scan each: about 660,000 comparisons. `distinctValues` (`DataTable.tsx:607`)
also runs the accessor over every row, once per render of each `filter: "select"` popover.

Compounds with finding 4, which makes it per keystroke rather than per data change.

**Fix:** build the lookup once, the way `RequestLeaveDialog.tsx:192-195` already does, and give
`personName` an overload that takes a prepared `Map`.

## 18. Board re-filters and re-sorts every card once per column-lane cell, twice

`web/src/pages/Boards.tsx:593-605`

```tsx
const visible = cards.filter(filter.match);                       // not memoized
const cardsIn = (colKey, laneKey) =>
  visible.filter((c) => c.column_key === colKey && …).sort(byRank);
const laneHasCards = (laneKey) => board.columns.some((col) => cardsIn(col.key, laneKey).length > 0);
const visibleLanes = … lanes.filter((l) => board.hide_empty_lanes && !laneHasCards(l.key) ? false : true);
```

`cardsIn` is a plain function that re-filters and re-sorts `visible` on every call. It is called
`columns × lanes` times while deciding `visibleLanes`, and `columns × visibleLanes` times again while
rendering. Nothing is memoized: `visible` is recomputed per render, and `BoardToolbar`'s own
`useMemo(…, [cards, filter])` (line 257) never hits either, because `filter` is a fresh object from
`useCardFilter` on every render.

A 6-column board with swimlanes by assignee across a 12-person team is ~156 filter-plus-sort passes over
every card in the board, per render - and a keystroke in the board search box is a render. `filter.match`
also lowercases the needle inside the predicate (line 236), so that is once per card per pass rather than
once.

**Fix:** memoize `visible`, and build the cells once - a single `Map<`col::lane`, CardT[]>` pass over
`visible`, which both `visibleLanes` and the render read from.

## 19. `startClippedTitles()` runs unconditionally in production

`web/src/main.tsx:33`, `web/src/lib/clippedTitle.ts:145-192`

Its sibling on the line above, `startOverflowProbe`, self-gates on `import.meta.env.DEV`
(`overflowProbe.ts:31`). This one does not.

It installs a document-wide `MutationObserver` on `childList + subtree + characterData +
attributes[class,style]`, plus a `ResizeObserver` over every element matching
`[class*="truncate"],[class*="line-clamp"],[class*="ellipsis"]` **and each of that element's direct
children** (`collect`, lines 84-93). On a 100-row table that is hundreds to thousands of observed nodes.
Each flush forces layout (`scrollWidth`/`clientWidth`, line 50) and calls `getComputedStyle` on every
cache miss, and the `axes` cache is invalidated by any `class` or `style` mutation on the element.

Giving clipped text its full string back is a real feature and the measurement approach is sound. The point
is that shipping it is a decision, and right now it is a default nobody chose.

**Fix:** decide deliberately. If it ships, note at the call site why the cost is accepted; if not, gate it
the way its sibling is gated.

---

## Tests added

Five test files, written to fail on the current tree. Each targets a finding whose root cause is *drift from
a rule the codebase already states*, so each asserts the rule rather than the symptom.

| File | Covers | Fails today with |
|---|---|---|
| `test/replayMaskDrift.test.ts` | 2 | 12 unmasked surfaces across 7 files |
| `test/employeeManagerCycle.test.ts` | 6 (write side) | 3 of 5 employee cases; the department contrast cases pass |
| `test/hierarchyWalkGuards.test.ts` | 6 (client side) | `OrgChart.tsx:208  while (p)` |
| `test/holidayAppliesDrift.test.ts` | 12 | `Dashboard.tsx:430` and `Leaves.tsx:184` |
| `test/settingsMirrorDrift.test.ts` | 13 | `ticketWorkflow.ts` (no subscription, no memo clear) |

**`replayMaskDrift`** is the one worth reading. It does not enumerate components; it parses `MEMORY_ONLY` out
of `resourceStore.ts` and `SENSITIVE_PAGES` out of `instrument.ts`, finds every component that reads each
collection, and requires a mask or a masked route. Adding to either list fails it - the property the existing
enumerating test cannot have. Exemptions are a table keyed by file, each carrying its reason, so the default
is "flagged" and an exemption is a deliberate act.

It found two surfaces the manual review missed: `Dashboard.tsx` renders each person's loan principal inline
in the "waiting on you" card (`:517`), and `Referrals.tsx` renders `candidate_name`/`candidate_email`/
`candidate_phone` (`:153-155`, `:245`).

**`holidayAppliesDrift`** also found one the review missed: `Leaves.tsx:184` builds its holiday-name map
without `applies`, so the detail note names a holiday the server did not drop - in the sentence whose whole
job is to reconcile with the server's charged figure (`:180-181`).

**`employeeManagerCycle`** keeps the passing department cases alongside the failing employee ones on purpose:
`codeCascade.ts:266-270` is what "guarded" looks like, thirty lines from the code that needs it.

### Verified, but not executed here

The assertions were verified by running their exact globs and regexes against the real tree, and
`./node_modules/.bin/tsc --noEmit` is clean (exit 0). The suite itself could not be run from this session:
`vitest` boots Miniflare from `wrangler.toml`, which opens `.dev.vars` and writes a log under
`~/Library/Preferences/.wrangler/` - both outside the sandbox, so the run dies before collection with
`EPERM ... .dev.vars`. Worth running directly:

```
npm test -- test/replayMaskDrift.test.ts test/employeeManagerCycle.test.ts \
             test/hierarchyWalkGuards.test.ts test/holidayAppliesDrift.test.ts \
             test/settingsMirrorDrift.test.ts
```

### Not covered, and why

**Finding 3** (a failed review submit deletes the draft) has no test here. The rule it breaks - "do not
discard the draft until the server has the work" - is a property of a swallowing helper and its callers
*across* functions, which a source scan can only approximate badly. It wants a component test, and this suite
is a workers-pool runner with no DOM. The cheap structural alternative is to make `Reviews.tsx#act` return a
boolean the way `Tickets.tsx#act` already does; the call sites then either check it or visibly do not, which
review can see and a scan could assert.

**Findings 9, 14** (the ACL `create` lint, `parseValue` round-trip) are pure functions and now have tests.
`covers()` stayed private - `ruleFlags` and `denyBlocking` are already exported and are what the UI actually
calls, so `test/aclCreateScopeLint.test.ts` asserts the badge rather than the helper. `parseValue` needed a
move, not an export: `ActionList.tsx` reaches `window` through its imports and neither runner here has a DOM,
so it and its two neighbours live in `web/src/components/workflows/bodyValue.ts`, pinned by
`test/workflowBodyRoundTrip.test.ts`.

## Design and risk notes, not defects

**Global side effects during render.** `App.tsx:339-351` calls `setTablePrefsUser`,
`setResourceStoreUser`, `setPhotoCacheUser` and `setSettingsUser` in the render body, and line 514 mutates
`booted.current`. Correct today because nothing suspends between them and commit. A Suspense boundary or a
`use()` call added above them would make a discarded render mutate global state, silently. If this stays,
the reason it is safe belongs in a comment at the call site.

**`{ all: true }` on `employees` from about forty pages.** Each walk is up to ten sequential `batch:run`
round-trips (`ALL_CAP` 1000, 100 rows per page) and is re-walked whenever the 60s `TTL_SEMI_MS` lapses.
Past a few hundred employees this is the dominant per-navigation request cost, against a stated
D1-read-minimisation constraint. The `useCollection` docstring argues the correctness case well; the cost
just is not bounded by org size.

**`hasCapability` is a linear `Array.includes`.** `lib/perm.ts:6-17`, reached through `usePermission` on
nearly every render of nearly every gated control. A `Set` built once in `CapabilitiesContext` makes it
O(1).

**`awayByDay` walks day by day over every department request.** `RequestLeaveDialog.tsx:389-395`. Bounded
only by the server's own date validation; a single row with a far-future `end_date` hangs the dialog.

**Board card ranks are never renormalised.** `Boards.tsx:204-208` inserts at the midpoint of its two
neighbours (`(lo + hi) / 2`, from `RANK_STEP` 1024) and `src/services/cards.ts:709` stores whatever the
client sends. Repeated insertion into the same gap halves it each time, so after ~60 drops at one spot the
midpoint equals its neighbour in double precision, `byRank` falls through to its `path` tiebreaker, and the
card lands somewhere arbitrary. Unlikely in a year; unbounded over the life of a board, and there is no
rebalance path anywhere.

**`cardsIn` computes an append rank over the FILTERED cards.** `Boards.tsx:632-633` and `:667-668`. With a
board filter active, a card dropped at the end of a column gets `max(visible ranks) + STEP`, which can sit
below a hidden card's rank - so clearing the filter shows it mid-column rather than last.

**`countable` omits `empById` from its deps.** `Goals.tsx:291-294`, under an `eslint-disable`. Its
predicate resolves owner names through `empName`. Only the chip COUNTS read it (the grids call
`matchesQuery` directly), and a query typed before the directory lands leaves the counts one keystroke
behind. Narrow, but the disable comment does not say which dependency was deliberately dropped or why.

**`RebalanceDialog` validates rows the reader cannot edit.** `Goals.tsx:1355`: `invalid` is computed over
all `goals`, while only `editable` rows have inputs. A locked goal already stored at weight 150 makes Save
permanently unavailable, with `whyNot` pointing at a control that is not on screen.

**The ATS save's dedupe comment overclaims.** `Settings.tsx:1032-1042` says "A collision can only come from
a key derived here (an existing one is already distinct), so suffixing is safe for live applications". The
loop suffixes whichever duplicate it meets SECOND, which is a position, not a provenance - so a derived key
that collides with an existing one while sitting EARLIER in the array would rename the existing stage and
orphan its applications. Unreachable from this panel today, because `addStage` always mints a key and the
`stageSlug` fallback only fires for a keyless stage; reachable from stored data written another way. The
code is fine; the sentence justifying it is not, and that is what the next person will trust.

**`ReimbursementsPanel` has no load gate.** `Settings.tsx:1416-1443` auto-saves on click and has no `ready`
flag, so a click landing before `getSetting` resolves is overwritten on screen by the stored value a moment
later - the server has the new mode, the toggle shows the old one until reload. Sub-second window, display
only.

**`monthOptions` still reads the UTC clock.** `PayrollRuns.tsx:274-281` builds the quick-run month window
from `new Date().getUTCMonth()`, while `defaultMonth()` twenty lines above was deliberately moved onto the
org clock for exactly this reason, and `orgMonthIdx()` (`:90`) exists but is used only by a caption at
`:634`. For a few hours around a month boundary the window's edges are a month out - "next month" is not
offerable on those mornings for an IST org. The defaulted value stays inside the list in every case I
worked through, so it is drift rather than a broken control.

**`pollOperation` cannot be cancelled.** `PayrollRuns.tsx:348-367` polls for up to 45s with no unmount flag,
so navigating away leaves the timer holding its closure, fires `reload()` against a page nobody is on, and
lands "Payroll published" or "Still processing" on whatever page the reader moved to. It also
`catch {}`es every error and keeps polling, so a 403 on the Operation read burns the full 45s before saying
"Still processing".

**`parseScanPayload` does not check the origin it matched.** `lib/assetTags.ts:320-331` tests the deep-link
and `/found/` patterns *before* the `if (/^https?:\/\//i.test(t)) return null; // some other URL - not one of
ours` guard, and neither pattern is anchored to the app's origin - `buildScanPayload` takes an `origin`
argument, the parser takes none. So `https://anywhere.example/#/assets/<id>?s=<secret>` is accepted as ours.
The secret still has to be valid for that asset server-side, so this is a mis-attribution risk (a sticker
that makes a scan record a *different* asset) rather than a way in, and it needs physical access to two
stickers. Anchoring the match to `location.origin` closes it.

**`sortSlabs` has an inconsistent comparator for two open-ended bands.** `Settings.tsx:709-710` returns `1`
whenever `a.up_to == null`, including when `b.up_to` is also null, where a comparator must return 0. Only
reachable from stored data with two null bands, which nothing else can produce.

---

## What came back clean

Checked and found correct:

- XSS: `richText.tsx:179` gates every href through `safeHref`; no `dangerouslySetInnerHTML` anywhere.
- CSV formula injection: `exportTable.ts:43-45` defuses `= + - @ \t \r` leads and leaves plain numbers alone.
- Tabnabbing: both `target="_blank"` sites carry `rel="noopener"`.
- `JSON.parse`: all 27 call sites guarded.
- `localStorage`: every accessor wrapped, including the writes (the accessor itself throws with site data blocked).
- Object URLs: all six `blobUrl` callers revoke, on replacement and on unmount.
- `img` alt text, numeric `&&` in JSX, division by zero, in-place sorts of store-owned arrays, listener cleanup.
- Date handling: `orgDay.ts` is used consistently. The `toISOString().slice(0, 10)` hits are all UTC calendar
  arithmetic on date-only strings, which is the correct form. A sweep for local-clock calendar boundaries
  (`new Date().getFullYear()`/`getMonth()`/`getDate()`) across the whole frontend returns exactly two live
  hits: finding 8, and `Notifications.tsx:35`, where the viewer's day is the right answer for a personal feed
  and is internally consistent with its own `toLocaleTimeString` labels.
- Role-as-permission: a sweep for `me.role === "super_admin"` returns finding 7 and one badge-variant helper
  (`RolesPanel.tsx:26`), which gates nothing.
- Linear lookups in table accessors: `Expenses.tsx:272-280` is the correct shape (a `Map` built once in a
  `useMemo`, reused by four accessors). `lib/utils.ts#personName` is the outlier - see finding 11.
- Client/server mirror drift: `leaveDays`, `attendance` and `expenses` import the server domain directly.
  `periodKeyOf` (`Expenses.tsx:85`) is a hand copy but matches `src/domain/expenses.ts:12` exactly.

## Coverage

Read in full: `api.ts`, `lib/getCoalescer.ts`, `lib/resourceStore.ts`, `lib/clientStore.ts`,
`lib/settingsStore.ts`, `hooks/useCollection.ts`, `useMe.ts`, `App.tsx`, `router.ts`,
`components/common/DataTable.tsx`, `lib/approvals.tsx`, `lib/notifications.tsx`, `lib/attendance.ts`,
`lib/orgDay.ts`, `lib/utils.ts`, `lib/perm.ts`, `lib/crossTabBus.ts`, `lib/viewAsStore.ts`,
`lib/dialogHistory.ts`, `lib/urlQuery.ts`, `lib/exportTable.ts`, `lib/clippedTitle.ts`,
`lib/tablePrefs.ts`, `components/ui/dialog.tsx`, `components/ui/combobox.tsx`,
`components/common/ErrorBoundary.tsx`, `components/common/RequestLeaveDialog.tsx`, and substantial parts of
`pages/Attendance.tsx` and `pages/Expenses.tsx`.

Also read: `components/leave/RestrictionsEditor.tsx` (1454 lines, clean - the three-state
inherit/custom/exempt grammar, the positional notice ladder and the per-leaf validation mirror all hold up),
`pages/Goals.tsx` (2445, quarter arithmetic verified against `orgDay`; finding 1 and two notes),
`pages/Boards.tsx` (2768, drag-and-drop ranking and swimlane routing; finding 7 and two notes), and the
shell plus payroll-policy, notifications and PT-slab panels of `pages/Settings.tsx` (3848).

Also read: `pages/PayrollRuns.tsx` (1034, run lifecycle, review breakdown, bank and statutory files;
finding 6 and two notes), `components/access/ruleLogic.ts` in full plus the ACL modal's authoring path
(finding 5), and `pages/ExpenseBudgets.tsx`'s rollup, year matrix and attention band (clean - the matrix
walks its own cursor at `:271-274` and every percentage is zero-guarded).

Also read: `lib/pdfSignature.ts` and `components/common/SignedPdfViewer.tsx` in full (finding 1; the rest of
the module is careful - signer-certificate resolution from `SignerInfo` rather than the bag's first entry,
chain validation as of signing time, and the offline caveats printed on the stamp are all right).

Also read and clean: `pages/Documents.tsx`'s signed-copy grouping and acknowledgement roster (the ack dialog
follows its cursor to `ACK_ROW_CAP`, reports `truncated`, and takes the roster from an `all: true` employees
read; `TruncationNotice` at `:809` covers both document collections), and `pages/ReviewCycles.tsx`'s
variable-pay panel (the server recomputes on award, blocked lines say why, and `already_awarded` makes a
retry after a partial failure idempotent).

Also read: `pages/Expenses.tsx`'s buckets, duplicate check, budget interlock and spend charts (finding 8;
the rest is right - `nameOf` is the `Map`-once shape, the recurrence step imports the server's own
`advanceRecurrence`, and `periodKeyOf` matches `src/domain/expenses.ts:12` exactly);
`pages/Announcements.tsx`'s optimistic machinery (`applyReaction` toggles correctly and `fold` writes to all
three sources - board entry, search entry and `soloRows` - which is what the "invalidate nothing" mapping in
`resourceStore` depends on); `pages/Pipeline.tsx`'s stage transitions (`:advance` sends no `If-Match`, but
`advanceApplication` in `src/services/ats.ts:412` accepts none either, so that is a server-side choice rather
than a client omission); and `components/common/TeamTimeline.tsx`'s weight arithmetic (`dayWeight` entries
are positive constants over a fixed-length `cols`, so `totalWeight` cannot be zero).

Also read: `pages/Reviews.tsx` (finding 2; `prevRatingFor` correctly refuses to answer on a truncated
history, and the cycle goals ride the review rather than being re-derived), `lib/ticketWorkflow.ts`
(finding 10; the `usable()` shape guard and the custom-state label fallback are both right), and
`components/common/PostComposer.tsx`'s save path, which is the reference for finding 2.

Also read: `pages/Dashboard.tsx` (finding 10; the inline approval path sends etags, relies correctly on
`invoke`'s own invalidation rather than reloading eight queues, and `oldestPendingDays` reads the right end
of an ascending sort) and `pages/Tickets.tsx` (clean - `act` returns its outcome and callers gate on it,
`moveTo`'s undo checks `can` for the reverse verb, and a 409 reloads the row in place with the message the
next attempt needs).

That closes the last of the large files. Every page and component over 1000 lines has now been read.

Below that tier, read so far: `components/common/ApiKeysPanel.tsx` (finding 2; the lifecycle work around it
is sound - `rotate` mints before it revokes and catches the revoke separately so a failed revoke cannot
strand an uncopyable secret, and `closeMinted` confirms before discarding), `components/common/EmployeeCompensation.tsx`
(clean - it imports `splitCtc`, `componentMonthly` and `pfWagesOf` from `src/domain/payroll` rather than
mirroring them, and the breakdown reads the stored `base_pay`/`special_allowance` rather than re-deriving
them), and `hooks/useSplitStaleness.ts` (clean - the staleness verdict is a server dry-run, not a client
recomputation, so a stale local `ctc` config cannot make the banner lie), and `pages/OrgChart.tsx` plus the
two manager pickers in `pages/Directory.tsx` and `pages/EmployeeProfile.tsx` (finding 6; the drag path's own
cycle guard and its two ancestor walks at `:342`/`:363` are correct - it is the third walk and the other two
write paths that are not), `components/workflows/ActionList.tsx` and `WorkflowBuilder.tsx` (finding 14; the
JSON hatch commits on every keystroke and holds the error rather than silently keeping a stale draft, which
is right), `pages/TableBuilder.tsx` (clean - `runFilled` pages until it has a screenful with two independent
bounds, and keeps the last page's envelope so `next_page_token` stays honest), and `lib/scanner.ts` plus
`lib/assetTags.ts` (camera and barcode mechanics; one hardening note below on origin checking).

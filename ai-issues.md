# AI code review - pre-production

Scope: every file that touches the AI layer. Ordered by severity within each pass.

State at time of writing: `tsc --noEmit` clean; `test/aiPolicy aiService moderation tableAssist aiDraft grants` = 179 pass;
`openapiRoutes customMethods moderatable scopedVerb seed settingsMirror mountOrder` drift = 32 pass. The findings
below are not caught by any of those.

43 findings: 8 HIGH, 16 MEDIUM, 10 LOW, 4 NIT, and 5 about coverage or documentation accuracy.

---

## Index

### The eight that matter

| # | | |
|---|---|---|
| **S1** | the gate is defeated by pressing Publish twice | a flagged post reaches the wall with two clicks |
| **S40** | any employee can spend the whole day's AI allocation in seconds | posting is unmetered and unattributed; the wall then stops accepting posts |
| **S36** | turning on semantic search can stop the noticeboard working | the backfill and the gate share one budget, first come first served |
| **S42** | `attention.summary` is a generation per dashboard load | the file computes the reason this cannot fit, then ships it |
| **S35** | "Release" during a model outage loses the post | history says released, post is invisible, nothing can recover it |
| **S34** | `held_at` has no reconciliation | three more routes to a permanently invisible post (S31 is one of them) |
| **S31** | the drain retires a held post's flag | held row + `superseded` flag = on no queue, visible to nobody |
| **S19** | a hard purge leaves the AI suggestion behind | the CV extraction's PII survives the erasure operation |

Four of the eight (S34, S35, S36, S40) end in the same place: **a post nobody can see and nobody can release.**
Three of them (S36, S40, S42) reach it through the shared daily budget, which is the single most load-bearing
and least defended number in the layer.

### Order of work

1. **S35** first - `releasePost` must stop re-entering the gate. See pass 14: this has to land *before* S1,
   because the obvious S1 fix would otherwise make held posts impossible to release.
2. **S1** - the gate refuses an `"unchanged"` outcome whose candidate is already flagged.
3. **S34's sweeper** - held hosts with no pending flag get re-queued. Catches whatever S31, the gate's catch
   block and the reply/parent case still strand.
4. **S40 + S36 + S42** - budget. An HTTP budget on the moderated write paths, a reservation for interactive
   work, and `attention.summary` off the load path. These are one piece of work.
5. **S13** - the settings copy, because it is the consent record and it is wrong today regardless.
6. **S19 / S21** - purge and retention.
7. **S3, S14, S23, S25, S27** - features quietly not working, or writing to the wrong column.
8. Everything else.

### All findings

| | Pass | Severity | Finding |
|---|---|---|---|
| S1 | 1 | HIGH | DONE - the moderation gate is defeated by pressing Publish twice |
| S2 | 1 | MEDIUM | DONE - `scanSoon` never does anything, at any call site |
| S3 | 1 | MEDIUM | DONE - re-extracting a receipt silently fails to record |
| S4 | 1 | MEDIUM | DONE - two generation sites fence untrusted text with no preamble |
| S5 | 1 | LOW | DONE - `assertMayReachModel` is opt-in per call site |
| S6 | 1 | LOW | DONE - a cache hit skips the rate limit entirely |
| S7 | 1 | LOW | DONE - the audit blames the wrong model |
| S8 | 1 | LOW | DONE - `budgets.narrate` missing from the client feature list (see S14) |
| S9 | 1 | LOW | DONE - cache sweep cannot keep up |
| S10 | 1 | NIT | DONE - `outputChars` is an array length, not characters |
| S11 | 1 | NIT | DONE - settings can brick or disable the budget |
| S12 | 1 | NIT | DONE - decided history loses a reply whose parent was later disabled |
| S13 | 2 | MEDIUM | DONE - the settings copy describes the pre-gate behaviour |
| S14 | 2 | MEDIUM | DONE - `budgets.narrate` is unreachable - no switch, no client key |
| S15 | 2 | LOW | DONE - the unhide toast contradicts what unhide does to an announcement |
| S16 | 2 | LOW | DONE - `DraftButton` does not bound what it sends |
| S17 | 3 | coverage | DONE - the tests that look like they cover S1 and S2 cover neither |
| S18 | 3 | NIT | DONE - duplicate pairs render a stale title and column |
| S19 | 4 | HIGH | DONE - a hard purge leaves the AI suggestion behind, with the extracted PII in it |
| S20 | 4 | MEDIUM | DONE - switching semantic search off freezes the vector cleanup |
| S21 | 4 | MEDIUM | DONE - `ai_usage` grows for the life of the deployment, no retention |
| S22 | 5 | MEDIUM | DONE - the scheduled-publish loop makes unbounded generation calls on a cron tick |
| S23 | 5 | LOW | DONE - `cardDuplicateSensitivity` cannot be set by anybody |
| S24 | 5 | coverage | DONE - the drift gate that would have caught S4 does not exist |
| S25 | 6 | MEDIUM | DONE - the deploy runbook is two features behind, and miscounts the ones it has |
| S26 | 6 | docs | DONE - "the model never hides" is not absolute; it is super-admin-bounded |
| S27 | 7 | MEDIUM | DONE - accepting two CV fields destroys the first, and any notes already there |
| S28 | 7 | LOW | DONE - a manual hide leaves `held_at` set |
| S29 | 8 | MEDIUM | DONE - the two extraction features write PII nothing reads, decides or deletes |
| S30 | 8 | LOW | DONE - `ai_usage.error` can carry prompt text back into the database |
| S31 | 9 | HIGH | DONE - a held suggestion or reply can be lost permanently |
| S32 | 9 | MEDIUM | DONE - three reads over held tables omit the filter, so held content is visible |
| S33 | 9 | coverage | DONE - the guard named in the source does not exist |
| S34 | 10 | HIGH | DONE - no reconciliation for `held_at`; three ways to a permanently invisible post |
| S35 | 11 | HIGH | DONE - "Release" during a model outage leaves the post invisible |
| S36 | 12 | HIGH | DONE - turning on semantic search can stop the noticeboard working |
| S37 | 12 | MEDIUM | DONE - turning on the conduct pass re-queues every post a moderator has dismissed |
| S38 | 13 | MEDIUM | DONE - the budget check reads every `ai_usage` row written today, before every inference |
| S39 | 14 | coverage | DONE - the gate has no e2e coverage, and its unit tests stop just short of every finding |
| S40 | 15 | HIGH | DONE - any employee can exhaust the org's daily AI allocation in seconds |
| S41 | 15 | MEDIUM | DONE - `ai_usage` cannot answer its own question for the gate's calls |
| S42 | 16 | HIGH | DONE - `attention.summary` is a generation per person per dashboard load |
| S43 | 17 | MEDIUM | DONE - editing a held announcement never re-examines it - the mirror image of S1 |

### What is good, and worth not breaking

The policy layer is the best-argued part of this codebase. `domain/aiPolicy.ts` states its threat model, derives
the denylist from the audit policy rather than hand-listing it, refuses provider routes by shape as well as by
membership, and argues each `CONSENTED_PATHS` exception in prose with the lawful basis attached.
`test/transportParity.test.ts` holds the two transports against each other through fakes of their own backends
and compares values across differing spellings - it is the gate that catches local/production drift, and it is
genuinely thorough. Every vector consumer re-decides scope in SQL rather than trusting the index. The narrators
cannot invent a number. `lib/aiLocal.ts` closes the egress question in code rather than in configuration.

Nothing in this review is an argument against the design. Every HIGH finding is a state one function produces
and another consumes, in the newest part of the layer - the gate - which is also the only part with no
cross-function tests and no e2e.

---

## Pass 1 - transport, policy, moderation, extraction, narration

### S1 - DONE - HIGH: the moderation gate is defeated by pressing Publish twice

`src/services/moderation.ts:231-244` short-circuits on an unchanged text hash and returns `"unchanged"`.
`moderationGate` (`:197`) treats `"unchanged"` exactly like `"clean"`: clears the hold, returns `true`. But
"unchanged" means *the text matches the last scan*, and the last scan may have been a **flag**. The candidate
already carries `flagged`; the gate ignores it.

Two paths, neither needing any privilege beyond posting:

**Announcement.** `setPublished` (`lifecycle.ts:96-99`) -> gate -> flagged -> held, `published` stays false.
Press Publish again: `setHeld`, gate, hash + `scanIdentity` both match -> `"unchanged"` -> `setHeldAt(null)` ->
`true` -> row flips published, audit, company-wide bell, email, mentions. The flag stays `pending`
(`reopenFlag` only touches `superseded`).

**Suggestion.** `updateSuggestion` (`suggestions.ts:185-192`): PATCH a held suggestion's `category` only, title
and body unchanged -> gate -> `"unchanged"` -> hold cleared -> live on the wall, flag still pending.

Replies are safe (no update verb). `:publish` carries no `assertMayUnhide` guard - that sits only on `:enable`
and `:restore` (`routes/announcements.ts:247`, `suggestions.ts:306`).

Falsifies `unhideModeration`'s own doc ("publishing... goes through the gate, which re-reads the text") and the
commit headline "nothing reaches a public wall unread".

Fix: the gate must not accept a prior objection as a pass.

```ts
// scanCandidate, unchanged branch
if (c.flagged) return "flagged";   // same text, same passes, same objection
return "unchanged";
```

or hold in `moderationGate` when `outcome === "unchanged" && candidate.flagged`. The drain still wants the cheap
`"unchanged"`, so the gate-side check is the cleaner cut. Needs a test: publish -> held -> publish again -> still
held.

### S2 - DONE - MEDIUM: `scanSoon` never does anything, at any call site

Every call is `if (!gated) await scanSoon(...)`, and `gated` is `moderationGateOn` =
`deps.ai && aiFeatureOn("moderation")`. `scanOnWrite:120-121` bails on exactly that condition, so `!gated`
implies `scanOnWrite` returns immediately.

Sites: `announcements.ts:283,514,676`, `suggestions.ts:168,195`, `lifecycle.ts:143`. The announcement-draft case
(`gated = published && ...`) does reach `scanOnWrite`, and then the candidate query filters the draft out -
correct, but still no scan.

Not exploitable (the gate covers the on-case, the cron drain covers the rest), but about 90 lines of
load-bearing-looking documentation describe a path that cannot run, and it is a trap for anyone who later splits
"gate" from "moderation" into two switches. Either delete the branch or make the switches distinct.

### S3 - DONE - MEDIUM: re-extracting a receipt silently fails to record

`receiptExtract.ts:201-208` is a bare `insert`, while `ai_suggestions_host_idx` is unique on
`(host_collection, host_record_id, feature)` (`schema.ts:1854`). The panel has a "Read again" button
(`ReceiptExtractPanel.tsx:133`). Second read -> UNIQUE violation -> swallowed by the catch. The stale first
suggestion stays on the row for ever and the accept-rate measurement is wrong.

`resumeExtract.ts:216` and `ticketTriage.ts:192` both use `onConflictDoUpdate`. Same fix here.

### S4 - DONE - MEDIUM: two generation sites fence untrusted text with no preamble

Fixed: `MEASURE_SYSTEM` (`domain/goalMeasure.ts`) and the `attention.summary` system prompt both end with
`UNTRUSTED_PREAMBLE`, and both fenced halves now go through `scrubIdentifiers`. `test/promptFencing.test.ts`
(S24) is what holds it: a fenced prompt with no preamble, or no scrub, fails the scan.

`fence()` is meaningless without `UNTRUSTED_PREAMBLE` - precisely the bug `moderation.ts:258-267` documents from
the other direction. Two callers fence and omit it:

- `attention.ts:110-116` - goal and card titles, employee-authored, `fence("what is off track", ...)`, system
  prompt has no preamble and no `scrubIdentifiers`.
- `goalMeasure.ts:61-62` - `fence("the goal", text)` with `MEASURE_SYSTEM` (`domain/goalMeasure.ts:61`), no
  preamble, no scrub.

Defence in depth only (both outputs are parsed and clamped), but it is the one invariant `aiPolicy.ts` states as
universal. Consider making `fence()` unusable without it: a `systemWith(instruction)` helper, or an assert in
`aiGenerate` that a `user` containing `FENCE_OPEN` carries the preamble somewhere in the prompt.

### S5 - DONE - LOW: `assertMayReachModel` is opt-in per call site

Fixed as suggested: `AiCallContext.reads` is REQUIRED - `"none"`, one `{ collection, subresource? }`, or a
list of them for a batch spanning the index. The four deliberate omissions now say `"none"` out loud with
their argument beside them, and a new call site cannot forget to answer the question because it will not
compile. `searchEmbed` declares every collection in its batch, so the denylist is asked about each rather
than about nothing.

`services/ai.ts:91,120,154` - `if (ctx.collection) assertMayReachModel(...)`. The denylist fires only when a
caller volunteers `collection`. Four sites deliberately omit it with good arguments (`tableAssist:118-129`,
`draftText:67`, `attention:85`, both narrators), so a deliberate omission is indistinguishable from a forgotten
one. A required `reads: "none" | { collection, subresource? }` on `AiCallContext` would make the omission a
positive declaration.

### S6 - DONE - LOW: a cache hit skips the rate limit entirely

`services/ai.ts:130-136` returns before `withinUserRate`. Documented intent is "do not ration answers we already
had", but the hit path still does two D1 writes (hit counter + usage row) with no ceiling at all. Someone
hammering Draft with one instruction gets unbounded writes. A separate, looser cached-hit ceiling closes it.

### S7 - DONE - LOW: the audit blames the wrong model

`moderation.ts:1537` - `flagged_by: MODELS.moderate`, always. The conduct pass writes `model: MODELS.generate`
on the flag (`:319`), and the event already gets `pass` right (`:674`). Read `flag.model` instead.

### S8 - DONE - LOW: `budgets.narrate` missing from the client feature list

`web/src/lib/aiFeatures.ts` `AiFeatureKey` has 15 of the server's 16 `AI_FEATURES` - `budgets.narrate` is
absent, so the ExpenseBudgets affordance cannot be gated by `useAiFeature` and can only be hidden outright or
render an always-failing button. `settingsMirrorDrift` does not catch it.

### S9 - DONE - LOW: cache sweep cannot keep up

`sweepAiCache` (`ai.ts:331-340`) deletes at most 500 rows per nightly tick. At 20 generations per user per hour a
modest org exceeds that, and the table grows for the life of the deployment holding generated text about real
records - which is the stated reason the sweep exists. Loop to a budget rather than one batch.

### S10 - DONE - NIT: `outputChars` is an array length, not characters

`ai.ts:104` and `:163` - `outputChars: vectors.length` / `ranked.length`. The ledger's cost picture is wrong for
two of the three roles, on the table that is meant to replace the neuron estimates with measurements.

### S11 - DONE - NIT: settings can brick or disable the budget

`routes/settings.ts:617-619` - `perUserHourlyGenerations: 0` passes validation and refuses every generation
(`used >= 0`). Suggest `min: 1`. Separately, an `ai` blob written outside the route as a non-object makes
`Math.min(undefined, 7000)` NaN at `ai.ts:184`, and `spent + cost > NaN` is false - the daily budget stops
existing. Worth clamping in `aiConfig` rather than trusting the route.

### S12 - DONE - NIT: decided history loses a reply whose parent was later disabled

`moderation.ts:1242` - `if (!parentVisible || !keep(...)) continue`. On the decided history (`anyVisibility`) a
reply whose parent has since been disabled drops out entirely, which is the one view added so that a takedown
stays findable.

### Accepted as-is

`MAX_SCAN_CHARS = 2000` (abuse past the cut passes clean) and inference region on the free tier are both argued
explicitly in the source. No disagreement - except that S1 makes the first moot, since the cheap bypass is
easier than padding a post.

---

## Pass 2 - retrieval, settings UI, client, transports

### S13 - DONE - MEDIUM: the settings copy describes the pre-gate behaviour, so the org consents to the wrong thing

`web/src/components/common/AiSettingsTab.tsx:125` (and `:131` for the conduct twin) tells the admin turning
moderation on:

> "read by a safety model shortly after they are posted ... **Nothing is hidden automatically: a flagged post
> stays exactly as visible as it was until somebody decides.**"

That is the behaviour before the gate landed. Today the same switch means a post is withheld and never reaches a
wall until a model clears it, and `moderationGate` **fails closed** (`moderation.ts:176-183`) - so during a model
outage or a spent neuron budget, posting silently stops working and the recovery is a human draining the queue.
The one screen where an organisation agrees to this describes materially different behaviour, and the failure
mode that lands on authors is not mentioned at all.

Rewrite both `on:` strings. The `off:` copy is still accurate.

### S14 - DONE - MEDIUM: `budgets.narrate` is unreachable - no switch, no client key

Three places disagree:

- `domain/aiPolicy.ts:405` declares it and `:423` defaults it off.
- `AiSettingsTab.tsx` has a card for all fifteen other features and **none** for this one.
- `web/src/lib/aiFeatures.ts` `AiFeatureKey` omits it (15 of 16).

So `narrateBudgets` (`budgetNarrate.ts:114`) always takes the `plain` branch unless somebody PATCHes the `ai`
setting by hand. The feature is written, routed (`routes/expenseBudgets.ts:54`), tested and dead.

This supersedes the earlier S8, which read as a typing nit; the type list is the smaller half of it. Worth a
drift test asserting `AI_FEATURES` equals the `AiSettingsTab` card list equals `AiFeatureKey` - the existing
`settingsMirrorDrift` does not cover any of the three.

### S15 - DONE - LOW: the unhide toast contradicts what unhide does to an announcement

Fixed: the toast branches on the host. An announcement says "Returned to its author as a draft ... publishing
it is what asks the question again"; a reply or a suggestion keeps "Put back on the wall ... waiting on a
decision again", which is true for them. The confirm dialog said the same wrong thing and now names both
outcomes.

`web/src/pages/Moderation.tsx` unhide handler: `toast(... "It is waiting on a decision again.")` and the comment
above it says the row "reappears on the queue".

True for a reply and a suggestion. **False for an announcement**, which is the common case:
`unhideModeration` calls `supersedeFlag` for announcements (`moderation.ts:1419`) precisely because the post
comes back as a draft with nothing outstanding. A `superseded` flag appears in neither view of the queue, so the
moderator is sent to look for it somewhere it cannot be. Say "returned to its author as a draft" for that host.

### S16 - DONE - LOW: `DraftButton` does not bound what it sends

Fixed: `MAX_DRAFT_INPUT` is mirrored in `web/src/lib/aiFeatures.ts` and bound in the dialog. The instruction
box stops at the cap; existing text past it is NOT truncated and sent - a truncated "improve" would rewrite a
different post to the one on screen - so the dialog says how long the text is against what drafting reads and
the button is disabled with that sentence beside it. `test/draftInputCap.test.ts` holds the two copies of the
number together.

`web/src/components/common/DraftButton.tsx:96-99` posts `instruction` and `existing` unclamped. The server caps
both at `MAX_DRAFT_INPUT` (4000) and answers 400. Improving a long announcement - the exact case the "Improve"
label invites - fails with a message about character counts after the round trip. The textarea has no
`maxLength` and the existing text is never truncated client-side.

### Retrieval paths - no findings

Checked and clean: `globalSearch.ts semanticHits` (ids from Vectorize, rows re-read under the identical
`or(...branches)` the FTS half uses, `docs.restricted` already folded into those branches for a caller without
`seeRestricted`), `ticketTriage`, `cardTriage`, `goalSimilar`, `suggestionSimilar` (all re-decide scope in SQL
via `applyScope`, drop unparseable and foreign vector ids, fail closed on an absent scope because
`applyScope` returns `1 = 0`), `lib/vector.ts` (collection filter documented as a pre-filter, not a permission),
`lib/vectorLocal.ts`, `lib/aiLocal.ts` (`assertLoopback` at construction), `scripts/preflight.ts` (refuses a
deploy that sets `AI_LOCAL_URL`), `e2e/e2e.vars` (redirects the whole AI layer at loopback, so the browser suite
has no path to Workers AI).

`aiEmbed` does not `scrubIdentifiers` the search query (`globalSearch.ts:183`). Deliberate and correct -
`aiPolicy.ts` scopes the scrub to generation prompts, and an embed is neither cached nor retained.

---

## Pass 3 - sweeps, board narration, scope registry, test coverage

### S17 - DONE - the tests that look like they cover S1 and S2 cover neither

Fixed both halves. The S2 half went away with S2: `scanSoon`/`scanOnWrite` were deleted, so there is no longer
a path for those tests to miss. The S1 half is a new test - the draft is published, held, and published again,
and the post is still held with its flag `pending` and nobody told. It sits in the new
`describe("state one function writes and another reads")` block in `test/moderation.test.ts`, with the three
other cross-function cases S39 asked for.

`test/moderation.test.ts:513` - `describe("a post is read when it is written, not when the sweep reaches it")`.
Every test in that block runs with `moderation` switched ON, so `gated` is true and the assertions are satisfied
by `moderationGate`. **`scanOnWrite` is never reached in any of them**, which is S2 restated from the test side:
the immediate path has four tests and no execution.

Worse, `:544` - "does not read a draft, and reads it the moment it is published" - ends exactly here:

```ts
const held = await postRow(draft.uuid);
expect(held?.published).toBe(false);
expect(held?.heldAt).not.toBeNull();
```

The next thing a real author does is press Publish again, and that is S1. The test stops one call short of the
bug it is closest to. Whatever the fix, the regression test is one more `setPublished` on the end of this test.

### S18 - DONE - NIT: duplicate pairs render a stale title and column

`cardDuplicateSweep.ts boardDuplicates` re-reads both halves of every pair under `applyScope` (correct), but
renders `d.title` and `d.column` out of the payload the nightly sweep stored rather than off the row it just
confirmed. A card renamed or moved since the sweep shows last night's title in last night's column. The host
card's title IS read live (`schema.cards.title` in the join), so one half of each pair is current and the other
is not.

### Clean, checked, no findings

- **Scope registry.** `SCOPE_READING_VERBS` (`middleware/authz.ts:285`) covers every AI verb that answers with
  rows other than the one in the path, including the two that deliberately bind a DIFFERENT collection's scope
  (`boards:duplicates` -> `cards`, `cards:suggestGoal` -> `goals`). `scopedVerbDrift` holds it both ways.
- **`boards:narrate`** reads the board's cards unscoped, which at first looks like a gap - but `boards:metrics`
  beside it does the same, the output is four aggregates with no title or person in it, and `cards:flow` (which
  does name an individual card's position) IS scoped. Consistent with the existing design, not a new hole.
- **`cardDuplicateSweep`** sweeps unscoped because it is a cron with no caller, and confines pairs to one board;
  the reader's scope is bound at `boardDuplicates`. Documented and correct.
- **`weeklyAttentionDigest`** uses no model at all (the arithmetic reason is in the header) and selects by owner,
  so there is no scope question.
- **`analyticsNarrate` / `budgetNarrate` / `boardNarrate`** all share the same shape: arithmetic finds the
  movements, the model only writes them up, `groundedIn` discards any answer containing a figure that was not in
  the findings, `plainSummary` is the fallback. No model sees a row.
- **`aiSuggestions` writers.** `ticketTriage`, `resumeExtract`, `cardDuplicateSweep`, `recordFlag` and
  `hideManually` all upsert against `ai_suggestions_host_idx`. `receiptExtract` is the only one that does not -
  see S3.

### Tests / typecheck at the end of pass 3

`tsc --noEmit` exit 0. `aiPolicy aiService moderation tableAssist aiDraft grants` 179 pass.
`openapiRoutes customMethods moderatable scopedVerb seed settingsMirror mountOrder` 32 pass. vitest needs a
sandbox bypass to run at all (`listen EPERM`), which is the known local constraint, not a finding.

---

## Suggested order of work

1. **S1** - the gate hole. Everything else can ship without it; this one is the feature not doing what its
   switch says.
2. **S13** - the settings copy, because it is the consent record and it is wrong today whether or not S1 is
   fixed.
3. **S3, S14** - two features quietly not working (receipt re-read, budget narration).
4. **S2, S4** - dead path and the two unfenced prompts.
5. Everything else at leisure.

---

## Pass 4 - retention, purge, erasure

Five tables carry AI state: `ai_usage`, `ai_cache`, `ai_suggestions`, `search_vectors`, `moderation_scans`.
Only two of the five are reachable by anything that deletes: `ai_cache` (the nightly `sweepAiCache`) and
`search_vectors` (`removeOrphans`, with the caveat in S20). Nothing anywhere else in `src/` so much as
references the other three - grep for the five table objects returns eight files, all of them writers.

### S19 - DONE - HIGH: a hard purge leaves the AI suggestion behind, with the extracted PII in it

`purgeRow` (`services/softDelete.ts:157`) already sweeps two FK-less pointer tables generically, and the comment
explaining why is the whole finding:

> `attachments` is keyed `(collection, object_id)` with `object_id` a bare `text().notNull()` and no
> `.references()` ... so SQLite never refuses a purge over an attachment, the DELETE succeeds, and
> `test/purgeCascadeDrift` (which holds each declaration against the schema's own foreign keys) cannot see the
> pointer either ... a hard purge is the operation reached for to honour an erasure request, which made it the
> one operation that left the document behind.

`ai_suggestions` is keyed `(host_collection, host_record_id)`, both bare `text().notNull()`, no `.references()`
(`schema.ts:1838-1841`). `moderation_scans` is keyed `(collection, record_id)` the same way (`:1906-1909`).
Neither is swept in `purgeRow`, and `purgeCascadeDrift` enumerates `cfg.foreignKeys` (`:56`), so it cannot see
either pointer. Same bug, same function, two tables further on.

What survives `DELETE /v1/<collection>/<id>?force`, in `payload_json`:

| feature | what the orphan holds |
|---|---|
| `ats.resumeExtract` | the candidate's name, email, phone, current employer, job title, years of experience and summary, transcribed from their CV |
| `moderation` | a 400-character **excerpt of the post itself**, plus hazard codes and the anonymity flag |
| `expenses.receiptExtract` | vendor name, invoice number, amounts, date |
| `tickets.triage` / `cards.duplicates` | the subjects and titles of neighbouring tickets and cards |

`candidates` is named in that same comment as one of the seven attachment-bearing collections whose purge was
fixed. It is also the collection behind `CONSENTED_PATHS["ats.resumeExtraction"]`, whose stated basis is that
the candidate submitted the document *for this purpose* - a basis that does not survive the record being erased
while the extraction stays.

Ids are uuids and never recycled, so the orphan is inert and invisible: nothing errors, nothing renders, the
row simply stays. Fix generically in `purgeRow` beside the `attachments` sweep - both halves of the key are
already in hand, so there is no per-collection declaration to forget:

```ts
stmts.push(deps.db.delete(schema.aiSuggestions).where(and(
  eq(schema.aiSuggestions.hostCollection, collection), eq(schema.aiSuggestions.hostRecordId, id))));
stmts.push(deps.db.delete(schema.moderationScans).where(and(
  eq(schema.moderationScans.collection, collection), eq(schema.moderationScans.recordId, id))));
```

`moderation_scans` holds only a hash and matters less; it is in the same statement for the same reason.

### S20 - DONE - MEDIUM: switching semantic search off freezes the vector cleanup

`drainSearchEmbeddings` (`searchEmbed.ts:38`) returns `skipped: "search.semantic is off"` **before**
`removeOrphans` (`:42`). So the feature switch gates deletion as well as creation, and two documented
guarantees stop holding the moment somebody uses the off switch:

- `removeOrphans`'s own header: *"taking a collection OUT of `INDEXABLE` is a privacy decision, and it has to
  actually remove what is already in the index rather than only stopping new writes. Without this, revoking a
  collection would leave its text embedded indefinitely."* Removing a collection from `INDEXABLE` does nothing
  at all until the next tick with the feature on.
- `aiPolicy.ts`'s stated privacy lever: *"the honest interim answer is to turn the feature flags off."* Doing
  that strands every existing vector in Vectorize - and an embedding is, as that same file says, "a lossy but
  partially invertible projection of the source text", held in a store outside the main tables.

So a purge, a soft delete or a de-indexing performed after the switch goes off leaves the vector in place with
nothing that will ever collect it. Run `removeOrphans` regardless of the feature flag and gate only
`embedPending`; deletion is not a feature, it is the undo for one. A binding check (`deps.vectors`) is still the
right guard for both.

### S21 - DONE - MEDIUM: `ai_usage` grows for the life of the deployment, with no retention story

`ai_cache` has a nightly sweep and an `expires_at`. `ai_usage` has neither, and it is the larger table: one row
per inference **and** one per cache hit (`services/ai.ts:134`). Each row carries `user_id` and
`subject` = `"<collection>/<uuid>"`, which together are a permanent per-person record of which employee had a
model consulted about which record, going back to deployment.

That is the table's stated job - *"answer 'what was sent to a model, by whom, about what' a year later"* - and
"a year later" is the part with no code behind it. `lib/ai.ts` names exactly this hazard about the gateway: a
retained copy "with its own lifetime and its own deletion story". The ledger has the first and not the second.

It also inherits S19: purging the subject record does not touch the usage rows that name it.

Needs a decision rather than a patch - pick a retention window (the audit trail presumably has one already, and
matching it is the defensible answer), then sweep on the nightly tick beside `sweepAiCache`. `ai_usage_spend_idx`
on `created_at` already supports the delete.

---

## Pass 5 - the scheduled-publish loop, unreachable settings, a missing scan test

### S22 - DONE - MEDIUM: the scheduled-publish loop makes unbounded generation calls on a cron tick

`publishDueAnnouncements` (`services/announcements.ts:348`) selects every due announcement with **no `LIMIT`**,
then for each one, serially:

```ts
if (gated) {
  await setHeld(deps, "announcements", row.uuid);
  if (!(await moderationGate(deps, "announcements", row.uuid))) continue;
}
```

`moderationGate` is one generation call, or two with `moderation.conduct` on. This is the same five-minute tick
that runs `drainModeration`, which is capped at `BUDGET.moderationsPerDrain = 8` for exactly this reason
(`aiPolicy.ts:369-383`):

> a runaway - a bulk import of every historic announcement - costs a bounded slice of the allocation per tick
> instead of the whole day before anyone notices.

The scheduled path walks straight past that ceiling. N posts due in the same minute - a comms batch, a seed, an
import that sets `publish_time` in the past - produce up to 2N generation calls in one invocation. At
`ESTIMATED_NEURONS.generate = 120` against a 7,000 ceiling, roughly **58 posts exhausts the org's entire day**.

What happens next is the bad part, because the gate fails closed: once the budget refuses, `aiGenerate` returns
`budget`, `scanCandidate` returns `"stopped"`, `moderationGate` calls `holdPost` and returns false - so **every
remaining scheduled post is held and silently does not publish**, and every other AI feature is dead until
midnight UTC. Each post is also one or two subrequests against an invocation budget the tick is already
spending on twenty-odd subtasks, plus two D1 writes apiece on the happy path (`setHeld`, then `setHeldAt(null)`).

Bound the loop the way the drain is bounded - a `LIMIT` on the `due` query when `gated`, so the overflow rolls
to the next tick, which is the behaviour the rest of the AI layer already has. The ungated path can stay
unbounded; it costs nothing.

### S23 - DONE - LOW: `cardDuplicateSensitivity` cannot be set by anybody

`aiPolicy.ts:434-447` argues the design at length:

> A CHOICE, NOT A NUMBER. The underlying knob is a cosine score, and 0.82 is not a thing an HR admin can reason
> about ... Three named positions carry the actual trade-off.

Grep for `cardDuplicateSensitivity` returns four hits: the type, the default, and the two readers
(`cardTriage.ts:60`, `cardDuplicateSweep.ts:56`). There is **no settings control, no client reference, and no
validation** in `validateAi` - so `loose` and `strict` are unreachable, every org is on `balanced`, and a value
written by hand through the API is silently coerced back to `balanced` by `cardDuplicateScore`'s `??` fallback.

The missing validation is its own small thing: `validateAi` checks the feature map, `resume_fields` and
`receipt_fields` each by name, on the stated reasoning that "an unknown key reads as `undefined` ... so a
misspelled name would silently leave the feature OFF on a screen that said it had been turned on". A misspelled
sensitivity does exactly that, and is the one leaf not checked.

Same class as S14 (`budgets.narrate`): designed, documented, defaulted, no surface.

### S24 - DONE - the drift gate that would have caught S4 does not exist

Fixed: `test/promptFencing.test.ts` scans every `aiGenerate(` call site in `src/services` and `src/domain`,
resolving the helper that builds each `system` and `user` half - `draftSystem(kind)`, `systemFor(allowed)`,
`MEASURE_SYSTEM` - because a scan that read only the call site would pass all of them without looking at a
prompt. Two rules, both of which S4 failed: a fenced prompt carries `UNTRUSTED_PREAMBLE`, and what it fences
goes through `scrubIdentifiers` or `scrubStatutoryIds`.

This codebase already uses scan tests to hold a convention that is not expressible in the type system - a goal
predicate may not be re-implemented locally, a colour may not be a hand-rolled light/dark pair. There is no
equivalent for the prompt convention, and it is the one where a miss is a security property rather than a style
one.

Two rules worth a scan, both violated today (S4):

1. A prompt whose `user` contains `FENCE_OPEN` must carry `UNTRUSTED_PREAMBLE` in its `system` (or in the user
   half, as moderation does). `attention.ts` and `goalMeasure.ts` fail this.
2. Employee-authored free text reaching a generation prompt goes through `scrubIdentifiers` or
   `scrubStatutoryIds`. Same two files fail this.

Cheapest version is a source scan over `src/services/*.ts` + `src/domain/*.ts` for `aiGenerate(` call sites, the
same shape `scopedVerbDrift` already uses to read route files. An assertion inside `aiGenerate` is stronger but
only fires on a path somebody exercises, and these two are the least-exercised paths in the layer.

### Also checked in this pass, no findings

- `domain/receiptFields.ts` / `domain/resumeFields.ts` - both field sets validated by name at
  `routes/settings.ts:633-650`, both default to empty, and the services refuse an empty set rather than reading
  everything.
- `suggestStepsForCard` / `suggestGoalForCard` (`cardTriage.ts:290-420`) - card ids clear `applyScope` before
  `card_todos` is read, frequency counted per card rather than per row, `MIN_NEIGHBOURS`/`MIN_AGREEMENT` floors
  documented with the off-by-one that was already fixed.
- `test/transportParity.test.ts` - holds the two text transports and the two vector transports against each
  other through fakes of their own backends, comparing VALUES across the two spellings (`max_tokens` against
  `num_predict`). This is the gate that catches local/production drift, and it is thorough.
- `test/resumeExtract.test.ts:98-118` asserts every `CONSENTED_PATHS` entry names a collection that is also on
  `NEVER_TO_MODEL`, and pins the set at exactly two. (`aiPolicy.ts:203` credits that assertion to
  `test/aiPolicy.test.ts`, which does not contain it - harmless, but the pointer is wrong.)
- `web/src/pages/TableBuilder.tsx` - the optional-base flow. `AI_CHOOSES_BASE` is a local sentinel that never
  leaves the dialog, the request omits `base` rather than sending the sentinel, and a failure with no base
  chosen rethrows instead of creating a table on a collection nobody picked.

---

## Pass 6 - the model-to-hide path, and the operator runbook

### S25 - DONE - MEDIUM: the deploy runbook is two features behind, and miscounts the ones it has

`docs/deploy-ai.md` is the document an operator follows to turn the AI layer on. Derived rather than eyeballed:

```
server AI_FEATURES: 16
docs/deploy-ai.md          missing: expenses.receiptExtraction, budgets.narrate
AiSettingsTab.tsx          missing: budgets.narrate
web/src/lib/aiFeatures.ts  missing: budgets.narrate
switch table rows: 14   |   prose says: "Thirteen switches, all off"
```

Three separate slips:

- **`expenses.receiptExtraction` is absent from the runbook entirely.** It is otherwise complete - settings
  card, field picker, client gate, service, route - and it sends employee-submitted receipt text to a model.
  An operator working down this table turns on thirteen things and never learns the fourteenth exists.
- **`budgets.narrate` is absent from all three surfaces**, which is S14 restated from a fourth angle.
- **The prose says thirteen and the table has fourteen**, so the count was already stale before either feature
  was added.

The section below it ("Two settings on the same screen are worth a decision rather than a default") names the CV
field picker and the daily budget. There are three: `receipt_fields` has its own picker with its own defaults
and its own reasoning (`domain/receiptFields.ts` argues at length about pharmacy and clinic receipts), and it is
the one a reader of this section would most want warned about.

A drift test over these four surfaces would hold all of it, and would also have caught S14 - see S24 for the
scan-test precedent this codebase already uses.

### S26 - DONE - the "the model never hides" claim is not absolute; it is super-admin-bounded

`services/moderation.ts:12-15` states the property the whole unattended design rests on:

> `drainModeration` writes flags; `decideModeration` is the only thing that touches a post ... A model that
> decides every kudos post is hate speech produces a long queue and no missing content.

and `domain/moderation.ts:7-11`:

> **THE MODEL FLAGS; IT NEVER HIDES** ... There is no path from a model's output to content disappearing, which
> is the property that makes it safe to run this unattended on a five-minute tick.

There is a path. `recordFlag` emits `moderation.flagged` (`:668`), the automation engine's `apiCall` action
(`domain/automations.ts:151`) can POST any endpoint, and `/v1/moderation:decide` with `action: "hide"` is an
endpoint. `domain/events.ts:229` is explicit that this is intended - `pass` is carried because it is *"the
field a rule that HIDES must condition on"*.

**The guard is real and I checked it**: `apiCall` is in `PRIVILEGED_ACTION_KINDS`
(`domain/automations.ts:208`) alongside `webhook`, `email` and `emailAudience`, and `assertMayAuthorActions`
refuses a non-super author. `collectActionKinds` recurses into `wait`/`waitFor` arms, so a privileged action
cannot hide inside a continuation, and `assertMayActOnStored` applies the same gate to enable/disable/delete -
so an hr_admin cannot arm a rule a super admin left off. That is a good design and it is not the finding.

The finding is that two files state as an invariant something that is a configuration default. The honest
sentence is "nothing hides a post unless a super admin wires a rule that does, and `pass` exists so they can" -
which is a weaker claim and still a good one. Worth fixing because these two headers are the argument anybody
reviewing this feature will read first, and the version in front of them today would not survive someone
finding the `apiCall` action.

### Also checked in this pass, no findings

- **`services/tableCatalog.ts buildCatalogue`** - the access boundary `tableAssist` rests its whole safety
  argument on. `walk(base, path, listable)` returns null for a hop into a collection the caller cannot list, so
  a linked node at depth two resolves to an empty catalogue rather than leaking field names; `allowed()` applies
  the field-level `canRead` gate to every field of every node, including the per-employee `SOURCES`, each of
  which additionally re-checks `listable` for its own collection and its `needs`. The claim in
  `tableAssist.ts:13-17` ("the fields handed to the model are exactly the fields the builder would have offered
  them in the picker") holds, because it is the same function.
- **`web/src/lib/calibrationNote.ts`** - a rating distribution said in a sentence, assembled from numbers with
  no model, and the header says why: `reviews` is on `NEVER_TO_MODEL`. Correct refusal, correctly explained.
- **`src/domain/reviewEvidence.ts`** - no AI at all despite matching the grep; it assembles an evidence pack
  from collections that are not denied, and the model is never involved.
- **`openapi.yaml`** - the three changed operations match their implementations: `describe` has
  `required: [question]` with `base` optional and `required: [base, spec, unmatched]` on the response,
  `:hide` and `:unhide` both `required: [host]`, and all three descriptions state the grant that gates them.
  `openapiRoutesDrift` passes.

---

## Pass 7 - the extraction panels, and the manual takedown

### S27 - DONE - MEDIUM: accepting two CV fields silently destroys the first, and any notes already there

`web/src/components/common/ResumeExtractPanel.tsx:38-45`:

```ts
const PATCHABLE: Record<string, string> = {
  name: "name",
  email: "email",
  phone: "phone",
  current_employer: "notes",
  current_title: "notes",   // <- the same column
  skills: "tags",
};
```

`accept` is a plain overwrite - `patch(candidatePath, { [column]: render(value) })` - and `candidates.notes` is
a single `text("notes")` column (`schema.ts:2236`), not a list. So:

1. Recruiter has typed "Referred by Priya, available from March" into notes.
2. They accept **Current employer: Acme** -> `notes` becomes `"Acme"`. The typed note is gone.
3. They accept **Current job title: Staff Engineer** -> `notes` becomes `"Staff Engineer"`. Acme is gone.

Both steps render "Saved" in green. Two clicks, on the feature whose entire safety argument is that a person
checks each value, and the second click silently undoes the first.

The file is careful about exactly this hazard one paragraph up, for two other fields:

> `summary` and `years_experience` have no column of their own - they are shown for the recruiter to read and
> copy into notes if they want them, never written automatically, because **inventing a destination for them
> would be this component deciding something the data model did not**.

`current_employer` and `current_title` have no column of their own either. They should be shown the same way -
read-only, with no Accept - or the panel should append to `notes` rather than replace it, and say in the row
which column it is writing to. Anything that keeps two Accept buttons pointed at one text column will lose data.

`ReceiptExtractPanel`'s map has no collision (`amount`, `tax_amount`, `incurred_on`, `invoice_number` each own
their column) and it converts money to `Number` before sending, so this is specific to the CV panel.

`skills -> tags` is fine: `candidates.tags` is documented as comma-separated text (`schema.ts:2235`) and
`render` joins an array with `", "`.

### S28 - DONE - LOW: a manual hide leaves `held_at` set

`hideManually` (`moderation.ts:1317`) reads the candidate with `includeHidden: true`, calls `hideHost`, and
stamps the flag `accepted`. `hideHost` writes `disabled` / `deleteTime` and **never touches `held_at`**.

`decideModeration` goes out of its way to avoid the state that leaves (`:1487-1502`):

> `held_at` hides a row from EVERY read (services/withheld.ts), including the restricted views that show
> editors a disabled post, and the queue lists `pending` flags only. So a held post whose flag was just upheld
> satisfied both exclusions at once ... the author's writing was simply gone, which is the one outcome
> moderation must never produce.

...and clears the hold first for exactly that reason. `hideManually` reaches the same end state by a different
door and does not.

It is recoverable today, and only because the decided history landed in this same change: the flag is
`accepted`, so it renders under "Already decided", and `unhideModeration` clears `heldAt`. So this is a stale
column rather than a lost post - but it is one regression away from being the hole the comment above describes,
and the asymmetry between two functions that write the same end state is the thing worth removing. One line,
beside the `hideHost` call:

```ts
await setHeldAt(deps, collection, recordId, null);
```

Reaching it needs a direct `POST /v1/moderation:hide` against a held post - the board does not render held
posts and the queue's buttons call `:decide` - so likelihood is low and correctness is cheap.

While there: `hideManually:1319` re-checks `isModeratable(collection)` immediately after `splitHost` has already
thrown for the same condition (`:1670`). Harmless, but it reads as though one of the two is load-bearing.

### Also checked in this pass, no findings

- **The new verb's six registries.** `accessHint.ts ACCESS_VERBS` + `KNOWN_VERBS`, `customMethods.ts`,
  `verbMeta.ts` (both new verbs carry a `caution` line naming what the grant lets somebody do to other
  people's posts), `resourceStore.ts VERB_SIDE_EFFECTS` (`moderation:hide` / `:unhide` both invalidate
  announcements + suggestions + notifications, matching the existing `:decide` entry, which carries a note
  explaining why `verbInvalidationDrift` cannot see any of the three), `openapi.yaml`, and
  `test/grants.test.ts`'s withheld list. All present; the drift tests pass.
- **Wire ids on the new endpoints.** `host` travels as a `<collection>/<id>` ref in the body and
  `decodeWireIds.ts decodeBodyRefs` rewrites any such string generically, with `announcement-replies` in
  `ENCODABLE` specifically so a reply can be addressed this way (`encodeWireIds.ts:39-41`). The routes take the
  decoded id straight through, which is the rule. A token that fails to decode falls through to a `notFound`,
  not a raw-id read.
- **`Announcements.tsx` / `Suggestions.tsx` wiring.** Both address `moderation.hide` rather than the post's own
  collection, both gate the button with `AccessAction` off the caller's capabilities rather than testing a role,
  and both now route their delete through the shared decision vocabulary so the destructive neighbour of a Hide
  button asks in the same voice. The `isDraft` fix (a `disabled` post is withdrawn, not unfinished) keeps a
  moderator-hidden post off the Drafts strip, which is right.
- **`TicketTriageCard`** - gated in the component like `DraftButton`, renders "nothing to say" explicitly rather
  than blank, and `decideTriage` is fire-and-forget with a silent catch because it is measurement.

---

## Pass 8 - what writes to `ai_suggestions` and what ever reads it back

Four features write to `ai_suggestions`. Exactly two of them are ever read back, and exactly two ever set
`state` - and they are not the same two.

| feature | written by | read back by | `state` ever set |
|---|---|---|---|
| `moderation` | `recordFlag`, `holdPost`, `hideManually` | the queue, both views | yes |
| `tickets.triage` | `recordSuggestion` | nothing (recomputed live) | yes, `decideTriage` |
| `cards.duplicates` | `sweepCardDuplicates` | `boardDuplicates` (scoped) | no - `pending` is the sweep's own clock |
| `ats.resumeExtract` | `recordSuggestion` | **nothing** | **no** |
| `expenses.receiptExtract` | `recordSuggestion` | **nothing** | **no** |

### S29 - DONE - MEDIUM: the two extraction features write PII that nothing reads, nothing decides and nothing deletes

`grep` for `aiSuggestions` across `src/` returns eight files, all of them writers except
`services/moderation.ts` and `services/cardDuplicateSweep.ts`. No route, no serializer and no service reads an
`ats.resumeExtract` or `expenses.receiptExtract` row back, and `state` is only ever written by
`decideModeration`, `hideManually` and `decideTriage` - none of which touch either feature. The panels PATCH the
host record directly and call no decide verb.

So for the two features that store the most sensitive payloads, every stated reason for the table is unmet
(`schema.ts:1823-1832`):

> PROVENANCE ... MEASUREMENT. **The accept rate is the only honest signal of whether a feature is worth its
> neurons.** A suggestion nobody takes is a feature to remove, and without this table that is unanswerable.

It is still unanswerable. Every extraction row is `pending` for ever, so the accept rate for CV extraction and
receipt extraction reads as 0% regardless of what recruiters and submitters actually did.

Meanwhile the payload is `{name, email, phone, current_employer, current_title, years_experience, summary}` for
a candidate, and vendor/invoice/amounts for an expense - written on every extraction, with:

- no reader (so it is not provenance anybody can consult),
- no decide path (so it is not measurement),
- no cleanup on purge (S19),
- and, for receipts, only ever the **first** extraction, because the insert has no upsert (S3).

Two ways out, and they point in opposite directions, so it is a decision rather than a patch:

- **Finish it** - add a decide verb the way tickets has, so the accept rate exists and the row earns the
  retention. Then S19 becomes mandatory rather than merely correct.
- **Stop storing the payload** - record the fact of the extraction (feature, model, field count, `basis`) and
  drop the values. The panel already has the fields in the HTTP response; storing them buys nothing today and
  is the whole of the retention problem.

The second is smaller and is what the current behaviour is already doing minus the payload, so it is probably
the honest one until somebody wants the accept rate.

### S30 - DONE - LOW: `ai_usage.error` is the one column that can carry prompt text back into the database

`runRecorded` (`services/ai.ts:286`) stores `error: (e as Error).message` verbatim and untruncated;
`schema.ts` declares it as a plain `text("error")`. Two lines above it in the same insert:

> The hash, never the text. Storing the prompt would rebuild inside our own database exactly the retained copy
> of salary and review text that `lib/ai.ts` suppresses at the gateway.

That holds for `input_hash` and not for `error`. A provider error that quotes what it was given - "input
exceeds N tokens: <prompt>", a validation failure that echoes the offending message, anything a future model
or gateway decides to be helpful about - lands in the column whole. The same string also goes to Workers Logs
via `console.error` on the line below.

Not a live leak: today's Workers AI errors are short and do not echo input, which is why it has not shown up.
It is a leak *waiting on somebody else's error message*, on the one code path that handles text the rest of the
file is careful never to persist. Truncating to a couple of hundred characters would bound it, and stripping
anything that matches the fence delimiters would bound it properly.

### Also checked in this pass, no findings

- **`ai_suggestions` is not a wire collection.** No route file references it, matching the schema's claim that
  it is served as a sub-resource of whatever it is about. Nothing serves a stored payload unscoped: the two
  readers are the moderation queue (gated by the `moderation.read` capability) and `boardDuplicates` (binds the
  caller's card scope to both halves of every pair).
- **`domain/attention.ts attentionConfigOf`** clamps every numeric leaf on read with an explicit lo/hi and
  falls back to the default for a non-finite value. This is exactly what `aiConfig` does not do (S11) - worth
  citing as the in-repo pattern when fixing it, since the settings validator's own comment says the clamp and
  the validation are deliberately both present and not redundant.
- **`test/aiLocalIntegration.test.ts`** - the new base-choosing case asserts the format and the vocabulary
  (`coerceBase` refuses anything not in the offered list) rather than the judgement, which is the right line for
  a live-model test. The whole file is `describe.skipIf(!LIVE)` and so never runs in CI; `transportParity` is
  what actually gates the two transports, and `lib/aiLocal.ts` says as much.
- **Log hygiene in the moderation drain.** Every `console.error` there names `<collection>/<recordId>` and
  never the post text - deliberate, and the opposite of S30.

---

## Pass 9 - `held_at`, and the reads that do not know about it

`services/withheld.ts` states the rule and names its own risk:

> A held post is withheld from EVERYONE ... There are a dozen reads over these three tables ... and a held row
> must be absent from all of them. One of them forgetting is not a cosmetic bug: it is the gate not holding, on
> the one surface where somebody looked ... `test/withheldReads.test.ts` is what watches for it.

`notHeld` has four call sites (`crud.ts:211`, `announcements.ts:101`, `announcements.ts:704`,
`suggestions.ts:107`). `test/withheldReads.test.ts` does not exist. Both of the following follow from that.

### S31 - DONE - HIGH: a held suggestion or reply can be lost permanently

`dueForScan` builds its candidates from queries that filter `delete_time` and **not `held_at`**:

```ts
// suggestionCandidates (:556)
.where(and(...(includeHidden ? [] : [isNull(s.deleteTime)]), ...))
// replyCandidates (:511)
...(includeHidden ? [] : [isNull(rep.deleteTime)]),
```

The comments above both claim a held row carries a soft-delete stamp - *"A held reply carries its own
soft-delete stamp, which is how it is kept off the thread until it is released"*, and the matching line in
`liveHosts:1199-1202` for suggestions. **That is not true of the code.** `createSuggestion:136`, `addReply:661`
and `holdPost:785` all set `held_at` and nothing else; `delete_time` stays null. So a held suggestion and a held
reply are both live candidates for the cron drain.

Announcements are not affected: a held announcement is also `published: false`, and
`announcementCandidates` filters on `published`.

**The sequence that loses the post**, all of it ordinary operation:

1. Gate on. Somebody submits a suggestion while the model is down or the daily budget is spent.
   `moderationGate` gets `"stopped"` -> `holdPost` -> `held_at` set, flag written `UNCHECKED` / `pending`.
   **No scan row is stamped** - that is the documented behaviour for a call that never landed.
2. Minutes or hours later the model is back. `drainModeration` picks the suggestion up, because nothing filters
   `held_at`. It has no scan row, so there is no hash short-circuit: it is scanned for real.
3. The model reads it and says safe. `scanCandidate` sets `cleared = true`, stamps the scan, and calls
   `supersedeFlag` - which moves the `pending` flag to `superseded`.
4. `listModerationQueue` shows `pending` (queue) and `accepted`/`rejected` (history). `superseded` appears in
   neither. **`held_at` is never cleared** - only `moderationGate` clears it, and the drain is not the gate.

The suggestion now has `held_at` set, so `notHeld` hides it from every read including its author's, and its
flag is in the one state no queue shows. Nothing in the product can see it, list it or release it. This is the
outcome the file says twice must never happen:

> the author's writing was simply gone, which is the one outcome moderation must never produce.

It is also the *more* likely path of the two, because step 1 is an outage or a spent budget rather than
anything anyone did wrong - and S22 (the unbounded scheduled-publish loop) is a reliable way to spend the
budget.

Two fixes, and both are worth having:

- Filter `held_at` out of the drain's candidates, the way `withheld.ts` says every read should
  (`notHeld(s)` / `notHeld(rep)`). The gate owns held rows; the sweep should not touch them.
- Make `supersedeFlag` refuse to retire a flag whose host is held, or have it clear the hold when it does -
  so that even if a held row reaches it, the post comes back rather than disappearing.

Then correct the two comments that describe a soft-delete stamp no code writes.

### S32 - DONE - MEDIUM: three reads over held tables omit the filter, so held content is visible

Fixed: `notHeld` on all three - `suggestionSimilar` (which rendered a held suggestion's TITLE as somebody
else's neighbour), `reviewEvidence` and `reviewCollaborators`. Two more found by the scan written for S33 and
fixed with them: the `repliedBy` sub-query on the board (a held reply pulled its post into a "replied to"
view) and `publishDueAnnouncements` (a held scheduled post was picked up again every tick, re-held and its
author re-told, for as long as it waited).

Grep for `.from(schema.announcements | suggestions | announcementReplies)` finds six files. Three of them
never call `notHeld`:

- **`services/suggestionSimilar.ts:110`** - filters `delete_time` and `applyScope`, not `held_at`. A held
  suggestion - one nobody has ever been allowed to see, possibly the one a model flagged - is returned as a
  neighbour on somebody else's suggestion, **with its title rendered** in the "others asked for this" panel.
  This is the gate's central promise broken on a surface built after it.
- **`services/reviewEvidence.ts:161`** - kudos evidence. Filters `delete_time`, `disabled` and scope; no
  `held_at` and no `published`. A held kudos post lands in a performance review's evidence pack.
- **`services/reviewCollaborators.ts:197`** - the same query shape for "who worked with this person". A held
  kudos counts toward the collaborator tally.

All three are reads that were written against the pre-gate world and never revisited. `suggestionSimilar` is
the one to fix first: it renders held text, where the other two render a count and a body inside a review pack.

### S33 - DONE - the guard named in the source does not exist

Fixed: `test/withheldReads.test.ts` now exists and is what `services/withheld.ts` claimed it was. It
enumerates every `.from(<heldable table>)` in `src/` - including the local bindings the moderation service
reads its joins through - and requires each statement to bind `notHeld` (or `visibleWhere`, which calls it),
or to be named in an allowance list with the reason. Twelve reads are allowed: the moderation service, which
owns the state, and the write paths, through which an author can still edit or delete what they wrote while
it waits.

`test/withheldReads.test.ts` is cited by `withheld.ts` as the thing that watches for exactly S31 and S32, and
there is no such file (`ls test/ | grep -c withheld` -> 0). This is the third documented-but-absent guard found
in this review, after the `aiPolicy.test.ts` pointer (pass 5, harmless - the assertion lives in
`resumeExtract.test.ts`) and the scan-on-write tests that never reach `scanOnWrite` (S17).

The test is mechanical and would have caught both findings above: enumerate every
`.from(schema.<heldable table>)` in `src/`, and require each query either to call `notHeld` or to be on a
declared allowlist (the moderation queue, which deliberately reads held rows, and `candidatesFor` with
`includeHidden`). `scopedVerbDrift` already scans route files this way, so the shape is in the repo.

---

## Pass 10 - `held_at` has no reconciliation, and three routes reach a permanent hold

Grep for `heldAt` across `src/services/` and `src/routes/`: outside `services/moderation.ts` there are only
writers (the three create/update paths that set it) and readers (`withheld.ts`, `crud.ts:183`). **Nothing
outside that one file ever clears it.**

Inside it, every clear is `setHeldAt(..., null)`, and every caller of that reaches it through a flag that is
`pending`:

| clearer | requires |
|---|---|
| `moderationGate` (cleared / unchanged / no candidate) | the gate call itself, once |
| `releasePost` (a moderator dismisses) | flag `pending`, host on the queue |
| `decideModeration` (a moderator hides) | flag `pending`, host on the queue |
| `unhideModeration` | flag `accepted` |

So a held row whose flag is `superseded`, or absent, or whose host the queue drops, is held **for ever** - and
there is no sweeper anywhere that asks the reconciling question this codebase asks about everything else:
*is there a row with `held_at` set and nothing outstanding that could release it?*

That is the structural version of S31, and it is worth stating separately because the same gap is reachable by
three unrelated routes, so fixing only the one in S31 leaves two open.

### S34 - DONE - HIGH: no reconciliation for `held_at`; three ways to a permanently invisible post

**Route 1 - the drain retires the flag** (S31, full detail there). Held suggestion or reply, held because the
model was down, gets re-scanned clean by the cron, `supersedeFlag` retires the `pending` flag, `held_at`
survives. No queue shows `superseded`.

**Route 2 - the gate throws before it writes the flag.** `moderationGate`'s catch (`:208-213`) returns false
and writes nothing:

```ts
} catch (e) {
  console.error(`moderation: gate failed for ${collection}/${recordId}`, e);
  return false;   // "The row stays invisible, and the sweep will offer it again."
}
```

The row is already held - `createSuggestion:136` / `addReply:661` / `createAnnouncement:236` set `held_at` at
the insert - so "stays invisible" is right and "the sweep will offer it again" is not: the sweep writes a flag
only when a model objects, and a scan that comes back clean calls `supersedeFlag` on a flag that was never
created. The most plausible trigger is `holdPost` itself, which is two statements with no transaction -
`setHeldAt(now)` and then the flag insert - so a D1 failure between them lands exactly here.

**Route 3 - a held reply's parent is hidden.** `liveHosts:1242`:

```ts
if (!parentVisible || !keep(visible, r.heldAt)) continue;
```

`!parentVisible` short-circuits **before** `keep`, which is the clause that exists to preserve held rows. So a
held reply under a post a moderator subsequently disabled is dropped from `liveHosts`, `listModerationQueue`
pushes it to `orphaned`, and `retireOrphans` writes `superseded`. Restoring the parent does not bring it back
unless the reply also happens to have a `flagged: true` scan row for `reopenFlag` to find - which it does not
have when the hold came from an `UNCHECKED` outcome.

**The fix is one sweeper, not three patches.** On the nightly tick, for each of the three heldable tables:
select rows with `held_at IS NOT NULL` that have no `ai_suggestions` row in state `pending` for feature
`moderation`, and for each either write an `UNCHECKED` pending flag (puts it back on the queue for a person -
the conservative choice, and the one that matches "flag, never hide") or clear the hold. It is the mirror of
`retireOrphans`, which already closes flags with no host; this closes hosts with no flag.

Worth doing regardless of S31's own fix, because routes 2 and 3 do not go through the drain at all.

Then the three narrow fixes are still each worth having, because a sweeper that runs nightly means up to a day
of a post being invisible:

- filter `held_at` out of `dueForScan`'s candidates (route 1),
- make `holdPost` atomic, or have the gate's catch write the `UNCHECKED` flag before returning false (route 2),
- evaluate `keep` before `parentVisible` for a held reply, or keep the reply and report `visible: false`
  (route 3).

### Why this class keeps appearing

Every other piece of moderation state in this app is reconciled: `moderation_scans` compares a text hash so an
edit comes back round, `search_vectors` outer-joins `search_docs` to find orphans, `retireOrphans` closes flags
whose host is gone, and the header of `services/moderation.ts` says why:

> nothing in the database announces a write to a service, so the only reliable question is "what does the
> record say now, and does that match what we last looked at".

`held_at` is the one piece of that state with no such question asked about it. It was added with the gate,
later than the rest, and the reconciliation that covers its neighbours was not extended to it.

---

## Pass 11 - releasing a held post runs the gate again, and can silently un-release it

### S35 - DONE - HIGH: "Release" during a model outage leaves the post invisible and the history saying it is up

Route 4 to a permanent hold, and unlike the three in S34 this one is reached by a moderator doing the normal
thing on the normal screen.

`decideModeration(..., "dismiss")` on a held announcement (`:1504`):

```ts
if (action === "dismiss" && held) await releasePost(deps, collection, recordId, user);
await deps.db.update(schema.aiSuggestions).set({ state: "rejected", decidedBy, decidedAt, ... })
```

`releasePost` (`:711`) clears the hold and then calls `setPublished`, because a held announcement is also left
unpublished and publishing is the one path that audits and broadcasts. But `setPublished` **starts with the
gate** (`lifecycle.ts:96-99`):

```ts
if (published && isModeratable(collection) && (await moderationGateOn(deps))) {
  await setHeld(deps, collection, id);
  if (!(await moderationGate(deps, collection, id))) return row;
}
```

So a release re-holds the post and asks the model again. With the model healthy the hash is unchanged, the gate
returns true, and it publishes. With the model **down, or the daily budget spent**:

1. `scanCandidate` -> `"stopped"` -> `moderationGate` -> `holdPost` -> `held_at` set again, flag back to
   `pending`, the author is told "your post could not be checked yet" - **a second time, after a moderator
   released it**.
2. `moderationGate` returns false, `setPublished` returns the row without publishing, and **nothing checks that
   return value**. `releasePost` returns normally; `decideModeration` carries on.
3. `decideModeration` then overwrites the flag to `rejected`.

Final state: `held_at` set, `published` false, flag `rejected`.

- Pending queue: not `pending`, so absent.
- Decided history: present, badged **"Released"**, and `Moderation.tsx` renders the line *"On the wall."* under
  it. It is not on the wall.
- `unhideModeration`: refuses - it requires `accepted` ("that post was not hidden by a moderation decision").
- `moderationHoldOn`: false, so the un-hide guards do not apply either.
- Every read is blocked by `notHeld`, including the author's.

The moderator is told it worked, the history says it is up, and the post is gone. The trigger is a model
outage, which is exactly when the queue is fullest, because the gate fails closed and the queue is where all
the held posts went.

A nastier sub-case: when the hold came from `UNCHECKED` there is no scan row, so the re-gate performs a **real
scan**. If the model now objects, `recordFlag` writes hazards, `holdPost` holds it, and `decideModeration` then
stamps `rejected` - so the record says a human released a post the model had just flagged, and the post is
invisible.

Two things to fix, and they are separable:

- **`releasePost` must not be re-gated.** A moderator dismissing a flag has already overruled the model;
  running the check again is the machine re-litigating a decision it lost. `setPublished` needs a way to skip
  the gate for this one caller (a parameter, or a `publishReleased` helper that does the flip, the audit and
  the broadcast without the gate block).
- **`setPublished`'s return must not be discarded.** `releasePost` ignores it, so "the publish did not happen"
  is indistinguishable from success all the way up to the HTTP 200. Even with the gate skipped, the guarded
  flip can legitimately claim nothing; the caller should know.

Until then the sweeper in S34 is what would rescue the post, which is another reason to build it.

### Second-order: a dismiss costs a model call it should not

Even on the happy path, `dismiss` runs `setHeld` -> `moderationGate` -> `scanCandidate` -> `setHeldAt(null)`:
three extra writes per release, plus a cache lookup, plus - whenever the hold came from `UNCHECKED` and so left
no scan row - a full generation call charged to the org's daily budget, on the one action that means "a person
has already decided this". On a queue that filled up during an outage, releasing it post by post re-spends the
budget that caused the backlog.

---

## Pass 12 - the per-drain ceilings are sized against the drains, not against the budget they share

Derived, not estimated (`BUDGET` and `ESTIMATED_NEURONS` read out of `domain/aiPolicy.ts`, 288 ticks/day at the
five-minute cron):

```
BUDGET { daily: 7000, embedsPerDrain: 200, moderationsPerDrain: 8 }
NEURONS { embed: 1, rerank: 3, generate: 120, moderate: 60 }

embed drain      capacity 57,600 rows/day = 57,600 neurons   budget allows  7,000 rows/day   (8.2x over)
moderation drain capacity  2,304 posts/day = 414,720 neurons  budget allows     38 posts/day  (60x over, conduct on)
                                                              budget allows    116 posts/day  (20x over, hazard only)
```

Both per-tick ceilings are documented as the thing that stops a runaway:

> a first-run backfill of a large database spreads over several ticks instead of spending the day in one
> (`searchEmbed.ts:19-20`)

> a runaway ... costs a bounded slice of the allocation per tick instead of the whole day before anyone notices
> (`aiPolicy.ts:379-381`)

Neither is true. 7,000 / 200 = **35 ticks**, so a backfill spends the entire org's day in **under three hours**,
and does it again every day until it finishes.

### S36 - DONE - HIGH: turning on semantic search can stop the noticeboard working

`src/cron.ts` runs the embed drain first (`:154`) and moderation second (`:160`), and both spend the same
`ai_usage`-backed daily ceiling that `withinDailyBudget` reads. Once cumulative spend since UTC midnight passes
7,000, **every** `aiGenerate` refuses with `budget` - including `moderationGate`, which runs in the request
path. The gate fails closed, so it holds.

The sequence needs nothing but two switches an org is told to turn on:

1. `moderation` is on. Posting works.
2. Somebody turns on `search.semantic` on a database with more than 7,000 indexable rows - a real employee
   directory plus tickets, cards, goals and documents reaches that easily.
3. The backfill spends the day's budget by mid-morning. It will do so again tomorrow: at 7,000 rows/day a
   50,000-row corpus takes about **eight days**.
4. From mid-morning every day until the backfill completes, `moderationGate` gets `budget` -> `"stopped"` ->
   `holdPost`. **Every post written after that point is held**, its author told "your post could not be checked
   yet", and the only way out is a moderator draining the queue - which (S35) itself re-runs the gate against
   the same spent budget and can silently fail.

Drafting, CV extraction, receipt extraction and the table builder all refuse for the rest of the day too, with
"the organisation's AI budget for today is spent". Those are honest refusals of optional features. The held
noticeboard is not optional, and nothing connects the two switches for whoever turned the second one on.

The design gap is that the budget is **first-come-first-served with no reservation**, and the unattended work
always arrives first: the cron runs on its own schedule, the person pressing Draft arrives later. A share for
interactive work - cap unattended spend at some fraction of the day, checked in `withinDailyBudget` from
`ctx.userId == null` - would make the guarantee the per-drain ceilings are currently claimed to give. Sizing
`embedsPerDrain` and `moderationsPerDrain` so that `ceiling x 288 <= dailyNeurons` would be the blunt version
(35 and 2 respectively), and is worth doing anyway so the two numbers stop implying a bound they do not carry.

`docs/deploy-ai.md` says to turn features on one at a time and watch the ledger, which is good advice and is
the only thing standing between an org and this today. It does not mention that the backfill competes with the
gate.

### S37 - DONE - MEDIUM: turning on the conduct pass re-queues every post a moderator has ever dismissed

`scanIdentity` (`moderation.ts:59`) is `"<moderate model>+<generate model>"` when conduct is on and
`"<moderate model>"` when it is off, and it is stamped on the scan row. Switching the pass on therefore makes
every post on the wall look unscanned - which is deliberate and correct (*"turning the conduct pass on has to
bring the whole wall back round"*).

What comes with it is not. The re-scan takes the full path, and when the hazard pass objects again,
`recordFlag`'s upsert (`:644-657`) sets:

```ts
set: { payloadJson, basis, model, state: "pending", decidedBy: null, decidedAt: null, updatedAt: now }
```

The justification above it is about an **edit**:

> A re-scan clears the previous decision with the previous flag. The text changed, so a moderator's "this is
> fine" was about something else, and carrying it forward would let an edit inherit a verdict.

Here the text did not change - the model set did. So every post a moderator explicitly dismissed comes back on
the queue, with the same excerpt and the same hazards, for them to dismiss again. On a wall with any history
that is the queue filling with work that has already been done, at the exact moment somebody is trying out a
new pass and forming a first impression of whether it is worth trusting.

Distinguish the two cases: reset the decision when the **hash** differs, keep it when only the scan identity
does. A conduct flag on a post whose hazard flag was already dismissed is still worth raising - it is a new
reason - but it should arrive as a conduct flag, not as the old one re-opened.

And the cost of that re-scan is S36's arithmetic: at 38 posts/day a 2,000-post wall takes about **52 days** to
come round, spending the whole org's daily allocation on moderation for every one of them.

---

## Pass 13 - the budget check gets more expensive the more the budget is used

### S38 - DONE - MEDIUM: `withinDailyBudget` reads every `ai_usage` row written today, before every inference

`services/ai.ts:185-189`:

```ts
const rows = await deps.db
  .select({ spent: sql`coalesce(sum(${schema.aiUsage.estimatedNeurons}), 0)` })
  .from(schema.aiUsage)
  .where(gte(schema.aiUsage.createdAt, utcMidnight(deps.clock.now())));
```

The index is there and the schema comment says why:

> The budget check is "neurons spent since midnight UTC", so it reads by time. Without this index that check
> would scan the table, and it runs before every single inference.

The index bounds the read to **today's** rows. Today's rows are exactly the thing that grows, and the check
runs before every inference *and* is charged a row read for each one summed. So the cost of asking "is there
budget left" rises linearly with how much budget has been used, on a database that bills rows read.

A row is written per inference **and** per cache hit (`:134`), so on a busy day `ai_usage` reaches the low
thousands. Every embed for a semantic search, every moderation scan in the drain (8 per tick, each with its own
check), every draft, every extraction pays a sum over all of them. Over a day it is quadratic in the number of
calls - roughly N²/2 row reads for N inferences - which is the shape this codebase elsewhere goes out of its
way to avoid (`lib/vector.ts`'s whole argument for not putting vectors in D1 is that "D1 bills rows read").

It is not urgent at today's volumes - the daily ceiling caps N at a few thousand - but it is the one cost in
the AI layer that gets worse precisely when the layer is working, and the fix is small: keep a per-UTC-day
rollup row (`ai_daily_spend(day, neurons)`) incremented in the same `recordUsage` write, and read that single
row in `withinDailyBudget`. The ledger stays the source of truth and can reconcile the rollup nightly, which is
the pattern `moderation_scans` and `search_vectors` already use.

A cheaper interim: memoize the sum on `deps.refCache` for the life of one request, the way `aiConfig` is
memoized. It would not help the drain (8 checks in one invocation, and the answer genuinely changes between
them), but it would help every request path that makes more than one call - the table builder's two
generations, and any future feature that batches.

### Checked in this pass, no findings

- **`withinUserRate`** has the same shape but is correctly bounded: `count(*)` over `(userId, createdAt >= -1h)`
  with `ai_usage_user_idx` on exactly that pair, and the ceiling caps the count at around 20 rows. No issue.
- **`routes/attention.ts:15`** and **`routes/peopleAnalytics.ts:55`** both fall back to an empty scope map
  (`?? new Map()`), which `applyScope` turns into `1 = 0` - fail closed, matching the documented behaviour.
- **The generation cache and moderation.** A verdict is cached 7 days on
  `(feature, role, promptVersion, system, user)`, so two different posts with byte-identical text share one
  verdict - correct, since the model is being asked about the text. A human's dismissal does not feed back into
  the cache, so reposting text a moderator released is held again; arguably right (the model's opinion has not
  changed) and worth knowing.

---

## Pass 14 - how the fixes interact, and where the gate's tests stop

### IMPORTANT: the S1 fix as written would break the legitimate release path

`test/moderation.test.ts:818` - *"releasing a held post puts it on the wall and tells the audience"* - passes
**because of the same short-circuit S1 abuses**. Trace it:

1. The post is held with `deps.ai` scripted to answer `unsafe\nS10`, so the scan row is stamped
   `flagged: true` with hash(T).
2. `decideModeration(..., "dismiss")` -> `releasePost` -> `setPublished` -> the gate runs again (S35).
3. `scanCandidate` sees the same hash and the same scan identity -> `"unchanged"` -> `moderationGate` clears
   the hold and returns true -> the post publishes and the audience is told.

So the release only works because `"unchanged"` is treated as a pass on a post whose last verdict was a flag.
Applying the fix I suggested for S1 -

```ts
if (c.flagged) return "flagged";
```

- turns that test red and makes a held post **impossible to release**, which is a worse bug than the one being
fixed. The two behaviours are the same three lines serving two callers with opposite needs.

**Order the work accordingly:**

1. **S35 first** - `releasePost` must not re-enter the gate at all. A moderator dismissing a flag has already
   overruled the model. Give `setPublished` a way to skip the gate block for this one caller.
2. **Then S1** - with the release path no longer depending on it, `moderationGate` can safely refuse an
   `"unchanged"` outcome whose candidate carries `flagged: true`.
3. **Then S34's sweeper**, which catches whatever either of them still strands.

Doing S1 first, or alone, converts a bypass into a trap.

### S39 - DONE - the gate has no e2e coverage, and its unit tests stop just short of every finding

Fixed both halves.

**Unit.** A new cross-function block in `test/moderation.test.ts` takes each of the steps this table says the
suite stopped short of: publish a held post twice (S1), hold a suggestion with the model down and then let the
drain read it clean (S31), reconcile a held post whose flag went away (S34), and release a held post while the
model is down (S35). The invariant they share is stated at the top of the block: a held row always has
something that can release it.

**E2E.** `e2e/aiFeatures.spec.ts` now posts with the gate ON and follows the post to the wall - directly, or
via a moderator releasing it from the queue. It lives in that file rather than `moderationQueue.spec.ts`
because the switch is one org-wide settings row and two spec FILES writing it race. What it does not claim is
the model's verdict: a local Gemma is not Llama Guard, so both outcomes are accepted and the assertion is that
the post is never in the third place, which is nowhere.

`e2e/moderationQueue.spec.ts` has three tests: the queue opens and says it is empty, an employee is refused the
page and the endpoint, and a super gets a 404 for an unflagged post. That is the authz surface. **No e2e test
posts anything with the gate on**, so nothing end-to-end exercises holding, releasing, or the wall.

`test/moderation.test.ts` is thorough - 82 tests - and covers the hold, the release, the upheld hold, the
queue's held rows, the drain's ordering and budget, both parsers, both dialects, the event. Every finding in
this review sits one step past where a test stops:

| finding | the test that gets closest | the step it does not take |
|---|---|---|
| S1 | `:545` "does not read a draft, and reads it the moment it is published" - ends with the post held | call `setPublished` a second time |
| S17 / S2 | `:513` describe "a post is read when it is written" - four tests | run any of them with `moderation` **off**, which is the only configuration where `scanSoon` is reached |
| S31 | `:567` "holds a post when the model is down" | let the model recover and run `drainModeration` |
| S35 | `:818` "releasing a held post puts it on the wall" | script the model to fail *at release time* |
| S32 | `:800`-ish held-suggestion leak checks against `listSuggestions` | ask `similarSuggestions`, `reviewEvidence` or `reviewCollaborators` the same question |

That is a coherent shape rather than a coincidence: the suite tests each function against the state it was
written to produce, and every finding here is a state produced by one function and consumed by another. The
tests that would catch them are cross-function, and there are none - which is also why S33's missing
`withheldReads` scan and S24's missing prompt scan matter more than a single unit test each would.

Three tests would close most of it, and each is a few lines on an existing fixture:

- publish a held post twice; assert it is still held (S1),
- hold a post with the model down, restore the model, `drainModeration`, assert it is still reachable from the
  queue and that `held_at` is either cleared or still flagged (S31/S34),
- release a held post with the model down; assert the post is either published or still on the queue, never
  `rejected` while held (S35).

### Supporting note for S27: the codebase already has the safe pattern

The AI write-back surface splits in two, and the bug is in the half that writes directly:

- **Hand it up to the form** - `CardGoalSuggest` (`onPick`), `CardStepsSuggest` (`onAdd`),
  `GoalMeasureSuggest` (`onPropose`). Nothing writes; the parent merges into form state, and
  `Goals.tsx:1823-1828` is explicit about the hazard S27 falls into:

  > A null means "the goal does not say", which must not wipe what somebody has typed.

- **PATCH the record from the panel** - `ResumeExtractPanel`, `ReceiptExtractPanel`. These own a `PATCHABLE`
  map, and the CV one points two different fields at the `notes` column (S27).

The read-only panels (`CardTriageCard`, `TicketTriageCard`, `GoalSimilarCard`, `SimilarAsks`) write nothing at
all and are clean. If the extraction panels adopted the hand-it-up pattern - render the values, let the
candidate/expense form merge them - S27 stops being possible rather than being fixed.

---

## Pass 15 - the gate is an unmetered, unattributed generative endpoint

Both gate call sites pass the same context (`moderation.ts:248`, `:345`):

```ts
{ feature: FEATURE, collection: c.collection }
```

No `userId`. No `subject`. Two consequences, and the first is the most serious finding after S1.

### S40 - DONE - HIGH: any employee can exhaust the org's daily AI allocation in seconds, and the noticeboard stops

`withinUserRate` (`services/ai.ts:199-200`) opens with:

```ts
if (!ctx.userId) return { ok: true };
```

...which is correct for the cron and wrong here: the gate runs **in the request path, on a write a person just
made**, and it is the single highest-volume generative caller in the app. With no `userId` it is exempt from
the per-caller hourly ceiling that exists to stop exactly this.

Nothing else covers it either. `middleware/rateLimit.ts` has a tight `render` budget (40/min) for PDF
construction *because that work is expensive*; an inference is comparably expensive **and** spends a shared,
hard-capped daily allocation. There is no AI budget in that file, so `POST /v1/announcements` and
`POST /v1/suggestions` fall to the catch-all `api` budget of 3000/min.

The arithmetic (derived in pass 12): the daily ceiling allows **38 posts** with conduct on, **116** with the
hazard pass alone. At 3000 requests a minute that is **under three seconds** of allowed traffic. Each post needs
only new text to miss the generation cache, which is free.

What the org gets afterwards, for the rest of the UTC day:

- the gate fails closed, so **every subsequent post on every wall is held** with "your post could not be
  checked yet",
- drafting, CV extraction, receipt extraction and the table builder all refuse,
- and the queue that would release the held posts is drained by an action (S35) that itself re-enters the gate
  against the same spent budget.

No access-control failure is involved - this is an ordinary employee using the noticeboard as designed, or a
runaway client loop, which is the exact threat `rateLimit.ts`'s own header names:

> Authentication bounds WHO, not HOW OFTEN ... a signed-in employee (or a runaway client loop) driving the
> surfaces that cost real work.

**Do not fix this by simply passing `userId` into the gate's context.** That routes the refusal through
`withinUserRate` -> `rate` -> `scanCandidate` returns `"stopped"` -> `holdPost`, so the 21st post in an hour is
not refused, it is **held indefinitely pending a moderator**. A rate limit that silently withholds somebody's
writing is worse than no rate limit. The right shape is an HTTP-layer budget so the author gets a clear 429 and
no row is created:

```ts
// middleware/rateLimit.ts, before the catch-all
{ name: "moderated-write", limit: 30,
  matches: (m, p) => m === "POST" && (p === "/v1/announcements" || p === "/v1/suggestions"),
  rate: keyedCounter(30) },
```

...plus the interactive reservation from S36, so unattended drains cannot spend the share a person needs to
post. Sizing is a judgement call; the point is that the surface currently has no ceiling of its own at all.

### S41 - DONE - MEDIUM: `ai_usage` cannot answer its own question for the gate's calls

The same missing context means every moderation row in `ai_usage` carries `user_id: null` **and**
`subject: null`. The schema says the column exists for exactly this (`schema.ts:1765-1768`):

> ACCOUNTABILITY. An AI layer over HR data has to be able to answer "what was sent to a model, by whom, about
> what" a year later. So the row records the FEATURE, the caller, and the subject it concerned.

For the highest-volume generative feature in the app it records the feature and nothing else. "Which posts were
read by a model, and whose were they" has no answer, and "who spent the budget today" has no answer either -
which is the question somebody will ask the moment S40 happens.

`subject` is free to add and carries no behavioural risk: `subject: \`${c.collection}/${c.recordId}\`` at both
call sites. It is also what makes S19's purge sweep able to find the usage rows belonging to a deleted record.

`userId` is the one that needs the care above - it changes the rate-limit path, so add it **with** the HTTP
budget, or add an explicit `limits: { perUserHourlyGenerations: Infinity }` on the gate's context so the row is
attributed without the refusal changing, and let the HTTP layer do the limiting.

---

## Pass 16 - a feature whose own file computes the reason it cannot work

### S42 - DONE - HIGH: `attention.summary` is a generation per person per dashboard load, and the file says so

`attentionFor` (`services/attention.ts:68`) ends:

```ts
const items = rankAttention(found).slice(0, cfg.limit);
const summary = await summarise(deps, user, items);
```

`summarise` is unconditional - every dashboard load, for every person, whenever the list has two or more items
and the switch is on. The dashboard is the app's highest-traffic page.

Sixty lines further down, the same file refuses the cron version of the same feature, and does the arithmetic
to explain why (`:129-132`):

> NO MODEL, AND THAT IS ARITHMETIC RATHER THAN CAUTION. The dashboard's one-line summary costs a generation,
> which `ESTIMATED_NEURONS` puts at about 120. **A hundred people is 12,000 against a daily ceiling of 7,000** -
> so a per-person written digest cannot fit in the free allocation at any company worth sending one to, and the
> version that fits is the one that does not ask.

That paragraph is a correct argument against the feature it sits in. 7,000 / 120 = **58 summaries a day**. The
weekly digest was refused for being per-person; the dashboard summary is per-person *and* more frequent.

The generation cache is the only thing standing between this and the ceiling, and it is weaker than it looks:
the key includes the item list, and the "Needs you" list is built from `goalPace` and `staleDays`, which move
as dates pass. An active person's list changes most days, so the steady state is closer to one generation per
person per day than one per week. Day one of switching the feature on is one generation per person, full stop.

Past 58, the failures are silent and unequal: whoever loads their dashboard first gets a sentence, everyone
after gets `budget` and `summarise` returns `undefined`, which renders as no summary at all. Nobody is told the
feature ran out; it simply works for the early risers.

And it is the third switch that can stop the noticeboard working, by the chain in S36 and S40: budget spent ->
`moderationGate` gets `budget` -> `"stopped"` -> `holdPost` -> every post held for the rest of the UTC day.

**`attention.summary`, `search.semantic` and `moderation` cannot all be on in the same org** at the free
allocation, and nothing in the product, the settings screen or `docs/deploy-ai.md` says so. The runbook's advice
to "turn on one at a time - the ledger in step 6 is much easier to read that way" is about legibility, not about
the three of them competing for one ceiling.

What would make it fit, in rough order of how much it changes:

- Make the summary an explicit gesture rather than part of the page load - a "what should I look at first"
  button, like `boards:narrate` and the team report already are. Both of those are per-press; this is the only
  narration on a load path.
- Or key the cache per person per day rather than per item list, so the list drifting does not re-spend.
- Either way, the interactive reservation from S36 is what stops one feature's load path silently eating the
  gate's budget.

The honest interim is what the runbook already implies but does not state: with `moderation` on, leave
`attention.summary` off.

---

## Coverage

Every file that touches `deps.ai` or `deps.vectors` has been read (17 services, verified by grep), plus
`lib/ai.ts`, `lib/aiLocal.ts`, `lib/vector.ts`, `lib/vectorLocal.ts`, `ports/index.ts`, `deps.ts`, `env.ts`,
`cron.ts`, the six AI domain files (`aiPolicy`, `aiDraft`, `moderation`, `conduct`, `narrate`, `goalMeasure`,
`resumeFields`, `receiptFields`), the routes and middleware that mount or gate them (`aiDraft`, `moderation`,
`tableFields`, `settings`, `rateLimit`, `decodeWireIds`, `authz`'s scope maps), the seven AI web components and
the three pages that host them, `docs/deploy-ai.md`, `openapi.yaml`, and the AI test files.

Checked and confirmed NOT AI features despite the name: `services/dashboardSummary.ts`,
`services/approvalsSummary.ts`, `domain/payrollNarrate.ts`, `web/src/lib/calibrationNote.ts`,
`domain/reviewEvidence.ts` - all deterministic, and the last three say why.

---

## Pass 17 - the author's recourse, and the edit that is never re-checked

### Correction to S34 and S35: the author is not completely without recourse

Both findings say a stranded held post cannot be recovered. That is true of every UI surface and of every read
path, and it is **not** true of the write paths, by design. `services/crud.ts:172-183`:

> A post the gate is holding answers NOT FOUND, not 403 ... **The WRITE paths reach their rows through their
> own reads, not this one, so an author can still edit and delete what they wrote while it waits.**

`updateAnnouncement:417` and `updateSuggestion` both do their own `select ... where uuid = ?` with no held
check, so a `PATCH` or `DELETE` against a held row is accepted.

The qualification is that nothing hands the author the id. The row is absent from every list (`notHeld` in
`crud.ts:211` and the three hand-written lists), a `GET` of it answers 404, and the composer's own copy of the
id is gone on the next page load. So the recourse exists at the API and has no route through the product after
a refresh. For S34 and S35, read "nothing in the app can recover it; a caller who kept the id can delete it".

That distinction matters for the sweeper in S34: the goal is not to make recovery *possible* - it already is -
but to make it reachable by the person whose post it is.

### S43 - DONE - MEDIUM: editing a held announcement never re-examines it, so the one recourse that is preserved does not work

`updateAnnouncement:497`:

```ts
const gated = row.published && (await moderationGateOn(deps));
if (gated) set.heldAt = deps.clock.now();
```

A held announcement is **by construction unpublished** - `createAnnouncement:243` writes
`published: published && !gated`, and the gate's whole design is that release runs through the publish verb. So
`row.published` is false for exactly the posts that are waiting, `gated` is false, and the edit:

- does not refresh `held_at` (it was already set),
- does not call `moderationGate`,
- and falls to `if (!gated) await scanSoon(...)`, which is dead (S2).

The author does the one thing the design preserved for them - rewrite the sentence that got their post held -
and **nothing looks at it**. The post stays held, the flag on the moderator's queue still quotes the old text,
and `edited_since_flag` lights up to tell the moderator the quote is stale. The only thing that would re-examine
it is `:publish`, which is S1's bypass, or the cron drain, which never sees it (announcements are filtered on
`published`).

Suggestions behave the opposite way and are also wrong. `updateSuggestion:185` has no `row.published` term
(suggestions have no such column), so **every** edit re-gates - which is right, and is also the S1 variant where
a no-op edit to a held suggestion releases it on an unchanged hash.

So the two walls disagree about the same question:

| | edit a held post | result |
|---|---|---|
| announcements | gate never runs | held for ever, however it is rewritten |
| suggestions | gate always runs | re-checked correctly, but an unchanged hash releases it (S1) |

The fix is the same predicate on both, and it is not `published`: **gate an edit whenever the row is held or
public**, i.e. `row.published || row.heldAt`. Combined with the S1 fix (an `"unchanged"` outcome on a flagged
candidate does not clear the hold) that gives the behaviour the design describes: rewriting a held post gets it
re-read, a genuine fix releases it, and a cosmetic edit does not.

This is the mirror image of S1. S1 is the gate clearing a hold it should not; S43 is the gate never running
when it should. Both come from the same place - the gate's trigger condition is written in terms of
`published`, which is the column the hold deliberately suppresses.

### Verification note for S1

S1 is traced statically, but an existing passing test proves the mechanism it depends on.
`test/moderation.test.ts:818` holds a post (scan row stamped `flagged: true`), then calls `decideModeration`
-> `releasePost` -> `setPublished`, and asserts:

```ts
expect(post?.heldAt).toBeNull();
expect(post?.published).toBe(true);
```

That publish happens **through `moderationGate`**, on a candidate whose last verdict was a flag, via the
`"unchanged"` branch. The branch demonstrably clears the hold and lets the post out. S1 is the same code path
reached by `POST /v1/announcements/<id>:publish` instead of by a moderator's dismissal - and nothing between
the two knows which caller it is serving. That is exactly why S35 has to be fixed first (pass 14): the fix for
one is the bug for the other until `releasePost` stops going through the gate.

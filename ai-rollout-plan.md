# AI layer: where it stands, and what turning it on takes

Companion to `ai-plan.md`, which holds the design and the reasoning behind it. This file is the state of the
work and the route from here to something running. Read `ai-plan.md` for why the layer is shaped the way it
is; read this to find out what exists, what is decided, and what is left.

Last verified with `npm run verify`: spectral, eslint, three tsc projects, **3822 tests across 304 files, 0
failures**.

## The one thing to know first

**No real model call has ever been made.** Every test drives a deterministic fake. The layer is complete,
internally consistent and covered, and it has never spoken to Workers AI. Three things are therefore unknown
rather than verified:

- **Prompt quality.** Nobody has seen what `@cf/meta/llama-3.1-8b-instruct-fast` actually returns for these
  prompts. The extraction parser is strict, so a model that formats differently is rejected cleanly rather
  than corrupting a record, but it could reject often enough to make the feature useless.
- **Real neuron costs.** `BUDGET` in `src/domain/aiPolicy.ts` still holds deliberately pessimistic guesses.
  The `ai_usage` table exists precisely to replace them with measurements and has no rows yet.
- **Vectorize.** The index is configured in `wrangler.toml` and does not exist in the account.

The next step that changes the most is a single real end-to-end smoke. That converts "tests pass" into "it
works", and it is the cheapest way to learn whether the prompts and the estimates survive contact.

## What is built

| Phase | Feature | The property it is built around |
|---|---|---|
| 0 | Policy spine, budget/cache/ledger, transports, settings | Model allowlist refuses by shape and by membership, so a prompt cannot leave Cloudflare's network through an edit that reads as a model upgrade |
| 1 | Semantic search | Ids come back from the index; the ROWS are re-read under the identical `applyScope` predicate the FTS query uses |
| 2 | Ticket triage and duplicates | No generation at all. A vector lookup and a majority vote, so it is explainable and nearly free |
| 3 | Drafting, 4 kinds, all wired | The prompt is the fixed instruction plus what the caller typed. No record is read, so there is no retrieval step to leak through |
| 4a | Resume extraction, with a per-field org setting | One named exception to the `candidates` denylist. The model transcribes; it does not judge |
| 5 | Natural language to a grid spec | The catalogue is a closed set, so an invented field key matches nothing and is reported rather than rendered |
| 6 | Narrated team analytics | Detection is arithmetic. The model is handed movements already found, and a sentence containing a number that was not in them is discarded |
| 3 | Moderation queue for the public walls | The model can only add a queue item. Hiding a post is a separate act by a person, through a capability nobody holds by default, and it is reversible |

### Where things live

- `src/domain/aiPolicy.ts` - the spine: model allowlist, `NEVER_TO_MODEL`, `INDEXABLE`, `CONSENTED_PATHS`,
  prompt fencing, the PII scrubs, budget constants, feature flags.
- `src/domain/aiDraft.ts` - every drafting prompt, in one list, so the whole set can be read at once.
- `src/domain/resumeFields.ts` - which CV fields may be extracted, and the org's choice among them.
- `src/services/ai.ts` - budget, cache, ledger, refusals. Everything goes through here.
- `src/lib/ai.ts`, `src/lib/vector.ts` - the two transports. The only files that call the bindings.
- `src/services/searchEmbed.ts` - the reconciling drain.
- `src/services/globalSearch.ts` - hybrid retrieval and RRF fusion.
- `src/services/ticketTriage.ts`, `src/services/aiDraft.ts`, `src/services/resumeExtract.ts` - the features.
- `src/domain/moderation.ts` - what may be scanned, the hazard taxonomy, and the strict verdict parse.
- `src/services/moderation.ts` - the scan drain, the queue, and the only code that hides anything.
- `web/src/pages/Moderation.tsx` - the moderator's queue.
- `web/src/components/common/WhatChanged.tsx` - the period-on-period panel on the team report.
- `web/src/components/common/AiSettingsTab.tsx` - the org's controls.

## Decisions already taken

Recorded so they are not re-litigated by accident, and so the ones that can change are visible.

1. **Data residency: no commitment exists, so unpinned inference is acceptable.** Confirmed with the
   business. This is a fact about the organisation, not the code, and a customer contract or enterprise DPA
   can change it without anyone touching this repository. If it changes, the levers are Data Localization
   Suite (paid) or the feature flags. See the Privacy section of `ai-plan.md`.
2. **Vectors live in Vectorize, not D1.** The original plan argued for D1; that was wrong. A brute-force
   cosine scan reads every vector in the caller's collections per query, which reintroduces exactly the
   fan-out read cost that `search_docs` exists to avoid.
3. **Candidate ranking is not built.** Extraction transcribes a document; ranking forms a judgement about a
   person for a hiring decision. It collides with the out-of-scope line in `ai-plan.md`, and candidate
   ranking is Annex III high risk under the EU AI Act. A test asserts `CONSENTED_PATHS` has exactly one
   entry, so adding it is a visible diff rather than a quiet extension.
4. **Every feature defaults to off.** Binding Workers AI is an operator's act; deciding that this
   organisation's text may be read by a model is a different decision belonging to whoever is accountable for
   the employee data.
5. **Suggestions are never applied automatically.** Accepting a triage suggestion calls the ticket's own
   `:route` / `:prioritize`; accepting an extracted field is an ordinary candidate PATCH. There is no second
   write path anywhere in the layer.
6. **AI Gateway payload logging is suppressed on every call**, whether or not a gateway is configured, so
   turning one on later cannot quietly start retaining prompts.
7. **A moderator may hide or dismiss, and nothing else.** Hiding uses the column the host collection already
   uses to withdraw a post - `disabled` for an announcement, the soft-delete stamp for a suggestion - so it is
   reversible, and the author is notified. There is deliberately no delete: an unrecoverable removal is a
   different authority from moderation, and nobody should acquire it by being handed a queue.
8. **The moderation queue is not narrowed per holder.** It quotes flagged posts in full to anyone with the
   capability, because moderating is an org-wide job and a queue scoped to each moderator's other grants would
   make coverage depend on something unrelated. That makes the capability the whole of the access decision,
   which is why nothing seeds it - only super holds it until an org names a moderator through the ACL.
9. **An anonymous suggestion stays anonymous on the queue.** The wall's promise is to the reader as much as to
   the submitter, and a moderation surface that resolved the name would make it "anonymous unless somebody
   complains about you". The author is still notified when their post comes down.

## Turning it on

In order. Nothing before step 4 has any user-visible effect.

1. **Create the index.** Dimensions and metric must match the embedding model; changing either later means
   rebuilding it, because vectors from two models are not comparable.
   ```bash
   wrangler vectorize create hrms-search --dimensions=384 --metric=cosine
   ```
   ```bash
   wrangler vectorize create-metadata-index hrms-search --property-name=collection --type=string
   ```
   The metadata index is required for the collection pre-filter in `src/lib/vector.ts`. It is the only
   metadata stored, so the index cannot be read as a staff directory.

2. **Decide what staging does.** It shares production's 10,000 neuron/day account allocation, and it must not
   share the index. Either create `hrms-search-staging` or remove the `[[env.staging.vectorize]]` block and
   let staging exercise the non-AI fallback paths, which is the more useful rehearsal of the two.

3. **Apply the migration and deploy.** The single squashed migration adds `ai_usage`, `ai_cache`,
   `ai_suggestions`, `search_vectors` and `moderation_scans`. It has never been applied to a real D1, local
   or remote.

4. **Turn features on** in Settings, Access and security, AI features. Start with one.

5. **Read `ai_usage`** after a day of real traffic and retune `BUDGET` from measurements rather than from the
   guesses in the file.

### Expect on first run

- The embed drain backfills over several five-minute ticks, bounded by `BUDGET.embedsPerDrain` and the daily
  ceiling. Semantic search returns nothing useful until it has caught up. This is the designed behaviour, not
  a fault.
- Ticket triage needs resolved tickets to learn from. On a fresh database it correctly suggests nothing.

## What is left

Everything below this line is outstanding. Everything above it is built: search, triage, drafting,
extraction, narration, the table assist, moderation and suggestion clustering, across `656fe79`, `31cb586`,
`04d1257`, `2a8669b`, `9d750cb`, `6624a82` and the working tree. `npm run verify` passes: 3851 tests across
306 files, and both AI e2e specs are green.

**Every feature in the plan is now built, covered and reachable from the UI.** Sections 3 and 5 below are
kept for their reasoning, marked DONE. What actually remains is one thing that cannot be done from inside the
repository, and two that cannot be done until it has been.

Ordered by value against risk.

### 1. A real end-to-end smoke (do this first, and it needs a decision)

Not a feature, and the only item here that cannot be done from inside the repository: it creates a Vectorize
index in the Cloudflare account and deploys. **That is somebody's call to make, not something to run because
it is next on a list.**

Bind the account, create the index, run one draft, one search and one extraction against the live model, and
look at what comes back. Record the real neuron cost per call. Everything below is worth more once this has
happened, and any of it may need reworking if the prompts disappoint.

### 2. E2E coverage of the features themselves

`e2e/aiFeatures.spec.ts` covers all three states in one file - off, on, and on with a model answering. They
are one file because the switches are one org-wide settings row and Playwright runs different FILES in
parallel: split across three, the "absent" and "present" assertions read and wrote that row from two workers
at once, raced, and passed on retry.

The OFF describe is the half that matters for a default deployment, and the half the unit suite structurally
cannot reach: search still finds records through the keyword index, and no AI affordance renders anywhere.
**What makes it true is the settings, not a missing binding** - `wrangler dev` honours `[ai]`, so the lane
has always had a live one.

Those tests assert ABSENCE plus CONTINUITY, and every absence half was checked for vacuity: the gate was
temporarily removed, the spec was confirmed to fail, and the gate was put back. An absence assertion that has
never been seen to fail is not evidence of anything.

The fourth test is the other shape, and the only AI-layer feature that can be covered in a browser today:
the team report's period comparison is SUPPOSED to render with no model, so it asserts that the panel
resolves and shows its figures, and that the "written by AI" credit is absent. Its absence half was
vacuity-checked the same way - forcing the credit to render made it fail on `Expected: 0, Received: 1`.

`e2e/moderationQueue.spec.ts` covers the other thing a browser can reach without a model: that the queue is
PRIVATE BY DEFAULT in a running app. A super is offered it and can open it; an employee holds neither
`moderation.read` nor `moderation.decide`, is not shown the nav item, and is refused 403 by the endpoint
directly - the nav being a courtesy and the middleware being the control. A super naming a post that was
never flagged gets 404, so the capability is to act on the queue rather than to take down any post by name.

That spec states its own limit in its header: a flag is written by the drain, the drain needs a guard model,
and this stack has none - so the queue is empty in every run and rendering a flag cannot be covered here. It
carries a positive control (the super DOES see the nav item) so the employee's absence assertion is a
contrast rather than a test that would pass if the nav item existed for nobody.

Features actually doing their job no longer wait on the smoke. `AI_LOCAL_URL` (`src/lib/aiLocal.ts`) points
the whole layer at a model on the developer's machine, and `src/deps.ts` prefers it over the bindings, so a
local run reaches Workers AI through no code path at all. The last describe of `aiFeatures.spec.ts` presses
the buttons, and `test/aiLocalIntegration.test.ts` drives the drains and the parsers against a real model -
both skipping when Ollama is down, so a green run does not mean they ran. Setup and the full account of what
a local pass proves are in `docs/04-testing.md`.

The extraction panel and semantic search are now covered in a browser too, the latter with its own vacuity
control (same record, same wordless query, feature off, nothing found). `runCron` drives the five-minute tick
so a spec can create a record, embed it and search for it in one test.

Still uncovered in a browser, both for stated reasons rather than oversight: **the triage panel**, which
needs a corpus of resolved tickets in one department to vote from before it suggests anything, so a spec
would be building the fixture it tests; and **a flag rendering on the moderation queue**, which needs a model
to judge content unacceptable - and a local model is not Llama Guard, so asserting on its verdict would claim
precisely what the local lane refuses to claim.

Note that `e2e/ticketTriage.spec.ts` is NOT this. It predates the AI layer and covers the manual assign /
route / prioritize controls; the AI suggestion panel above them has no browser coverage at all.

House rules in `docs/04-testing.md`; run only the named specs, never the full suite.

### 3. The narration UI, built findings-first (DONE, `2a8669b` - kept here for the reasoning)

`web/src/components/common/WhatChanged.tsx`, on the team report above the measures table.

The concern that held this back was designing a panel around prose nobody has read. It is answered by
inverting what the panel is about: `narrateAnalytics` returns the FINDINGS alongside the text and falls back
to a deterministic summary when the feature is off, so the panel is a period-on-period comparison first and
the written paragraph is added to it. The movements render either way; the paragraph appears only when
`source` comes back `model`, badged as written by AI. With the feature off there is no AI control on the
panel to hide, which is the hide-never-disable rule satisfied by there being nothing to disable.

It therefore does not wait on the smoke. What the smoke still decides is whether the paragraph is worth
keeping, and that is now a judgement about one element of a panel that is useful without it.

Lazy behind an explicit open, because narrating runs the whole report a second time over the preceding
window. Keyed on the window, so changing the dates collapses it rather than leaving a stale comparison up.

### 4. Retune the budget from evidence

`BUDGET` in `src/domain/aiPolicy.ts` holds pessimistic guesses, and `ai_usage` exists to replace them. After
a day of real traffic, read the table and set the ceilings from what calls actually cost. Until then the app
is deliberately under-spending, which is the safe direction but not the right number.

Two constants worth revisiting at the same time, both currently guesses:
- `SEMANTIC_WHEN_KEYWORD_UNDER` (8) in `globalSearch.ts` - how thin a keyword result has to be before the
  semantic half is worth an embed.
- `MIN_CHANGE_PCT` / `MIN_ABSOLUTE` in `domain/narrate.ts` - how much a measure has to move to be worth a
  sentence. Too low and the narration talks about noise; too high and it says nothing on a week that mattered.

### 5. Suggestion-box clustering (DONE - kept here for the reasoning)

`suggestions:similar` plus `SimilarAsks` on the respond dialog, above the existing merge picker rather than
instead of it. The same primitive as ticket duplicates: neighbours of an embedding the search drain already
made, no generation. It answers the thing that made the upvote count dishonest - one idea in seven wordings
reads as seven weak asks.

Two thresholds differ from the ticket version deliberately. It only offers neighbours a good deal closer,
because this feeds a MERGE that rewrites somebody's suggestion and moves their votes, so a false neighbour
costs more than a wrong duplicate hint on a ticket. And it carries NO submitter for any neighbour, signed or
anonymous: a "who else asked for this" feature is a different feature, and on a box that offers anonymity it
would break a promise for the rows that used it.

### Designed in `ai-plan.md`, not scheduled above

Both are Phase 4 in the plan, neither is built, and neither belongs in the ordered list until something is
decided about it.

- **Requisition matching** - embed the job description and every application, rank by similarity. The plan
  frames it as a ranking aid and explicitly not a filter. **That collides with decision 3 above**, which says
  candidate ranking is not built because it is Annex III high risk under the EU AI Act, and holds the line
  with a test pinning `CONSENTED_PATHS` to one entry. Advisory ranking is still ranking, so the two cannot
  both be acted on. Decision 3 is the later position and the one citing law; it stands until somebody rules
  otherwise, and this line exists so the ruling is made once rather than rediscovered.
- **Interview note summarisation**, optionally with `@cf/openai/whisper` over an uploaded recording. No
  conflict with anything, cost is per interview rather than per query, and it is ordinary Phase 3 drafting
  work pointed at a different record. Worth doing once the smoke has shown what the prompts return.

### Deliberately not scheduled

- **Candidate ranking**, per decision 3 above. Unblocked whenever somebody decides to take it on.
- **Free-text chat over the whole database.** The retrieval scope is the caller's scope, and proving that for
  an open-ended prompt is much harder than proving it for a search box. Reconsider once Phase 1's scoped
  retrieval has been running and audited.
- **Autonomous workflow actions from model output.** The automation engine may take AI enrichment as data for
  its rules, never as a decision the rules obey.

## Known gaps and risks

- **The migration applies cleanly from scratch, but not yet through wrangler.** The squashed
  `0000_clammy_doorman.sql` was run into an empty SQLite database: 128 tables, 492 indexes and 534 triggers,
  with `integrity_check` and `foreign_key_check` both clean and `ai_usage`, `ai_cache`, `ai_suggestions`,
  `search_vectors` and `moderation_scans` all present. D1 is SQLite, so the DDL itself is proven. What is
  still unexercised is `wrangler d1 migrations apply` against a real D1 and its migration bookkeeping.

  `npm run db:migrate:local` cannot show this on a machine that already has a local database: the squash
  rule means 0000 is regenerated under a new name each time, so wrangler offers to apply it to a database
  that already holds the tables and stops on `table access_rules already exists`. Testing the apply path
  needs a local D1 that has been reset first.

- **Vectorize has no local emulation.** `wrangler` says so on every test run: index bindings do not work in
  local development, and the suggested `remote: true` means the real index. Nothing local - the test suite,
  `wrangler dev`, the e2e stack - can exercise semantic search or triage against a real vector store, which
  is why the fake is the only coverage those two have and why the smoke is the only thing that can change
  that.
- **Committing needs the sandbox off.** The husky pre-commit runs the whole of `npm run verify`, and the
  test gate binds a port and writes a wrangler log - both refused inside the agent sandbox, which fails the
  commit with an `EPERM` that looks like a test failure and is not one.
- **Moderation has never seen a real guard model.** `parseVerdict` is strict, so a model that answers in prose
  is discarded rather than flagging on a sentence nobody parsed - but whether Llama Guard's workplace
  false-positive rate makes the queue useful or unusable is exactly the sort of thing only the smoke answers.
  If it objects to half the kudos wall, the feature is a nuisance rather than a safeguard, and the thing to
  tune is which hazard codes are worth queueing rather than the prompt.
- **The `ai` settings blob is broadly readable**, like every other settings key. That is what lets the client
  decide whether to offer an AI affordance without a second endpoint. It means any signed-in caller can see
  which AI features the org has enabled and the neuron ceilings, which is configuration rather than data -
  but it is a deliberate position, not an oversight.
- **Drafting reads no records, which is a cost as well as a property.** The suggestion-response draft does not
  see the suggestion, so the responder has to put the substance in the instruction. If that proves annoying
  in use, sending the suggestion body is a deliberate decision to take, not a tweak to slip in.
- **`summary` and `years_experience` from an extraction have no candidate column to land in.** They display
  for the recruiter to read and copy. Giving them a home means a schema decision nobody has made yet.
- **The semantic half is skipped when the keyword half returns 8 or more hits.** This keeps a search box that
  fires as you type from spending the daily allocation, at the cost of a semantically better row sometimes
  not surfacing on a query that already looks answered. Revisit once the real per-query cost is known.

## The properties worth not breaking

If a later change has to be judged quickly, these are the ones that matter.

1. **Authz is upstream of AI, never downstream.** Nothing reaches a prompt that the caller could not have read
   through the API, and vector hits are re-decided in SQL under the same predicate the ordinary list uses.
2. **`NEVER_TO_MODEL` is derived from the existing `AUDIT` policy.** Marking a collection sensitive in future
   closes the AI door at the same time. A test holds the derivation.
3. **Model output is parsed into a fixed shape and can only become a suggestion a human accepts.** A model
   that decides to follow an injected instruction still cannot act, because nothing it emits is wired to a
   write.
4. **Every feature degrades to its non-AI self.** No binding, no budget, no flag, a model error: the app is
   never worse than it was before the layer existed.
5. **The trail records a hash, never the input.** Storing prompts would rebuild, inside our own database, the
   retained copy of salary and review text that the gateway suppression exists to prevent.
6. **An affordance is hidden when its feature is off, not disabled.** Gating lives inside each component
   (`useAiFeature`), so a page that adds one cannot forget it. This is the rule the layer broke once already:
   every AI control rendered regardless, and pressing one explained that it did not work.

## If you only do one thing next

Run the smoke. Every phase in the table above is complete, covered and committed, and **not one of them has
ever spoken to a real model**. What is left on the list - the browser coverage, the budget numbers, the
clustering - is better designed after seeing what the models actually return, and some of what is already
built may not survive the seeing.

Moderation is the sharpest case and worth naming: its machinery is proven against a fake, but a guard model's
false-positive rate on workplace kudos is not a thing anybody can reason their way to. One afternoon of real
verdicts decides whether it ships enabled, ships with a narrower set of hazard codes, or does not ship.

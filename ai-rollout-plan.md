# AI layer: where it stands, and what turning it on takes

Companion to `ai-plan.md`, which holds the design and the reasoning behind it. This file is the state of the
work and the route from here to something running. Read `ai-plan.md` for why the layer is shaped the way it
is; read this to find out what exists, what is decided, and what is left.

Last verified with `npm run verify`: spectral, eslint, three tsc projects, **3764 tests across 301 files, 0
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
   `ai_suggestions` and `search_vectors`. It has never been applied to a real D1, local or remote.

4. **Turn features on** in Settings, Access and security, AI features. Start with one.

5. **Read `ai_usage`** after a day of real traffic and retune `BUDGET` from measurements rather than from the
   guesses in the file.

### Expect on first run

- The embed drain backfills over several five-minute ticks, bounded by `BUDGET.embedsPerDrain` and the daily
  ceiling. Semantic search returns nothing useful until it has caught up. This is the designed behaviour, not
  a fault.
- Ticket triage needs resolved tickets to learn from. On a fresh database it correctly suggests nothing.

## What is left to build

Ordered by value against risk.

### 1. A real end-to-end smoke (do this first)

Not a feature. Bind the account, create the index, run one draft, one search and one extraction against the
live model, and look at what comes back. Record the real neuron cost per call. Everything below is worth more
once this has happened, and any of it may need reworking if the prompts disappoint.

### 2. Moderation

`@cf/meta/llama-guard-3-8b` on content that posts publicly. Flag rather than block, which means it needs a
moderator queue to be worth anything. That queue is the real work; the model call is the small part.

### 3. E2E coverage

No browser spec drives any AI feature. The unit suite covers the logic with fakes; nothing exercises the UI
paths. Candidates: the search box with the flag on and off, the triage panel, a draft round trip, the
extraction panel, and creating a table from a description. Note the house rules in `docs/04-testing.md` and
run only the named specs, never the full suite.

### 4. The narration has no UI yet

`people-analytics:narrate` is built, tested and specified, and nothing calls it. The team report page is
where it belongs, above the measures table. Small, and worth doing once the real smoke has shown what the
prose actually reads like - wiring it first would mean designing around output nobody has seen.

### Deliberately not scheduled

- **Candidate ranking**, per decision 3 above. Unblocked whenever somebody decides to take it on.
- **Free-text chat over the whole database.** The retrieval scope is the caller's scope, and proving that for
  an open-ended prompt is much harder than proving it for a search box. Reconsider once Phase 1's scoped
  retrieval has been running and audited.
- **Autonomous workflow actions from model output.** The automation engine may take AI enrichment as data for
  its rules, never as a decision the rules obey.

## Known gaps and risks

- **The migration is untested against a real D1.** `npm run db:migrate:local` has not been run against these
  tables.
- **Everything is uncommitted.** The working tree also carries in-flight table-builder work that predates
  this effort; the AI work should be committed as its own set rather than swept up with it.
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

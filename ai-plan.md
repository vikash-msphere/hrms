# AI plan: Workers AI on the free allocation

What "smart" means for this app, what Cloudflare gives away for nothing, and the order to build it in.

## The constraint first, because it decides the design

Cloudflare's free AI allocation is **10,000 Neurons/day**, reset daily, on both the Free and the Paid
Workers plan. Paid plans bill overflow (order of a cent per 1,000 neurons); the Free plan simply refuses
requests once the allocation is spent. Vectorize has its own free allocation (stored and queried vector
dimensions per month) and AI Gateway - logging, caching, rate limiting in front of a model - costs nothing.
Treat every neuron figure in this document as an estimate to be replaced by measurement: the per-model
neuron table moves, and the ledger in Phase 0 exists to tell us the real number for THIS workload.

10,000 neurons/day is small for chat and large for embeddings. That single fact produces the whole shape
of the plan:

- **Embedding is the cheap primitive.** A `bge-small`/`bge-base` embed of a 200-token record is a rounding
  error against the daily allocation. Anything that can be expressed as "find the semantically near thing"
  - search, duplicate detection, candidate-to-requisition matching, ticket routing - should be, and none of
  it needs a generative model at request time.
- **Generation is the expensive primitive and belongs off the request path.** An 8B instruct model
  answering with a few hundred tokens is worth roughly a thousand embeds. So generation is: user-initiated
  and rate-limited per person (a "Draft this" button), or batched in the nightly cron, never fired
  automatically on every write.
- **The allocation is shared by the whole org.** One enthusiastic user must not be able to spend the day's
  budget before anyone else logs in. The budget ledger is a feature, not an afterthought.

## Non-negotiables

These are the rules that keep an AI layer from wrecking an HR system. They bind every feature below.

1. **AI is never a source of truth.** No model output is ever written into a payroll figure, a leave
   balance, an authz decision, an attendance record, or any field the business relies on. Model output
   lands as a *suggestion* attached to a record, with provenance (model, prompt version, timestamp, inputs
   hash) and an explicit human accept or reject. Accepting writes through the normal service, with the
   normal validation and audit trail.
2. **Authz is upstream of AI, never downstream.** Nothing goes into a prompt that the caller could not have
   read through `GET /v1/<collection>`. Vector rows carry the same `(collection, code, owner_id)` columns
   `search_docs` carries, and the same `applyScope` filters vector hits that filters FTS hits. A semantic
   search that surfaces a title the caller is not scoped to is a data breach, so the scope filter is applied
   to the candidate set, not to the rendered answer.
3. **Employee-authored text is data, never instruction.** Tickets, suggestions, announcements, resumes,
   review feedback and chat messages are attacker-controlled by construction. They go into the prompt inside
   a delimited, labelled block, the system prompt states that the block is untrusted content, and the model
   is never given a tool that writes. A model that emits `{"action":"approve_leave"}` gets its output
   discarded by the zod schema, because the schema has no such shape.
4. **Every feature degrades to its non-AI self.** Budget spent, model down, feature flag off: global search
   falls back to FTS5, ticket triage falls back to the current manual pick, the draft button disappears.
   The app must never be *worse* than it is today because an inference failed.
5. **Nothing leaves the account.** Workers AI runs on Cloudflare's network under the existing binding. No
   third-party model provider, no new egress destination (the e2e suite asserts no egress, and that stays
   true).
6. **Opt-in at the org level, visible at the record level.** A settings panel turns the AI layer on and off
   per feature, and any AI-produced text is badged as such in the UI. HR staff deserve to know which
   sentence a machine wrote.

## Privacy and security

Checked against Cloudflare's documentation rather than assumed, because the answer turned out to be better
than expected in one place and worse in another.

**The starting position is stronger than it looks.** The employee data is already in Cloudflare's custody:
D1 holds every row, R2 holds every document. Workers AI is the same processor doing a new thing with data it
already stores, not a new party gaining access. Cloudflare states that Customer Content is not used to train
models and is not retained unless the caller writes it to a storage service, and every `@cf/*` model -
including the closed-source partner models from Leonardo and Deepgram - runs on Cloudflare's own
infrastructure rather than being forwarded to the model vendor. So this is not the usual "our HR data goes to
a third-party LLM" problem.

**Four things that position does not cover**, each with its enforcement in `src/domain/aiPolicy.ts`:

1. **Routing off-platform.** The `AI` binding can proxy external providers, so a future edit that looks like
   a model upgrade could hand payroll text to a party with no contract with us. `MODELS` is an allowlist and
   `assertModelAllowed` refuses anything without the `@cf/` prefix as well as anything absent from the list -
   a shape check and a membership check, so adding an entry carelessly cannot open that door.
2. **A new copy at rest.** AI Gateway logs bodies by default; see the cache section. `ai_usage` records a
   hash of the input, never the input.
3. **Us over-sharing.** Nothing about the platform stops a prompt builder decrypting a bank account into a
   model call. `NEVER_TO_MODEL` forbids it, and it is *derived from the existing `AUDIT` policy* rather than
   hand-listed, so a collection marked sensitive in future closes this door at the same time. Money,
   assessments of people, medical and status records, outside candidates, credentials and audit trails are
   all on it. `INDEXABLE` is the opposite list and defaults to deny: a collection nobody has considered
   contributes nothing, whatever the caller may read through the API.
4. **Region. DECIDED: acceptable, because there is no residency commitment to breach.** Pinning inference to
   a country is Data Localization Suite, a paid add-on, so on the free allocation a prompt may be processed
   in any city on Cloudflare's network. This was put to the business and the answer was that msphere.io holds
   no data-residency commitment, so nothing here has to change.

   It stays written down because the answer is a fact about the organisation and not about the code, and it
   can change without anyone touching this repository - a customer contract, a tender, or an enterprise
   client's DPA can introduce a residency obligation overnight. **If one is ever taken on, re-read this
   section before it bites:** the levers are Data Localization Suite (paid) or switching the feature flags
   off, and what crosses the boundary today is org-internal working text (a ticket subject, a job
   description, an announcement draft) plus one CV at a time on a recruiter's action - never the statutory,
   financial, medical or assessment data the denylist names.

**Three further properties of the design:**

- **Embedded text is text already on screen.** The embed source is the `title` + `subtitle` that
  `search_docs` already holds, defined per collection by `domain/searchIndex.ts` and already held against
  the schema by a test. Embedding it sends nothing across the inference boundary that a directory listing
  does not already show the same caller.
- **An embedding is not a hash.** It is a lossy but partially invertible projection of its source, so the
  vector store holds derived personal data. It is therefore treated as a data store in its own right: the
  index's metadata carries the collection and nothing else - no name, no code, no owner id - so it cannot be
  read as a staff directory even by someone holding it, and its entries are removed when a row is deleted,
  becomes restricted, or its collection is taken out of `INDEXABLE`.
- **Injection is contained by wiring, not by wording.** User text is fenced and the fence delimiters are
  stripped from the content so text cannot close its own fence, but the actual guarantee is that model output
  is parsed into a fixed shape and can only ever become a suggestion a human accepts. A model that decides to
  obey a malicious ticket still cannot do anything, because nothing it emits is wired to an action.

`test/aiPolicy.test.ts` holds every name in these lists against the collection registry and the search index,
and asserts nothing is on both lists. A denylist entry with a typo matches nothing, silently, and the first
symptom would be salary text in an inference; that test is what makes the lists worth reading.

## Architecture

### Bindings

```toml
[ai]
binding = "AI"

[[vectorize]]
binding = "VEC"
index_name = "hrms-search"
```

Both repeated under `[env.staging]` with its own index name, the same way D1 and R2 are, because wrangler
does not inherit top-level bindings into a named environment.

### The port

`src/ports/index.ts` grows a `TextModel` port next to `EmailSender` and `DocumentStore`:

```ts
export interface TextModel {
  embed(texts: string[]): Promise<Float32Array[]>;
  generate(req: { system: string; user: string; maxTokens: number; json?: unknown }): Promise<string>;
}
```

`src/lib/ai.ts` implements it over the `AI` binding; `deps.ts` wires it. Tests get a deterministic fake -
embeddings from a hash of the text, generation from a fixture table - so the suite never calls a model and
stays offline.

### The budget ledger

A `ai_usage` table (internal, not a collection): one row per call with model, feature, caller, input tokens,
output tokens, estimated neurons, cache hit, latency, outcome. `src/lib/ai.ts` refuses a call when either
the org's daily budget or the caller's per-hour quota is spent, and returns a typed `AiUnavailable` that
callers turn into the non-AI fallback. This is how we learn the real neuron cost of each feature, and it is
also the throttle that stops one user eating the org's day.

Budgets live in settings so they are tunable without a deploy: a daily neuron ceiling (default well under
10,000 to leave headroom), a per-user hourly generation count, and a per-feature on/off.

### The cache

Generation is keyed by `(feature, prompt version, sha256 of inputs)` and cached in D1. A summary of a review
cycle that nobody edited costs one inference forever.

AI Gateway can sit in front of the binding for a second cache layer and per-model analytics, but **not on its
defaults**: it stores request and response bodies by default, which would put salary and review text into a
third retained surface with its own lifetime and its own deletion story. If it is used at all, every call
carries `cf-aig-collect-log-payload: false`, set once in `lib/ai.ts` rather than per call site. Metadata-only
logging still gives the usage picture, and `ai_usage` gives a better one because it is ours.

### The async path

The existing `jobs` table and the five-minute `drainJobs` tick are the queue. Embedding on write is enqueued,
never awaited: the user's save does not wait on an inference, and a model outage delays the index rather than
failing the write. Batch generation (digests, cycle summaries) runs in the nightly 02:00 dispatch, which is
also where the day's fresh allocation is cheapest to spend.

### The suggestion record

One new collection, `ai-suggestions`, built the only way collections get built here (`collectionRoute.ts` +
`crud.ts` + every registry in the add-collection checklist). Columns: target collection and code, feature,
payload JSON, provenance, state (`pending` / `accepted` / `rejected` / `expired`), decided-by, decided-at.
Access follows the target: you may see a suggestion about a record if you may read that record. This single
record type carries triage suggestions, extracted resume fields, draft summaries and match scores, so there
is one audit surface and one accept/reject UI pattern rather than eight.

## Features, in build order

### Phase 0: the substrate

Bindings, port, fake for tests, ledger, cache, settings panel, `ai-suggestions` collection, feature flags.
No user-visible AI. Ends with a measured neuron cost per primitive on real data, which is the number the
rest of the plan is budgeted against.

### Phase 1: semantic search (highest value per neuron)

The global search (`⌘K`) is FTS5 over `search_docs` today, so it is exact-prefix only: "person who handles
laptops" finds nothing, "maternity" does not find "parental leave".

**Vectors live in Vectorize, not D1.** The original draft of this plan argued the opposite - the corpus is
small, so keep it in one datastore. That was wrong, and the reason is the same one that produced the FTS
index in the first place. A brute-force cosine scan has to read every vector in the caller's collections on
every query; at 384 dimensions that is tens of megabytes of D1 reads per keystroke, and D1 bills rows read.
It would reintroduce precisely the `LIKE '%q%'` fan-out cost that `search_docs` exists to avoid. Vectorize
answers the same question as an index lookup.

**Indexing is a reconciliation, not a notification.** `search_docs` is maintained by SQL triggers, by design,
because a trigger is the only thing that sees writes from services, cron, automations, seeds and manual SQL
alike - and a trigger cannot call Vectorize. So the five-minute drain compares the two sets instead: rows
whose text hash differs from what was embedded get re-embedded, and entries whose row is gone, has become
`deleted` or `restricted`, or whose collection has left `INDEXABLE` get removed. That also makes the index
self-healing: a half-finished tick, a Vectorize outage, an afternoon spent out of budget, or a bulk import
that bypassed the app all converge on the next successful run.

**Retrieval is two steps, and the split is load-bearing.** Vectorize is asked only to narrow by collection.
It is never asked who may see a row, because `applyScope`'s department prefixes, owner columns and per-object
shares cannot be expressed as metadata equality, and an approximated access rule is a wrong one. The ids come
back and the rows are read from `search_docs` under the identical `or(...branches)` predicate the FTS query
uses, so a semantic hit is a row the caller's list would have returned by construction rather than by a
second implementation kept in agreement. The two ranked lists are then fused with reciprocal rank fusion -
ranks, not scores, because BM25 and cosine similarity are not commensurable - with the keyword half weighted
higher, since someone typing into a search box usually means the characters they typed.

**Every failure returns the keyword result.** No binding, no budget, a model error, an index outage, an empty
index: `semanticHits` returns `[]` and the caller keeps the search this app has always had.

Cost: one embed per changed record plus one per query. This is the feature the allocation was made for.

### Phase 2: ticket triage and duplicate detection

Tickets already have a servicing department distinct from requester-department authz, and somebody picks it
by hand. On create:

- Nearest-neighbour the new ticket against resolved tickets to suggest servicing department, category and
  priority, with the three nearest resolved tickets shown as the reason. No generation: it is a vector
  lookup plus a majority vote over the neighbours' fields, which means it is explainable and free.
- Surface likely duplicates above a similarity threshold, so the agent merges rather than works both.
- Same primitive, no extra code, applied to the suggestion box: "seven people have asked for this" is a
  clustering job, and it makes the upvote count honest.

Suggestions land on the ticket as `ai-suggestions` rows; accepting sets the field through the normal service.

### Phase 3: assisted drafting

A "Draft" / "Improve" affordance on the long-form text fields that already exist: announcements, job
descriptions on requisitions, goal and check-in descriptions, letter body blocks, a response to a suggestion.
User-initiated, rate-limited per person, output lands in the editor as editable text that the user must save.
Nothing is written without a human pressing save, which makes this the cheapest feature to get right.

Also here: `@cf/meta/llama-guard-3-8b` as an optional moderation pass on content that posts publicly (kudos,
announcements, the suggestion wall), flagging rather than blocking, because a false positive that silently
eats someone's post is worse than a moderator queue.

### Phase 4: ATS intelligence

The highest manual-labour reduction in the app.

- **Resume extraction.** Candidate attachment in R2, text extracted by the existing PDF path, one constrained
  generation returning a zod-validated JSON of name, contact, years of experience, skills, last employer.
  Fields land as a suggestion for the recruiter to accept field by field, never written blind.
- **Requisition matching.** Embed the job description and every application; rank applications by similarity
  with the contributing skill overlap shown. A ranking aid, explicitly not a filter: no application is ever
  auto-rejected, and the ranking is advisory metadata, not a state transition. This boundary is deliberate
  and non-negotiable for legal reasons as much as ethical ones.
- **Interview note summarisation**, and optionally `@cf/openai/whisper` on an uploaded interview recording,
  which is a per-interview cost and therefore affordable.

### Phase 5: natural language to a table

The table builder is a field CATALOGUE, not a query language, which makes it the safest possible target for
a model: the output space is a closed set. "Employees in Bangalore hired this year with no goals" becomes a
generation constrained to emit a table definition JSON, validated against the existing catalogue schema, and
rejected outright if it names a field that does not exist. Invalid output costs the user a retry, never a
wrong answer, and the resulting table is a normal saved table the user can inspect and edit. Same trick
applies to the global search box: a query that parses as a filter can offer "show this as a table".

### Phase 6: narrated analytics

The detection stays deterministic SQL - payroll run variance against the prior period, expense claims outside
the category's distribution, attendance patterns, goal drift - exactly as `peopleAnalytics` and the payroll
staleness check already do it. The model's only job is turning the numbers the query already found into a
sentence for the dashboard and the nightly digest. A model that cannot invent the anomaly cannot invent a
false one.

### Deliberately out of scope

- Anything that scores, ranks or flags a person for a performance, disciplinary or termination decision.
  The reviews module produces evidence for humans; a model does not get an opinion on somebody's job.
- Free-text chat over the whole database. It sounds like the headline feature and it is the one that breaks
  rule 2 the hardest: the retrieval scope is the caller's scope, and proving that for an open-ended prompt is
  much harder than proving it for a search box. Reconsider once Phase 1's scoped retrieval has been running
  and audited.
- Autonomous workflow actions driven by model output. The automation engine gets AI *enrichment* (classify
  this ticket, summarise this thread) as an action whose result is data for the rules, never as a decision
  the rules obey.

## What Phase 1 touches

- `wrangler.toml`: `[ai]` and `[[vectorize]]`, both environments.
- `src/ports/index.ts`, `src/lib/ai.ts`, `src/deps.ts`: the port, implementation and wiring.
- `src/db/schema.ts` + one squashed migration: `ai_usage`, `ai_cache`, `ai_suggestions`.
- `src/services/searchIndex` write path: enqueue embed jobs.
- `src/cron.ts`: an embed-drain subtask, counted in the run summary like every other subtask.
- `src/services/globalSearch.ts`: hybrid retrieval and fusion behind a flag, FTS path untouched as fallback.
- `src/services/settings.ts` + the settings panel: budgets and per-feature flags.
- Tests: a deterministic fake model, a scope test proving a vector hit the caller cannot read never renders,
  a budget test proving exhaustion falls back rather than errors, and an e2e that searches with the flag on
  and off.

## Open questions

- **Per-org isolation.** Is this deployment single-org, or does a shared index need a tenant dimension? The
  scope columns handle the within-org case; a multi-org index needs a namespace per org.
- **Retention.** How long do `ai_suggestions` rows survive after a decision, and does the ledger need the
  input hash at all once the cache expires? Both are privacy surface.
- **Staging budget.** Staging shares the account's daily allocation. Either give it a small fixed slice in
  settings, or point it at the fake model, so a rehearsal cannot starve production.

# Turning the AI layer on

Companion to `docs/deploy.md`, which covers deploying the app itself. Everything here is **additional** and
every step is **optional**: with none of it done the app runs exactly as it did before the AI layer existed,
which is the state it ships in. Nothing below changes behaviour for anybody until step 5.

Design and reasoning live in `ai-plan.md` and `ai-rollout-plan.md`. This file is only the doing.

**Rehearse it locally first.** `docs/04-testing.md` has a lane that points the whole AI layer at a model on
your own machine, so all eight features can be walked end to end before any of this is switched on - without
spending the account's daily allowance or writing into the live index, which is what a local run did before
that lane existed. It leaves exactly two things for the real service to answer: how the production models
behave, and how Vectorize behaves.

## Before you start: nothing is on

Two independent switches have to be thrown before any feature does anything.

1. **The bindings** (`AI`, `VEC`) - an operator's act, this document, steps 1 to 4.
2. **The org settings** - a separate decision by whoever is accountable for the employee data, step 5.

Bind without switching on and nothing happens. That is deliberate: deciding that this organisation's ticket
text and directory entries may be read by a model is not the same decision as deploying the code that could.

**`npm run preflight` does not check any of this.** It knows nothing about AI, so it will not warn you that
`VEC` is bound to an index that does not exist, or that a feature is on with no binding behind it. The checks
in step 6 are manual for that reason.

## 1. Create the Vectorize index

Only needed for semantic search, ticket triage and suggestion clustering. Drafting, CV extraction, the table
assist and narration need no index.

```bash
npx wrangler vectorize create hrms-search --dimensions=384 --metric=cosine
```

```bash
npx wrangler vectorize create-metadata-index hrms-search --property-name=collection --type=string
```

**The dimensions and metric must match the embedding model** (`@cf/baai/bge-small-en-v1.5`, 384, cosine - see
`MODELS` in `src/domain/aiPolicy.ts`). Changing either later means deleting and rebuilding the index, because
vectors from two models are not comparable and nothing will tell you they are being mixed.

The metadata index is **required**, not optional: without it the `$in` collection pre-filter in
`src/lib/vector.ts` has nothing to filter on. `collection` is the only metadata stored - no name, no code, no
owner id - so the index cannot be read as a staff directory even by somebody holding it.

## 2. Decide what staging does

Staging shares production's neuron allowance (it is one account) and **must not share the index** - the row
ids differ, so its upserts would overwrite production's entries and its searches would return rows that do
not exist there.

Either give it its own:

```bash
npx wrangler vectorize create hrms-search-staging --dimensions=384 --metric=cosine
```

```bash
npx wrangler vectorize create-metadata-index hrms-search-staging --property-name=collection --type=string
```

...or delete the `[[env.staging.vectorize]]` and `[env.staging.ai]` blocks from `wrangler.toml` and let
staging exercise the non-AI fallback paths, which is the more useful rehearsal of the two.

## 3. Optional: an AI Gateway

Set `AI_GATEWAY_ID` in `wrangler.toml` `[vars]` to route inference through a gateway for per-model analytics.

**Payload logging is suppressed on every call regardless** (`src/lib/ai.ts` sends
`cf-aig-collect-log-payload: false`), because AI Gateway stores request and response bodies by default and
that would put salary and review text in a third retained surface with its own lifetime. The gateway records
that a call happened, not what was in it. Leave it unset to call the binding directly.

## 4. Migrate and deploy

The migration adds `ai_usage`, `ai_cache`, `ai_suggestions`, `search_vectors` and `moderation_scans`.

```bash
npm run db:migrate:remote
```

```bash
npm run deploy
```

Nothing is switched on yet. At this point every AI feature still behaves as though no model were bound.

## 5. Switch features on

**Settings → Access & security → AI features.**

Eight switches, all off, each with a line saying what it does when on and what happens when off. Turn on one
at a time - the ledger in step 6 is much easier to read that way.

| Setting key | What turns on | Needs the index |
|---|---|---|
| `search.semantic` | ⌘K also matches by meaning | yes |
| `tickets.triage` | Suggested department/category/priority, duplicate hints | yes |
| `suggestions.similar` | "Others asked for this" on a suggestion | yes |
| `drafting` | Draft buttons on announcements, JDs, goals, suggestion replies | no |
| `ats.extraction` | Read a CV into the candidate form | no |
| `tables.describe` | Describe a grid in words in the table builder | no |
| `analytics.narrate` | Written summary on the team report | no |
| `moderation` | Public walls scanned, flagged posts queued | no |

Two settings on the same screen are worth a decision rather than a default:

- **Which CV fields may be extracted.** Appears once `ats.extraction` is on. `summary` and
  `years_experience` are **off by default** because they are the model doing more than copying - a summary is
  a paraphrase in the model's words that a recruiter will read as what the CV said.
- **The daily budget.** Defaults to 7000 neurons, which is 70% of Cloudflare's free 10,000/day allowance.
  It can only be lowered; a higher number does not buy more allowance and is ignored.

### Expect on first run

- **Semantic search returns nothing useful for a while.** The embed drain backfills 200 rows per five-minute
  tick, bounded by the daily budget, so a large database takes several ticks. This is designed, not a fault.
- **Ticket triage correctly suggests nothing** until there are resolved tickets to learn from.
- **Moderation only scans 8 posts per tick.** It is a generation call, unlike embedding.

## 6. Grant the capabilities that nothing seeds

Three things are deliberately ungranted, so they do nothing until somebody is given them in
**Settings → Access & security → Permissions**:

| Capability | Who needs it | Why it is not seeded |
|---|---|---|
| `moderation.read` | whoever reviews flagged posts | Moderating is an org-wide job; which role does it is your call |
| `moderation.decide` | whoever may take a post down | It removes other people's posts from a public wall |
| `suggestions.similar` + `suggestions.merge` | whoever triages the suggestion box | Merging rewrites somebody's suggestion and moves their votes |

Without `moderation.read` the queue is invisible and the nav item does not appear - so if you turn moderation
on and nobody can see the queue, this is the step you skipped.

## 7. Check it is actually working

There is no dashboard for this yet. Three direct checks:

**Is anything being spent?**

```bash
npx wrangler d1 execute hrms --remote --command "select feature, count(*) n, sum(estimated_neurons) neurons, sum(case when outcome='error' then 1 else 0 end) errors from ai_usage where created_at > unixepoch('now','-1 day')*1000 group by feature"
```

No rows means nothing has called a model: the feature is off, the binding is missing, or nothing has
triggered it. A high `errors` count is the signal to look at the Worker logs.

**Is the index filling?**

```bash
npx wrangler d1 execute hrms --remote --command "select count(*) embedded from search_vectors"
```

Compare with `select count(*) from search_docs` - it should climb towards it over successive ticks.

**Are the crons running?** `search_vectors` and moderation both ride the five-minute tick; the `ai_cache`
sweep runs nightly. `cron_runs.summary_json` records `embedded` and `moderated` counts per tick.

## 8. Retune the budget from evidence

`BUDGET` in `src/domain/aiPolicy.ts` holds deliberately pessimistic guesses - the app under-spends rather
than over-spends until somebody measures. After a day of real traffic, read `ai_usage` and set the ceilings
from what calls actually cost.

Rough per-call estimates the app currently assumes, and what a day's 7000 neurons buys if spent only on one:

| Call | Estimate | Per day |
|---|---|---|
| embed (search index, one row) | 1 | ~7,000 rows |
| moderation scan | 60 | ~116 posts |
| generation (draft, extraction, table, narration) | 120 | ~58 calls |

They share one budget, so a busy drafting day leaves less for moderation. When it runs out every feature
falls back to its non-AI behaviour until midnight UTC - nothing breaks, things just stop being clever.

## Turning it off

**One feature:** switch it off in Settings. Takes effect immediately; the affordance disappears rather than
being disabled.

**Everything, without deploying:** switch all eight off. The drains no-op, no affordance renders.

**Everything, permanently:** remove the `[ai]` and `[[vectorize]]` blocks from `wrangler.toml` and deploy.
Every feature falls back to the path it had before the layer existed - FTS search, manual routing, typed
drafts. This is covered by `e2e/aiFeatures.spec.ts`, which asserts every fallback in a browser - **with the
features switched off, not with the bindings removed**, which is a weaker thing and the file says so. Nothing
in the suite exercises a deployment that has no `[ai]` block at all.

Data left behind: `ai_usage` (a hash per call, never the input), `ai_cache` (generated text, swept nightly
after expiry), `ai_suggestions` (advisory rows), `search_vectors` and `moderation_scans` (bookkeeping). The
Vectorize index survives until deleted with `npx wrangler vectorize delete hrms-search`.

## Residency

Pinning inference to a country requires Data Localization Suite, a paid add-on. On the free allowance a
prompt may be processed in any city on Cloudflare's network. **This was checked: msphere.io holds no
data-residency commitment, so nothing here has to change.**

It is written down because that is a fact about the organisation, not about the code, and a customer contract
or an enterprise client's DPA can introduce an obligation without anyone touching this repository. If one is
ever taken on, the levers are Data Localization Suite or the feature switches, and what crosses the boundary
today is org-internal working text plus one CV at a time on a recruiter's action - never the statutory,
financial, medical or assessment data the denylist in `src/domain/aiPolicy.ts` names.

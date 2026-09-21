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

Thirteen switches, all off, each with a line saying what it does when on and what happens when off. Turn on
one at a time - the ledger in step 6 is much easier to read that way.

| Setting key | What turns on | Needs the index |
|---|---|---|
| `search.semantic` | ⌘K also matches by meaning | yes |
| `tickets.triage` | Suggested department/category/priority, duplicate hints | yes |
| `cards.triage` | On a board task: what comparable delivered work says about its filing, how long it took, what blocked it, the goal it probably serves, the steps it needs, and open tasks that look like duplicates (including the nightly sweep) | yes |
| `goals.similar` | Goals that are the same work in other words, and the goal one could roll up under | yes |
| `goals.measure` | A proposed unit, baseline and target for a goal that has none | no |
| `boards.narrate` | A paragraph over a board's analytics saying how flow moved | no |
| `suggestions.similar` | "Others asked for this" on a suggestion | yes |
| `attention.summary` | A line over the dashboard's "Needs you" list saying what to look at first | no |
| `drafting` | Draft buttons on announcements, JDs, goals, suggestion replies | no |
| `ats.extraction` | Read a CV into the candidate form | no |
| `tables.describe` | Describe a grid in words in the table builder | no |
| `analytics.narrate` | Written summary on the team report | no |
| `moderation` | A gate on the public walls: nothing is posted until a model has read it | no |
| `moderation.conduct` | The same posts read a second time against this org's conduct rules | no |

Two settings on the same screen are worth a decision rather than a default:

- **Which CV fields may be extracted.** Appears once `ats.extraction` is on. `summary` and
  `years_experience` are **off by default** because they are the model doing more than copying - a summary is
  a paraphrase in the model's words that a recruiter will read as what the CV said.
- **The daily budget.** Defaults to 7000 neurons, which is 70% of Cloudflare's free 10,000/day allowance.
  It can only be lowered; a higher number does not buy more allowance and is ignored.

### Expect on first run

- **Semantic search returns nothing useful for a while.** The embed drain backfills 200 rows per five-minute
  tick, bounded by the daily budget, so a large database takes several ticks. This is designed, not a fault.
- **Ticket triage correctly suggests nothing** until there are resolved tickets to learn from, and board task
  triage the same until cards have been delivered. Both vote from finished work only.
- **The nightly duplicate sweep examines 60 open cards a tick**, least-recently-swept first, so a large
  backlog is covered over several nights.
- **`moderation` is a GATE, not a warning.** With it on, nothing reaches a wall until a model has read it:
  a post, reply or suggestion is written invisible, checked, and only then published. There is no moment at
  which a post is both public and unread. The gate meets every route onto a wall - a new post, an edit to
  one already up, the `:publish` verb, and the tick that publishes a scheduled draft.
- **A held post is invisible at the API, not just in the UI.** It is absent from the board feed, the
  suggestion box, a thread's replies, search and a direct `GET` (which answers 404) - including for HR and
  for its own author. It appears in one place: **Flagged posts**.
- **It fails closed.** If the model is down, out of budget or answers nonsense, the post is HELD, with the
  reason `Not checked`. During an outage, posting appears not to work and the queue fills up. That is the
  deliberate trade: a gate that opens when the guard is asleep is not a gate. An org that would rather have
  the opposite failure should switch the feature off, which is an honest switch.
- **Releasing is `dismiss` on the queue.** On a held post the buttons read "Release it" / "Keep it hidden",
  and releasing sends the broadcast that was held back with it - the bell, the email and the mentions.
- **With the feature off**, nothing changes from before: posts go up unread and the cron sweep flags them
  afterwards.
- **The cron pass scans 8 posts per tick**, newest unread first. It is a generation call, unlike embedding.
  With `moderation.conduct` on, a post costs up to two calls: the guard model, then the conduct model on
  whatever the guard model passed.
- **Switching `moderation.conduct` on re-reads the whole wall.** A post already scanned by the guard model
  has not been read against the conduct rules, so every post comes back round, 8 per tick.

### What the two passes each catch

They are different questions, and running only the first is what makes the queue look broken to somebody
testing it with a rude post.

| The post | `moderation` (Llama Guard) | `moderation.conduct` |
|---|---|---|
| Threats, weapons, self-harm, sexual content, child exploitation | flags | - |
| Hate against a protected attribute | flags | also flags |
| "Bob in accounts is a useless idiot" | **safe** | flags (W1) |
| Someone's salary, illness or warning letter posted on the wall | usually safe | flags (W4) |
| "This company is run by crooks who are cooking the books" | usually safe | flags (W5) |
| Blunt criticism of a decision or a process | safe | safe, deliberately |

`moderation` is a safety classifier answering "is this content dangerous". Most of what a workplace
noticeboard needs a person for is not dangerous, which is what the second pass is for. It is a general model
reading our rubric, so it is less accurate than the first in both directions; both only ever add a queue item,
and neither can hide anything.

### Acting on a flag without waiting for the queue

A flag emits `moderation.flagged`, so what happens next is a rule in **Workflows** rather than behaviour
baked in. Two ship with the app:

| Rule | Ships | What it does |
|---|---|---|
| Tell the moderators about a flagged post | **enabled** | Notifies and emails whoever holds `moderation.read`, with the reason and a link. Touches nothing. |
| Take down a post the safety model flagged | **disabled** | Hides the post immediately, then tells the moderators it came down. |

The takedown is off by default and conditioned on `pass == "hazard"` - the guard model's fixed taxonomy -
never on a conduct flag. Turn it on only if an hour of exposure is worse for you than an occasional
wrongly-hidden post; a conduct flag is a general model's read of a tone rubric, and hiding on it will
eventually take down a post somebody merely disagreed with. The hide is reversible, the author is told, and
the flag stays on the queue to be upheld or dismissed either way.

Both rules address their audience as **whoever holds an access right** rather than a department or a list of
names, which is new in the workflow builder: the engine asks the ACL at send time, so the right people are
told after moderation moves to another role.

## 6. Grant the capabilities that nothing seeds

Three things are deliberately ungranted, so they do nothing until somebody is given them in
**Settings → Access & security → Permissions**:

| Capability | Who needs it | Why it is not seeded |
|---|---|---|
| `moderation.read` | whoever reviews flagged posts | Moderating is an org-wide job; which role does it is your call |
| `moderation.decide` | whoever may take a post down | It removes other people's posts from a public wall |
| `suggestions.similar` + `suggestions.merge` | whoever triages the suggestion box | Merging rewrites somebody's suggestion and moves their votes |

Without `moderation.read` the queue is invisible and its "Flagged posts" tab under Connect does not appear -
so if you turn moderation on and nobody can see the queue, this is the step you skipped.

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

**The queue is empty and you expected it not to be.** Read it in this order, because the three causes look
identical from the page:

```bash
npx wrangler d1 execute hrms --remote --command "select outcome, error, count(*) n from ai_usage where feature='moderation' group by 1,2 order by n desc"
```

- No rows at all: nothing called a model. The feature is off, there is no `AI` binding, or the day's budget
  was spent before the tick came round.
- Rows with `outcome='error'`: the calls are landing and failing, and `error` says how.
- All `outcome='ok'` and `select count(*) from moderation_scans where flagged=1` is 0: the models are
  answering and objecting to nothing. Check what you posted against the table in section 5 - if it is rude
  rather than dangerous, it needs `moderation.conduct`.

## 8. Retune the budget from evidence

`BUDGET` in `src/domain/aiPolicy.ts` holds deliberately pessimistic guesses - the app under-spends rather
than over-spends until somebody measures. After a day of real traffic, read `ai_usage` and set the ceilings
from what calls actually cost.

Rough per-call estimates the app currently assumes, and what a day's 7000 neurons buys if spent only on one:

| Call | Estimate | Per day |
|---|---|---|
| embed (search index, one row) | 1 | ~7,000 rows |
| moderation scan, guard pass | 60 | ~116 posts |
| moderation scan, conduct pass | 120 | ~58 posts |
| generation (draft, extraction, table, narration) | 120 | ~58 calls |

A post scanned by both passes costs 180, so ~38 posts a day on the budget alone. That is the number to watch
after switching the conduct pass on, and the reason it is a separate switch.

They share one budget, so a busy drafting day leaves less for moderation. When it runs out every feature
falls back to its non-AI behaviour until midnight UTC - nothing breaks, things just stop being clever.

## Turning it off

**One feature:** switch it off in Settings. Takes effect immediately; the affordance disappears rather than
being disabled.

**Everything, without deploying:** switch all nine off. The drains no-op, no affordance renders.

**Note that "Needs you" is not one of them.** The dashboard list is worked out from dates and progress, uses
no model, and stays exactly as it is with every switch off; `attention.summary` only adds the sentence over
it. That is the intended shape - the surface people come to rely on does not have an optional dependency.

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

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

## 3. Skip the AI Gateway

**Leave `AI_GATEWAY_ID` unset.** `src/lib/ai.ts` supports a gateway and setting the var routes inference
through one, but the deploy does not, and the reasoning is in `ai-observability-plan.md`. In short: its
analytics duplicate `ai_usage`, its cache sits behind `ai_cache` and only ever sees that cache's misses, and
it adds a second hop in front of a gate that fails closed - a wrong gateway id reads to the app as "the model
was silent", which under the default posture stops every wall accepting posts (step 5).

The per-model numbers step 8 asks for do not need it. They come from `aiInferenceAdaptiveGroups` on the
GraphQL Analytics API, which is account-level and independent of AI Gateway.

**Payload logging is suppressed on every call regardless** (`src/lib/ai.ts` sends
`cf-aig-collect-log-payload: false`), because AI Gateway stores request and response bodies by default and
that would put salary and review text in a third retained surface with its own lifetime. That header is sent
whether or not a gateway is configured, so turning one on later cannot quietly start recording prompts. Note
that Cloudflare's logging docs do not state precedence between the header and a gateway-level setting, so
verify it against a live gateway before relying on it.

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

Sixteen switches, all off, in four groups: search and similarity, writing and summarising, reading documents,
and the public walls. Each row says in one line what it does, and **What this means** opens the full account
of what happens when it is on and what happens when it is off - which is the record of what the organisation
agreed to, so it opens by itself the moment a switch goes on. A feature's own settings (which CV fields, which
walls, how alike two tasks must look) sit underneath it and appear when it is on. Turn on one at a time - the
ledger in step 6 is much easier to read that way.

The screen also says what nothing used to: the four features in the first group read the semantic index and
find nothing while `search.semantic` is off, the conduct check does nothing while the gate above it is off,
and `moderation` with `attention.summary` is two interactive features competing for one allowance.

**They share one daily allowance, and three of them can spend all of it.** `search.semantic`'s first-run
backfill, `moderation` and `attention.summary` are the three with volume behind them, and `moderation` is the
one that matters when the budget runs out: it is a GATE and it fails closed, so a post written after the
allowance is spent is held rather than published - unless the org has chosen otherwise under **When the model
cannot answer** (see the moderation notes below). Unattended work (the backfill, the moderation drain, the
nightly sweeps) is capped at 60% of the day so it cannot take the share a person posting needs - but two
interactive features can still crowd each other. With `moderation` on, leave `attention.summary` off until
the ledger in step 6 says there is room for it.

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
| `tables.describe` | Describe a grid in words in the table builder, including which collection one row of it is | no |
| `analytics.narrate` | Written summary on the team report | no |
| `budgets.narrate` | Written summary of how an expense budget is tracking | no |
| `expenses.receiptExtraction` | Read a PDF receipt into the expense form | no |
| `moderation` | A gate on the public walls: nothing is posted until a model has read it | no |
| `moderation.conduct` | The same posts read a second time against this org's conduct rules | no |

Six settings on the same screen are worth a decision rather than a default:

- **Which posts are checked.** Appears once `moderation` is on. Every wall is checked by default -
  announcements and kudos, replies, the suggestion box - and each can be set to `Don't check` on its own.
  The suggestion box has a third position, **Anonymous only**, which is the cheapest useful configuration of
  the whole feature: a name beside a post already does most of the work a queue does, and the suggestion box
  is the one wall that deliberately removes it. A wall set to `Don't check` still has a queue and can still
  be moderated by hand; what stops is the model reading it, so nothing on it is ever held.

- **What happens when the moderation model cannot answer.** Appears once `moderation` is on, and it is the
  one to decide BEFORE turning the gate on rather than the first afternoon posting stops. `hold` is the
  default: nothing reaches a wall unread, and an outage or a spent allowance means posts wait for a person.
  `publish` keeps posting working and leaves every unread post on Flagged posts marked `Not checked`, which
  is a defensible choice only if somebody reads that queue. Neither position lets a post the model OBJECTED
  to go up.

- **Which CV fields may be extracted.** Appears once `ats.extraction` is on. `summary` and
  `years_experience` are **off by default** because they are the model doing more than copying - a summary is
  a paraphrase in the model's words that a recruiter will read as what the CV said.
- **Which receipt fields may be extracted.** Appears once `expenses.receiptExtraction` is on. `vendor_name`
  is **off by default** and is never picked for the submitter even when on - a wrong vendor misattributes
  spend silently. `amount` and `incurred_on` are the two where the model is choosing between several numbers
  and several dates printed on the same page, which is why the person filing accepts each field one by one.
- **How alike two tasks must look to be called a duplicate.** Appears once `cards.triage` is on. Loose points
  at more unrelated work, which teaches people to ignore the panel; strict misses the duplicate somebody
  worded differently. `balanced` is the default.
- **The daily budget.** Defaults to 7000 neurons, which is 70% of Cloudflare's free 10,000/day allowance.
  It can only be lowered; a higher number does not buy more allowance and is ignored.

### Expect on first run

- **Semantic search returns nothing useful for a while.** The embed drain backfills 14 rows per five-minute
  tick - sized so a whole day of ticks stays inside the unattended share of the allowance - so a large
  database takes several days. This is designed, not a fault: the alternative spends the org's whole day by
  mid-morning, every morning, and with `moderation` on that means every post held until UTC midnight.
- **Ticket triage correctly suggests nothing** until there are resolved tickets to learn from, and board task
  triage the same until cards have been delivered. Both vote from finished work only.
- **The nightly duplicate sweep examines 60 open cards a tick**, least-recently-swept first, so a large
  backlog is covered over several nights.
- **`moderation` is a GATE, not a warning.** With it on, nothing reaches a wall in scope until a model has
  read it: a post, reply or suggestion is written invisible, checked, and only then published. There is no
  moment at which such a post is both public and unread. The gate meets every route onto a wall - a new post,
  an edit to one already up, the `:publish` verb, and the tick that publishes a scheduled draft.
- **Scope is honoured on both paths.** `ai.moderationScope` narrows the gate AND the cron sweep, in the
  sweep's case inside the SQL, so a wall that is off costs nothing per tick and a suggestion box narrowed to
  anonymous posts spends the tick's budget only on those. A post out of scope is never written held, never
  sent, and never flagged - "we do not check the noticeboard" means no queue items from it, not quiet ones.
  Editing a suggestion re-decides on the anonymity the edit leaves behind, so signing one takes it out of
  scope and making one anonymous brings it in.
- **A held post is invisible at the API, not just in the UI.** It is absent from the board feed, the
  suggestion box, a thread's replies, search and a direct `GET` (which answers 404) - including for HR and
  for its own author. It appears in one place: **Flagged posts**.
- **It fails closed by default, and that is now a choice.** If the model is down, out of budget or answers
  nonsense, the post is HELD with the reason `Not checked`: during an outage posting appears not to work and
  the queue fills up, on the principle that a gate which opens when the guard is asleep is not a gate. An org
  that would rather have the opposite failure sets **When the model cannot answer → "Let the post go up, and
  flag it as unchecked"** on the same settings screen (`ai.moderationFallback: "publish"`). The post then
  goes up in the ordinary way - broadcast included - and a `pending` flag marked `Not checked` is left
  standing over it, so Flagged posts is the record of exactly what reached a wall unread. **Somebody has to
  be reading that queue for the setting to be defensible**; it is the only place that window is visible.
- **The choice is about SILENCE, never about a verdict.** A post the model read and objected to is held
  under both positions. `publish` covers no allowance left, no binding, a provider error, or a reply that was
  not a verdict - and not the gate itself throwing, which always holds, because that means our code failed
  and nothing is known about the post. An unrecognised stored value reads as `hold`.
- **Releasing is `dismiss` on the queue.** On a held post the buttons read "Release it" / "Keep it hidden",
  and releasing sends the broadcast that was held back with it - the bell, the email and the mentions.
- **A held announcement can also be handed back.** "Put it back as a draft" is the third answer, beside
  releasing it and keeping it down: the post goes to its author's drafts, its flag closes because nobody
  judged the text, and publishing it is what asks the question again - through the gate, which re-reads it.
  It needs `moderation.unhide`, not `moderation.decide`, and it is announcements only: a reply and a
  suggestion have no draft to go back to.
- **A hidden post goes back either way.** On **Already decided**, an announcement offers "Put it back as a
  draft" and "Put it back on the wall"; a reply or a suggestion has no draft state, so it offers the second
  alone. The draft route reopens the flag for somebody to decide again; the wall route records the takedown
  as overruled, by whoever put it back. Both are `moderation.unhide` - reversing a takedown is one permission,
  not two - and a post that was never published is announced as it goes up.
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

**`ai_usage` cannot tell you what a call cost**, only what the app assumed it cost: `estimated_neurons` is the
constant from `ESTIMATED_NEURONS`, written by the same code that is being checked. The real figure comes from
the account's own inference logs:

```bash
CF_ANALYTICS_TOKEN=... npm run ai:spend -- --introspect   # confirm the query shape, one request, needs no data
CF_ANALYTICS_TOKEN=... npm run ai:spend -- --days 1       # both sides of the same window, with the ratio
```

`scripts/aiSpend.ts` reads `aiInferenceAdaptiveGroups` (account-level, no AI Gateway involved) and `ai_usage`
for the same UTC window and prints, per role, what we assumed against what it cost. The ratio is the
multiplier to apply to `ESTIMATED_NEURONS`.

Run `--introspect` first. The dataset's field names are not in the published docs, so the script asks the
schema what it offers rather than assuming; if it recognises nothing it says what is there instead of
reporting a zero. As of 2026-09-22 the neuron figure is `sum.totalNeurons`, and the same dataset carries
`totalInputTokens`, `totalOutputTokens` and `totalInferenceTimeMs`, which the script prints alongside.

The token is account-scoped with Analytics Read, is passed in the environment for one command, and belongs in
neither `.dev.vars` nor `wrangler.toml` - nothing in the request path needs account-level analytics. Creating
one: **My Profile → API Tokens → Create Custom Token**, permissions **Account → Account Analytics → Read**,
restricted to the one account.

**Neurons are being retired as the user-facing unit.** Cloudflare has moved to per-model pricing - LLMs by
parameter size and input/output tokens, embeddings by input tokens - while still billing neurons behind it.
Everything in this section, `BUDGET`, and the org's daily budget setting are denominated in that unit. Nothing
breaks while the back end still bills in neurons, but a future retune may be reading tokens.

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

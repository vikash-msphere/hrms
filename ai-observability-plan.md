# Reading what the AI layer spends

Companion to `ai-plan.md` (design) and `ai-rollout-plan.md` (what shipped). This file covers one question
those two left open: where the numbers come from once the layer is on, and whether AI Gateway belongs in the
answer.

`docs/deploy-ai.md` step 8 tells an operator to "retune the budget from evidence" without saying where the
evidence lives. `BUDGET` and `ESTIMATED_NEURONS` in `src/domain/aiPolicy.ts` are deliberately pessimistic
guesses - 1 neuron per embed, 60 per guard pass, 120 per conduct pass and per generation - and nothing in the
repo reads a real figure back.

## The decision: no AI Gateway

`AI_GATEWAY_ID` stays unset. `src/lib/ai.ts` keeps its gateway support, because removing it would mean
re-deciding this later with the code gone, but nothing in the deploy path sets the var.

Four reasons, weakest to strongest.

**It duplicates `ai_usage`.** The gateway's analytics are `model`, `provider`, `gateway`, timestamp and a
count. `ai_usage` (`src/db/schema.ts:1770`) already records `model`, `role`, `feature`, `userId`, `subject`,
`inputChars`, `outputChars`, `estimatedNeurons`, `cacheHit`, `durationMs`, `outcome` and `error` per call, in
our own database, joinable to the org's own rows.

**Its caching duplicates `ai_cache`, and would sit behind it.** `aiGenerate` checks `ai_cache` in-process
before the binding call, so a gateway cache only ever sees prompts that just missed. The measured value of
what remains is in "The embed cache" below.

**It adds a retained surface.** Payload logging is suppressed on every call
(`cf-aig-collect-log-payload: false`, `src/lib/ai.ts:28`), but metadata-only logs still hold tokens, model,
status, cost and duration per request, with a lifetime and a deletion story separate from ours. The public
logging docs do not state precedence between that per-request header and a gateway-level setting, so the
guarantee the code comment asserts is undocumented rather than wrong.

**It puts a second hop in front of a gate that fails closed.** This is the one that decides it. A wrong or
deleted gateway id reads to the app as "the model was silent", which lands at `src/services/moderation.ts:232`
and is resolved by `ai.moderationFallback` - default `hold`. A typo in a var stops every wall accepting posts,
and the only place that says so is `ai_usage.error`. Today there is one hop between `aiEmbed`/`aiGenerate` and
a model. Adding a second to gain analytics we already have is the wrong trade.

## Where the numbers come from instead

Two sources, both without a gateway.

**Ours, per call.** `ai_usage`, queried as `docs/deploy-ai.md` step 7 already shows. It answers which feature
spent what, who asked, how long it took and what failed. What it cannot answer is what a call actually cost,
because `estimatedNeurons` is the constant, not a measurement.

**Cloudflare's, per inference.** The GraphQL Analytics API at
`https://api.cloudflare.com/client/v4/graphql` carries `aiInferenceAdaptiveGroups` and its raw sibling
`aiInferenceAdaptive`, both account-level and both independent of AI Gateway. That is the neuron measure the
estimates need to be checked against.

Confirmed against the live endpoint on 2026-09-22. The field names are not in the published docs, so this is
what introspection returned rather than what anything documents:

```
aiInferenceAdaptiveGroups -> AccountAiInferenceAdaptiveGroups
  fields:     confidence, count, dimensions, sum
  sum:        totalAudioSeconds, totalCostMetricValue1, totalCostMetricValue2, totalInferenceSteps,
              totalInferenceTimeMs, totalInputLength, totalInputTokens, totalNeurons, totalOutputTokens,
              totalProcessedPixels, totalProcessedTiles, totalRequestBytesIn, totalRequestBytesOut, totalTiles
  dimensions: costMetricName1, costMetricName2, costMetricValue1, costMetricValue2, date, datetime,
              datetimeFifteenMinutes, datetimeFiveMinutes, datetimeHour, datetimeMinute, datetimeSixHours,
              errorCode, inferenceTimeMs, modelId, modelIsBeta, neurons, requestBytesIn, requestBytesOut,
              requestSource, tag
```

`totalNeurons` is the figure `ESTIMATED_NEURONS` is checked against. Two others earn their place in the
output:

- **`totalInputTokens` and `totalOutputTokens`** are the units Workers AI pricing is moving to. Recording
  them from the first run means the transition is read off runs we already have, rather than measured again
  when it lands.
- **`totalInferenceTimeMs`** is the model's own time. It is not the round trip from the Worker, so it does
  not settle the embed cache below - the difference between the two is the network, and the network is the
  term that decides it. It does bound it: the round trip cannot be less than this.

One caution stands: "adaptive sampling" means high-volume sums are estimates, though at a 7000-neuron daily
ceiling sampling will not engage.

### Phase 1: a script that reads both

`scripts/aiSpend.ts`, run by hand, not on a cron and not from the Worker:

```bash
CF_ANALYTICS_TOKEN=... npm run ai:spend -- --days 1
CF_ANALYTICS_TOKEN=... npm run ai:spend -- --introspect
```

It queries `aiInferenceAdaptiveGroups` for real usage per model and `ai_usage` (through
`wrangler d1 execute --remote --json`) for the same UTC window, then prints per role: calls on both sides, our
estimate, the actual figure, and the ratio. The ratio is the output that matters. Cache hits are excluded from
our side, because they cost no inference and would make the two columns disagree for a reason that is not an
error.

Two things it does deliberately.

**It asks the schema what the dataset offers rather than hardcoding a metric name.** The field names are not
published, so the script introspects `Account`, follows the dataset's type, reads what lives under `sum`, and
picks the first name it recognises. If it recognises none it prints what the dataset does offer and stops,
rather than reporting a confident zero. That is also how the move off neurons will surface: a token-shaped
name where a neuron-shaped one used to be.

**It refuses to read the token from `.dev.vars`,** unlike every other script in `scripts/`. An account-scoped
Analytics Read token can read the whole account, and `.dev.vars` is the file whose contents become Worker
secrets - one `wrangler secret put` from an isolate that serves employee requests and has no use for account
analytics. It is passed in the environment for one command and lives nowhere.

### What the same query settles about the trail

`ai_usage` is written by the code that makes the call, so it cannot report a call that failed before
`recordUsage` ran, or one made by something that is not `services/ai.ts`. Two dimensions on the same rows can,
at no extra cost:

- **`errorCode`** against our `outcome='error'` count. Cloudflare counting more failures than we recorded
  means the trail is missing calls that were actually made - which matters on the one table the accountability
  story rests on.
- **`requestSource`** says how the inference arrived. Everything this app does goes through the binding in
  `src/lib/ai.ts`, so a second value in that column is inference on this account that did not come from here.

Plus the original check: a model Cloudflare billed for with no `ai_usage` rows at all.

Written and typechecked. Its output is blocked until the layer is on in production and has spent something.

### Phase 2: retune `ESTIMATED_NEURONS` from the ratio

Edit the constants in `src/domain/aiPolicy.ts` with the measured multipliers, and record the measurement date
and the numbers beside them, because the next person needs to know how old the calibration is. The estimates
staying pessimistic is fine; the estimates being uncheckable is not.

## The embed cache

`aiEmbed` (`src/services/ai.ts:140`) has no cache, unlike `aiGenerate`. For the backfill that is correct -
each row's text is embedded once. For `search.query` it is not: `src/services/globalSearch.ts:185` embeds the
caller's own ⌘K box, and fifty people typing "payroll" is fifty identical calls at 1 neuron each.

### What was measured

A throwaway bench under `@cloudflare/vitest-pool-workers` (real workerd, real D1 binding), with the statements
copied verbatim from `cacheGet`, `cachePut` and `withinCachedRate`, against `ai_cache` at 5,000 rows and
`ai_usage` at 2,000, storing a realistic 384-float vector. 400 statements per timed round, 7 rounds.

Per-statement timing is not available in workerd: `performance.now()` is clamped to whole milliseconds, so the
first attempt produced a column of zeroes. Timing batches and dividing is what makes the numbers real.

| Statement | Cost |
|---|---|
| baseline `select 1` | 0.115 ms |
| `cacheGet` SELECT, hit | 0.155 ms |
| `cacheGet` SELECT, miss | 0.135 ms |
| `cacheGet` UPDATE hits | 0.148 ms |
| `cachePut` INSERT | 0.210 ms |
| `withinCachedRate` COUNT | 0.295 ms |

So a hit adds 0.302 ms, a hit behind the rate gate adds 0.597 ms, and a miss adds 0.345 ms of pure loss.

### What it means

With a D1 round trip of `r` and a hit rate of `h`, the cache wins on latency when the embed call costs more
than `2r / h`. The measured local figures give 1.1 ms at h=30% and 0.6 ms at h=50%, which any real inference
call clears by an order of magnitude.

But Miniflare's D1 is local SQLite, and `r` is the dominant term. At a remote round trip of 5 ms the same
formula wants an embed call slower than 33 ms at h=30%, or 20 ms at h=50%.

### Phase 3: decide it with production numbers, not this bench

Neither `r` nor the real embed latency can be measured from a dev machine. Both are already instrumented:
`runRecorded` writes `durationMs` on every call (`src/services/ai.ts:429`).

1. Turn `search.semantic` on and let a day of real ⌘K traffic through.
2. `select count(*), avg(duration_ms) from ai_usage where feature='search.query'`.
3. Add the cache only if that average clears `2r / h` for the hit rate the same data implies.

If it goes in, it is not a copy of `aiGenerate`'s shape. Two of that path's three statements do not belong on
a search box: the hit counter is best-effort telemetry, and `withinCachedRate` exists to stop someone holding
down a Draft button. Dropping both takes the hit cost from 0.597 ms to 0.155 ms.

The upside is small either way. At 500 searches a day and a 50% hit rate it is 250 of 7000 neurons.

## Neurons are being retired as the unit

Cloudflare has announced that Workers AI pricing moves to per-model units - LLMs by parameter size and
input/output tokens, embeddings by input tokens - while still billing neurons behind it. The free allowance is
10,000 neurons per day, resetting 00:00 UTC, on both Free and Paid.

`BUDGET`, `ESTIMATED_NEURONS`, the org's `dailyNeurons` setting and every number in `docs/deploy-ai.md` step 8
are denominated in a unit with an announced end. Nothing breaks while the back end still bills in neurons, so
this is a watch item rather than work: when the GraphQL dataset starts reporting tokens rather than neurons,
phases 1 and 2 are where the change lands.

Unrelated but checked at the same time: the July 2026 move of some models behind Workers Paid covers
`@cf/moonshotai/kimi-k2.6`, `@cf/moonshotai/kimi-k2.7-code` and `@cf/zai-org/glm-5.2`, returning 403 with
internal error 5035 on Free. None of the ids in `MODELS` (`src/domain/aiPolicy.ts`) are among them.

## Status

- Doc updates: done. `docs/deploy-ai.md` steps 3 and 8, `docs/env-vars.html`, `ai-plan.md`.
- Phase 1 (`scripts/aiSpend.ts`): written, typechecked, wired to `npm run ai:spend`. `--introspect` has run
  against the real endpoint and the schema above is its output, so the dataset, its type and its metric names
  are confirmed rather than assumed. The spend query itself is still unexercised: it needs a window with
  inference in it, and nothing has been spent yet.
- Phase 2 (retune `ESTIMATED_NEURONS`): blocked on phase 1 having real output. Not startable - the
  multipliers cannot be invented.
- Phase 3 (embed cache): blocked on `duration_ms` from real traffic. May end in "no change", which is a
  result.

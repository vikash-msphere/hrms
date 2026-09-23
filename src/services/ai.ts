// Everything that has to be true before a model is called, and everything that has to be recorded after.
//
// lib/ai.ts is transport: it turns a model id into a subrequest and refuses ids that would leave Cloudflare's
// network. This file is the policy around that call - is there a model at all, is the org's day already
// spent, has this caller had their share this hour, do we already know the answer, and what does the trail
// say afterwards. Call sites go through here; nothing outside lib/ai.ts and this file touches the port.
//
// THE RETURN SHAPE IS THE POINT. These functions do not throw when inference is unavailable, out of budget or
// broken, because "no model today" is a normal operating state for this app and every feature is built with a
// path that does not need one. They return a refusal the caller turns into its fallback: FTS search instead
// of semantic search, the manual department picker instead of a suggested one, no draft button. A thrown
// error would make an optional feature able to fail a request, which is the opposite of the design.
//
// They DO throw for policy violations - an unlisted model, a forbidden collection. Those are not runtime
// conditions to degrade around, they are bugs, and the loudest possible failure is the correct one.
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { GENERATIVE_ROLES, type GenerativeRole } from "../ports";
import {
  AI_CONFIG_DEFAULT,
  BUDGET,
  ESTIMATED_NEURONS,
  MODELS,
  MODERATION_FALLBACKS,
  USAGE_RETENTION_DAYS,
  assertMayReachModel,
  type AiConfig,
  type AiFeature,
  type ModelRole,
} from "../domain/aiPolicy";
import { getSettingValue } from "./settings";

/**
 * The org's AI switches, read off the per-request settings snapshot (lib/refData.ts), so asking costs nothing
 * beyond the one settings read every request already makes.
 *
 * A malformed blob falls back to the defaults, which are all-off - the safe direction for this particular
 * setting, since the failure mode of the other direction is processing employee text nobody agreed to.
 */
export async function aiConfig(deps: Deps): Promise<AiConfig> {
  const raw = await getSettingValue<AiConfig>(deps, "ai", AI_CONFIG_DEFAULT);
  // `getSettingValue` shallow-merges, so a blob that sets one feature would otherwise drop the rest of the
  // map and leave them `undefined` - falsy, and so off, but off by accident rather than by decision.
  //
  // THE NUMBERS ARE CLAMPED ON READ, not only validated on write, and the two are deliberately both here for
  // the reason `domain/attention.ts attentionConfigOf` gives about its own leaves: the route is one way an
  // `ai` blob is written and not the only one, and a non-finite `dailyNeurons` does not fail loudly - it makes
  // `Math.min(undefined, 7000)` NaN, `spent + cost > NaN` false, and the daily budget silently stop existing.
  // A zero `perUserHourlyGenerations` is the mirror: it passes every numeric test and refuses every generation.
  return {
    ...raw,
    features: { ...AI_CONFIG_DEFAULT.features, ...(raw.features ?? {}) },
    dailyNeurons: clamp(raw.dailyNeurons, 1, BUDGET.dailyNeurons, AI_CONFIG_DEFAULT.dailyNeurons),
    perUserHourlyGenerations: clamp(raw.perUserHourlyGenerations, 1, BUDGET.perUserHourlyGenerations, AI_CONFIG_DEFAULT.perUserHourlyGenerations),
    // ...and the gate's posture is coerced on read for the same reason, with the failure landing on `hold`.
    // A stored value this does not recognise - a typo, an older spelling, a blob written by hand - must not
    // read as "publish unread": the whole point of the setting is that one of its two positions lets content
    // onto a public wall without a model having seen it, and that position has to be CHOSEN, never inherited
    // from something unparseable. The route validates it by name on write (routes/settings.ts validateAi),
    // which is the half that stops an admin being told a value saved when it will not be honoured.
    moderationFallback: (MODERATION_FALLBACKS as readonly string[]).includes(raw.moderationFallback as string)
      ? (raw.moderationFallback as AiConfig["moderationFallback"])
      : AI_CONFIG_DEFAULT.moderationFallback,
  };
}

/** A stored number held inside its stated range, with the default for anything that is not a number at all. */
const clamp = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : fallback;

/** Is this feature switched on for the org? The single question every AI call site asks first. */
export async function aiFeatureOn(deps: Deps, feature: AiFeature): Promise<boolean> {
  return (await aiConfig(deps)).features[feature] === true;
}

/** Why a call did not produce a value. Each maps to a different thing the caller should do, which is why it
 *  is not one flag: `unavailable` is permanent for this deployment, `budget` clears at midnight UTC, `rate`
 *  clears within the hour, and `error` is worth retrying. */
export type AiRefusal = { ok: false; reason: "unavailable" | "budget" | "rate" | "error"; detail?: string };
export type AiResult<T> = ({ ok: true; value: T; cached: boolean }) | AiRefusal;

const refuse = (reason: AiRefusal["reason"], detail?: string): AiRefusal => ({ ok: false, reason, ...(detail ? { detail } : {}) });

/** Ceilings, overridable so the settings panel can lower them per deployment without touching call sites.
 *  Raising them above the constants is possible and is a decision for whoever edits settings: the free
 *  allocation is an account-wide fact, not something this app can grant itself more of. */
export type AiLimits = { dailyNeurons: number; perUserHourlyGenerations: number };
const limitsOf = (over?: Partial<AiLimits>): AiLimits => ({
  dailyNeurons: over?.dailyNeurons ?? BUDGET.dailyNeurons,
  perUserHourlyGenerations: over?.perUserHourlyGenerations ?? BUDGET.perUserHourlyGenerations,
});

/**
 * WHOSE CONTENT IS IN THIS PROMPT, as a declaration the caller cannot leave out.
 *
 * The denylist (`assertMayReachModel`) is absolute, and it can only fire on what it is told. This used to be
 * an optional `collection`, which meant a call that forgot to declare one and a call that genuinely reads no
 * record looked identical - and four call sites deliberately omit it with good arguments (`tableAssist`,
 * `draftText`, `attention`, the narrators), so the omission was already the normal case. There was no way to
 * read a call site and tell which kind it was, and no way for a reviewer to notice a new one that forgot.
 *
 * `"none"` is that same omission, said out loud. A caller that adds a record's text to a prompt later has to
 * come back here and change a value rather than leave one absent, and the four legitimate `"none"`s each
 * carry the argument for themselves at the call site.
 */
export type AiReadsOne = { collection: string; subresource?: string };
/** One collection, several (a batch spanning the index), or `"none"` said out loud. */
export type AiReads = "none" | AiReadsOne | readonly AiReadsOne[];

/** What every call through this file identifies itself as. `subject` is what makes the usage row answer
 *  "what was sent to a model about whom" a year later, so it is worth passing wherever there is one. */
export type AiCallContext = {
  feature: string; // "search.embed", "tickets.triage", "announcements.draft"
  userId?: string | null; // null/absent = a cron or system call
  subject?: string; // "<collection>/<uuid>"
  reads: AiReads; // checked against the denylist before anything is sent
  limits?: Partial<AiLimits>;
};

/** The denylist check, on the declaration the context is required to carry. */
function assertDeclaredReadable(ctx: AiCallContext): void {
  if (ctx.reads === "none") return;
  for (const r of Array.isArray(ctx.reads) ? ctx.reads : [ctx.reads as AiReadsOne]) {
    assertMayReachModel(r.collection, r.subresource);
  }
}

// ---------------------------------------------------------------------------------------------------------
// The public calls
// ---------------------------------------------------------------------------------------------------------

/**
 * Embed a batch of texts. The cheap primitive, and the only one in the request path.
 *
 * Not cached: an embedding is cheap enough that a cache lookup costs a comparable amount of the thing that is
 * actually scarce here, which is D1 reads rather than neurons. The index itself is the cache - a row's vector
 * is stored and only recomputed when its text changes.
 */
export async function aiEmbed(deps: Deps, ctx: AiCallContext, texts: string[]): Promise<AiResult<number[][]>> {
  assertDeclaredReadable(ctx);
  if (!deps.ai) return refuse("unavailable", "no AI binding on this deployment");
  if (texts.length === 0) return { ok: true, value: [], cached: false };

  const cost = ESTIMATED_NEURONS.embed * texts.length;
  const budget = await withinDailyBudget(deps, ctx, cost);
  if (!budget.ok) return budget;

  // `cost`, not the per-call estimate: the budget check scales with the batch, so the ledger has to as well.
  // Charging a 200-row embed batch one neuron would let the checked ceiling and the recorded spend diverge by
  // two orders of magnitude, and the check reads the ledger - so the ceiling would stop meaning anything.
  return runRecorded(deps, ctx, "embed", texts.join("\n"), cost, async () => {
    const vectors = await deps.ai!.embed(texts);
    // CHARACTERS, not rows. `vectors.length` is the batch size, so the ledger recorded a 200-row embed as
    // having produced 200 characters - on the one table whose job is to replace the neuron estimates with
    // measurements. A vector's size is its dimension count, summed across the batch.
    return { value: vectors, outputChars: vectors.reduce((n, v) => n + v.length, 0) };
  });
}

/**
 * Generate short-form text. The expensive primitive: user-initiated or nightly, never automatic on a write.
 *
 * Cached by `(feature, promptVersion, inputs)`. `promptVersion` is a caller-supplied string that must change
 * whenever the system prompt does, or an edit to the prompt would keep serving answers produced by the old
 * one - the failure mode where a fix appears not to work.
 */
export async function aiGenerate(
  deps: Deps,
  ctx: AiCallContext,
  req: { system: string; user: string; promptVersion: string; maxTokens?: number; cacheTtlMs?: number; role?: GenerativeRole },
): Promise<AiResult<string>> {
  assertDeclaredReadable(ctx);
  if (!deps.ai) return refuse("unavailable", "no AI binding on this deployment");

  // Which model answers, and therefore what it costs and what the ledger says it was. Defaulting here rather
  // than at each call site keeps the three in step: a caller that names a role cannot end up charged for one
  // model and answered by another.
  const role = req.role ?? "generate";
  // The role is IN THE CACHE KEY. Two models asked the same question give different answers, and without it
  // a moderation verdict and a draft built from identical text would share one cached reply.
  //
  // So is the MODEL ID behind the role, for the same reason across time: replacing `MODELS.generate` would
  // otherwise keep serving the old model's answers for up to a week, and an upgrade would look like it did
  // nothing until the cache ran out.
  const key = await sha256Hex(`${ctx.feature}|${role}|${MODELS[role]}|${req.promptVersion}|${req.system}|${req.user}`);
  const hit = await cacheGet(deps, key);
  if (hit !== null) {
    // A HIT IS CHEAP, NOT FREE, so it has a ceiling of its own rather than none at all. The generation limit
    // deliberately does not apply - "do not ration answers we already had" - but the hit path still does two
    // D1 writes apiece (the hit counter and the usage row), and unbounded that is somebody hammering Draft
    // with one instruction costing real reads and writes all day. The looser ceiling keeps the intent and
    // closes the hole.
    const cachedRate = await withinCachedRate(deps, ctx);
    if (!cachedRate.ok) return cachedRate;
    // Recorded, with `cacheHit` set: a cache hit is still a use of the feature, and leaving it out of the
    // trail would make the usage picture flatter than reality and the accountability answer incomplete.
    await recordUsage(deps, ctx, role, { inputHash: key, inputChars: req.user.length, outputChars: hit.length, neurons: 0, cacheHit: true, outcome: "ok", durationMs: 0 });
    return { ok: true, value: hit, cached: true };
  }

  const rate = await withinUserRate(deps, ctx);
  if (!rate.ok) return rate;
  const budget = await withinDailyBudget(deps, ctx, ESTIMATED_NEURONS[role]);
  if (!budget.ok) return budget;

  const out = await runRecorded(deps, ctx, role, `${req.system}\n${req.user}`, ESTIMATED_NEURONS[role], async () => {
    const text = await deps.ai!.generate({ system: req.system, user: req.user, maxTokens: req.maxTokens, role });
    return { value: text, outputChars: text.length };
  });
  if (out.ok && out.value) await cachePut(deps, key, ctx.feature, out.value, req.cacheTtlMs ?? DEFAULT_CACHE_MS);
  return out;
}

/** Re-rank a shortlist the cheap retrieval already produced. Optional everywhere it is used: a refusal means
 *  the caller keeps the order it already had, which is a worse ranking and not a broken one. */
export async function aiRerank(deps: Deps, ctx: AiCallContext, query: string, candidates: string[]): Promise<AiResult<{ index: number; score: number }[]>> {
  assertDeclaredReadable(ctx);
  if (!deps.ai) return refuse("unavailable", "no AI binding on this deployment");
  if (candidates.length === 0) return { ok: true, value: [], cached: false };

  const budget = await withinDailyBudget(deps, ctx, ESTIMATED_NEURONS.rerank);
  if (!budget.ok) return budget;

  return runRecorded(deps, ctx, "rerank", `${query}\n${candidates.join("\n")}`, ESTIMATED_NEURONS.rerank, async () => {
    const ranked = await deps.ai!.rerank(query, candidates);
    // As in `aiEmbed`: the ledger wants a size, and `ranked.length` is a count of shortlist entries. A rerank
    // returns scores rather than text, so the honest measure of what came back is the JSON it amounts to.
    return { value: ranked, outputChars: JSON.stringify(ranked).length };
  });
}

// ---------------------------------------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------------------------------------

/**
 * Neurons spent since midnight UTC, against the ceiling.
 *
 * UTC deliberately, and NOT services/orgDay.ts, which is what every other "today" in this app comes from. The
 * window being tracked here is Cloudflare's allocation reset, which is a platform fact in UTC; aligning it to
 * the org's local day would mean the app's idea of a fresh budget and the platform's diverged by the UTC
 * offset, and the app would confidently spend an allocation that ran out hours ago.
 */
async function withinDailyBudget(deps: Deps, ctx: AiCallContext, cost: number): Promise<{ ok: true } | AiRefusal> {
  // The org's configured ceiling, unless the caller passed a tighter one for this call. Clamped to the
  // constant in domain/aiPolicy.ts: settings may LOWER the budget, never raise it, because the number above
  // it is Cloudflare's account-wide free allocation and this app cannot grant itself more of that.
  const configured = (await aiConfig(deps)).dailyNeurons;
  const { dailyNeurons } = limitsOf({ dailyNeurons: Math.min(configured, BUDGET.dailyNeurons), ...ctx.limits });
  const { spent, unattended } = await spentToday(deps);

  // THE RESERVATION. A call with no `userId` is a cron: the embed backfill, the moderation drain, the nightly
  // sweeps. Unattended work is capped at a SHARE of the day, so the rest is still there when somebody presses
  // something - and, more to the point, when the moderation gate runs on a post a person has just written.
  // Without this the two were first-come-first-served and the cron always came first, so a semantic-search
  // backfill over a corpus larger than a day's allocation held every post on every wall from mid-morning
  // until UTC midnight, every day until it finished.
  if (!ctx.userId) {
    const ceiling = Math.floor(dailyNeurons * BUDGET.unattendedShare);
    if (unattended + cost > ceiling) {
      return refuse("budget", `daily AI budget for unattended work spent (${unattended}/${ceiling} neurons)`);
    }
  }
  if (spent + cost > dailyNeurons) {
    return refuse("budget", `daily AI budget spent (${spent}/${dailyNeurons} neurons)`);
  }
  return { ok: true };
}

/**
 * Neurons spent since midnight UTC, in total and by unattended callers, memoized for the life of one request.
 *
 * WHY MEMOIZED. This sums every `ai_usage` row written today and it runs before every single inference, so
 * its cost rises with how much of the budget has already been used - roughly N squared over a busy day, on a
 * database that bills rows read, which is the shape `lib/vector.ts` argues at length for avoiding. The memo
 * rides `deps.refCache` like the reference tables do (lib/refData.ts), so a request making several calls -
 * the table builder's two generations, an extraction followed by its embed - pays for one sum.
 *
 * NOT memoized across the cron's ticks: `deps.refCache` is created per request, and a cron Deps has none, so
 * the drain's eight checks each read fresh. That is correct rather than a gap - the answer genuinely changes
 * between them, and a stale one would let a drain spend past the ceiling it just met.
 */
async function spentToday(deps: Deps): Promise<{ spent: number; unattended: number }> {
  const read = async () => {
    const rows = await deps.db
      .select({
        spent: sql<number>`coalesce(sum(${schema.aiUsage.estimatedNeurons}), 0)`,
        unattended: sql<number>`coalesce(sum(case when ${schema.aiUsage.userId} is null then ${schema.aiUsage.estimatedNeurons} else 0 end), 0)`,
      })
      .from(schema.aiUsage)
      .where(gte(schema.aiUsage.createdAt, utcMidnight(deps.clock.now())));
    return { spent: Number(rows[0]?.spent ?? 0), unattended: Number(rows[0]?.unattended ?? 0) };
  };
  const memo = deps.refCache;
  if (!memo) return read();
  const key = spentKey(deps);
  const hit = memo.get(key) as Promise<{ spent: number; unattended: number }> | undefined;
  if (hit) return hit;
  const work = read();
  memo.set(key, work);
  return work;
}

const spentKey = (deps: Deps): string => `ai:spent:${utcMidnight(deps.clock.now()).getTime()}`;

/**
 * Add what this call just spent to the memoized sum, so the NEXT call in the same request sees it.
 *
 * Without this the memo would be a ceiling with a hole in it: a request making three generations would check
 * all three against the figure as it stood before the first. Adding to the memo rather than dropping it keeps
 * the one-read-per-request property and the ceiling both.
 */
function noteSpend(deps: Deps, neurons: number, unattended: boolean): void {
  const memo = deps.refCache;
  if (!memo || neurons <= 0) return;
  const key = spentKey(deps);
  const hit = memo.get(key) as Promise<{ spent: number; unattended: number }> | undefined;
  if (!hit) return;
  memo.set(key, hit.then((v) => ({ spent: v.spent + neurons, unattended: v.unattended + (unattended ? neurons : 0) })));
}

/** Generations one person has made in the last hour, against their ceiling. Cron and system calls carry no
 *  user and are not rate-limited per caller - they are bounded by the daily budget and by their own batch
 *  sizes instead. */
async function withinUserRate(deps: Deps, ctx: AiCallContext): Promise<{ ok: true } | AiRefusal> {
  if (!ctx.userId) return { ok: true };
  const configured = (await aiConfig(deps)).perUserHourlyGenerations;
  const { perUserHourlyGenerations } = limitsOf({ perUserHourlyGenerations: Math.min(configured, BUDGET.perUserHourlyGenerations), ...ctx.limits });
  const since = new Date(deps.clock.now().getTime() - 3_600_000);
  const rows = await deps.db
    .select({ n: sql<number>`count(*)` })
    .from(schema.aiUsage)
    // Cache hits are excluded. They are recorded as usage because they ARE a use of the feature, but they
    // cost no neurons, and this limit exists to stop one person spending the org's day - not to ration
    // answers the app already had. Counting them meant a user who kept reopening the same summary hit their
    // ceiling having spent nothing.
    //
    // EVERY GENERATIVE ROLE, not the one called `generate`. The ceiling is about the expensive primitive, and
    // which model serves a prompt is a routing detail: `moderate` costs the same order of neurons as
    // `generate` and is reached through the same function. Written as an equality it counted one role and let
    // any other past, so the next user-initiated feature on a second model would have had no per-caller
    // ceiling at all - silently, since nothing about a request says which role answered it. Cron calls carry
    // no `userId` and are already exempt above, so this widens nothing that runs unattended today.
    .where(and(eq(schema.aiUsage.userId, ctx.userId), inArray(schema.aiUsage.role, [...GENERATIVE_ROLES]), eq(schema.aiUsage.cacheHit, false), gte(schema.aiUsage.createdAt, since)));
  const used = Number(rows[0]?.n ?? 0);
  if (used >= perUserHourlyGenerations) {
    return refuse("rate", `hourly AI limit reached (${used}/${perUserHourlyGenerations})`);
  }
  return { ok: true };
}

/**
 * The looser ceiling that applies to answers we already had.
 *
 * A multiple of the generation ceiling rather than a number of its own, so lowering the one in settings
 * lowers both and the relationship between them stays legible: a cache hit is cheap, so you get many more of
 * them, but not unboundedly many. Counts hits ONLY - the generations are counted by `withinUserRate`, and
 * adding them here would make an ordinary session hit this ceiling for having worked.
 */
const CACHED_RATE_MULTIPLE = 10;

async function withinCachedRate(deps: Deps, ctx: AiCallContext): Promise<{ ok: true } | AiRefusal> {
  if (!ctx.userId) return { ok: true };
  const configured = (await aiConfig(deps)).perUserHourlyGenerations;
  const { perUserHourlyGenerations } = limitsOf({ perUserHourlyGenerations: Math.min(configured, BUDGET.perUserHourlyGenerations), ...ctx.limits });
  const ceiling = perUserHourlyGenerations * CACHED_RATE_MULTIPLE;
  if (!Number.isFinite(ceiling)) return { ok: true };
  const since = new Date(deps.clock.now().getTime() - 3_600_000);
  const rows = await deps.db
    .select({ n: sql<number>`count(*)` })
    .from(schema.aiUsage)
    .where(and(eq(schema.aiUsage.userId, ctx.userId), eq(schema.aiUsage.cacheHit, true), gte(schema.aiUsage.createdAt, since)));
  const used = Number(rows[0]?.n ?? 0);
  if (used >= ceiling) return refuse("rate", `hourly AI limit reached (${used}/${ceiling} cached answers)`);
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------------------------------------

const DEFAULT_CACHE_MS = 7 * 24 * 3_600_000;

async function cacheGet(deps: Deps, key: string): Promise<string | null> {
  const [row] = await deps.db
    .select({ uuid: schema.aiCache.uuid, output: schema.aiCache.output, expiresAt: schema.aiCache.expiresAt })
    .from(schema.aiCache)
    .where(eq(schema.aiCache.cacheKey, key))
    .limit(1);
  if (!row) return null;
  if (row.expiresAt.getTime() <= deps.clock.now().getTime()) return null; // swept nightly; ignored meanwhile
  // Best-effort hit counter: it tells us which features the cache is actually earning its keep on, and a
  // failed increment must never cost the caller the answer it already has.
  try {
    await deps.db.update(schema.aiCache).set({ hits: sql`${schema.aiCache.hits} + 1` }).where(eq(schema.aiCache.uuid, row.uuid));
  } catch (e) {
    console.error("ai cache hit counter failed", e);
  }
  return row.output;
}

async function cachePut(deps: Deps, key: string, feature: string, output: string, ttlMs: number): Promise<void> {
  try {
    await deps.db
      .insert(schema.aiCache)
      .values({ cacheKey: key, feature, output, expiresAt: new Date(deps.clock.now().getTime() + ttlMs) })
      .onConflictDoUpdate({ target: schema.aiCache.cacheKey, set: { output, expiresAt: new Date(deps.clock.now().getTime() + ttlMs) } });
  } catch (e) {
    // A cache write is an optimisation. Losing one costs a future inference, not this answer.
    console.error("ai cache write failed", e);
  }
}

// ---------------------------------------------------------------------------------------------------------
// The trail
// ---------------------------------------------------------------------------------------------------------

/** Run one inference, and record it whatever happens - including when it throws, because a model that fails
 *  every call is invisible in a table that only records successes. */
async function runRecorded<T>(
  deps: Deps,
  ctx: AiCallContext,
  role: ModelRole,
  input: string,
  neurons: number,
  fn: () => Promise<{ value: T; outputChars: number }>,
): Promise<AiResult<T>> {
  const inputHash = await sha256Hex(input);
  const started = deps.clock.now().getTime();
  try {
    const { value, outputChars } = await fn();
    await recordUsage(deps, ctx, role, { inputHash, inputChars: input.length, outputChars, neurons, cacheHit: false, outcome: "ok", durationMs: deps.clock.now().getTime() - started });
    return { ok: true, value, cached: false };
  } catch (e) {
    const detail = (e as Error).message;
    // A failed call still consumed the allocation - the platform charges for the attempt, not the outcome -
    // so it is charged here too. Recording a failure as free would let a broken model be retried all day.
    await recordUsage(deps, ctx, role, { inputHash, inputChars: input.length, outputChars: 0, neurons, cacheHit: false, outcome: "error", durationMs: deps.clock.now().getTime() - started, error: safeError(detail) });
    console.error(`ai ${ctx.feature} (${role}) failed ${safeError(detail)}`);
    return refuse("error", detail);
  }
}

/**
 * A provider error, bounded and stripped of anything that looks like the prompt coming back.
 *
 * `error` is the one column on this table that can carry text the caller sent. Two lines above the insert the
 * file says "the hash, never the text", and that holds for `input_hash` and did not hold here: a provider
 * that quotes what it was given - "input exceeds N tokens: <prompt>", a validation failure that echoes the
 * offending message - lands in the column whole, and in Workers Logs with it. Today's Workers AI errors are
 * short and echo nothing, so this is a leak waiting on somebody else's error message rather than a live one.
 *
 * The fence delimiters are what untrusted employee text travels inside (domain/aiPolicy.ts), so an error
 * containing one is an error containing a post, a CV or a ticket. Anything from the first delimiter on is
 * dropped, and what is left is cut to a couple of hundred characters.
 */
const ERROR_CHARS = 200;
function safeError(message: string): string {
  const cut = message.search(/<<<UNTRUSTED_CONTENT|UNTRUSTED_CONTENT>>>/);
  const head = cut === -1 ? message : `${message.slice(0, cut).trimEnd()} [content removed]`;
  return head.length > ERROR_CHARS ? `${head.slice(0, ERROR_CHARS).trimEnd()}...` : head;
}

type UsageFacts = {
  inputHash: string;
  inputChars: number;
  outputChars: number;
  neurons: number;
  cacheHit: boolean;
  outcome: "ok" | "error" | "refused" | "budget";
  durationMs: number;
  error?: string;
};

async function recordUsage(deps: Deps, ctx: AiCallContext, role: ModelRole, f: UsageFacts): Promise<void> {
  noteSpend(deps, f.neurons, !ctx.userId);
  try {
    await deps.db.insert(schema.aiUsage).values({
      feature: ctx.feature,
      model: MODELS[role],
      role,
      userId: ctx.userId ?? null,
      subject: ctx.subject ?? null,
      // The hash, never the text. Storing the prompt would rebuild inside our own database exactly the
      // retained copy of salary and review text that lib/ai.ts suppresses at the gateway.
      inputHash: f.inputHash,
      inputChars: f.inputChars,
      outputChars: f.outputChars,
      estimatedNeurons: f.neurons,
      cacheHit: f.cacheHit,
      durationMs: f.durationMs,
      outcome: f.outcome,
      error: f.error ?? null,
    });
  } catch (e) {
    // The ledger must not be able to fail the feature it observes.
    console.error("ai usage row failed", e);
  }
}

/**
 * Delete cache entries past their expiry. `cacheGet` already ignores an expired row, so this is table hygiene
 * rather than the enforcement - but without it the table grows for the life of the deployment, and it holds
 * generated text about real records.
 *
 * LOOPS TO A BUDGET rather than deleting one batch. At one batch of 500 a night, a modest org generating
 * twenty answers per person per hour outruns the sweep and the table grows anyway - which is the exact
 * outcome the paragraph above says the sweep exists to prevent. The ceiling is on the whole pass, so a
 * deployment that has fallen behind catches up over a few nights instead of never.
 */
const CACHE_SWEEP_BATCH = 500;
const CACHE_SWEEP_MAX = 20_000;

export async function sweepAiCache(deps: Deps): Promise<number> {
  let swept = 0;
  while (swept < CACHE_SWEEP_MAX) {
    const stale = await deps.db
      .select({ uuid: schema.aiCache.uuid })
      .from(schema.aiCache)
      .where(lt(schema.aiCache.expiresAt, deps.clock.now()))
      .limit(CACHE_SWEEP_BATCH);
    if (stale.length === 0) break;
    await deps.db.delete(schema.aiCache).where(inArray(schema.aiCache.uuid, stale.map((r) => r.uuid)));
    swept += stale.length;
    if (stale.length < CACHE_SWEEP_BATCH) break;
  }
  return swept;
}

/**
 * Drop usage rows past the retention window.
 *
 * WHY THERE IS A WINDOW AT ALL. `ai_usage` is the larger of the two AI tables - a row per inference AND a row
 * per cache hit - and each one carries `user_id` and `subject` = "<collection>/<uuid>". Together that is a
 * permanent per-person record of which employee had a model consulted about which record, going back to
 * deployment. The table's stated job is to answer "what was sent to a model, by whom, about what" A YEAR
 * LATER, and "a year later" is the half that had no code behind it. `lib/ai.ts` names precisely this hazard
 * about the gateway: a retained copy "with its own lifetime and its own deletion story".
 *
 * HOW LONG, AND WHY THAT LONG. `USAGE_RETENTION_DAYS` is thirteen months, which is the table's own promise
 * ("a year later") plus a month, so the answer is still there for somebody asking about this time last year
 * and the record does not accumulate for ever behind it. It is a constant rather than a setting because it is
 * the one number here an org must not be able to set to "never".
 *
 * Bounded per pass for the same reason the cache sweep is, and by the same `ai_usage_spend_idx` on
 * `created_at` that the budget check reads by.
 */
const USAGE_SWEEP_BATCH = 500;
const USAGE_SWEEP_MAX = 20_000;

export async function sweepAiUsage(deps: Deps): Promise<number> {
  const cutoff = new Date(deps.clock.now().getTime() - USAGE_RETENTION_DAYS * 86_400_000);
  let swept = 0;
  while (swept < USAGE_SWEEP_MAX) {
    const stale = await deps.db
      .select({ uuid: schema.aiUsage.uuid })
      .from(schema.aiUsage)
      .where(lt(schema.aiUsage.createdAt, cutoff))
      .limit(USAGE_SWEEP_BATCH);
    if (stale.length === 0) break;
    await deps.db.delete(schema.aiUsage).where(inArray(schema.aiUsage.uuid, stale.map((r) => r.uuid)));
    swept += stale.length;
    if (stale.length < USAGE_SWEEP_BATCH) break;
  }
  return swept;
}

// ---------------------------------------------------------------------------------------------------------

const utcMidnight = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

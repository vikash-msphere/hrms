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
  return { ...raw, features: { ...AI_CONFIG_DEFAULT.features, ...(raw.features ?? {}) } };
}

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

/** What every call through this file identifies itself as. `subject` is what makes the usage row answer
 *  "what was sent to a model about whom" a year later, so it is worth passing wherever there is one. */
export type AiCallContext = {
  feature: string; // "search.embed", "tickets.triage", "announcements.draft"
  userId?: string | null; // null/absent = a cron or system call
  subject?: string; // "<collection>/<uuid>"
  collection?: string; // checked against the denylist before anything is sent
  subresource?: string;
  limits?: Partial<AiLimits>;
};

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
  if (ctx.collection) assertMayReachModel(ctx.collection, ctx.subresource);
  if (!deps.ai) return refuse("unavailable", "no AI binding on this deployment");
  if (texts.length === 0) return { ok: true, value: [], cached: false };

  const cost = ESTIMATED_NEURONS.embed * texts.length;
  const budget = await withinDailyBudget(deps, cost, ctx.limits);
  if (!budget.ok) return budget;

  // `cost`, not the per-call estimate: the budget check scales with the batch, so the ledger has to as well.
  // Charging a 200-row embed batch one neuron would let the checked ceiling and the recorded spend diverge by
  // two orders of magnitude, and the check reads the ledger - so the ceiling would stop meaning anything.
  return runRecorded(deps, ctx, "embed", texts.join("\n"), cost, async () => {
    const vectors = await deps.ai!.embed(texts);
    return { value: vectors, outputChars: vectors.length };
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
  if (ctx.collection) assertMayReachModel(ctx.collection, ctx.subresource);
  if (!deps.ai) return refuse("unavailable", "no AI binding on this deployment");

  // Which model answers, and therefore what it costs and what the ledger says it was. Defaulting here rather
  // than at each call site keeps the three in step: a caller that names a role cannot end up charged for one
  // model and answered by another.
  const role = req.role ?? "generate";
  // The role is IN THE CACHE KEY. Two models asked the same question give different answers, and without it
  // a moderation verdict and a draft built from identical text would share one cached reply.
  const key = await sha256Hex(`${ctx.feature}|${role}|${req.promptVersion}|${req.system}|${req.user}`);
  const hit = await cacheGet(deps, key);
  if (hit !== null) {
    // Recorded, with `cacheHit` set: a cache hit is still a use of the feature, and leaving it out of the
    // trail would make the usage picture flatter than reality and the accountability answer incomplete.
    await recordUsage(deps, ctx, role, { inputHash: key, inputChars: req.user.length, outputChars: hit.length, neurons: 0, cacheHit: true, outcome: "ok", durationMs: 0 });
    return { ok: true, value: hit, cached: true };
  }

  const rate = await withinUserRate(deps, ctx);
  if (!rate.ok) return rate;
  const budget = await withinDailyBudget(deps, ESTIMATED_NEURONS[role], ctx.limits);
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
  if (ctx.collection) assertMayReachModel(ctx.collection, ctx.subresource);
  if (!deps.ai) return refuse("unavailable", "no AI binding on this deployment");
  if (candidates.length === 0) return { ok: true, value: [], cached: false };

  const budget = await withinDailyBudget(deps, ESTIMATED_NEURONS.rerank, ctx.limits);
  if (!budget.ok) return budget;

  return runRecorded(deps, ctx, "rerank", `${query}\n${candidates.join("\n")}`, ESTIMATED_NEURONS.rerank, async () => {
    const ranked = await deps.ai!.rerank(query, candidates);
    return { value: ranked, outputChars: ranked.length };
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
async function withinDailyBudget(deps: Deps, cost: number, over?: Partial<AiLimits>): Promise<{ ok: true } | AiRefusal> {
  // The org's configured ceiling, unless the caller passed a tighter one for this call. Clamped to the
  // constant in domain/aiPolicy.ts: settings may LOWER the budget, never raise it, because the number above
  // it is Cloudflare's account-wide free allocation and this app cannot grant itself more of that.
  const configured = (await aiConfig(deps)).dailyNeurons;
  const { dailyNeurons } = limitsOf({ dailyNeurons: Math.min(configured, BUDGET.dailyNeurons), ...over });
  const rows = await deps.db
    .select({ spent: sql<number>`coalesce(sum(${schema.aiUsage.estimatedNeurons}), 0)` })
    .from(schema.aiUsage)
    .where(gte(schema.aiUsage.createdAt, utcMidnight(deps.clock.now())));
  const spent = Number(rows[0]?.spent ?? 0);
  if (spent + cost > dailyNeurons) {
    return refuse("budget", `daily AI budget spent (${spent}/${dailyNeurons} neurons)`);
  }
  return { ok: true };
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
    await recordUsage(deps, ctx, role, { inputHash, inputChars: input.length, outputChars: 0, neurons, cacheHit: false, outcome: "error", durationMs: deps.clock.now().getTime() - started, error: detail });
    console.error(`ai ${ctx.feature} (${role}) failed`, e);
    return refuse("error", detail);
  }
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

/** Delete cache entries past their expiry. `cacheGet` already ignores an expired row, so this is table
 *  hygiene rather than the enforcement - but without it the table grows for the life of the deployment, and
 *  it holds generated text about real records. */
export async function sweepAiCache(deps: Deps): Promise<number> {
  const stale = await deps.db
    .select({ uuid: schema.aiCache.uuid })
    .from(schema.aiCache)
    .where(lt(schema.aiCache.expiresAt, deps.clock.now()))
    .limit(500);
  if (stale.length === 0) return 0;
  await deps.db.delete(schema.aiCache).where(inArray(schema.aiCache.uuid, stale.map((r) => r.uuid)));
  return stale.length;
}

// ---------------------------------------------------------------------------------------------------------

const utcMidnight = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

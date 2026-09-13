import { eq, and, asc, desc, inArray, isNull, isNotNull, notInArray, sql } from "drizzle-orm";
import { applyScope } from "./listScope";
import { scopeFor, type ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, fieldDiff, noteMeta, stateMeta } from "../lib/audit";
import { invalidArgument, notFound, failedPrecondition } from "../lib/errors";
import { keysetPage } from "./keysetPage";
import { byIdChunks } from "../lib/dbBatch";
import { notify, managerIdOf } from "./notifications";
import { getSettingValue } from "./settings";
import { documentLetterhead, type LetterheadMedia, type OrgWithDocumentLogos } from "./letterheads";
import { DEFAULT_PERFORMANCE, competenciesForCycle, competencyScore, goalAttainment, type GoalSnapshot, type GoalVerdict, type PerformanceFramework } from "../domain/performance";
import { renderLetterPdf, type LetterBlock } from "../lib/letterPdf";
import { formatLongDate } from "../lib/pdfPrimitives";
import { orgToday, dayStartMs } from "./orgDay";

const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
type State = typeof schema.reviews.$inferSelect.state;
const NEXT: Record<State, State | null> = { SELF: "MANAGER", MANAGER: "SHARED", SHARED: "ACKNOWLEDGED", ACKNOWLEDGED: null };

export async function listReviews(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, cycle?: string, stateFilter?: string) {
  const conds = [applyScope(scope, schema.reviews.code, schema.reviews.employeeId)];
  const cycleId = idFromPath(cycle);
  if (cycleId) conds.push(eq(schema.reviews.cycleId, cycleId));
  if (stateFilter) conds.push(eq(schema.reviews.state, stateFilter as State));
  // Reviews have no delete_time of their own: they live and die with their cycle. Soft-deleting a cycle must
  // therefore take its reviews off the list too, or every enrolled employee keeps a nameless, un-dated review
  // card for a cycle that no longer exists (restoring the cycle brings them back).
  const dead = (await deps.db.select({ uuid: schema.reviewCycles.uuid }).from(schema.reviewCycles).where(isNotNull(schema.reviewCycles.deleteTime))).map((c) => c.uuid);
  if (dead.length) conds.push(notInArray(schema.reviews.cycleId, dead));
  return keysetPage(deps, schema.reviews, "reviews", and(...conds.filter(Boolean)), { max: maxPageSize, pageToken });
}


/**
 * Who owes the write-up on this review: the assigned reviewer, else the employee's manager.
 *
 * One function rather than an inlined `managerIdOf` at each site, because "who is this review's reviewer" is
 * asked in five places (the hand-off after the self stage, the nudge, the acknowledgement note, the scheduled
 * metric, and the assignment itself) and an override that only some of them honoured would be worse than no
 * override at all.
 */
export async function reviewerIdOf(deps: Deps, row: { employeeId: string; reviewerId: string | null }): Promise<string | null> {
  return row.reviewerId ?? (await managerIdOf(deps, row.employeeId));
}

/**
 * Point one review at a specific reviewer, or clear it back to the manager chain.
 *
 * The write-up used to fall to `managerIdOf()` and nowhere else. A transfer mid-cycle, a matrix report or a
 * manager on long leave left one fix: re-parent the employee, which changes approvals, list scopes and the
 * org chart in order to solve a review. This is the narrow version of that.
 *
 * Allowed at any stage. A review already SHARED keeps its reviewer as a record of who actually wrote it, so
 * re-pointing one is refused rather than quietly rewriting history.
 */
export async function assignReviewer(deps: Deps, actor: AppUser, id: string, reviewer?: string | null) {
  const row = (await deps.db.select().from(schema.reviews).where(eq(schema.reviews.uuid, id)).limit(1))[0];
  if (!row) throw notFound("review not found");
  if (row.state === "SHARED" || row.state === "ACKNOWLEDGED") {
    throw failedPrecondition("this review is already shared - its reviewer is part of the record");
  }
  const reviewerId = idFromPath(reviewer) ?? null;
  if (reviewerId) {
    if (reviewerId === row.employeeId) throw invalidArgument("somebody cannot be their own reviewer");
    const emp = (await deps.db.select({ del: schema.employees.deleteTime, status: schema.employees.status }).from(schema.employees).where(eq(schema.employees.uuid, reviewerId)).limit(1))[0];
    if (!emp || emp.del) throw invalidArgument("reviewer not found");
    if (emp.status !== "active") throw invalidArgument("that person is not an active employee");
  }
  const updated = (await deps.db.update(schema.reviews).set({ reviewerId, updatedAt: new Date() }).where(eq(schema.reviews.uuid, id)).returning())[0]!;
  await audit(deps, actor, "review.assignReviewer", "reviews", id, {
    employee: `employees/${row.employeeId}`,
    diff: { reviewerId: { from: row.reviewerId ? `employees/${row.reviewerId}` : null, to: reviewerId ? `employees/${reviewerId}` : null } },
  }, updated);
  // Being handed somebody else's review is not something to discover at the deadline.
  if (reviewerId && reviewerId !== actor.employeeId) {
    await notify(deps, {
      recipient: reviewerId,
      type: "review.reviewer_assigned",
      title: "You were assigned a review to write",
      body: "You have been named the reviewer on a colleague's performance review.",
      link: `reviews/${id}`,
      subject: `reviews/${id}`,
      action: "respond",
      actorId: actor.employeeId,
    });
  }
  return updated;
}

// ---- The cycle's goals, as a review reads them ----

const goalCols = {
  code: schema.goals.code,
  uuid: schema.goals.uuid,
  title: schema.goals.title,
  weight: schema.goals.weight,
  progress: schema.goals.progress,
  status: schema.goals.status,
  stage: schema.goals.stage,
  retro: schema.goals.retro,
  dueDate: schema.goals.dueDate,
  targetValue: schema.goals.targetValue,
  currentValue: schema.goals.currentValue,
};
type GoalRow = {
  code: string; uuid: string; title: string; weight: number; progress: number;
  status: GoalSnapshot["status"]; stage: "DRAFT" | "PROPOSED" | "AGREED"; retro: string | null; dueDate: Date | null;
  targetValue: number | null; currentValue: number | null;
};
const toSnapshot = (g: GoalRow): GoalSnapshot => ({
  code: g.code,
  path: `goals/${g.uuid}`,
  title: g.title,
  weight: g.weight ?? 0,
  progress: g.progress ?? 0,
  status: g.status,
  ...(g.dueDate ? { due_date: new Date(g.dueDate).toISOString().slice(0, 10) } : {}),
  // Same rule the goal resource states: a measure owns its progress, so the review must not offer to type over
  // it during the self stage (see services/goals.ts#measuredProgress).
  ...(g.targetValue != null && g.currentValue != null ? { measured: true } : {}),
  // Only when it was never agreed. A review scoring a draft should say so on its face rather than presenting
  // it as an objective both sides signed up to.
  ...(g.stage !== "AGREED" ? { stage: g.stage } : {}),
  ...(g.retro?.trim() ? { retro: g.retro.trim() } : {}),
});

// A stored snapshot, defensively parsed: a blob that isn't an array of goals reads as no goals rather than
// breaking the review it rides on.
function parseSnapshot(json: string | null): GoalSnapshot[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v.filter((g) => g && typeof g.code === "string" && typeof g.title === "string") as GoalSnapshot[]) : [];
  } catch {
    return [];
  }
}

export function parseGoalVerdicts(json: string | null): Record<string, GoalVerdict> {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, GoalVerdict>) : {};
  } catch {
    return {};
  }
}

/**
 * A share of somebody else's goal, as this reviewee's review counts it.
 *
 * The weight is scaled to the share, so the attainment arithmetic needs no special case: a 40% share of a
 * 100-weight goal is a 40-weight line in this person's set. Cross-team work therefore scores once, in both
 * reviews, at the split the two managers agreed - instead of counting for nobody or being typed up twice.
 */
function contributedSnapshot(g: GoalRow & { ownerId: string }, share: number): GoalSnapshot {
  const base = toSnapshot(g);
  return {
    ...base,
    weight: Math.round((base.weight * clampShare(share)) / 100),
    contribution: { share, owner: `employees/${g.ownerId}` },
  };
}

const clampShare = (n: number) => Math.max(0, Math.min(100, Math.round(n || 0)));

/**
 * The reviewee's OWN goal, with the weight the contributors did not take.
 *
 * `setGoalContributors` states the model plainly: "the goal's owner is not one of its contributors - their
 * share is what the others do not take". The snapshot did not implement that half. The owner's line carried
 * the goal's FULL weight while every contributor also carried `weight x share`, so a goal 40% credited away
 * was scored at 140% of its weight across the org - and the surplus landed on the owner, inflating their
 * attainment and, through services/variablePay.ts, the bonus priced off it. Splitting credit has to subtract
 * it from somebody, and the owner is who the split says it comes from.
 *
 * A goal nobody contributed to keeps its weight exactly (taken = 0, a no-op), which is every goal in an org
 * that does not use contributors.
 */
function ownedSnapshot(g: GoalRow, takenShare: number): GoalSnapshot {
  const base = toSnapshot(g);
  const taken = clampShare(takenShare);
  return taken > 0 ? { ...base, weight: Math.round((base.weight * (100 - taken)) / 100) } : base;
}

/**
 * How much of each goal's credit has been given away to contributors, summed per goal.
 *
 * Keyed by GOAL, not by contributor: what the owner's weight has to be reduced by is the whole split, which
 * includes shares held by people outside the set being read. Clamped in `clampShare` at the point of use -
 * the service caps a split at 100% on write, and a row from before that cap must not produce a negative
 * weight here.
 */
async function takenSharesFor(deps: Deps, goalIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = [...new Set(goalIds.filter(Boolean))];
  if (!ids.length) return out;
  const rows = (await byIdChunks(ids, (group) =>
    deps.db
      .select({ goalId: schema.goalContributors.goalId, taken: sql<number>`coalesce(sum(${schema.goalContributors.share}), 0)` })
      .from(schema.goalContributors)
      .where(inArray(schema.goalContributors.goalId, group))
      .groupBy(schema.goalContributors.goalId),
  )) as { goalId: string; taken: number | null }[];
  for (const r of rows) out.set(r.goalId, Number(r.taken ?? 0));
  return out;
}

// The goals a cycle scores for one person: their own, plus their share of anybody else's they contributed to.
// Heaviest first. Unscoped on purpose - this is the answer to "what did this cycle ask of this person", used
// when freezing the snapshot and when rendering the PDF, both of which act for the review rather than a reader.
export async function cycleGoals(deps: Deps, employeeId: string, cycleId: string): Promise<GoalSnapshot[]> {
  const own = (await deps.db
    .select(goalCols)
    .from(schema.goals)
    .where(and(eq(schema.goals.cycleId, cycleId), eq(schema.goals.employeeId, employeeId), isNull(schema.goals.deleteTime)))
    .orderBy(desc(schema.goals.weight), asc(schema.goals.createdAt))) as GoalRow[];
  const shared = (await deps.db
    .select({ ...goalCols, ownerId: schema.goals.employeeId, share: schema.goalContributors.share })
    .from(schema.goalContributors)
    .innerJoin(schema.goals, eq(schema.goals.uuid, schema.goalContributors.goalId))
    .where(and(
      eq(schema.goalContributors.employeeId, employeeId),
      eq(schema.goals.cycleId, cycleId),
      isNull(schema.goals.deleteTime),
    ))) as (GoalRow & { ownerId: string; share: number })[];
  const taken = await takenSharesFor(deps, own.map((g) => g.uuid));
  return [...own.map((g) => ownedSnapshot(g, taken.get(g.uuid) ?? 0)), ...shared.map((g) => contributedSnapshot(g, g.share))]
    .sort((a, b) => b.weight - a.weight);
}

/**
 * `cycleGoals` for a whole cycle at once: two reads, whatever the headcount.
 *
 * The per-person form above costs two reads EACH, which is fine where it is used (freezing one snapshot,
 * rendering one PDF) and is not where a caller walks the cycle. The variable-pay run does exactly that -
 * every reviewee of a cycle, in one request, to price a payout - so on a two-hundred-person cycle it spent
 * four hundred round-trips against an invocation's subrequest budget and stopped working at whatever size
 * crossed it. Same rows, same shape, same order; one query for the owned goals and one for the contributed
 * shares, chunked under D1's bound-parameter cap. (Three reads now: the owned goals, the shares taken OFF
 * them, and the shares this set holds in OTHER people's goals - the middle one is grouped in SQL, so it is a
 * read per chunk rather than per person.)
 */
export async function cycleGoalsFor(deps: Deps, employeeIds: string[], cycleId: string): Promise<Map<string, GoalSnapshot[]>> {
  const out = new Map<string, GoalSnapshot[]>();
  const ids = [...new Set(employeeIds.filter(Boolean))];
  if (!ids.length) return out;
  for (const id of ids) out.set(id, []);

  const own = (await byIdChunks(ids, (group) =>
    deps.db
      .select({ ...goalCols, employeeId: schema.goals.employeeId })
      .from(schema.goals)
      .where(and(eq(schema.goals.cycleId, cycleId), inArray(schema.goals.employeeId, group), isNull(schema.goals.deleteTime)))
      .orderBy(desc(schema.goals.weight), asc(schema.goals.createdAt)),
  )) as (GoalRow & { employeeId: string })[];
  const taken = await takenSharesFor(deps, own.map((g) => g.uuid));
  for (const g of own) out.get(g.employeeId)?.push(ownedSnapshot(g, taken.get(g.uuid) ?? 0));

  const shared = (await byIdChunks(ids, (group) =>
    deps.db
      .select({ ...goalCols, contributorId: schema.goalContributors.employeeId, ownerId: schema.goals.employeeId, share: schema.goalContributors.share })
      .from(schema.goalContributors)
      .innerJoin(schema.goals, eq(schema.goals.uuid, schema.goalContributors.goalId))
      .where(and(
        inArray(schema.goalContributors.employeeId, group),
        eq(schema.goals.cycleId, cycleId),
        isNull(schema.goals.deleteTime),
      )),
  )) as (GoalRow & { contributorId: string; ownerId: string; share: number })[];
  for (const g of shared) out.get(g.contributorId)?.push(contributedSnapshot(g, g.share));

  for (const list of out.values()) list.sort((a, b) => b.weight - a.weight);
  return out;
}

/**
 * The goals to show on a page of reviews, in ONE query, keyed by review id.
 *
 * A shared review answers from its frozen snapshot (see schema `goalsJson`) so the record stays the record;
 * anything earlier reads the goals live, because the whole point of the panel before the manager stage is to
 * show where the goals stand right now.
 *
 * ACCESS. The live read is bound to the caller's own `goals` scope, not the review's. Reading a review of
 * someone in your department does not by itself entitle you to their goal list, so a caller whose goals scope
 * doesn't reach this employee gets a review with no goals panel instead of one that leaks their objectives.
 * The snapshot is exempt: once shared, it IS part of the review the caller is allowed to read.
 */
export async function goalsForReviews(
  deps: Deps,
  actor: AppUser,
  rows: { uuid: string; employeeId: string; cycleId: string; goalsJson: string | null }[],
): Promise<Map<string, GoalSnapshot[]>> {
  const out = new Map<string, GoalSnapshot[]>();
  const live: typeof rows = [];
  for (const r of rows) {
    if (r.goalsJson) out.set(r.uuid, parseSnapshot(r.goalsJson));
    else live.push(r);
  }
  if (!live.length) return out;
  const goals = (await deps.db
    .select({ ...goalCols, employeeId: schema.goals.employeeId, cycleId: schema.goals.cycleId })
    .from(schema.goals)
    .where(and(
      applyScope(scopeFor(actor, "goals"), schema.goals.code, schema.goals.employeeId),
      inArray(schema.goals.cycleId, [...new Set(live.map((r) => r.cycleId))]),
      inArray(schema.goals.employeeId, [...new Set(live.map((r) => r.employeeId))]),
      isNull(schema.goals.deleteTime),
    ))
    .orderBy(desc(schema.goals.weight), asc(schema.goals.createdAt))) as (GoalRow & { employeeId: string; cycleId: string | null })[];
  // Same owner-share reduction the frozen snapshot applies, so a live review and the one it becomes when it is
  // shared quote the same weight for the same goal.
  const taken = await takenSharesFor(deps, goals.map((g) => g.uuid));
  const byPair = new Map<string, GoalSnapshot[]>();
  for (const g of goals) {
    const key = `${g.cycleId}\u0000${g.employeeId}`;
    (byPair.get(key) ?? byPair.set(key, []).get(key)!).push(ownedSnapshot(g, taken.get(g.uuid) ?? 0));
  }
  for (const r of live) out.set(r.uuid, byPair.get(`${r.cycleId}\u0000${r.employeeId}`) ?? []);
  return out;
}

export type AttainmentPoint = { cycle: string; name: string; period_end?: string; attainment: number; rating?: number };

/**
 * One person's attainment over their last few cycles - the trend a single number cannot show.
 *
 * 68% is a different conversation depending on whether last year was 40% or 90%, and until now every review
 * was read in isolation. Built from the FROZEN snapshots, so it is the history as each review recorded it
 * rather than a re-derivation from goals that have moved since.
 *
 * Only shared reviews count: an in-flight one has no settled score, and putting a half-finished cycle on a
 * trend line makes the line say something nobody agreed to.
 */
export async function attainmentTrend(deps: Deps, employeeId: string, limit = 6): Promise<AttainmentPoint[]> {
  const rows = (await deps.db
    .select({
      cycleId: schema.reviews.cycleId,
      goalsJson: schema.reviews.goalsJson,
      rating: schema.reviews.overallRating,
      state: schema.reviews.state,
      name: schema.reviewCycles.name,
      periodEnd: schema.reviewCycles.periodEnd,
      deleteTime: schema.reviewCycles.deleteTime,
    })
    .from(schema.reviews)
    .innerJoin(schema.reviewCycles, eq(schema.reviewCycles.uuid, schema.reviews.cycleId))
    .where(and(eq(schema.reviews.employeeId, employeeId), inArray(schema.reviews.state, ["SHARED", "ACKNOWLEDGED"])))) as {
      cycleId: string; goalsJson: string | null; rating: number | null; state: string; name: string; periodEnd: Date | null; deleteTime: Date | null;
    }[];
  const points: AttainmentPoint[] = [];
  for (const r of rows) {
    if (r.deleteTime || !r.goalsJson) continue;
    const attained = goalAttainment(parseSnapshot(r.goalsJson));
    if (!attained) continue;
    points.push({
      cycle: `review-cycles/${r.cycleId}`,
      name: r.name,
      ...(r.periodEnd ? { period_end: new Date(r.periodEnd).toISOString().slice(0, 10) } : {}),
      attainment: attained.score,
      ...(r.rating != null ? { rating: r.rating } : {}),
    });
  }
  // Oldest first, so a chart reads left to right; the cap keeps the newest few.
  points.sort((a, b) => (a.period_end ?? "").localeCompare(b.period_end ?? ""));
  return points.slice(-limit);
}

async function loadInState(deps: Deps, id: string, required: State): Promise<typeof schema.reviews.$inferSelect> {
  const row = (await deps.db.select().from(schema.reviews).where(eq(schema.reviews.uuid, id)).limit(1))[0];
  if (!row) throw notFound("review not found");
  if (row.state !== required) throw failedPrecondition(`this review is not in the ${required.toLowerCase()} stage`);
  return row;
}
// Guards the write on the state the caller validated (`from`) so a stage advance is EXACTLY-ONCE: a
// double-clicked/concurrent submit that also read that state loses here (0 rows) instead of both firing
// the stage-handoff notification twice.
async function applyState(deps: Deps, id: string, from: State, set: Record<string, unknown>) {
  const updated = (await deps.db.update(schema.reviews).set({ ...set, updatedAt: new Date() }).where(and(eq(schema.reviews.uuid, id), eq(schema.reviews.state, from))).returning())[0];
  if (!updated) throw failedPrecondition("this review has already moved past that stage");
  return updated;
}

// SELF -> MANAGER: the employee records their self-assessment (comment + optional per-competency self ratings).
export async function submitSelf(deps: Deps, actor: AppUser, id: string, selfComment?: string | null, selfRatings?: Record<string, number>) {
  await loadInState(deps, id, "SELF");
  // Self ratings are competency-key -> number, like the manager's; drop non-numeric values defensively.
  const ratings = selfRatings && typeof selfRatings === "object"
    ? Object.fromEntries(Object.entries(selfRatings).filter(([, v]) => typeof v === "number" && !Number.isNaN(v)))
    : null;
  const row = await applyState(deps, id, "SELF", {
    selfComment: selfComment?.trim() || null,
    selfRatingsJson: ratings && Object.keys(ratings).length ? JSON.stringify(ratings) : null,
    state: "MANAGER",
  });
  await audit(deps, actor, "review.submitSelf", "reviews", id, stateMeta("SELF", "MANAGER", { employee: `employees/${row.employeeId}` }), row);
  // Hand the review to whoever owes the write-up: the assigned reviewer, else the employee's manager.
  const reviewerId = await reviewerIdOf(deps, row);
  if (reviewerId) await notify(deps, { recipient: reviewerId, type: "review.self_submitted", title: "Self-review submitted", body: "A colleague finished their self-assessment. Your review is next.", link: `reviews/${id}`, subject: `reviews/${id}`, action: "respond", actorId: row.employeeId });
  return row;
}

// MANAGER -> SHARED: the manager records ratings + comment and shares the result with the employee.
export async function submitManager(
  deps: Deps,
  actor: AppUser,
  id: string,
  input: { ratings?: Record<string, number>; manager_comment?: string | null; overall_rating?: number | null; goal_ratings?: Record<string, GoalVerdict> },
) {
  const before = await loadInState(deps, id, "MANAGER"); // also the scores this submission replaces, for the audit diff
  // Ratings are competency-key -> number; stored as JSON. Drop non-numeric values defensively.
  const ratings = input.ratings && typeof input.ratings === "object"
    ? Object.fromEntries(Object.entries(input.ratings).filter(([, v]) => typeof v === "number" && !Number.isNaN(v)))
    : {};
  if (input.overall_rating != null && (typeof input.overall_rating !== "number" || Number.isNaN(input.overall_rating))) {
    throw invalidArgument("overall_rating must be a number");
  }
  // The cycle's goals are frozen HERE, at the moment the review is shared, and the manager's per-goal verdicts
  // are kept only for goals in that frozen set - a verdict keyed to a goal the reviewee doesn't hold is either
  // a stale form or a client bug, and either way it has nothing to say about this review.
  const frozen = await cycleGoals(deps, before.employeeId, before.cycleId);
  const codes = new Set(frozen.map((g) => g.code));
  const verdicts = Object.entries(input.goal_ratings ?? {}).reduce<Record<string, GoalVerdict>>((acc, [code, v]) => {
    if (!codes.has(code) || !v || typeof v !== "object") return acc;
    const rating = typeof v.rating === "number" && !Number.isNaN(v.rating) ? v.rating : undefined;
    const comment = typeof v.comment === "string" && v.comment.trim() ? v.comment.trim() : undefined;
    if (rating != null || comment) acc[code] = { ...(rating != null ? { rating } : {}), ...(comment ? { comment } : {}) };
    return acc;
  }, {});
  const row = await applyState(deps, id, "MANAGER", {
    ratingsJson: JSON.stringify(ratings),
    managerComment: input.manager_comment?.trim() || null,
    overallRating: input.overall_rating ?? null,
    goalRatingsJson: Object.keys(verdicts).length ? JSON.stringify(verdicts) : null,
    goalsJson: frozen.length ? JSON.stringify(frozen) : null,
    state: "SHARED",
  });
  // The per-competency scores are the substance of a manager review, and `ratingsJson` was excluded from every
  // diff as a blob. lib/audit expands it for this collection, so `fieldDiff` states each rating that was set.
  const attained = goalAttainment(frozen);
  await audit(deps, actor, "review.submitManager", "reviews", id, stateMeta("MANAGER", "SHARED", {
    employee: `employees/${row.employeeId}`,
    // What the goals said at the moment of sharing. The snapshot makes the review reproducible; this makes the
    // TRAIL reproducible too, so "why was this rated a 3" can be answered without re-deriving anything.
    ...(attained ? { note: `goal attainment ${attained.score}% across ${attained.counted} goal${attained.counted === 1 ? "" : "s"}` } : {}),
    diff: {
      state: { from: "MANAGER", to: "SHARED" },
      overallRating: { from: null, to: input.overall_rating ?? null },
      ...fieldDiff({ ratingsJson: before?.ratingsJson ?? null }, { ratingsJson: row.ratingsJson }, ["ratingsJson"], "reviews"),
    },
  }), row);
  // The result is now shared with the employee to review + acknowledge.
  await notify(deps, { recipient: row.employeeId, type: "review.shared", title: "Your review is ready", body: "Your manager shared your performance review.", link: `reviews/${id}`, subject: `reviews/${id}`, action: "acknowledge", actorId: actor.employeeId });
  return row;
}

// SHARED -> ACKNOWLEDGED: the employee acknowledges they've seen the shared review, optionally with a note
// (context or disagreement) that stays on the review for the manager/HR to see.
export async function acknowledgeReview(deps: Deps, actor: AppUser, id: string, comment?: string | null) {
  await loadInState(deps, id, "SHARED");
  const row = await applyState(deps, id, "SHARED", { state: "ACKNOWLEDGED", ackComment: comment?.trim() || null });
  // The comment stays on the review (where the manager and HR read it) and out of the trail: it is what an
  // employee writes back about their own performance review, which the serializer treats as narrow throughout.
  await audit(deps, actor, "review.acknowledge", "reviews", id, stateMeta("SHARED", "ACKNOWLEDGED", { employee: `employees/${row.employeeId}`, ...noteMeta("reviews", comment) }), row);
  // A note on the acknowledgement is feedback aimed at the manager - surface it, don't bury it.
  if (comment?.trim()) {
    const reviewerId = await reviewerIdOf(deps, row);
    if (reviewerId) await notify(deps, { recipient: reviewerId, type: "review.acknowledged", title: "Review acknowledged with a note", body: comment.trim().slice(0, 200), link: `reviews/${id}`, subject: `reviews/${id}`, actorId: row.employeeId });
  }
  return row;
}

// Remind whoever owns the review's current stage: the employee in SELF/SHARED, the manager in MANAGER.
// No state change; just a notification from a manager/HR unblocking a stalled review.
export async function nudgeReview(deps: Deps, actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.reviews).where(eq(schema.reviews.uuid, id)).limit(1))[0];
  if (!row) throw notFound("review not found");
  if (row.state === "ACKNOWLEDGED") throw failedPrecondition("this review is already complete");
  const recipient = row.state === "MANAGER" ? await reviewerIdOf(deps, row) : row.employeeId;
  if (!recipient) throw failedPrecondition("this review's current stage has no owner to remind");
  const body = row.state === "SELF" ? "Reminder: your self-assessment is waiting." : row.state === "MANAGER" ? "Reminder: your manager review is waiting." : "Reminder: your shared review is waiting for your acknowledgement.";
  await notify(deps, { recipient, type: "review.nudge", title: "Review reminder", body, link: `reviews/${id}`, subject: `reviews/${id}`, action: "respond", actorId: actor.employeeId });
  // Which stage was nudged, and whose inbox it went to - a reminder with neither is unauditable as chasing.
  await audit(deps, actor, "review.nudge", "reviews", id, { employee: `employees/${recipient}`, note: `at the ${row.state.toLowerCase()} stage` }, row);
  return row;
}

// The finished review as a letter-style PDF (the employee's record copy). Only a SHARED/ACKNOWLEDGED review
// renders - before that the manager assessment is still private to its author, and a PDF is a copy that
// leaves the app, so nothing unshared may be in it. Layout rides the letterhead renderer; content only here.
export async function renderReviewPdf(deps: Deps, _actor: AppUser, id: string, media: LetterheadMedia = "screen"): Promise<{ bytes: Uint8Array; fileName: string }> {
  const row = (await deps.db.select().from(schema.reviews).where(eq(schema.reviews.uuid, id)).limit(1))[0];
  if (!row) throw notFound("review not found");
  if (row.state !== "SHARED" && row.state !== "ACKNOWLEDGED") throw failedPrecondition("only a shared or acknowledged review can be exported");

  const emp = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, row.employeeId)).limit(1))[0];
  const cycle = (await deps.db.select().from(schema.reviewCycles).where(eq(schema.reviewCycles.uuid, row.cycleId)).limit(1))[0];
  const org = await getSettingValue<{ name?: string; legal_name?: string; address?: string; logo?: string } & OrgWithDocumentLogos>(deps, "organization", {});
  // A review export is rendered on demand and never filed, so the print page is chosen per request.
  const letterhead = await documentLetterhead(deps, org, "review", [], media);
  const framework = await getSettingValue<PerformanceFramework>(deps, "performance", DEFAULT_PERFORMANCE);
  // The competencies THIS cycle asked about, not the whole framework: a record copy that lists questions the
  // review never posed reads as five unanswered ratings.
  const competencies = competenciesForCycle(framework.competencies ?? [], cycle?.competencyKeysJson ?? null);
  const scaleLabel = (v: number | null | undefined) => (v == null ? "-" : `${v} (${framework.scale.find((s) => s.value === v)?.label ?? ""})`);

  const empName = emp ? `${emp.firstName} ${emp.lastName}` : "Employee";
  const ratings: Record<string, number> = row.ratingsJson ? JSON.parse(row.ratingsJson) : {};
  const selfRatings: Record<string, number> = row.selfRatingsJson ? JSON.parse(row.selfRatingsJson) : {};
  const hasSelfRatings = Object.keys(selfRatings).length > 0;
  const period = cycle?.periodStart && cycle?.periodEnd
    ? `${formatLongDate(new Date(cycle.periodStart))} to ${formatLongDate(new Date(cycle.periodEnd))}`
    : undefined;

  const paras = (s: string): LetterBlock[] => s.split(/\n{2,}/).map((p) => ({ kind: "para", runs: [p.trim()] as const }) as LetterBlock).filter((b) => (b as any).runs[0]);
  const blocks: LetterBlock[] = [
    { kind: "subject", text: `Performance review: ${cycle?.name ?? "review"}` },
    ...(period ? [{ kind: "para", runs: ["Review period: ", { b: period }] } as LetterBlock] : []),
    {
      kind: "table",
      table: {
        title: "Ratings",
        columns: hasSelfRatings ? ["Competency", "Self", "Manager"] : ["Competency", "Rating"],
        rows: [
          // A weighted framework says so on the face of the record: a 4 on a competency worth three times
          // another one is not the same 4, and a reader six months later has no other way to know.
          ...competencies.map((c) => {
            const label = c.weight ? `${c.label} (weight ${c.weight})` : c.label;
            return hasSelfRatings
              ? [label, selfRatings[c.key] != null ? String(selfRatings[c.key]) : "-", scaleLabel(ratings[c.key])]
              : [label, scaleLabel(ratings[c.key])];
          }),
          // The computed half, next to the manager's own overall below it. Printing only the overall leaves a
          // reader unable to tell a generous rounding from a considered judgement.
          ...(competencyScore(competencies, ratings)
            ? [(() => {
                const cs = competencyScore(competencies, ratings)!;
                const label = cs.weighted ? "Competency score (weighted)" : "Competency score (mean)";
                return hasSelfRatings ? [label, "", String(cs.score)] : [label, String(cs.score)];
              })()]
            : []),
        ],
        total: row.overallRating != null
          ? (hasSelfRatings ? ["Overall", "", scaleLabel(row.overallRating)] : ["Overall", scaleLabel(row.overallRating)])
          : undefined,
      },
    },
  ];
  // The behavioural anchors, when the org has written them. The record copy of a review is read by people who
  // were not in the room - a promotion panel, an appeal, the employee themselves a year later - and a bare
  // "Ownership: 4" means whatever the reader assumes it means.
  const anchored = competencies.filter((c) => c.description?.trim());
  if (anchored.length) {
    blocks.push({
      kind: "table",
      table: {
        title: "What each competency means",
        columns: ["Competency", "Definition"],
        rows: anchored.map((c) => [c.label, c.description!.trim()]),
      },
    });
  }
  // The goals this cycle asked for, as the review froze them, with the manager's verdict on each and the
  // weighted attainment as the total row. A rating on a competency says how someone worked; this says what
  // they delivered, and the record copy is poorer for leaving it out.
  const goals = parseSnapshot(row.goalsJson);
  if (goals.length) {
    const verdicts = parseGoalVerdicts(row.goalRatingsJson);
    const rated = goals.some((g) => verdicts[g.code]?.rating != null);
    const attained = goalAttainment(goals);
    blocks.push({
      kind: "table",
      table: {
        title: "Goals",
        columns: rated ? ["Goal", "Weight", "Progress", "Rating"] : ["Goal", "Weight", "Progress"],
        rows: goals.map((g) => {
          const progress = g.status === "cancelled" ? "cancelled" : `${g.progress}%`;
          const cells = [g.title, g.weight ? String(g.weight) : "-", progress];
          return rated ? [...cells, scaleLabel(verdicts[g.code]?.rating)] : cells;
        }),
        total: attained
          ? (rated
            ? ["Attainment", attained.weighted ? String(attained.weight_total) : "-", `${attained.score}%`, ""]
            : ["Attainment", attained.weighted ? String(attained.weight_total) : "-", `${attained.score}%`])
          : undefined,
      },
    });
    for (const g of goals) {
      // The owner's account of what happened first, then the manager's verdict on it - the order the
      // conversation actually runs in.
      if (g.retro) blocks.push(...paras(`${g.title} - what happened: ${g.retro}`));
      const note = verdicts[g.code]?.comment;
      if (note) blocks.push(...paras(`${g.title}: ${note}`));
    }
  }
  if (row.selfComment) blocks.push({ kind: "subject", text: "Self-assessment" }, ...paras(row.selfComment));
  if (row.managerComment) blocks.push({ kind: "subject", text: "Manager feedback" }, ...paras(row.managerComment));
  if (row.state === "ACKNOWLEDGED") {
    blocks.push({ kind: "note", text: `Acknowledged by ${empName} on ${formatLongDate(new Date(row.updatedAt))}.` });
    if (row.ackComment) blocks.push(...paras(`Acknowledgement note: ${row.ackComment}`));
  }

  const { bytes } = await renderLetterPdf({
    org: { name: org.name || "", address: org.address, logo: org.logo, legalName: org.legal_name || undefined },
    ...(letterhead ? { letterhead } : {}),
    // The org's calendar day. `formatLongDate` reads with `getUTC*`, so `new Date()` printed yesterday for the
    // first hours of an IST morning; the two uses above it format STORED date-only columns, where reading in
    // UTC is correct and stays. See services/orgDay.ts.
    date: formatLongDate(new Date(dayStartMs(await orgToday(deps)))),
    to: { name: empName, lines: cycle?.name ? [cycle.name] : [] },
    blocks,
  });
  const safe = (s: string) => s.replace(/[^\w.-]+/g, "-");
  return { bytes, fileName: `review-${safe(empName)}-${safe(cycle?.name ?? "cycle")}.pdf` };
}

// Skip the current stage: advance one state without filling its content (a stage can always be skipped).
export async function skipReviewStage(deps: Deps, actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.reviews).where(eq(schema.reviews.uuid, id)).limit(1))[0];
  if (!row) throw notFound("review not found");
  const next = NEXT[row.state];
  if (!next) throw failedPrecondition("this review is already complete");
  // Skipping the manager stage still SHARES the review, so the goals freeze here exactly as they do on a
  // submitted one - otherwise a skipped review would keep re-reading live goals and quietly restate itself
  // every quarter.
  const freeze = next === "SHARED" && !row.goalsJson ? await cycleGoals(deps, row.employeeId, row.cycleId) : null;
  const updated = await applyState(deps, id, row.state, { state: next, ...(freeze?.length ? { goalsJson: JSON.stringify(freeze) } : {}) });
  await audit(deps, actor, "review.skipStage", "reviews", id, stateMeta(row.state, next, { employee: `employees/${row.employeeId}` }), updated);
  return updated;
}

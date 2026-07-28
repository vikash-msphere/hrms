import { eq, and } from "drizzle-orm";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { invalidArgument, notFound, failedPrecondition } from "../lib/errors";
import { keysetPage } from "./keysetPage";
import { notify, managerIdOf } from "./notifications";

const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
type State = typeof schema.reviews.$inferSelect.state;
const NEXT: Record<State, State | null> = { SELF: "MANAGER", MANAGER: "SHARED", SHARED: "ACKNOWLEDGED", ACKNOWLEDGED: null };

export async function listReviews(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, cycle?: string, stateFilter?: string) {
  const conds = [applyScope(scope, schema.reviews.code, schema.reviews.employeeId)];
  const cycleId = idFromPath(cycle);
  if (cycleId) conds.push(eq(schema.reviews.cycleId, cycleId));
  if (stateFilter) conds.push(eq(schema.reviews.state, stateFilter as State));
  return keysetPage(deps, schema.reviews, "reviews", and(...conds.filter(Boolean)), { dir: "asc", max: maxPageSize, pageToken });
}

export async function getReview(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.reviews).where(eq(schema.reviews.uuid, id)).limit(1))[0];
  if (!row) throw notFound("review not found");
  return row;
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

// SELF -> MANAGER: the employee records their self-assessment.
export async function submitSelf(deps: Deps, actor: AppUser, id: string, selfComment?: string | null) {
  await loadInState(deps, id, "SELF");
  const row = await applyState(deps, id, "SELF", { selfComment: selfComment?.trim() || null, state: "MANAGER" });
  await audit(deps, actor, "review.submitSelf", "reviews", id);
  // Hand the review to the employee's manager for the manager stage.
  const mgr = await managerIdOf(deps, row.employeeId);
  if (mgr) await notify(deps, { recipient: mgr, type: "review.self_submitted", title: "Self-review submitted", body: "A report finished their self-assessment. Your review is next.", link: "reviews", subject: `reviews/${id}`, action: "respond", actorId: row.employeeId });
  return row;
}

// MANAGER -> SHARED: the manager records ratings + comment and shares the result with the employee.
export async function submitManager(deps: Deps, actor: AppUser, id: string, input: { ratings?: Record<string, number>; manager_comment?: string | null; overall_rating?: number | null }) {
  await loadInState(deps, id, "MANAGER");
  // Ratings are competency-key -> number; stored as JSON. Drop non-numeric values defensively.
  const ratings = input.ratings && typeof input.ratings === "object"
    ? Object.fromEntries(Object.entries(input.ratings).filter(([, v]) => typeof v === "number" && !Number.isNaN(v)))
    : {};
  if (input.overall_rating != null && (typeof input.overall_rating !== "number" || Number.isNaN(input.overall_rating))) {
    throw invalidArgument("overall_rating must be a number");
  }
  const row = await applyState(deps, id, "MANAGER", {
    ratingsJson: JSON.stringify(ratings),
    managerComment: input.manager_comment?.trim() || null,
    overallRating: input.overall_rating ?? null,
    state: "SHARED",
  });
  await audit(deps, actor, "review.submitManager", "reviews", id);
  // The result is now shared with the employee to review + acknowledge.
  await notify(deps, { recipient: row.employeeId, type: "review.shared", title: "Your review is ready", body: "Your manager shared your performance review.", link: "reviews", subject: `reviews/${id}`, action: "acknowledge", actorId: actor.employeeId });
  return row;
}

// SHARED -> ACKNOWLEDGED: the employee acknowledges they've seen the shared review.
export async function acknowledgeReview(deps: Deps, actor: AppUser, id: string) {
  await loadInState(deps, id, "SHARED");
  const row = await applyState(deps, id, "SHARED", { state: "ACKNOWLEDGED" });
  await audit(deps, actor, "review.acknowledge", "reviews", id);
  return row;
}

// Skip the current stage: advance one state without filling its content (a stage can always be skipped).
export async function skipReviewStage(deps: Deps, actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.reviews).where(eq(schema.reviews.uuid, id)).limit(1))[0];
  if (!row) throw notFound("review not found");
  const next = NEXT[row.state];
  if (!next) throw failedPrecondition("this review is already complete");
  const updated = await applyState(deps, id, row.state, { state: next });
  await audit(deps, actor, "review.skipStage", "reviews", id);
  return updated;
}

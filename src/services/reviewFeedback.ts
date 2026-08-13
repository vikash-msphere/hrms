import { eq, and, inArray } from "drizzle-orm";
import { allocOwnedCode } from "./codeAlloc";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { invalidArgument, notFound, failedPrecondition, forbidden } from "../lib/errors";
import { encodeCursor, decodeCursor } from "../http/pagination";
import { notify } from "./notifications";

const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
type State = typeof schema.reviewFeedback.$inferSelect.state;

export async function listReviewFeedback(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, stateFilter?: string) {
  const conds = [applyScope(scope, schema.reviewFeedback.code, schema.reviewFeedback.authorId)];
  if (stateFilter) conds.push(eq(schema.reviewFeedback.state, stateFilter as State));
  const all = (await deps.db.select().from(schema.reviewFeedback).where(conds.filter(Boolean).length ? and(...conds.filter(Boolean)) : undefined))
    .sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt) || a.uuid.localeCompare(b.uuid));
  const cur = decodeCursor(pageToken);
  const start = cur
    ? all.findIndex((e) => +new Date(e.createdAt) > cur.createTimeMs || (+new Date(e.createdAt) === cur.createTimeMs && e.uuid > cur.uid))
    : 0;
  const slice = start < 0 ? [] : all.slice(start, start + maxPageSize);
  const last = slice[slice.length - 1];
  const nextPageToken = start >= 0 && start + maxPageSize < all.length && last ? encodeCursor(+new Date(last.createdAt), last.uuid) : undefined;
  return { items: slice, nextPageToken };
}

async function getReviewFeedback(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.reviewFeedback).where(eq(schema.reviewFeedback.uuid, id)).limit(1))[0];
  if (!row) throw notFound("feedback request not found");
  return row;
}

// Nominate peers to give feedback on a review (called by the review's `nominate` verb). Skips the reviewee
// themselves and anyone already nominated. Returns the review row so the route can re-serialize.
export async function nominateFeedback(deps: Deps, actor: AppUser, reviewId: string, employeeRefs: string[]) {
  const review = (await deps.db.select().from(schema.reviews).where(eq(schema.reviews.uuid, reviewId)).limit(1))[0];
  if (!review) throw notFound("review not found");
  // 360 feedback exists to inform the manager's assessment. Once the review is shared it can no longer change,
  // so a nomination past that point only sends a colleague a request that can't affect anything.
  if (review.state === "SHARED" || review.state === "ACKNOWLEDGED") {
    throw failedPrecondition("this review has already been shared - peer feedback can no longer be added to it");
  }
  const ids = [...new Set(employeeRefs.map(idFromPath).filter(Boolean) as string[])].filter((id) => id !== review.employeeId);
  if (!ids.length) throw invalidArgument("select at least one peer (other than the reviewee)");
  const existing = new Set(
    (await deps.db.select({ a: schema.reviewFeedback.authorId }).from(schema.reviewFeedback).where(eq(schema.reviewFeedback.reviewId, reviewId))).map((r) => r.a),
  );
  const reviewee = (await deps.db.select({ f: schema.employees.firstName, l: schema.employees.lastName }).from(schema.employees).where(eq(schema.employees.uuid, review.employeeId)).limit(1))[0];
  const revieweeName = reviewee ? `${reviewee.f} ${reviewee.l}`.trim() : "a colleague";
  for (const authorId of ids) {
    if (existing.has(authorId)) continue;
    const code = await allocOwnedCode(deps, schema.reviewFeedback, schema.reviewFeedback.authorId, authorId);
    const fb = (await deps.db.insert(schema.reviewFeedback).values({ code, reviewId, revieweeId: review.employeeId, authorId }).returning())[0]!;
    await notify(deps, { recipient: authorId, type: "review.feedback_requested", title: "Feedback requested", body: `You've been asked to give feedback on ${revieweeName}.`, link: "reviews", subject: `review-feedback/${fb.uuid}`, action: "respond", actorId: actor.employeeId });
  }
  await audit(deps, actor, "review.nominate", "reviews", reviewId);
  return review;
}

// The nominee submits their feedback (REQUESTED -> SUBMITTED).
export async function submitFeedback(deps: Deps, actor: AppUser, id: string, input: { comment?: string | null; overall_rating?: number | null }) {
  const row = (await deps.db.select().from(schema.reviewFeedback).where(eq(schema.reviewFeedback.uuid, id)).limit(1))[0];
  if (!row) throw notFound("feedback request not found");
  // Owner-only, hard-enforced here and not left to scope alone: a nomination is addressed to ONE person and
  // the answer is attributed to them. A caller with org-wide reach (super, or anyone granted the verb broadly)
  // must not be able to put words in a colleague's mouth. Same reasoning as employees.me.getSignature.
  if (row.authorId !== actor.employeeId) throw forbidden("only the nominated author can answer this feedback request");
  if (row.state !== "REQUESTED") throw failedPrecondition("this feedback has already been submitted or declined");
  if (input.overall_rating != null && (typeof input.overall_rating !== "number" || Number.isNaN(input.overall_rating))) {
    throw invalidArgument("overall_rating must be a number");
  }
  // Guard the flip on REQUESTED so submission is EXACTLY-ONCE (0 rows = already submitted/declined).
  const updated = (await deps.db.update(schema.reviewFeedback)
    .set({ comment: input.comment?.trim() || null, overallRating: input.overall_rating ?? null, state: "SUBMITTED", updatedAt: new Date() })
    .where(and(eq(schema.reviewFeedback.uuid, id), eq(schema.reviewFeedback.state, "REQUESTED"))).returning())[0];
  if (!updated) throw failedPrecondition("this feedback has already been submitted or declined");
  await audit(deps, actor, "review-feedback.submit", "review-feedback", id);
  return updated;
}

// The nominee declines a feedback request (REQUESTED -> DECLINED).
export async function declineFeedback(deps: Deps, actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.reviewFeedback).where(eq(schema.reviewFeedback.uuid, id)).limit(1))[0];
  if (!row) throw notFound("feedback request not found");
  if (row.authorId !== actor.employeeId) throw forbidden("only the nominated author can decline this feedback request");
  if (row.state !== "REQUESTED") throw failedPrecondition("this feedback request is no longer open");
  const updated = (await deps.db.update(schema.reviewFeedback).set({ state: "DECLINED", updatedAt: new Date() }).where(and(eq(schema.reviewFeedback.uuid, id), eq(schema.reviewFeedback.state, "REQUESTED"))).returning())[0];
  if (!updated) throw failedPrecondition("this feedback request is no longer open");
  await audit(deps, actor, "review-feedback.decline", "review-feedback", id);
  return updated;
}

// All feedback rows for a set of reviews, grouped by review id (for embedding in the review serialize).
export async function feedbackForReviews(deps: Deps, reviewIds: string[]) {
  const map = new Map<string, (typeof schema.reviewFeedback.$inferSelect)[]>();
  if (!reviewIds.length) return map;
  const rows = await deps.db.select().from(schema.reviewFeedback).where(inArray(schema.reviewFeedback.reviewId, reviewIds)).orderBy(schema.reviewFeedback.createdAt);
  for (const r of rows) {
    const list = map.get(r.reviewId) ?? [];
    list.push(r);
    map.set(r.reviewId, list);
  }
  return map;
}

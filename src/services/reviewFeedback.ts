import { eq, and, inArray, type SQL } from "drizzle-orm";
import { allocOwnedCodesFor } from "./codeAlloc";
import { insertBatches, runBatch, type BatchStmt } from "../lib/dbBatch";
import { genId } from "../lib/idCodec";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, noteMeta, stateMeta } from "../lib/audit";
import { invalidArgument, notFound, failedPrecondition, forbidden } from "../lib/errors";
import { keysetPage } from "./keysetPage";
import { notify, notifyMany } from "./notifications";

const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
type State = typeof schema.reviewFeedback.$inferSelect.state;

export async function listReviewFeedback(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, stateFilter?: string) {
  const conds = [applyScope(scope, schema.reviewFeedback.code, schema.reviewFeedback.authorId)];
  if (stateFilter) conds.push(eq(schema.reviewFeedback.state, stateFilter as State));
  // Oldest first: 360 feedback on one review reads as a thread, in the order it was given. Paged in SQL
  // (services/keysetPage.ts) rather than by reading every request the scope matched into the isolate - one
  // row per reviewer per cycle per person, kept for the record, and D1 bills rows read.
  const { items: slice, nextPageToken } = await keysetPage<typeof schema.reviewFeedback.$inferSelect>(deps, schema.reviewFeedback, "review-feedback", and(...(conds.filter(Boolean) as SQL[])), { dir: "asc", max: maxPageSize, pageToken });
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
  // A row the REVIEWEE suggested is upgraded rather than skipped: the manager agreeing with a suggestion is
  // the moment it becomes a real request, and inserting a second row would ask the same person twice.
  const suggested = new Map(
    (await deps.db
      .select({ uuid: schema.reviewFeedback.uuid, a: schema.reviewFeedback.authorId })
      .from(schema.reviewFeedback)
      .where(and(eq(schema.reviewFeedback.reviewId, reviewId), eq(schema.reviewFeedback.state, "SUGGESTED"))))
      .map((r) => [r.a, r.uuid] as const),
  );
  // Batched, not looped. Every D1 round trip is a Worker subrequest against a per-invocation ceiling, and a
  // nomination is a list somebody picks off a team - looping meant an owned-code allocation, an insert and a
  // whole `notify` (five more) per nominee. The two kinds of nominee are kept apart because they are different
  // writes: a SUGGESTED row is promoted in place, a new one is inserted.
  const upgrades = ids.map((a) => [a, suggested.get(a)] as const).filter((p): p is readonly [string, string] => !!p[1]);
  const fresh = ids.filter((a) => !suggested.has(a) && !existing.has(a));
  // The row each nominee is told about - a promoted suggestion keeps its id, a new request gets one minted
  // here so the notification can name it without reading the inserts back.
  const rowIdFor = new Map<string, string>(upgrades);
  const now = new Date();
  const stmts: BatchStmt[] = upgrades.map(([, uuid]) =>
    deps.db.update(schema.reviewFeedback).set({ state: "REQUESTED", updatedAt: now }).where(eq(schema.reviewFeedback.uuid, uuid)));
  if (fresh.length) {
    // The SAME per-(table, owner) counters `allocOwnedCode` takes from - see codeAlloc.ts allocOwnedCodesFor.
    const codes = await allocOwnedCodesFor(deps, schema.reviewFeedback, schema.reviewFeedback.authorId, fresh);
    const rows = fresh.map((authorId) => {
      const uuid = genId();
      rowIdFor.set(authorId, uuid);
      return { uuid, code: codes.get(authorId)!, reviewId, revieweeId: review.employeeId, authorId };
    });
    stmts.push(...insertBatches(rows, (group) => deps.db.insert(schema.reviewFeedback).values(group)));
  }
  // One atomic batch: a half-nominated panel is a state the caller cannot see and the second press cannot fix.
  await runBatch(deps.db, stmts);
  await notifyMany(deps, [...rowIdFor.keys()], {
    type: "review.feedback_requested",
    title: "Feedback requested",
    body: `You've been asked to give feedback on ${revieweeName}.`,
    link: "reviews",
    action: "respond",
    actorId: actor.employeeId,
    // Each nominee is being told about THEIR request, not a shared one.
    subjectFor: (rid) => `review-feedback/${rowIdFor.get(rid)}`,
  });
  // The nominees as REFS, not the bare ids: an internal id must not reach the wire, and the feed resolves a
  // ref to the person's name.
  await audit(deps, actor, "review.nominate", "reviews", reviewId, { employee: `employees/${review.employeeId}`, fields: ids.slice(0, 12).map((i) => `employees/${i}`) }, review);
  return review;
}

/**
 * The REVIEWEE suggests who saw their work (called by the review's `suggestFeedback` verb).
 *
 * Nomination was the manager's alone, which has the 360 backwards: the people who actually worked with
 * somebody are known to that person, and a manager two projects away is guessing at a list. A suggestion is
 * inert - it notifies nobody and cannot be written to - until the manager nominates that person for real,
 * which turns the same row REQUESTED. So this asks nothing of anyone and cannot be used to solicit feedback.
 *
 * Replaces the whole suggested set (the reviewee's list is a list, not an append log), and never touches a row
 * that is already REQUESTED, SUBMITTED or DECLINED - those are the manager's process and the nominee's answer.
 */
export async function suggestFeedback(deps: Deps, actor: AppUser, reviewId: string, employeeRefs: string[]) {
  const review = (await deps.db.select().from(schema.reviews).where(eq(schema.reviews.uuid, reviewId)).limit(1))[0];
  if (!review) throw notFound("review not found");
  // Owner-only, hard-enforced: this is the reviewee's own list of who saw their work. HR nominating on
  // somebody's behalf is `nominate`, which is a different act with a different audit entry.
  if (review.employeeId !== actor.employeeId) throw forbidden("only the reviewee can suggest who saw their work");
  if (review.state === "SHARED" || review.state === "ACKNOWLEDGED") {
    throw failedPrecondition("this review has already been shared - peer feedback can no longer be added to it");
  }
  const ids = [...new Set(employeeRefs.map(idFromPath).filter(Boolean) as string[])].filter((id) => id !== review.employeeId);
  if (ids.length > 20) throw invalidArgument("suggest up to 20 people");

  const rows = await deps.db
    .select({ uuid: schema.reviewFeedback.uuid, a: schema.reviewFeedback.authorId, state: schema.reviewFeedback.state })
    .from(schema.reviewFeedback)
    .where(eq(schema.reviewFeedback.reviewId, reviewId));
  const live = new Set(rows.filter((r) => r.state !== "SUGGESTED").map((r) => r.a));
  const already = new Map(rows.filter((r) => r.state === "SUGGESTED").map((r) => [r.a, r.uuid] as const));

  // Drop the suggestions that were withdrawn, keep the ones that stayed, add the new ones.
  //
  // BATCHED, for the reason `nominateFeedback` above is batched, and this path was the one that never got it:
  // a withdrawal was a DELETE per row and an addition was an owned-code allocation (two round trips of its own)
  // plus an insert, all sequential, on a list the route caps at twenty. A caller replacing a full set of twenty
  // suggestions with twenty different people spent about eighty-five subrequests on one request - against a
  // per-invocation ceiling (lib/dbBatch.ts), on a verb somebody presses while editing a list.
  //
  // One atomic batch, so a half-replaced set - some withdrawals applied, some additions missing - is not a
  // state the reviewee can land in and then have to guess their way out of.
  const wanted = new Set(ids);
  const withdrawn = [...already].filter(([authorId]) => !wanted.has(authorId)).map(([, uuid]) => uuid);
  const fresh = ids.filter((authorId) => !already.has(authorId) && !live.has(authorId));
  const stmts: BatchStmt[] = withdrawn.length
    ? [deps.db.delete(schema.reviewFeedback).where(inArray(schema.reviewFeedback.uuid, withdrawn))]
    : [];
  if (fresh.length) {
    // The SAME per-(table, owner) counters `allocOwnedCode` takes from - see codeAlloc.ts allocOwnedCodesFor.
    const codes = await allocOwnedCodesFor(deps, schema.reviewFeedback, schema.reviewFeedback.authorId, fresh);
    const newRows = fresh.map((authorId) => ({
      code: codes.get(authorId)!,
      reviewId,
      revieweeId: review.employeeId,
      authorId,
      state: "SUGGESTED" as const,
    }));
    stmts.push(...insertBatches(newRows, (group) => deps.db.insert(schema.reviewFeedback).values(group)));
  }
  await runBatch(deps.db, stmts);
  await audit(deps, actor, "review.suggestFeedback", "reviews", reviewId, {
    employee: `employees/${review.employeeId}`,
    fields: ids.slice(0, 12).map((i) => `employees/${i}`),
    note: ids.length ? `${ids.length} suggested` : "suggestions cleared",
  }, review);
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
  await audit(deps, actor, "review-feedback.submit", "review-feedback", id, stateMeta("REQUESTED", "SUBMITTED", { employee: `employees/${row.revieweeId}` }), updated);
  return updated;
}

// The nominee declines a feedback request (REQUESTED -> DECLINED), optionally saying why.
export async function declineFeedback(deps: Deps, actor: AppUser, id: string, reason?: string | null) {
  const row = (await deps.db.select().from(schema.reviewFeedback).where(eq(schema.reviewFeedback.uuid, id)).limit(1))[0];
  if (!row) throw notFound("feedback request not found");
  if (row.authorId !== actor.employeeId) throw forbidden("only the nominated author can decline this feedback request");
  if (row.state !== "REQUESTED") throw failedPrecondition("this feedback request is no longer open");
  // The reason matters: "I have not worked with them this cycle" tells the manager to nominate somebody else,
  // where a bare decline leaves them guessing whether it was a bad match or a busy week.
  const text = reason?.trim() || null;
  const updated = (await deps.db.update(schema.reviewFeedback).set({ state: "DECLINED", declineReason: text, updatedAt: new Date() }).where(and(eq(schema.reviewFeedback.uuid, id), eq(schema.reviewFeedback.state, "REQUESTED"))).returning())[0];
  if (!updated) throw failedPrecondition("this feedback request is no longer open");
  // The reason itself stays on the row, not in the trail: it is a peer's own words under an anonymity promise
  // this file keeps everywhere else (lib/audit.ts#noteMeta).
  await audit(deps, actor, "review-feedback.decline", "review-feedback", id, stateMeta("REQUESTED", "DECLINED", { employee: `employees/${row.revieweeId}`, ...noteMeta("review-feedback", text) }), updated);
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

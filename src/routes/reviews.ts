import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { collectionRoutes } from "../http/collectionRoute";
import { contentDisposition } from "../http/contentDisposition";
import { listReviews, submitSelf, submitManager, acknowledgeReview, skipReviewStage, nudgeReview, renderReviewPdf, goalsForReviews, attainmentTrend, assignReviewer } from "../services/reviews";
import { nominateFeedback, suggestFeedback, feedbackForReviews } from "../services/reviewFeedback";
import { reviewEvidenceFor } from "../services/reviewEvidence";
import { collaboratorsFor } from "../services/reviewCollaborators";
import { notFound } from "../lib/errors";
import { getSettingValue } from "../services/settings";
import { DEFAULT_PERFORMANCE, competenciesForCycle, type PerformanceFramework } from "../domain/performance";
import { toReviewResource } from "../http/serialize";
import type { AppUser } from "../env";

type Feedback = typeof schema.reviewFeedback.$inferSelect;
type ReviewRow = typeof schema.reviews.$inferSelect;

// Every answer carries the review's 360 feedback and the cycle's goals, both attached before serializing: two
// queries per page, two per single row. The goals ride the review so the page renders its evidence panel and
// its attainment score without reading the whole goals collection to find the handful that belong to a cycle.
const withEvidence = async <T extends ReviewRow>(deps: Deps, actor: AppUser, rows: T[]) => {
  const cycleIds = [...new Set(rows.map((r) => r.cycleId))];
  const [fb, goals, framework, cycles] = await Promise.all([
    feedbackForReviews(deps, rows.map((r) => r.uuid)),
    goalsForReviews(deps, actor, rows),
    // The competency catalogue, once for the page: the serializer needs the weights to say what the ratings
    // add up to, and a client that re-derived it from its own copy of the framework could disagree with the
    // PDF about the same review.
    getSettingValue<PerformanceFramework>(deps, "performance", DEFAULT_PERFORMANCE),
    // Which of those competencies each cycle actually asks about. One query for the page - a probation review
    // and an annual review are the same framework narrowed two different ways.
    cycleIds.length
      ? deps.db.select({ uuid: schema.reviewCycles.uuid, keys: schema.reviewCycles.competencyKeysJson }).from(schema.reviewCycles).where(inArray(schema.reviewCycles.uuid, cycleIds))
      : Promise.resolve([] as { uuid: string; keys: string | null }[]),
  ]);
  const keysByCycle = new Map(cycles.map((c) => [c.uuid, c.keys]));
  // The trend is ONE person's history, so it rides the single-review read only: a page of reviews would mean
  // a query each, and a list has no room to draw it anyway.
  const trend = rows.length === 1 ? await attainmentTrend(deps, rows[0]!.employeeId) : undefined;
  return rows.map((r) => Object.assign(r, {
    _fb: fb.get(r.uuid) ?? [],
    _goals: goals.get(r.uuid) ?? [],
    _competencies: competenciesForCycle(framework.competencies ?? [], keysByCycle.get(r.cycleId) ?? null),
    ...(trend ? { _trend: trend } : {}),
  }));
};

const selfSchema = z.object({
  self_comment: z.string().nullable().optional(),
  self_ratings: z.record(z.string(), z.number()).optional(),
}).strict();
const managerSchema = z.object({
  ratings: z.record(z.string(), z.number()).optional(),
  manager_comment: z.string().nullable().optional(),
  overall_rating: z.number().nullable().optional(),
  // The manager's verdict per goal, keyed by the goal's code. Verdicts for goals outside the cycle's set are
  // dropped by the service, so a stale form can't attach an assessment to a goal this review never held.
  goal_ratings: z.record(z.string(), z.object({ rating: z.number().optional(), comment: z.string().max(2000).optional() }).strict()).optional(),
}).strict();
// Capped at the same twenty `suggestFeedback` allows: the two halves of one list (who the reviewee says saw
// their work, who the manager actually asks) had different limits, and the unbounded one was the half that
// writes rows and sends mail. A 360 with more than twenty reviewers is not a 360.
const nominateSchema = z.object({ employees: z.array(z.string()).min(1).max(20) }).strict();
// The reviewee's own list, which may legitimately be emptied (a withdrawn suggestion is a suggestion removed).
const suggestSchema = z.object({ employees: z.array(z.string()).max(20) }).strict();
const acknowledgeSchema = z.object({ comment: z.string().nullable().optional() }).strict();
// Null clears the override, handing the write-up back to the manager chain.
const reviewerSchema = z.object({ reviewer: z.string().nullable().optional() }).strict();

// Performance reviews. A review is created by launching its cycle and is only ever moved by the stage verbs -
// there is no create, no edit and no delete here - so the factory mounts list, get and the seven verbs.
export const reviews = collectionRoutes({
  table: schema.reviews,
  collection: "reviews",
  auditName: "review",
  notFound: "review not found",
  param: "review_id",
  // The manager's assessment is withheld from the owner-employee until the review is SHARED. Anyone who can see
  // a review they don't own (a manager/HR, by scope) always sees it. 360 feedback is embedded the same way:
  // managers/HR see every entry, named; the employee sees only SUBMITTED entries, anonymized, and only once the
  // review is shared.
  serialize: (row, user) => {
    const feedback: Feedback[] = row._fb ?? [];
    const shared = row.state === "SHARED" || row.state === "ACKNOWLEDGED";
    const isOwner = user!.employeeId === row.employeeId;
    row._managerVisible = shared || !isOwner;
    row._feedbackNamed = !isOwner;
    if (!isOwner) row._feedback = feedback; // manager/HR: all entries (progress + authors)
    else {
      // The employee sees two disjoint things: their OWN suggestions (names they typed themselves, carrying no
      // feedback content, so there is nothing to withhold), and once the review is shared, the submitted
      // feedback - anonymized. Everything in between is the manager's process and stays theirs.
      const own = feedback.filter((f) => f.state === "SUGGESTED");
      const answered = shared ? feedback.filter((f) => f.state === "SUBMITTED") : [];
      row._feedback = own.length || answered.length ? [...own, ...answered] : undefined;
    }
    return toReviewResource(row);
  },
  list: (c, page) => listReviews(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, c.req.query("cycle"), c.req.query("state"), c.req.query("employee")),
  decorate: (deps, actor, rows) => withEvidence(deps, actor, rows),
  verbs: {
    submitSelf: { schema: selfSchema, run: (deps, user, id, body) => submitSelf(deps, user, id, body.self_comment, body.self_ratings) },
    submitManager: { schema: managerSchema, run: (deps, user, id, body) => submitManager(deps, user, id, body) },
    nominate: { schema: nominateSchema, run: (deps, user, id, body) => nominateFeedback(deps, user, id, body.employees) },
    // The reviewee's own suggestion of who saw their work. Inert until the manager nominates one of them for
    // real, which is what makes it safe to hand this verb to the person being reviewed.
    suggestFeedback: { schema: suggestSchema, run: (deps, user, id, body) => suggestFeedback(deps, user, id, body.employees) },
    // Point this one review at a specific reviewer (a transfer, a matrix report, a manager on leave) instead
    // of re-parenting the employee to fix a review.
    assignReviewer: { schema: reviewerSchema, run: (deps, user, id, body) => assignReviewer(deps, user, id, body.reviewer) },
    acknowledge: { schema: acknowledgeSchema, run: (deps, user, id, body) => acknowledgeReview(deps, user, id, body.comment) },
    skipStage: { run: (deps, user, id) => skipReviewStage(deps, user, id) },
    nudge: { run: (deps, user, id) => nudgeReview(deps, user, id) },
    // What this person actually did in the cycle, gathered from the four places that already record it.
    //
    // `raw`, because there is no review row to serialize: the answer is a pack of OTHER records, each a link.
    // No model is called and nothing is written, so there is no feature flag and no fallback - the only thing
    // that can make a section empty is the caller not being allowed to list that collection, which is decided
    // per collection by the middleware (MULTI_SCOPE_VERBS) and arrives here as `evidenceScopes`.
    evidence: {
      raw: async (c, id) => {
        const deps = c.get("deps");
        const row = (await deps.db
          .select({ uuid: schema.reviews.uuid, employeeId: schema.reviews.employeeId, cycleId: schema.reviews.cycleId, createdAt: schema.reviews.createdAt })
          .from(schema.reviews)
          .where(eq(schema.reviews.uuid, id))
          .limit(1))[0];
        if (!row) throw notFound("review not found");
        return c.json({ evidence: await reviewEvidenceFor(deps, c.get("evidenceScopes") ?? new Map(), row) });
      },
    },
    // Who saw this person's work, from the record of who worked with them. Feeds the 360 picker, which was
    // otherwise a blank list of the whole directory answered from memory. Nothing is written: nominating is
    // still a separate act through `:nominate`.
    collaborators: {
      raw: async (c, id) => {
        const deps = c.get("deps");
        const row = (await deps.db
          .select({ uuid: schema.reviews.uuid, employeeId: schema.reviews.employeeId, cycleId: schema.reviews.cycleId, createdAt: schema.reviews.createdAt })
          .from(schema.reviews)
          .where(eq(schema.reviews.uuid, id))
          .limit(1))[0];
        if (!row) throw notFound("review not found");
        return c.json({ collaborators: await collaboratorsFor(deps, c.get("evidenceScopes") ?? new Map(), row) });
      },
    },
    pdf: {
      raw: async (c, id) => {
        // `?variant=print` renders it on the letterhead's print page; nothing is filed either way.
        const { bytes, fileName } = await renderReviewPdf(c.get("deps"), c.get("user"), id, c.req.query("variant") === "print" ? "print" : "screen");
        // pdf-lib returns a Uint8Array over an ArrayBufferLike; hand Hono a plain ArrayBuffer copy.
        return c.body(bytes.slice().buffer, 200, { "Content-Type": "application/pdf", "Content-Disposition": contentDisposition("inline", fileName) });
      },
    },
  },
});

import { z } from "zod";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { collectionRoutes } from "../http/collectionRoute";
import { listReviews, submitSelf, submitManager, acknowledgeReview, skipReviewStage, nudgeReview, renderReviewPdf } from "../services/reviews";
import { nominateFeedback, feedbackForReviews } from "../services/reviewFeedback";
import { toReviewResource } from "../http/serialize";

type Feedback = typeof schema.reviewFeedback.$inferSelect;

// Every answer carries the review's 360 feedback, so it is attached before serializing: one query per page,
// one per single row.
const withFeedback = async <T extends { uuid: string }>(deps: Deps, rows: T[]) => {
  const fb = await feedbackForReviews(deps, rows.map((r) => r.uuid));
  return rows.map((r) => Object.assign(r, { _fb: fb.get(r.uuid) ?? [] }));
};

const selfSchema = z.object({
  self_comment: z.string().nullable().optional(),
  self_ratings: z.record(z.string(), z.number()).optional(),
}).strict();
const managerSchema = z.object({
  ratings: z.record(z.string(), z.number()).optional(),
  manager_comment: z.string().nullable().optional(),
  overall_rating: z.number().nullable().optional(),
}).strict();
const nominateSchema = z.object({ employees: z.array(z.string()).min(1) }).strict();
const acknowledgeSchema = z.object({ comment: z.string().nullable().optional() }).strict();

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
    else if (shared) row._feedback = feedback.filter((f) => f.state === "SUBMITTED"); // employee: submitted only, anonymized
    else row._feedback = undefined; // employee, not yet shared: omit
    return toReviewResource(row);
  },
  list: (c, page) => listReviews(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, c.req.query("cycle"), c.req.query("state")),
  decorate: (deps, _actor, rows) => withFeedback(deps, rows),
  verbs: {
    submitSelf: { schema: selfSchema, run: (deps, user, id, body) => submitSelf(deps, user, id, body.self_comment, body.self_ratings) },
    submitManager: { schema: managerSchema, run: (deps, user, id, body) => submitManager(deps, user, id, body) },
    nominate: { schema: nominateSchema, run: (deps, user, id, body) => nominateFeedback(deps, user, id, body.employees) },
    acknowledge: { schema: acknowledgeSchema, run: (deps, user, id, body) => acknowledgeReview(deps, user, id, body.comment) },
    skipStage: { run: (deps, user, id) => skipReviewStage(deps, user, id) },
    nudge: { run: (deps, user, id) => nudgeReview(deps, user, id) },
    pdf: {
      raw: async (c, id) => {
        const { bytes, fileName } = await renderReviewPdf(c.get("deps"), c.get("user"), id);
        // pdf-lib returns a Uint8Array over an ArrayBufferLike; hand Hono a plain ArrayBuffer copy.
        return c.body(bytes.slice().buffer, 200, { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${fileName}"` });
      },
    },
  },
});

import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { listReviewFeedback, submitFeedback, declineFeedback } from "../services/reviewFeedback";
import { toReviewFeedbackResource } from "../http/serialize";

const submitSchema = z.object({ comment: z.string().nullable().optional(), overall_rating: z.number().nullable().optional() }).strict();
const declineSchema = z.object({ reason: z.string().max(500).nullable().optional() }).strict();

// 360 feedback requests. A request is minted by nominating a peer on a review, and the nominee either answers
// it (:submitFeedback) or declines - so there is no create, no edit and no delete here.
export const reviewFeedback = collectionRoutes({
  table: schema.reviewFeedback,
  collection: "review-feedback",
  auditName: "review-feedback",
  notFound: "feedback request not found",
  param: "feedback_id",
  serialize: toReviewFeedbackResource,
  list: (c, page) => listReviewFeedback(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, c.req.query("state")),
  verbs: {
    submitFeedback: { schema: submitSchema, run: (deps, user, id, body) => submitFeedback(deps, user, id, body) },
    // Saying why is optional but useful: "I have not worked with them this cycle" tells the manager to
    // nominate somebody else, where a bare decline leaves them guessing.
    decline: { schema: declineSchema, run: (deps, user, id, body) => declineFeedback(deps, user, id, body?.reason) },
  },
});

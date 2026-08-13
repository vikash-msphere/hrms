import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { listReviewFeedback, submitFeedback, declineFeedback } from "../services/reviewFeedback";
import { toReviewFeedbackResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";

const submitSchema = z.object({ comment: z.string().nullable().optional(), overall_rating: z.number().nullable().optional() }).strict();

// 360 feedback requests. A request is minted by nominating a peer on a review, and the nominee either answers
// it (:submitFeedback) or declines - so there is no create, no edit and no delete here.
export const reviewFeedback = collectionRoutes({
  table: schema.reviewFeedback,
  collection: "review-feedback",
  auditName: "review-feedback",
  notFound: "feedback request not found",
  param: "feedback_id",
  serialize: toReviewFeedbackResource,
  list: (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    return listReviewFeedback(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("state"));
  },
  verbs: {
    submitFeedback: { schema: submitSchema, run: (deps, user, id, body) => submitFeedback(deps, user, id, body) },
    decline: { run: (deps, user, id) => declineFeedback(deps, user, id) },
  },
});

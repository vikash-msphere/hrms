import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { listInterviewFeedback, createInterviewFeedback, updateInterviewFeedback, type FeedbackInput } from "../services/ats";
import { toInterviewFeedbackResource } from "../http/serialize";

const writeSchema = z
  .object({
    interview: z.string().nullable().optional(),
    author: z.string().nullable().optional(),
    ratings: z.record(z.string(), z.number()).nullable().optional(),
    overall_rating: z.number().nullable().optional(),
    recommendation: z.string().nullable().optional(),
    comment: z.string().nullable().optional(),
  })
  .strict();

// Interview scorecards. Plain CRUD plus soft delete/restore - the lane, with the field mapping in the ATS
// service. The delete-side audit stems join the create/update ones on `interview-feedback.*` (they used to
// read `scorecard.*`, which nothing depends on); the 404 text stays the scorecard wording callers see.
export const interviewFeedback = collectionRoutes<FeedbackInput, typeof schema.interviewFeedback>({
  table: schema.interviewFeedback,
  collection: "interview-feedback",
  auditName: "interview-feedback",
  notFound: "scorecard not found",
  param: "feedback_id",
  writeSchema,
  serialize: toInterviewFeedbackResource,
  overrides: {
    create: (deps, actor, input, id) => createInterviewFeedback(deps, actor, input, id),
    update: (deps, actor, id, patch, ifMatch) => updateInterviewFeedback(deps, actor, id, patch, ifMatch),
  },
  list: (c, page) => {
    return listInterviewFeedback(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, {
      interview: c.req.query("interview"),
      showDeleted: page.showDeleted,
    });
  },
});

import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { listInterviews, createInterview, updateInterview, completeInterview, cancelInterview, inviteCandidate, type InterviewInput } from "../services/ats";
import { toInterviewResource } from "../http/serialize";

const writeSchema = z
  .object({
    application: z.string().nullable().optional(),
    // title, mode and status are NOT NULL columns (defaults "video" / "scheduled") that the serializer emits on
    // every response: null is not a value they can hold. `interviewers` stays clearable - its column is a
    // nullable JSON array, so null really does mean "no panel yet".
    title: z.string().optional(),
    mode: z.string().optional(),
    scheduled_start_time: z.string().nullable().optional(),
    scheduled_end_time: z.string().nullable().optional(),
    interviewers: z.array(z.string()).nullable().optional(),
    location: z.string().nullable().optional(),
    status: z.string().optional(),
  })
  .strict();

// Scheduled interviews for an application. :complete and :cancel close the slot out.
export const interviews = collectionRoutes<InterviewInput, typeof schema.interviews>({
  table: schema.interviews,
  collection: "interviews",
  auditName: "interview",
  notFound: "interview not found",
  param: "interview_id",
  writeSchema,
  serialize: toInterviewResource,
  overrides: {
    create: (deps, actor, input, id) => createInterview(deps, actor, input, id),
    update: (deps, actor, id, patch, ifMatch) => updateInterview(deps, actor, id, patch, ifMatch),
  },
  list: (c, page) => {
    return listInterviews(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, {
      application: c.req.query("application"),
      status: c.req.query("status"),
      showDeleted: page.showDeleted,
      deletedOnly: page.deletedOnly,
    });
  },
  verbs: {
    complete: { run: (deps, user, id) => completeInterview(deps, user, id) },
    cancel: { run: (deps, user, id) => cancelInterview(deps, user, id) },
    invite: { run: (deps, user, id) => inviteCandidate(deps, user, id) },
  },
});

import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { listInterviews, createInterview, updateInterview, completeInterview, cancelInterview, type InterviewInput } from "../services/ats";
import { toInterviewResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";

const writeSchema = z
  .object({
    application: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    mode: z.string().nullable().optional(),
    scheduled_start_time: z.string().nullable().optional(),
    scheduled_end_time: z.string().nullable().optional(),
    interviewers: z.array(z.string()).nullable().optional(),
    location: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
  })
  .strict();

// Scheduled interviews for an application. :complete and :cancel close the slot out.
export const interviews = collectionRoutes<InterviewInput>({
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
  list: (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    return listInterviews(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), {
      application: c.req.query("application"),
      status: c.req.query("status"),
      showDeleted: c.req.query("show_deleted") === "true",
    });
  },
  verbs: {
    complete: { run: (deps, user, id) => completeInterview(deps, user, id) },
    cancel: { run: (deps, user, id) => cancelInterview(deps, user, id) },
  },
});

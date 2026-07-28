import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import {
  listInterviewFeedback, getInterviewFeedback, createInterviewFeedback, updateInterviewFeedback,
  deleteInterviewFeedback, restoreInterviewFeedback, purgeInterviewFeedback,
} from "../services/ats";
import { toInterviewFeedbackResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

const COL = "interview-feedback";

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

export const interviewFeedback = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listInterviewFeedback(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), {
      interview: c.req.query("interview"),
      showDeleted: c.req.query("show_deleted") === "true",
    });
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toInterviewFeedbackResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:feedback_id", async (c) => {
    const row = await getInterviewFeedback(c.get("deps"), c.req.param("feedback_id"));
    return c.json(withAccess(toInterviewFeedbackResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createInterviewFeedback(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(withAccess(toInterviewFeedbackResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .patch("/:feedback_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateInterviewFeedback(c.get("deps"), c.get("user"), c.req.param("feedback_id"), c.req.valid("json"), c.req.header("If-Match"));
    return c.json(withAccess(toInterviewFeedbackResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .delete("/:feedback_id", async (c) => {
    const id = c.req.param("feedback_id");
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeInterviewFeedback(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteInterviewFeedback(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:feedback_id", async (c) => {
    const { id, verb } = customMethod(c);
    const deps = c.get("deps");
    const user = c.get("user");
    const hint = (row: any) => withAccess(toInterviewFeedbackResource(row), user, COL, row?.code, c.get("objectGrant"));
    if (verb === "restore") return c.json(hint(await restoreInterviewFeedback(deps, user, id)));
    return c.notFound();
  });

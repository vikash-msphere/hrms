import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { listReviewFeedback, getReviewFeedback, submitFeedback, declineFeedback } from "../services/reviewFeedback";
import { toReviewFeedbackResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

const COL = "review-feedback";

export const reviewFeedback = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listReviewFeedback(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("state"));
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toReviewFeedbackResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:feedback_id", async (c) => {
    const row = await getReviewFeedback(c.get("deps"), c.get("user"), c.req.param("feedback_id")!);
    return c.json(withAccess(toReviewFeedbackResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/:feedback_id", async (c) => {
    const { id, verb } = customMethod(c);
    const user = c.get("user");
    const hint = (row: { code: string | null } | undefined) => withAccess(toReviewFeedbackResource(row), user, COL, row?.code, c.get("objectGrant"));
    if (verb === "submitFeedback") {
      const body = z.object({ comment: z.string().nullable().optional(), overall_rating: z.number().nullable().optional() }).strict().parse(await c.req.json().catch(() => ({})));
      return c.json(hint(await submitFeedback(c.get("deps"), user, id, body)));
    }
    if (verb === "decline") return c.json(hint(await declineFeedback(c.get("deps"), user, id)));
    return c.notFound();
  });

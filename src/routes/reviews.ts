import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import type { AppUser } from "../env";
import { listReviews, getReview, submitSelf, submitManager, acknowledgeReview, skipReviewStage, nudgeReview, renderReviewPdf } from "../services/reviews";
import { nominateFeedback, feedbackForReviews } from "../services/reviewFeedback";
import { toReviewResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";
import type { Grant } from "../domain/permissions";

const COL = "reviews";
type Feedback = typeof import("../db/schema").reviewFeedback.$inferSelect;

// The manager's assessment is withheld from the owner-employee until the review is SHARED. Anyone who can see a
// review they don't own (a manager/HR, by scope) always sees it. 360 feedback is embedded too: managers/HR see
// every entry, named; the employee sees only SUBMITTED entries, anonymized, and only once the review is shared.
function serialize(user: AppUser, row: any, feedback: Feedback[], grant?: Grant) {
  const shared = row.state === "SHARED" || row.state === "ACKNOWLEDGED";
  const isOwner = user.employeeId === row.employeeId;
  row._managerVisible = shared || !isOwner;
  row._feedbackNamed = !isOwner;
  if (!isOwner) row._feedback = feedback; // manager/HR: all entries (progress + authors)
  else if (shared) row._feedback = feedback.filter((f) => f.state === "SUBMITTED"); // employee: submitted only, anonymized
  else row._feedback = undefined; // employee, not yet shared: omit
  return withAccess(toReviewResource(row), user, COL, row?.code, grant);
}

export const reviews = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listReviews(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("cycle"), c.req.query("state"));
    const user = c.get("user");
    const fb = await feedbackForReviews(c.get("deps"), items.map((r) => r.uuid));
    return c.json({ results: items.map((r) => serialize(user, r, fb.get(r.uuid) ?? [])), next_page_token: nextPageToken });
  })
  .get("/:review_id", async (c) => {
    const row = await getReview(c.get("deps"), c.get("user"), c.req.param("review_id")!);
    const fb = await feedbackForReviews(c.get("deps"), [row.uuid]);
    return c.json(serialize(c.get("user"), row, fb.get(row.uuid) ?? [], c.get("objectGrant")));
  })
  .post("/:review_id", async (c) => {
    const { id, verb } = customMethod(c);
    const deps = c.get("deps");
    const user = c.get("user");
    const out = async (row: any) => c.json(serialize(user, row, (await feedbackForReviews(deps, [row.uuid])).get(row.uuid) ?? [], c.get("objectGrant")));
    if (verb === "submitSelf") {
      const { self_comment, self_ratings } = z.object({
        self_comment: z.string().nullable().optional(),
        self_ratings: z.record(z.string(), z.number()).optional(),
      }).strict().parse(await c.req.json().catch(() => ({})));
      return out(await submitSelf(deps, user, id, self_comment, self_ratings));
    }
    if (verb === "submitManager") {
      const body = z.object({
        ratings: z.record(z.string(), z.number()).optional(),
        manager_comment: z.string().nullable().optional(),
        overall_rating: z.number().nullable().optional(),
      }).strict().parse(await c.req.json().catch(() => ({})));
      return out(await submitManager(deps, user, id, body));
    }
    if (verb === "nominate") {
      const { employees } = z.object({ employees: z.array(z.string()).min(1) }).strict().parse(await c.req.json().catch(() => ({})));
      return out(await nominateFeedback(deps, user, id, employees));
    }
    if (verb === "acknowledge") {
      const { comment } = z.object({ comment: z.string().nullable().optional() }).strict().parse(await c.req.json().catch(() => ({})));
      return out(await acknowledgeReview(deps, user, id, comment));
    }
    if (verb === "skipStage") return out(await skipReviewStage(deps, user, id));
    if (verb === "nudge") return out(await nudgeReview(deps, user, id));
    if (verb === "pdf") {
      const { bytes, fileName } = await renderReviewPdf(deps, user, id);
      // pdf-lib returns a Uint8Array over an ArrayBufferLike; hand Hono a plain ArrayBuffer copy.
      return c.body(bytes.slice().buffer, 200, { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${fileName}"` });
    }
    return c.notFound();
  });

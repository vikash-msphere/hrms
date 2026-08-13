import { z } from "zod";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { collectionRoutes } from "../http/collectionRoute";
import {
  listReviewCycles, createReviewCycle, updateReviewCycle,
  launchReviewCycle, addRevieweesToCycle, setReviewCycleState, reviewCountsFor, purgeReviewCycle,
  type ReviewCycleInput,
} from "../services/reviewCycles";
import { toReviewCycleResource } from "../http/serialize";

const writeSchema = z.object({
  name: z.string().min(1).optional(),
  period_start: z.string().nullable().optional(),
  period_end: z.string().nullable().optional(),
  self_due_date: z.string().nullable().optional(),
  manager_due_date: z.string().nullable().optional(),
}).strict();
const employeesSchema = z.object({ employees: z.array(z.string()).min(1) }).strict();

// A cycle always reports how many reviews it holds: one count query per page, one per single row.
const withCounts = async <T extends { uuid: string }>(deps: Deps, rows: T[]) => {
  const counts = await reviewCountsFor(deps, rows.map((r) => r.uuid));
  return rows.map((r) => Object.assign(r, { _reviewCount: counts.get(r.uuid) ?? 0 }));
};
const oneWithCounts = async (deps: Deps, row: any) => (await withCounts(deps, [row]))[0];

// Review cycles. Create and update stay the service's own (the dates drive every review the cycle will hold);
// :launch mints the reviews, :enroll adds late joiners, :close/:reopen move the state. Delete/restore are the
// shared soft-delete lane.
export const reviewCycles = collectionRoutes<ReviewCycleInput>({
  table: schema.reviewCycles,
  collection: "review-cycles",
  auditName: "review-cycle",
  notFound: "review cycle not found",
  param: "cycle_id",
  writeSchema,
  serialize: toReviewCycleResource,
  decorate: (deps, _actor, rows) => withCounts(deps, rows),
  overrides: {
    create: (deps, actor, input, id) => createReviewCycle(deps, actor, input, id),
    update: (deps, actor, id, patch, ifMatch) => updateReviewCycle(deps, actor, id, patch, ifMatch),
    // A hard purge tears the cycle's children down bottom-up: 360 feedback, then the reviews, then the cycle.
    purge: (deps, actor, id, ifMatch) => purgeReviewCycle(deps, actor, id, ifMatch),
  },
  list: async (c, page) => {
    const deps = c.get("deps");
    // This list scopes by the caller (a cycle is visible to whoever holds a review in it), not by a code filter.
    const { items, nextPageToken } = await listReviewCycles(deps, c.get("user"), page.maxPageSize, page.pageToken, page.showDeleted);
    return { items: await withCounts(deps, items), nextPageToken };
  },
  verbs: {
    launch: { schema: employeesSchema, run: async (deps, user, id, body) => oneWithCounts(deps, await launchReviewCycle(deps, user, id, body.employees)) },
    enroll: { schema: employeesSchema, run: async (deps, user, id, body) => oneWithCounts(deps, await addRevieweesToCycle(deps, user, id, body.employees)) },
    close: { run: async (deps, user, id) => oneWithCounts(deps, await setReviewCycleState(deps, user, id, "CLOSED")) },
    reopen: { run: async (deps, user, id) => oneWithCounts(deps, await setReviewCycleState(deps, user, id, "ACTIVE")) },
  },
});

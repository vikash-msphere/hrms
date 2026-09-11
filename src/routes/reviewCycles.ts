import { z } from "zod";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { collectionRoutes } from "../http/collectionRoute";
import {
  listReviewCycles, createReviewCycle, updateReviewCycle,
  launchReviewCycle, addRevieweesToCycle, setReviewCycleState, reviewCountsFor, goalCoverageFor, purgeReviewCycle,
  type ReviewCycleInput,
} from "../services/reviewCycles";
import { toReviewCycleResource } from "../http/serialize";
import { variablePayRun, awardVariablePay } from "../services/variablePay";

const writeSchema = z.object({
  name: z.string().min(1).optional(),
  period_start: z.string().nullable().optional(),
  period_end: z.string().nullable().optional(),
  goal_setting_due_date: z.string().nullable().optional(),
  self_due_date: z.string().nullable().optional(),
  manager_due_date: z.string().nullable().optional(),
  // Which framework competencies this cycle rates. The editor ALWAYS sends it, empty included, because
  // clearing the selection is a real edit ("ask about all of them again") - so a schema that left it out
  // rejected every create and every save the UI made, not just the ones that narrowed the list.
  competency_keys: z.array(z.string()).nullable().optional(),
}).strict();
// Capped like `:award` beside it. The service fans these out (one batch of codes, chunked inserts, one
// broadcast) so the cost is no longer per-person, but the request is still O(headcount) in CPU and the list
// arrives from a picker - an uncapped array is a request whose work the caller chooses.
const employeesSchema = z.object({ employees: z.array(z.string()).min(1).max(500) }).strict();
const awardSchema = z.object({ employees: z.array(z.string()).min(1).max(500) }).strict();

// A cycle always reports how many reviews it holds and how many of those reviewees have goals attached: two
// count queries per page, two per single row.
const withCounts = async <T extends { uuid: string }>(deps: Deps, rows: T[]) => {
  const ids = rows.map((r) => r.uuid);
  const [counts, coverage] = await Promise.all([reviewCountsFor(deps, ids), goalCoverageFor(deps, ids)]);
  return rows.map((r) => Object.assign(r, { _reviewCount: counts.get(r.uuid) ?? 0, _goalCoverage: coverage.get(r.uuid) ?? 0 }));
};

// Review cycles. Create and update stay the service's own (the dates drive every review the cycle will hold);
// :launch mints the reviews, :enroll adds late joiners, :close/:reopen move the state. Delete/restore are the
// shared soft-delete lane.
export const reviewCycles = collectionRoutes<ReviewCycleInput, typeof schema.reviewCycles>({
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
  // This list scopes by the caller (a cycle is visible to whoever holds a review in it), not by a code filter.
  list: (c, page) => listReviewCycles(c.get("deps"), c.get("user"), page.maxPageSize, page.pageToken, page.showDeleted),
  verbs: {
    launch: { schema: employeesSchema, run: (deps, user, id, body) => launchReviewCycle(deps, user, id, body.employees) },
    enroll: { schema: employeesSchema, run: (deps, user, id, body) => addRevieweesToCycle(deps, user, id, body.employees) },
    // Attainment -> money, in two presses. `:variablePay` computes and reports (nothing is written); `:award`
    // writes the bonuses at exactly the figures it reported. Both read reviews through the caller's own scope,
    // so a manager sees their team and HR sees everyone.
    variablePay: {
      run: async (deps, user, id, _body, c) => {
        const { cycle, lines } = await variablePayRun(deps, c.get("scope"), id);
        return { ...cycle, _variablePay: lines };
      },
    },
    award: {
      schema: awardSchema,
      run: async (deps, user, id, body, c) => {
        // One run, not two: the award patches the lines it paid (services/variablePay.ts). Re-running it here
        // doubled the cost of the module's heaviest call to recompute what the award already knew.
        const { cycle, lines, result } = await awardVariablePay(deps, user, c.get("scope"), id, body.employees);
        return { ...cycle, _variablePay: lines, _awarded: result };
      },
    },
    close: { run: (deps, user, id) => setReviewCycleState(deps, user, id, "CLOSED") },
    reopen: { run: (deps, user, id) => setReviewCycleState(deps, user, id, "ACTIVE") },
  },
});

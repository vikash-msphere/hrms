/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { createReviewCycle, launchReviewCycle, addRevieweesToCycle, purgeReviewCycle, goalCoverageFor } from "../src/services/reviewCycles";
import { listReviews, submitManager, submitSelf, skipReviewStage, goalsForReviews, cycleGoals } from "../src/services/reviews";
import { createGoal, updateGoalProgress, setGoalContributors } from "../src/services/goals";
import { competencyScore, goalAttainment } from "../src/domain/performance";
import type { ListScope } from "../src/domain/access";
import { grantFor } from "../bootstrap/authz/grants";
import { DEFAULT_POLICY } from "../bootstrap/authz/policy";

// Goals inside a review: the cycle link that decides which goals a review scores, the weighted attainment
// that link produces, and the snapshot that stops a shared review from re-stating itself as the goals move on.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;
const ALL: ListScope = { breadth: "all", deptCode: null, ownerId: null, seeRestricted: true };

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

const TABLES = [schema.goalContributors, schema.goalComments, schema.goals, schema.reviewFeedback, schema.reviews, schema.reviewCycles, schema.notifications, schema.auditLog, schema.eventLog, schema.settings, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
});

async function seedActor(managerId?: string): Promise<AppUser & { employeeId: string }> {
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({
    uuid: employeeId, code: `04-${genId().slice(0, 3)}`, firstName: "Test", lastName: "User",
    workEmail: `${employeeId}@test.example`, status: "active", ...(managerId ? { managerId } : {}),
  });
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role: "employee", employeeId });
  return { uuid, email: `${uuid}@test.example`, role: "employee", status: "active", employeeId, employeeCode: null, grant: grantFor("super_admin"), policy: DEFAULT_POLICY } as unknown as AppUser & { employeeId: string };
}

const cycleFor = (actor: AppUser) => createReviewCycle(deps, actor, { name: "H1 2026", period_start: "2026-01-01", period_end: "2026-06-30" });
const reviewOf = async (employeeId: string) => (await listReviews(deps, ALL, 100)).items.find((r) => r.employeeId === employeeId)!;

describe("goal attainment", () => {
  it("weights delivery by importance rather than averaging it", () => {
    // 60 at 50% + 10 at 100% = 40 of 70 = 57%, where a plain mean would claim 75%.
    const a = goalAttainment([
      { weight: 60, progress: 50, status: "in_progress" },
      { weight: 10, progress: 100, status: "completed" },
    ]);
    expect(a).toMatchObject({ score: 57, weight_total: 70, counted: 2, weighted: true });
  });

  it("drops cancelled goals whole and falls back to the mean with no weights", () => {
    expect(goalAttainment([
      { weight: 50, progress: 100, status: "completed" },
      { weight: 50, progress: 0, status: "cancelled" },
    ])).toMatchObject({ score: 100, counted: 1 });

    expect(goalAttainment([
      { weight: 0, progress: 80, status: "in_progress" },
      { weight: 0, progress: 20, status: "in_progress" },
    ])).toMatchObject({ score: 50, weight_total: 0, weighted: false });

    // Nothing to score is not a score of zero.
    expect(goalAttainment([])).toBeNull();
    expect(goalAttainment([{ weight: 10, progress: 0, status: "cancelled" }])).toBeNull();
  });

  it("never lets a weighted goal speak for the unweighted ones beside it", () => {
    // THE REGRESSION. `weight` defaults to 0, so a half-weighted set is the ordinary case - and under the old
    // Σweight > 0 test a weight-0 goal added nothing to either side of the fraction, so it did not score 0, it
    // VANISHED. One weighted goal at 100% beside five untouched ones scored the person at 100%.
    const mixed = [
      { weight: 10, progress: 100, status: "completed" as const },
      ...Array.from({ length: 5 }, () => ({ weight: 0, progress: 0, status: "in_progress" as const })),
    ];
    expect(goalAttainment(mixed)).toMatchObject({ score: 17, counted: 6, weighted: false, weight_total: 0 });

    // And the other direction: goals that DID move must not be diluted away either. Two 100%s and one
    // untouched unweighted goal is 67%, not the 100% the weighted branch used to report.
    expect(goalAttainment([
      { weight: 50, progress: 100, status: "completed" },
      { weight: 50, progress: 100, status: "completed" },
      { weight: 0, progress: 0, status: "not_started" },
    ])).toMatchObject({ score: 67, counted: 3, weighted: false });
  });

  it("counts a cancelled goal's weight in neither branch", () => {
    // Cancelling the only unweighted goal restores the weighted arithmetic, because it is dropped before the
    // all-weighted test is applied - not after.
    expect(goalAttainment([
      { weight: 60, progress: 50, status: "in_progress" },
      { weight: 10, progress: 100, status: "completed" },
      { weight: 0, progress: 0, status: "cancelled" },
    ])).toMatchObject({ score: 57, weight_total: 70, counted: 2, weighted: true });
  });
});

describe("competency score with a half-weighted framework", () => {
  it("averages every rated competency rather than dropping the unweighted ones", () => {
    // Same defect, same shape: a rated competency the framework left unweighted used to disappear from the
    // score instead of being averaged into it, so a framework mid-way through being weighted scored people on
    // a subset of the questions their manager answered.
    const comps = [
      { key: "impact", label: "Impact", weight: 3 },
      { key: "craft", label: "Craft" },
    ];
    expect(competencyScore(comps, { impact: 5, craft: 1 })).toMatchObject({ score: 3, weight_total: 0, counted: 2, weighted: false });
    // An unweighted competency nobody rated is dropped first, so the weighted arithmetic still applies.
    expect(competencyScore(comps, { impact: 5 })).toMatchObject({ score: 5, weight_total: 3, counted: 1, weighted: true });
  });
});

describe("competency score", () => {
  const comps = [
    { key: "impact", label: "Impact", weight: 3 },
    { key: "craft", label: "Craft", weight: 1 },
  ];

  it("weights the competency ratings, on the framework's own scale", () => {
    // (3x5 + 1x1) / 4 = 4, where a plain mean would claim 3.
    expect(competencyScore(comps, { impact: 5, craft: 1 })).toMatchObject({ score: 4, weight_total: 4, counted: 2, weighted: true });
  });

  it("leaves an unrated competency out instead of scoring it zero", () => {
    // Only the rated one counts: an unanswered question is not a bad answer, and counting it as a 0 would
    // hand a manager who has filled in half the form a rating nobody gave.
    expect(competencyScore(comps, { impact: 4 })).toMatchObject({ score: 4, weight_total: 3, counted: 1 });
  });

  it("falls back to the plain mean when the framework carries no weights", () => {
    const flat = [{ key: "a", label: "A" }, { key: "b", label: "B" }];
    expect(competencyScore(flat, { a: 4, b: 3 })).toMatchObject({ score: 3.5, weight_total: 0, weighted: false });
  });

  it("says nothing rather than zero when nothing was rated", () => {
    expect(competencyScore(comps, {})).toBeNull();
    expect(competencyScore([], { impact: 5 })).toBeNull();
  });
});

describe("the cycle link", () => {
  it("claims the reviewee's unattached in-window goals when the cycle launches", async () => {
    const actor = await seedActor();
    const inWindow = await createGoal(deps, actor, { title: "in window", due_date: "2026-03-31" });
    const outside = await createGoal(deps, actor, { title: "next year", due_date: "2027-03-31" });
    const undated = await createGoal(deps, actor, { title: "no due date" });
    const cancelled = await createGoal(deps, actor, { title: "called off", due_date: "2026-02-01", status: "cancelled" });

    const cycle = await cycleFor(actor);
    await launchReviewCycle(deps, actor, cycle.uuid, [`employees/${actor.employeeId}`]);

    const codes = (await cycleGoals(deps, actor.employeeId, cycle.uuid)).map((g) => g.code);
    expect(codes).toContain(inWindow.code);
    // Only the unambiguous ones: outside the period, undated, or already called off stay unattached.
    for (const g of [outside, undated, cancelled]) expect(codes).not.toContain(g.code);
  });

  it("never steals a goal that already names another cycle", async () => {
    const actor = await seedActor();
    const first = await cycleFor(actor);
    const goal = await createGoal(deps, actor, { title: "spoken for", due_date: "2026-03-31", cycle: `review-cycles/${first.uuid}` });

    const second = await createReviewCycle(deps, actor, { name: "H1 2026 (b)", period_start: "2026-01-01", period_end: "2026-06-30" });
    await launchReviewCycle(deps, actor, second.uuid, [`employees/${actor.employeeId}`]);

    expect((await cycleGoals(deps, actor.employeeId, second.uuid)).map((g) => g.code)).not.toContain(goal.code);
    expect((await cycleGoals(deps, actor.employeeId, first.uuid)).map((g) => g.code)).toEqual([goal.code]);
  });

  it("counts the reviewees who have goals, so HR can see who has nothing to score", async () => {
    const hr = await seedActor();
    const withGoals = await seedActor();
    const without = await seedActor();
    await createGoal(deps, hr, { title: "theirs", employee: `employees/${withGoals.employeeId}`, due_date: "2026-03-31" });

    const cycle = await cycleFor(hr);
    await launchReviewCycle(deps, hr, cycle.uuid, [`employees/${withGoals.employeeId}`]);
    await addRevieweesToCycle(deps, hr, cycle.uuid, [`employees/${without.employeeId}`]);

    expect((await goalCoverageFor(deps, [cycle.uuid])).get(cycle.uuid)).toBe(1);
  });

  it("cuts the link rather than the goal when a cycle is purged", async () => {
    const actor = await seedActor();
    const cycle = await cycleFor(actor);
    const goal = await createGoal(deps, actor, { title: "outlives the cycle", due_date: "2026-03-31", cycle: `review-cycles/${cycle.uuid}` });
    await launchReviewCycle(deps, actor, cycle.uuid, [`employees/${actor.employeeId}`]);

    await purgeReviewCycle(deps, actor, cycle.uuid);

    const rows = await deps.db.select().from(schema.goals);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.uuid).toBe(goal.uuid);
    expect(rows[0]!.cycleId).toBeNull();
  });

  it("splits a shared goal's weight instead of paying it twice", async () => {
    // `setGoalContributors` states the model: the owner's share is what the contributors do not take. The
    // snapshot only implemented the contributor half - the owner's line kept the goal's FULL weight while a
    // contributor also carried weight x share, so a goal 40% credited away was scored at 140% of its weight
    // across the org, and the surplus inflated the owner's attainment and the bonus priced off it.
    const owner = await seedActor();
    const helper = await seedActor();
    const cycle = await cycleFor(owner);
    const goal = await createGoal(deps, owner, { title: "the launch", due_date: "2026-03-31", weight: 100, progress: 50, cycle: `review-cycles/${cycle.uuid}` });
    await setGoalContributors(deps, owner, goal.uuid, [{ employee: `employees/${helper.employeeId}`, share: 40 }]);

    const mine = await cycleGoals(deps, owner.employeeId, cycle.uuid);
    const theirs = await cycleGoals(deps, helper.employeeId, cycle.uuid);
    expect(mine).toMatchObject([{ code: goal.code, weight: 60 }]);
    expect(theirs).toMatchObject([{ code: goal.code, weight: 40, contribution: { share: 40 } }]);
    // The whole goal is accounted for exactly once, whoever is asked.
    expect(mine[0]!.weight + theirs[0]!.weight).toBe(100);
    // Both sides score the same progress, because they are the same goal - the split is of the CREDIT.
    expect(goalAttainment(mine)).toMatchObject({ score: 50, weight_total: 60 });
    expect(goalAttainment(theirs)).toMatchObject({ score: 50, weight_total: 40 });
  });

  it("leaves an uncontributed goal's weight exactly alone", async () => {
    const owner = await seedActor();
    const cycle = await cycleFor(owner);
    const goal = await createGoal(deps, owner, { title: "all mine", due_date: "2026-03-31", weight: 100, progress: 25, cycle: `review-cycles/${cycle.uuid}` });
    expect(await cycleGoals(deps, owner.employeeId, cycle.uuid)).toMatchObject([{ code: goal.code, weight: 100 }]);
  });

  it("refuses to credit a share to somebody who is not a current employee", async () => {
    // The share comes off the owner's weight, so crediting a nobody took credit away from a real person and
    // gave it to a row no review can score.
    const owner = await seedActor();
    const goal = await createGoal(deps, owner, { title: "the launch", due_date: "2026-03-31", weight: 100 });
    await expect(setGoalContributors(deps, owner, goal.uuid, [{ employee: `employees/${genId()}`, share: 40 }])).rejects.toThrow(/not a current employee/);
  });
});

describe("goals on a review", () => {
  it("reads live goals before sharing and the frozen snapshot after", async () => {
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);
    await createGoal(deps, manager, { title: "ship it", employee: `employees/${employee.employeeId}`, due_date: "2026-03-31", weight: 100, progress: 40 });
    const cycle = await cycleFor(manager);
    await launchReviewCycle(deps, manager, cycle.uuid, [`employees/${employee.employeeId}`]);

    const before = await reviewOf(employee.employeeId);
    const live = (await goalsForReviews(deps, manager, [before])).get(before.uuid)!;
    expect(live).toMatchObject([{ title: "ship it", weight: 100, progress: 40 }]);
    expect(goalAttainment(live)).toMatchObject({ score: 40 });

    await submitSelf(deps, employee, before.uuid, "did my best");
    const goal = (await deps.db.select().from(schema.goals))[0]!;
    const shared = await submitManager(deps, manager, before.uuid, {
      ratings: { impact: 3 },
      overall_rating: 3,
      goal_ratings: { [goal.code!]: { rating: 2, comment: "landed late" } },
    });
    expect(JSON.parse(shared.goalRatingsJson!)).toMatchObject({ [goal.code!]: { rating: 2, comment: "landed late" } });

    // The goal moves on; the shared review keeps saying what it said the day it was shared.
    await updateGoalProgress(deps, employee, goal.uuid, 100, "completed");
    const after = await reviewOf(employee.employeeId);
    const frozen = (await goalsForReviews(deps, manager, [after])).get(after.uuid)!;
    expect(frozen).toMatchObject([{ title: "ship it", progress: 40 }]);
  });

  it("freezes the snapshot when the manager stage is skipped instead of submitted", async () => {
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);
    await createGoal(deps, manager, { title: "skipped cycle", employee: `employees/${employee.employeeId}`, due_date: "2026-03-31", progress: 30 });
    const cycle = await cycleFor(manager);
    await launchReviewCycle(deps, manager, cycle.uuid, [`employees/${employee.employeeId}`]);

    const review = await reviewOf(employee.employeeId);
    await submitSelf(deps, employee, review.uuid, "done");
    const skipped = await skipReviewStage(deps, manager, review.uuid);
    expect(skipped.state).toBe("SHARED");
    expect(JSON.parse(skipped.goalsJson!)).toMatchObject([{ title: "skipped cycle", progress: 30 }]);
  });

  it("drops a verdict aimed at a goal the cycle never held", async () => {
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);
    await createGoal(deps, manager, { title: "the real one", employee: `employees/${employee.employeeId}`, due_date: "2026-03-31" });
    const cycle = await cycleFor(manager);
    await launchReviewCycle(deps, manager, cycle.uuid, [`employees/${employee.employeeId}`]);
    const review = await reviewOf(employee.employeeId);
    await submitSelf(deps, employee, review.uuid, "done");

    const shared = await submitManager(deps, manager, review.uuid, { goal_ratings: { "04-999-9": { rating: 5 } } });
    expect(shared.goalRatingsJson).toBeNull();
  });

  it("hides the live goals from a reader whose own goals scope doesn't reach them", async () => {
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);
    await createGoal(deps, manager, { title: "private objective", employee: `employees/${employee.employeeId}`, due_date: "2026-03-31" });
    const cycle = await cycleFor(manager);
    await launchReviewCycle(deps, manager, cycle.uuid, [`employees/${employee.employeeId}`]);
    const review = await reviewOf(employee.employeeId);

    // A reader who may read reviews but holds `goals` only over their OWN rows sees no goals panel.
    const nosy = { ...(await seedActor()), grant: { levels: { "goals.*.me": "read" }, allow: [] }, policy: DEFAULT_POLICY } as unknown as AppUser;
    expect((await goalsForReviews(deps, nosy, [review])).get(review.uuid)).toEqual([]);
    // The owner still sees their own.
    expect((await goalsForReviews(deps, employee, [review])).get(review.uuid)).toHaveLength(1);
  });
});

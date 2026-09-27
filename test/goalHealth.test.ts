/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { goalPace, staleDays, STALE_AFTER_DAYS } from "../src/domain/goals";
import { DEFAULT_PERFORMANCE } from "../src/domain/performance";
import { createGoal, updateGoal, updateGoalProgress, setGoalConfidence, proposeGoal, approveGoal, requestGoalChanges, getGoalWithComments, commentGoal, cycleBurnup, lastCommentAtFor, deleteGoal, objectivesWithKeyResults, setGoalContributors } from "../src/services/goals";
import { createReviewCycle } from "../src/services/reviewCycles";
import { cycleGoals } from "../src/services/reviews";
import { toGoalResource } from "../src/http/serialize";
import { grantFor } from "../bootstrap/authz/grants";
import { DEFAULT_POLICY } from "../bootstrap/authz/policy";
import type { ListScope } from "../src/domain/access";

// Goal health: the numbers nobody has to fill in. Pace says where a goal should be by now, silence says how
// long since anyone touched it, the history is read back out of the audit trail, and the burn-up is the shape
// of a whole cycle. All four are derived, so the only way they can be wrong is quietly.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const DAY = 86_400_000;
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

const TABLES = [schema.goalContributors, schema.goalComments, schema.goals, schema.reviewCycles, schema.settings, schema.notifications, schema.auditLog, schema.eventLog, schema.users, schema.employees, schema.roles];
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

const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
const eqUuid = (id: string) => eq(schema.goals.uuid, id);

describe("pace", () => {
  const now = Date.parse("2026-06-01T12:00:00Z");
  const open = { progress: 0, status: "in_progress" as const };

  it("says where a goal should be by now, and how far off it is", () => {
    // Set on 1 May, due 30 June (the whole of which counts), read at midday on 1 June: 31.5 of 61 days gone.
    const g = { ...open, createdAt: Date.parse("2026-05-01T00:00:00Z"), dueDate: Date.parse("2026-06-30T00:00:00Z"), progress: 20 };
    const pace = goalPace(g, now)!;
    expect(pace.expected).toBe(52);
    expect(pace.drift).toBe(-32);
    expect(pace.state).toBe("at_risk");
  });

  it("bands drift into ahead / on track / behind / at risk", () => {
    const at = (progress: number) => goalPace({ ...open, progress, createdAt: Date.parse("2026-05-01T00:00:00Z"), dueDate: Date.parse("2026-06-30T00:00:00Z") }, now)!.state;
    expect(at(52)).toBe("on_track");
    expect(at(45)).toBe("on_track"); // 7 behind: a wobble, not a warning
    expect(at(40)).toBe("behind");
    expect(at(20)).toBe("at_risk");
    expect(at(70)).toBe("ahead");
  });

  it("refuses to answer where there is no honest answer", () => {
    const base = { createdAt: Date.parse("2026-05-01T00:00:00Z"), dueDate: Date.parse("2026-06-30T00:00:00Z"), progress: 10 };
    // No deadline: a goal cannot be behind a line that does not exist.
    expect(goalPace({ ...base, dueDate: null, status: "in_progress" }, now)).toBeNull();
    // Finished: a completed goal is not "behind" for having landed late, and a red chip on delivered work is
    // the fastest way to teach people to ignore the chip.
    expect(goalPace({ ...base, status: "completed" }, now)).toBeNull();
    expect(goalPace({ ...base, status: "cancelled" }, now)).toBeNull();
    // Back-dated: due before it was set, so there is no line at all.
    expect(goalPace({ ...base, createdAt: Date.parse("2026-07-01T00:00:00Z"), status: "in_progress" }, now)).toBeNull();
  });

  it("counts the whole of the due day, so a goal due today is not already late", () => {
    const due = Date.parse("2026-06-01T00:00:00Z");
    expect(goalPace({ ...open, createdAt: due - 10 * DAY, dueDate: due, progress: 100 }, due + 3600_000)!.expected).toBeLessThan(100);
  });
});

describe("silence", () => {
  const now = Date.parse("2026-06-01T00:00:00Z");
  it("counts from the last thing that happened, comment included", () => {
    const g = { updatedAt: now - 30 * DAY, status: "in_progress" };
    expect(staleDays(g, null, now)).toBe(30);
    // A manager asking "what's blocking this?" is the goal being alive, and it never touches the row.
    expect(staleDays(g, now - 2 * DAY, now)).toBe(2);
  });

  it("says nothing about a finished goal, which is supposed to go quiet", () => {
    expect(staleDays({ updatedAt: now - 90 * DAY, status: "completed" }, null, now)).toBeNull();
    expect(staleDays({ updatedAt: now - 90 * DAY, status: "cancelled" }, null, now)).toBeNull();
  });
});

describe("the goal resource", () => {
  it("carries pace and silence, and omits them rather than reporting a flattering zero", async () => {
    const actor = await seedActor();
    const behind = await createGoal(deps, actor, { title: "behind", due_date: ymd(Date.now() + 10 * DAY) });
    // Backdated so the line has actually been running: set 90 days ago, due in 10, untouched for 30.
    await b.DB.prepare("update goals set created_at = ?, updated_at = ? where uuid = ?")
      .bind(Date.now() - 90 * DAY, Date.now() - 30 * DAY, behind.uuid).run();
    const row = (await deps.db.select().from(schema.goals))[0]!;
    const wire = toGoalResource(row) as Record<string, unknown>;
    expect(wire.pace).toBe("at_risk");
    expect(wire.expected_progress).toBeGreaterThan(80);
    expect(wire.stale_days).toBe(30);

    // An undated goal reports no pace at all - not a drift of 0, which reads as healthy.
    const undated = await createGoal(deps, actor, { title: "someday" });
    const undatedWire = toGoalResource((await deps.db.select().from(schema.goals)).find((g) => g.uuid === undated.uuid)!) as Record<string, unknown>;
    expect(undatedWire.pace).toBeUndefined();
    expect(undatedWire.drift).toBeUndefined();
  });

  it("counts a comment as activity", async () => {
    const actor = await seedActor();
    const g = await createGoal(deps, actor, { title: "discussed" });
    await commentGoal(deps, actor, g.uuid, "how is this going?");
    const map = await lastCommentAtFor(deps, [g.uuid]);
    expect(map.get(g.uuid)).toBeInstanceOf(Date);
  });
});

describe("confidence", () => {
  it("records the owner's call and tells the manager when it turns", async () => {
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);
    const g = await createGoal(deps, employee, { title: "slipping" });

    const flagged = await setGoalConfidence(deps, employee, g.uuid, "off_track", "vendor slipped a month");
    expect(flagged.confidence).toBe("off_track");
    expect(flagged.confidenceNote).toBe("vendor slipped a month");

    const events = await deps.db.select().from(schema.eventLog);
    expect(events.some((e) => e.type === "goal.confidenceChanged")).toBe(true);
    const notes = await deps.db.select().from(schema.notifications);
    expect(notes.some((n) => n.recipientId === manager.employeeId && n.type === "goal.at_risk")).toBe(true);
  });

  it("announces a MOVE, not a re-statement", async () => {
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);
    const g = await createGoal(deps, employee, { title: "steady" });
    await setGoalConfidence(deps, employee, g.uuid, "on_track");
    await setGoalConfidence(deps, employee, g.uuid, "on_track");
    const events = (await deps.db.select().from(schema.eventLog)).filter((e) => e.type === "goal.confidenceChanged");
    expect(events).toHaveLength(1);
    // On track is not news for the manager either.
    expect(await deps.db.select().from(schema.notifications)).toHaveLength(0);
  });

  it("refuses a call on a goal that is already closed", async () => {
    const actor = await seedActor();
    const g = await createGoal(deps, actor, { title: "done", status: "completed" });
    await expect(setGoalConfidence(deps, actor, g.uuid, "at_risk")).rejects.toThrow(/already closed/);
  });
});

describe("history", () => {
  it("rebuilds the progress series from the audit trail, opening at the beginning", async () => {
    const actor = await seedActor();
    const g = await createGoal(deps, actor, { title: "climbed" });
    await updateGoalProgress(deps, actor, g.uuid, 30);
    await updateGoal(deps, actor, g.uuid, { progress: 65 });
    await updateGoalProgress(deps, actor, g.uuid, 90);

    const full = await getGoalWithComments(deps, g.uuid);
    expect(full._history.map((p) => p.progress)).toEqual([0, 30, 65, 90]);
  });
});

describe("the cycle burn-up", () => {
  it("replays the cycle's goals week by week against the line it should follow", async () => {
    const actor = await seedActor();
    const start = Date.now() - 21 * DAY;
    const cycle = await createReviewCycle(deps, actor, { name: "Burnup", period_start: ymd(start), period_end: ymd(Date.now() + 7 * DAY) });
    const g = await createGoal(deps, actor, { title: "the work", weight: 100, cycle: `review-cycles/${cycle.uuid}` });
    await b.DB.prepare("update goals set created_at = ? where uuid = ?").bind(start, g.uuid).run();
    await updateGoalProgress(deps, actor, g.uuid, 60);
    await b.DB.prepare("update audit_log set at = ? where action = 'goal.updateProgress'").bind(start + 7 * DAY).run();

    const curve = await cycleBurnup(deps, ALL, cycle.uuid);
    expect(curve.length).toBeGreaterThan(2);
    expect(curve[0]).toMatchObject({ attained: 0, expected: 0 });
    // The move landed a week in, and everything from that point carries it.
    expect(curve[curve.length - 1]!.attained).toBe(60);
    // The expected line climbs, and never past 100.
    expect(curve[curve.length - 1]!.expected).toBeGreaterThan(curve[0]!.expected);
    expect(Math.max(...curve.map((p) => p.expected))).toBeLessThanOrEqual(100);
  });

  it("is empty for a cycle with no goals, and never counts a cancelled one", async () => {
    const actor = await seedActor();
    const cycle = await createReviewCycle(deps, actor, { name: "Empty", period_start: ymd(Date.now() - 7 * DAY), period_end: ymd(Date.now() + 7 * DAY) });
    expect(await cycleBurnup(deps, ALL, cycle.uuid)).toEqual([]);
    await createGoal(deps, actor, { title: "called off", status: "cancelled", cycle: `review-cycles/${cycle.uuid}` });
    expect(await cycleBurnup(deps, ALL, cycle.uuid)).toEqual([]);
  });
});

describe("the goal-setting handshake", () => {
  // Approval is off by default, so turning it on is part of the setup - which is itself the first assertion.
  const requireApproval = async () => {
    await deps.db.insert(schema.settings).values({ key: "performance", value: JSON.stringify({ ...DEFAULT_PERFORMANCE, goal_approval: "required" }) });
  };

  it("agrees a goal on the spot when the org has not turned approval on", async () => {
    const actor = await seedActor();
    const g = await createGoal(deps, actor, { title: "just work" });
    expect(g.stage).toBe("AGREED");
    expect(g.agreedAt).toBeTruthy();
  });

  it("runs DRAFT -> PROPOSED -> AGREED, stamping who agreed it", async () => {
    await requireApproval();
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);

    const draft = await createGoal(deps, employee, { title: "mine to propose" });
    expect(draft.stage).toBe("DRAFT");
    expect(draft.agreedAt).toBeNull();

    const proposed = await proposeGoal(deps, employee, draft.uuid);
    expect(proposed.stage).toBe("PROPOSED");
    const notes = await deps.db.select().from(schema.notifications);
    expect(notes.some((n) => n.recipientId === manager.employeeId && n.type === "goal.proposed")).toBe(true);

    const agreed = await approveGoal(deps, manager, draft.uuid);
    expect(agreed.stage).toBe("AGREED");
    expect(agreed.agreedById).toBe(manager.employeeId);
    expect(agreed.agreedAt).toBeTruthy();
    const events = (await deps.db.select().from(schema.eventLog)).map((e) => e.type);
    expect(events).toContain("goal.proposed");
    expect(events).toContain("goal.agreed");
  });

  it("lands a manager's goal for a report already agreed - the approver is the person typing", async () => {
    await requireApproval();
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);
    const g = await createGoal(deps, manager, { title: "your goal, from me", employee: `employees/${employee.employeeId}` });
    expect(g.stage).toBe("AGREED");
  });

  it("sends a goal back with the reason ON the goal, where the reply can reach it", async () => {
    await requireApproval();
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);
    const g = await createGoal(deps, employee, { title: "too vague" });
    await proposeGoal(deps, employee, g.uuid);

    const back = await requestGoalChanges(deps, manager, g.uuid, "  what number are we aiming at?  ");
    expect(back.stage).toBe("DRAFT");
    const comments = await deps.db.select().from(schema.goalComments);
    expect(comments.map((c) => c.body)).toEqual(["what number are we aiming at?"]);
    const notes = await deps.db.select().from(schema.notifications);
    expect(notes.some((n) => n.recipientId === employee.employeeId && n.type === "goal.changes_requested")).toBe(true);

    // And it can go round again.
    expect((await proposeGoal(deps, employee, g.uuid)).stage).toBe("PROPOSED");
  });

  it("refuses the moves that do not belong to the stage", async () => {
    await requireApproval();
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);
    const g = await createGoal(deps, employee, { title: "draft" });

    await expect(requestGoalChanges(deps, manager, g.uuid, "no")).rejects.toThrow(/only a proposed goal/);
    // A DRAFT is the owner's to submit. Agreeing one skips the handshake entirely and stamps `agreed_by` on
    // something they were still writing - which a review then scores them against.
    await expect(approveGoal(deps, manager, g.uuid)).rejects.toThrow(/only a proposed goal can be agreed/);
    await proposeGoal(deps, employee, g.uuid);
    await expect(proposeGoal(deps, employee, g.uuid)).rejects.toThrow(/only a draft goal/);
    await approveGoal(deps, manager, g.uuid);
    await expect(approveGoal(deps, manager, g.uuid)).rejects.toThrow(/already agreed/);
  });

  it("tells a review that a goal it is scoring was never agreed", async () => {
    await requireApproval();
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);
    const cycle = await createReviewCycle(deps, manager, { name: "Unagreed", period_start: ymd(Date.now() - 7 * DAY), period_end: ymd(Date.now() + 7 * DAY) });
    const g = await createGoal(deps, employee, { title: "never signed off", cycle: `review-cycles/${cycle.uuid}` });

    const [snapshot] = await cycleGoals(deps, employee.employeeId, cycle.uuid);
    expect(snapshot!.stage).toBe("DRAFT");
    // Agreed goals say nothing - the marker exists to flag the exception, not to label the norm. Agreed
    // through the real handshake: `approveGoal` only accepts a PROPOSED goal, because a goal its owner is
    // still drafting must not be agreed out from under them.
    await proposeGoal(deps, employee, g.uuid);
    await approveGoal(deps, manager, g.uuid);
    expect((await cycleGoals(deps, employee.employeeId, cycle.uuid))[0]!.stage).toBeUndefined();
  });
});

describe("key results", () => {
  const progressOf = async (id: string) => (await deps.db.select().from(schema.goals).where(eqUuid(id)).limit(1))[0]!.progress;

  it("derives the objective's progress from its key results, weighted", async () => {
    const actor = await seedActor();
    const objective = await createGoal(deps, actor, { title: "make onboarding excellent" });
    const heavy = await createGoal(deps, actor, { title: "time to first commit < 3 days", kind: "key_result", parent: `goals/${objective.uuid}`, weight: 75 });
    await createGoal(deps, actor, { title: "buddy assigned day one", kind: "key_result", parent: `goals/${objective.uuid}`, weight: 25 });

    await updateGoalProgress(deps, actor, heavy.uuid, 40);
    // 75 at 40% + 25 at 0% = 30 of 100.
    expect(await progressOf(objective.uuid)).toBe(30);
  });

  it("refuses to let anyone type over a derived objective", async () => {
    const actor = await seedActor();
    const objective = await createGoal(deps, actor, { title: "objective" });
    const kr = await createGoal(deps, actor, { title: "kr", kind: "key_result", parent: `goals/${objective.uuid}`, weight: 100 });
    await updateGoalProgress(deps, actor, kr.uuid, 50);

    await expect(updateGoalProgress(deps, actor, objective.uuid, 100)).rejects.toThrow(/comes from its key results/);
    // The edit form's `progress` is dropped rather than refused - the next roll-up would overwrite it anyway.
    await updateGoal(deps, actor, objective.uuid, { progress: 99, title: "objective (renamed)" });
    expect(await progressOf(objective.uuid)).toBe(50);
  });

  it("needs an objective to sit under, and never parents another key result", async () => {
    const actor = await seedActor();
    await expect(createGoal(deps, actor, { title: "orphan", kind: "key_result" })).rejects.toThrow(/needs an objective/);
  });

  it("drops a cancelled key result whole, and re-rolls when one is deleted", async () => {
    const actor = await seedActor();
    const objective = await createGoal(deps, actor, { title: "objective" });
    const a = await createGoal(deps, actor, { title: "a", kind: "key_result", parent: `goals/${objective.uuid}`, weight: 50 });
    const bKr = await createGoal(deps, actor, { title: "b", kind: "key_result", parent: `goals/${objective.uuid}`, weight: 50 });
    await updateGoalProgress(deps, actor, a.uuid, 100);
    expect(await progressOf(objective.uuid)).toBe(50);

    // Cancelling the one that never moved leaves the objective at what the remaining work says.
    await updateGoal(deps, actor, bKr.uuid, { status: "cancelled" });
    expect(await progressOf(objective.uuid)).toBe(100);

    // And deleting a key result re-rolls too, rather than leaving a figure derived from a goal that is gone.
    await updateGoal(deps, actor, bKr.uuid, { status: "in_progress" });
    expect(await progressOf(objective.uuid)).toBe(50);
    await deleteGoal(deps, actor, bKr.uuid);
    expect(await progressOf(objective.uuid)).toBe(100);
  });

  it("tells the page which objectives are derived, in one query", async () => {
    const actor = await seedActor();
    const derived = await createGoal(deps, actor, { title: "has KRs" });
    const plain = await createGoal(deps, actor, { title: "no KRs" });
    await createGoal(deps, actor, { title: "kr", kind: "key_result", parent: `goals/${derived.uuid}` });
    const set = await objectivesWithKeyResults(deps, [derived.uuid, plain.uuid]);
    expect([...set]).toEqual([derived.uuid]);
  });
});

describe("contribution credit", () => {
  it("credits a share of somebody else's goal into the contributor's own review", async () => {
    const manager = await seedActor();
    const owner = await seedActor(manager.employeeId);
    const helper = await seedActor(manager.employeeId);
    const cycle = await createReviewCycle(deps, manager, { name: "Shared", period_start: ymd(Date.now() - 7 * DAY), period_end: ymd(Date.now() + 7 * DAY) });
    const goal = await createGoal(deps, manager, { title: "the launch", employee: `employees/${owner.employeeId}`, weight: 100, progress: 50, cycle: `review-cycles/${cycle.uuid}` });

    await setGoalContributors(deps, manager, goal.uuid, [{ employee: `employees/${helper.employeeId}`, share: 40 }]);

    // The owner keeps what the contributors did not take. This assertion used to read "the owner's own set is
    // untouched - a share is credited, not carved out", which is the double-count: the owner carried the full
    // 100 while the helper also carried 40, so the goal was scored at 140% of its weight across the org and
    // the surplus inflated the owner's attainment (and the bonus priced off it in services/variablePay.ts).
    // `setGoalContributors` states the model this now implements: the owner's share is the remainder.
    const ownerSet = await cycleGoals(deps, owner.employeeId, cycle.uuid);
    expect(ownerSet).toHaveLength(1);
    expect(ownerSet[0]).toMatchObject({ weight: 60, progress: 50 });
    expect(ownerSet[0]!.contribution).toBeUndefined();

    // The helper's review scores the same goal at 40 weight, and says whose it was.
    const helperSet = await cycleGoals(deps, helper.employeeId, cycle.uuid);
    expect(helperSet).toHaveLength(1);
    expect(helperSet[0]).toMatchObject({ weight: 40, progress: 50, contribution: { share: 40, owner: `employees/${owner.employeeId}` } });

    // The whole goal is accounted for exactly once, across the two reviews that score it.
    expect(ownerSet[0]!.weight + helperSet[0]!.weight).toBe(100);

    // And the helper hears about it, rather than finding out at review time.
    const notes = await deps.db.select().from(schema.notifications);
    expect(notes.some((n) => n.recipientId === helper.employeeId && n.type === "goal.contributor")).toBe(true);
  });

  it("refuses a split that credits more than the goal, the owner, or one person twice", async () => {
    const actor = await seedActor();
    const other = await seedActor();
    const third = await seedActor();
    const goal = await createGoal(deps, actor, { title: "mine", weight: 100 });

    await expect(setGoalContributors(deps, actor, goal.uuid, [
      { employee: `employees/${other.employeeId}`, share: 60 },
      { employee: `employees/${third.employeeId}`, share: 60 },
    ])).rejects.toThrow(/add up to 120%/);
    await expect(setGoalContributors(deps, actor, goal.uuid, [{ employee: `employees/${actor.employeeId}`, share: 50 }]))
      .rejects.toThrow(/owner is not one of its contributors/);
    await expect(setGoalContributors(deps, actor, goal.uuid, [
      { employee: `employees/${other.employeeId}`, share: 10 },
      { employee: `employees/${other.employeeId}`, share: 10 },
    ])).rejects.toThrow(/listed twice/);
  });

  it("replaces the whole set, so clearing it really clears it", async () => {
    const actor = await seedActor();
    const other = await seedActor();
    const goal = await createGoal(deps, actor, { title: "mine", weight: 50 });
    await setGoalContributors(deps, actor, goal.uuid, [{ employee: `employees/${other.employeeId}`, share: 30 }]);
    expect(await deps.db.select().from(schema.goalContributors)).toHaveLength(1);
    await setGoalContributors(deps, actor, goal.uuid, []);
    expect(await deps.db.select().from(schema.goalContributors)).toHaveLength(0);
  });
});

describe("waiting on another goal", () => {
  it("links one goal to the goal it is waiting on", async () => {
    const actor = await seedActor();
    const blocker = await createGoal(deps, actor, { title: "platform migration" });
    const waiting = await createGoal(deps, actor, { title: "ship the feature", blocked_by: `goals/${blocker.uuid}` });
    expect(waiting.blockedById).toBe(blocker.uuid);
    const cleared = await updateGoal(deps, actor, waiting.uuid, { blocked_by: null });
    expect(cleared.blockedById).toBeNull();
  });

  it("refuses a goal waiting on itself, on a missing goal, or on a mutual deadlock", async () => {
    const actor = await seedActor();
    const a = await createGoal(deps, actor, { title: "a" });
    const bGoal = await createGoal(deps, actor, { title: "b", blocked_by: `goals/${a.uuid}` });

    await expect(updateGoal(deps, actor, a.uuid, { blocked_by: `goals/${a.uuid}` })).rejects.toThrow(/cannot wait on itself/);
    await expect(createGoal(deps, actor, { title: "c", blocked_by: `goals/${genId()}` })).rejects.toThrow(/not found/);
    // b already waits on a, so a waiting on b is a pair nobody can act on.
    await expect(updateGoal(deps, actor, a.uuid, { blocked_by: `goals/${bGoal.uuid}` })).rejects.toThrow(/waiting on each other/);
  });
});

describe("the closing note", () => {
  it("carries what happened into the review's snapshot", async () => {
    const actor = await seedActor();
    const cycle = await createReviewCycle(deps, actor, { name: "Retro", period_start: ymd(Date.now() - 7 * DAY), period_end: ymd(Date.now() + 7 * DAY) });
    const g = await createGoal(deps, actor, { title: "shipped late", cycle: `review-cycles/${cycle.uuid}` });
    await updateGoal(deps, actor, g.uuid, { retro: "  the vendor slipped a month; we shipped a smaller v1  ", status: "completed" });

    const [snapshot] = await cycleGoals(deps, actor.employeeId, cycle.uuid);
    expect(snapshot!.retro).toBe("the vendor slipped a month; we shipped a smaller v1");
  });
});

describe("the attainment trend", () => {
  it("reads each cycle from the review that froze it, oldest first, shared only", async () => {
    const { attainmentTrend } = await import("../src/services/reviews");
    const { launchReviewCycle } = await import("../src/services/reviewCycles");
    const { listReviews, submitSelf, submitManager } = await import("../src/services/reviews");
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);

    // Two finished cycles at different attainment, and one still in flight.
    for (const [name, end, progress] of [["Q1", -60, 40], ["Q2", -20, 90]] as const) {
      const cycle = await createReviewCycle(deps, manager, { name, period_start: ymd(Date.now() + (end - 30) * DAY), period_end: ymd(Date.now() + end * DAY) });
      await createGoal(deps, manager, { title: `${name} work`, employee: `employees/${employee.employeeId}`, weight: 100, progress, cycle: `review-cycles/${cycle.uuid}` });
      await launchReviewCycle(deps, manager, cycle.uuid, [`employees/${employee.employeeId}`]);
      const review = (await listReviews(deps, { breadth: "all", deptCode: null, ownerId: null, seeRestricted: true }, 100)).items.find((r) => r.cycleId === cycle.uuid)!;
      await submitSelf(deps, employee, review.uuid, "done");
      await submitManager(deps, manager, review.uuid, { overall_rating: 3 });
    }
    const live = await createReviewCycle(deps, manager, { name: "Q3", period_start: ymd(Date.now() - 10 * DAY), period_end: ymd(Date.now() + 20 * DAY) });
    await createGoal(deps, manager, { title: "Q3 work", employee: `employees/${employee.employeeId}`, weight: 100, progress: 10, cycle: `review-cycles/${live.uuid}` });
    await launchReviewCycle(deps, manager, live.uuid, [`employees/${employee.employeeId}`]);

    const trend = await attainmentTrend(deps, employee.employeeId);
    expect(trend.map((p) => [p.name, p.attainment])).toEqual([["Q1", 40], ["Q2", 90]]);
    expect(trend.every((p) => p.rating === 3)).toBe(true);
  });
});

describe("the stale threshold", () => {
  it("is three weeks", () => {
    expect(STALE_AFTER_DAYS).toBe(21);
  });
});

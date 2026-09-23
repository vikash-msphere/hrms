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
import { eq } from "drizzle-orm";
import { createGoal, linkedTaskRollup } from "../src/services/goals";
import { recomputeGoalProgress } from "../src/services/cards";
import { toGoalResource } from "../src/http/serialize";

// The linked-task rollup a goal card renders ("3/5 tasks · 8/13 pts"). It has to equal what the linked cards
// say, because the client no longer reads them to check: it renders whatever the goal resource carries.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

const TABLES = [schema.auditLog, schema.eventLog, schema.cards, schema.boards, schema.goals, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

async function seedActor(): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: `04-${genId().slice(0, 3)}`, firstName: "Test", lastName: "User", workEmail: `${employeeId}@test.example`, status: "active" });
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role: "employee", employeeId });
  return { uuid, email: `${uuid}@test.example`, role: "employee", status: "active", employeeId, employeeCode: null, name: "Test User" } as unknown as AppUser;
}

async function seedBoard(): Promise<string> {
  const board = genId();
  await deps.db.insert(schema.boards).values({ uuid: board, code: `01-${genId().slice(0, 3)}`, name: "Board" });
  return board;
}

type CardOpts = { goalId?: string | null; size?: number | null; delivered?: boolean; deleted?: boolean };
async function seedCard(board: string, employeeId: string, rank: number, o: CardOpts) {
  await deps.db.insert(schema.cards).values({
    uuid: genId(),
    code: `${rank}-${genId().slice(0, 4)}`,
    boardId: board,
    employeeId,
    assigneeId: employeeId,
    columnKey: "doing",
    rank,
    title: `card ${rank}`,
    goalId: o.goalId ?? null,
    size: o.size ?? null,
    deliveredAt: o.delivered ? new Date() : null,
    deleteTime: o.deleted ? new Date() : null,
  });
}

describe("goal linked-task rollup", () => {
  it("counts tasks and points, delivered and not, per goal", async () => {
    const actor = await seedActor();
    const board = await seedBoard();
    const a = await createGoal(deps, actor, { title: "Goal A" });
    const bGoal = await createGoal(deps, actor, { title: "Goal B" });
    await seedCard(board, actor.employeeId!, 1, { goalId: a.uuid, size: 5, delivered: true });
    await seedCard(board, actor.employeeId!, 2, { goalId: a.uuid, size: 8 });
    await seedCard(board, actor.employeeId!, 3, { goalId: a.uuid, size: null }); // no estimate: counts as a task, 0 pts
    await seedCard(board, actor.employeeId!, 4, { goalId: a.uuid, size: 3, deleted: true }); // binned: not a task
    await seedCard(board, actor.employeeId!, 5, { goalId: bGoal.uuid, size: 2 });
    await seedCard(board, actor.employeeId!, 6, {}); // linked to nothing

    const roll = await linkedTaskRollup(deps, [a.uuid, bGoal.uuid]);
    expect(roll.get(a.uuid)).toEqual({ tasks: 3, delivered: 1, points: 13, deliveredPoints: 5 });
    expect(roll.get(bGoal.uuid)).toEqual({ tasks: 1, delivered: 0, points: 2, deliveredPoints: 0 });
  });

  it("reports a goal with no linked tasks as zeroes on the wire, not as absent fields", async () => {
    const actor = await seedActor();
    const goal = await createGoal(deps, actor, { title: "Unlinked" });
    const roll = await linkedTaskRollup(deps, [goal.uuid]);
    expect(roll.get(goal.uuid)).toBeUndefined(); // nothing to group
    // The serializer is what the client reads, and it must answer 0 rather than undefined - a card renders the
    // chip only when linked_tasks > 0, so an absent field would make "no tasks" indistinguishable from "unknown".
    const wire = toGoalResource({ ...goal, _tasks: roll.get(goal.uuid) });
    expect(wire.linked_tasks).toBe(0);
    expect(wire.delivered_tasks).toBe(0);
    expect(wire.task_points).toBe(0);
    expect(wire.delivered_task_points).toBe(0);
  });

  it("asks nothing of the database for an empty page of goals", async () => {
    const roll = await linkedTaskRollup(deps, []);
    expect(roll.size).toBe(0);
  });
});

// The roll-up that WRITES, as opposed to the one above that reads. `updateGoalProgress` files an audit entry
// and emits `goal.progress` on every call, and this function is reached from the commonest write on the board,
// so it has to decide for itself whether anything actually moved - the objective roll-up next door
// (services/goals.ts) has always had that guard and this one did not.
describe("writing a goal's progress back from its linked tasks", () => {
  const progressAudits = async (goalId: string) =>
    (await deps.db.select().from(schema.auditLog)).filter((r) => r.action === "goal.updateProgress" && r.entityId === goalId);

  it("writes once, and not again while nothing has moved", async () => {
    const actor = await seedActor();
    const board = await seedBoard();
    const goal = await createGoal(deps, actor, { title: "Ship it" });
    await seedCard(board, actor.employeeId!, 1, { goalId: goal.uuid, size: 1, delivered: true });
    await seedCard(board, actor.employeeId!, 2, { goalId: goal.uuid, size: 1 });

    await recomputeGoalProgress(deps, actor, goal.uuid);
    expect((await progressAudits(goal.uuid)).length).toBe(1);
    expect((await deps.db.select().from(schema.goals).where(eq(schema.goals.uuid, goal.uuid)))[0]?.progress).toBe(50);

    // A card moved between two undelivered columns re-runs this with the same answer. Before the guard, every
    // such move filed an audit entry recording a change from 50 to 50 and emitted a domain event the
    // automation engine then dispatched.
    await recomputeGoalProgress(deps, actor, goal.uuid);
    await recomputeGoalProgress(deps, actor, goal.uuid);
    expect((await progressAudits(goal.uuid)).length).toBe(1);
  });

  it("still writes when the percentage is unchanged but the status is not what it should be", async () => {
    // The guard compares the STATUS too. A goal sitting at 100% whose status was put back by hand needs the
    // write, and guarding on the number alone would skip it for ever.
    const actor = await seedActor();
    const board = await seedBoard();
    const goal = await createGoal(deps, actor, { title: "Done, allegedly" });
    await seedCard(board, actor.employeeId!, 1, { goalId: goal.uuid, size: 1, delivered: true });

    await recomputeGoalProgress(deps, actor, goal.uuid);
    expect((await progressAudits(goal.uuid)).length).toBe(1);

    await deps.db.update(schema.goals).set({ status: "in_progress" }).where(eq(schema.goals.uuid, goal.uuid));
    await recomputeGoalProgress(deps, actor, goal.uuid);
    const after = (await deps.db.select().from(schema.goals).where(eq(schema.goals.uuid, goal.uuid)))[0];
    expect(after?.status).toBe("completed");
    expect((await progressAudits(goal.uuid)).length).toBe(2);
  });
});

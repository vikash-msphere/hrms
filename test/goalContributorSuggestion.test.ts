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
import { createGoal, suggestedContributorsFor } from "../src/services/goals";
import { toGoalResource } from "../src/http/serialize";

// The contributor split the linked tasks already imply. Contributor shares score in somebody else's review, so
// the suggestion has to be arithmetic anyone can check against the board: whose delivered tasks, how big.
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

async function seedEmployee(first: string): Promise<string> {
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: `04-${genId().slice(0, 3)}`, firstName: first, lastName: "User", workEmail: `${employeeId}@test.example`, status: "active" });
  return employeeId;
}

async function seedActor(): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const employeeId = await seedEmployee("Owner");
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role: "employee", employeeId });
  return { uuid, email: `${uuid}@test.example`, role: "employee", status: "active", employeeId, employeeCode: null, name: "Owner User" } as unknown as AppUser;
}

async function seedBoard(): Promise<string> {
  const board = genId();
  await deps.db.insert(schema.boards).values({ uuid: board, code: `01-${genId().slice(0, 3)}`, name: "Board" });
  return board;
}

type CardOpts = { goalId?: string | null; assigneeId?: string | null; size?: number | null; delivered?: boolean; deleted?: boolean };
let rank = 0;
async function seedCard(board: string, filerId: string, o: CardOpts) {
  rank += 1;
  await deps.db.insert(schema.cards).values({
    uuid: genId(),
    code: `${rank}-${genId().slice(0, 4)}`,
    boardId: board,
    employeeId: filerId,
    assigneeId: o.assigneeId ?? null,
    columnKey: "doing",
    rank,
    title: `card ${rank}`,
    goalId: o.goalId ?? null,
    size: o.size ?? null,
    deliveredAt: o.delivered ? new Date() : null,
    deleteTime: o.deleted ? new Date() : null,
  });
}

describe("suggested goal contributors", () => {
  it("splits the delivered points per assignee and leaves the owner's share as the remainder", async () => {
    const actor = await seedActor();
    const owner = actor.employeeId!;
    const sam = await seedEmployee("Sam");
    const priya = await seedEmployee("Priya");
    const board = await seedBoard();
    const goal = await createGoal(deps, actor, { title: "Launch" });

    await seedCard(board, owner, { goalId: goal.uuid, assigneeId: sam, size: 3, delivered: true });
    await seedCard(board, owner, { goalId: goal.uuid, assigneeId: priya, size: 1, delivered: true });
    await seedCard(board, owner, { goalId: goal.uuid, assigneeId: owner, size: 4, delivered: true }); // owner's own: denominator only
    await seedCard(board, owner, { goalId: goal.uuid, assigneeId: null, size: 1, delivered: true }); // nobody's: falls to the owner
    await seedCard(board, owner, { goalId: goal.uuid, assigneeId: sam, size: 5 }); // not delivered: no credit yet
    await seedCard(board, owner, { goalId: goal.uuid, assigneeId: priya, size: 9, deleted: true }); // binned

    const out = await suggestedContributorsFor(deps, [{ uuid: goal.uuid, employeeId: owner }]);
    // 9 points delivered: Sam 3, Priya 1, owner 4, unassigned 1. The owner is never a row - their credit is
    // the 5 points the contributors do not take.
    expect(out.get(goal.uuid)).toEqual([
      { employeeId: sam, share: 33, deliveredPoints: 3, deliveredTasks: 1 },
      { employeeId: priya, share: 11, deliveredPoints: 1, deliveredTasks: 1 },
    ]);
  });

  it("counts one point per task when no linked task carries an estimate", async () => {
    const actor = await seedActor();
    const owner = actor.employeeId!;
    const sam = await seedEmployee("Sam");
    const board = await seedBoard();
    const goal = await createGoal(deps, actor, { title: "Unsized" });

    await seedCard(board, owner, { goalId: goal.uuid, assigneeId: sam, delivered: true });
    await seedCard(board, owner, { goalId: goal.uuid, assigneeId: sam, delivered: true });
    await seedCard(board, owner, { goalId: goal.uuid, assigneeId: owner, delivered: true });
    await seedCard(board, owner, { goalId: goal.uuid, assigneeId: sam }); // open

    const out = await suggestedContributorsFor(deps, [{ uuid: goal.uuid, employeeId: owner }]);
    // Same weighting the card roll-up uses, so the suggestion and the delivery chip never disagree: 2 of 3
    // delivered tasks were Sam's.
    expect(out.get(goal.uuid)).toEqual([{ employeeId: sam, share: 67, deliveredPoints: 2, deliveredTasks: 2 }]);
  });

  it("suggests nothing until something is delivered, rather than suggesting 0%", async () => {
    const actor = await seedActor();
    const owner = actor.employeeId!;
    const sam = await seedEmployee("Sam");
    const board = await seedBoard();
    const goal = await createGoal(deps, actor, { title: "In flight" });
    await seedCard(board, owner, { goalId: goal.uuid, assigneeId: sam, size: 5 });

    const out = await suggestedContributorsFor(deps, [{ uuid: goal.uuid, employeeId: owner }]);
    expect(out.get(goal.uuid)).toBeUndefined();
    // Absent on the wire is an empty array, so a client renders "no suggestion" without a null check.
    expect(toGoalResource({ ...goal, _suggestedContributors: out.get(goal.uuid) }).suggested_contributors).toEqual([]);
  });

  it("never suggests a split the service would refuse", async () => {
    const actor = await seedActor();
    const owner = actor.employeeId!;
    const board = await seedBoard();
    const goal = await createGoal(deps, actor, { title: "Six ways" });
    // Six equal delivered tasks, none of them the owner's: 16.67% each rounds to 17, which adds up to 102.
    for (let i = 0; i < 6; i += 1) {
      await seedCard(board, owner, { goalId: goal.uuid, assigneeId: await seedEmployee(`P${i}`), size: 1, delivered: true });
    }

    const rows = (await suggestedContributorsFor(deps, [{ uuid: goal.uuid, employeeId: owner }])).get(goal.uuid)!;
    expect(rows).toHaveLength(6);
    expect(rows.reduce((s, r) => s + r.share, 0)).toBeLessThanOrEqual(100);
  });

  it("asks nothing of the database for an empty page of goals", async () => {
    const out = await suggestedContributorsFor(deps, []);
    expect(out.size).toBe(0);
  });
});

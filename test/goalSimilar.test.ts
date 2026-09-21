/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import type { ListScope } from "../src/domain/access";
import { vectorIdOf } from "../src/lib/vector";
import { similarGoals } from "../src/services/goalSimilar";

// Two teams planning the same quarter in different words, and the goal a personal one should roll up under.
//
// The properties worth holding: the switch is checked BEFORE the index is touched, a goal the caller could
// not have listed is never named (a goal's title is frequently the strategy), alignment is only offered
// where the question is still open, and an already-aligned goal is left alone.

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

const ME = genId();
const THEM = genId();
const DEPT = genId();
const all = (): ListScope => ({ breadth: "all", deptCode: null, ownerId: null, seeRestricted: true });

function fakeIndex(neighbours: { id: string; score: number }[], selfVector: number[] | null = [0.1, 0.2]) {
  return {
    async upsert() { /* unused */ },
    async query() { return neighbours; },
    async fetch(ids: string[]) {
      const out = new Map<string, number[]>();
      if (selfVector) for (const id of ids) out.set(id, selfVector);
      return out;
    },
    async remove() { /* unused */ },
  };
}
const near = (ids: string[], score = 0.92) => ids.map((id) => ({ id: vectorIdOf("goals", id), score }));

const TABLES = [schema.goals, schema.employees, schema.departments, schema.settings];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  await deps.db.insert(schema.settings).values({ key: "ai", value: JSON.stringify({ features: { "goals.similar": true } }) });
  await deps.db.insert(schema.departments).values({ uuid: DEPT, code: "04", name: "Engineering" });
  await deps.db.insert(schema.employees).values([
    { uuid: ME, code: "04-001-001", firstName: "Me", lastName: "X", workEmail: "me@x.test", status: "active" },
    { uuid: THEM, code: "04-001-002", firstName: "Ola", lastName: "Other", workEmail: "ola@x.test", status: "active" },
  ]);
});

let n = 0;
async function goal(over: Partial<typeof schema.goals.$inferInsert> = {}) {
  const uuid = genId();
  await deps.db.insert(schema.goals).values({
    uuid, code: `g-${uuid.slice(0, 6)}`, employeeId: ME, title: `Goal ${++n}`, progress: 10, ...over,
  });
  return uuid;
}

describe("goals aiming at the same thing", () => {
  it("calls a near-identical goal owned by somebody else an overlap", async () => {
    const mine = await goal();
    const theirs = await goal({ employeeId: THEM, title: "Make the first week faster" });
    deps.vectors = fakeIndex(near([theirs, mine], 0.93));
    const out = await similarGoals(deps, all(), mine);
    expect(out!.overlaps.map((g) => g.path)).toEqual([`goals/${theirs}`]);
    expect(out!.overlaps[0]!.owner).toBe("Ola Other");
  });

  it("does not call the reader's own second goal a duplicate of their first", async () => {
    const mine = await goal();
    const alsoMine = await goal({ title: "The same thing, split in two" });
    deps.vectors = fakeIndex(near([alsoMine, mine], 0.95));
    const out = await similarGoals(deps, all(), mine);
    // Splitting your own goal in two is a way of working, not duplicated effort.
    expect(out!.overlaps).toEqual([]);
    expect(out!.related).toHaveLength(1);
  });

  it("offers a department goal to align to, ahead of a personal one", async () => {
    const mine = await goal();
    const personal = await goal({ employeeId: THEM, title: "Their own goal" });
    const deptGoal = await goal({ employeeId: THEM, departmentId: DEPT, title: "The department's goal" });
    deps.vectors = fakeIndex(near([personal, deptGoal, mine], 0.85));
    const out = await similarGoals(deps, all(), mine);
    expect(out!.parent_candidates[0]!.path).toBe(`goals/${deptGoal}`);
    expect(out!.parent_candidates[0]!.department_goal).toBe(true);
  });

  it("offers no parent for a goal that already has one", async () => {
    const parent = await goal({ employeeId: THEM, departmentId: DEPT });
    const mine = await goal({ parentId: parent });
    deps.vectors = fakeIndex(near([parent, mine], 0.85));
    const out = await similarGoals(deps, all(), mine);
    // Somebody has already made this decision; re-offering it is noise on every future open.
    expect(out!.parent_candidates).toEqual([]);
  });

  it("offers no parent for a key result", async () => {
    const other = await goal({ employeeId: THEM, departmentId: DEPT });
    const kr = await goal({ kind: "key_result" });
    deps.vectors = fakeIndex(near([other, kr], 0.85));
    expect((await similarGoals(deps, all(), kr))!.parent_candidates).toEqual([]);
  });

  it("ignores a COMPLETED goal as well as a cancelled one", async () => {
    const mine = await goal();
    const done = await goal({ employeeId: THEM, status: "completed" });
    deps.vectors = fakeIndex(near([done, mine], 0.95));
    // A goal finished last quarter offered as "somebody else is doing this too", or as the objective a live
    // goal should roll up under, is worse than no panel at all.
    expect(await similarGoals(deps, all(), mine)).toBeNull();
  });

  it("ignores a cancelled goal entirely", async () => {
    const mine = await goal();
    const dead = await goal({ employeeId: THEM, status: "cancelled" });
    deps.vectors = fakeIndex(near([dead, mine], 0.95));
    expect(await similarGoals(deps, all(), mine)).toBeNull();
  });

  it("names nothing the caller could not have listed", async () => {
    const mine = await goal();
    const theirs = await goal({ employeeId: THEM });
    deps.vectors = fakeIndex(near([theirs, mine], 0.95));
    // A goal's title is often the strategy, so a scope miss must lose the row rather than only its link.
    expect(await similarGoals(deps, undefined, mine)).toBeNull();
  });

  it("reads nothing at all when the feature is off", async () => {
    await deps.db.delete(schema.settings);
    const mine = await goal();
    let asked = false;
    deps.vectors = { ...fakeIndex([]), async fetch(ids: string[]) { asked = true; return new Map<string, number[]>(ids.map((i) => [i, [0.1]])); } };
    expect(await similarGoals(deps, all(), mine)).toBeNull();
    expect(asked).toBe(false);
  });

  it("is absent, not broken, for a goal the drain has not embedded yet", async () => {
    const mine = await goal();
    deps.vectors = fakeIndex([], null);
    expect(await similarGoals(deps, all(), mine)).toBeNull();
  });
});

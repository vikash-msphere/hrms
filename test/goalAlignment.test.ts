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
import { createGoal, updateGoal, updateGoalProgress } from "../src/services/goals";

// Alignment (parent links) + the updateProgress audit meta: parents must exist, self/cycle links are
// rejected, and a progress note lands in the audit record for the activity feed to render.
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

const TABLES = [schema.auditLog, schema.eventLog, schema.goals, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

async function seedActor(): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: `04-${genId().slice(0, 3)}`, firstName: "Test", lastName: "User", workEmail: `${employeeId}@test.example`, status: "active" });
  const uuid = genId();
  const email = `${uuid}@test.example`;
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email, role: "employee", employeeId });
  return { uuid, email, role: "employee", status: "active", employeeId, employeeCode: null, name: "Test User" } as unknown as AppUser;
}

describe("goal alignment", () => {
  it("links a child to a parent on create and re-links on patch", async () => {
    const actor = await seedActor();
    const parent = await createGoal(deps, actor, { title: "Company: grow revenue" });
    const other = await createGoal(deps, actor, { title: "Company: reduce churn" });
    const child = await createGoal(deps, actor, { title: "Ship billing revamp", parent: `goals/${parent.uuid}` });
    expect(child.parentId).toBe(parent.uuid);

    const moved = await updateGoal(deps, actor, child.uuid, { parent: `goals/${other.uuid}` });
    expect(moved.parentId).toBe(other.uuid);
    const cleared = await updateGoal(deps, actor, child.uuid, { parent: null });
    expect(cleared.parentId).toBeNull();
  });

  it("rejects a missing parent, self-alignment, and cycles", async () => {
    const actor = await seedActor();
    await expect(createGoal(deps, actor, { title: "x", parent: `goals/${genId()}` })).rejects.toThrow(/parent goal not found/);

    const a = await createGoal(deps, actor, { title: "a" });
    const bGoal = await createGoal(deps, actor, { title: "b", parent: `goals/${a.uuid}` });
    const c = await createGoal(deps, actor, { title: "c", parent: `goals/${bGoal.uuid}` });

    await expect(updateGoal(deps, actor, a.uuid, { parent: `goals/${a.uuid}` })).rejects.toThrow(/cannot align to itself/);
    // a <- b <- c, so aligning a under c would loop the chain.
    await expect(updateGoal(deps, actor, a.uuid, { parent: `goals/${c.uuid}` })).rejects.toThrow(/cycle/);
  });

  it("walks a deep chain in one statement rather than one read per hop", async () => {
    // The cycle check used to walk the chain a query at a time, up to 25 D1 reads inside a create that also
    // allocates a code, writes the row, audits it and emits an event - against a per-invocation subrequest
    // budget. A recursive CTE answers the same question at any depth. What is pinned here is the ANSWER: a
    // long legal chain is still accepted, and a loop at the far end of one is still refused.
    const actor = await seedActor();
    let parent = await createGoal(deps, actor, { title: "root" });
    const root = parent;
    for (let i = 1; i < 20; i++) parent = await createGoal(deps, actor, { title: `level ${i}`, parent: `goals/${parent.uuid}` });
    // 20 deep and legal.
    const leaf = await createGoal(deps, actor, { title: "leaf", parent: `goals/${parent.uuid}` });
    expect(leaf.parentId).toBe(parent.uuid);
    // And the loop is caught from the top of the chain, not just one hop up.
    await expect(updateGoal(deps, actor, root.uuid, { parent: `goals/${leaf.uuid}` })).rejects.toThrow(/cycle/);
  });

  it("refuses a chain past the depth cap instead of walking it", async () => {
    const actor = await seedActor();
    let parent = await createGoal(deps, actor, { title: "root" });
    for (let i = 1; i <= 26; i++) parent = await createGoal(deps, actor, { title: `level ${i}`, parent: `goals/${parent.uuid}` });
    await expect(createGoal(deps, actor, { title: "one too deep", parent: `goals/${parent.uuid}` })).rejects.toThrow(/too deep/);
  });

  it("keeps a key result a leaf: it may not sit under another key result", async () => {
    // "A key result needs an objective to sit under" was enforced as "needs a parent", so a KR could hang off
    // another KR. The roll-up then recurses up the chain (several reads per level), and the model stops meaning
    // anything - a key result of a key result proves nothing and appears in no objective's roll-up.
    const actor = await seedActor();
    const objective = await createGoal(deps, actor, { title: "make onboarding excellent" });
    const kr = await createGoal(deps, actor, { title: "time to first commit under 3 days", kind: "key_result", parent: `goals/${objective.uuid}` });

    await expect(createGoal(deps, actor, { title: "nested", kind: "key_result", parent: `goals/${kr.uuid}` }))
      .rejects.toThrow(/cannot sit under another key result/);
    // A KR with no parent at all is still refused by its own rule.
    await expect(createGoal(deps, actor, { title: "orphan", kind: "key_result" })).rejects.toThrow(/needs an objective/);
    // Re-parenting an existing KR under another KR is the same refusal.
    const sibling = await createGoal(deps, actor, { title: "second measure", kind: "key_result", parent: `goals/${objective.uuid}` });
    await expect(updateGoal(deps, actor, sibling.uuid, { parent: `goals/${kr.uuid}` })).rejects.toThrow(/cannot sit under another key result/);
  });

  it("refuses to turn an objective that HAS key results into one", async () => {
    // The same rule from below - reachable with `{kind: "key_result"}` on a goal that already has KRs.
    const actor = await seedActor();
    const top = await createGoal(deps, actor, { title: "top" });
    const objective = await createGoal(deps, actor, { title: "objective", parent: `goals/${top.uuid}` });
    await createGoal(deps, actor, { title: "its measure", kind: "key_result", parent: `goals/${objective.uuid}` });
    await expect(updateGoal(deps, actor, objective.uuid, { kind: "key_result" })).rejects.toThrow(/has key results of its own/);
  });

  it("records progress from/to and the optional note in the audit meta", async () => {
    const actor = await seedActor();
    const g = await createGoal(deps, actor, { title: "trackable" });
    await updateGoalProgress(deps, actor, g.uuid, 40, "in_progress", "shipped the first slice");

    const entries = await deps.db.select().from(schema.auditLog);
    const upd = entries.find((e) => e.action === "goal.updateProgress");
    expect(upd).toBeTruthy();
    const meta = JSON.parse(upd!.meta ?? "{}");
    expect(meta).toMatchObject({ from: 0, to: 40, note: "shipped the first slice" });
  });
});

/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { clearCache } from "../src/lib/cache";
import { generational, readGenerations, bumpAllGenerations, CURRENT_KEY, type Generations } from "../src/lib/cacheGenerations";

// The counters every long-held server cache is checked against (migration 0003). What matters is that each
// write moves EXACTLY the counter whose caches it changes: one it misses leaves a cache serving the old answer
// for as long as it is held, and one it moves needlessly reloads rows nobody's answer depends on - which, for
// the ticket-share rows a routine assignment writes, would reload every role's grant in every instance.
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
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
});

beforeEach(() => clearCache());

const counters = async (): Promise<Generations> => (await readGenerations(deps))!;

/** What `write` moved, as `{ counter: by }` for the counters that changed and nothing for those that did not. */
async function moved(write: () => Promise<unknown>): Promise<Partial<Generations>> {
  const before = await counters();
  await write();
  const after = await counters();
  const out: Partial<Generations> = {};
  for (const k of Object.keys(after) as (keyof Generations)[]) if (after[k] !== before[k]) out[k] = after[k] - before[k];
  return out;
}

const rule = (over: Partial<typeof schema.accessRules.$inferInsert> = {}) => ({
  uuid: genId(), subject: "employee", subjectKind: "role" as const, namespace: "leave-requests", pattern: "leave-requests.**",
  scopeKind: "all" as const, scopeCode: "", matchCode: null, level: "read" as const, effect: "allow" as const, ...over,
});

describe("access rules: two counters, split by who reads the row", () => {
  it("a role's broad rule moves role_rules alone", async () => {
    expect(await moved(() => deps.db.insert(schema.accessRules).values(rule()))).toEqual({ roleRules: 1 });
  });

  it("a user's rule and any per-object rule (a ticket share's shape) move acl_rules alone", async () => {
    expect(await moved(() => deps.db.insert(schema.accessRules).values(rule({ subject: genId(), subjectKind: "user" })))).toEqual({ aclRules: 1 });
    const exact = rule({ subject: genId(), subjectKind: "user", pattern: "tickets.04-002-9.**", namespace: "tickets", scopeKind: "exact", scopeCode: "04-002-9", matchCode: "04-002-9" });
    expect(await moved(() => deps.db.insert(schema.accessRules).values(exact))).toEqual({ aclRules: 1 });
    const pinned = rule({ pattern: "tickets.04-002-8.**", namespace: "tickets", scopeKind: "exact", scopeCode: "04-002-8", matchCode: "04-002-8" });
    expect(await moved(() => deps.db.insert(schema.accessRules).values(pinned))).toEqual({ aclRules: 1 });
  });

  it("an update moves the counter of each side it touches, and a delete the side it leaves", async () => {
    const r = rule();
    await deps.db.insert(schema.accessRules).values(r);
    const byId = eq(schema.accessRules.uuid, r.uuid);
    expect(await moved(() => deps.db.update(schema.accessRules).set({ level: "write" }).where(byId))).toEqual({ roleRules: 1 });
    // Pinned to an object: it leaves the role's grant AND joins the per-object set, so both reload.
    expect(await moved(() => deps.db.update(schema.accessRules).set({ matchCode: "04-002-7", scopeKind: "exact", scopeCode: "04-002-7" }).where(byId))).toEqual({ roleRules: 1, aclRules: 1 });
    expect(await moved(() => deps.db.delete(schema.accessRules).where(byId))).toEqual({ aclRules: 1 });
  });
});

describe("the other sources, one counter each", () => {
  it("user_roles, policy, roles and automations each move their own counter", async () => {
    const user = genId();
    await deps.db.insert(schema.users).values({ uuid: user, code: `u-${genId().slice(0, 6)}`, email: `${user}@test.example`, role: "employee" });
    expect(await moved(() => deps.db.insert(schema.userRoles).values({ userId: user, role: "employee" }))).toEqual({ userRoles: 1 });
    expect(await moved(() => deps.db.delete(schema.userRoles).where(eq(schema.userRoles.userId, user)))).toEqual({ userRoles: 1 });
    expect(await moved(() => deps.db.insert(schema.policy).values({ key: `k-${genId()}`, valueJson: "{}" }))).toEqual({ policy: 1 });
    expect(await moved(() => deps.db.update(schema.roles).set({ label: "Staff" }).where(eq(schema.roles.name, "employee")))).toEqual({ roles: 1 });
    expect(await moved(() => deps.db.insert(schema.automations).values({ name: "r", triggerType: "leave.approved", actionsJson: "[]" }))).toEqual({ automations: 1 });
  });

  it("employees: a new or removed person, a manager change or a code change moves org; a code change moves codes too; a name edit moves nothing", async () => {
    const boss = genId();
    const report = genId();
    const person = (uuid: string, code: string) => ({ uuid, code, firstName: "A", lastName: "B", workEmail: `${uuid}@test.example` });
    expect(await moved(() => deps.db.insert(schema.employees).values(person(boss, "07-001")))).toEqual({ org: 1 });
    await deps.db.insert(schema.employees).values(person(report, "07-002"));
    const byId = eq(schema.employees.uuid, report);
    expect(await moved(() => deps.db.update(schema.employees).set({ firstName: "C" }).where(byId))).toEqual({});
    // Named in the SET but unchanged: not a change.
    expect(await moved(() => deps.db.update(schema.employees).set({ code: "07-002" }).where(byId))).toEqual({});
    expect(await moved(() => deps.db.update(schema.employees).set({ managerId: boss }).where(byId))).toEqual({ org: 1 });
    expect(await moved(() => deps.db.update(schema.employees).set({ code: "07-001-002" }).where(byId))).toEqual({ org: 1, codes: 1 });
    expect(await moved(() => deps.db.update(schema.employees).set({ deleteTime: new Date() }).where(byId))).toEqual({ org: 1 });
    expect(await moved(() => deps.db.delete(schema.employees).where(byId))).toEqual({ org: 1 });
  });

  it("departments: a code change moves codes; a rename moves nothing", async () => {
    const dept = genId();
    await deps.db.insert(schema.departments).values({ uuid: dept, code: "08", name: "Ops" });
    const byId = eq(schema.departments.uuid, dept);
    expect(await moved(() => deps.db.update(schema.departments).set({ name: "Operations" }).where(byId))).toEqual({});
    expect(await moved(() => deps.db.update(schema.departments).set({ code: "09" }).where(byId))).toEqual({ codes: 1 });
  });
});

describe("generational(): held until its own counter moves", () => {
  it("keeps serving across a counter re-read when nothing moved", async () => {
    let loads = 0;
    const load = async () => ++loads;
    expect(await generational(deps, "t:held", ["roles"], load)).toBe(1);
    clearCache(CURRENT_KEY); // the check interval passing
    expect(await generational(deps, "t:held", ["roles"], load)).toBe(1);
    expect(loads).toBe(1);
  });

  it("reloads once its counter moves - after the next counter re-read, not before", async () => {
    let loads = 0;
    const load = async () => ++loads;
    await generational(deps, "t:moves", ["roles"], load);
    await deps.db.update(schema.roles).set({ label: "Employee" }).where(eq(schema.roles.name, "employee"));
    // The counters this instance holds are still the old ones: the saving is exactly this.
    expect(await generational(deps, "t:moves", ["roles"], load)).toBe(1);
    clearCache(CURRENT_KEY);
    expect(await generational(deps, "t:moves", ["roles"], load)).toBe(2);
  });

  it("ignores a counter it does not depend on", async () => {
    let loads = 0;
    const load = async () => ++loads;
    await generational(deps, "t:other", ["roles"], load);
    await deps.db.insert(schema.automations).values({ name: "r2", triggerType: "leave.approved", actionsJson: "[]" });
    clearCache(CURRENT_KEY);
    expect(await generational(deps, "t:other", ["roles"], load)).toBe(1);
  });

  it("bumpAllGenerations moves every counter by one", async () => {
    const before = await counters();
    await bumpAllGenerations(deps);
    const after = await counters();
    for (const k of Object.keys(before) as (keyof Generations)[]) expect(after[k]).toBe(before[k] + 1);
  });

  it("without the row it still answers (the fail-safe), and a flush puts the row back", async () => {
    await deps.db.delete(schema.cacheGenerations);
    expect(await readGenerations(deps)).toBeNull();
    let loads = 0;
    expect(await generational(deps, "t:norow", ["roles"], async () => ++loads)).toBe(1);
    await bumpAllGenerations(deps);
    expect(await readGenerations(deps)).toEqual({ roleRules: 1, aclRules: 1, userRoles: 1, policy: 1, roles: 1, org: 1, codes: 1, automations: 1 });
  });
});

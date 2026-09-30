/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import type { ListScope } from "../src/domain/access";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { listGoals, type GoalCounts, type GoalListFilters } from "../src/services/goals";
import { managedDepartmentCodes } from "../src/services/departments";

// A manager's team on the Goals page, and the numbers on its Mine / My team / Everyone chips.
//
// The team is the people who report to them AND everybody in the departments that list them as a manager,
// sub-departments included (codes nest by department, so a subtree is a code range). Their own goals are Mine.
// Each chip number must equal what pressing that chip would list: every other filter kept (the state chip
// included), the owner filters dropped. The Everyone view folds the sums into the totals query and the other
// views run their own pass, so both paths are asked the same question here and must agree.

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

const TABLES = [schema.goals, schema.employees, schema.departments];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

// Engineering (04) is managed by A and has a sub-department, Platform (04-01), where D works. B reports to A
// but sits in Sales (07). C is in Support (09), nobody's team.
const ENG = genId();
const PLATFORM = genId();
const SALES = genId();
const SUPPORT = genId();
const A = genId();
const B = genId();
const C = genId();
const D = genId();

async function seed() {
  await deps.db.insert(schema.departments).values([
    { uuid: ENG, code: "04", name: "Engineering", managerIds: JSON.stringify([A]) },
    { uuid: PLATFORM, code: "04-01", name: "Platform", parentId: ENG },
    { uuid: SALES, code: "07", name: "Sales" },
    { uuid: SUPPORT, code: "09", name: "Support" },
  ]);
  await deps.db.insert(schema.employees).values([
    { uuid: A, code: "04-001", firstName: "A", lastName: "A", workEmail: "a@x.test", status: "active", departmentId: ENG },
    { uuid: B, code: "07-001", firstName: "B", lastName: "B", workEmail: "b@x.test", status: "active", departmentId: SALES, managerId: A },
    { uuid: C, code: "09-001", firstName: "C", lastName: "C", workEmail: "c@x.test", status: "active", departmentId: SUPPORT },
    { uuid: D, code: "04-01-001", firstName: "D", lastName: "D", workEmail: "d@x.test", status: "active", departmentId: PLATFORM },
  ]);
  const goal = (employeeId: string, code: string, status: "in_progress" | "completed") =>
    ({ uuid: genId(), code, employeeId, title: code, status });
  await deps.db.insert(schema.goals).values([
    goal(A, "04-001-001", "in_progress"),
    goal(A, "04-001-002", "completed"),
    goal(B, "07-001-001", "in_progress"),
    goal(B, "07-001-002", "in_progress"),
    goal(B, "07-001-003", "completed"),
    goal(C, "09-001-001", "in_progress"),
    goal(D, "04-01-001-001", "in_progress"),
  ]);
}

const read = async (filters: GoalListFilters) =>
  (await listGoals(deps, ALL, 100, undefined, { withCounts: true, ...filters })) as { items: { code: string }[]; extra?: { counts?: GoalCounts } };
const scopesOf = async (filters: GoalListFilters) => (await read(filters)).extra?.counts?.scopes;

describe("a manager's team", () => {
  it("is their reports plus the departments they manage, sub-departments included, minus their own", async () => {
    await seed();
    const codes = (await read({ manager: `employees/${A}` })).items.map((g) => g.code).sort();
    expect(codes).toEqual(["04-01-001-001", "07-001-001", "07-001-002", "07-001-003"]);
  });

  it("is only their reports when no department lists them as a manager", async () => {
    await seed();
    await deps.db.update(schema.departments).set({ managerIds: null });
    const codes = (await read({ manager: `employees/${A}` })).items.map((g) => g.code).sort();
    expect(codes).toEqual(["07-001-001", "07-001-002", "07-001-003"]);
  });

  it("reads a nested managed department as part of its parent's subtree", async () => {
    await seed();
    await deps.db.update(schema.departments).set({ managerIds: JSON.stringify([A]) });
    expect((await managedDepartmentCodes(deps, A)).sort()).toEqual(["04", "07", "09"]);
    await deps.db.update(schema.departments).set({ managerIds: JSON.stringify(["someone-else"]) });
    expect(await managedDepartmentCodes(deps, A)).toEqual([]);
  });
});

describe("scope chip counts", () => {
  it("counts each scope the same from every view", async () => {
    await seed();
    const want = { mine: 2, team: 4, all: 7 };
    expect(await scopesOf({ scopeCountsFor: A })).toEqual(want); // Everyone: folded into the totals
    expect(await scopesOf({ scopeCountsFor: A, employee: `employees/${A}` })).toEqual(want); // Mine
    expect(await scopesOf({ scopeCountsFor: A, manager: `employees/${A}` })).toEqual(want); // My team
    expect(await scopesOf({ scopeCountsFor: A, employee: `employees/${C}` })).toEqual(want); // a picked person
  });

  it("keeps the state chip, because switching scope keeps it", async () => {
    await seed();
    const want = { mine: 1, team: 3, all: 5 };
    expect(await scopesOf({ scopeCountsFor: A, state: "active" })).toEqual(want);
    expect(await scopesOf({ scopeCountsFor: A, state: "active", manager: `employees/${A}` })).toEqual(want);
  });

  it("counts only Everyone for a caller with no employee record", async () => {
    await seed();
    expect(await scopesOf({ scopeCountsFor: "" })).toEqual({ mine: 0, team: 0, all: 7 });
  });

  it("is absent unless asked for", async () => {
    await seed();
    expect(await scopesOf({})).toBeUndefined();
  });
});

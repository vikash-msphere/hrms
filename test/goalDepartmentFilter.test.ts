/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import type { ListScope } from "../src/domain/access";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { createGoal, listGoals } from "../src/services/goals";

// `GET /v1/goals?department=` - the filter behind "show me the goals this team owns".
//
// A goal can be marked as owned by a department, and until this existed there was no way to ask for a team's
// set: the Team goals page held one page of rows and recognised the badges by eye, so a team whose goals sat
// past the first hundred simply had none. Filtered in SQL for the same reason `?cycle=` is - a team's set
// answered over the page a browser happens to hold is wrong rather than merely short.

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

const TABLES = [schema.auditLog, schema.eventLog, schema.goals, schema.users, schema.employees, schema.roles, schema.departments];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

async function seedActor(): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const employeeId = genId();
  const employeeCode = `04-${genId().slice(0, 3)}`;
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: employeeCode, firstName: "Test", lastName: "User", workEmail: `${employeeId}@test.example`, status: "active" });
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role: "employee", employeeId });
  // The whole AppUser, not a cast over half of it: a fixture missing `policy`/`roles` throws a long way from
  // the line that built it.
  return { uuid, email: `${uuid}@test.example`, role: "employee", status: "active", employeeId, employeeCode, name: "Test User", policy: null, roles: ["employee"] } as unknown as AppUser;
}

async function seedDept(name: string) {
  const uuid = genId();
  await deps.db.insert(schema.departments).values({ uuid, code: `d-${genId().slice(0, 4)}`, name });
  return uuid;
}

describe("listing the goals a team owns", () => {
  it("returns only that department's goals, and `none` only the ones nobody's team owns", async () => {
    const actor = await seedActor();
    const eng = await seedDept("Engineering");
    const sales = await seedDept("Sales");

    await createGoal(deps, actor, { title: "Ship the billing revamp", department: `departments/${eng}` });
    await createGoal(deps, actor, { title: "Cut p95 latency", department: `departments/${eng}` });
    await createGoal(deps, actor, { title: "Land three enterprise logos", department: `departments/${sales}` });
    await createGoal(deps, actor, { title: "Finish my certification" });

    const titles = async (department?: string) =>
      (await listGoals(deps, ALL, 100, undefined, { department }))
        .items.map((g) => (g as { title: string }).title).sort();

    expect(await titles(`departments/${eng}`)).toEqual(["Cut p95 latency", "Ship the billing revamp"]);
    expect(await titles("none")).toEqual(["Finish my certification"]);
    expect(await titles(undefined)).toHaveLength(4);
  });

  it("keeps the goal's own lead, so a team goal is still somebody's to answer for", async () => {
    // The department does not replace the employee - that is the point of the field. A team goal with no
    // accountable person is how a team goal becomes nobody's.
    const actor = await seedActor();
    const eng = await seedDept("Engineering");
    const made = await createGoal(deps, actor, { title: "Ship the billing revamp", department: `departments/${eng}` });
    expect(made.employeeId).toBe(actor.employeeId);
    expect(made.departmentId).toBe(eng);
  });
});

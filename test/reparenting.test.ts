/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { createDepartment, updateDepartment } from "../src/services/departments";
import { createEmployee, updateEmployee } from "../src/services/employees";
import { HIERARCHICAL_TABLES } from "../src/services/codeCascade";
import { RESOURCE_COLLECTIONS } from "../src/lib/authzResolve";

// Re-parenting cascade: moving an employee (or a whole department subtree) recomputes the internal `code` for
// the moved entity AND every row nested under it, since authz scope is a code-prefix match. The wire id never
// changes. These tests assert the subtree codes actually follow the move.
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

const TABLES = [schema.notifications, schema.goals, schema.leaveRequests, schema.accessRules, schema.auditLog, schema.eventLog, schema.employees, schema.departments, schema.users, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
});

const actor: AppUser = { uuid: "u-actor", email: "hr@test.example", role: "super_admin", status: "active", employeeId: null, employeeCode: null } as unknown as AppUser;
const codeOfEmp = async (id: string) => (await deps.db.select({ code: schema.employees.code }).from(schema.employees).where(eq(schema.employees.uuid, id)).limit(1))[0]!.code!;
const codeOfDept = async (id: string) => (await deps.db.select({ code: schema.departments.code }).from(schema.departments).where(eq(schema.departments.uuid, id)).limit(1))[0]!.code!;

// Two owned rows under an employee (a goal + a notification), coded as children of the employee's code.
async function seedOwned(empCode: string, empId: string) {
  await deps.db.insert(schema.goals).values({ code: `${empCode}-100`, employeeId: empId, title: "Ship it" });
  await deps.db.insert(schema.notifications).values({ code: `${empCode}-101`, recipientId: empId, type: "system.test", title: "hi" });
}
const ownedCodes = async (empId: string) => ({
  goal: (await deps.db.select({ code: schema.goals.code }).from(schema.goals).where(eq(schema.goals.employeeId, empId)).limit(1))[0]?.code,
  notif: (await deps.db.select({ code: schema.notifications.code }).from(schema.notifications).where(eq(schema.notifications.recipientId, empId)).limit(1))[0]?.code,
});

describe("re-parenting: move an employee to another department", () => {
  it("recomputes the employee code + every owned row's code under the new department", async () => {
    const a = await createDepartment(deps, actor, { display_name: "Alpha" });
    const bDept = await createDepartment(deps, actor, { display_name: "Bravo" });
    const emp = await createEmployee(deps, actor, { first_name: "Ada", last_name: "L", work_email: "ada@test.example", department: `departments/${a.uuid}` });
    const eCode0 = await codeOfEmp(emp.uuid);
    expect(eCode0.startsWith(`${a.code}-`)).toBe(true); // under Alpha
    await seedOwned(eCode0, emp.uuid);

    await updateEmployee(deps, actor, emp.uuid, { department: `departments/${bDept.uuid}` });

    const eCode1 = await codeOfEmp(emp.uuid);
    expect(eCode1.startsWith(`${bDept.code}-`)).toBe(true); // now under Bravo
    expect(eCode1.startsWith(`${a.code}-`)).toBe(false);
    const owned = await ownedCodes(emp.uuid);
    expect(owned.goal).toBe(`${eCode1}-100`); // owned rows followed the employee
    expect(owned.notif).toBe(`${eCode1}-101`);
  });
});

describe("re-parenting: move a department subtree", () => {
  it("recomputes the dept, its employees, and their owned rows; rejects a cycle", async () => {
    const a = await createDepartment(deps, actor, { display_name: "Alpha" });
    const bDept = await createDepartment(deps, actor, { display_name: "Bravo" });
    const emp = await createEmployee(deps, actor, { first_name: "Ada", last_name: "L", work_email: "ada@test.example", department: `departments/${a.uuid}` });
    await seedOwned(await codeOfEmp(emp.uuid), emp.uuid);

    // Nest Alpha under Bravo.
    await updateDepartment(deps, actor, a.uuid, { parent: `departments/${bDept.uuid}` });

    const aCode1 = await codeOfDept(a.uuid);
    expect(aCode1.startsWith(`${bDept.code}-`)).toBe(true); // Alpha now under Bravo
    const eCode1 = await codeOfEmp(emp.uuid);
    expect(eCode1.startsWith(`${aCode1}-`)).toBe(true); // employee still under Alpha (which moved)
    const owned = await ownedCodes(emp.uuid);
    expect(owned.goal).toBe(`${eCode1}-100`);

    // A cycle (Bravo under Alpha, now Alpha's descendant) is rejected.
    await expect(updateDepartment(deps, actor, bDept.uuid, { parent: `departments/${a.uuid}` })).rejects.toThrow(/itself or one of its descendants/);
  });
});

describe("re-parenting: coverage tripwire", () => {
  it("HIERARCHICAL_TABLES are all real resource collections, unique, and include employees + departments", () => {
    const cols = HIERARCHICAL_TABLES.map((h) => h.collection);
    expect(new Set(cols).size).toBe(cols.length); // no duplicates
    expect(cols).toContain("employees");
    expect(cols).toContain("departments");
    for (const c of cols) expect(RESOURCE_COLLECTIONS).toContain(c);
    // Tripwire: bump this when a new employee-owned (allocOwnedCode) collection is added AND wired into the cascade.
    expect(cols.length).toBe(40);
  });
});

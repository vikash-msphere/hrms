/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { createEmployee, updateEmployee } from "../src/services/employees";
import { createDepartment, updateDepartment } from "../src/services/departments";

// THE REPORTING LINE MUST STAY A TREE.
//
// The DEPARTMENT hierarchy is guarded where it is written: services/codeCascade.ts#moveDepartment refuses a
// self-parent and refuses a move under one of its own descendants, so no route can produce a department cycle.
// The EMPLOYEE hierarchy has no such guard - services/employees.ts sets `managerId` from the patch and writes
// it - and the only cycle check in the product is client-side, in the org chart's drag handler
// (web/src/pages/OrgChart.tsx#applyMove). The two manager PICKERS exclude self and nothing else
// (Directory.tsx, EmployeeProfile.tsx), so pointing A's manager at A's own report is one ordinary edit - the
// state an HR admin passes through mid-reorg, before they get to the shape they meant.
//
// What a cycle then costs: every consumer that walks the chain has to defend itself, and one of the three
// walks in the org chart does not (see test/hierarchyWalkGuards.test.ts), so the search box freezes the tab.
// Guarding the WRITE is what makes all of those safe at once, and it is the only place that holds for the API
// and any future caller as well as for the two pickers.
//
// These assert the guard from the service layer, where the department equivalent already lives.
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

const TABLES = [schema.notifications, schema.auditLog, schema.eventLog, schema.employees, schema.departments, schema.users, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
});

const actor: AppUser = { uuid: "u-actor", email: "hr@test.example", role: "super_admin", status: "active", employeeId: null, employeeCode: null } as unknown as AppUser;

let seq = 0;
const person = (first: string) =>
  createEmployee(deps, actor, { first_name: first, last_name: "T", work_email: `${first.toLowerCase()}${seq++}@test.example` });
/** Point `child`'s manager at `parent`. */
const setManager = (child: { uuid: string }, parent: { uuid: string } | null) =>
  updateEmployee(deps, actor, child.uuid, { manager: parent ? `employees/${parent.uuid}` : "" });

describe("employee manager: the reporting line stays a tree", () => {
  it("refuses an employee as their own manager", async () => {
    const ada = await person("Ada");
    await expect(setManager(ada, ada)).rejects.toThrow();
  });

  it("refuses a two-person cycle (A manages B, then B is made A's manager)", async () => {
    const ada = await person("Ada");
    const bo = await person("Bo");
    await setManager(bo, ada); // Bo reports to Ada - fine
    await expect(setManager(ada, bo)).rejects.toThrow(); // now Ada reports to Bo - a cycle
  });

  it("refuses a longer cycle (A -> B -> C, then A is made to report to C)", async () => {
    const ada = await person("Ada");
    const bo = await person("Bo");
    const cy = await person("Cy");
    await setManager(bo, ada);
    await setManager(cy, bo);
    await expect(setManager(ada, cy)).rejects.toThrow();
  });

  it("still allows an ordinary move that creates no cycle", async () => {
    // The guard must not be so broad that it refuses real reorganisations - a sibling taking over a report is
    // the commonest edit this screen makes.
    const boss = await person("Boss");
    const lead = await person("Lead");
    const report = await person("Report");
    await setManager(lead, boss);
    await setManager(report, boss);
    await expect(setManager(report, lead)).resolves.toBeTruthy();
  });

  it("still allows clearing a manager", async () => {
    const ada = await person("Ada");
    const bo = await person("Bo");
    await setManager(bo, ada);
    await expect(setManager(bo, null)).resolves.toBeTruthy();
  });
});

describe("department parent: the guard the manager line is missing", () => {
  // Kept alongside deliberately. This passes today, and it is the shape the employee tests above are asking
  // for - so if somebody wonders what "guarded" should look like, it is thirty lines up in codeCascade.ts.
  it("refuses a department under itself", async () => {
    const alpha = await createDepartment(deps, actor, { display_name: "Alpha" });
    await expect(updateDepartment(deps, actor, alpha.uuid, { parent: `departments/${alpha.uuid}` })).rejects.toThrow();
  });

  it("refuses a department under its own descendant", async () => {
    const alpha = await createDepartment(deps, actor, { display_name: "Alpha" });
    const bravo = await createDepartment(deps, actor, { display_name: "Bravo", parent: `departments/${alpha.uuid}` });
    await expect(updateDepartment(deps, actor, alpha.uuid, { parent: `departments/${bravo.uuid}` })).rejects.toThrow();
  });
});

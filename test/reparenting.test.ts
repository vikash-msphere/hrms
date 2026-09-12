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
import { HIERARCHICAL_TABLES, reprefixPattern } from "../src/services/codeCascade";
import { decide } from "../src/domain/permissions";
import { rulesToGrant } from "../src/domain/compileGrants";
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

const TABLES = [schema.notifications, schema.goals, schema.leaveRequests, schema.accessRules, schema.auditLog, schema.eventLog, schema.jobs, schema.employees, schema.departments, schema.users, schema.roles];
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

describe("re-parenting: a flat code in a mixed table is not collateral", () => {
  // `jobs` and `announcements` allocate an OWNED code when the act has an employee behind it and a FLAT one
  // when it does not. `CODE_WIDTH.flat` and `CODE_WIDTH.dept` are both 2 over one alphabet, so a flat code is
  // a WELL-FORMED department code - and the cascade's `code = oldPrefix` arm matched it. Reparenting the
  // department whose code happened to equal some job's flat code rewrote that job onto the department's new
  // code, on a UNIQUE column: either the row silently claimed a department it has nothing to do with, or the
  // UPDATE threw and took the half-finished cascade with it.
  it("reparenting a department leaves a flat-coded job alone and still moves the owned one", async () => {
    const parent = await createDepartment(deps, actor, { display_name: "Parent" });
    const dept = await createDepartment(deps, actor, { display_name: "Movable" });
    const emp = await createEmployee(deps, actor, { first_name: "Ada", last_name: "L", work_email: "ada@test.example", department: `departments/${dept.uuid}` });
    const empCode0 = await codeOfEmp(emp.uuid);

    // The collision: a flat-coded operation whose code IS this department's code, owner null (the shape
    // payroll's publishRun writes when the actor has no employee record).
    const flatJob = genId();
    await deps.db.insert(schema.jobs).values({ uuid: flatJob, code: dept.code!, kind: "payslip.generateRun", payload: "{}", employeeId: null });
    // And an owned-coded operation under the employee, which MUST follow the move.
    const ownedJob = genId();
    await deps.db.insert(schema.jobs).values({ uuid: ownedJob, code: `${empCode0}-900`, kind: "payslip.generateRun", payload: "{}", employeeId: emp.uuid });

    await updateDepartment(deps, actor, dept.uuid, { parent: `departments/${parent.uuid}` });

    const codeOfJob = async (id: string) => (await deps.db.select({ code: schema.jobs.code }).from(schema.jobs).where(eq(schema.jobs.uuid, id)).limit(1))[0]!.code;
    expect(await codeOfJob(flatJob)).toBe(dept.code); // untouched: it was never in the hierarchy
    const empCode1 = await codeOfEmp(emp.uuid);
    expect(empCode1).not.toBe(empCode0); // the employee did move
    expect(await codeOfJob(ownedJob)).toBe(`${empCode1}-900`); // and its owned operation followed
  });
});

describe("re-parenting: coverage tripwire", () => {
  it("HIERARCHICAL_TABLES are all real resource collections, unique, and include employees + departments", () => {
    const cols = HIERARCHICAL_TABLES.map((h) => h.collection);
    expect(new Set(cols).size).toBe(cols.length); // no duplicates
    expect(cols).toContain("employees");
    expect(cols).toContain("departments");
    // A null collection is an INTERNAL table (comp_off_credits): its code is owner-embedded and must be
    // rewritten, but it has no wire collection, so no access rule can name it.
    for (const c of cols) if (c !== null) expect(RESOURCE_COLLECTIONS).toContain(c);
    // Tripwire: bump this when a new employee-owned (allocOwnedCode) collection is added AND wired into the cascade.
    expect(cols.length).toBe(44);
  });

  // THE DIRECTION THAT ACTUALLY DRIFTED. The assertion above checks that everything in the list is a real
  // collection - which every entry always was. Nothing checked the inverse: that every table taking an
  // OWNED code is IN the list. Four had fallen out (`asset-requests`, `approval-delegations`, `table-views`,
  // `comp_off_credits`), so a reparent moved the employee and left those rows' codes on the old prefix. Authz
  // scope is a code-prefix match, so the rows stayed in the old department's breadth and vanished from the
  // new one's - and a `me`-scoped rule matches by code too, so the employee lost their own rows. A count
  // tripwire cannot catch that: the number was correct for the list somebody wrote.
  //
  // A SOURCE scan, for the same reason test/listOwnerColumns.test.ts is one: the table is an argument at a
  // call site, so there is no runtime value to assert against.
  it("every table that allocates an OWNED code is wired into the cascade", () => {
    const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    // `allocOwnedCode(deps, <schema.X | table>, schema.Y.<col>, ...)` - the table is named by whichever of the
    // two is a schema reference (the factory form passes a generic `table` and names the column off schema).
    const ALLOC = /allocOwnedCodes?(?:For)?\(\s*deps\s*,\s*(?:schema\.([A-Za-z0-9_]+)|[A-Za-z_][A-Za-z0-9_]*)\s*,\s*(?:schema\.([A-Za-z0-9_]+)\.|[A-Za-z_][A-Za-z0-9_]*\.)/g;
    // The one call that names no schema table at all: services/documentService.ts is a factory over the two
    // document resources and passes `table`/`table.employeeId`. Its owned branch is `personal-documents`,
    // which the same file also allocates explicitly (the signed-copy insert), so the scan still covers it.
    const UNATTRIBUTABLE = new Set(["src/services/documentService.ts"]);

    const inCascade = new Set<string>();
    for (const [prop, table] of Object.entries(schema)) {
      if (HIERARCHICAL_TABLES.some((h) => h.table === table)) inCascade.add(prop);
    }

    const missing: string[] = [];
    const unattributable: string[] = [];
    const seen = new Set<string>();
    for (const [path, src] of Object.entries(sources)) {
      const file = path.replace("../", "");
      src.split("\n").forEach((raw, i) => {
        if (/^\s*(\*|\/\*|\/\/)/.test(raw)) return; // prose, not code
        const line = raw.replace(/\/\/.*$/, "");
        for (const m of line.matchAll(ALLOC)) {
          const prop = m[1] ?? m[2];
          if (!prop) {
            if (!UNATTRIBUTABLE.has(file)) unattributable.push(`${file}:${i + 1}`);
            continue;
          }
          seen.add(prop);
          if (!inCascade.has(prop)) missing.push(`${file}:${i + 1} schema.${prop} takes an owned code but is not in HIERARCHICAL_TABLES`);
        }
      });
    }
    // A glob or a regex that matches nothing passes every assertion below it. Anchor the scan first: if this
    // ever reads zero files or finds zero allocations, the tripwire is dead rather than green.
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    expect(inCascade.size).toBe(HIERARCHICAL_TABLES.length);
    expect(seen.size).toBeGreaterThan(30);
    // An owned allocation the scan cannot attribute to a table is a hole in this tripwire, not a pass.
    expect(unattributable).toEqual([]);
    expect(missing).toEqual([]);
  });

  // A MIXED table allocates an owned code only when the act has an employee behind it, and a flat one
  // otherwise - and a flat code shares the department namespace (`CODE_WIDTH.flat` and `.dept` are both 2 over
  // one alphabet), so `code = <deptCode>` matched an unrelated flat row and rewrote it on a UNIQUE column.
  // Every mixed table must therefore carry an `ownedWhen` discriminator.
  it("every mixed-coding table in the cascade narrows to its owned rows", () => {
    const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    const FLAT = /allocFlatCodes?\(\s*deps\s*,\s*schema\.([A-Za-z0-9_]+)/g;
    const flatCoded = new Set<string>();
    for (const src of Object.values(sources)) {
      for (const m of src.matchAll(FLAT)) flatCoded.add(m[1]!);
    }
    expect(flatCoded.size).toBeGreaterThan(10); // the scan found the flat allocations, so a miss below is real
    const propOf = new Map<unknown, string>(Object.entries(schema).map(([p, t]) => [t, p]));
    const ungated = HIERARCHICAL_TABLES.filter((h) => {
      const prop = propOf.get(h.table);
      return prop && flatCoded.has(prop) && !h.ownedWhen;
    }).map((h) => h.collection ?? "(internal)");
    expect(ungated).toEqual([]);
  });
});

// ---- The access rules move with the codes ----------------------------------------------------------------
//
// The cascade rewrote `match_code` and `scope_code` and left `pattern` alone - and `pattern` is the column that
// decides (schema.ts: "VERBATIM grant pattern - the decision input, never re-derived"; compileGrants: the
// others are "DERIVED narrowing keys ... to fetch a SUPERSET of candidate rows"). So after a move the narrowing
// key found the rule and `decide()` then failed to match it, silently revoking every per-object share and every
// subtree rule pointing into the moved subtree.
//
// It displayed as working, which is what made it invisible: services/accessRules.ts resolves a rule's
// `scope_ref` from `match_code` - the column that WAS updated - so the manage-access modal went on showing the
// rule as active and pointing at the moved record.
describe("reprefixPattern: only the code in the id position moves", () => {
  it("rewrites the exact and subtree spellings, keeping any field path or verb tail", () => {
    expect(reprefixPattern("employees.04-002.**", "04-002", "05-001")).toBe("employees.05-001.**");
    expect(reprefixPattern("employees.04-002-*.**", "04-002", "05-001")).toBe("employees.05-001-*.**");
    // A descendant of the moved row keeps its own trailing segments.
    expect(reprefixPattern("goals.04-002-100.**", "04-002", "05-001")).toBe("goals.05-001-100.**");
    // A field path and a verb tail are not the id token and ride through untouched.
    expect(reprefixPattern("employees.04-002.identity.uan.**", "04-002", "05-001")).toBe("employees.05-001.identity.uan.**");
    expect(reprefixPattern("leave-requests.04-002.approve", "04-002", "05-001")).toBe("leave-requests.05-001.approve");
  });

  it("leaves scope words alone even when a code could spell one", () => {
    // THE TRAP. Segments come from the Crockford alphabet, which has m, y, e and d - so a department really can
    // be coded `my`, and "my-dept".startsWith("my-") is true. Without the scope-word guard, re-parenting that
    // department would rewrite every `my-dept` rule in the app into a subtree rule for the moved department:
    // "your own department" silently becomes "that one", for every holder.
    expect(reprefixPattern("employees.my-dept.**", "my", "05")).toBeNull();
    expect(reprefixPattern("employees.me.**", "me", "05")).toBeNull();
    expect(reprefixPattern("employees.**", "04-002", "05-001")).toBeNull();
    expect(reprefixPattern("employees.*.bio.**", "04-002", "05-001")).toBeNull();
  });

  it("is boundary-anchored, so a prefix-collision neighbour is not caught", () => {
    // The same containment `reprefixSubtree` selects rows by: `04-0029` is not under `04-002`.
    expect(reprefixPattern("employees.04-0029.**", "04-002", "05-001")).toBeNull();
    expect(reprefixPattern("employees.04-003.**", "04-002", "05-001")).toBeNull();
  });
});

describe("re-parenting: an access rule keeps deciding about the row it named", () => {
  it("moves the pattern with the code, so the share still allows after the move", async () => {
    const a = await createDepartment(deps, actor, { display_name: "Alpha" });
    const bDept = await createDepartment(deps, actor, { display_name: "Bravo" });
    const emp = await createEmployee(deps, actor, { first_name: "Ada", last_name: "L", work_email: "ada@test.example", department: `departments/${a.uuid}` });
    const before = await codeOfEmp(emp.uuid);

    // Exactly what the ACL modal writes for "share this record" and for "this subtree".
    await deps.db.insert(schema.accessRules).values([
      { uuid: genId(), subject: "u-reader", subjectKind: "user", namespace: "employees", pattern: `employees.${before}.**`, scopeKind: "exact", scopeCode: before, matchCode: before, level: "read", effect: "allow" },
      { uuid: genId(), subject: "u-reader", subjectKind: "user", namespace: "employees", pattern: `employees.${before}-*.**`, scopeKind: "subtree", scopeCode: before, matchCode: null, level: "read", effect: "allow" },
    ]);

    await updateEmployee(deps, actor, emp.uuid, { department: `departments/${bDept.uuid}` });
    const after = await codeOfEmp(emp.uuid);
    expect(after).not.toBe(before);

    const rules = await deps.db.select().from(schema.accessRules).where(eq(schema.accessRules.subject, "u-reader"));
    // The narrowing keys moved before this fix; the PATTERN is the half that did not.
    expect(rules.map((r) => r.pattern).sort()).toEqual([`employees.${after}-*.**`, `employees.${after}.**`].sort());
    expect(rules.every((r) => r.scopeCode === after)).toBe(true);

    // And the thing that actually matters: the engine still allows, over the rebuilt grant, on the NEW code.
    const grant = rulesToGrant(rules.map((r) => ({ namespace: r.namespace, pattern: r.pattern, scopeKind: r.scopeKind, scopeCode: r.scopeCode, matchCode: r.matchCode, level: r.level, effect: r.effect })));
    const self = { employeeCode: null };
    expect(decide(grant, { kind: "standard", resource: `employees.${after}`, level: "read" }, self).allow).toBe(true);
    // A row owned by the moved employee rides the subtree half.
    expect(decide(grant, { kind: "standard", resource: `employees.${after}-100`, level: "read" }, self).allow).toBe(true);
    // The vacated code is not a way back in.
    expect(decide(grant, { kind: "standard", resource: `employees.${before}`, level: "read" }, self).allow).toBe(false);
  });
});

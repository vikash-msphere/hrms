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
import { DEFAULT_POLICY } from "../src/domain/manifests";
import { whoCanSeeMe } from "../src/services/myViewers";
import { clearCachePrefix } from "../src/lib/cache";
import { invalidateCodeCache } from "../src/lib/authzResolve";

// Real-D1 test for the employee's own "who can see my data" report.
//
// The case that matters most here is the FIRST one: the report is written for ordinary employees, and an
// ordinary employee holds `users.me.**` and nothing else - so the subject-scope bound `previewAccess` applies
// on behalf of a caller refused every single reader of this report with a 403. The feature was unreachable by
// its whole audience and no test said so, which is why this file exists.
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

// alice + bob share dept 04; hala (HR) sits in 07.
const ALICE_CODE = "04-002";
const BOB_CODE = "04-003";
const HALA_CODE = "07-001";

const emp = (uuid: string, code: string, name: string) => ({ uuid, code, firstName: name, lastName: "T", workEmail: `${name}@test.example`, status: "active" as const });
const ids = { aliceEmp: genId(), bobEmp: genId(), halaEmp: genId(), alice: genId(), bob: genId(), hala: genId() };

// The caller as the middleware would build them. `employeeCode` is load-bearing: it anchors every target the
// report grades, including the probe code for an area the caller has no rows in yet.
const alice = (): AppUser =>
  ({
    uuid: ids.alice,
    email: "alice@test.example",
    name: "alice T",
    role: "employee",
    roles: ["employee"],
    status: "active",
    employeeId: ids.aliceEmp,
    employeeCode: ALICE_CODE,
    grant: { levels: { "users.me.**": "read" }, allow: [] },
    policy: DEFAULT_POLICY,
  }) as AppUser;

beforeEach(async () => {
  for (const t of [schema.accessRules, schema.users, schema.employees, schema.roles, schema.goals]) await deps.db.delete(t);
  clearCachePrefix("");
  invalidateCodeCache();
  await deps.db.insert(schema.roles).values([
    { name: "employee", label: "Employee" },
    { name: "hr_admin", label: "HR Admin" },
    { name: "everyone", label: "Everyone" },
  ]);
  await deps.db.insert(schema.employees).values([emp(ids.aliceEmp, ALICE_CODE, "alice"), emp(ids.bobEmp, BOB_CODE, "bob"), emp(ids.halaEmp, HALA_CODE, "hala")]);
  await deps.db.insert(schema.users).values([
    { uuid: ids.alice, code: `u-${genId().slice(0, 6)}`, email: "alice@test.example", role: "employee", employeeId: ids.aliceEmp },
    { uuid: ids.bob, code: `u-${genId().slice(0, 6)}`, email: "bob@test.example", role: "employee", employeeId: ids.bobEmp },
    { uuid: ids.hala, code: `u-${genId().slice(0, 6)}`, email: "hala@test.example", role: "hr_admin", employeeId: ids.halaEmp },
  ]);
  const rule = (subject: string, subjectKind: "role" | "user", pattern: string, o: Partial<typeof schema.accessRules.$inferInsert> = {}) => ({
    id: genId(), subject, subjectKind, namespace: pattern.split(".")[0]!, pattern, scopeKind: "all" as const, scopeCode: "", effect: "allow" as const, ...o,
  });
  await deps.db.insert(schema.accessRules).values([
    rule("employee", "role", "employees.me.**", { scopeKind: "self", level: "write" }),
    rule("employee", "role", "payslips.me.**", { scopeKind: "self", level: "read" }),
    // HR reads everyone's record and everyone's payslips; only HR reaches the bank sub-resource.
    rule("hr_admin", "role", "employees.**", { level: "admin" }),
    rule("hr_admin", "role", "payslips.**", { level: "read" }),
    rule("hr_admin", "role", "goals.**", { level: "read" }),
  ]);
});

const area = (r: Awaited<ReturnType<typeof whoCanSeeMe>>, key: string) => r.areas.find((a) => a.key === key)!;

describe("whoCanSeeMe", () => {
  it("answers for an ordinary employee, who can read nobody else's user record", async () => {
    const report = await whoCanSeeMe(deps, alice());
    expect(report.roster).toBe(3);
    expect(report.complete).toBe(true);
    expect(area(report, "bank-account").viewers.map((v) => v.email)).toEqual(["hala@test.example"]);
  });

  it("covers the data that lives outside the employee row, not just its sub-resources", async () => {
    const report = await whoCanSeeMe(deps, alice());
    const keys = report.areas.map((a) => a.key);
    expect(keys).toEqual(expect.arrayContaining(["profile", "bank-account", "payslips", "reviews", "leave-requests", "personal-documents"]));
    expect(new Set(report.areas.map((a) => a.group))).toEqual(new Set(report.groups.map((g) => g.key)));
    // No rows yet, so the count says so and the viewers are who WOULD see one.
    expect(area(report, "payslips").records).toBe(0);
    expect(area(report, "payslips").viewers.map((v) => v.email)).toEqual(["hala@test.example"]);
  });

  it("grades a real row of the caller's once they have one, and counts it", async () => {
    await deps.db.insert(schema.goals).values({ uuid: genId(), code: `${ALICE_CODE}-0a`, employeeId: ids.aliceEmp, title: "Ship the thing" });
    const report = await whoCanSeeMe(deps, alice());
    expect(area(report, "goals").records).toBe(1);
    expect(area(report, "goals").viewers.map((v) => v.email)).toEqual(["hala@test.example"]);
  });

  it("leaves the caller out of their own viewer lists, and marks who can change things", async () => {
    const report = await whoCanSeeMe(deps, alice());
    const profile = area(report, "profile");
    expect(profile.viewers.map((v) => v.email)).not.toContain("alice@test.example");
    expect(profile.viewers.map((v) => v.email)).not.toContain("bob@test.example"); // a peer reaches nothing
    expect(profile.viewers.find((v) => v.email === "hala@test.example")!.write).toBe(true);
    expect(area(report, "payslips").viewers.find((v) => v.email === "hala@test.example")!.write).toBe(false); // read-only there
  });

  it("says nothing about the reader but their name", async () => {
    // A tripwire, not a formality: the role field was there, and so were reasons drawn from how far each
    // reader's access runs ("they can see this for everyone"). Either one, re-added, publishes who is powerful
    // to every employee from a page about their own data. The only reason allowed is the one about the
    // CALLER'S record - that something was shared from it.
    const report = await whoCanSeeMe(deps, alice());
    const viewers = report.areas.flatMap((a) => a.viewers);
    expect(viewers.length).toBeGreaterThan(0);
    for (const v of viewers) {
      expect(Object.keys(v).sort()).toEqual(["email", "name", "write"]); // no role, and no scope-derived why
      expect(v.why).toBeUndefined();
    }
  });

  it("refuses when the account is not linked to an employee record", async () => {
    await expect(whoCanSeeMe(deps, { ...alice(), employeeId: null } as AppUser)).rejects.toMatchObject({ httpStatus: 409 });
  });
});

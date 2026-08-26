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
import { clearCache } from "../src/lib/cache";
import { app } from "../src/index";

// The body-level access gate (middleware/authz.ts bodyDecision) over REAL HTTP, on the content type an Update
// actually uses.
//
// It existed only as a unit-level mirror before (test/fieldAccess.test.ts), and that is how the gate came to be
// switched off for every PATCH in the app without a single test going red: the gate asked
// `contentType.includes("application/json")`, while openapi.yaml declares - and web/src/api.ts sends -
// `application/merge-patch+json` for all 70 Update operations. The substring is not in that string, so the
// gate answered "no JSON body, no constraint" and the protected-field / reference / per-field checks never ran.
//
// So these drive the whole chain (dev auth -> authz -> handler) against a real D1, and each protected-field
// assertion is made twice: once per JSON content type. A gate that holds for one and not the other is the bug.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  (b as Record<string, unknown>).ALLOW_DEV_AUTH = "true";
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

const TABLES = [schema.accessRules, schema.auditLog, schema.users, schema.employees, schema.departments, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  await deps.db.insert(schema.roles).values([{ name: "records_admin", label: "Records" }]);
  // A role that may write an employee RECORD but holds no field grant over `department` (a protected field:
  // re-parenting an employee re-scopes every dept-scoped decision about them). `employees.*` is deliberately
  // 2-token, so it cannot match the 3-token field resource `employees.<code>.department` - which is exactly
  // what the gate is for.
  await deps.db.insert(schema.accessRules).values([
    { subject: "records_admin", subjectKind: "role", namespace: "employees", pattern: "employees", scopeKind: "all", scopeCode: "", matchCode: null, level: "write", effect: "allow" },
    { subject: "records_admin", subjectKind: "role", namespace: "employees", pattern: "employees.*", scopeKind: "all", scopeCode: "", matchCode: null, level: "write", effect: "allow" },
    { subject: "records_admin", subjectKind: "role", namespace: "users", pattern: "users.me.**", scopeKind: "self", scopeCode: "", matchCode: null, level: "read", effect: "allow" },
  ]);
  clearCache(); // the role-grant loader caches for ~5s; each test seeds its own rules
});

async function seedPerson(code: string, first: string, role: string) {
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code, firstName: first, lastName: "Test", workEmail: `${first.toLowerCase()}@test.example`, status: "active" });
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${first.toLowerCase()}@test.example`, role, employeeId });
  return { userId: uuid, employeeId, code, email: `${first.toLowerCase()}@test.example` };
}

const patch = (path: string, body: unknown, contentType: string) =>
  app.request(
    path,
    { method: "PATCH", headers: { "X-Requested-By": "hrms-spa", "Content-Type": contentType }, body: JSON.stringify(body) },
    b as unknown as Record<string, unknown>,
  );

// Both JSON content types the API speaks. `application/json` is what a create posts; the merge-patch type is
// what every Update sends, and it is the one that used to walk straight past the gate.
const JSON_TYPES = ["application/json", "application/merge-patch+json"];

describe("body-level field gate, over HTTP, on every JSON content type", () => {
  for (const contentType of JSON_TYPES) {
    it(`refuses a protected field the caller holds no field grant for (${contentType})`, async () => {
      const admin = await seedPerson("04-001", "Rec", "records_admin");
      const target = await seedPerson("04-002", "Diya", "records_admin");
      const deptId = genId();
      await deps.db.insert(schema.departments).values({ uuid: deptId, code: "07", name: "Ops" });
      (b as Record<string, unknown>).DEV_FAKE_EMAIL = admin.email;

      const res = await patch(`/v1/employees/${target.employeeId}`, { department: `departments/${deptId}` }, contentType);
      expect(res.status).toBe(403);
      // and the write did not land
      const row = (await deps.db.select().from(schema.employees))!.find((e) => e.uuid === target.employeeId)!;
      expect(row.departmentId).toBeNull();
    });

    it(`still allows an ordinary field the record-write grant covers (${contentType})`, async () => {
      const admin = await seedPerson("04-001", "Rec", "records_admin");
      const target = await seedPerson("04-002", "Diya", "records_admin");
      (b as Record<string, unknown>).DEV_FAKE_EMAIL = admin.email;

      const res = await patch(`/v1/employees/${target.employeeId}`, { first_name: "Diya2" }, contentType);
      expect(res.status).toBe(200);
    });
  }

  // The other half of the same invariant: a handler must not read a body the gate declined to inspect. The gate
  // only looks at JSON-family types, so a body that declares itself as anything else must not reach the service
  // either - otherwise the request talks its way around the gate by relabelling the same bytes.
  it("ignores a protected field smuggled under a non-JSON content type", async () => {
    const admin = await seedPerson("04-001", "Rec", "records_admin");
    const target = await seedPerson("04-002", "Diya", "records_admin");
    const deptId = genId();
    await deps.db.insert(schema.departments).values({ uuid: deptId, code: "07", name: "Ops" });
    (b as Record<string, unknown>).DEV_FAKE_EMAIL = admin.email;

    const res = await patch(`/v1/employees/${target.employeeId}`, { department: `departments/${deptId}` }, "text/plain");
    // Whatever the status, the one thing that must be true is that the protected field did not land.
    expect(res.status).not.toBe(500);
    const row = (await deps.db.select().from(schema.employees))!.find((e) => e.uuid === target.employeeId)!;
    expect(row.departmentId).toBeNull();
  });
});

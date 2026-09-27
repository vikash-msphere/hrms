/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { seedManifest } from "./seedManifest";
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
  await seedManifest(b.DB);
  deps = makeDeps(b);
});

const TABLES = [schema.accessRules, schema.auditLog, schema.personalDocuments, schema.users, schema.employees, schema.departments, schema.roles];
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

// A declared ref does not stop being one because it arrived in the query string.
//
// `personal-documents:uploadForm16` files a document for `?employee=<ref>` with the raw PDF as the body, so
// the gate - which used to return early on anything that was not JSON - never ran on it, while the sibling
// route that files the same document through a JSON body was gated. The owner-on-create check was in effect a
// property of the CONTENT TYPE rather than of the request.
describe("owner-on-create gate, when the owner ref rides in the query string", () => {
  const uploadForm16 = (employeeId: string) =>
    app.request(
      `/v1/personal-documents:uploadForm16?employee=employees/${employeeId}&financial_year=2025-26`,
      { method: "POST", headers: { "X-Requested-By": "hrms-spa", "Content-Type": "application/pdf" }, body: "%PDF-1.4\n" },
      b as unknown as Record<string, unknown>,
    );

  beforeEach(async () => {
    await deps.db.insert(schema.roles).values([{ name: "doc_filer", label: "Docs" }]).onConflictDoNothing();
    // May use the verb and may write documents for their OWN subtree only - not for 04-002.
    await deps.db.insert(schema.accessRules).values([
      { subject: "doc_filer", subjectKind: "role", namespace: "personal-documents", pattern: "personal-documents.uploadForm16", scopeKind: "all", scopeCode: "", matchCode: null, level: null, effect: "allow" },
      { subject: "doc_filer", subjectKind: "role", namespace: "personal-documents", pattern: "personal-documents.me.**", scopeKind: "self", scopeCode: "", matchCode: null, level: "write", effect: "allow" },
      { subject: "doc_filer", subjectKind: "role", namespace: "employees", pattern: "employees.me.**", scopeKind: "self", scopeCode: "", matchCode: null, level: "read", effect: "allow" },
    ]);
    clearCache();
  });

  it("refuses filing against an employee the caller may not write", async () => {
    const filer = await seedPerson("04-001", "Filer", "doc_filer");
    const other = await seedPerson("04-002", "Other", "doc_filer");
    (b as Record<string, unknown>).DEV_FAKE_EMAIL = filer.email;

    const res = await uploadForm16(other.employeeId);
    expect(res.status).toBe(403);
    expect(await deps.db.select().from(schema.personalDocuments)).toEqual([]);
  });

  it("still allows filing against an employee the caller may write", async () => {
    const filer = await seedPerson("04-001", "Filer", "doc_filer");
    (b as Record<string, unknown>).DEV_FAKE_EMAIL = filer.email;

    const res = await uploadForm16(filer.employeeId);
    expect(res.status).toBe(200);
  });
});

describe("a body reference to another object is gated by READ on that object", () => {
  // `policy.references` is the gate for a body field that POINTS AT another record, and a goal's alignment was
  // not declared in it: services/goals.ts checked that the parent exists and that the chain does not loop -
  // integrity, not access - so a caller could hang their own goal under a goal they cannot read. No disclosure
  // (the serializer emits a bare `goals/<id>` ref), but the row then sits in somebody else's alignment tree and
  // counts toward that subtree's rollups.
  const createGoal = (body: Record<string, unknown>) =>
    app.request(
      "/v1/goals",
      { method: "POST", headers: { "X-Requested-By": "hrms-spa", "Content-Type": "application/json" }, body: JSON.stringify(body) },
      b as unknown as Record<string, unknown>,
    );

  beforeEach(async () => {
    await deps.db.insert(schema.roles).values([{ name: "goal_owner", label: "Goals" }]).onConflictDoNothing();
    // Their own goals, and nobody else's - the ordinary employee grant.
    await deps.db.insert(schema.accessRules).values([
      { subject: "goal_owner", subjectKind: "role", namespace: "goals", pattern: "goals", scopeKind: "all", scopeCode: "", matchCode: null, level: "write", effect: "allow" },
      { subject: "goal_owner", subjectKind: "role", namespace: "goals", pattern: "goals.me.**", scopeKind: "self", scopeCode: "", matchCode: null, level: "write", effect: "allow" },
      { subject: "goal_owner", subjectKind: "role", namespace: "employees", pattern: "employees.me.**", scopeKind: "self", scopeCode: "", matchCode: null, level: "read", effect: "allow" },
    ]);
    clearCache();
  });

  async function goalFor(code: string, employeeId: string, title: string) {
    const uuid = genId();
    await deps.db.insert(schema.goals).values({ uuid, code, employeeId, title } as never);
    return uuid;
  }

  it("refuses aligning to a goal the caller may not read", async () => {
    const mine = await seedPerson("04-001", "Mine", "goal_owner");
    const other = await seedPerson("07-001", "Other", "goal_owner");
    const theirs = await goalFor("07-001-1", other.employeeId, "Their private objective");
    (b as Record<string, unknown>).DEV_FAKE_EMAIL = mine.email;

    const res = await createGoal({ title: "Mine", parent: `goals/${theirs}` });
    expect(res.status).toBe(403);
    expect(await deps.db.select().from(schema.goals).then((r) => r.length)).toBe(1); // only theirs
  });

  it("still allows aligning to one of the caller's own", async () => {
    const mine = await seedPerson("04-001", "Mine", "goal_owner");
    const ours = await goalFor("04-001-1", mine.employeeId, "My objective");
    (b as Record<string, unknown>).DEV_FAKE_EMAIL = mine.email;

    const res = await createGoal({ title: "Key result", parent: `goals/${ours}` });
    expect(res.status).toBe(200);
  });
});


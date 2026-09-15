/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { clearCache } from "../src/lib/cache";
import { app } from "../src/index";

// "View as" is a SERVER-side simulation (src/lib/viewAs.ts): while the header is present the app installs the
// subject as the request principal, so the answer is whatever THEY could see - not the admin's data wearing
// their capability set. These drive the real middleware chain (dev auth -> authz -> handler) against a real
// D1, because the whole point of the feature is that nothing downstream is special-cased.
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

const TABLES = [schema.accessRules, schema.auditLog, schema.leaveRequests, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  await deps.db.insert(schema.roles).values([
    { name: "super_admin", label: "Super" },
    { name: "employee", label: "Employee" },
    { name: "hr_admin", label: "HR" },
  ]);
  // The compiled grants this bare DB needs: super sees everything (a level rule AND the verb rule that
  // carries custom methods); an employee sees only their own records.
  await deps.db.insert(schema.accessRules).values([
    { subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", scopeCode: "", matchCode: null, level: "admin", effect: "allow" },
    { subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", scopeCode: "", matchCode: null, level: null, effect: "allow" },
    { subject: "employee", subjectKind: "role", namespace: "employees", pattern: "employees.me.**", scopeKind: "self", scopeCode: "", matchCode: null, level: "read", effect: "allow" },
    { subject: "employee", subjectKind: "role", namespace: "users", pattern: "users.me.**", scopeKind: "self", scopeCode: "", matchCode: null, level: "read", effect: "allow" },
    { subject: "hr_admin", subjectKind: "role", namespace: "users", pattern: "users.me.**", scopeKind: "self", scopeCode: "", matchCode: null, level: "read", effect: "allow" },
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

// The header speaks WIRE TOKENS, exactly as the SPA does (src/lib/viewAs.ts). It used to accept a bare
// internal id "because tests speak internal ids", which put a test affordance on a production header; the
// tests encode instead.
const viewAs = async (kind: "users" | "employees", id: string) => `${kind}/${await deps.idCodec.encode(kind, id)}`;

const req = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { "X-Requested-By": "hrms-spa", ...headers } }, b as unknown as Record<string, unknown>);

describe("view as - the simulation is enforced server-side", () => {
  it("answers /users/me as the subject, not as the admin driving it", async () => {
    const admin = await seedPerson("04-001", "Admin", "super_admin");
    const diya = await seedPerson("04-002", "Diya", "employee");
    (b as Record<string, unknown>).DEV_FAKE_EMAIL = admin.email;

    const plain = (await (await req("/v1/users/me")).json()) as { email: string };
    expect(plain.email).toBe(admin.email);

    const simulated = (await (await req("/v1/users/me", { "X-View-As": await viewAs("users", diya.userId) })).json()) as { email: string };
    expect(simulated.email).toBe(diya.email);
  });

  it("refuses a read the simulated user cannot make, even though the admin could", async () => {
    const admin = await seedPerson("04-001", "Admin", "super_admin");
    const diya = await seedPerson("04-002", "Diya", "employee");
    const aarav = await seedPerson("04-003", "Aarav", "employee");
    (b as Record<string, unknown>).DEV_FAKE_EMAIL = admin.email;

    const target = `/v1/employees/${aarav.employeeId}/bank-account`;
    expect((await req(target)).status).not.toBe(403); // the admin holds it (super)
    expect((await req(target, { "X-View-As": await viewAs("users", diya.userId) })).status).toBe(403); // Diya never could
    // Their OWN record still resolves - the simulation narrows, it doesn't blind.
    expect((await req(`/v1/employees/${diya.employeeId}`, { "X-View-As": await viewAs("users", diya.userId) })).status).toBe(200);
  });

  it("simulates a person who has never signed in (no users row) instead of 404ing the shell", async () => {
    const admin = await seedPerson("04-001", "Admin", "super_admin");
    // An employee with no account at all - the common case in a fresh org, and what broke the SPA before:
    // /users/me had no row to read, so the whole shell fell over on "couldn't load your account".
    const nobodyId = genId();
    await deps.db.insert(schema.employees).values({ uuid: nobodyId, code: "04-009", firstName: "Priya", lastName: "Test", workEmail: "priya@test.example", status: "active" });
    (b as Record<string, unknown>).DEV_FAKE_EMAIL = admin.email;

    const res = await req("/v1/users/me", { "X-View-As": await viewAs("employees", nobodyId) });
    expect(res.status).toBe(200);
    const me = (await res.json()) as { email: string; role: string; caller_access?: { capabilities: string[] } };
    expect(me.email).toBe("priya@test.example"); // graded as the account she WOULD get on first login
    expect(me.role).toBe("employee");
    expect(me.caller_access?.capabilities).toContain("employees.read");
  });

  it("refuses a raw internal id in the header - the subject is a wire token", async () => {
    const admin = await seedPerson("04-001", "Admin", "super_admin");
    const diya = await seedPerson("04-002", "Diya", "employee");
    (b as Record<string, unknown>).DEV_FAKE_EMAIL = admin.email;

    // The internal primary key is never an inbound identifier, on this header or anywhere else.
    const res = await req("/v1/users/me", { "X-View-As": `users/${diya.userId}` });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail?: string }).detail).toMatch(/must be users\/<id> or employees\/<id>/);

    // A token minted for the OTHER collection is not this one's, either: the codec binds a token to its
    // collection, so an employees token presented as a user fails the tag check rather than resolving.
    const crossed = await deps.idCodec.encode("employees", diya.employeeId);
    expect((await req("/v1/users/me", { "X-View-As": `users/${crossed}` })).status).toBe(404);
  });

  it("is read-only: any write while simulating is refused", async () => {
    const admin = await seedPerson("04-001", "Admin", "super_admin");
    const diya = await seedPerson("04-002", "Diya", "employee");
    (b as Record<string, unknown>).DEV_FAKE_EMAIL = admin.email;

    const res = await req(`/v1/employees/${diya.employeeId}`, { "X-View-As": await viewAs("users", diya.userId), "Content-Type": "application/merge-patch+json" }, {
      method: "PATCH",
      body: JSON.stringify({ first_name: "Nope" }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { detail?: string }).detail).toMatch(/^view as: read-only/);
  });

  it("only an access admin may simulate, and never a super admin from below", async () => {
    const hr = await seedPerson("04-004", "Hr", "hr_admin");
    const admin = await seedPerson("04-001", "Admin", "super_admin");
    const diya = await seedPerson("04-002", "Diya", "employee");

    // An hr_admin without access-rules.preview cannot simulate at all.
    (b as Record<string, unknown>).DEV_FAKE_EMAIL = hr.email;
    let res = await req("/v1/users/me", { "X-View-As": await viewAs("users", diya.userId) });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { detail?: string }).detail).toMatch(/may not simulate/);

    // Granted preview, they may simulate an employee - but not step into the super admin.
    await deps.db.insert(schema.accessRules).values({ subject: "hr_admin", subjectKind: "role", namespace: "access-rules", pattern: "access-rules.preview", scopeKind: "all", scopeCode: "", matchCode: null, level: null, effect: "allow" });
    clearCache();
    expect((await req("/v1/users/me", { "X-View-As": await viewAs("users", diya.userId) })).status).toBe(200);
    res = await req("/v1/users/me", { "X-View-As": await viewAs("users", admin.userId) });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { detail?: string }).detail).toMatch(/super admin/);
  });

  it("refuses a read the REAL caller could not make, however wide the subject's own grant is", async () => {
    // Rail 2 used to be one case: a non-super caller may not step into a super subject. Everything else was
    // allowed, and the widening that matters is not upward - it is SIDEWAYS, into an ordinary employee's own
    // `me` scope. The seeded policy keeps the admin roles out of other people's PII on purpose, and stepping
    // into somebody reads it with their self-grant unless the real caller is asked the same question.
    const hr = await seedPerson("04-004", "Hr", "hr_admin");
    const diya = await seedPerson("04-002", "Diya", "employee");
    await deps.db.insert(schema.accessRules).values({ subject: "hr_admin", subjectKind: "role", namespace: "access-rules", pattern: "access-rules.preview", scopeKind: "all", scopeCode: "", matchCode: null, level: null, effect: "allow" });
    clearCache();
    (b as Record<string, unknown>).DEV_FAKE_EMAIL = hr.email;

    // Diya may read her own record; this hr_admin holds nothing on `employees` at all.
    const asDiya = { "X-View-As": await viewAs("users", diya.userId) };
    expect((await req(`/v1/employees/${diya.employeeId}`)).status).toBe(403); // as themselves
    const res = await req(`/v1/employees/${diya.employeeId}`, asDiya);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { detail?: string }).detail).toMatch(/you do not have permission/);

    // ...and the containment NARROWS rather than blinds: granted the read as themselves, the simulation works.
    await deps.db.insert(schema.accessRules).values({ subject: "hr_admin", subjectKind: "role", namespace: "employees", pattern: "employees.**", scopeKind: "all", scopeCode: "", matchCode: null, level: "read", effect: "allow" });
    clearCache();
    expect((await req(`/v1/employees/${diya.employeeId}`, asDiya)).status).toBe(200);
  });

  it("records a sensitive read made through a simulation - it is not a self-read", async () => {
    // `isSelf` exists to stop logging YOUR reads of YOUR own data, and it is computed from the request
    // principal - which under a simulation is the SUBJECT on both sides, so it was always true and the
    // `employees.read.sensitive` row was never written. That made view-as QUIETER than acting as yourself for
    // the three sub-resources the policy calls an accountability event.
    const admin = await seedPerson("04-001", "Admin", "super_admin");
    const diya = await seedPerson("04-002", "Diya", "employee");
    (b as Record<string, unknown>).DEV_FAKE_EMAIL = admin.email;

    const res = await req(`/v1/employees/${diya.employeeId}/bank-account`, { "X-View-As": await viewAs("users", diya.userId) });
    expect(res.status).toBe(200); // allowed: Diya may read her own bank details

    const rows = await deps.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "employees.read.sensitive"));
    expect(rows.length).toBe(1);
    // Attributed to the human driving, naming who they were watching as - which is the promise lib/viewAs.ts
    // makes and could not keep while there was no row to stamp.
    expect(rows[0]!.actorEmail).toBe(admin.email);
    expect(JSON.parse(rows[0]!.meta ?? "{}")).toMatchObject({ viewing_as: diya.email, field: "bank-account" });
  });

  it("audits the read against the real admin, tagged with who they were watching as", async () => {
    const admin = await seedPerson("04-001", "Admin", "super_admin");
    const diya = await seedPerson("04-002", "Diya", "employee");
    (b as Record<string, unknown>).DEV_FAKE_EMAIL = admin.email;

    // A denied request is always audited (abuse signal) - the cheapest row to assert on.
    await req(`/v1/employees/${admin.employeeId}/bank-account`, { "X-View-As": await viewAs("users", diya.userId) });
    const rows = await deps.db.select().from(schema.auditLog).where(eq(schema.auditLog.actorEmail, admin.email));
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.parse(rows[0]!.meta ?? "{}")).toMatchObject({ viewing_as: diya.email });
  });
});

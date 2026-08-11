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

const req = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { "X-Requested-By": "hrms-spa", ...headers } }, b as unknown as Record<string, unknown>);

describe("view as - the simulation is enforced server-side", () => {
  it("answers /users/me as the subject, not as the admin driving it", async () => {
    const admin = await seedPerson("04-001", "Admin", "super_admin");
    const diya = await seedPerson("04-002", "Diya", "employee");
    (b as Record<string, unknown>).DEV_FAKE_EMAIL = admin.email;

    const plain = (await (await req("/v1/users/me")).json()) as { email: string };
    expect(plain.email).toBe(admin.email);

    const simulated = (await (await req("/v1/users/me", { "X-View-As": `users/${diya.userId}` })).json()) as { email: string };
    expect(simulated.email).toBe(diya.email);
  });

  it("refuses a read the simulated user cannot make, even though the admin could", async () => {
    const admin = await seedPerson("04-001", "Admin", "super_admin");
    const diya = await seedPerson("04-002", "Diya", "employee");
    const aarav = await seedPerson("04-003", "Aarav", "employee");
    (b as Record<string, unknown>).DEV_FAKE_EMAIL = admin.email;

    const target = `/v1/employees/${aarav.employeeId}/bank-account`;
    expect((await req(target)).status).not.toBe(403); // the admin holds it (super)
    expect((await req(target, { "X-View-As": `users/${diya.userId}` })).status).toBe(403); // Diya never could
    // Their OWN record still resolves - the simulation narrows, it doesn't blind.
    expect((await req(`/v1/employees/${diya.employeeId}`, { "X-View-As": `users/${diya.userId}` })).status).toBe(200);
  });

  it("simulates a person who has never signed in (no users row) instead of 404ing the shell", async () => {
    const admin = await seedPerson("04-001", "Admin", "super_admin");
    // An employee with no account at all - the common case in a fresh org, and what broke the SPA before:
    // /users/me had no row to read, so the whole shell fell over on "couldn't load your account".
    const nobodyId = genId();
    await deps.db.insert(schema.employees).values({ uuid: nobodyId, code: "04-009", firstName: "Priya", lastName: "Test", workEmail: "priya@test.example", status: "active" });
    (b as Record<string, unknown>).DEV_FAKE_EMAIL = admin.email;

    const res = await req("/v1/users/me", { "X-View-As": `employees/${nobodyId}` });
    expect(res.status).toBe(200);
    const me = (await res.json()) as { email: string; role: string; caller_access?: { capabilities: string[] } };
    expect(me.email).toBe("priya@test.example"); // graded as the account she WOULD get on first login
    expect(me.role).toBe("employee");
    expect(me.caller_access?.capabilities).toContain("employees.read");
  });

  it("is read-only: any write while simulating is refused", async () => {
    const admin = await seedPerson("04-001", "Admin", "super_admin");
    const diya = await seedPerson("04-002", "Diya", "employee");
    (b as Record<string, unknown>).DEV_FAKE_EMAIL = admin.email;

    const res = await req(`/v1/employees/${diya.employeeId}`, { "X-View-As": `users/${diya.userId}`, "Content-Type": "application/merge-patch+json" }, {
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
    let res = await req("/v1/users/me", { "X-View-As": `users/${diya.userId}` });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { detail?: string }).detail).toMatch(/may not simulate/);

    // Granted preview, they may simulate an employee - but not step into the super admin.
    await deps.db.insert(schema.accessRules).values({ subject: "hr_admin", subjectKind: "role", namespace: "access-rules", pattern: "access-rules.preview", scopeKind: "all", scopeCode: "", matchCode: null, level: null, effect: "allow" });
    clearCache();
    expect((await req("/v1/users/me", { "X-View-As": `users/${diya.userId}` })).status).toBe(200);
    res = await req("/v1/users/me", { "X-View-As": `users/${admin.userId}` });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { detail?: string }).detail).toMatch(/super admin/);
  });

  it("audits the read against the real admin, tagged with who they were watching as", async () => {
    const admin = await seedPerson("04-001", "Admin", "super_admin");
    const diya = await seedPerson("04-002", "Diya", "employee");
    (b as Record<string, unknown>).DEV_FAKE_EMAIL = admin.email;

    // A denied request is always audited (abuse signal) - the cheapest row to assert on.
    await req(`/v1/employees/${admin.employeeId}/bank-account`, { "X-View-As": `users/${diya.userId}` });
    const rows = await deps.db.select().from(schema.auditLog).where(eq(schema.auditLog.actorEmail, admin.email));
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.parse(rows[0]!.meta ?? "{}")).toMatchObject({ viewing_as: diya.email });
  });
});

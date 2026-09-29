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
import { previewAccess } from "../src/services/accessPreview";
import { clearCachePrefix } from "../src/lib/cache";
import { invalidateCodeCache } from "../src/lib/authzResolve";

// Real-D1 test for the effective-access preview: the service must mirror the middleware's grant assembly
// (role + everyone + user rules + per-object exceptions) and the engine's ladder/deny/verb semantics for
// ARBITRARY subjects - this is what the ACL modal's "view as" panel and impact warnings stand on.
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

// Fixed codes: alice + bob share dept 04; hala (HR) sits in 07.
const ALICE_CODE = "04-002";
const BOB_CODE = "04-003";
const HALA_CODE = "07-001";

const emp = (uuid: string, code: string, name: string) => ({ uuid, code, firstName: name, lastName: "T", workEmail: `${name}@test.example`, status: "active" as const });
const ids = { aliceEmp: genId(), bobEmp: genId(), halaEmp: genId(), alice: genId(), bob: genId(), hala: genId(), carol: genId(), dave: genId() };

beforeEach(async () => {
  for (const t of [schema.accessRules, schema.users, schema.employees, schema.roles]) await deps.db.delete(t);
  clearCachePrefix(""); // grant + manifest caches are cross-test state; start clean
  invalidateCodeCache();
  await deps.db.insert(schema.roles).values([
    { name: "employee", label: "Employee", provisioned: true }, // what an unlinked person is graded as
    { name: "hr_admin", label: "HR Admin" },
    { name: "everyone", label: "Everyone" },
  ]);
  await deps.db.insert(schema.employees).values([emp(ids.aliceEmp, ALICE_CODE, "alice"), emp(ids.bobEmp, BOB_CODE, "bob"), emp(ids.halaEmp, HALA_CODE, "hala")]);
  await deps.db.insert(schema.users).values([
    { uuid: ids.alice, code: `u-${genId().slice(0, 6)}`, email: "alice@test.example", role: "employee", employeeId: ids.aliceEmp },
    { uuid: ids.bob, code: `u-${genId().slice(0, 6)}`, email: "bob@test.example", role: "employee", employeeId: ids.bobEmp },
    { uuid: ids.hala, code: `u-${genId().slice(0, 6)}`, email: "hala@test.example", role: "hr_admin", employeeId: ids.halaEmp },
    { uuid: ids.carol, code: `u-${genId().slice(0, 6)}`, email: "carol@test.example", role: "employee", employeeId: null },
    { uuid: ids.dave, code: `u-${genId().slice(0, 6)}`, email: "dave@test.example", role: "hr_admin", employeeId: null, status: "disabled" },
  ]);
  const rule = (subject: string, subjectKind: "role" | "user", pattern: string, o: Partial<typeof schema.accessRules.$inferInsert> = {}) => ({
    id: genId(), subject, subjectKind, namespace: pattern.split(".")[0]!, pattern, scopeKind: "all" as const, scopeCode: "", effect: "allow" as const, ...o,
  });
  await deps.db.insert(schema.accessRules).values([
    // employee: write on own employee record (self scope), nothing collection-wide.
    rule("employee", "role", "employees.me.**", { scopeKind: "self", level: "write" }),
    // hr_admin: admin on all employees + the enrolDefaultBenefits verb anywhere.
    rule("hr_admin", "role", "employees.**", { level: "admin" }),
    rule("hr_admin", "role", "employees.*.enrollDefaultBenefits", {}),
    // hala is personally DENIED alice's record (user exception; deny wins over her role's admin).
    rule(ids.hala, "user", `employees.${ALICE_CODE}.**`, { scopeKind: "exact", scopeCode: ALICE_CODE, matchCode: ALICE_CODE, effect: "deny" }),
  ]);
});

const subj = (...us: string[]) => us.map((u) => `users/${u}`);
const byEmail = (rs: Awaited<ReturnType<typeof previewAccess>>) => new Map(rs.map((r) => [r.email, r]));

describe("previewAccess", () => {
  it("collection grain: self-scoped grants do not read as collection-wide; the hr ladder expands down", async () => {
    const rs = byEmail(await previewAccess(deps, { subjects: subj(ids.alice, ids.hala, ids.carol), collection: "employees" }));
    const alice = rs.get("alice@test.example")!;
    expect([alice.read, alice.write, alice.admin]).toEqual([false, false, false]); // own-record scope ≠ directory-wide
    const hala = rs.get("hala@test.example")!;
    expect([hala.read, hala.write, hala.admin]).toEqual([true, true, true]);
    const carol = rs.get("carol@test.example")!;
    expect([carol.read, carol.write, carol.admin]).toEqual([false, false, false]); // no employee link -> me never matches
  });

  it("object grain: self scope allows the own record with why=self; a user deny beats the role admin", async () => {
    const rs = byEmail(await previewAccess(deps, { subjects: subj(ids.alice, ids.bob, ids.hala), collection: "employees", object: `employees/${ids.aliceEmp}` }));
    const alice = rs.get("alice@test.example")!;
    expect([alice.read, alice.write, alice.admin]).toEqual([true, true, false]);
    expect(alice.why).toBe("self");
    expect(alice.denied).toBe(false);
    const bob = rs.get("bob@test.example")!; // same dept, but the employee role has no dept tier here
    expect(bob.read).toBe(false);
    const hala = rs.get("hala@test.example")!; // admin everywhere EXCEPT this record (personal deny)
    expect([hala.read, hala.denied]).toEqual([false, true]);
  });

  it("verbs: allowed only by an explicit verb grant, and a matching deny kills the verb too", async () => {
    const onBob = byEmail(await previewAccess(deps, { subjects: subj(ids.alice, ids.hala), collection: "employees", object: `employees/${ids.bobEmp}`, verb: "enrollDefaultBenefits" }));
    expect(onBob.get("hala@test.example")!.verb_allowed).toBe(true);
    expect(onBob.get("alice@test.example")!.verb_allowed).toBe(false);
    const onAlice = byEmail(await previewAccess(deps, { subjects: subj(ids.hala), collection: "employees", object: `employees/${ids.aliceEmp}`, verb: "enrollDefaultBenefits" }));
    expect(onAlice.get("hala@test.example")!.verb_allowed).toBe(false); // the exact deny covers the verb key
  });

  it("<collection>/me grades a self-acting verb on the key the real /me request decides", async () => {
    await deps.db.insert(schema.accessRules).values({
      subject: "employee", subjectKind: "role", namespace: "attendance", pattern: "attendance.me.clockIn", scopeKind: "self", scopeCode: "", effect: "allow",
    });
    // The bare collection key has no record token for `me` to match - the verdict that read "cannot clockIn".
    const bare = byEmail(await previewAccess(deps, { subjects: subj(ids.alice), collection: "attendance", verb: "clockIn" }));
    expect(bare.get("alice@test.example")!.verb_allowed).toBe(false);
    const own = byEmail(await previewAccess(deps, { subjects: subj(ids.alice, ids.hala), collection: "attendance", object: "attendance/me", verb: "clockIn" }));
    expect(own.get("alice@test.example")!.verb_allowed).toBe(true);
    expect(own.get("hala@test.example")!.verb_allowed).toBe(false); // hr_admin holds no clockIn rule here
    await expect(previewAccess(deps, { subjects: subj(ids.alice), collection: "attendance", object: "attendance/me", field: "notes" })).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("a disabled account reports all-false with the disabled flag (matches auth reality)", async () => {
    const [dave] = await previewAccess(deps, { subjects: subj(ids.dave), collection: "employees" });
    expect(dave!.disabled).toBe(true);
    expect([dave!.read, dave!.write, dave!.admin]).toEqual([false, false, false]);
  });

  it("include_capabilities returns the /users/me-style set, works collection-less, and empties for disabled", async () => {
    const rs = byEmail(await previewAccess(deps, { subjects: subj(ids.hala, ids.alice, ids.dave), include_capabilities: true }));
    const halaCaps = rs.get("hala@test.example")!.capabilities!;
    expect(halaCaps).toEqual(expect.arrayContaining(["employees.read", "employees.write", "employees.admin", "employees.enrollDefaultBenefits"]));
    expect(rs.get("alice@test.example")!.capabilities).toEqual(expect.arrayContaining(["employees.read", "employees.write"])); // self scope stripped, ladder expanded
    expect(rs.get("dave@test.example")!.capabilities).toEqual([]); // disabled account
    // Collection-less call grades nothing.
    expect(rs.get("hala@test.example")!.read).toBe(false);
    // Without the flag, a collection is still required.
    await expect(previewAccess(deps, { subjects: subj(ids.alice) })).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("employees/<id> subjects: linked resolves to the account; unlinked grades as the default-role account", async () => {
    const ghostEmp = genId();
    await deps.db.insert(schema.employees).values(emp(ghostEmp, "04-009", "ghost"));
    const rs = await previewAccess(deps, {
      subjects: [`employees/${ids.aliceEmp}`, `employees/${ghostEmp}`],
      collection: "employees",
      object: `employees/${ids.aliceEmp}`,
      include_capabilities: true,
    });
    const alice = rs.find((r) => r.subject === `employees/${ids.aliceEmp}`)!;
    expect([alice.read, alice.write]).toEqual([true, true]); // via her linked account's self scope
    const ghost = rs.find((r) => r.subject === `employees/${ghostEmp}`)!;
    expect(ghost.role).toBe("employee"); // never signed in -> the account they'd get
    expect(ghost.read).toBe(false); // someone ELSE's record; self scope doesn't reach it
    expect(ghost.capabilities).toEqual(expect.arrayContaining(["employees.read"])); // own-record cap, scope-stripped
  });

  it("validates its inputs (field needs an object; foreign object collection rejected)", async () => {
    await expect(previewAccess(deps, { subjects: subj(ids.alice), collection: "employees", field: "bank-account" })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(previewAccess(deps, { subjects: subj(ids.alice), collection: "employees", object: `departments/${ids.bobEmp}` })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(previewAccess(deps, { subjects: [], collection: "employees" })).rejects.toMatchObject({ httpStatus: 400 });
  });
});

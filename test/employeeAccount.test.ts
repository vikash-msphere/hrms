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
import { eq } from "drizzle-orm";
import { createEmployee, updateEmployee } from "../src/services/employees";
import { grantFor } from "../bootstrap/authz/grants";

// An access rule names a `users/{id}` subject (domain/policyValidate.ts), so a person with no account row can
// neither be granted access nor be offered by the access modal's people picker. That is why the account is
// provisioned when the employee is created rather than at their first sign-in - which used to leave the picker
// listing only the handful of people who had already logged in.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;
const actor = { uuid: genId(), email: "hr@test.example", role: "hr_admin", employeeId: null } as unknown as AppUser;

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

beforeEach(async () => {
  for (const t of [schema.notifications, schema.auditLog, schema.accessRules, schema.userRoles, schema.users, schema.employees, schema.codeSequences, schema.roles]) await deps.db.delete(t);
  // `users.role` is a FK to the roles catalog (roles are data), and the provisioned account gets the role marked
  // `provisioned` - `employee` here, as in a seeded database.
  await deps.db.insert(schema.roles).values([{ name: "employee", label: "Employee", provisioned: true }, { name: "hr_admin", label: "HR admin" }, { name: "super_admin", label: "Super admin" }]).onConflictDoNothing();
});

const accountFor = async (employeeId: string) =>
  (await deps.db.select().from(schema.users).where(eq(schema.users.employeeId, employeeId)).limit(1))[0];

const hire = (email: string, first = "Asha") =>
  createEmployee(deps, actor, { first_name: first, last_name: "Rao", work_email: email });

describe("employee sign-in accounts", () => {
  it("provisions an account when the employee is created", async () => {
    const row = await hire("asha@test.example");
    const account = await accountFor(row.uuid);
    expect(account?.email).toBe("asha@test.example");
    expect(account?.role).toBe("employee");
    expect(account?.status).toBe("active");
    expect(account?.code).toBeTruthy(); // flat-coded like any other account, so scoped lists can bind it
  });

  it("links the account someone already signed in with instead of minting a second one", async () => {
    const existing = genId();
    await deps.db.insert(schema.users).values({ uuid: existing, code: "01", email: "Early@test.example", role: "employee" });
    const row = await hire("early@test.example"); // HR types the address in a different case
    expect((await deps.db.select().from(schema.users)).length).toBe(1);
    expect((await accountFor(row.uuid))?.uuid).toBe(existing);
  });

  it("links the OLDEST of two accounts that differ only in case, not whichever the engine returns first", async () => {
    // `users.email` is UNIQUE on the RAW column, so both of these are legal rows and `lower(email) = ?` matches
    // both. Which one the new employee is linked to is not a cosmetic choice - the two carry different roles and
    // different access rules - so the tie is broken by age rather than by the query plan. Oldest first, because
    // that is the row that has been accruing the grants. The middleware's own first-login lookup breaks the same
    // tie the same way (middleware/auth.ts loadUserRow `stable`).
    const older = genId();
    const newer = genId();
    await deps.db.insert(schema.users).values([
      { uuid: older, code: "01", email: "Dev@test.example", role: "employee", createdAt: new Date(1_700_000_000_000) },
      { uuid: newer, code: "02", email: "DEV@test.example", role: "employee", createdAt: new Date(1_800_000_000_000) },
    ]);
    const row = await hire("dev@test.example", "Dev");
    expect((await accountFor(row.uuid))?.uuid).toBe(older);
    expect((await deps.db.select().from(schema.users)).length).toBe(2); // neither clobbered, none minted
  });

  it("leaves an account that already holds the new address alone", async () => {
    // Somebody signed in with that address already (an account of their own, no employee link). `users.email` is
    // UNIQUE, so moving this employee's account onto it would have to clobber theirs: the employee edit stands
    // and the two accounts are left for whoever reconciles them in the Accounts screen.
    const stranger = genId();
    await deps.db.insert(schema.users).values({ uuid: stranger, code: "01", email: "shared@test.example", role: "employee" });
    const row = await hire("chetan@test.example", "Chetan");
    await updateEmployee(deps, actor, row.uuid, { work_email: "shared@test.example" });
    expect((await accountFor(row.uuid))?.email).toBe("chetan@test.example");
    expect((await deps.db.select().from(schema.users).where(eq(schema.users.uuid, stranger)).limit(1))[0]?.employeeId).toBeNull();
  });

  it("moves the account when the work email is corrected", async () => {
    const row = await hire("typo@test.example");
    await updateEmployee(deps, actor, row.uuid, { work_email: "fixed@test.example" });
    expect((await accountFor(row.uuid))?.email).toBe("fixed@test.example");
    expect((await deps.db.select().from(schema.users)).length).toBe(1);
  });

  it("ends the live sessions that were issued to the old address", async () => {
    // A session cookie carries the EMAIL and nothing else (lib/session.ts), verified by signature alone for
    // twelve hours. Move the column without this stamp and the next request with that cookie does not fail -
    // middleware/auth.ts misses both lookups, finds the old address still inside an allowed domain, finds no
    // employee holding it (this edit just moved it) and AUTO-PROVISIONS a second account at the default role
    // with no employee link. The person then carries on in an app where every `me`-scoped grant matches
    // nothing, while their real roles sit on the account that moved.
    const before = Date.now();
    const row = await hire("old.address@test.example");
    expect((await accountFor(row.uuid))?.sessionsValidFrom).toBeNull(); // nothing revoked by the hire itself

    await updateEmployee(deps, actor, row.uuid, { work_email: "new.address@test.example" });

    const account = await accountFor(row.uuid);
    expect(account?.email).toBe("new.address@test.example");
    expect(account?.sessionsValidFrom).not.toBeNull();
    expect(+new Date(account!.sessionsValidFrom!)).toBeGreaterThanOrEqual(before);
    // And no phantom account was minted for the address that was left behind.
    expect((await deps.db.select().from(schema.users)).length).toBe(1);
  });

  // The account row IS the sign-in identity, and every lane resolves a caller by their lowercased address
  // (middleware/auth.ts - the Access JWT's email, the session cookie's, the dev bypass). Stored as typed, an
  // address HR entered with capitals was never found by that login: it minted a SECOND account at the default
  // role, leaving the person with no access and their real role sitting on the row beside it.
  it("stores the sign-in address lowercased, however HR typed it", async () => {
    const row = await hire("Priya.Nair@Test.Example", "Priya");
    expect((await accountFor(row.uuid))?.email).toBe("priya.nair@test.example");
  });

  it("keeps it lowercased when the work email is corrected", async () => {
    const row = await hire("wrong@test.example");
    await updateEmployee(deps, actor, row.uuid, { work_email: "Right.Name@Test.Example" });
    expect((await accountFor(row.uuid))?.email).toBe("right.name@test.example");
    expect((await deps.db.select().from(schema.users)).length).toBe(1);
  });

  it("provisions on a work-email edit for an employee that has no account yet", async () => {
    const id = genId();
    await deps.db.insert(schema.employees).values({ uuid: id, code: "04-0011", firstName: "Divya", lastName: "Rao", workEmail: "old@test.example" });
    await updateEmployee(deps, actor, id, { work_email: "new@test.example" });
    expect((await accountFor(id))?.email).toBe("new@test.example");
  });
});

// The sign-in account is the identity every grant hangs off, and auth resolves a caller by its email. Whoever
// edits employee records must not thereby choose the login address of an account that holds MORE than a plain
// provisioned employee does - that is re-pointing somebody else's privileges at a mailbox the editor picked.
describe("a work-email edit and a privileged account", () => {
  const hr = { ...actor, grant: grantFor("hr_admin") } as unknown as AppUser;
  const superAdmin = { uuid: genId(), email: "root@test.example", role: "super_admin", employeeId: null, grant: grantFor("super_admin") } as unknown as AppUser;
  const auditActions = async () => (await deps.db.select().from(schema.auditLog)).map((r) => r.action);

  it("HR still corrects a plain employee's address, and the login follows", async () => {
    const row = await hire("typo@test.example");
    await updateEmployee(deps, hr, row.uuid, { work_email: "fixed@test.example" });
    expect((await accountFor(row.uuid))?.email).toBe("fixed@test.example");
  });

  it("HR editing an account admin's work email leaves their sign-in address where it was", async () => {
    const row = await hire("boss@test.example", "Boss");
    await deps.db.update(schema.users).set({ role: "super_admin" }).where(eq(schema.users.employeeId, row.uuid));
    await updateEmployee(deps, hr, row.uuid, { work_email: "boss@elsewhere.example" });
    // The employee record moves (HR owns it); the login does not, and the mismatch is on the record.
    expect((await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, row.uuid)))[0]?.workEmail).toBe("boss@elsewhere.example");
    const account = await accountFor(row.uuid);
    expect(account?.email).toBe("boss@test.example");
    expect(account?.sessionsValidFrom).toBeNull(); // nobody was signed out either
    expect(await auditActions()).toContain("employee.loginEmailMismatch");
  });

  it("an extra role or a personal grant counts as privileged too", async () => {
    const extra = await hire("extra@test.example", "Extra");
    const extraAcct = (await accountFor(extra.uuid))!;
    await deps.db.insert(schema.userRoles).values({ userId: extraAcct.uuid, role: "hr_admin" });
    await updateEmployee(deps, hr, extra.uuid, { work_email: "extra2@test.example" });
    expect((await accountFor(extra.uuid))?.email).toBe("extra@test.example");

    const ruled = await hire("ruled@test.example", "Ruled");
    const ruledAcct = (await accountFor(ruled.uuid))!;
    await deps.db.insert(schema.accessRules).values({ uuid: genId(), subject: ruledAcct.uuid, subjectKind: "user", namespace: "payslips", pattern: "payslips.**", scopeKind: "all", level: "read", effect: "allow" });
    await updateEmployee(deps, hr, ruled.uuid, { work_email: "ruled2@test.example" });
    expect((await accountFor(ruled.uuid))?.email).toBe("ruled@test.example");
  });

  it("an account admin's edit moves the login as before", async () => {
    const row = await hire("boss@test.example", "Boss");
    await deps.db.update(schema.users).set({ role: "super_admin" }).where(eq(schema.users.employeeId, row.uuid));
    await updateEmployee(deps, superAdmin, row.uuid, { work_email: "boss@new.example" });
    expect((await accountFor(row.uuid))?.email).toBe("boss@new.example");
    expect(await auditActions()).not.toContain("employee.loginEmailMismatch");
  });
});

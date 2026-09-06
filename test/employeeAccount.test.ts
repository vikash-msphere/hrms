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
  for (const t of [schema.employees, schema.users, schema.codeSequences, schema.roles]) await deps.db.delete(t);
  // `users.role` is a FK to the roles catalog (roles are data), and the provisioned account is an `employee`.
  await deps.db.insert(schema.roles).values([{ name: "employee", label: "Employee" }, { name: "hr_admin", label: "HR admin" }]).onConflictDoNothing();
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

  it("provisions on a work-email edit for an employee that has no account yet", async () => {
    const id = genId();
    await deps.db.insert(schema.employees).values({ uuid: id, code: "04-0011", firstName: "Divya", lastName: "Rao", workEmail: "old@test.example" });
    await updateEmployee(deps, actor, id, { work_email: "new@test.example" });
    expect((await accountFor(id))?.email).toBe("new@test.example");
  });
});

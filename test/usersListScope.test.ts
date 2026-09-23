/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import type { ListScope } from "../src/domain/access";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { listUsers, updateUser } from "../src/services/users";
import type { AppUser } from "../src/env";
import { EMPTY_GRANT } from "../src/domain/grants";
import { DEFAULT_POLICY } from "../src/domain/manifests";

// A sign-in account names a person, their email and the role they hold, so who may LIST accounts matters.
// Everyone holds `users.me.**` (their own account), which resolves to breadth `own`; only an admin holds
// `users.**`. The list used to bind no scope at all, so anyone who could read their own account got a page of
// every account in the company. These pin the binding.
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

const mine = genId();
const peer = genId();
beforeEach(async () => {
  for (const t of [schema.users, schema.employees, schema.roles]) await deps.db.delete(t);
  await deps.db.insert(schema.roles).values([{ name: "employee", label: "Employee" }, { name: "super_admin", label: "Super" }]);
  await deps.db.insert(schema.employees).values([
    { uuid: mine, code: "04-0001", firstName: "Me", lastName: "Self", workEmail: "me@test.example", status: "active" },
    { uuid: peer, code: "04-0002", firstName: "Peer", lastName: "Other", workEmail: "peer@test.example", status: "active" },
  ]);
  await deps.db.insert(schema.users).values([
    { uuid: genId(), code: "u-1", email: "me@test.example", role: "employee", status: "active", employeeId: mine },
    { uuid: genId(), code: "u-2", email: "peer@test.example", role: "employee", status: "active", employeeId: peer },
    { uuid: genId(), code: "u-3", email: "admin@test.example", role: "super_admin", status: "active", employeeId: null },
  ]);
});

const all: ListScope = { breadth: "all", deptCode: null, ownerId: null, seeRestricted: true };
const own: ListScope = { breadth: "own", deptCode: null, ownerId: mine, seeRestricted: true };

describe("the accounts list is scoped", () => {
  it("gives an admin every account", async () => {
    expect((await listUsers(deps, all, 50)).items.length).toBe(3);
  });

  it("gives everyone else their own account and nobody else's", async () => {
    const { items } = await listUsers(deps, own, 50);
    expect(items.map((r: { email: string }) => r.email)).toEqual(["me@test.example"]);
  });

  it("gives an unscoped request nothing, rather than the whole table", async () => {
    expect((await listUsers(deps, undefined, 50)).items).toEqual([]);
  });
});

// ONE account per person. The link is patchable, and without the unique index two accounts could name the
// same employee - at which point "this person's account" has two answers and every consumer picks a
// different one (the view-as subject lookup takes whichever row comes back, the holiday-feed token is minted
// for one of them, a self-scoped grant resolves against whichever employee code the account carries).
describe("an employee may hold only one sign-in account", () => {
  const actor = (uuid: string): AppUser => ({
    uuid, email: "admin@test.example", role: "super_admin", roles: ["super_admin"], status: "active",
    employeeId: null, employeeCode: null, name: "Admin", grant: EMPTY_GRANT, policy: DEFAULT_POLICY,
  });

  it("refuses to point a second account at an employee who already has one", async () => {
    const admin = (await deps.db.select().from(schema.users)).find((u) => u.email === "admin@test.example")!;
    // `peer` already belongs to u-2. Say so, rather than raising a bare UNIQUE constraint as a 500.
    await expect(updateUser(deps, actor(admin.uuid), admin.uuid, { employee: `employees/${peer}` })).rejects.toThrow(/already has a sign-in account/);
    // and nothing moved
    const after = (await deps.db.select().from(schema.users)).find((u) => u.uuid === admin.uuid)!;
    expect(after.employeeId).toBeNull();
  });

  it("still allows linking an account to an employee who has none", async () => {
    const admin = (await deps.db.select().from(schema.users)).find((u) => u.email === "admin@test.example")!;
    const spare = genId();
    await deps.db.insert(schema.employees).values({ uuid: spare, code: "04-0003", firstName: "Spare", lastName: "Person", workEmail: "spare@test.example", status: "active" });
    const updated = await updateUser(deps, actor(admin.uuid), admin.uuid, { employee: `employees/${spare}` });
    expect(updated.employeeId).toBe(spare);
  });

  it("leaves accounts with no employee unconstrained - NULLs are distinct in the index", async () => {
    await deps.db.insert(schema.users).values([
      { uuid: genId(), code: "u-4", email: "svc1@test.example", role: "employee", status: "active", employeeId: null },
      { uuid: genId(), code: "u-5", email: "svc2@test.example", role: "employee", status: "active", employeeId: null },
    ]);
    expect((await listUsers(deps, all, 50)).items.length).toBe(5);
  });
});

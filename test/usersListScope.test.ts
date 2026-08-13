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
import { listUsers } from "../src/services/users";

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

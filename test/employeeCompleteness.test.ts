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
import { app } from "../src/index";

// The record-quality flags (`profile_completeness`) are what the Profile and EmployeeProfile pages render to
// tell someone their record is missing a bank account or an emergency contact. They ride the ITEM read only:
// computing them decrypts three stored blobs per employee, and no list renders them. Putting them on the
// employee spec's `decorate` looked equivalent and was not - `overrides.get` replaces the method that applies
// decorate, so the flags silently vanished from the wire while the spec still declared them. These pin both
// halves of the contract: present on the item read, absent from a page.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const DEV_EMAIL = "dev@example.com"; // the dev-auth bypass (vitest.config.ts) is the ambient credential
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

let employeeId: string;
beforeEach(async () => {
  for (const t of [schema.employees, schema.accessRules, schema.users, schema.roles]) await deps.db.delete(t);
  await deps.db.insert(schema.roles).values([{ name: "super_admin", label: "Super" }]).onConflictDoNothing();
  await deps.db.insert(schema.accessRules).values([
    { subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", scopeCode: "", matchCode: null, level: "admin", effect: "allow" },
    { subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", scopeCode: "", matchCode: null, level: null, effect: "allow" },
  ]);
  await deps.db.insert(schema.users).values({ uuid: genId(), code: `u-${genId().slice(0, 4)}`, email: DEV_EMAIL, role: "super_admin", status: "active" });
  employeeId = genId();
  await deps.db.insert(schema.employees).values({
    uuid: employeeId, code: "04-0001", firstName: "Asha", lastName: "Rao",
    workEmail: "asha@test.example", status: "active",
  });
});

const get = (path: string) =>
  app.request(path, { headers: { "X-Requested-By": "hrms-spa" } }, b as unknown as Record<string, unknown>);

describe("employee profile completeness", () => {
  it("rides the item read", async () => {
    const res = await get(`/v1/employees/${employeeId}`);
    expect(res.status).toBe(200);
    const emp = (await res.json()) as Record<string, any>;
    // An empty record: every flag false, and `signature` stripped because the caller is not this employee.
    expect(emp.profile_completeness).toMatchObject({ photo: false, personal: false, bank: false });
    expect(emp.profile_completeness.signature, "even the flag's existence is owner-only").toBeUndefined();
  });

  it("stays off a page, which would decrypt three blobs per row for a field no list renders", async () => {
    const page = (await (await get("/v1/employees")).json()) as { results: Record<string, any>[] };
    expect(page.results.length).toBe(1);
    expect(page.results[0]!.profile_completeness).toBeUndefined();
  });
});

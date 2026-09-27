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
import { clearCachePrefix } from "../src/lib/cache";
import { provisionedRole, updateRole, deleteRole } from "../src/services/roles";

// Which role a new account gets is DATA on the role row, not a name in the Worker. One role carries it, the flag
// moves rather than clears, and a database where nobody set it refuses new accounts instead of guessing.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;
const actor = { uuid: genId(), email: "super@test.example", role: "super_admin", roles: ["super_admin"], employeeId: null } as unknown as AppUser;

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
  for (const t of [schema.auditLog, schema.roles]) await deps.db.delete(t);
  clearCachePrefix("");
  await deps.db.insert(schema.roles).values([
    { name: "everyone", label: "Everyone" },
    { name: "employee", label: "Employee", provisioned: true },
    { name: "contractor", label: "Contractor" },
    { name: "super_admin", label: "Super" },
  ]);
});

describe("the provisioned role", () => {
  it("is read off the role row", async () => {
    expect(await provisionedRole(deps)).toBe("employee");
  });

  it("moves: marking another role takes it off the old one, so exactly one holds it", async () => {
    await updateRole(deps, actor, "contractor", { provisioned: true });
    expect(await provisionedRole(deps)).toBe("contractor");
    const marked = (await deps.db.select().from(schema.roles)).filter((r) => r.provisioned).map((r) => r.name);
    expect(marked).toEqual(["contractor"]);
  });

  it("cannot be cleared outright, and cannot land on `everyone`", async () => {
    await expect(updateRole(deps, actor, "employee", { provisioned: false })).rejects.toThrow(/choose another role/);
    await expect(updateRole(deps, actor, "everyone", { provisioned: true })).rejects.toThrow(/not a role an account can hold/);
    expect(await provisionedRole(deps)).toBe("employee");
  });

  it("cannot be deleted while it is the one new accounts get", async () => {
    await expect(deleteRole(deps, actor, "employee")).rejects.toThrow(/new accounts are given this role/);
  });

  it("refuses when no role carries it, and does not remember the refusal", async () => {
    await deps.db.update(schema.roles).set({ provisioned: false });
    clearCachePrefix("");
    await expect(provisionedRole(deps)).rejects.toThrow(/no role is set to be given to new accounts/);
    // Fixed straight away: the next call sees it without waiting out a cached "none".
    await deps.db.update(schema.roles).set({ provisioned: true }).where(eq(schema.roles.name, "contractor"));
    expect(await provisionedRole(deps)).toBe("contractor");
  });
});

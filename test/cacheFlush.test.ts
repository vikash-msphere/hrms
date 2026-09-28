/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { seedManifest } from "./seedManifest";
import { app } from "../src/index";
import { loadRoleGrant } from "../src/lib/policyLoad";
import { readGenerations, type Generations } from "../src/lib/cacheGenerations";

// `POST /v1/operations:clearCache` (the "Clear caches" button). Other instances cannot be observed from a test,
// so what is checked is the two halves they rely on: every counter moves (which is how every other instance
// learns), and the answering instance is emptied at once. And that it is an admin act: gated and recorded.
describe("operations:clearCache", () => {
  const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const b = env as unknown as Bindings;
  let deps: Deps;

  beforeAll(async () => {
    (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
    (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
    (b as Record<string, unknown>).ALLOW_DEV_AUTH = "true";
    for (const stmt of migrationSql.split("--> statement-breakpoint")) {
      const t = stmt.trim();
      if (t) await b.DB.prepare(t).run();
    }
    await seedManifest(b.DB);
    deps = makeDeps(b);
    await deps.db.insert(schema.roles).values([{ name: "super_admin", label: "Super" }, { name: "employee", label: "Employee" }]).onConflictDoNothing();
    await deps.db.insert(schema.users).values([
      { uuid: "usr1234567890", code: "u-1", email: "super@test.example", role: "super_admin" },
      { uuid: "usr2234567890", code: "u-2", email: "emp@test.example", role: "employee" },
    ]);
    await deps.db.insert(schema.accessRules).values([
      { uuid: "arl1234567890", subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", level: "admin", effect: "allow" },
      { uuid: "arl2234567890", subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", level: null, effect: "allow" },
    ]);
  });

  const clear = (as: string) => {
    (b as Record<string, unknown>).DEV_FAKE_EMAIL = as;
    return app.request("/v1/operations:clearCache", { method: "POST", headers: { "content-type": "application/json", "X-Requested-By": "hrms-spa" } }, b as unknown as Record<string, unknown>);
  };

  it("moves every counter and empties this instance at once", async () => {
    // Warm a role grant, then take its rule away behind the cache's back and put the counter back, so nothing
    // but the flush could make this instance re-read it.
    const before = (await readGenerations(deps))!;
    await deps.db.insert(schema.accessRules).values({ uuid: "arl3234567890", subject: "employee", subjectKind: "role", namespace: "holidays", pattern: "holidays.**", scopeKind: "all", level: "read", effect: "allow" });
    expect((await loadRoleGrant(deps, "employee")).levels?.["holidays.**"]).toBe("read");
    const warm = (await readGenerations(deps))!;
    await deps.db.delete(schema.accessRules).where(eq(schema.accessRules.uuid, "arl3234567890"));
    await deps.db.update(schema.cacheGenerations).set({ roleRules: warm.roleRules });
    expect((await loadRoleGrant(deps, "employee")).levels?.["holidays.**"]).toBe("read"); // still the held rows

    const res = await clear("super@test.example");
    expect(res.status).toBe(200);
    expect(typeof ((await res.json()) as { clear_time: string }).clear_time).toBe("string");

    const after = (await readGenerations(deps))!;
    for (const k of Object.keys(after) as (keyof Generations)[]) expect(after[k], k).toBeGreaterThan(before[k]);
    expect((await loadRoleGrant(deps, "employee")).levels?.["holidays.**"]).toBeUndefined(); // re-read, rule gone

    // And it is an act on the record. Checked in this test because the pool rolls each test's writes back.
    const actions = (await deps.db.select().from(schema.auditLog)).map((r) => r.action);
    expect(actions).toContain("operations.clearCache");
  });

  it("is refused to someone nobody granted it to", async () => {
    const before = (await readGenerations(deps))!;
    const res = await clear("emp@test.example");
    expect(res.status).toBe(403);
    expect(await readGenerations(deps)).toEqual(before);
  });
});

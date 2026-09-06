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
import { crudService } from "../src/services/crud";
import { assetCategorySpec, type AssetCategoryInput } from "../src/services/assetCategories";

// Two people creating a record in the same collection at the same moment.
//
// Codes are allocated read-max-then-write (services/codeAlloc.ts): every create reads the sibling codes in
// scope and composes the next one. Simultaneous creates therefore read the same maximum and compose the same
// code, and the UNIQUE index on `code` is what stops the duplicate from being minted - it fails the loser
// instead. The loser's request was never wrong, so services/crud.ts re-reads the scope and composes again;
// what this test protects is that the second writer gets a record rather than an error to retry by hand.
//
// The `await`s inside `create` are what interleave the attempts here: with every create started before any of
// them inserts, all of them read the same empty scope, which is exactly the race the retry exists for.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;
const categories = crudService<AssetCategoryInput, typeof schema.assetCategories>(assetCategorySpec);

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

// `codeSequences` is in here with the rest: allocation runs off that counter now (services/codeAlloc.ts), so
// leaving it behind would carry one test's high-water mark into the next one's assertions.
const TABLES = [schema.assetCategories, schema.auditLog, schema.eventLog, schema.settings, schema.users, schema.employees, schema.roles, schema.codeSequences];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

async function seedActor(role = "hr_admin"): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: role, label: role }).onConflictDoNothing();
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: `04-${genId().slice(0, 3)}`, firstName: "Test", lastName: "User", workEmail: `${employeeId}@test.example`, status: "active" });
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role, employeeId });
  return { uuid, email: `${uuid}@test.example`, role, status: "active", employeeId, employeeCode: null } as unknown as AppUser;
}

describe("a create that loses the code-allocation race", () => {
  it("re-allocates instead of failing the second writer", async () => {
    const admin = await seedActor();

    const rows = await Promise.all(
      ["Laptop", "Phone", "Monitor", "Headset"].map((display_name) => categories.create(deps, admin, { display_name })),
    );

    // Every writer got a record, and no two of them are filed under the same code - which is what the UNIQUE
    // index guarantees and the retry is what turns from an error into a row.
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.code)).size).toBe(4);

    const stored = await deps.db.select({ code: schema.assetCategories.code }).from(schema.assetCategories);
    expect(stored).toHaveLength(4);
  });
});

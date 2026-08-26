/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { makeRefCache, bustRef, refPayComponents } from "../src/lib/refData";
import { getSettingValue } from "../src/services/settings";

// The reference-data memo (src/lib/refData.ts): the small catalogs the money code reads whole are read ONCE per
// request and never held past it. Both halves matter - the saving, and the bound on staleness - so both are
// pinned here.

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

beforeEach(async () => {
  await deps.db.delete(schema.payComponents);
  await deps.db.delete(schema.settings);
  delete deps.refCache;
});

const setThreshold = (n: number) =>
  deps.db.insert(schema.settings).values({ key: "expenses", value: JSON.stringify({ auto_approve_threshold: n }) });

describe("reference-data memo", () => {
  it("reads a table once for the whole request", async () => {
    await setThreshold(100);
    const scoped: Deps = { ...deps, refCache: makeRefCache() };
    expect((await getSettingValue<{ auto_approve_threshold?: number }>(scoped, "expenses", {})).auto_approve_threshold).toBe(100);
    // Change the row behind the request's back: the memo is what the rest of the request sees, which is the
    // point (one read, and a consistent view of config for the whole operation).
    await deps.db.update(schema.settings).set({ value: JSON.stringify({ auto_approve_threshold: 999 }) }).where(eq(schema.settings.key, "expenses"));
    expect((await getSettingValue<{ auto_approve_threshold?: number }>(scoped, "expenses", {})).auto_approve_threshold).toBe(100);
  });

  it("never outlives the request: a fresh memo sees the new value", async () => {
    await setThreshold(100);
    const first: Deps = { ...deps, refCache: makeRefCache() };
    await getSettingValue(first, "expenses", {});
    await deps.db.update(schema.settings).set({ value: JSON.stringify({ auto_approve_threshold: 999 }) }).where(eq(schema.settings.key, "expenses"));
    const second: Deps = { ...deps, refCache: makeRefCache() };
    expect((await getSettingValue<{ auto_approve_threshold?: number }>(second, "expenses", {})).auto_approve_threshold).toBe(999);
  });

  it("a write inside the request drops the memo, so the rest of it sees what it just wrote", async () => {
    await setThreshold(100);
    const scoped: Deps = { ...deps, refCache: makeRefCache() };
    await getSettingValue(scoped, "expenses", {});
    await deps.db.update(schema.settings).set({ value: JSON.stringify({ auto_approve_threshold: 999 }) }).where(eq(schema.settings.key, "expenses"));
    bustRef(scoped, "settings"); // what upsertSetting does after writing
    expect((await getSettingValue<{ auto_approve_threshold?: number }>(scoped, "expenses", {})).auto_approve_threshold).toBe(999);
  });

  it("without a request scope (a cron tick, a service called directly) every read is fresh", async () => {
    await deps.db.insert(schema.payComponents).values({ uuid: "pc1", code: "01-001", name: "HRA", kind: "earning" as const, method: "fixed" as const });
    expect((await refPayComponents(deps)).length).toBe(1);
    await deps.db.insert(schema.payComponents).values({ uuid: "pc2", code: "01-002", name: "Conveyance", kind: "earning" as const, method: "fixed" as const });
    expect((await refPayComponents(deps)).length).toBe(2);
  });
});

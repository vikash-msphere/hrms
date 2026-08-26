/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { changedSince } from "../src/services/changes";
import { listableCollectionsFor } from "../src/middleware/authz";
import { rulesToGrant, deriveNarrowing, type CompiledRule } from "../src/domain/compileGrants";

// "What has been written since I last looked" - the answer a client trusts its stored copies against. The
// property that matters is COMPLETENESS: a write this fails to report is a client serving stale rows and never
// finding out. So these tests write through the ordinary tables and assert the stamps followed, which is a test
// of the generated triggers as much as of the query.

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
  await deps.db.delete(schema.holidays);
  await deps.db.delete(schema.employees);
  await deps.db.delete(schema.collectionVersions);
});

const seedHoliday = async (name: string) => {
  const uuid = genId();
  await deps.db.insert(schema.holidays).values({ uuid, code: `h-${genId().slice(0, 5)}`, name, date: new Date("2099-01-01"), kind: "fixed" });
  return uuid;
};

// The stamps come from a clock inside SQLite, so a test that writes and immediately asks "changed since now?"
// races it. Every case here asks about a window that started comfortably before the write.
const AGO = 60_000;

describe("changes feed", () => {
  it("names a collection that was inserted into", async () => {
    const before = Date.now() - AGO;
    await seedHoliday("Diwali");
    const out = await changedSince(deps, before);
    expect(out.collections).toContain("holidays");
  });

  it("names it for an UPDATE and for a DELETE too, not just an insert", async () => {
    const id = await seedHoliday("Diwali");
    await deps.db.delete(schema.collectionVersions); // forget the insert's stamp
    await deps.db.update(schema.holidays).set({ name: "Deepavali" }).where(eq(schema.holidays.uuid, id));
    expect((await changedSince(deps, Date.now() - AGO)).collections).toContain("holidays");

    await deps.db.delete(schema.collectionVersions);
    await deps.db.delete(schema.holidays).where(eq(schema.holidays.uuid, id));
    expect((await changedSince(deps, Date.now() - AGO)).collections).toContain("holidays");
  });

  it("names only the collections that were actually written to", async () => {
    const before = Date.now() - AGO;
    await seedHoliday("Diwali");
    const out = await changedSince(deps, before);
    expect(out.collections).toEqual(["holidays"]); // employees was not touched, so it is not named
  });

  it("says nothing changed - an ANSWER, not a refusal - when the window is quiet", async () => {
    await seedHoliday("Diwali");
    const after = Date.now() + 1000; // everything already stamped is older than this
    const out = await changedSince(deps, after);
    expect(out.collections).toEqual([]);
    expect(out.now).toBeLessThanOrEqual(Date.now());
  });

  it("refuses to answer without a reference point, rather than claiming nothing changed", async () => {
    await seedHoliday("Diwali");
    // A first visit (nothing stored), or a nonsense value: the client must revalidate normally instead of
    // trusting copies this cannot speak for.
    expect((await changedSince(deps, 0)).collections).toBeNull();
    expect((await changedSince(deps, Number.NaN)).collections).toBeNull();
  });

  it("answers a copy from long ago as exactly as a recent one - the stamps are state, not history", async () => {
    await seedHoliday("Diwali");
    const weekAgo = Date.now() - 7 * 24 * 60 * 60_000;
    expect((await changedSince(deps, weekAgo)).collections).toContain("holidays");
  });
});

// The answer is collection NAMES, so "which names may this caller be told" is the whole access story. It is the
// same list decision a real GET /v1/<collection> gets, reduced to a boolean - so a caller learns nothing about
// a collection they could not have read for themselves.
describe("which collections a caller may be told about", () => {
  const rule = (pattern: string, level: "read" | "write" | null): CompiledRule => {
    const n = deriveNarrowing(pattern);
    return { namespace: n.namespace, pattern, scopeKind: n.scopeKind, scopeCode: n.scopeCode, matchCode: n.scopeKind === "exact" ? n.scopeCode : null, level, effect: "allow" };
  };
  const user = (patterns: string[]): AppUser =>
    ({ grant: rulesToGrant(patterns.map((p) => rule(p, "read"))), employeeCode: "04-001-001" }) as unknown as AppUser;

  it("names only what the caller may list", () => {
    const listable = listableCollectionsFor(user(["holidays", "leave-requests"]));
    expect(listable.has("holidays")).toBe(true);
    expect(listable.has("leave-requests")).toBe(true);
    expect(listable.has("payroll-runs")).toBe(false); // not granted -> never named
  });

  it("gives a caller with no grants nothing at all", () => {
    expect(listableCollectionsFor(user([])).size).toBe(0);
  });

  it("covers `settings`, which is cached like a collection but is not code-scoped", () => {
    expect(listableCollectionsFor(user(["settings"])).has("settings")).toBe(true);
    expect(listableCollectionsFor(user(["holidays"])).has("settings")).toBe(false);
  });
});

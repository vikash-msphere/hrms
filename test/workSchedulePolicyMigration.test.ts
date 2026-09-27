/// <reference types="vite/client" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Bindings } from "../src/env";
import { DEFAULT_POLICY } from "../bootstrap/authz/policy";

// Migration 0002 puts `work-pattern-assignments` into the LIVE policy row.
//
// THIS IS THE GAP THE REST OF THE SUITE CANNOT SEE. Every other test migrates from zero, where the bootstrap
// writes the whole manifest, so registering a collection in bootstrap/authz/policy.ts looks like it works
// everywhere. Production reads the ROW, and the row on a live database was written before this collection
// existed - the work schedules section of 0002 adds the tables and never touches it, and the policy manifest
// section deliberately leaves a COMPLETE row alone (test/policyManifestMigration.test.ts). So the only way the
// entries arrive is this section, and the only way that claim gets checked is by migrating a row that LACKS them.
//
// The owner ref is the half that matters: without it nothing binds a created assignment to the caller's own
// employee, so somebody could be put on a schedule they did not choose - which changes the days they are owed.
//
// 0002 carries several changes, one section each (a comment header, then its statements, then a blank line).
// Only this section is under test: every other migration, and the rest of 0002, is applied first.
const migrations = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const paths = Object.keys(migrations).sort();
const release = paths.find((p) => p.includes("0002_release_two"))!;
const whole = migrations[release]!;
const start = whole.indexOf("-- The policy manifest entries for `work-pattern-assignments`");
const end = whole.indexOf("\n\n-- ", start);
const section = whole.slice(start, end < 0 ? undefined : end);
const db = (env as unknown as Bindings).DB;

async function runSql(sql: string) {
  for (const stmt of sql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await db.prepare(s).run();
  }
}
const migrate = () => runSql(section);
const stored = async () => (await db.prepare("SELECT value_json FROM policy WHERE key = 'manifest'").first<{ value_json: string }>())?.value_json ?? null;
const parsed = async () => JSON.parse((await stored())!) as Record<string, Record<string, unknown>>;
async function setRow(json: string) {
  await db.prepare("DELETE FROM policy WHERE key = 'manifest'").run();
  await db.prepare("INSERT INTO policy (key, value_json, updated_at) VALUES ('manifest', ?, 0)").bind(json).run();
}

/** The manifest as a database predating work schedules held it: complete, but without this collection. */
function without(): string {
  const p = structuredClone(DEFAULT_POLICY) as unknown as Record<string, Record<string, unknown>>;
  for (const section of ["owner_refs", "references", "supported_scopes"]) delete p[section]!["work-pattern-assignments"];
  return JSON.stringify(p);
}

beforeAll(async () => {
  for (const p of paths.filter((p) => p !== release)) await runSql(migrations[p]!);
  await runSql(whole.slice(0, start) + whole.slice(start + section.length));
});
beforeEach(async () => {
  await db.prepare("DELETE FROM policy").run();
});

describe("migration 0002: work-pattern-assignments reaches the live manifest", () => {
  it("adds all three entries to a row that predates the collection", async () => {
    await setRow(without());
    await migrate();
    const p = await parsed();
    expect(p.owner_refs!["work-pattern-assignments"]).toEqual({ employee: { collection: "employees" } });
    expect(p.references!["work-pattern-assignments"]).toEqual({ pattern: { collection: "work-patterns", level: "read" } });
    expect(p.supported_scopes!["work-pattern-assignments"]).toEqual(["self", "reports", "org", "dept", "all"]);
  });

  it("changes nothing else about the row", async () => {
    const before = JSON.parse(without()) as Record<string, unknown>;
    await setRow(without());
    await migrate();
    const after = await parsed();
    for (const [section, value] of Object.entries(before)) {
      if (["owner_refs", "references", "supported_scopes"].includes(section)) continue;
      expect(after[section]).toEqual(value);
    }
    // And within the three sections it does touch, every other collection is untouched.
    for (const section of ["owner_refs", "references", "supported_scopes"] as const) {
      const wasSection = (before[section] ?? {}) as Record<string, unknown>;
      for (const [collection, value] of Object.entries(wasSection)) expect(after[section]![collection]).toEqual(value);
    }
  });

  it("is idempotent, and keeps an entry an admin has already edited", async () => {
    // An admin who narrowed the scope tiers by hand must not have it widened back by a re-run.
    const edited = JSON.parse(without()) as Record<string, Record<string, unknown>>;
    edited.supported_scopes!["work-pattern-assignments"] = ["self", "all"];
    await setRow(JSON.stringify(edited));
    await migrate();
    await migrate();
    const p = await parsed();
    expect(p.supported_scopes!["work-pattern-assignments"]).toEqual(["self", "all"]);
    // The two it did not hold are still added.
    expect(p.owner_refs!["work-pattern-assignments"]).toEqual({ employee: { collection: "employees" } });
  });

  it("leaves a row that already has all three byte-for-byte alone", async () => {
    const complete = JSON.stringify(DEFAULT_POLICY);
    await setRow(complete);
    await migrate();
    expect(await stored()).toBe(complete);
  });

  it("does not create a row where there is none (a fresh database gets it from the bootstrap)", async () => {
    await migrate();
    expect(await stored()).toBeNull();
  });
});

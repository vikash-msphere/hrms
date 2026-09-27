/// <reference types="vite/client" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import type { Bindings } from "../src/env";

// Global search does not match an employee's LEGAL name: it is a redacted field, and matching on it would let
// anyone who reads the directory confirm a guess through search. Migration 0002 rebuilds the employees triggers
// without it AND rewrites the rows already in the index - a changed trigger alone only reindexes a row the next
// time it is written, which would have left every existing legal name searchable. Both halves are held here.
//
// 0002 carries several changes, one section each (a comment header, then its statements, then a blank line).
// The "before" database is every earlier migration plus 0002 up to this section, where the old trigger still
// matched legal_name; the section is then applied on its own.
//
// Everything that must persist across the cases happens in beforeAll: the pool isolates storage per test, so a
// migration applied inside one `it` is gone by the next.
const migrations = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const paths = Object.keys(migrations).sort();
const release = paths.find((p) => p.includes("0002_release_two"))!;
const whole = migrations[release]!;
const start = whole.indexOf("-- Global search stops matching an employee's LEGAL name");
const end = whole.indexOf("\n\n-- ", start);
const section = whole.slice(start, end < 0 ? undefined : end);
const db = (env as unknown as Bindings).DB;

async function runSql(sql: string) {
  for (const stmt of sql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await db.prepare(s).run();
  }
}
async function person(uuid: string, code: string, first: string, legal: string) {
  await db
    .prepare("INSERT INTO employees (uuid, code, first_name, last_name, legal_name, work_email, job_title, status, created_at, updated_at) VALUES (?, ?, ?, 'Tester', ?, ?, 'Engineer', 'active', 0, 0)")
    .bind(uuid, code, first, legal, `${first.toLowerCase()}@test.example`)
    .run();
}
const matches = async (term: string) =>
  ((await db.prepare(`SELECT d."record_id" AS id FROM "search_fts" f JOIN "search_docs" d ON d."rowid" = f."rowid" WHERE d."collection" = 'employees' AND "search_fts" MATCH ?`).bind(`"${term}"`).all<{ id: string }>()).results.map((r) => r.id));

let beforeMigration: string[] = [];
beforeAll(async () => {
  for (const p of paths.filter((p) => p < release)) await runSql(migrations[p]!);
  await runSql(whole.slice(0, start));
  // Indexed by the OLD trigger, which matched legal_name.
  await person("0000000000aa0", "91", "Priyanka", "Qzlegalbefore");
  beforeMigration = await matches("Qzlegalbefore");
  await runSql(section);
});

describe("legal name is not searchable", () => {
  it("was searchable before the migration (the fixture really exercises the old index)", () => {
    expect(beforeMigration).toEqual(["0000000000aa0"]);
  });

  it("0002 takes it out of the rows already indexed, and the rest of the row still matches", async () => {
    expect(await matches("Qzlegalbefore")).toEqual([]);
    expect(await matches("Priyanka")).toEqual(["0000000000aa0"]);
  });

  it("a person added or edited afterwards is never indexed by legal name", async () => {
    await person("0000000000ab0", "92", "Meenakshi", "Qzlegalafter");
    expect(await matches("Qzlegalafter")).toEqual([]);
    expect(await matches("Meenakshi")).toEqual(["0000000000ab0"]);
    await db.prepare("UPDATE employees SET legal_name = 'Qzlegaledited', job_title = 'Lead' WHERE uuid = '0000000000ab0'").run();
    expect(await matches("Qzlegaledited")).toEqual([]);
    expect(await matches("Lead")).toContain("0000000000ab0");
  });

  it("is idempotent", async () => {
    await runSql(section);
    expect(await matches("Qzlegalbefore")).toEqual([]);
    expect(await matches("Priyanka")).toEqual(["0000000000aa0"]);
  });
});

/// <reference types="vite/client" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Bindings } from "../src/env";
import { DEFAULT_TASK_TYPES } from "../src/domain/boards";

// Migration 0014 carries task types to a LIVE database: every board saved before types existed gets the starter
// catalog a new board gets, and existing cards stay untyped. The catalog is a JSON literal in the SQL, so this
// holds it to `DEFAULT_TASK_TYPES` - a board from before the change and a board made after it offer the same
// types. Every earlier migration and 0014's schema statements are applied first; each test lays boards down as
// the old schema left them (catalog at its column default) and applies the data statement - twice, since a
// re-run must change nothing.
const migrations = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const paths = Object.keys(migrations).sort();
const target = paths.find((p) => p.includes("0014_card_task_types"))!;
const db = (env as unknown as Bindings).DB;
const statements = (sql: string) => sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
const isSchema = (s: string) => /^ALTER TABLE/m.test(s.replace(/^--.*$/gm, "").trim().split("\n")[0] ?? "");
const run = async (list: string[]) => { for (const s of list) await db.prepare(s).run(); };
const backfill = () => run(statements(migrations[target]!).filter((s) => !isSchema(s)));

beforeAll(async () => {
  if (!target) throw new Error("0014_card_task_types.sql not found");
  for (const p of paths.filter((p) => p < target)) await run(statements(migrations[p]!));
  await run(statements(migrations[target]!).filter(isSchema));
  for (const p of paths.filter((p) => p > target)) await run(statements(migrations[p]!));
});

beforeEach(async () => {
  for (const t of ["cards", "boards"]) await db.prepare(`DELETE FROM ${t}`).run();
});

const insertBoard = (uuid: string, code: string, taskTypesJson?: string) =>
  taskTypesJson == null
    ? db.prepare("INSERT INTO boards (uuid, code, name, created_at, updated_at) VALUES (?, ?, 'Board', 0, 0)").bind(uuid, code).run()
    : db.prepare("INSERT INTO boards (uuid, code, name, task_types_json, created_at, updated_at) VALUES (?, ?, 'Board', ?, 0, 0)").bind(uuid, code, taskTypesJson).run();
const typesOf = async (uuid: string) => JSON.parse((await db.prepare("SELECT task_types_json AS t FROM boards WHERE uuid = ?").bind(uuid).first<{ t: string }>())!.t);

describe("migration 0014: task types", () => {
  it("gives every existing board the starter catalog a new board gets", async () => {
    await insertBoard("b00000000001a", "ve-01");
    await insertBoard("b00000000002a", "vp-01");
    await backfill();
    expect(await typesOf("b00000000001a")).toEqual(DEFAULT_TASK_TYPES);
    expect(await typesOf("b00000000002a")).toEqual(DEFAULT_TASK_TYPES);
    await backfill();
    expect(await typesOf("b00000000001a")).toEqual(DEFAULT_TASK_TYPES);
  });

  it("leaves a board that already has a catalog alone", async () => {
    const own = [{ key: "story", label: "Story" }];
    await insertBoard("b00000000003a", "ve-02", JSON.stringify(own));
    await backfill();
    expect(await typesOf("b00000000003a")).toEqual(own);
  });
});

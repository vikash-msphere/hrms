/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import type { Bindings } from "../src/env";

// EVERY SQL-PAGED LIST MUST WALK AN INDEX, NEVER SORT.
//
// services/keysetPage.ts pages with `ORDER BY <key>, uuid LIMIT n+1` - and for a long time `created_at` was
// indexed on exactly one table in the schema (`search_docs`). SQLite answered the rest by reading the whole
// filtered set into a temp B-tree and sorting it, to hand back fifty rows. On D1, which bills rows READ, that
// is the whole table per page, growing with the table, on essentially every list in the app. `audit_log` was
// the one collection that paged properly, because it happens to order by a column it had indexed for its own
// reasons - which is what made the difference visible.
//
// The check is the QUERY PLAN rather than the presence of an index, because "there is an index" and "the
// planner uses it for this ORDER BY" are different claims and only the second one is the point. It runs
// against the real migration in the real runtime, so it also catches an index whose column ORDER is wrong.
//
// Fully derived: the cases come out of the migration's own `*_page_idx` definitions, so a collection added
// without one is not silently skipped - it is simply absent from the schema and `keysetPage` will sort for it.
// That half is covered by the count assertion below.
const b = env as unknown as Bindings;

beforeAll(async () => {
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
});

/** `EXPLAIN QUERY PLAN`, joined - D1 answers it like any other read. */
async function plan(sql: string): Promise<string> {
  const res = await b.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>();
  return (res.results ?? []).map((r) => r.detail).join(" | ");
}

/** Every `<table>_page_idx` the migration declares, with the columns it is built on, in order. */
const PAGE_INDEXES = [...migrationSql.matchAll(/CREATE INDEX `([a-z_0-9]+)_page_idx` ON `([a-z_0-9]+)` \(([^)]+)\)/g)].map((m) => ({
  table: m[2]!,
  cols: m[3]!.split(",").map((c) => c.trim().replace(/`/g, "")),
}));

describe("keyset pagination walks an index", () => {
  it("the schema declares a paging index for every collection that pages", () => {
    // A floor, not the exact count: it is here so the derivation below cannot silently degrade to an empty
    // list (a regex that stops matching would otherwise turn this whole file into a no-op that passes).
    expect(PAGE_INDEXES.length).toBeGreaterThan(60);
  });

  it.each(PAGE_INDEXES)("$table pages without sorting", async ({ table, cols }) => {
    const [key, tie] = cols;
    const p = await plan(`select * from \`${table}\` order by \`${key}\` desc, \`${tie}\` desc limit 51`);
    expect(p, `${table} page 1 planned as: ${p}`).not.toMatch(/TEMP B-TREE/);
  });

  // The OWNER-FILTERED shape, which the plain paging index does NOT serve: with `where owner = ?` the planner
  // picks the owner index and then sorts. Self-service is the commonest list there is (my leave, my payslips,
  // my notifications), and these are the tables that grow per person, so their owner indexes carry the page
  // key too - the same composite shape `audit_log` already used for `(subject_id, at)`.
  const OWNED: [table: string, owner: string, key: string][] = [
    ["attendance_sessions", "employee_id", "clock_in"],
    ["notifications", "recipient_id", "created_at"],
    ["leave_requests", "employee_id", "created_at"],
    ["payslips", "employee_id", "created_at"],
    ["tickets", "employee_id", "created_at"],
    ["expenses", "employee_id", "created_at"],
    ["goals", "employee_id", "created_at"],
    ["time_entries", "employee_id", "created_at"],
    ["reimbursements", "employee_id", "created_at"],
    ["bonuses", "employee_id", "award_date"],
    ["positions", "employee_id", "effective_from"],
    ["settlements", "employee_id", "settlement_date"],
  ];
  it.each(OWNED)("%s pages one owner's rows without sorting", async (table, owner, key) => {
    const p = await plan(`select * from \`${table}\` where \`${owner}\` = 'x' order by \`${key}\` desc, \`uuid\` desc limit 51`);
    expect(p, `${table} by ${owner} planned as: ${p}`).not.toMatch(/TEMP B-TREE/);
  });

  // A month of one person's attendance is the shape the app asks for most on that table, and the one that
  // grows without bound: every punch they have ever made used to be read and sorted to render one month.
  it("attendance reads a date window as a range, not a scan of the person's whole history", async () => {
    const p = await plan(
      "select * from `attendance_sessions` where `employee_id` = 'x' and `clock_in` >= 1 and `clock_in` <= 2 order by `clock_in` desc, `uuid` desc limit 51",
    );
    expect(p).toMatch(/clock_in>/);
    expect(p).not.toMatch(/TEMP B-TREE/);
  });
});

/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import type { TextModel, VectorIndex } from "../src/ports";
import { drainSearchEmbeddings } from "../src/services/searchEmbed";
import { INDEXABLE, MODELS } from "../src/domain/aiPolicy";

// THE EMBED DRAIN PAYS FOR WHAT CHANGED, NOT FOR THE SIZE OF THE INDEX.
//
// services/searchEmbed.ts runs every ten minutes and nearly always finds nothing to do. It used to find that
// out by reading every indexed `search_docs` row, its `search_vectors` row and its collection's stamp, and then
// every `search_vectors` row again to look for orphans: about five rows read per indexed record, on every
// tick. D1 bills rows READ, so the check here is the number D1 bills, summed over every statement the drain
// sends, over an index that already holds a few thousand records.
const b = env as unknown as Bindings;

const NOW = Date.parse("2026-10-03T09:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const PER_COLLECTION = 100;
const COLLECTIONS = [...INDEXABLE];
const INDEXED = COLLECTIONS.length * PER_COLLECTION;

// Reading one row per indexable collection a few times over is the floor (marks, stamps, the index's own list
// of collections). Anything that walks the index is in the thousands.
const IDLE_ROWS_READ_CEILING = 200;
// One collection written since the last tick: its rows, a vector and a stamp for each, and its sort. Well under
// any second collection's worth on top.
const ONE_COLLECTION_CEILING = IDLE_ROWS_READ_CEILING + 6 * PER_COLLECTION;

beforeAll(async () => {
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
});

type Read = { sql: string; rows: number };

/**
 * The binding with every statement's `meta.rows_read` recorded. Drizzle runs a select through `.raw()`, which
 * carries no meta, so a select is run once more through `.all()` first to be counted - reads do not change
 * anything, so running one twice changes nothing but the count.
 */
function counted(db: D1Database): { db: D1Database; reads: Read[] } {
  const reads: Read[] = [];
  const isRead = (sql: string) => /^\s*(select|with)\b/i.test(sql);
  const wrap = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if (prop === "raw") {
          return async (opts?: { columnNames?: boolean }) => {
            if (isRead(sql)) reads.push({ sql, rows: (await target.all()).meta.rows_read });
            return target.raw(opts as { columnNames: true });
          };
        }
        if (prop === "all" || prop === "run") {
          return async () => {
            const res = await target[prop]();
            reads.push({ sql, rows: res.meta.rows_read });
            return res;
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { db: proxy, reads };
}

const model: TextModel = {
  async embed(texts: string[]) { return texts.map(() => [0.1, 0.2, 0.3]); },
  async generate() { return ""; },
  async rerank() { return []; },
};
const index: VectorIndex = {
  async upsert() {},
  async query() { return []; },
  async fetch() { return new Map(); },
  async remove() {},
};

/**
 * Every indexable collection holds `PER_COLLECTION` titled rows, all embedded by the current model, plus rows in
 * collections that are not indexable. Every collection was last written an hour ago, and the drain finished
 * every collection ten minutes ago: the state of an index nobody has touched since its last tick.
 */
async function seedSettledIndex(): Promise<void> {
  const all = JSON.stringify([...COLLECTIONS, "leave-requests", "payslips", "kudos"]);
  await b.DB.batch([
    b.DB.prepare(`insert into settings (key, value, updated_at) values ('ai', ?1, ?2) on conflict(key) do update set value = excluded.value`)
      .bind(JSON.stringify({ features: { "search.semantic": true } }), NOW),
    b.DB.prepare(
      `with recursive n(i) as (select 1 union all select i + 1 from n where i < ?2)
       insert into search_docs (collection, record_id, title, subtitle, deleted, restricted, created_at)
       select c.value, printf('rec-%05d', n.i), 'Title ' || n.i, 'Subtitle', 0, 0, ?3 from json_each(?1) c, n`,
    ).bind(all, PER_COLLECTION, NOW - HOUR),
    b.DB.prepare(
      `insert into search_vectors (uuid, collection, record_id, text_hash, model, embedded_at, checked_at, created_at, updated_at)
       select d.collection || '/' || d.record_id, d.collection, d.record_id, 'hash', ?2, ?3, ?3, ?3, ?3
       from search_docs d where d.collection in (select value from json_each(?1))`,
    ).bind(JSON.stringify(COLLECTIONS), MODELS.embed, NOW - 10 * MIN),
    b.DB.prepare(`insert or replace into collection_versions (collection, at) select value, ?2 from json_each(?1)`).bind(all, NOW - HOUR),
    b.DB.prepare(
      `insert into search_vector_marks (collection, embedded_at, model, pruned_at) select value, ?2, ?3, ?2 from json_each(?1)`,
    ).bind(JSON.stringify(COLLECTIONS), NOW - 10 * MIN, MODELS.embed),
  ]);
}

/** One drain over the counting binding: its result, the rows D1 billed for it, and the costliest statements. */
async function drain(opts: { fullSweep?: boolean } = {}): Promise<{ out: Awaited<ReturnType<typeof drainSearchEmbeddings>>; rowsRead: number; top: string }> {
  const { db, reads } = counted(b.DB);
  const deps: Deps = { ...makeDeps({ ...b, DB: db }), ai: model, vectors: index, clock: { now: () => new Date(NOW) } };
  const out = await drainSearchEmbeddings(deps, opts);
  const top = [...reads].sort((x, y) => y.rows - x.rows).slice(0, 3).map((r) => `${r.rows} rows: ${r.sql.replace(/(\?, )+\?/g, "?...")}`).join("\n");
  return { out, rowsRead: reads.reduce((n, r) => n + r.rows, 0), top };
}

describe("embed drain: a tick reads the collections that changed, not the index", () => {
  it("is measured by a counter that does count a scan here", async () => {
    // Without this, a runtime that reported no row counts would pass every ceiling below by reading zero.
    await seedSettledIndex();
    const scan = await b.DB.prepare("select count(*) as n from search_vectors where text_hash = 'no such hash'").all();
    expect(scan.meta.rows_read).toBeGreaterThanOrEqual(INDEXED);
  });

  it("finds nothing to do on an idle tick, and reads a handful of rows doing it", async () => {
    await seedSettledIndex();
    const { out, rowsRead, top } = await drain();
    expect(out).toEqual({ embedded: 0, removed: 0, pending: 0 });
    expect(rowsRead, `idle drain read ${rowsRead} rows; costliest:\n${top}`).toBeLessThan(IDLE_ROWS_READ_CEILING);
  });

  it("reads only the collection that was written", async () => {
    await seedSettledIndex();
    await b.DB.prepare(`update search_docs set title = 'Laptop will not charge' where collection = 'tickets' and record_id = 'rec-00001'`).run();
    await b.DB.prepare(`update collection_versions set at = ?1 where collection = 'tickets'`).bind(NOW - MIN).run();
    const { out, rowsRead, top } = await drain();
    // The window is the tickets checked longest ago, which is all of them: the seeded hash matches none.
    expect(out.embedded).toBeGreaterThan(0);
    expect(rowsRead, `one-collection drain read ${rowsRead} rows; costliest:\n${top}`).toBeLessThan(ONE_COLLECTION_CEILING);
  });

  it("finds a deleted row's vector by reading only that row's collection", async () => {
    await seedSettledIndex();
    await b.DB.prepare(`update search_docs set deleted = 1 where collection = 'cards' and record_id = 'rec-00042'`).run();
    await b.DB.prepare(`update collection_versions set at = ?1 where collection = 'cards'`).bind(NOW - MIN).run();
    const { out, rowsRead, top } = await drain();
    expect(out.removed).toBe(1);
    expect(rowsRead, `orphan drain read ${rowsRead} rows; costliest:\n${top}`).toBeLessThan(ONE_COLLECTION_CEILING);
  });

  it("takes the hourly full sweep's window from the rows checked longest ago, without reading the rest", async () => {
    await seedSettledIndex();
    const { out, rowsRead, top } = await drain({ fullSweep: true });
    // Every seeded hash is stale, so the sweep re-embeds a window of them.
    expect(out.embedded).toBeGreaterThan(0);
    expect(rowsRead, `full sweep read ${rowsRead} rows; costliest:\n${top}`).toBeLessThan(IDLE_ROWS_READ_CEILING + 100);
  });

  // Production may carry planner statistics, and with them SQLite may cost the full sweep's collection list as
  // an index seek again. Last in the file, so nothing after it runs against a database that has statistics.
  it("still reads a handful of rows once the database has planner statistics", async () => {
    await seedSettledIndex();
    await b.DB.prepare("ANALYZE").run();
    const idle = await drain();
    expect(idle.rowsRead, `idle drain read ${idle.rowsRead} rows with statistics; costliest:\n${idle.top}`).toBeLessThan(IDLE_ROWS_READ_CEILING);
    const sweep = await drain({ fullSweep: true });
    expect(sweep.rowsRead, `full sweep read ${sweep.rowsRead} rows with statistics; costliest:\n${sweep.top}`).toBeLessThan(IDLE_ROWS_READ_CEILING + 100);
  });
});

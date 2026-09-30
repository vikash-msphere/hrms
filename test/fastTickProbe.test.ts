/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import type { Bindings } from "../src/env";
import { fastTickProbe } from "../src/cron";

// THE FAST TICK'S PROBE PAYS FOR WHAT IT FINDS, NOT FOR THE HISTORY AROUND IT.
//
// cron.ts `fastTickProbe` runs every five minutes and nearly always finds nothing, which is exactly when an EXISTS
// reads every row its plan can reach. D1 bills rows READ, so the check here is the number D1 bills: `meta.rows_read`
// for the shipped statement, over a database that already holds history (finished runs, published posts, finished
// and delayed jobs) and a near-miss for every check. The partial indexes in db/schema.ts are what keep that number
// small. A probe term that stops matching its index, or an index that stops matching the probe, shows up here as a
// row count that grows with the history.
const b = env as unknown as Bindings;
const dialect = new SQLiteSyncDialect();

beforeAll(async () => {
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
});

const NOW = Date.parse("2026-09-30T09:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Well under the history seeded below (500 finished runs, 305 board rows, 321 jobs) and well over what the index
// seeks touch, so a probe that walks any one table's history cannot pass.
const IDLE_ROWS_READ_CEILING = 20;

/** What surrounds an idle tick: history the probe must not read, and one near-miss for every check it makes. */
async function seedHistory(): Promise<void> {
  await b.DB.batch([
    // Finished runs, every one more than an hour old: the history the stuck-run check steps over.
    b.DB.prepare(
      `with recursive n(i) as (select 1 union all select i + 1 from n where i < 500)
       insert into cron_runs (uuid, code, cron, status, started_at, finished_at, created_at, updated_at)
       select 'run-' || i, 'run-' || i, '*/5 * * * *', 'done', ?1 - ?2 - i * ?3, ?1 - ?2 - i * ?3 + 900, ?1 - ?2 - i * ?3, ?1 - ?2 - i * ?3 from n`,
    ).bind(NOW, HOUR, 5 * MIN),
    // The tick running now, and a slow run that started half an hour ago: in flight, not stuck.
    b.DB.prepare(
      `insert into cron_runs (uuid, code, cron, status, started_at, created_at, updated_at) values
       ('run-now', 'run-now', '*/5 * * * *', 'running', ?1, ?1, ?1),
       ('run-slow', 'run-slow', '0 2 * * *', 'running', ?1 - ?2, ?1 - ?2, ?1 - ?2)`,
    ).bind(NOW, 30 * MIN),
    // The board.
    b.DB.prepare(
      `with recursive n(i) as (select 1 union all select i + 1 from n where i < 300)
       insert into announcements (uuid, code, kind, title, body, created_at, updated_at)
       select 'post-' || i, 'post-' || i, 'post', 'Post ' || i, 'Body ' || i, ?1 - i * ?2, ?1 - i * ?2 from n`,
    ).bind(NOW, HOUR),
    // Drafts the publish loop would not put out: scheduled for tomorrow, never scheduled, deleted after their time
    // came, held by moderation, and disabled after their time came.
    b.DB.prepare(
      `insert into announcements (uuid, code, title, body, published, publish_time, delete_time, held_at, disabled, created_at, updated_at) values
       ('draft-later', 'draft-later', 'Later', 'b', 0, ?1 + ?2, null, null, 0, ?1, ?1),
       ('draft-unscheduled', 'draft-unscheduled', 'Someday', 'b', 0, null, null, null, 0, ?1, ?1),
       ('draft-deleted', 'draft-deleted', 'Deleted', 'b', 0, ?1 - ?3, ?1 - ?3, null, 0, ?1, ?1),
       ('draft-held', 'draft-held', 'Held', 'b', 0, ?1 - ?3, null, ?1 - ?3, 0, ?1, ?1),
       ('draft-disabled', 'draft-disabled', 'Disabled', 'b', 0, ?1 - ?3, null, null, 1, ?1, ?1)`,
    ).bind(NOW, DAY, HOUR),
    // Finished jobs.
    b.DB.prepare(
      `with recursive n(i) as (select 1 union all select i + 1 from n where i < 300)
       insert into jobs (uuid, code, kind, payload, status, created_at, updated_at)
       select 'done-' || i, 'done-' || i, 'automation.action', '{}', 'done', ?1 - i * ?2, ?1 - i * ?2 from n`,
    ).bind(NOW, HOUR),
    // Jobs queued behind a delay that runs out hours from now: workflow timers, retry backoffs.
    b.DB.prepare(
      `with recursive n(i) as (select 1 union all select i + 1 from n where i < 20)
       insert into jobs (uuid, code, kind, payload, status, run_after, created_at, updated_at)
       select 'later-' || i, 'later-' || i, 'workflow.timer', '{}', 'queued', ?1 + i * ?2, ?1, ?1 from n`,
    ).bind(NOW, HOUR),
    // A job running right now, which touched its row a minute ago: busy, not stale.
    b.DB.prepare(
      `insert into jobs (uuid, code, kind, payload, status, created_at, updated_at) values ('busy', 'busy', 'payslip.generateRun', '{}', 'running', ?1 - ?2, ?1 - ?2)`,
    ).bind(NOW, MIN),
  ]);
}

type Flags = { announcements: number; jobs: number; stuckRuns: number };

/** The shipped probe, run the way D1 runs it: its flags, the rows D1 bills for it, and its plan for a failure message. */
async function probe(): Promise<{ flags: Flags; rowsRead: number; plan: string }> {
  const q = dialect.sqlToQuery(fastTickProbe(NOW));
  const res = await b.DB.prepare(q.sql).bind(...q.params).all<Flags>();
  const plan = await b.DB.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).bind(...q.params).all<{ detail: string }>();
  return { flags: res.results[0]!, rowsRead: res.meta.rows_read, plan: plan.results.map((r) => r.detail).join(" | ") };
}

const IDLE: Flags = { announcements: 0, jobs: 0, stuckRuns: 0 };

describe("fast-tick probe: an idle tick reads only the rows it asks about", () => {
  it("is measured by a counter that does count a scan here", async () => {
    // Without this, a runtime that reported no row counts would pass the ceiling below by reading zero.
    await seedHistory();
    const scan = await b.DB.prepare("select count(*) as n from announcements where title = 'no such post'").all();
    expect(scan.meta.rows_read).toBeGreaterThanOrEqual(300);
  });

  it("finds nothing to do, and reads a handful of rows doing it", async () => {
    await seedHistory();
    const { flags, rowsRead, plan } = await probe();
    expect(flags).toEqual(IDLE);
    expect(rowsRead, `probe read ${rowsRead} rows, planned as: ${plan}`).toBeLessThan(IDLE_ROWS_READ_CEILING);
  });

  // The flags are what the fast tick acts on: each must turn on for the row its subtask would pick up, on top of
  // the history and near-misses above, and turn on nothing else.
  const DUE: [what: string, flag: keyof Flags, insert: string, at: number][] = [
    ["a draft whose time has come", "announcements",
      "insert into announcements (uuid, code, title, body, published, publish_time, created_at, updated_at) values ('draft-due', 'draft-due', 'Due', 'b', 0, ?1, ?1, ?1)",
      NOW - MIN],
    ["a queued job with no delay", "jobs",
      "insert into jobs (uuid, code, kind, payload, status, created_at, updated_at) values ('asap', 'asap', 'automation.action', '{}', 'queued', ?1, ?1)",
      NOW],
    ["a queued job whose delay has run out", "jobs",
      "insert into jobs (uuid, code, kind, payload, status, run_after, created_at, updated_at) values ('ready', 'ready', 'workflow.timer', '{}', 'queued', ?1, ?1, ?1)",
      NOW - MIN],
    ["a job left running past the stale cutoff", "jobs",
      "insert into jobs (uuid, code, kind, payload, status, created_at, updated_at) values ('orphan', 'orphan', 'automation.action', '{}', 'running', ?1, ?1)",
      NOW - 11 * MIN],
    ["a run still running an hour after it started", "stuckRuns",
      "insert into cron_runs (uuid, code, cron, status, started_at, created_at, updated_at) values ('killed', 'killed', '*/5 * * * *', 'running', ?1, ?1, ?1)",
      NOW - 61 * MIN],
  ];
  it.each(DUE)("sees %s as %s work, and nothing else", async (_what, flag, insert, at) => {
    await seedHistory();
    await b.DB.prepare(insert).bind(at).run();
    const { flags } = await probe();
    expect(flags).toEqual({ ...IDLE, [flag]: 1 });
  });

  // Production may carry planner statistics, and with them SQLite costs a lookup by the AVERAGE rows per key: a
  // `status` index over a table of mostly finished jobs looks no better than a scan. Last in the file, so nothing
  // after it runs against a database that has statistics.
  it("still reads a handful of rows once the database has planner statistics", async () => {
    await seedHistory();
    await b.DB.prepare("ANALYZE").run();
    const { flags, rowsRead, plan } = await probe();
    expect(flags).toEqual(IDLE);
    expect(rowsRead, `probe read ${rowsRead} rows with statistics, planned as: ${plan}`).toBeLessThan(IDLE_ROWS_READ_CEILING);
  });
});

# Fast-tick probe: stop the idle tick reading whole tables

## Context

`fastTickWork` (src/cron.ts:72) runs on every `*/5` tick (288 times a day). It was added in 4cfae88 (2026-09-30) so
idle ticks skip their subtasks. It is one statement with three `EXISTS` checks. `EXISTS` stops at the first
matching row. But on an idle tick, the case the probe is for, nothing matches. So each `EXISTS` reads every row
its plan can reach.

I checked this with `EXPLAIN QUERY PLAN` + `.scanstats on` in an in-memory sqlite3 built from migrations 0000-0005.
The test data looked like an idle production tick: 3,001 cron runs, 405 board rows, 1,540 jobs (40 of them queued
with a future `run_after`).

| branch | plan today | rows visited (idle) | why |
|---|---|---|---|
| `cron_runs` stuck runs | `SEARCH cron_runs USING INDEX cron_runs_started_idx (started_at<?)` | 2,980 / 3,001, plus a row fetch each to test `status` | No index has `status`. `started_at < now-1h` matches every run except the last hour. The table gains 577 rows a day (288 fast + 288 AI + 1 nightly) and is never pruned. **New in 4cfae88, so this is the cost that just showed up. It is the biggest one and it keeps growing.** |
| `announcements` due drafts | `SCAN announcements` | 405 / 405 | The only index is `announcements_code_unique`. `publishDueAnnouncements` has used this same predicate every tick since b6ed9e5 (2026-08-04), and the probe kept that scan. |
| `jobs` queued/stale | `MULTI-INDEX OR` on `jobs_status_idx` | 40 / 40 (every queued job, even ones delayed for days) | `run_after IS NULL OR run_after <= ?` cannot bound an index range. **With planner statistics (`ANALYZE`) the plan becomes `SCAN jobs`: 1,540 / 1,540**, because stat1 averages rows per status and `done` rows dominate. |

Estimate: the cron_runs branch alone adds about 577 rows per probe per day (×2 if D1 also counts the row fetch).
That is +166k to 332k rows read per day, every day, against the free plan's 5M rows read per day.

Result, checked in the same harness **both without and with ANALYZE**: every branch visits **0 rows** on an idle
tick, and the flags still turn on correctly (idle `0|0|0`, and each flag flips for its own due row).

## Changes

0. Copy this plan to `<repo>/fast-tick-probe-plan.md` (the user keeps plans in the project root).

1. **`src/db/schema.ts`**: three partial indexes, each holding only the rows one probe branch asks about. Follow
   the existing `.where(sql\`...\`)` style (`roles_one_provisioned`, `ladj_opening_idx`), with a comment above each.
   - `announcements` (it has no index block yet, so add the third `sqliteTable` argument):
     `dueIdx: index("announcements_due_idx").on(t.publishTime).where(sql\`${t.published} = 0 and ${t.deleteTime} is null and ${t.heldAt} is null\`)`
     This holds only live drafts. Use literal `0` because the probe writes `= 0`. Drizzle's bound `eq(published, false)` in
     `publishDueAnnouncements` also matches it (checked).
   - `cron_runs`: `runningIdx: index("cron_runs_running_idx").on(t.startedAt).where(sql\`${t.status} = 'running'\`)`
     This holds only in-flight runs and covers the probe query. `reclaimStuckCronRuns` uses it too.
   - `jobs`: `queuedIdx: index("jobs_queued_idx").on(t.status, t.runAfter).where(sql\`${t.status} = 'queued'\`)`.
     Every row in the index has the same `status`, but the column still has to lead. Without statistics, SQLite
     prefers `jobs_status_idx` for `status = ?` unless another index constrains more columns. A `(run_after)`-only
     version lost to it and read 40 + 40 rows.
   - **Keep `jobs_status_idx`.** Without it, `drainJobs` (ORDER BY created_at LIMIT 20) walked `jobs_page_idx`
     over the whole table when there were no statistics (1,540 rows).

2. **Migration**: add a new `0006`, not a fold into 0005. `0005_release_five` shipped with the probe that is
   running in prod.
   - Run `ls src/db/migrations` first, in case another session already took 0006.
   - Run `npx drizzle-kit generate --name=fast_tick_probe_indexes`, then the two check scripts that `db:generate` chains:
     `node --import ./scripts/tsResolve.mjs scripts/genSearchDdl.ts` and `scripts/genChangeDdl.ts`.
   - The output must be exactly 3 `CREATE INDEX` statements. Anything else is unrelated schema drift: stop and report it.
   - Prepend a `-- ` header comment (house convention, see 0005). Wrangler strips comments before it splits.
   - Re-run `npm run db:generate` and expect "No schema changes".
   - D1 builds each index with a single read of its table at migrate time.

3. **`src/cron.ts`**:
   - Move the statement into `export function fastTickProbe(now: number): SQL`. `fastTickWork` calls it, and the
     test uses the same builder, so it tests the shipped query rather than a copy.
   - Split the jobs check into three `EXISTS`, joined with `or` into the one `jobs` column:
     queued with `run_after is null` / queued with `run_after <= now` / `running` with `updated_at < now - STALE_RUNNING_MS`.
     This is the same logic as `drainJobs` + `reclaimStuckJobs`. Each `EXISTS` is planned on its own, so one
     expensive branch cannot turn the whole check into a table scan.
   - Rewrite the doc comment to match: each check is answered from a partial index that holds only the rows it asks
     about (name the three), so an idle tick costs about the same however much history the tables hold. Give the
     one-line reason for the jobs split.

4. **`test/fastTickProbe.test.ts`** (new). Use the migration `beforeAll` from test/listIndexes.test.ts and the
   `SQLiteSyncDialect().sqlToQuery` rendering from test/listScope.test.ts. Run it through `b.DB.prepare(sql).bind(...params).all()`
   so the test can read `meta.rows_read`.
   - Test data (one `WITH RECURSIVE` insert per table, inside each `it`, because storage rolls back per test):
     - 500 finished cron runs more than 1h old, plus one `running` run started now.
     - 300 published posts, plus these drafts: one scheduled for later, one with no time set, one soft-deleted
       with a past time, one held with a past time.
     - 300 done jobs, 20 queued jobs delayed into the future, and one running job with a fresh `updated_at`.
   - Control check: a deliberate full scan over the same data reports `rows_read >= 300`. This proves the counter
     works in this runtime. (globalSearch.test.ts's `?? 0` would pass even if the counter never ran.)
   - Idle probe: all three flags are 0 and `rows_read < 20`. The failure message includes the EXPLAIN QUERY PLAN text.
     Repeat after `ANALYZE`, since prod may have statistics. If local D1 refuses `ANALYZE`, drop that case and say so.
   - Correctness: each flag turns on for the row its subtask would take: a due draft; a queued job with a null or
     past `run_after`; a running job stale past 10 min; a cron run `running` for more than 1h. Each flag stays off for
     the near-misses listed in the test data.

**Write cost:** a partial index only takes writes for rows inside it:
- cron_runs: +2 index writes per tick (the row enters on insert and leaves on finish). About 1,150 rows written per day, against a 100k-a-day allowance.
- jobs: +2 per job lifecycle.
- announcements: draft rows only.

**Not doing:**
- `ANALYZE` / `PRAGMA optimize`. Statistics would change plans across the whole app; the jobs full scan above is one example.
- cron_runs retention. With the index, the probe's cost no longer depends on the table's size.

## Verification

1. `./node_modules/.bin/tsc --noEmit; echo $?` (don't trust the filtered stdout).
2. `npm run db:generate` prints "No schema changes" and both DDL checks pass.
3. vitest needs a sandbox bypass: ask first. Run:
   `npx vitest run test/fastTickProbe.test.ts test/jobQueue.test.ts test/announcementDraft.test.ts test/moderation.test.ts test/listIndexes.test.ts test/searchDdlDrift.test.ts test/changeDdlDrift.test.ts test/scheduledAutomations.test.ts`
   Then run `npm run test:gate` for the full suite.
4. Prod check, read-only (the user runs it, or I run it with an explicit OK): after deploy,
   `npx wrangler d1 execute hrms --remote --command "EXPLAIN QUERY PLAN <probe>"`. Expect three `SEARCH ... USING
   (COVERING) INDEX` lines naming `announcements_due_idx`, `jobs_queued_idx` and `cron_runs_running_idx`, and no `SCAN`.
   D1 insights (dashboard or `wrangler d1 insights hrms --sort-by=reads`) should show rows read per run dropping to single digits.

## Part 2: `cron_runs` writes (approved 2026-09-30)

**Context.** The `cron_runs` insert was D1's top writer: ~1.2k rows in 6 hours. Production registers three
triggers (288 fast + 288 AI + 1 nightly a day), and every tick was recorded, idle or not. Each insert writes
about 8 rows: the table row, 5 index entries, and the `cron-runs` change-stamp upsert on `collection_versions`
(its row plus its `at` index). Add the finish update and the code counter and a tick costs about 12 writes.
Recording idle ticks had three side effects:
- Every list ETag is keyed on the global max stamp (`http/listEtag.ts`), so each tick invalidated all of them.
- The Operations page took each card's "Last run" from the newest 100 rows. That covers about 4 hours, so the
  Nightly card read "Never run" for most of the day.
- The table grew without bound.

**Changes.**
1. `src/cron.ts` `runScheduled`: a fast tick asks the probe first and records nothing when it finds no work.
   - A failed probe counts as work.
   - The probe answer is passed on to `dispatchCron`, so the probe runs once per tick.
   - A manual `cron-runs:run` is always recorded.
   - The probe also leaves out disabled drafts, which the publish loop skips anyway. Otherwise one disabled
     past-due draft would make every tick record itself.
2. `cron_runs_cron_idx (cron)`, which no query read, is replaced by `cron_runs_cron_started_idx (cron, started_at, uuid)`.
   It is folded into the still-unapplied 0006, which was regenerated with drizzle-kit.
3. `GET /v1/cron-runs?cron=<expression>` returns one trigger's runs (route + openapi.yaml).
   - The Operations page renders one `CronCard` per trigger, and each card reads its own latest run
     (`max: 1`, one index seek).
   - "Run now" and Refresh invalidate `cron-runs`, so every card refetches.
4. Tests:
   - `test/jobQueue.test.ts`: an idle tick records nothing, and the drain tests seed real work.
   - `test/cronRunsList.test.ts`: the filter finds the daily run behind two full pages of frequent runs.
   - `test/listIndexes.test.ts`: the filtered page is planned without a sort.
   - `test/fastTickProbe.test.ts`: a disabled past-due draft is a near-miss.
   - `e2e/operations.spec.ts` waits for all three cards before counting "Never run".

**Not doing.**
- Skipping idle AI ticks. Their row must exist before the drain runs (CPU-limit kills are why that trigger is
  separate), and the drains only learn they are idle from their own window query.
- Dropping the `cron-runs` stamps. It is a cached wire collection.

-- Partial indexes for the five-minute tick's "is there any work" probe (cron.ts `fastTickProbe`). Each holds only
-- the rows one of its checks asks about - drafts waiting to go out, runs in flight, queued jobs - so an idle tick
-- reads a handful of index entries however large those tables grow. And `cron_runs` is indexed by trigger and
-- start time, so the Operations page reads each trigger's newest run directly. db/schema.ts carries the reasoning
-- beside each index. Index-only: no stored row changes.
DROP INDEX IF EXISTS `cron_runs_cron_idx`;--> statement-breakpoint
CREATE INDEX `cron_runs_cron_started_idx` ON `cron_runs` (`cron`,`started_at`,`uuid`);--> statement-breakpoint
CREATE INDEX `cron_runs_running_idx` ON `cron_runs` (`started_at`) WHERE "cron_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX `announcements_due_idx` ON `announcements` (`publish_time`) WHERE "announcements"."published" = 0 and "announcements"."delete_time" is null and "announcements"."held_at" is null;--> statement-breakpoint
CREATE INDEX `jobs_queued_idx` ON `jobs` (`status`,`run_after`) WHERE "jobs"."status" = 'queued';
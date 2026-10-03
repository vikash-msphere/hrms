-- `idempotency_keys` loses its `created_at` index. D1 bills every index entry as a written row, and a key row is
-- inserted, updated and swept once each, so the index cost a write on the insert and on the sweep for one query a
-- night - a scan of one day's rows that reads as many rows without it. db/schema.ts says the same beside the
-- table. Index-only: no stored row changes.
DROP INDEX IF EXISTS `idempotency_keys_created_idx`;
--> statement-breakpoint

-- How far the embed drain has reconciled each indexable collection (services/searchEmbed.ts), so a ten-minute
-- tick reads only the collections written since it last finished them instead of every indexed row. Starts
-- empty, which reads every collection in full once, exactly as before. db/schema.ts carries the reasoning.
CREATE TABLE `search_vector_marks` (
	`collection` text PRIMARY KEY NOT NULL,
	`embedded_at` integer,
	`model` text,
	`pruned_at` integer
);

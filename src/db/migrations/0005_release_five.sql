-- Cached values shared by every Worker instance (lib/cacheGenerations.ts `persist`, db/schema.ts `cache_packs`).
-- A fresh isolate reads one packed row per role instead of that role's few hundred `access_rules` rows. Derived
-- only: every row is filed under a `cache_generations` counter, so a stale or missing row is just re-read.
CREATE TABLE `cache_packs` (
	`key` text PRIMARY KEY NOT NULL,
	`gen` integer NOT NULL,
	`value_json` text NOT NULL
);

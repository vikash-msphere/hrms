-- How far the embed drain has reconciled each indexable collection (services/searchEmbed.ts), so a ten-minute
-- tick reads only the collections written since it last finished them instead of every indexed row. Starts
-- empty, which reads every collection in full once, exactly as before. db/schema.ts carries the reasoning.
CREATE TABLE `search_vector_marks` (
	`collection` text PRIMARY KEY NOT NULL,
	`embedded_at` integer,
	`model` text,
	`pruned_at` integer
);

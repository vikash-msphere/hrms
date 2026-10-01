-- One board's live cards, newest first, for the Boards page's `GET /v1/cards?board=` walk: each keyset page is one
-- seek and a page of index steps instead of the board's whole range read and sorted again for every page.
-- db/schema.ts carries the measurement beside the index. Index-only: no stored row changes.
CREATE INDEX `card_board_created_idx` ON `cards` (`board_id`,`created_at`,`uuid`) WHERE "cards"."delete_time" is null;
--> statement-breakpoint

-- A leave type's accrual cap: the most a balance of that type may accrue to (db/schema.ts `accrualCapDays`).
-- Nullable with no default, so every existing type reads as uncapped and accrues exactly as it did before.
ALTER TABLE `leave_types` ADD `accrual_cap_days` real;
--> statement-breakpoint

-- The narrowed access-rules lists, each in the list's keyset order: a subject's rules, a collection's rules, and
-- the denies alone (access mode's tint). Each page becomes one seek and about a page of index steps instead of
-- the subject's whole set sorted, or the whole table walked. db/schema.ts carries the measurement beside the
-- indexes. Index-only: no stored row changes.
CREATE INDEX `ar_subject_created_idx` ON `access_rules` (`subject`,`subject_kind`,`created_at`,`uuid`);--> statement-breakpoint
CREATE INDEX `ar_namespace_created_idx` ON `access_rules` (`namespace`,`created_at`,`uuid`);--> statement-breakpoint
CREATE INDEX `ar_deny_created_idx` ON `access_rules` (`effect`,`created_at`,`uuid`) WHERE "access_rules"."effect" = 'deny';

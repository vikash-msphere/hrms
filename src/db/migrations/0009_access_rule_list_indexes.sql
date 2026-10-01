-- The narrowed access-rules lists, each in the list's keyset order: a subject's rules, a collection's rules, and
-- the denies alone (access mode's tint). Each page becomes one seek and about a page of index steps instead of
-- the subject's whole set sorted, or the whole table walked. db/schema.ts carries the measurement beside the
-- indexes. Index-only: no stored row changes.
CREATE INDEX `ar_subject_created_idx` ON `access_rules` (`subject`,`subject_kind`,`created_at`,`uuid`);--> statement-breakpoint
CREATE INDEX `ar_namespace_created_idx` ON `access_rules` (`namespace`,`created_at`,`uuid`);--> statement-breakpoint
CREATE INDEX `ar_deny_created_idx` ON `access_rules` (`effect`,`created_at`,`uuid`) WHERE "access_rules"."effect" = 'deny';

-- Late arrival / early departure requests (src/db/schema.ts `lateEarlyRequests`, late-early-requests-plan.md).
-- Adds the table, its change-stamp triggers, and the collection's owner ref and scope tiers on the live policy
-- manifest. Additive only: no existing row changes.
CREATE TABLE `late_early_requests` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`date` integer NOT NULL,
	`kind` text NOT NULL,
	`at` text NOT NULL,
	`minutes` integer NOT NULL,
	`reason` text,
	`state` text DEFAULT 'PENDING' NOT NULL,
	`over_limit` integer DEFAULT false NOT NULL,
	`auto_approved` integer DEFAULT false NOT NULL,
	`decided_by` text,
	`decision_note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `late_early_requests_code_unique` ON `late_early_requests` (`code`);--> statement-breakpoint
CREATE INDEX `late_early_requests_page_idx` ON `late_early_requests` (`created_at`,`uuid`);--> statement-breakpoint
CREATE INDEX `ler_emp_idx` ON `late_early_requests` (`employee_id`,`date`);--> statement-breakpoint
CREATE INDEX `ler_state_date_idx` ON `late_early_requests` (`state`,`date`);--> statement-breakpoint
CREATE UNIQUE INDEX `ler_live_idx` ON `late_early_requests` (`employee_id`,`date`,`kind`) WHERE "late_early_requests"."state" in ('PENDING', 'APPROVED');
--> statement-breakpoint
-- The collection's change stamps (src/db/changeDdl.ts). The generated block in 0000 is never rewritten, so a
-- table added after it carries its own triggers here; `npm run db:generate` prints them.
CREATE TRIGGER "chg_i_late_early_requests" AFTER INSERT ON "late_early_requests" BEGIN
  INSERT INTO "collection_versions" ("collection", "at") VALUES ('late-early-requests', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) ON CONFLICT("collection") DO UPDATE SET "at" = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);
END;
--> statement-breakpoint
CREATE TRIGGER "chg_u_late_early_requests" AFTER UPDATE ON "late_early_requests" BEGIN
  INSERT INTO "collection_versions" ("collection", "at") VALUES ('late-early-requests', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) ON CONFLICT("collection") DO UPDATE SET "at" = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);
END;
--> statement-breakpoint
CREATE TRIGGER "chg_d_late_early_requests" AFTER DELETE ON "late_early_requests" BEGIN
  INSERT INTO "collection_versions" ("collection", "at") VALUES ('late-early-requests', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) ON CONFLICT("collection") DO UPDATE SET "at" = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);
END;
--> statement-breakpoint
-- The policy manifest. Production reads `owner_refs` and `supported_scopes` from the `policy` row, not from
-- DEFAULT_POLICY in src/domain/manifests.ts, so the code change alone never reaches it. The owner ref is the
-- half that matters for safety: once an admin grants the collection, it is what stops a request being filed
-- under somebody else's name. Each statement touches only a manifest that lacks the entry, so a re-run changes
-- nothing and an entry an admin already wrote is kept.
UPDATE policy
SET value_json = json_set(value_json, '$.owner_refs."late-early-requests"', json('{"employee":{"collection":"employees"}}')),
    updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE key = 'manifest'
  AND json_type(value_json, '$.owner_refs') = 'object'
  AND json_type(value_json, '$.owner_refs."late-early-requests"') IS NULL;
--> statement-breakpoint
UPDATE policy
SET value_json = json_set(value_json, '$.supported_scopes."late-early-requests"', json('["self","reports","org","dept","all"]')),
    updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE key = 'manifest'
  AND json_type(value_json, '$.supported_scopes') = 'object'
  AND json_type(value_json, '$.supported_scopes."late-early-requests"') IS NULL;

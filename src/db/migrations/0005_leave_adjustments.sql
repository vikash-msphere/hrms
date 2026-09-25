-- The leave balance ledger (src/db/schema.ts `leaveAdjustments`, opening-balances-plan.md): opening balances
-- brought in from before HRMS, and hand corrections. Adds the table, its change-stamp triggers, and the
-- collection's owner ref and scope tiers on the live policy manifest. Additive only: no existing row changes.
-- No access rule is added: the collection is private by default, and an org grants it through the ACL.
CREATE TABLE `leave_adjustments` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`leave_type_id` text NOT NULL,
	`kind` text NOT NULL,
	`days` real NOT NULL,
	`opening_days` real,
	`removed_days` real,
	`encashed_days` real,
	`as_of` integer,
	`opening_seq` integer,
	`reason` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`leave_type_id`) REFERENCES `leave_types`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leave_adjustments_code_unique` ON `leave_adjustments` (`code`);--> statement-breakpoint
CREATE INDEX `leave_adjustments_page_idx` ON `leave_adjustments` (`created_at`,`uuid`);--> statement-breakpoint
CREATE INDEX `ladj_emp_idx` ON `leave_adjustments` (`employee_id`,`created_at`,`uuid`);--> statement-breakpoint
CREATE UNIQUE INDEX `ladj_opening_idx` ON `leave_adjustments` (`employee_id`,`leave_type_id`,`opening_seq`) WHERE "leave_adjustments"."kind" = 'opening';
--> statement-breakpoint
-- The collection's change stamps (src/db/changeDdl.ts). The generated block in 0000 is never rewritten, so a
-- table added after it carries its own triggers here; `npm run db:generate` prints them.
CREATE TRIGGER "chg_i_leave_adjustments" AFTER INSERT ON "leave_adjustments" BEGIN
  INSERT INTO "collection_versions" ("collection", "at") VALUES ('leave-adjustments', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) ON CONFLICT("collection") DO UPDATE SET "at" = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);
END;
--> statement-breakpoint
CREATE TRIGGER "chg_u_leave_adjustments" AFTER UPDATE ON "leave_adjustments" BEGIN
  INSERT INTO "collection_versions" ("collection", "at") VALUES ('leave-adjustments', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) ON CONFLICT("collection") DO UPDATE SET "at" = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);
END;
--> statement-breakpoint
CREATE TRIGGER "chg_d_leave_adjustments" AFTER DELETE ON "leave_adjustments" BEGIN
  INSERT INTO "collection_versions" ("collection", "at") VALUES ('leave-adjustments', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) ON CONFLICT("collection") DO UPDATE SET "at" = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);
END;
--> statement-breakpoint
-- The policy manifest. Production reads `owner_refs` and `supported_scopes` from the `policy` row, not from
-- DEFAULT_POLICY in src/domain/manifests.ts, so the code change alone never reaches it. The owner ref is the
-- half that matters for safety: once an admin grants the collection, it is what stops an adjustment being
-- filed against somebody the caller may not write for. Each statement touches only a manifest that lacks the
-- entry, so a re-run changes nothing and an entry an admin already wrote is kept.
UPDATE policy
SET value_json = json_set(value_json, '$.owner_refs."leave-adjustments"', json('{"employee":{"collection":"employees"}}')),
    updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE key = 'manifest'
  AND json_type(value_json, '$.owner_refs') = 'object'
  AND json_type(value_json, '$.owner_refs."leave-adjustments"') IS NULL;
--> statement-breakpoint
UPDATE policy
SET value_json = json_set(value_json, '$.supported_scopes."leave-adjustments"', json('["self","reports","org","dept","all"]')),
    updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE key = 'manifest'
  AND json_type(value_json, '$.supported_scopes') = 'object'
  AND json_type(value_json, '$.supported_scopes."leave-adjustments"') IS NULL;

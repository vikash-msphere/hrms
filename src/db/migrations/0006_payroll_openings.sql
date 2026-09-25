-- Pay and tax already paid this financial year before HRMS ran payroll (src/db/schema.ts `payrollOpenings`,
-- opening-balances-plan.md). Adds the table, its change-stamp triggers, and the collection's owner ref, scope
-- tiers and read-audit entry on the live policy manifest. Additive only: no existing row changes. No access
-- rule is added: the collection is private by default, and an org grants it through the ACL.
CREATE TABLE `payroll_openings` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`financial_year` text NOT NULL,
	`paid_through` text NOT NULL,
	`gross` real NOT NULL,
	`taxable_gross` real NOT NULL,
	`tds` real DEFAULT 0 NOT NULL,
	`pt` real DEFAULT 0 NOT NULL,
	`esi_contributing` integer DEFAULT false NOT NULL,
	`note` text,
	`created_by` text,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payroll_openings_code_unique` ON `payroll_openings` (`code`);--> statement-breakpoint
CREATE INDEX `payroll_openings_page_idx` ON `payroll_openings` (`created_at`,`uuid`);--> statement-breakpoint
CREATE INDEX `popen_emp_idx` ON `payroll_openings` (`employee_id`,`created_at`,`uuid`);--> statement-breakpoint
CREATE UNIQUE INDEX `popen_emp_fy_idx` ON `payroll_openings` (`employee_id`,`financial_year`) WHERE "payroll_openings"."delete_time" is null;
--> statement-breakpoint
-- The collection's change stamps (src/db/changeDdl.ts). The generated block in 0000 is never rewritten, so a
-- table added after it carries its own triggers here; `npm run db:generate` prints them.
CREATE TRIGGER "chg_i_payroll_openings" AFTER INSERT ON "payroll_openings" BEGIN
  INSERT INTO "collection_versions" ("collection", "at") VALUES ('payroll-openings', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) ON CONFLICT("collection") DO UPDATE SET "at" = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);
END;
--> statement-breakpoint
CREATE TRIGGER "chg_u_payroll_openings" AFTER UPDATE ON "payroll_openings" BEGIN
  INSERT INTO "collection_versions" ("collection", "at") VALUES ('payroll-openings', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) ON CONFLICT("collection") DO UPDATE SET "at" = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);
END;
--> statement-breakpoint
CREATE TRIGGER "chg_d_payroll_openings" AFTER DELETE ON "payroll_openings" BEGIN
  INSERT INTO "collection_versions" ("collection", "at") VALUES ('payroll-openings', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) ON CONFLICT("collection") DO UPDATE SET "at" = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);
END;
--> statement-breakpoint
-- The policy manifest. Production reads it from the `policy` row, not from DEFAULT_POLICY in
-- src/domain/manifests.ts, so the code change alone never reaches it. The owner ref stops a row being filed
-- against somebody the caller may not write for; the audit entry records every read of one, as it does for
-- compensation and payslips, since a row is a person's pay. Each statement touches only a manifest that lacks
-- the entry, so a re-run changes nothing and an entry an admin already wrote is kept.
UPDATE policy
SET value_json = json_set(value_json, '$.owner_refs."payroll-openings"', json('{"employee":{"collection":"employees"}}')),
    updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE key = 'manifest'
  AND json_type(value_json, '$.owner_refs') = 'object'
  AND json_type(value_json, '$.owner_refs."payroll-openings"') IS NULL;
--> statement-breakpoint
UPDATE policy
SET value_json = json_set(value_json, '$.supported_scopes."payroll-openings"', json('["self","reports","org","dept","all"]')),
    updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE key = 'manifest'
  AND json_type(value_json, '$.supported_scopes') = 'object'
  AND json_type(value_json, '$.supported_scopes."payroll-openings"') IS NULL;
--> statement-breakpoint
UPDATE policy
SET value_json = json_insert(value_json, '$.audit.sensitive_collections[#]', 'payroll-openings'),
    updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE key = 'manifest'
  AND json_type(value_json, '$.audit.sensitive_collections') = 'array'
  AND NOT EXISTS (SELECT 1 FROM json_each(value_json, '$.audit.sensitive_collections') WHERE value = 'payroll-openings');

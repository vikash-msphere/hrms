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
--> statement-breakpoint

-- Carries the photo permission across to the verb that still exists, on the live database. Data only; no
-- schema change. Every statement is idempotent, so a re-run changes nothing.
--
-- WHAT CHANGED IN THE CODE. Avatars used to arrive through `employees:batchGetPhotos`, a collection-level verb
-- granted broadly as pure transport, whose service re-applied the employee list scope per id. There is no batch
-- any more: a face is an ordinary image at `GET /v1/employees/<id>:getPhoto`, and the rule it enforces is the
-- one it always was - if you may read the employee's record, you may see their face (services/employeePhoto.ts
-- asks the engine that exact question). So `getPhoto` now needs the breadth `batchGetPhotos` had.
--
-- WHY A MIGRATION. `access_rules` is live data; `scripts/seed.sql` and `bootstrap/bootstrap.sql` only ever
-- reach a fresh database. Without this, the first deploy would leave every avatar in the app 403ing.
--
-- NOBODY GAINS ANYTHING. The new rule is minted only for a subject that already holds the batch rule, with that
-- rule's own scope, conditions and expiry - the same callers, seeing the same faces, through a different URL.
-- Self-scoped `employees.me.getPhoto` rules are left alone: redundant while the broad rule stands, and the
-- thing that keeps a person's own photo working if it is ever withdrawn.
INSERT INTO access_rules (uuid, subject, subject_kind, namespace, pattern, scope_kind, scope_code, match_code, level, effect, condition, from_ip, "window", source, status, requested_by, expires_at, created_at, updated_at)
SELECT
  substr('0123456789abcdefghjkmnpqrstvwxyz', (random() & 31) + 1, 1) ||
  substr('0123456789abcdefghjkmnpqrstvwxyz', (random() & 31) + 1, 1) ||
  substr('0123456789abcdefghjkmnpqrstvwxyz', (random() & 31) + 1, 1) ||
  substr('0123456789abcdefghjkmnpqrstvwxyz', (random() & 31) + 1, 1) ||
  substr('0123456789abcdefghjkmnpqrstvwxyz', (random() & 31) + 1, 1) ||
  substr('0123456789abcdefghjkmnpqrstvwxyz', (random() & 31) + 1, 1) ||
  substr('0123456789abcdefghjkmnpqrstvwxyz', (random() & 31) + 1, 1) ||
  substr('0123456789abcdefghjkmnpqrstvwxyz', (random() & 31) + 1, 1) ||
  substr('0123456789abcdefghjkmnpqrstvwxyz', (random() & 31) + 1, 1) ||
  substr('0123456789abcdefghjkmnpqrstvwxyz', (random() & 31) + 1, 1) ||
  substr('0123456789abcdefghjkmnpqrstvwxyz', (random() & 31) + 1, 1) ||
  substr('0123456789abcdefghjkmnpqrstvwxyz', (random() & 31) + 1, 1) ||
  substr('0123456789abcdefghjkmnpqrstvwxyz', (random() & 15) * 2 + 1, 1),
  r.subject, r.subject_kind, r.namespace, 'employees.*.getPhoto', r.scope_kind, r.scope_code, r.match_code,
  NULL, 'allow', r.condition, r.from_ip, r."window", r.source, r.status, NULL, r.expires_at,
  CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
  CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
FROM access_rules r
WHERE r.pattern = 'employees.batchGetPhotos'
  AND r.effect = 'allow'
  AND NOT EXISTS (
    SELECT 1 FROM access_rules x
    WHERE x.subject = r.subject AND x.subject_kind = r.subject_kind AND x.pattern = 'employees.*.getPhoto' AND x.effect = 'allow'
  );
--> statement-breakpoint
-- The batch verb is gone from the app, so a rule naming it grants nothing and only confuses the access screens.
DELETE FROM access_rules WHERE pattern = 'employees.batchGetPhotos';
--> statement-breakpoint

-- The day HRMS records start for each employee (src/db/schema.ts `employees.trackedFrom`,
-- opening-balances-plan.md). Additive and nullable: every existing row reads null, which means "records start on
-- the start date", so nothing about a live row changes until HR sets a date: in bulk for the people who joined
-- before go-live (`employees:setTrackedFrom`), or per person on the employee record.
ALTER TABLE `employees` ADD `tracked_from` integer;
--> statement-breakpoint

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
--> statement-breakpoint

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
--> statement-breakpoint

-- Where a leave request came from (src/db/schema.ts `leaveRequests.source`, opening-balances-plan.md): 'app' for
-- everything filed in HRMS, 'import' for leave taken before HRMS and brought in as history. Additive only:
-- every existing row is 'app', which is what it is.
ALTER TABLE `leave_requests` ADD `source` text DEFAULT 'app' NOT NULL;
--> statement-breakpoint

-- Work schedules: a day's shift, its length and whether it is worked at all become a per-employee answer
-- (src/db/schema.ts `workPatterns`, `workPatternAssignments`, `shifts`, `shiftAssignments`;
-- work-schedules-plan.md). Three parts: the pattern catalog and its assignments, the per-shift day lengths,
-- and a roster entry that can say "off".
--
-- Nothing here changes what any existing org is paid. A day still resolves to `settings/attendance` until
-- that blob's `schedule_source` is switched to "resolved" (src/domain/workSchedule.ts), and every column added
-- below is nullable or defaulted to what the table already meant.
CREATE TABLE `work_patterns` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`name` text NOT NULL,
	`cycle_weeks` integer DEFAULT 1 NOT NULL,
	`days_json` text DEFAULT '[]' NOT NULL,
	`color` text,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_patterns_code_unique` ON `work_patterns` (`code`);--> statement-breakpoint
CREATE INDEX `work_patterns_page_idx` ON `work_patterns` (`created_at`,`uuid`);--> statement-breakpoint
CREATE TABLE `work_pattern_assignments` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`pattern_id` text NOT NULL,
	`start_date` integer NOT NULL,
	`end_date` integer,
	`anchor_date` integer,
	`note` text,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pattern_id`) REFERENCES `work_patterns`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_pattern_assignments_code_unique` ON `work_pattern_assignments` (`code`);--> statement-breakpoint
CREATE INDEX `work_pattern_assignments_page_idx` ON `work_pattern_assignments` (`created_at`,`uuid`);--> statement-breakpoint
CREATE INDEX `wpa_emp_idx` ON `work_pattern_assignments` (`employee_id`,`created_at`,`uuid`);--> statement-breakpoint
CREATE INDEX `wpa_pattern_idx` ON `work_pattern_assignments` (`pattern_id`);--> statement-breakpoint
CREATE INDEX `wpa_start_idx` ON `work_pattern_assignments` (`start_date`);--> statement-breakpoint
-- A ROSTER ENTRY THAT CAN SAY "OFF". `shift_id` was NOT NULL, and SQLite cannot drop a NOT NULL in place, so
-- this is the 12-step rebuild: copy into a new table, drop the old one, rename. Every existing row copies
-- across unchanged and lands on `kind` = 'shift', which is what each of them is.
--
-- `kind` is DEFAULTED IN THE SELECT, not copied: the old table has no such column, and the generated form of
-- this migration selected it by name (which would fail on the first row).
--
-- DROP TABLE takes the table's triggers with it, so all six are recreated below - the three search-index
-- triggers and the three change stamps. Without them the roster falls silently out of global search and out
-- of the collection-version feed the SPA's caches read. The `search_docs` rows themselves are untouched: a
-- DROP does not fire per-row DELETE triggers, and the copy preserves every `uuid` they point at.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_shift_assignments` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`shift_id` text,
	`kind` text DEFAULT 'shift' NOT NULL,
	`date` integer NOT NULL,
	`note` text,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shift_id`) REFERENCES `shifts`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_shift_assignments`("uuid", "code", "employee_id", "shift_id", "kind", "date", "note", "delete_time", "created_at", "updated_at") SELECT "uuid", "code", "employee_id", "shift_id", 'shift', "date", "note", "delete_time", "created_at", "updated_at" FROM `shift_assignments`;--> statement-breakpoint
DROP TABLE `shift_assignments`;--> statement-breakpoint
ALTER TABLE `__new_shift_assignments` RENAME TO `shift_assignments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `shift_assignments_code_unique` ON `shift_assignments` (`code`);--> statement-breakpoint
CREATE INDEX `shift_assignments_page_idx` ON `shift_assignments` (`created_at`,`uuid`);--> statement-breakpoint
CREATE INDEX `sa_emp_idx` ON `shift_assignments` (`employee_id`,`created_at`,`uuid`);--> statement-breakpoint
CREATE INDEX `sa_shift_idx` ON `shift_assignments` (`shift_id`);--> statement-breakpoint
CREATE INDEX `sa_date_idx` ON `shift_assignments` (`date`);--> statement-breakpoint
CREATE UNIQUE INDEX `sa_emp_day_idx` ON `shift_assignments` (`employee_id`,`date`) WHERE "shift_assignments"."delete_time" is null;--> statement-breakpoint
CREATE TRIGGER "search_ai_shift_assignments" AFTER INSERT ON "shift_assignments" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('shift-assignments', new."uuid", new."code", new."employee_id", nullif(trim(new."note"), ''), NULL, (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."note", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_shift_assignments" AFTER UPDATE ON "shift_assignments" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."note"), ''), "subtitle" = NULL, "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'shift-assignments' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."note", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'shift-assignments' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_shift_assignments" AFTER DELETE ON "shift_assignments" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'shift-assignments' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'shift-assignments' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "chg_i_shift_assignments" AFTER INSERT ON "shift_assignments" BEGIN
  INSERT INTO "collection_versions" ("collection", "at") VALUES ('shift-assignments', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) ON CONFLICT("collection") DO UPDATE SET "at" = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);
END;
--> statement-breakpoint
CREATE TRIGGER "chg_u_shift_assignments" AFTER UPDATE ON "shift_assignments" BEGIN
  INSERT INTO "collection_versions" ("collection", "at") VALUES ('shift-assignments', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) ON CONFLICT("collection") DO UPDATE SET "at" = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);
END;
--> statement-breakpoint
CREATE TRIGGER "chg_d_shift_assignments" AFTER DELETE ON "shift_assignments" BEGIN
  INSERT INTO "collection_versions" ("collection", "at") VALUES ('shift-assignments', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) ON CONFLICT("collection") DO UPDATE SET "at" = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);
END;
--> statement-breakpoint
-- What a day on each shift is worth, and the shift's own lateness rules. Null on every existing row, which is
-- the derivation: a full day is the shift's span less its break, half a day is half of that, and grace and
-- flexible hours come from the org. See src/domain/workSchedule.ts#shiftDay.
ALTER TABLE `shifts` ADD `full_day_minutes` integer;--> statement-breakpoint
ALTER TABLE `shifts` ADD `half_day_minutes` integer;--> statement-breakpoint
ALTER TABLE `shifts` ADD `grace_minutes` integer;--> statement-breakpoint
ALTER TABLE `shifts` ADD `flexible_hours` integer;--> statement-breakpoint
-- The two new collections' change stamps (src/db/changeDdl.ts). The generated block in 0000 is never
-- rewritten, so a table added after it carries its own triggers here; `npm run db:generate` prints them.
CREATE TRIGGER "chg_i_work_pattern_assignments" AFTER INSERT ON "work_pattern_assignments" BEGIN
  INSERT INTO "collection_versions" ("collection", "at") VALUES ('work-pattern-assignments', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) ON CONFLICT("collection") DO UPDATE SET "at" = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);
END;
--> statement-breakpoint
CREATE TRIGGER "chg_u_work_pattern_assignments" AFTER UPDATE ON "work_pattern_assignments" BEGIN
  INSERT INTO "collection_versions" ("collection", "at") VALUES ('work-pattern-assignments', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) ON CONFLICT("collection") DO UPDATE SET "at" = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);
END;
--> statement-breakpoint
CREATE TRIGGER "chg_d_work_pattern_assignments" AFTER DELETE ON "work_pattern_assignments" BEGIN
  INSERT INTO "collection_versions" ("collection", "at") VALUES ('work-pattern-assignments', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) ON CONFLICT("collection") DO UPDATE SET "at" = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);
END;
--> statement-breakpoint
CREATE TRIGGER "chg_i_work_patterns" AFTER INSERT ON "work_patterns" BEGIN
  INSERT INTO "collection_versions" ("collection", "at") VALUES ('work-patterns', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) ON CONFLICT("collection") DO UPDATE SET "at" = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);
END;
--> statement-breakpoint
CREATE TRIGGER "chg_u_work_patterns" AFTER UPDATE ON "work_patterns" BEGIN
  INSERT INTO "collection_versions" ("collection", "at") VALUES ('work-patterns', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) ON CONFLICT("collection") DO UPDATE SET "at" = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);
END;
--> statement-breakpoint
CREATE TRIGGER "chg_d_work_patterns" AFTER DELETE ON "work_patterns" BEGIN
  INSERT INTO "collection_versions" ("collection", "at") VALUES ('work-patterns', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) ON CONFLICT("collection") DO UPDATE SET "at" = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);
END;
--> statement-breakpoint
-- And the two collections' search-index triggers plus their backfills (src/db/searchDdl.ts,
-- src/domain/searchIndex.ts), so a schedule and a schedule assignment are reachable from the command palette
-- like every other collection. Generated by `node scripts/genSearchDdl.ts`; carried here rather than in the
-- generated block in 0000, which is applied to the live database and is never rewritten. The backfills are
-- no-ops on a fresh database and pick up any rows an earlier apply created.
CREATE TRIGGER "search_ai_work_patterns" AFTER INSERT ON "work_patterns" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('work-patterns', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), NULL, (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."name", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_work_patterns" AFTER UPDATE ON "work_patterns" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = NULL, "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'work-patterns' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."name", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'work-patterns' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_work_patterns" AFTER DELETE ON "work_patterns" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'work-patterns' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'work-patterns' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_work_pattern_assignments" AFTER INSERT ON "work_pattern_assignments" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('work-pattern-assignments', new."uuid", new."code", new."employee_id", nullif(trim(new."note"), ''), NULL, (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."note", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_work_pattern_assignments" AFTER UPDATE ON "work_pattern_assignments" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."note"), ''), "subtitle" = NULL, "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'work-pattern-assignments' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."note", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'work-pattern-assignments' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_work_pattern_assignments" AFTER DELETE ON "work_pattern_assignments" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'work-pattern-assignments' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'work-pattern-assignments' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
INSERT OR IGNORE INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) SELECT 'work-patterns', t."uuid", t."code", NULL, nullif(trim(t."name"), ''), NULL, (t."delete_time" IS NOT NULL), 0, t."created_at" FROM "work_patterns" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."name", '') FROM "search_docs" d JOIN "work_patterns" t ON t."uuid" = d."record_id" WHERE d."collection" = 'work-patterns' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT OR IGNORE INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) SELECT 'work-pattern-assignments', t."uuid", t."code", t."employee_id", nullif(trim(t."note"), ''), NULL, (t."delete_time" IS NOT NULL), 0, t."created_at" FROM "work_pattern_assignments" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."note", '') FROM "search_docs" d JOIN "work_pattern_assignments" t ON t."uuid" = d."record_id" WHERE d."collection" = 'work-pattern-assignments' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint

CREATE TABLE `search_insights` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`day` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `search_insights_code_unique` ON `search_insights` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `search_insights_key_idx` ON `search_insights` (`day`,`kind`,`label`);--> statement-breakpoint
CREATE INDEX `search_insights_page_idx` ON `search_insights` (`created_at`,`uuid`);--> statement-breakpoint
-- Change stamps for the new collection (printed by scripts/genChangeDdl.ts).
CREATE TRIGGER "chg_i_search_insights" AFTER INSERT ON "search_insights" BEGIN
  INSERT INTO "collection_versions" ("collection", "at") VALUES ('search-insights', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) ON CONFLICT("collection") DO UPDATE SET "at" = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);
END;
--> statement-breakpoint
CREATE TRIGGER "chg_u_search_insights" AFTER UPDATE ON "search_insights" BEGIN
  INSERT INTO "collection_versions" ("collection", "at") VALUES ('search-insights', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) ON CONFLICT("collection") DO UPDATE SET "at" = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);
END;
--> statement-breakpoint
CREATE TRIGGER "chg_d_search_insights" AFTER DELETE ON "search_insights" BEGIN
  INSERT INTO "collection_versions" ("collection", "at") VALUES ('search-insights', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) ON CONFLICT("collection") DO UPDATE SET "at" = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);
END;
--> statement-breakpoint

CREATE TABLE `app_locks` (
	`user_id` text PRIMARY KEY NOT NULL,
	`pin_hash` text,
	`pin_length` integer,
	`pin_set_at` integer,
	`idle_minutes` integer DEFAULT 15 NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`blocked_until` integer,
	`last_failed_at` integer,
	`unlocks_valid_from` integer,
	`revoked_json` text DEFAULT '[]' NOT NULL,
	`key_epoch` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`uuid`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint

-- The role a new account is given on hire and at first sign-in, as DATA on the role row (src/db/schema.ts
-- `roles.provisioned`) instead of the name `employee` written into the Worker. At most one role carries it (the
-- partial unique index). The existing database keeps what it did: `employee` is the role new accounts were
-- given, so it is marked. An admin moves the flag in Access Management.
ALTER TABLE `roles` ADD `provisioned` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `roles_one_provisioned` ON `roles` (`provisioned`) WHERE "roles"."provisioned" = 1;--> statement-breakpoint
UPDATE `roles` SET `provisioned` = 1 WHERE `name` = 'employee';
--> statement-breakpoint

-- The policy manifest becomes the ONLY copy of the policy. The Worker used to fall back to DEFAULT_POLICY in
-- src/domain/manifests.ts whenever the `policy` row was not JSON or lacked a section, and to the typed
-- SUPPORTED_SCOPES when a row predated that section. That code is gone (the seed values now live only in
-- bootstrap/authz/policy.ts, which the app never reads), so this writes into the row exactly what the fallback
-- used to supply, and the live database decides the same way it did the moment before. Data only; every
-- statement is idempotent, so a re-run changes nothing, and on a fresh database (no row yet - the bootstrap
-- inserts it after the migrations) they touch nothing.
--
-- A MISSING row is deliberately not recreated here: that is not a shape the live database is in, and the app
-- now refuses (503 not-configured) rather than inventing a policy, which is the point.
--
-- 1. A row that is not JSON: the fallback served the whole default, so the row becomes it. First and on its
--    own, because json_type() raises on malformed JSON and SQLite does not promise to short-circuit an OR.
-- 2. A row lacking one of the sections the parser required: the same, the whole default.
-- 3. A row that predates `supported_scopes`: the fallback served the typed scopes for that one section, so the
--    section is added and nothing else is touched.
UPDATE policy
SET value_json = '{"protected_fields":{"users":["role","roles","status","employee"],"employees":["department","manager","epf_enrolled","eps_excluded","employee_number"],"compensation":["annual_ctc","variable_pay_target","currency_code","pay_grade","salary_structure"]},"references":{"leave-requests":{"leave_type":{"collection":"leave-types","level":"read"}},"holiday-selections":{"holiday":{"collection":"holidays","level":"read"}},"payroll-runs":{"pay_period":{"collection":"pay-periods","level":"read"}},"reimbursements":{"category":{"collection":"reimbursement-categories","level":"read"}},"assets":{"category":{"collection":"asset-categories","level":"read"},"stocktake":{"collection":"stocktakes","level":"read"}},"asset-requests":{"category":{"collection":"asset-categories","level":"read"}},"benefit-enrollments":{"plan":{"collection":"benefit-plans","level":"read"}},"shift-assignments":{"shift":{"collection":"shifts","level":"read"}},"work-pattern-assignments":{"pattern":{"collection":"work-patterns","level":"read"}},"time-entries":{"project":{"collection":"projects","level":"read"}},"referrals":{"department":{"collection":"departments","level":"read"},"hired_employee":{"collection":"employees","level":"read"}},"job-requisitions":{"department":{"collection":"departments","level":"read"},"hiring_manager":{"collection":"employees","level":"read"},"pay_grade":{"collection":"pay-grades","level":"read"}},"candidates":{"referral":{"collection":"referrals","level":"read"}},"applications":{"candidate":{"collection":"candidates","level":"read"},"requisition":{"collection":"job-requisitions","level":"read"},"referral":{"collection":"referrals","level":"read"}},"interviews":{"application":{"collection":"applications","level":"read"}},"interview-feedback":{"interview":{"collection":"interviews","level":"read"}},"goals":{"parent":{"collection":"goals","level":"read"},"blocked_by":{"collection":"goals","level":"read"},"cycle":{"collection":"review-cycles","level":"read"},"department":{"collection":"departments","level":"read"}},"cards":{"board":{"collection":"boards","level":"read"},"goal":{"collection":"goals","level":"read"},"sprint":{"collection":"sprints","level":"read"}},"sprints":{"board":{"collection":"boards","level":"read"}},"offers":{"application":{"collection":"applications","level":"read"}}},"owner_refs":{"leave-requests":{"employee":{"collection":"employees"}},"personal-documents":{"employee":{"collection":"employees"}},"attendance-regularizations":{"employee":{"collection":"employees"}},"attendance-day-marks":{"employee":{"collection":"employees"}},"overtime-requests":{"employee":{"collection":"employees"}},"remote-work-requests":{"employee":{"collection":"employees"}},"late-early-requests":{"employee":{"collection":"employees"}},"asset-requests":{"employee":{"collection":"employees"}},"notice-periods":{"employee":{"collection":"employees"}},"announcements":{"author":{"collection":"employees"}},"suggestions":{"submitter":{"collection":"employees"}},"reimbursements":{"employee":{"collection":"employees"}},"expenses":{"employee":{"collection":"employees"}},"goals":{"employee":{"collection":"employees"}},"cards":{"employee":{"collection":"employees"}},"transitions":{"employee":{"collection":"employees"}},"check-ins":{"employee":{"collection":"employees"}},"dependents":{"employee":{"collection":"employees"}},"benefit-enrollments":{"employee":{"collection":"employees"}},"shift-assignments":{"employee":{"collection":"employees"}},"work-pattern-assignments":{"employee":{"collection":"employees"}},"time-entries":{"employee":{"collection":"employees"}},"tax-declarations":{"employee":{"collection":"employees"}},"tickets":{"employee":{"collection":"employees"}},"referrals":{"referrer":{"collection":"employees"}},"interview-feedback":{"author":{"collection":"employees"}},"compensation":{"employee":{"collection":"employees"}},"positions":{"employee":{"collection":"employees"}},"bonuses":{"employee":{"collection":"employees"}},"settlements":{"employee":{"collection":"employees"}},"leave-encashments":{"employee":{"collection":"employees"}},"leave-adjustments":{"employee":{"collection":"employees"}},"payroll-openings":{"employee":{"collection":"employees"}},"approval-delegations":{"delegator":{"collection":"employees"}},"background-checks":{"employee":{"collection":"employees"}}},"state_visibility":{"announcements":{"requires":"write","public_when":{"published":true,"disabled":false}}},"audit":{"sensitive_subresources":["bank-account","identity","tax"],"sensitive_collections":["compensation","payslips","settlements","background-checks","offers","payroll-openings"],"sensitive_verbs":["employees:downloadIdentityDoc","payslips:preview","payslips:download","payroll-runs:bankFile","payroll-runs:statutoryReport","personal-documents:download","personal-documents:previewLetter","candidates:download","referrals:download","tax-declarations:download","leave-requests:download","tickets:attachment","reimbursements:download","offers:letter"]},"supported_scopes":{"employees":["self","reports","org","dept","all"],"leave-requests":["self","reports","org","dept","all"],"goals":["self","reports","org","dept","all"],"cards":["self","reports","org","dept","all"],"reviews":["self","reports","org","dept","all"],"review-feedback":["self","reports","org","dept","all"],"transitions":["self","reports","org","dept","all"],"transition-tasks":["self","reports","org","dept","all"],"check-ins":["self","reports","org","dept","all"],"dependents":["self","reports","org","dept","all"],"benefit-enrollments":["self","reports","org","dept","all"],"shift-assignments":["self","reports","org","dept","all"],"work-pattern-assignments":["self","reports","org","dept","all"],"time-entries":["self","reports","org","dept","all"],"loans":["self","reports","org","dept","all"],"tax-declarations":["self","reports","org","dept","all"],"referrals":["self","reports","org","dept","all"],"interview-feedback":["self","reports","org","dept","all"],"background-checks":["self","reports","org","dept","all"],"assets":["self","reports","org","dept","all"],"leave-balances":["self","reports","org","dept","all"],"leave-encashments":["self","reports","org","dept","all"],"leave-adjustments":["self","reports","org","dept","all"],"payroll-openings":["self","reports","org","dept","all"],"attendance":["self","reports","org","dept","all"],"attendance-regularizations":["self","reports","org","dept","all"],"attendance-day-marks":["self","reports","org","dept","all"],"overtime-requests":["self","reports","org","dept","all"],"remote-work-requests":["self","reports","org","dept","all"],"late-early-requests":["self","reports","org","dept","all"],"asset-requests":["self","reports","org","dept","all"],"notice-periods":["self","reports","org","dept","all"],"announcements":["self","reports","org","dept","all"],"suggestions":["self","reports","org","dept","all"],"document-acknowledgements":["self","reports","org","dept","all"],"personal-documents":["self","all"],"payslips":["self","reports","org","dept","all"],"reimbursements":["self","reports","org","dept","all"],"compensation":["self","reports","org","dept","all"],"positions":["self","reports","org","dept","all"],"bonuses":["self","reports","org","dept","all"],"settlements":["self","reports","org","dept","all"],"operations":["self","all"],"tickets":["self","all"],"table-views":["self","all"],"expenses":["self","reports","org","dept","all"],"approval-delegations":["self","all"],"users":["self","all"],"departments":["subtree","all"],"activity":["self","reports","org","dept","all"]},"redacted_fields":{"offers":["base_comp"],"candidates":["email","phone","notes"],"leave-requests":["reason"],"tickets":["description"],"assets":["purchase_cost","book_value"],"background-checks":["cost"],"employees":["probation_end_date"]}}',
    updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE key = 'manifest' AND json_valid(value_json) = 0;
--> statement-breakpoint
UPDATE policy
SET value_json = '{"protected_fields":{"users":["role","roles","status","employee"],"employees":["department","manager","epf_enrolled","eps_excluded","employee_number"],"compensation":["annual_ctc","variable_pay_target","currency_code","pay_grade","salary_structure"]},"references":{"leave-requests":{"leave_type":{"collection":"leave-types","level":"read"}},"holiday-selections":{"holiday":{"collection":"holidays","level":"read"}},"payroll-runs":{"pay_period":{"collection":"pay-periods","level":"read"}},"reimbursements":{"category":{"collection":"reimbursement-categories","level":"read"}},"assets":{"category":{"collection":"asset-categories","level":"read"},"stocktake":{"collection":"stocktakes","level":"read"}},"asset-requests":{"category":{"collection":"asset-categories","level":"read"}},"benefit-enrollments":{"plan":{"collection":"benefit-plans","level":"read"}},"shift-assignments":{"shift":{"collection":"shifts","level":"read"}},"work-pattern-assignments":{"pattern":{"collection":"work-patterns","level":"read"}},"time-entries":{"project":{"collection":"projects","level":"read"}},"referrals":{"department":{"collection":"departments","level":"read"},"hired_employee":{"collection":"employees","level":"read"}},"job-requisitions":{"department":{"collection":"departments","level":"read"},"hiring_manager":{"collection":"employees","level":"read"},"pay_grade":{"collection":"pay-grades","level":"read"}},"candidates":{"referral":{"collection":"referrals","level":"read"}},"applications":{"candidate":{"collection":"candidates","level":"read"},"requisition":{"collection":"job-requisitions","level":"read"},"referral":{"collection":"referrals","level":"read"}},"interviews":{"application":{"collection":"applications","level":"read"}},"interview-feedback":{"interview":{"collection":"interviews","level":"read"}},"goals":{"parent":{"collection":"goals","level":"read"},"blocked_by":{"collection":"goals","level":"read"},"cycle":{"collection":"review-cycles","level":"read"},"department":{"collection":"departments","level":"read"}},"cards":{"board":{"collection":"boards","level":"read"},"goal":{"collection":"goals","level":"read"},"sprint":{"collection":"sprints","level":"read"}},"sprints":{"board":{"collection":"boards","level":"read"}},"offers":{"application":{"collection":"applications","level":"read"}}},"owner_refs":{"leave-requests":{"employee":{"collection":"employees"}},"personal-documents":{"employee":{"collection":"employees"}},"attendance-regularizations":{"employee":{"collection":"employees"}},"attendance-day-marks":{"employee":{"collection":"employees"}},"overtime-requests":{"employee":{"collection":"employees"}},"remote-work-requests":{"employee":{"collection":"employees"}},"late-early-requests":{"employee":{"collection":"employees"}},"asset-requests":{"employee":{"collection":"employees"}},"notice-periods":{"employee":{"collection":"employees"}},"announcements":{"author":{"collection":"employees"}},"suggestions":{"submitter":{"collection":"employees"}},"reimbursements":{"employee":{"collection":"employees"}},"expenses":{"employee":{"collection":"employees"}},"goals":{"employee":{"collection":"employees"}},"cards":{"employee":{"collection":"employees"}},"transitions":{"employee":{"collection":"employees"}},"check-ins":{"employee":{"collection":"employees"}},"dependents":{"employee":{"collection":"employees"}},"benefit-enrollments":{"employee":{"collection":"employees"}},"shift-assignments":{"employee":{"collection":"employees"}},"work-pattern-assignments":{"employee":{"collection":"employees"}},"time-entries":{"employee":{"collection":"employees"}},"tax-declarations":{"employee":{"collection":"employees"}},"tickets":{"employee":{"collection":"employees"}},"referrals":{"referrer":{"collection":"employees"}},"interview-feedback":{"author":{"collection":"employees"}},"compensation":{"employee":{"collection":"employees"}},"positions":{"employee":{"collection":"employees"}},"bonuses":{"employee":{"collection":"employees"}},"settlements":{"employee":{"collection":"employees"}},"leave-encashments":{"employee":{"collection":"employees"}},"leave-adjustments":{"employee":{"collection":"employees"}},"payroll-openings":{"employee":{"collection":"employees"}},"approval-delegations":{"delegator":{"collection":"employees"}},"background-checks":{"employee":{"collection":"employees"}}},"state_visibility":{"announcements":{"requires":"write","public_when":{"published":true,"disabled":false}}},"audit":{"sensitive_subresources":["bank-account","identity","tax"],"sensitive_collections":["compensation","payslips","settlements","background-checks","offers","payroll-openings"],"sensitive_verbs":["employees:downloadIdentityDoc","payslips:preview","payslips:download","payroll-runs:bankFile","payroll-runs:statutoryReport","personal-documents:download","personal-documents:previewLetter","candidates:download","referrals:download","tax-declarations:download","leave-requests:download","tickets:attachment","reimbursements:download","offers:letter"]},"supported_scopes":{"employees":["self","reports","org","dept","all"],"leave-requests":["self","reports","org","dept","all"],"goals":["self","reports","org","dept","all"],"cards":["self","reports","org","dept","all"],"reviews":["self","reports","org","dept","all"],"review-feedback":["self","reports","org","dept","all"],"transitions":["self","reports","org","dept","all"],"transition-tasks":["self","reports","org","dept","all"],"check-ins":["self","reports","org","dept","all"],"dependents":["self","reports","org","dept","all"],"benefit-enrollments":["self","reports","org","dept","all"],"shift-assignments":["self","reports","org","dept","all"],"work-pattern-assignments":["self","reports","org","dept","all"],"time-entries":["self","reports","org","dept","all"],"loans":["self","reports","org","dept","all"],"tax-declarations":["self","reports","org","dept","all"],"referrals":["self","reports","org","dept","all"],"interview-feedback":["self","reports","org","dept","all"],"background-checks":["self","reports","org","dept","all"],"assets":["self","reports","org","dept","all"],"leave-balances":["self","reports","org","dept","all"],"leave-encashments":["self","reports","org","dept","all"],"leave-adjustments":["self","reports","org","dept","all"],"payroll-openings":["self","reports","org","dept","all"],"attendance":["self","reports","org","dept","all"],"attendance-regularizations":["self","reports","org","dept","all"],"attendance-day-marks":["self","reports","org","dept","all"],"overtime-requests":["self","reports","org","dept","all"],"remote-work-requests":["self","reports","org","dept","all"],"late-early-requests":["self","reports","org","dept","all"],"asset-requests":["self","reports","org","dept","all"],"notice-periods":["self","reports","org","dept","all"],"announcements":["self","reports","org","dept","all"],"suggestions":["self","reports","org","dept","all"],"document-acknowledgements":["self","reports","org","dept","all"],"personal-documents":["self","all"],"payslips":["self","reports","org","dept","all"],"reimbursements":["self","reports","org","dept","all"],"compensation":["self","reports","org","dept","all"],"positions":["self","reports","org","dept","all"],"bonuses":["self","reports","org","dept","all"],"settlements":["self","reports","org","dept","all"],"operations":["self","all"],"tickets":["self","all"],"table-views":["self","all"],"expenses":["self","reports","org","dept","all"],"approval-delegations":["self","all"],"users":["self","all"],"departments":["subtree","all"],"activity":["self","reports","org","dept","all"]},"redacted_fields":{"offers":["base_comp"],"candidates":["email","phone","notes"],"leave-requests":["reason"],"tickets":["description"],"assets":["purchase_cost","book_value"],"background-checks":["cost"],"employees":["probation_end_date"]}}',
    updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE key = 'manifest' AND (json_type(value_json, '$.protected_fields') IS NULL
    OR json_type(value_json, '$.references') IS NULL
    OR json_type(value_json, '$.owner_refs') IS NULL
    OR json_type(value_json, '$.state_visibility') IS NULL
    OR json_type(value_json, '$.audit') IS NULL);
--> statement-breakpoint
UPDATE policy
SET value_json = json_set(value_json, '$.supported_scopes', json('{"employees":["self","reports","org","dept","all"],"leave-requests":["self","reports","org","dept","all"],"goals":["self","reports","org","dept","all"],"cards":["self","reports","org","dept","all"],"reviews":["self","reports","org","dept","all"],"review-feedback":["self","reports","org","dept","all"],"transitions":["self","reports","org","dept","all"],"transition-tasks":["self","reports","org","dept","all"],"check-ins":["self","reports","org","dept","all"],"dependents":["self","reports","org","dept","all"],"benefit-enrollments":["self","reports","org","dept","all"],"shift-assignments":["self","reports","org","dept","all"],"work-pattern-assignments":["self","reports","org","dept","all"],"time-entries":["self","reports","org","dept","all"],"loans":["self","reports","org","dept","all"],"tax-declarations":["self","reports","org","dept","all"],"referrals":["self","reports","org","dept","all"],"interview-feedback":["self","reports","org","dept","all"],"background-checks":["self","reports","org","dept","all"],"assets":["self","reports","org","dept","all"],"leave-balances":["self","reports","org","dept","all"],"leave-encashments":["self","reports","org","dept","all"],"leave-adjustments":["self","reports","org","dept","all"],"payroll-openings":["self","reports","org","dept","all"],"attendance":["self","reports","org","dept","all"],"attendance-regularizations":["self","reports","org","dept","all"],"attendance-day-marks":["self","reports","org","dept","all"],"overtime-requests":["self","reports","org","dept","all"],"remote-work-requests":["self","reports","org","dept","all"],"late-early-requests":["self","reports","org","dept","all"],"asset-requests":["self","reports","org","dept","all"],"notice-periods":["self","reports","org","dept","all"],"announcements":["self","reports","org","dept","all"],"suggestions":["self","reports","org","dept","all"],"document-acknowledgements":["self","reports","org","dept","all"],"personal-documents":["self","all"],"payslips":["self","reports","org","dept","all"],"reimbursements":["self","reports","org","dept","all"],"compensation":["self","reports","org","dept","all"],"positions":["self","reports","org","dept","all"],"bonuses":["self","reports","org","dept","all"],"settlements":["self","reports","org","dept","all"],"operations":["self","all"],"tickets":["self","all"],"table-views":["self","all"],"expenses":["self","reports","org","dept","all"],"approval-delegations":["self","all"],"users":["self","all"],"departments":["subtree","all"],"activity":["self","reports","org","dept","all"]}')),
    updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE key = 'manifest' AND json_type(value_json, '$.supported_scopes') IS NULL;
--> statement-breakpoint

-- The policy manifest entries for `work-pattern-assignments` (bootstrap/authz/policy.ts; work-schedules-plan.md).
--
-- PRODUCTION READS THE `policy` ROW, NOT THE TYPED DEFAULTS, so registering a collection in
-- bootstrap/authz/policy.ts and regenerating seed.sql reaches a FRESH database and nothing else. 0008 added
-- the tables and the collections but not these three entries, which is a gap only a live upgrade would show:
-- every test migrates from zero, where the bootstrap supplies the whole manifest.
--
-- 0012 does not cover it either. Its statements fire only where the row is unreadable or missing a section -
-- it leaves a COMPLETE row byte-for-byte alone on purpose (test/policyManifestMigration.test.ts) - and a live
-- row is complete. So the entries have to be written here, the way 0002, 0005 and 0006 write theirs.
--
-- THE OWNER REF IS THE HALF THAT MATTERS FOR SAFETY. Without it, once an admin grants the collection there is
-- nothing binding a created row to the caller's own employee - so somebody could be put on a schedule they did
-- not choose, and which days they are owed (and therefore what a day of absence costs them) would change
-- underneath them.
--
-- Data only. Each statement touches a manifest that LACKS the entry, so a re-run changes nothing, an entry an
-- admin already wrote is kept, and this stays correct whichever side of 0012 it lands on.
UPDATE policy
SET value_json = json_set(value_json, '$.owner_refs."work-pattern-assignments"', json('{"employee":{"collection":"employees"}}')),
    updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE key = 'manifest'
  AND json_type(value_json, '$.owner_refs') = 'object'
  AND json_type(value_json, '$.owner_refs."work-pattern-assignments"') IS NULL;
--> statement-breakpoint
-- The pattern reference: naming one in a write requires being able to READ it, so a caller cannot put somebody
-- on a schedule whose existence they cannot otherwise see.
UPDATE policy
SET value_json = json_set(value_json, '$.references."work-pattern-assignments"', json('{"pattern":{"collection":"work-patterns","level":"read"}}')),
    updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE key = 'manifest'
  AND json_type(value_json, '$.references') = 'object'
  AND json_type(value_json, '$.references."work-pattern-assignments"') IS NULL;
--> statement-breakpoint
-- The scope tiers an admin can author a rule at. Without them the collection cannot be granted self- or
-- dept-scoped at all, so the only usable rule is org-wide.
UPDATE policy
SET value_json = json_set(value_json, '$.supported_scopes."work-pattern-assignments"', json('["self","reports","org","dept","all"]')),
    updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE key = 'manifest'
  AND json_type(value_json, '$.supported_scopes') = 'object'
  AND json_type(value_json, '$.supported_scopes."work-pattern-assignments"') IS NULL;
--> statement-breakpoint

-- Global search stops matching an employee's LEGAL name (src/domain/searchIndex.ts). It is a redacted field:
-- someone's legal name can differ from the one they go by, and the directory every employee reads never shows
-- it, but matching on it let anybody confirm a guess ("whose legal name is X?") through search.
--
-- 1. The employees insert/update triggers, regenerated without it (printed by scripts/genSearchDdl.ts).
-- 2. The rows ALREADY in the index. A changed trigger only reindexes a row the next time it is written, so
--    without this every existing employee's legal name would stay searchable until their record changed. Their
--    text is rewritten with exactly the expression the new triggers use. Idempotent; on a fresh database it
--    rewrites whatever the 0000 backfill indexed, which is nothing.
DROP TRIGGER IF EXISTS "search_ai_employees";
--> statement-breakpoint
CREATE TRIGGER "search_ai_employees" AFTER INSERT ON "employees" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('employees', new."uuid", new."code", new."uuid", nullif(trim(coalesce(new."first_name", '') || ' ' || coalesce(new."last_name", '')), ''), coalesce(nullif(trim(new."job_title"), ''), nullif(trim(new."work_email"), '')), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."first_name", '') || ' ' || coalesce(new."last_name", '') || ' ' || coalesce(new."work_email", '') || ' ' || coalesce(new."job_title", '') || ' ' || coalesce(new."employee_number", ''));
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_employees";
--> statement-breakpoint
CREATE TRIGGER "search_au_employees" AFTER UPDATE ON "employees" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."uuid", "title" = nullif(trim(coalesce(new."first_name", '') || ' ' || coalesce(new."last_name", '')), ''), "subtitle" = coalesce(nullif(trim(new."job_title"), ''), nullif(trim(new."work_email"), '')), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'employees' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."first_name", '') || ' ' || coalesce(new."last_name", '') || ' ' || coalesce(new."work_email", '') || ' ' || coalesce(new."job_title", '') || ' ' || coalesce(new."employee_number", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'employees' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
UPDATE "search_fts"
SET "text" = (
  SELECT coalesce(e."first_name", '') || ' ' || coalesce(e."last_name", '') || ' ' || coalesce(e."work_email", '') || ' ' || coalesce(e."job_title", '') || ' ' || coalesce(e."employee_number", '')
  FROM "search_docs" d JOIN "employees" e ON e."uuid" = d."record_id"
  WHERE d."rowid" = "search_fts"."rowid"
)
WHERE "rowid" IN (
  SELECT d."rowid" FROM "search_docs" d JOIN "employees" e ON e."uuid" = d."record_id" WHERE d."collection" = 'employees'
);
--> statement-breakpoint

-- How many days ahead a birthday or work anniversary starts to show (settings/celebrations `lead_days`; 0 = only
-- on the day). The dashboard used to show everything in the next 30 days, which put a colleague's birthday on
-- screen weeks before it; the org now sets the window in Settings → Dashboard visibility → Celebrations.
--
-- The feed has no built-in window to fall back on (services/celebrations.ts#celebrationLeadDays refuses a
-- missing row), so the row is written here for every existing database: a week, the window the dashboard's
-- "this week" count already used. Data only. OR IGNORE keeps a row an admin already saved, and lets
-- bootstrap/bootstrap.sql (which seeds the same value, and inserts OR IGNORE) run after it on a fresh database.
INSERT OR IGNORE INTO `settings` (`key`, `value`, `updated_at`)
VALUES ('celebrations', '{"lead_days":7}', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));

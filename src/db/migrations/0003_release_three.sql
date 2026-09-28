-- Read indexes for `access_rules` (see the index notes in db/schema.ts). Additive only: no row changes.
CREATE INDEX `ar_subject_kind_match_idx` ON `access_rules` (`subject`,`subject_kind`,`match_code`);--> statement-breakpoint
CREATE INDEX `ar_created_idx` ON `access_rules` (`created_at`,`uuid`);
--> statement-breakpoint

-- The counters the server's in-memory caches are checked against (lib/cacheGenerations.ts, db/schema.ts
-- `cache_generations`). One row, and a trigger on every table a cache is loaded from, so a write moves its
-- counter in the same transaction whoever makes it: a service, a cron, the code cascade, a migration, hand-run SQL.
--
-- `access_rules` feeds two counters. A role's broad rules (subject_kind 'role', no match_code) are what every
-- request's grant is built from; everything else there (user rules, per-object rules, the ticket shares a routine
-- `:assign` writes) is read per caller. Kept apart, a ticket assignment reloads a few rows per caller rather than
-- every role's whole grant. The 0/1 arithmetic stands in for CASE, which wrangler's splitter cannot parse here.
CREATE TABLE `cache_generations` (
	`id` integer PRIMARY KEY NOT NULL,
	`role_rules` integer DEFAULT 0 NOT NULL,
	`acl_rules` integer DEFAULT 0 NOT NULL,
	`user_roles` integer DEFAULT 0 NOT NULL,
	`policy` integer DEFAULT 0 NOT NULL,
	`roles` integer DEFAULT 0 NOT NULL,
	`org` integer DEFAULT 0 NOT NULL,
	`codes` integer DEFAULT 0 NOT NULL,
	`automations` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT INTO "cache_generations" ("id") VALUES (1);
--> statement-breakpoint
CREATE TRIGGER "gen_access_rules_i" AFTER INSERT ON "access_rules" BEGIN
  UPDATE "cache_generations" SET
    "role_rules" = "role_rules" + (NEW."subject_kind" = 'role' AND NEW."match_code" IS NULL),
    "acl_rules" = "acl_rules" + (NOT (NEW."subject_kind" = 'role' AND NEW."match_code" IS NULL))
  WHERE "id" = 1;
END;
--> statement-breakpoint
CREATE TRIGGER "gen_access_rules_u" AFTER UPDATE ON "access_rules" BEGIN
  UPDATE "cache_generations" SET
    "role_rules" = "role_rules" + ((OLD."subject_kind" = 'role' AND OLD."match_code" IS NULL) OR (NEW."subject_kind" = 'role' AND NEW."match_code" IS NULL)),
    "acl_rules" = "acl_rules" + ((NOT (OLD."subject_kind" = 'role' AND OLD."match_code" IS NULL)) OR (NOT (NEW."subject_kind" = 'role' AND NEW."match_code" IS NULL)))
  WHERE "id" = 1;
END;
--> statement-breakpoint
CREATE TRIGGER "gen_access_rules_d" AFTER DELETE ON "access_rules" BEGIN
  UPDATE "cache_generations" SET
    "role_rules" = "role_rules" + (OLD."subject_kind" = 'role' AND OLD."match_code" IS NULL),
    "acl_rules" = "acl_rules" + (NOT (OLD."subject_kind" = 'role' AND OLD."match_code" IS NULL))
  WHERE "id" = 1;
END;
--> statement-breakpoint
CREATE TRIGGER "gen_user_roles_i" AFTER INSERT ON "user_roles" BEGIN
  UPDATE "cache_generations" SET "user_roles" = "user_roles" + 1 WHERE "id" = 1;
END;
--> statement-breakpoint
CREATE TRIGGER "gen_user_roles_u" AFTER UPDATE ON "user_roles" BEGIN
  UPDATE "cache_generations" SET "user_roles" = "user_roles" + 1 WHERE "id" = 1;
END;
--> statement-breakpoint
CREATE TRIGGER "gen_user_roles_d" AFTER DELETE ON "user_roles" BEGIN
  UPDATE "cache_generations" SET "user_roles" = "user_roles" + 1 WHERE "id" = 1;
END;
--> statement-breakpoint
CREATE TRIGGER "gen_policy_i" AFTER INSERT ON "policy" BEGIN
  UPDATE "cache_generations" SET "policy" = "policy" + 1 WHERE "id" = 1;
END;
--> statement-breakpoint
CREATE TRIGGER "gen_policy_u" AFTER UPDATE ON "policy" BEGIN
  UPDATE "cache_generations" SET "policy" = "policy" + 1 WHERE "id" = 1;
END;
--> statement-breakpoint
CREATE TRIGGER "gen_policy_d" AFTER DELETE ON "policy" BEGIN
  UPDATE "cache_generations" SET "policy" = "policy" + 1 WHERE "id" = 1;
END;
--> statement-breakpoint
CREATE TRIGGER "gen_roles_i" AFTER INSERT ON "roles" BEGIN
  UPDATE "cache_generations" SET "roles" = "roles" + 1 WHERE "id" = 1;
END;
--> statement-breakpoint
CREATE TRIGGER "gen_roles_u" AFTER UPDATE ON "roles" BEGIN
  UPDATE "cache_generations" SET "roles" = "roles" + 1 WHERE "id" = 1;
END;
--> statement-breakpoint
CREATE TRIGGER "gen_roles_d" AFTER DELETE ON "roles" BEGIN
  UPDATE "cache_generations" SET "roles" = "roles" + 1 WHERE "id" = 1;
END;
--> statement-breakpoint
CREATE TRIGGER "gen_automations_i" AFTER INSERT ON "automations" BEGIN
  UPDATE "cache_generations" SET "automations" = "automations" + 1 WHERE "id" = 1;
END;
--> statement-breakpoint
CREATE TRIGGER "gen_automations_u" AFTER UPDATE ON "automations" BEGIN
  UPDATE "cache_generations" SET "automations" = "automations" + 1 WHERE "id" = 1;
END;
--> statement-breakpoint
CREATE TRIGGER "gen_automations_d" AFTER DELETE ON "automations" BEGIN
  UPDATE "cache_generations" SET "automations" = "automations" + 1 WHERE "id" = 1;
END;
--> statement-breakpoint
CREATE TRIGGER "gen_employees_i" AFTER INSERT ON "employees" BEGIN
  UPDATE "cache_generations" SET "org" = "org" + 1 WHERE "id" = 1;
END;
--> statement-breakpoint
CREATE TRIGGER "gen_employees_u" AFTER UPDATE OF "manager_id", "code", "delete_time" ON "employees"
WHEN OLD."manager_id" IS NOT NEW."manager_id" OR OLD."code" IS NOT NEW."code" OR OLD."delete_time" IS NOT NEW."delete_time" BEGIN
  UPDATE "cache_generations" SET "org" = "org" + 1, "codes" = "codes" + (OLD."code" IS NOT NEW."code") WHERE "id" = 1;
END;
--> statement-breakpoint
CREATE TRIGGER "gen_employees_d" AFTER DELETE ON "employees" BEGIN
  UPDATE "cache_generations" SET "org" = "org" + 1 WHERE "id" = 1;
END;
--> statement-breakpoint
CREATE TRIGGER "gen_departments_u" AFTER UPDATE OF "code" ON "departments" WHEN OLD."code" IS NOT NEW."code" BEGIN
  UPDATE "cache_generations" SET "codes" = "codes" + 1 WHERE "id" = 1;
END;

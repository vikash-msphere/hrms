CREATE TABLE `search_counts` (
	`collection` text NOT NULL,
	`parent_code` text DEFAULT '' NOT NULL,
	`owner_id` text DEFAULT '' NOT NULL,
	`restricted` integer DEFAULT false NOT NULL,
	`n` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`collection`, `parent_code`, `owner_id`, `restricted`)
);
--> statement-breakpoint
CREATE INDEX `search_counts_owner_idx` ON `search_counts` (`owner_id`);
--> statement-breakpoint
-- `search_counts` kept in step with `search_docs` (see the table's note in src/db/schema.ts). The parent code is
-- the code with its last segment taken off: codes are lowercase Crockford base32 segments joined by '-'
-- (src/domain/codes.ts), so stripping trailing base32 characters and then the '-' leaves the parent - and
-- leaves '' for a one-segment code. A row counts only while it is not deleted.
CREATE TRIGGER "search_counts_ins" AFTER INSERT ON "search_docs" WHEN new."deleted" = 0 BEGIN
  INSERT INTO "search_counts" ("collection", "parent_code", "owner_id", "restricted", "n")
  VALUES (new."collection", coalesce(rtrim(rtrim(new."code", '0123456789abcdefghjkmnpqrstvwxyz'), '-'), ''), coalesce(new."owner_id", ''), new."restricted", 1)
  ON CONFLICT DO UPDATE SET "n" = "n" + 1;
END;
--> statement-breakpoint
CREATE TRIGGER "search_counts_del" AFTER DELETE ON "search_docs" WHEN old."deleted" = 0 BEGIN
  UPDATE "search_counts" SET "n" = "n" - 1
  WHERE "collection" = old."collection" AND "parent_code" = coalesce(rtrim(rtrim(old."code", '0123456789abcdefghjkmnpqrstvwxyz'), '-'), '')
    AND "owner_id" = coalesce(old."owner_id", '') AND "restricted" = old."restricted";
END;
--> statement-breakpoint
-- Only when something the count is grouped by, or whether the row counts, actually changed: the source tables'
-- update triggers rewrite `code` and `owner_id` on every edit, mostly to the same values, and a title edit must
-- not cost two counter writes.
CREATE TRIGGER "search_counts_upd" AFTER UPDATE ON "search_docs"
WHEN old."collection" IS NOT new."collection" OR old."code" IS NOT new."code" OR old."owner_id" IS NOT new."owner_id"
  OR old."deleted" IS NOT new."deleted" OR old."restricted" IS NOT new."restricted"
BEGIN
  UPDATE "search_counts" SET "n" = "n" - 1
  WHERE old."deleted" = 0 AND "collection" = old."collection"
    AND "parent_code" = coalesce(rtrim(rtrim(old."code", '0123456789abcdefghjkmnpqrstvwxyz'), '-'), '')
    AND "owner_id" = coalesce(old."owner_id", '') AND "restricted" = old."restricted";
  INSERT INTO "search_counts" ("collection", "parent_code", "owner_id", "restricted", "n")
  SELECT new."collection", coalesce(rtrim(rtrim(new."code", '0123456789abcdefghjkmnpqrstvwxyz'), '-'), ''), coalesce(new."owner_id", ''), new."restricted", 1
  WHERE new."deleted" = 0
  ON CONFLICT DO UPDATE SET "n" = "n" + 1;
END;
--> statement-breakpoint
-- The rows already indexed, counted once.
INSERT INTO "search_counts" ("collection", "parent_code", "owner_id", "restricted", "n")
SELECT "collection", coalesce(rtrim(rtrim("code", '0123456789abcdefghjkmnpqrstvwxyz'), '-'), ''), coalesce("owner_id", ''), "restricted", count(*)
FROM "search_docs" WHERE "deleted" = 0
GROUP BY 1, 2, 3, 4;

-- `search_counts` counts what words can find: a live `search_docs` row WITH a title. A row without one (an
-- attendance punch with no note, a leave encashment, which has no title column at all) is indexed so `in:` and
-- the filters can list it, but no typed word reaches it and the palette shows it as just its kind's name - and
-- counting it put the kinds with the most such rows (attendance grows people x days) first in the `in:` chips.
-- The index writes a blank title as NULL (src/db/searchDdl.ts `nullif(trim(...))`), so `title IS NOT NULL` is
-- the whole test. The triggers are 0010's with that added; the counters are recounted from scratch.
DROP TRIGGER IF EXISTS "search_counts_ins";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_counts_del";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_counts_upd";
--> statement-breakpoint
CREATE TRIGGER "search_counts_ins" AFTER INSERT ON "search_docs" WHEN new."deleted" = 0 AND new."title" IS NOT NULL BEGIN
  INSERT INTO "search_counts" ("collection", "parent_code", "owner_id", "restricted", "n")
  VALUES (new."collection", coalesce(rtrim(rtrim(new."code", '0123456789abcdefghjkmnpqrstvwxyz'), '-'), ''), coalesce(new."owner_id", ''), new."restricted", 1)
  ON CONFLICT DO UPDATE SET "n" = "n" + 1;
END;
--> statement-breakpoint
CREATE TRIGGER "search_counts_del" AFTER DELETE ON "search_docs" WHEN old."deleted" = 0 AND old."title" IS NOT NULL BEGIN
  UPDATE "search_counts" SET "n" = "n" - 1
  WHERE "collection" = old."collection" AND "parent_code" = coalesce(rtrim(rtrim(old."code", '0123456789abcdefghjkmnpqrstvwxyz'), '-'), '')
    AND "owner_id" = coalesce(old."owner_id", '') AND "restricted" = old."restricted";
END;
--> statement-breakpoint
-- Only when something the count is grouped by, or whether the row counts, actually changed. A title edit is a
-- change of whether it counts only when the title appears or goes; any other edit of it costs no counter write.
CREATE TRIGGER "search_counts_upd" AFTER UPDATE ON "search_docs"
WHEN old."collection" IS NOT new."collection" OR old."code" IS NOT new."code" OR old."owner_id" IS NOT new."owner_id"
  OR old."deleted" IS NOT new."deleted" OR old."restricted" IS NOT new."restricted"
  OR (old."title" IS NULL) IS NOT (new."title" IS NULL)
BEGIN
  UPDATE "search_counts" SET "n" = "n" - 1
  WHERE old."deleted" = 0 AND old."title" IS NOT NULL AND "collection" = old."collection"
    AND "parent_code" = coalesce(rtrim(rtrim(old."code", '0123456789abcdefghjkmnpqrstvwxyz'), '-'), '')
    AND "owner_id" = coalesce(old."owner_id", '') AND "restricted" = old."restricted";
  INSERT INTO "search_counts" ("collection", "parent_code", "owner_id", "restricted", "n")
  SELECT new."collection", coalesce(rtrim(rtrim(new."code", '0123456789abcdefghjkmnpqrstvwxyz'), '-'), ''), coalesce(new."owner_id", ''), new."restricted", 1
  WHERE new."deleted" = 0 AND new."title" IS NOT NULL
  ON CONFLICT DO UPDATE SET "n" = "n" + 1;
END;
--> statement-breakpoint
DELETE FROM "search_counts";
--> statement-breakpoint
INSERT INTO "search_counts" ("collection", "parent_code", "owner_id", "restricted", "n")
SELECT "collection", coalesce(rtrim(rtrim("code", '0123456789abcdefghjkmnpqrstvwxyz'), '-'), ''), coalesce("owner_id", ''), "restricted", count(*)
FROM "search_docs" WHERE "deleted" = 0 AND "title" IS NOT NULL
GROUP BY 1, 2, 3, 4;

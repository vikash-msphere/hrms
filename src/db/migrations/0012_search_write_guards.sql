-- The search index stops paying for writes that change nothing it holds (src/db/searchDdl.ts, "WHAT A WRITE
-- COSTS"). A clock-in wrote about 30 D1 rows, most of them FTS5 internals for the text " clock": every punch
-- matched its two-value `source` column, and every clock-out rewrote the doc and its FTS row although search
-- reads neither `clock_out` nor anything else a clock-out touches.
--
-- 1. The rows ALREADY in the index. Attendance stops matching `source`, so its keyword text is rewritten with
--    the expression the new triggers use - only the note, and no FTS row at all for a punch without one. Then
--    any other doc whose text has no word in it loses its FTS row, which no typed word could reach anyway; its
--    `search_docs` row stays, so `in:` and the filters still list it. Idempotent; a no-op on a fresh database.
-- 2. The insert and update triggers of every searchable collection, regenerated (printed by
--    scripts/genSearchDdl.ts): no FTS row for a doc with no words, and an update fires only when a column the
--    index reads changed, rewriting the FTS row only when a matched column did.
DELETE FROM "search_fts" WHERE "rowid" IN (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'attendance');
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text")
SELECT d."rowid", coalesce(t."note", '') FROM "search_docs" d JOIN "attendance_sessions" t ON t."uuid" = d."record_id"
WHERE d."collection" = 'attendance' AND trim(coalesce(t."note", '')) <> '';
--> statement-breakpoint
DELETE FROM "search_fts" WHERE trim("text") = '';
--> statement-breakpoint
-- Search index delta (printed by scripts/genSearchDdl.ts).
DROP TRIGGER IF EXISTS "search_ai_employees";
--> statement-breakpoint
CREATE TRIGGER "search_ai_employees" AFTER INSERT ON "employees" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('employees', new."uuid", new."code", new."uuid", nullif(trim(coalesce(new."first_name", '') || ' ' || coalesce(new."last_name", '')), ''), coalesce(nullif(trim(new."job_title"), ''), nullif(trim(new."work_email"), '')), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."first_name", '') || ' ' || coalesce(new."last_name", '') || ' ' || coalesce(new."work_email", '') || ' ' || coalesce(new."job_title", '') || ' ' || coalesce(new."employee_number", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_employees";
--> statement-breakpoint
CREATE TRIGGER "search_au_employees" AFTER UPDATE ON "employees"
WHEN old."code" IS NOT new."code" OR old."uuid" IS NOT new."uuid" OR old."first_name" IS NOT new."first_name" OR old."last_name" IS NOT new."last_name" OR old."job_title" IS NOT new."job_title" OR old."work_email" IS NOT new."work_email" OR old."employee_number" IS NOT new."employee_number" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."uuid", "title" = nullif(trim(coalesce(new."first_name", '') || ' ' || coalesce(new."last_name", '')), ''), "subtitle" = coalesce(nullif(trim(new."job_title"), ''), nullif(trim(new."work_email"), '')), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'employees' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'employees' AND "record_id" = new."uuid") AND (old."first_name" IS NOT new."first_name" OR old."last_name" IS NOT new."last_name" OR old."work_email" IS NOT new."work_email" OR old."job_title" IS NOT new."job_title" OR old."employee_number" IS NOT new."employee_number");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'employees' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."first_name", '') || ' ' || coalesce(new."last_name", '') || ' ' || coalesce(new."work_email", '') || ' ' || coalesce(new."job_title", '') || ' ' || coalesce(new."employee_number", '') AS "text") WHERE trim("text") <> '' AND (old."first_name" IS NOT new."first_name" OR old."last_name" IS NOT new."last_name" OR old."work_email" IS NOT new."work_email" OR old."job_title" IS NOT new."job_title" OR old."employee_number" IS NOT new."employee_number");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_departments";
--> statement-breakpoint
CREATE TRIGGER "search_ai_departments" AFTER INSERT ON "departments" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('departments', new."uuid", new."code", new."code", nullif(trim(new."name"), ''), NULL, (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."name", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_departments";
--> statement-breakpoint
CREATE TRIGGER "search_au_departments" AFTER UPDATE ON "departments"
WHEN old."code" IS NOT new."code" OR old."name" IS NOT new."name" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."code", "title" = nullif(trim(new."name"), ''), "subtitle" = NULL, "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'departments' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'departments' AND "record_id" = new."uuid") AND (old."name" IS NOT new."name");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'departments' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."name", '') AS "text") WHERE trim("text") <> '' AND (old."name" IS NOT new."name");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_positions";
--> statement-breakpoint
CREATE TRIGGER "search_ai_positions" AFTER INSERT ON "positions" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('positions', new."uuid", new."code", new."employee_id", nullif(trim(new."job_title"), ''), coalesce(nullif(trim(new."location"), ''), nullif(trim(new."note"), '')), 0, 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."job_title", '') || ' ' || coalesce(new."location", '') || ' ' || coalesce(new."note", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_positions";
--> statement-breakpoint
CREATE TRIGGER "search_au_positions" AFTER UPDATE ON "positions"
WHEN old."code" IS NOT new."code" OR old."employee_id" IS NOT new."employee_id" OR old."job_title" IS NOT new."job_title" OR old."location" IS NOT new."location" OR old."note" IS NOT new."note" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."job_title"), ''), "subtitle" = coalesce(nullif(trim(new."location"), ''), nullif(trim(new."note"), '')), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'positions' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'positions' AND "record_id" = new."uuid") AND (old."job_title" IS NOT new."job_title" OR old."location" IS NOT new."location" OR old."note" IS NOT new."note");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'positions' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."job_title", '') || ' ' || coalesce(new."location", '') || ' ' || coalesce(new."note", '') AS "text") WHERE trim("text") <> '' AND (old."job_title" IS NOT new."job_title" OR old."location" IS NOT new."location" OR old."note" IS NOT new."note");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_leave_requests";
--> statement-breakpoint
CREATE TRIGGER "search_ai_leave_requests" AFTER INSERT ON "leave_requests" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('leave-requests', new."uuid", new."code", new."employee_id", nullif(trim(new."reason"), ''), nullif(trim(new."state"), ''), 0, 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."reason", '') || ' ' || coalesce(new."state", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_leave_requests";
--> statement-breakpoint
CREATE TRIGGER "search_au_leave_requests" AFTER UPDATE ON "leave_requests"
WHEN old."code" IS NOT new."code" OR old."employee_id" IS NOT new."employee_id" OR old."reason" IS NOT new."reason" OR old."state" IS NOT new."state" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."reason"), ''), "subtitle" = nullif(trim(new."state"), ''), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'leave-requests' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'leave-requests' AND "record_id" = new."uuid") AND (old."reason" IS NOT new."reason" OR old."state" IS NOT new."state");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'leave-requests' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."reason", '') || ' ' || coalesce(new."state", '') AS "text") WHERE trim("text") <> '' AND (old."reason" IS NOT new."reason" OR old."state" IS NOT new."state");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_leave_encashments";
--> statement-breakpoint
CREATE TRIGGER "search_ai_leave_encashments" AFTER INSERT ON "leave_encashments" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('leave-encashments', new."uuid", new."code", new."employee_id", NULL, nullif(trim(new."state"), ''), 0, 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."state", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_leave_encashments";
--> statement-breakpoint
CREATE TRIGGER "search_au_leave_encashments" AFTER UPDATE ON "leave_encashments"
WHEN old."code" IS NOT new."code" OR old."employee_id" IS NOT new."employee_id" OR old."state" IS NOT new."state" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = NULL, "subtitle" = nullif(trim(new."state"), ''), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'leave-encashments' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'leave-encashments' AND "record_id" = new."uuid") AND (old."state" IS NOT new."state");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'leave-encashments' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."state", '') AS "text") WHERE trim("text") <> '' AND (old."state" IS NOT new."state");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_leave_types";
--> statement-breakpoint
CREATE TRIGGER "search_ai_leave_types" AFTER INSERT ON "leave_types" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('leave-types', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), NULL, (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."name", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_leave_types";
--> statement-breakpoint
CREATE TRIGGER "search_au_leave_types" AFTER UPDATE ON "leave_types"
WHEN old."code" IS NOT new."code" OR old."name" IS NOT new."name" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = NULL, "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'leave-types' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'leave-types' AND "record_id" = new."uuid") AND (old."name" IS NOT new."name");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'leave-types' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."name", '') AS "text") WHERE trim("text") <> '' AND (old."name" IS NOT new."name");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_holidays";
--> statement-breakpoint
CREATE TRIGGER "search_ai_holidays" AFTER INSERT ON "holidays" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('holidays', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), nullif(trim(new."kind"), ''), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."kind", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_holidays";
--> statement-breakpoint
CREATE TRIGGER "search_au_holidays" AFTER UPDATE ON "holidays"
WHEN old."code" IS NOT new."code" OR old."name" IS NOT new."name" OR old."kind" IS NOT new."kind" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = nullif(trim(new."kind"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'holidays' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'holidays' AND "record_id" = new."uuid") AND (old."name" IS NOT new."name" OR old."kind" IS NOT new."kind");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'holidays' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."kind", '') AS "text") WHERE trim("text") <> '' AND (old."name" IS NOT new."name" OR old."kind" IS NOT new."kind");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_attendance";
--> statement-breakpoint
CREATE TRIGGER "search_ai_attendance" AFTER INSERT ON "attendance_sessions" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('attendance', new."uuid", new."code", new."employee_id", nullif(trim(new."note"), ''), nullif(trim(new."source"), ''), 0, 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."note", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_attendance";
--> statement-breakpoint
CREATE TRIGGER "search_au_attendance" AFTER UPDATE ON "attendance_sessions"
WHEN old."code" IS NOT new."code" OR old."employee_id" IS NOT new."employee_id" OR old."note" IS NOT new."note" OR old."source" IS NOT new."source" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."note"), ''), "subtitle" = nullif(trim(new."source"), ''), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'attendance' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'attendance' AND "record_id" = new."uuid") AND (old."note" IS NOT new."note");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'attendance' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."note", '') AS "text") WHERE trim("text") <> '' AND (old."note" IS NOT new."note");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_attendance_regularizations";
--> statement-breakpoint
CREATE TRIGGER "search_ai_attendance_regularizations" AFTER INSERT ON "attendance_regularizations" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('attendance-regularizations', new."uuid", new."code", new."employee_id", nullif(trim(new."reason"), ''), nullif(trim(new."state"), ''), 0, 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."reason", '') || ' ' || coalesce(new."state", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_attendance_regularizations";
--> statement-breakpoint
CREATE TRIGGER "search_au_attendance_regularizations" AFTER UPDATE ON "attendance_regularizations"
WHEN old."code" IS NOT new."code" OR old."employee_id" IS NOT new."employee_id" OR old."reason" IS NOT new."reason" OR old."state" IS NOT new."state" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."reason"), ''), "subtitle" = nullif(trim(new."state"), ''), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'attendance-regularizations' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'attendance-regularizations' AND "record_id" = new."uuid") AND (old."reason" IS NOT new."reason" OR old."state" IS NOT new."state");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'attendance-regularizations' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."reason", '') || ' ' || coalesce(new."state", '') AS "text") WHERE trim("text") <> '' AND (old."reason" IS NOT new."reason" OR old."state" IS NOT new."state");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_overtime_requests";
--> statement-breakpoint
CREATE TRIGGER "search_ai_overtime_requests" AFTER INSERT ON "overtime_requests" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('overtime-requests', new."uuid", new."code", new."employee_id", nullif(trim(new."reason"), ''), nullif(trim(new."state"), ''), 0, 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."reason", '') || ' ' || coalesce(new."state", '') || ' ' || coalesce(new."decision_note", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_overtime_requests";
--> statement-breakpoint
CREATE TRIGGER "search_au_overtime_requests" AFTER UPDATE ON "overtime_requests"
WHEN old."code" IS NOT new."code" OR old."employee_id" IS NOT new."employee_id" OR old."reason" IS NOT new."reason" OR old."state" IS NOT new."state" OR old."decision_note" IS NOT new."decision_note" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."reason"), ''), "subtitle" = nullif(trim(new."state"), ''), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'overtime-requests' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'overtime-requests' AND "record_id" = new."uuid") AND (old."reason" IS NOT new."reason" OR old."state" IS NOT new."state" OR old."decision_note" IS NOT new."decision_note");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'overtime-requests' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."reason", '') || ' ' || coalesce(new."state", '') || ' ' || coalesce(new."decision_note", '') AS "text") WHERE trim("text") <> '' AND (old."reason" IS NOT new."reason" OR old."state" IS NOT new."state" OR old."decision_note" IS NOT new."decision_note");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_remote_work_requests";
--> statement-breakpoint
CREATE TRIGGER "search_ai_remote_work_requests" AFTER INSERT ON "remote_work_requests" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('remote-work-requests', new."uuid", new."code", new."employee_id", coalesce(nullif(trim(new."reason"), ''), nullif(trim(new."location"), '')), coalesce(nullif(trim(new."location"), ''), nullif(trim(new."state"), '')), 0, 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."location", '') || ' ' || coalesce(new."reason", '') || ' ' || coalesce(new."state", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_remote_work_requests";
--> statement-breakpoint
CREATE TRIGGER "search_au_remote_work_requests" AFTER UPDATE ON "remote_work_requests"
WHEN old."code" IS NOT new."code" OR old."employee_id" IS NOT new."employee_id" OR old."reason" IS NOT new."reason" OR old."location" IS NOT new."location" OR old."state" IS NOT new."state" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = coalesce(nullif(trim(new."reason"), ''), nullif(trim(new."location"), '')), "subtitle" = coalesce(nullif(trim(new."location"), ''), nullif(trim(new."state"), '')), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'remote-work-requests' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'remote-work-requests' AND "record_id" = new."uuid") AND (old."location" IS NOT new."location" OR old."reason" IS NOT new."reason" OR old."state" IS NOT new."state");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'remote-work-requests' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."location", '') || ' ' || coalesce(new."reason", '') || ' ' || coalesce(new."state", '') AS "text") WHERE trim("text") <> '' AND (old."location" IS NOT new."location" OR old."reason" IS NOT new."reason" OR old."state" IS NOT new."state");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_asset_requests";
--> statement-breakpoint
CREATE TRIGGER "search_ai_asset_requests" AFTER INSERT ON "asset_requests" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('asset-requests', new."uuid", new."code", new."employee_id", nullif(trim(new."justification"), ''), nullif(trim(new."state"), ''), 0, 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."justification", '') || ' ' || coalesce(new."state", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_asset_requests";
--> statement-breakpoint
CREATE TRIGGER "search_au_asset_requests" AFTER UPDATE ON "asset_requests"
WHEN old."code" IS NOT new."code" OR old."employee_id" IS NOT new."employee_id" OR old."justification" IS NOT new."justification" OR old."state" IS NOT new."state" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."justification"), ''), "subtitle" = nullif(trim(new."state"), ''), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'asset-requests' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'asset-requests' AND "record_id" = new."uuid") AND (old."justification" IS NOT new."justification" OR old."state" IS NOT new."state");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'asset-requests' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."justification", '') || ' ' || coalesce(new."state", '') AS "text") WHERE trim("text") <> '' AND (old."justification" IS NOT new."justification" OR old."state" IS NOT new."state");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_approval_delegations";
--> statement-breakpoint
CREATE TRIGGER "search_ai_approval_delegations" AFTER INSERT ON "approval_delegations" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('approval-delegations', new."uuid", new."code", new."delegator_id", nullif(trim(new."reason"), ''), NULL, 0, 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."reason", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_approval_delegations";
--> statement-breakpoint
CREATE TRIGGER "search_au_approval_delegations" AFTER UPDATE ON "approval_delegations"
WHEN old."code" IS NOT new."code" OR old."delegator_id" IS NOT new."delegator_id" OR old."reason" IS NOT new."reason" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."delegator_id", "title" = nullif(trim(new."reason"), ''), "subtitle" = NULL, "deleted" = 0, "restricted" = 0 WHERE "collection" = 'approval-delegations' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'approval-delegations' AND "record_id" = new."uuid") AND (old."reason" IS NOT new."reason");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'approval-delegations' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."reason", '') AS "text") WHERE trim("text") <> '' AND (old."reason" IS NOT new."reason");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_shifts";
--> statement-breakpoint
CREATE TRIGGER "search_ai_shifts" AFTER INSERT ON "shifts" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('shifts', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), NULL, (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."name", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_shifts";
--> statement-breakpoint
CREATE TRIGGER "search_au_shifts" AFTER UPDATE ON "shifts"
WHEN old."code" IS NOT new."code" OR old."name" IS NOT new."name" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = NULL, "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'shifts' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'shifts' AND "record_id" = new."uuid") AND (old."name" IS NOT new."name");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'shifts' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."name", '') AS "text") WHERE trim("text") <> '' AND (old."name" IS NOT new."name");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_shift_assignments";
--> statement-breakpoint
CREATE TRIGGER "search_ai_shift_assignments" AFTER INSERT ON "shift_assignments" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('shift-assignments', new."uuid", new."code", new."employee_id", nullif(trim(new."note"), ''), NULL, (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."note", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_shift_assignments";
--> statement-breakpoint
CREATE TRIGGER "search_au_shift_assignments" AFTER UPDATE ON "shift_assignments"
WHEN old."code" IS NOT new."code" OR old."employee_id" IS NOT new."employee_id" OR old."note" IS NOT new."note" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."note"), ''), "subtitle" = NULL, "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'shift-assignments' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'shift-assignments' AND "record_id" = new."uuid") AND (old."note" IS NOT new."note");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'shift-assignments' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."note", '') AS "text") WHERE trim("text") <> '' AND (old."note" IS NOT new."note");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_work_patterns";
--> statement-breakpoint
CREATE TRIGGER "search_ai_work_patterns" AFTER INSERT ON "work_patterns" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('work-patterns', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), NULL, (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."name", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_work_patterns";
--> statement-breakpoint
CREATE TRIGGER "search_au_work_patterns" AFTER UPDATE ON "work_patterns"
WHEN old."code" IS NOT new."code" OR old."name" IS NOT new."name" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = NULL, "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'work-patterns' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'work-patterns' AND "record_id" = new."uuid") AND (old."name" IS NOT new."name");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'work-patterns' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."name", '') AS "text") WHERE trim("text") <> '' AND (old."name" IS NOT new."name");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_work_pattern_assignments";
--> statement-breakpoint
CREATE TRIGGER "search_ai_work_pattern_assignments" AFTER INSERT ON "work_pattern_assignments" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('work-pattern-assignments', new."uuid", new."code", new."employee_id", nullif(trim(new."note"), ''), NULL, (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."note", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_work_pattern_assignments";
--> statement-breakpoint
CREATE TRIGGER "search_au_work_pattern_assignments" AFTER UPDATE ON "work_pattern_assignments"
WHEN old."code" IS NOT new."code" OR old."employee_id" IS NOT new."employee_id" OR old."note" IS NOT new."note" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."note"), ''), "subtitle" = NULL, "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'work-pattern-assignments' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'work-pattern-assignments' AND "record_id" = new."uuid") AND (old."note" IS NOT new."note");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'work-pattern-assignments' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."note", '') AS "text") WHERE trim("text") <> '' AND (old."note" IS NOT new."note");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_projects";
--> statement-breakpoint
CREATE TRIGGER "search_ai_projects" AFTER INSERT ON "projects" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('projects', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), coalesce(nullif(trim(new."client"), ''), nullif(trim(new."project_code"), '')), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."client", '') || ' ' || coalesce(new."project_code", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_projects";
--> statement-breakpoint
CREATE TRIGGER "search_au_projects" AFTER UPDATE ON "projects"
WHEN old."code" IS NOT new."code" OR old."name" IS NOT new."name" OR old."client" IS NOT new."client" OR old."project_code" IS NOT new."project_code" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = coalesce(nullif(trim(new."client"), ''), nullif(trim(new."project_code"), '')), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'projects' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'projects' AND "record_id" = new."uuid") AND (old."name" IS NOT new."name" OR old."client" IS NOT new."client" OR old."project_code" IS NOT new."project_code");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'projects' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."client", '') || ' ' || coalesce(new."project_code", '') AS "text") WHERE trim("text") <> '' AND (old."name" IS NOT new."name" OR old."client" IS NOT new."client" OR old."project_code" IS NOT new."project_code");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_time_entries";
--> statement-breakpoint
CREATE TRIGGER "search_ai_time_entries" AFTER INSERT ON "time_entries" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('time-entries', new."uuid", new."code", new."employee_id", nullif(trim(new."description"), ''), nullif(trim(new."status"), ''), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."description", '') || ' ' || coalesce(new."status", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_time_entries";
--> statement-breakpoint
CREATE TRIGGER "search_au_time_entries" AFTER UPDATE ON "time_entries"
WHEN old."code" IS NOT new."code" OR old."employee_id" IS NOT new."employee_id" OR old."description" IS NOT new."description" OR old."status" IS NOT new."status" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."description"), ''), "subtitle" = nullif(trim(new."status"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'time-entries' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'time-entries' AND "record_id" = new."uuid") AND (old."description" IS NOT new."description" OR old."status" IS NOT new."status");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'time-entries' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."description", '') || ' ' || coalesce(new."status", '') AS "text") WHERE trim("text") <> '' AND (old."description" IS NOT new."description" OR old."status" IS NOT new."status");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_goals";
--> statement-breakpoint
CREATE TRIGGER "search_ai_goals" AFTER INSERT ON "goals" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('goals', new."uuid", new."code", new."employee_id", nullif(trim(new."title"), ''), nullif(trim(new."status"), ''), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."title", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."status", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_goals";
--> statement-breakpoint
CREATE TRIGGER "search_au_goals" AFTER UPDATE ON "goals"
WHEN old."code" IS NOT new."code" OR old."employee_id" IS NOT new."employee_id" OR old."title" IS NOT new."title" OR old."status" IS NOT new."status" OR old."description" IS NOT new."description" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."title"), ''), "subtitle" = nullif(trim(new."status"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'goals' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'goals' AND "record_id" = new."uuid") AND (old."title" IS NOT new."title" OR old."description" IS NOT new."description" OR old."status" IS NOT new."status");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'goals' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."title", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."status", '') AS "text") WHERE trim("text") <> '' AND (old."title" IS NOT new."title" OR old."description" IS NOT new."description" OR old."status" IS NOT new."status");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_boards";
--> statement-breakpoint
CREATE TRIGGER "search_ai_boards" AFTER INSERT ON "boards" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('boards', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), nullif(trim(new."description"), ''), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."task_prefix", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_boards";
--> statement-breakpoint
CREATE TRIGGER "search_au_boards" AFTER UPDATE ON "boards"
WHEN old."code" IS NOT new."code" OR old."name" IS NOT new."name" OR old."description" IS NOT new."description" OR old."task_prefix" IS NOT new."task_prefix" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = nullif(trim(new."description"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'boards' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'boards' AND "record_id" = new."uuid") AND (old."name" IS NOT new."name" OR old."description" IS NOT new."description" OR old."task_prefix" IS NOT new."task_prefix");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'boards' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."task_prefix", '') AS "text") WHERE trim("text") <> '' AND (old."name" IS NOT new."name" OR old."description" IS NOT new."description" OR old."task_prefix" IS NOT new."task_prefix");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_sprints";
--> statement-breakpoint
CREATE TRIGGER "search_ai_sprints" AFTER INSERT ON "sprints" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('sprints', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), coalesce(nullif(trim(new."goal"), ''), nullif(trim(new."state"), '')), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."goal", '') || ' ' || coalesce(new."state", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_sprints";
--> statement-breakpoint
CREATE TRIGGER "search_au_sprints" AFTER UPDATE ON "sprints"
WHEN old."code" IS NOT new."code" OR old."name" IS NOT new."name" OR old."goal" IS NOT new."goal" OR old."state" IS NOT new."state" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = coalesce(nullif(trim(new."goal"), ''), nullif(trim(new."state"), '')), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'sprints' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'sprints' AND "record_id" = new."uuid") AND (old."name" IS NOT new."name" OR old."goal" IS NOT new."goal" OR old."state" IS NOT new."state");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'sprints' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."goal", '') || ' ' || coalesce(new."state", '') AS "text") WHERE trim("text") <> '' AND (old."name" IS NOT new."name" OR old."goal" IS NOT new."goal" OR old."state" IS NOT new."state");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_cards";
--> statement-breakpoint
CREATE TRIGGER "search_ai_cards" AFTER INSERT ON "cards" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('cards', new."uuid", new."code", new."employee_id", nullif(trim(new."title"), ''), nullif(trim(new."column_key"), ''), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."title", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."key_prefix", '') || ' ' || coalesce(new."column_key", '') || ' ' || coalesce(new."priority", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_cards";
--> statement-breakpoint
CREATE TRIGGER "search_au_cards" AFTER UPDATE ON "cards"
WHEN old."code" IS NOT new."code" OR old."employee_id" IS NOT new."employee_id" OR old."title" IS NOT new."title" OR old."column_key" IS NOT new."column_key" OR old."description" IS NOT new."description" OR old."key_prefix" IS NOT new."key_prefix" OR old."priority" IS NOT new."priority" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."title"), ''), "subtitle" = nullif(trim(new."column_key"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'cards' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'cards' AND "record_id" = new."uuid") AND (old."title" IS NOT new."title" OR old."description" IS NOT new."description" OR old."key_prefix" IS NOT new."key_prefix" OR old."column_key" IS NOT new."column_key" OR old."priority" IS NOT new."priority");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'cards' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."title", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."key_prefix", '') || ' ' || coalesce(new."column_key", '') || ' ' || coalesce(new."priority", '') AS "text") WHERE trim("text") <> '' AND (old."title" IS NOT new."title" OR old."description" IS NOT new."description" OR old."key_prefix" IS NOT new."key_prefix" OR old."column_key" IS NOT new."column_key" OR old."priority" IS NOT new."priority");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_review_cycles";
--> statement-breakpoint
CREATE TRIGGER "search_ai_review_cycles" AFTER INSERT ON "review_cycles" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('review-cycles', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), nullif(trim(new."state"), ''), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."state", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_review_cycles";
--> statement-breakpoint
CREATE TRIGGER "search_au_review_cycles" AFTER UPDATE ON "review_cycles"
WHEN old."code" IS NOT new."code" OR old."name" IS NOT new."name" OR old."state" IS NOT new."state" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = nullif(trim(new."state"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'review-cycles' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'review-cycles' AND "record_id" = new."uuid") AND (old."name" IS NOT new."name" OR old."state" IS NOT new."state");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'review-cycles' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."state", '') AS "text") WHERE trim("text") <> '' AND (old."name" IS NOT new."name" OR old."state" IS NOT new."state");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_reviews";
--> statement-breakpoint
CREATE TRIGGER "search_ai_reviews" AFTER INSERT ON "reviews" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('reviews', new."uuid", new."code", new."employee_id", nullif(trim(new."self_comment"), ''), nullif(trim(new."state"), ''), 0, 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."self_comment", '') || ' ' || coalesce(new."state", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_reviews";
--> statement-breakpoint
CREATE TRIGGER "search_au_reviews" AFTER UPDATE ON "reviews"
WHEN old."code" IS NOT new."code" OR old."employee_id" IS NOT new."employee_id" OR old."self_comment" IS NOT new."self_comment" OR old."state" IS NOT new."state" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."self_comment"), ''), "subtitle" = nullif(trim(new."state"), ''), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'reviews' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'reviews' AND "record_id" = new."uuid") AND (old."self_comment" IS NOT new."self_comment" OR old."state" IS NOT new."state");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'reviews' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."self_comment", '') || ' ' || coalesce(new."state", '') AS "text") WHERE trim("text") <> '' AND (old."self_comment" IS NOT new."self_comment" OR old."state" IS NOT new."state");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_review_feedback";
--> statement-breakpoint
CREATE TRIGGER "search_ai_review_feedback" AFTER INSERT ON "review_feedback" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('review-feedback', new."uuid", new."code", new."author_id", nullif(trim(new."comment"), ''), nullif(trim(new."state"), ''), 0, 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."comment", '') || ' ' || coalesce(new."state", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_review_feedback";
--> statement-breakpoint
CREATE TRIGGER "search_au_review_feedback" AFTER UPDATE ON "review_feedback"
WHEN old."code" IS NOT new."code" OR old."author_id" IS NOT new."author_id" OR old."comment" IS NOT new."comment" OR old."state" IS NOT new."state" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."author_id", "title" = nullif(trim(new."comment"), ''), "subtitle" = nullif(trim(new."state"), ''), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'review-feedback' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'review-feedback' AND "record_id" = new."uuid") AND (old."comment" IS NOT new."comment" OR old."state" IS NOT new."state");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'review-feedback' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."comment", '') || ' ' || coalesce(new."state", '') AS "text") WHERE trim("text") <> '' AND (old."comment" IS NOT new."comment" OR old."state" IS NOT new."state");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_check_ins";
--> statement-breakpoint
CREATE TRIGGER "search_ai_check_ins" AFTER INSERT ON "check_ins" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('check-ins', new."uuid", new."code", new."employee_id", nullif(trim(new."notes"), ''), NULL, (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."notes", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_check_ins";
--> statement-breakpoint
CREATE TRIGGER "search_au_check_ins" AFTER UPDATE ON "check_ins"
WHEN old."code" IS NOT new."code" OR old."employee_id" IS NOT new."employee_id" OR old."notes" IS NOT new."notes" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."notes"), ''), "subtitle" = NULL, "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'check-ins' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'check-ins' AND "record_id" = new."uuid") AND (old."notes" IS NOT new."notes");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'check-ins' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."notes", '') AS "text") WHERE trim("text") <> '' AND (old."notes" IS NOT new."notes");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_transitions";
--> statement-breakpoint
CREATE TRIGGER "search_ai_transitions" AFTER INSERT ON "transitions" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('transitions', new."uuid", new."code", new."employee_id", nullif(trim(new."name"), ''), coalesce(nullif(trim(new."kind"), ''), nullif(trim(new."state"), '')), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."kind", '') || ' ' || coalesce(new."state", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_transitions";
--> statement-breakpoint
CREATE TRIGGER "search_au_transitions" AFTER UPDATE ON "transitions"
WHEN old."code" IS NOT new."code" OR old."employee_id" IS NOT new."employee_id" OR old."name" IS NOT new."name" OR old."kind" IS NOT new."kind" OR old."state" IS NOT new."state" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."name"), ''), "subtitle" = coalesce(nullif(trim(new."kind"), ''), nullif(trim(new."state"), '')), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'transitions' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'transitions' AND "record_id" = new."uuid") AND (old."name" IS NOT new."name" OR old."kind" IS NOT new."kind" OR old."state" IS NOT new."state");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'transitions' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."kind", '') || ' ' || coalesce(new."state", '') AS "text") WHERE trim("text") <> '' AND (old."name" IS NOT new."name" OR old."kind" IS NOT new."kind" OR old."state" IS NOT new."state");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_transition_tasks";
--> statement-breakpoint
CREATE TRIGGER "search_ai_transition_tasks" AFTER INSERT ON "transition_tasks" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('transition-tasks', new."uuid", new."code", new."assignee_id", nullif(trim(new."title"), ''), nullif(trim(new."status"), ''), 0, 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."title", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."note", '') || ' ' || coalesce(new."status", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_transition_tasks";
--> statement-breakpoint
CREATE TRIGGER "search_au_transition_tasks" AFTER UPDATE ON "transition_tasks"
WHEN old."code" IS NOT new."code" OR old."assignee_id" IS NOT new."assignee_id" OR old."title" IS NOT new."title" OR old."status" IS NOT new."status" OR old."description" IS NOT new."description" OR old."note" IS NOT new."note" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."assignee_id", "title" = nullif(trim(new."title"), ''), "subtitle" = nullif(trim(new."status"), ''), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'transition-tasks' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'transition-tasks' AND "record_id" = new."uuid") AND (old."title" IS NOT new."title" OR old."description" IS NOT new."description" OR old."note" IS NOT new."note" OR old."status" IS NOT new."status");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'transition-tasks' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."title", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."note", '') || ' ' || coalesce(new."status", '') AS "text") WHERE trim("text") <> '' AND (old."title" IS NOT new."title" OR old."description" IS NOT new."description" OR old."note" IS NOT new."note" OR old."status" IS NOT new."status");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_notice_periods";
--> statement-breakpoint
CREATE TRIGGER "search_ai_notice_periods" AFTER INSERT ON "notice_periods" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('notice-periods', new."uuid", new."code", new."employee_id", coalesce(nullif(trim(new."reason"), ''), nullif(trim(new."type"), '')), nullif(trim(new."status"), ''), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."type", '') || ' ' || coalesce(new."reason", '') || ' ' || coalesce(new."notes", '') || ' ' || coalesce(new."status", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_notice_periods";
--> statement-breakpoint
CREATE TRIGGER "search_au_notice_periods" AFTER UPDATE ON "notice_periods"
WHEN old."code" IS NOT new."code" OR old."employee_id" IS NOT new."employee_id" OR old."reason" IS NOT new."reason" OR old."type" IS NOT new."type" OR old."status" IS NOT new."status" OR old."notes" IS NOT new."notes" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = coalesce(nullif(trim(new."reason"), ''), nullif(trim(new."type"), '')), "subtitle" = nullif(trim(new."status"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'notice-periods' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'notice-periods' AND "record_id" = new."uuid") AND (old."type" IS NOT new."type" OR old."reason" IS NOT new."reason" OR old."notes" IS NOT new."notes" OR old."status" IS NOT new."status");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'notice-periods' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."type", '') || ' ' || coalesce(new."reason", '') || ' ' || coalesce(new."notes", '') || ' ' || coalesce(new."status", '') AS "text") WHERE trim("text") <> '' AND (old."type" IS NOT new."type" OR old."reason" IS NOT new."reason" OR old."notes" IS NOT new."notes" OR old."status" IS NOT new."status");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_background_checks";
--> statement-breakpoint
CREATE TRIGGER "search_ai_background_checks" AFTER INSERT ON "background_checks" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('background-checks', new."uuid", new."code", new."employee_id", nullif(trim(new."check_type"), ''), coalesce(nullif(trim(new."vendor"), ''), nullif(trim(new."status"), '')), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."check_type", '') || ' ' || coalesce(new."vendor", '') || ' ' || coalesce(new."reference_no", '') || ' ' || coalesce(new."notes", '') || ' ' || coalesce(new."status", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_background_checks";
--> statement-breakpoint
CREATE TRIGGER "search_au_background_checks" AFTER UPDATE ON "background_checks"
WHEN old."code" IS NOT new."code" OR old."employee_id" IS NOT new."employee_id" OR old."check_type" IS NOT new."check_type" OR old."vendor" IS NOT new."vendor" OR old."status" IS NOT new."status" OR old."reference_no" IS NOT new."reference_no" OR old."notes" IS NOT new."notes" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."check_type"), ''), "subtitle" = coalesce(nullif(trim(new."vendor"), ''), nullif(trim(new."status"), '')), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'background-checks' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'background-checks' AND "record_id" = new."uuid") AND (old."check_type" IS NOT new."check_type" OR old."vendor" IS NOT new."vendor" OR old."reference_no" IS NOT new."reference_no" OR old."notes" IS NOT new."notes" OR old."status" IS NOT new."status");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'background-checks' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."check_type", '') || ' ' || coalesce(new."vendor", '') || ' ' || coalesce(new."reference_no", '') || ' ' || coalesce(new."notes", '') || ' ' || coalesce(new."status", '') AS "text") WHERE trim("text") <> '' AND (old."check_type" IS NOT new."check_type" OR old."vendor" IS NOT new."vendor" OR old."reference_no" IS NOT new."reference_no" OR old."notes" IS NOT new."notes" OR old."status" IS NOT new."status");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_compliance_events";
--> statement-breakpoint
CREATE TRIGGER "search_ai_compliance_events" AFTER INSERT ON "compliance_events" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('compliance-events', new."uuid", new."code", new."code", nullif(trim(new."title"), ''), coalesce(nullif(trim(new."category"), ''), nullif(trim(new."period_label"), '')), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."title", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."period_label", '') || ' ' || coalesce(new."reference", '') || ' ' || coalesce(new."notes", '') || ' ' || coalesce(new."status", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_compliance_events";
--> statement-breakpoint
CREATE TRIGGER "search_au_compliance_events" AFTER UPDATE ON "compliance_events"
WHEN old."code" IS NOT new."code" OR old."title" IS NOT new."title" OR old."category" IS NOT new."category" OR old."period_label" IS NOT new."period_label" OR old."reference" IS NOT new."reference" OR old."notes" IS NOT new."notes" OR old."status" IS NOT new."status" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."code", "title" = nullif(trim(new."title"), ''), "subtitle" = coalesce(nullif(trim(new."category"), ''), nullif(trim(new."period_label"), '')), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'compliance-events' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'compliance-events' AND "record_id" = new."uuid") AND (old."title" IS NOT new."title" OR old."category" IS NOT new."category" OR old."period_label" IS NOT new."period_label" OR old."reference" IS NOT new."reference" OR old."notes" IS NOT new."notes" OR old."status" IS NOT new."status");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'compliance-events' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."title", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."period_label", '') || ' ' || coalesce(new."reference", '') || ' ' || coalesce(new."notes", '') || ' ' || coalesce(new."status", '') AS "text") WHERE trim("text") <> '' AND (old."title" IS NOT new."title" OR old."category" IS NOT new."category" OR old."period_label" IS NOT new."period_label" OR old."reference" IS NOT new."reference" OR old."notes" IS NOT new."notes" OR old."status" IS NOT new."status");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_compliance_rules";
--> statement-breakpoint
CREATE TRIGGER "search_ai_compliance_rules" AFTER INSERT ON "compliance_rules" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('compliance-rules', new."uuid", new."code", NULL, nullif(trim(new."title"), ''), nullif(trim(new."category"), ''), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."title", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."notes", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_compliance_rules";
--> statement-breakpoint
CREATE TRIGGER "search_au_compliance_rules" AFTER UPDATE ON "compliance_rules"
WHEN old."code" IS NOT new."code" OR old."title" IS NOT new."title" OR old."category" IS NOT new."category" OR old."notes" IS NOT new."notes" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."title"), ''), "subtitle" = nullif(trim(new."category"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'compliance-rules' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'compliance-rules' AND "record_id" = new."uuid") AND (old."title" IS NOT new."title" OR old."category" IS NOT new."category" OR old."notes" IS NOT new."notes");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'compliance-rules' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."title", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."notes", '') AS "text") WHERE trim("text") <> '' AND (old."title" IS NOT new."title" OR old."category" IS NOT new."category" OR old."notes" IS NOT new."notes");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_org_documents";
--> statement-breakpoint
CREATE TRIGGER "search_ai_org_documents" AFTER INSERT ON "org_documents" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('org-documents', new."uuid", new."code", new."code", coalesce(nullif(trim(new."title"), ''), nullif(trim(new."file_name"), '')), nullif(trim(new."document_type"), ''), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."title", '') || ' ' || coalesce(new."file_name", '') || ' ' || coalesce(new."document_type", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_org_documents";
--> statement-breakpoint
CREATE TRIGGER "search_au_org_documents" AFTER UPDATE ON "org_documents"
WHEN old."code" IS NOT new."code" OR old."title" IS NOT new."title" OR old."file_name" IS NOT new."file_name" OR old."document_type" IS NOT new."document_type" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."code", "title" = coalesce(nullif(trim(new."title"), ''), nullif(trim(new."file_name"), '')), "subtitle" = nullif(trim(new."document_type"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'org-documents' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'org-documents' AND "record_id" = new."uuid") AND (old."title" IS NOT new."title" OR old."file_name" IS NOT new."file_name" OR old."document_type" IS NOT new."document_type");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'org-documents' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."title", '') || ' ' || coalesce(new."file_name", '') || ' ' || coalesce(new."document_type", '') AS "text") WHERE trim("text") <> '' AND (old."title" IS NOT new."title" OR old."file_name" IS NOT new."file_name" OR old."document_type" IS NOT new."document_type");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_personal_documents";
--> statement-breakpoint
CREATE TRIGGER "search_ai_personal_documents" AFTER INSERT ON "personal_documents" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('personal-documents', new."uuid", new."code", new."employee_id", coalesce(nullif(trim(new."title"), ''), nullif(trim(new."file_name"), '')), nullif(trim(new."document_type"), ''), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."title", '') || ' ' || coalesce(new."file_name", '') || ' ' || coalesce(new."document_type", '') || ' ' || coalesce(new."financial_year", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_personal_documents";
--> statement-breakpoint
CREATE TRIGGER "search_au_personal_documents" AFTER UPDATE ON "personal_documents"
WHEN old."code" IS NOT new."code" OR old."employee_id" IS NOT new."employee_id" OR old."title" IS NOT new."title" OR old."file_name" IS NOT new."file_name" OR old."document_type" IS NOT new."document_type" OR old."financial_year" IS NOT new."financial_year" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = coalesce(nullif(trim(new."title"), ''), nullif(trim(new."file_name"), '')), "subtitle" = nullif(trim(new."document_type"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'personal-documents' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'personal-documents' AND "record_id" = new."uuid") AND (old."title" IS NOT new."title" OR old."file_name" IS NOT new."file_name" OR old."document_type" IS NOT new."document_type" OR old."financial_year" IS NOT new."financial_year");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'personal-documents' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."title", '') || ' ' || coalesce(new."file_name", '') || ' ' || coalesce(new."document_type", '') || ' ' || coalesce(new."financial_year", '') AS "text") WHERE trim("text") <> '' AND (old."title" IS NOT new."title" OR old."file_name" IS NOT new."file_name" OR old."document_type" IS NOT new."document_type" OR old."financial_year" IS NOT new."financial_year");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_letter_templates";
--> statement-breakpoint
CREATE TRIGGER "search_ai_letter_templates" AFTER INSERT ON "letter_templates" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('letter-templates', new."uuid", new."code", NULL, nullif(trim(new."label"), ''), nullif(trim(new."category"), ''), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."label", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."filename", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_letter_templates";
--> statement-breakpoint
CREATE TRIGGER "search_au_letter_templates" AFTER UPDATE ON "letter_templates"
WHEN old."code" IS NOT new."code" OR old."label" IS NOT new."label" OR old."category" IS NOT new."category" OR old."filename" IS NOT new."filename" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."label"), ''), "subtitle" = nullif(trim(new."category"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'letter-templates' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'letter-templates' AND "record_id" = new."uuid") AND (old."label" IS NOT new."label" OR old."category" IS NOT new."category" OR old."filename" IS NOT new."filename");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'letter-templates' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."label", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."filename", '') AS "text") WHERE trim("text") <> '' AND (old."label" IS NOT new."label" OR old."category" IS NOT new."category" OR old."filename" IS NOT new."filename");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_announcements";
--> statement-breakpoint
CREATE TRIGGER "search_ai_announcements" AFTER INSERT ON "announcements" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('announcements', new."uuid", new."code", new."author_employee_id", nullif(trim(new."title"), ''), nullif(trim(new."kind"), ''), (new."delete_time" IS NOT NULL OR new."held_at" IS NOT NULL), (coalesce(new."published", 0) <> 1 OR coalesce(new."disabled", 0) <> 0), new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."title", '') || ' ' || coalesce(new."body_text", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."kind", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_announcements";
--> statement-breakpoint
CREATE TRIGGER "search_au_announcements" AFTER UPDATE ON "announcements"
WHEN old."code" IS NOT new."code" OR old."author_employee_id" IS NOT new."author_employee_id" OR old."title" IS NOT new."title" OR old."kind" IS NOT new."kind" OR old."body_text" IS NOT new."body_text" OR old."category" IS NOT new."category" OR old."delete_time" IS NOT new."delete_time" OR old."held_at" IS NOT new."held_at" OR old."published" IS NOT new."published" OR old."disabled" IS NOT new."disabled" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."author_employee_id", "title" = nullif(trim(new."title"), ''), "subtitle" = nullif(trim(new."kind"), ''), "deleted" = (new."delete_time" IS NOT NULL OR new."held_at" IS NOT NULL), "restricted" = (coalesce(new."published", 0) <> 1 OR coalesce(new."disabled", 0) <> 0) WHERE "collection" = 'announcements' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'announcements' AND "record_id" = new."uuid") AND (old."title" IS NOT new."title" OR old."body_text" IS NOT new."body_text" OR old."category" IS NOT new."category" OR old."kind" IS NOT new."kind");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'announcements' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."title", '') || ' ' || coalesce(new."body_text", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."kind", '') AS "text") WHERE trim("text") <> '' AND (old."title" IS NOT new."title" OR old."body_text" IS NOT new."body_text" OR old."category" IS NOT new."category" OR old."kind" IS NOT new."kind");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_events";
--> statement-breakpoint
CREATE TRIGGER "search_ai_events" AFTER INSERT ON "events" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('events', new."uuid", new."code", new."code", nullif(trim(new."title"), ''), nullif(trim(new."description"), ''), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."title", '') || ' ' || coalesce(new."description", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_events";
--> statement-breakpoint
CREATE TRIGGER "search_au_events" AFTER UPDATE ON "events"
WHEN old."code" IS NOT new."code" OR old."title" IS NOT new."title" OR old."description" IS NOT new."description" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."code", "title" = nullif(trim(new."title"), ''), "subtitle" = nullif(trim(new."description"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'events' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'events' AND "record_id" = new."uuid") AND (old."title" IS NOT new."title" OR old."description" IS NOT new."description");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'events' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."title", '') || ' ' || coalesce(new."description", '') AS "text") WHERE trim("text") <> '' AND (old."title" IS NOT new."title" OR old."description" IS NOT new."description");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_reimbursements";
--> statement-breakpoint
CREATE TRIGGER "search_ai_reimbursements" AFTER INSERT ON "reimbursements" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('reimbursements', new."uuid", new."code", new."employee_id", nullif(trim(new."description"), ''), nullif(trim(new."state"), ''), 0, 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."description", '') || ' ' || coalesce(new."state", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_reimbursements";
--> statement-breakpoint
CREATE TRIGGER "search_au_reimbursements" AFTER UPDATE ON "reimbursements"
WHEN old."code" IS NOT new."code" OR old."employee_id" IS NOT new."employee_id" OR old."description" IS NOT new."description" OR old."state" IS NOT new."state" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."description"), ''), "subtitle" = nullif(trim(new."state"), ''), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'reimbursements' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'reimbursements' AND "record_id" = new."uuid") AND (old."description" IS NOT new."description" OR old."state" IS NOT new."state");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'reimbursements' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."description", '') || ' ' || coalesce(new."state", '') AS "text") WHERE trim("text") <> '' AND (old."description" IS NOT new."description" OR old."state" IS NOT new."state");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_reimbursement_categories";
--> statement-breakpoint
CREATE TRIGGER "search_ai_reimbursement_categories" AFTER INSERT ON "reimbursement_categories" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('reimbursement-categories', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), NULL, (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."name", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_reimbursement_categories";
--> statement-breakpoint
CREATE TRIGGER "search_au_reimbursement_categories" AFTER UPDATE ON "reimbursement_categories"
WHEN old."code" IS NOT new."code" OR old."name" IS NOT new."name" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = NULL, "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'reimbursement-categories' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'reimbursement-categories' AND "record_id" = new."uuid") AND (old."name" IS NOT new."name");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'reimbursement-categories' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."name", '') AS "text") WHERE trim("text") <> '' AND (old."name" IS NOT new."name");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_expenses";
--> statement-breakpoint
CREATE TRIGGER "search_ai_expenses" AFTER INSERT ON "expenses" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('expenses', new."uuid", new."code", new."employee_id", coalesce(nullif(trim(new."description"), ''), nullif(trim(new."invoice_number"), '')), nullif(trim(new."state"), ''), 0, 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."description", '') || ' ' || coalesce(new."invoice_number", '') || ' ' || coalesce(new."payment_ref", '') || ' ' || coalesce(new."state", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_expenses";
--> statement-breakpoint
CREATE TRIGGER "search_au_expenses" AFTER UPDATE ON "expenses"
WHEN old."code" IS NOT new."code" OR old."employee_id" IS NOT new."employee_id" OR old."description" IS NOT new."description" OR old."invoice_number" IS NOT new."invoice_number" OR old."state" IS NOT new."state" OR old."payment_ref" IS NOT new."payment_ref" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = coalesce(nullif(trim(new."description"), ''), nullif(trim(new."invoice_number"), '')), "subtitle" = nullif(trim(new."state"), ''), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'expenses' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'expenses' AND "record_id" = new."uuid") AND (old."description" IS NOT new."description" OR old."invoice_number" IS NOT new."invoice_number" OR old."payment_ref" IS NOT new."payment_ref" OR old."state" IS NOT new."state");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'expenses' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."description", '') || ' ' || coalesce(new."invoice_number", '') || ' ' || coalesce(new."payment_ref", '') || ' ' || coalesce(new."state", '') AS "text") WHERE trim("text") <> '' AND (old."description" IS NOT new."description" OR old."invoice_number" IS NOT new."invoice_number" OR old."payment_ref" IS NOT new."payment_ref" OR old."state" IS NOT new."state");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_expense_categories";
--> statement-breakpoint
CREATE TRIGGER "search_ai_expense_categories" AFTER INSERT ON "expense_categories" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('expense-categories', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), nullif(trim(new."gl_code"), ''), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."gl_code", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_expense_categories";
--> statement-breakpoint
CREATE TRIGGER "search_au_expense_categories" AFTER UPDATE ON "expense_categories"
WHEN old."code" IS NOT new."code" OR old."name" IS NOT new."name" OR old."gl_code" IS NOT new."gl_code" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = nullif(trim(new."gl_code"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'expense-categories' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'expense-categories' AND "record_id" = new."uuid") AND (old."name" IS NOT new."name" OR old."gl_code" IS NOT new."gl_code");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'expense-categories' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."gl_code", '') AS "text") WHERE trim("text") <> '' AND (old."name" IS NOT new."name" OR old."gl_code" IS NOT new."gl_code");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_expense_budgets";
--> statement-breakpoint
CREATE TRIGGER "search_ai_expense_budgets" AFTER INSERT ON "expense_budgets" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('expense-budgets', new."uuid", new."code", NULL, nullif(trim(new."period_key"), ''), nullif(trim(new."period_type"), ''), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."period_key", '') || ' ' || coalesce(new."period_type", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_expense_budgets";
--> statement-breakpoint
CREATE TRIGGER "search_au_expense_budgets" AFTER UPDATE ON "expense_budgets"
WHEN old."code" IS NOT new."code" OR old."period_key" IS NOT new."period_key" OR old."period_type" IS NOT new."period_type" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."period_key"), ''), "subtitle" = nullif(trim(new."period_type"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'expense-budgets' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'expense-budgets' AND "record_id" = new."uuid") AND (old."period_key" IS NOT new."period_key" OR old."period_type" IS NOT new."period_type");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'expense-budgets' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."period_key", '') || ' ' || coalesce(new."period_type", '') AS "text") WHERE trim("text") <> '' AND (old."period_key" IS NOT new."period_key" OR old."period_type" IS NOT new."period_type");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_payroll_budgets";
--> statement-breakpoint
CREATE TRIGGER "search_ai_payroll_budgets" AFTER INSERT ON "payroll_budgets" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('payroll-budgets', new."uuid", new."code", NULL, nullif(trim(new."period_key"), ''), nullif(trim(new."period_type"), ''), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."period_key", '') || ' ' || coalesce(new."period_type", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_payroll_budgets";
--> statement-breakpoint
CREATE TRIGGER "search_au_payroll_budgets" AFTER UPDATE ON "payroll_budgets"
WHEN old."code" IS NOT new."code" OR old."period_key" IS NOT new."period_key" OR old."period_type" IS NOT new."period_type" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."period_key"), ''), "subtitle" = nullif(trim(new."period_type"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'payroll-budgets' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'payroll-budgets' AND "record_id" = new."uuid") AND (old."period_key" IS NOT new."period_key" OR old."period_type" IS NOT new."period_type");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'payroll-budgets' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."period_key", '') || ' ' || coalesce(new."period_type", '') AS "text") WHERE trim("text") <> '' AND (old."period_key" IS NOT new."period_key" OR old."period_type" IS NOT new."period_type");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_vendors";
--> statement-breakpoint
CREATE TRIGGER "search_ai_vendors" AFTER INSERT ON "vendors" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('vendors', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), nullif(trim(new."contact_email"), ''), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."contact_email", '') || ' ' || coalesce(new."tax_id", '') || ' ' || coalesce(new."notes", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_vendors";
--> statement-breakpoint
CREATE TRIGGER "search_au_vendors" AFTER UPDATE ON "vendors"
WHEN old."code" IS NOT new."code" OR old."name" IS NOT new."name" OR old."contact_email" IS NOT new."contact_email" OR old."tax_id" IS NOT new."tax_id" OR old."notes" IS NOT new."notes" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = nullif(trim(new."contact_email"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'vendors' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'vendors' AND "record_id" = new."uuid") AND (old."name" IS NOT new."name" OR old."contact_email" IS NOT new."contact_email" OR old."tax_id" IS NOT new."tax_id" OR old."notes" IS NOT new."notes");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'vendors' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."contact_email", '') || ' ' || coalesce(new."tax_id", '') || ' ' || coalesce(new."notes", '') AS "text") WHERE trim("text") <> '' AND (old."name" IS NOT new."name" OR old."contact_email" IS NOT new."contact_email" OR old."tax_id" IS NOT new."tax_id" OR old."notes" IS NOT new."notes");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_loans";
--> statement-breakpoint
CREATE TRIGGER "search_ai_loans" AFTER INSERT ON "loans" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('loans', new."uuid", new."code", new."employee_id", coalesce(nullif(trim(new."reason"), ''), nullif(trim(new."kind"), '')), nullif(trim(new."status"), ''), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."kind", '') || ' ' || coalesce(new."reason", '') || ' ' || coalesce(new."status", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_loans";
--> statement-breakpoint
CREATE TRIGGER "search_au_loans" AFTER UPDATE ON "loans"
WHEN old."code" IS NOT new."code" OR old."employee_id" IS NOT new."employee_id" OR old."reason" IS NOT new."reason" OR old."kind" IS NOT new."kind" OR old."status" IS NOT new."status" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = coalesce(nullif(trim(new."reason"), ''), nullif(trim(new."kind"), '')), "subtitle" = nullif(trim(new."status"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'loans' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'loans' AND "record_id" = new."uuid") AND (old."kind" IS NOT new."kind" OR old."reason" IS NOT new."reason" OR old."status" IS NOT new."status");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'loans' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."kind", '') || ' ' || coalesce(new."reason", '') || ' ' || coalesce(new."status", '') AS "text") WHERE trim("text") <> '' AND (old."kind" IS NOT new."kind" OR old."reason" IS NOT new."reason" OR old."status" IS NOT new."status");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_bonuses";
--> statement-breakpoint
CREATE TRIGGER "search_ai_bonuses" AFTER INSERT ON "bonuses" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('bonuses', new."uuid", new."code", new."employee_id", coalesce(nullif(trim(new."reason"), ''), nullif(trim(new."kind"), '')), nullif(trim(new."kind"), ''), 0, 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."kind", '') || ' ' || coalesce(new."reason", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_bonuses";
--> statement-breakpoint
CREATE TRIGGER "search_au_bonuses" AFTER UPDATE ON "bonuses"
WHEN old."code" IS NOT new."code" OR old."employee_id" IS NOT new."employee_id" OR old."reason" IS NOT new."reason" OR old."kind" IS NOT new."kind" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = coalesce(nullif(trim(new."reason"), ''), nullif(trim(new."kind"), '')), "subtitle" = nullif(trim(new."kind"), ''), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'bonuses' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'bonuses' AND "record_id" = new."uuid") AND (old."kind" IS NOT new."kind" OR old."reason" IS NOT new."reason");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'bonuses' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."kind", '') || ' ' || coalesce(new."reason", '') AS "text") WHERE trim("text") <> '' AND (old."kind" IS NOT new."kind" OR old."reason" IS NOT new."reason");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_tax_declarations";
--> statement-breakpoint
CREATE TRIGGER "search_ai_tax_declarations" AFTER INSERT ON "tax_declarations" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('tax-declarations', new."uuid", new."code", new."employee_id", nullif(trim(new."label"), ''), coalesce(nullif(trim(new."section"), ''), nullif(trim(new."financial_year"), '')), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."label", '') || ' ' || coalesce(new."section", '') || ' ' || coalesce(new."note", '') || ' ' || coalesce(new."financial_year", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_tax_declarations";
--> statement-breakpoint
CREATE TRIGGER "search_au_tax_declarations" AFTER UPDATE ON "tax_declarations"
WHEN old."code" IS NOT new."code" OR old."employee_id" IS NOT new."employee_id" OR old."label" IS NOT new."label" OR old."section" IS NOT new."section" OR old."financial_year" IS NOT new."financial_year" OR old."note" IS NOT new."note" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."label"), ''), "subtitle" = coalesce(nullif(trim(new."section"), ''), nullif(trim(new."financial_year"), '')), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'tax-declarations' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'tax-declarations' AND "record_id" = new."uuid") AND (old."label" IS NOT new."label" OR old."section" IS NOT new."section" OR old."note" IS NOT new."note" OR old."financial_year" IS NOT new."financial_year");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'tax-declarations' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."label", '') || ' ' || coalesce(new."section", '') || ' ' || coalesce(new."note", '') || ' ' || coalesce(new."financial_year", '') AS "text") WHERE trim("text") <> '' AND (old."label" IS NOT new."label" OR old."section" IS NOT new."section" OR old."note" IS NOT new."note" OR old."financial_year" IS NOT new."financial_year");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_pay_components";
--> statement-breakpoint
CREATE TRIGGER "search_ai_pay_components" AFTER INSERT ON "pay_components" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('pay-components', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), nullif(trim(new."kind"), ''), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."kind", '') || ' ' || coalesce(new."method", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_pay_components";
--> statement-breakpoint
CREATE TRIGGER "search_au_pay_components" AFTER UPDATE ON "pay_components"
WHEN old."code" IS NOT new."code" OR old."name" IS NOT new."name" OR old."kind" IS NOT new."kind" OR old."method" IS NOT new."method" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = nullif(trim(new."kind"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'pay-components' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'pay-components' AND "record_id" = new."uuid") AND (old."name" IS NOT new."name" OR old."kind" IS NOT new."kind" OR old."method" IS NOT new."method");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'pay-components' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."kind", '') || ' ' || coalesce(new."method", '') AS "text") WHERE trim("text") <> '' AND (old."name" IS NOT new."name" OR old."kind" IS NOT new."kind" OR old."method" IS NOT new."method");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_pay_grades";
--> statement-breakpoint
CREATE TRIGGER "search_ai_pay_grades" AFTER INSERT ON "pay_grades" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('pay-grades', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), nullif(trim(new."level"), ''), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."level", '') || ' ' || coalesce(new."description", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_pay_grades";
--> statement-breakpoint
CREATE TRIGGER "search_au_pay_grades" AFTER UPDATE ON "pay_grades"
WHEN old."code" IS NOT new."code" OR old."name" IS NOT new."name" OR old."level" IS NOT new."level" OR old."description" IS NOT new."description" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = nullif(trim(new."level"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'pay-grades' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'pay-grades' AND "record_id" = new."uuid") AND (old."name" IS NOT new."name" OR old."level" IS NOT new."level" OR old."description" IS NOT new."description");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'pay-grades' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."level", '') || ' ' || coalesce(new."description", '') AS "text") WHERE trim("text") <> '' AND (old."name" IS NOT new."name" OR old."level" IS NOT new."level" OR old."description" IS NOT new."description");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_salary_structures";
--> statement-breakpoint
CREATE TRIGGER "search_ai_salary_structures" AFTER INSERT ON "salary_structures" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('salary-structures', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), nullif(trim(new."description"), ''), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."description", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_salary_structures";
--> statement-breakpoint
CREATE TRIGGER "search_au_salary_structures" AFTER UPDATE ON "salary_structures"
WHEN old."code" IS NOT new."code" OR old."name" IS NOT new."name" OR old."description" IS NOT new."description" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = nullif(trim(new."description"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'salary-structures' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'salary-structures' AND "record_id" = new."uuid") AND (old."name" IS NOT new."name" OR old."description" IS NOT new."description");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'salary-structures' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."description", '') AS "text") WHERE trim("text") <> '' AND (old."name" IS NOT new."name" OR old."description" IS NOT new."description");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_pay_periods";
--> statement-breakpoint
CREATE TRIGGER "search_ai_pay_periods" AFTER INSERT ON "pay_periods" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('pay-periods', new."uuid", new."code", NULL, nullif(trim(new."label"), ''), NULL, (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."label", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_pay_periods";
--> statement-breakpoint
CREATE TRIGGER "search_au_pay_periods" AFTER UPDATE ON "pay_periods"
WHEN old."code" IS NOT new."code" OR old."label" IS NOT new."label" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."label"), ''), "subtitle" = NULL, "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'pay-periods' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'pay-periods' AND "record_id" = new."uuid") AND (old."label" IS NOT new."label");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'pay-periods' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."label", '') AS "text") WHERE trim("text") <> '' AND (old."label" IS NOT new."label");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_benefit_plans";
--> statement-breakpoint
CREATE TRIGGER "search_ai_benefit_plans" AFTER INSERT ON "benefit_plans" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('benefit-plans', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), coalesce(nullif(trim(new."provider"), ''), nullif(trim(new."category"), '')), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."provider", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_benefit_plans";
--> statement-breakpoint
CREATE TRIGGER "search_au_benefit_plans" AFTER UPDATE ON "benefit_plans"
WHEN old."code" IS NOT new."code" OR old."name" IS NOT new."name" OR old."provider" IS NOT new."provider" OR old."category" IS NOT new."category" OR old."description" IS NOT new."description" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = coalesce(nullif(trim(new."provider"), ''), nullif(trim(new."category"), '')), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'benefit-plans' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'benefit-plans' AND "record_id" = new."uuid") AND (old."name" IS NOT new."name" OR old."category" IS NOT new."category" OR old."description" IS NOT new."description" OR old."provider" IS NOT new."provider");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'benefit-plans' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."provider", '') AS "text") WHERE trim("text") <> '' AND (old."name" IS NOT new."name" OR old."category" IS NOT new."category" OR old."description" IS NOT new."description" OR old."provider" IS NOT new."provider");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_dependents";
--> statement-breakpoint
CREATE TRIGGER "search_ai_dependents" AFTER INSERT ON "dependents" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('dependents', new."uuid", new."code", new."employee_id", nullif(trim(new."name"), ''), nullif(trim(new."relationship"), ''), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."relationship", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_dependents";
--> statement-breakpoint
CREATE TRIGGER "search_au_dependents" AFTER UPDATE ON "dependents"
WHEN old."code" IS NOT new."code" OR old."employee_id" IS NOT new."employee_id" OR old."name" IS NOT new."name" OR old."relationship" IS NOT new."relationship" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."name"), ''), "subtitle" = nullif(trim(new."relationship"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'dependents' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'dependents' AND "record_id" = new."uuid") AND (old."name" IS NOT new."name" OR old."relationship" IS NOT new."relationship");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'dependents' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."relationship", '') AS "text") WHERE trim("text") <> '' AND (old."name" IS NOT new."name" OR old."relationship" IS NOT new."relationship");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_benefit_enrollments";
--> statement-breakpoint
CREATE TRIGGER "search_ai_benefit_enrollments" AFTER INSERT ON "benefit_enrollments" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('benefit-enrollments', new."uuid", new."code", new."employee_id", NULL, nullif(trim(new."status"), ''), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."status", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_benefit_enrollments";
--> statement-breakpoint
CREATE TRIGGER "search_au_benefit_enrollments" AFTER UPDATE ON "benefit_enrollments"
WHEN old."code" IS NOT new."code" OR old."employee_id" IS NOT new."employee_id" OR old."status" IS NOT new."status" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = NULL, "subtitle" = nullif(trim(new."status"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'benefit-enrollments' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'benefit-enrollments' AND "record_id" = new."uuid") AND (old."status" IS NOT new."status");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'benefit-enrollments' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."status", '') AS "text") WHERE trim("text") <> '' AND (old."status" IS NOT new."status");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_job_requisitions";
--> statement-breakpoint
CREATE TRIGGER "search_ai_job_requisitions" AFTER INSERT ON "job_requisitions" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('job-requisitions', new."uuid", new."code", new."code", nullif(trim(new."title"), ''), coalesce(nullif(trim(new."location"), ''), nullif(trim(new."status"), '')), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."title", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."location", '') || ' ' || coalesce(new."employment_type", '') || ' ' || coalesce(new."status", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_job_requisitions";
--> statement-breakpoint
CREATE TRIGGER "search_au_job_requisitions" AFTER UPDATE ON "job_requisitions"
WHEN old."code" IS NOT new."code" OR old."title" IS NOT new."title" OR old."location" IS NOT new."location" OR old."status" IS NOT new."status" OR old."description" IS NOT new."description" OR old."employment_type" IS NOT new."employment_type" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."code", "title" = nullif(trim(new."title"), ''), "subtitle" = coalesce(nullif(trim(new."location"), ''), nullif(trim(new."status"), '')), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'job-requisitions' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'job-requisitions' AND "record_id" = new."uuid") AND (old."title" IS NOT new."title" OR old."description" IS NOT new."description" OR old."location" IS NOT new."location" OR old."employment_type" IS NOT new."employment_type" OR old."status" IS NOT new."status");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'job-requisitions' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."title", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."location", '') || ' ' || coalesce(new."employment_type", '') || ' ' || coalesce(new."status", '') AS "text") WHERE trim("text") <> '' AND (old."title" IS NOT new."title" OR old."description" IS NOT new."description" OR old."location" IS NOT new."location" OR old."employment_type" IS NOT new."employment_type" OR old."status" IS NOT new."status");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_candidates";
--> statement-breakpoint
CREATE TRIGGER "search_ai_candidates" AFTER INSERT ON "candidates" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('candidates', new."uuid", new."code", new."code", nullif(trim(new."name"), ''), coalesce(nullif(trim(new."email"), ''), nullif(trim(new."source"), '')), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."email", '') || ' ' || coalesce(new."phone", '') || ' ' || coalesce(new."source", '') || ' ' || coalesce(new."tags", '') || ' ' || coalesce(new."notes", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_candidates";
--> statement-breakpoint
CREATE TRIGGER "search_au_candidates" AFTER UPDATE ON "candidates"
WHEN old."code" IS NOT new."code" OR old."name" IS NOT new."name" OR old."email" IS NOT new."email" OR old."source" IS NOT new."source" OR old."phone" IS NOT new."phone" OR old."tags" IS NOT new."tags" OR old."notes" IS NOT new."notes" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."code", "title" = nullif(trim(new."name"), ''), "subtitle" = coalesce(nullif(trim(new."email"), ''), nullif(trim(new."source"), '')), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'candidates' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'candidates' AND "record_id" = new."uuid") AND (old."name" IS NOT new."name" OR old."email" IS NOT new."email" OR old."phone" IS NOT new."phone" OR old."source" IS NOT new."source" OR old."tags" IS NOT new."tags" OR old."notes" IS NOT new."notes");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'candidates' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."email", '') || ' ' || coalesce(new."phone", '') || ' ' || coalesce(new."source", '') || ' ' || coalesce(new."tags", '') || ' ' || coalesce(new."notes", '') AS "text") WHERE trim("text") <> '' AND (old."name" IS NOT new."name" OR old."email" IS NOT new."email" OR old."phone" IS NOT new."phone" OR old."source" IS NOT new."source" OR old."tags" IS NOT new."tags" OR old."notes" IS NOT new."notes");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_applications";
--> statement-breakpoint
CREATE TRIGGER "search_ai_applications" AFTER INSERT ON "applications" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('applications', new."uuid", new."code", new."code", nullif(trim(new."stage"), ''), nullif(trim(new."status"), ''), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."stage", '') || ' ' || coalesce(new."status", '') || ' ' || coalesce(new."rejection_reason", '') || ' ' || coalesce(new."source", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_applications";
--> statement-breakpoint
CREATE TRIGGER "search_au_applications" AFTER UPDATE ON "applications"
WHEN old."code" IS NOT new."code" OR old."stage" IS NOT new."stage" OR old."status" IS NOT new."status" OR old."rejection_reason" IS NOT new."rejection_reason" OR old."source" IS NOT new."source" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."code", "title" = nullif(trim(new."stage"), ''), "subtitle" = nullif(trim(new."status"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'applications' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'applications' AND "record_id" = new."uuid") AND (old."stage" IS NOT new."stage" OR old."status" IS NOT new."status" OR old."rejection_reason" IS NOT new."rejection_reason" OR old."source" IS NOT new."source");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'applications' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."stage", '') || ' ' || coalesce(new."status", '') || ' ' || coalesce(new."rejection_reason", '') || ' ' || coalesce(new."source", '') AS "text") WHERE trim("text") <> '' AND (old."stage" IS NOT new."stage" OR old."status" IS NOT new."status" OR old."rejection_reason" IS NOT new."rejection_reason" OR old."source" IS NOT new."source");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_interviews";
--> statement-breakpoint
CREATE TRIGGER "search_ai_interviews" AFTER INSERT ON "interviews" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('interviews', new."uuid", new."code", new."code", nullif(trim(new."title"), ''), coalesce(nullif(trim(new."mode"), ''), nullif(trim(new."status"), '')), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."title", '') || ' ' || coalesce(new."mode", '') || ' ' || coalesce(new."location", '') || ' ' || coalesce(new."status", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_interviews";
--> statement-breakpoint
CREATE TRIGGER "search_au_interviews" AFTER UPDATE ON "interviews"
WHEN old."code" IS NOT new."code" OR old."title" IS NOT new."title" OR old."mode" IS NOT new."mode" OR old."status" IS NOT new."status" OR old."location" IS NOT new."location" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."code", "title" = nullif(trim(new."title"), ''), "subtitle" = coalesce(nullif(trim(new."mode"), ''), nullif(trim(new."status"), '')), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'interviews' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'interviews' AND "record_id" = new."uuid") AND (old."title" IS NOT new."title" OR old."mode" IS NOT new."mode" OR old."location" IS NOT new."location" OR old."status" IS NOT new."status");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'interviews' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."title", '') || ' ' || coalesce(new."mode", '') || ' ' || coalesce(new."location", '') || ' ' || coalesce(new."status", '') AS "text") WHERE trim("text") <> '' AND (old."title" IS NOT new."title" OR old."mode" IS NOT new."mode" OR old."location" IS NOT new."location" OR old."status" IS NOT new."status");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_interview_feedback";
--> statement-breakpoint
CREATE TRIGGER "search_ai_interview_feedback" AFTER INSERT ON "interview_feedback" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('interview-feedback', new."uuid", new."code", new."author_id", nullif(trim(new."comment"), ''), nullif(trim(new."recommendation"), ''), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."comment", '') || ' ' || coalesce(new."recommendation", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_interview_feedback";
--> statement-breakpoint
CREATE TRIGGER "search_au_interview_feedback" AFTER UPDATE ON "interview_feedback"
WHEN old."code" IS NOT new."code" OR old."author_id" IS NOT new."author_id" OR old."comment" IS NOT new."comment" OR old."recommendation" IS NOT new."recommendation" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."author_id", "title" = nullif(trim(new."comment"), ''), "subtitle" = nullif(trim(new."recommendation"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'interview-feedback' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'interview-feedback' AND "record_id" = new."uuid") AND (old."comment" IS NOT new."comment" OR old."recommendation" IS NOT new."recommendation");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'interview-feedback' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."comment", '') || ' ' || coalesce(new."recommendation", '') AS "text") WHERE trim("text") <> '' AND (old."comment" IS NOT new."comment" OR old."recommendation" IS NOT new."recommendation");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_offers";
--> statement-breakpoint
CREATE TRIGGER "search_ai_offers" AFTER INSERT ON "offers" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('offers', new."uuid", new."code", new."code", nullif(trim(new."notes"), ''), nullif(trim(new."status"), ''), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."status", '') || ' ' || coalesce(new."notes", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_offers";
--> statement-breakpoint
CREATE TRIGGER "search_au_offers" AFTER UPDATE ON "offers"
WHEN old."code" IS NOT new."code" OR old."notes" IS NOT new."notes" OR old."status" IS NOT new."status" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."code", "title" = nullif(trim(new."notes"), ''), "subtitle" = nullif(trim(new."status"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'offers' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'offers' AND "record_id" = new."uuid") AND (old."status" IS NOT new."status" OR old."notes" IS NOT new."notes");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'offers' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."status", '') || ' ' || coalesce(new."notes", '') AS "text") WHERE trim("text") <> '' AND (old."status" IS NOT new."status" OR old."notes" IS NOT new."notes");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_referrals";
--> statement-breakpoint
CREATE TRIGGER "search_ai_referrals" AFTER INSERT ON "referrals" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('referrals', new."uuid", new."code", new."referrer_id", nullif(trim(new."candidate_name"), ''), coalesce(nullif(trim(new."position_title"), ''), nullif(trim(new."status"), '')), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."candidate_name", '') || ' ' || coalesce(new."candidate_email", '') || ' ' || coalesce(new."position_title", '') || ' ' || coalesce(new."notes", '') || ' ' || coalesce(new."status", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_referrals";
--> statement-breakpoint
CREATE TRIGGER "search_au_referrals" AFTER UPDATE ON "referrals"
WHEN old."code" IS NOT new."code" OR old."referrer_id" IS NOT new."referrer_id" OR old."candidate_name" IS NOT new."candidate_name" OR old."position_title" IS NOT new."position_title" OR old."status" IS NOT new."status" OR old."candidate_email" IS NOT new."candidate_email" OR old."notes" IS NOT new."notes" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."referrer_id", "title" = nullif(trim(new."candidate_name"), ''), "subtitle" = coalesce(nullif(trim(new."position_title"), ''), nullif(trim(new."status"), '')), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'referrals' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'referrals' AND "record_id" = new."uuid") AND (old."candidate_name" IS NOT new."candidate_name" OR old."candidate_email" IS NOT new."candidate_email" OR old."position_title" IS NOT new."position_title" OR old."notes" IS NOT new."notes" OR old."status" IS NOT new."status");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'referrals' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."candidate_name", '') || ' ' || coalesce(new."candidate_email", '') || ' ' || coalesce(new."position_title", '') || ' ' || coalesce(new."notes", '') || ' ' || coalesce(new."status", '') AS "text") WHERE trim("text") <> '' AND (old."candidate_name" IS NOT new."candidate_name" OR old."candidate_email" IS NOT new."candidate_email" OR old."position_title" IS NOT new."position_title" OR old."notes" IS NOT new."notes" OR old."status" IS NOT new."status");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_tickets";
--> statement-breakpoint
CREATE TRIGGER "search_ai_tickets" AFTER INSERT ON "tickets" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('tickets', new."uuid", new."code", new."employee_id", nullif(trim(new."subject"), ''), coalesce(nullif(trim(new."category"), ''), nullif(trim(new."state"), '')), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."subject", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."state", '') || ' ' || coalesce(new."priority", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_tickets";
--> statement-breakpoint
CREATE TRIGGER "search_au_tickets" AFTER UPDATE ON "tickets"
WHEN old."code" IS NOT new."code" OR old."employee_id" IS NOT new."employee_id" OR old."subject" IS NOT new."subject" OR old."category" IS NOT new."category" OR old."state" IS NOT new."state" OR old."description" IS NOT new."description" OR old."priority" IS NOT new."priority" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."subject"), ''), "subtitle" = coalesce(nullif(trim(new."category"), ''), nullif(trim(new."state"), '')), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'tickets' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'tickets' AND "record_id" = new."uuid") AND (old."subject" IS NOT new."subject" OR old."description" IS NOT new."description" OR old."category" IS NOT new."category" OR old."state" IS NOT new."state" OR old."priority" IS NOT new."priority");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'tickets' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."subject", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."state", '') || ' ' || coalesce(new."priority", '') AS "text") WHERE trim("text") <> '' AND (old."subject" IS NOT new."subject" OR old."description" IS NOT new."description" OR old."category" IS NOT new."category" OR old."state" IS NOT new."state" OR old."priority" IS NOT new."priority");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_ticket_checklists";
--> statement-breakpoint
CREATE TRIGGER "search_ai_ticket_checklists" AFTER INSERT ON "ticket_checklists" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('ticket-checklists', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), NULL, (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."name", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_ticket_checklists";
--> statement-breakpoint
CREATE TRIGGER "search_au_ticket_checklists" AFTER UPDATE ON "ticket_checklists"
WHEN old."code" IS NOT new."code" OR old."name" IS NOT new."name" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = NULL, "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'ticket-checklists' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'ticket-checklists' AND "record_id" = new."uuid") AND (old."name" IS NOT new."name");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'ticket-checklists' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."name", '') AS "text") WHERE trim("text") <> '' AND (old."name" IS NOT new."name");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_suggestions";
--> statement-breakpoint
CREATE TRIGGER "search_ai_suggestions" AFTER INSERT ON "suggestions" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('suggestions', new."uuid", new."code", new."submitter_id", nullif(trim(new."title"), ''), coalesce(nullif(trim(new."category"), ''), nullif(trim(new."status"), '')), (new."delete_time" IS NOT NULL OR new."held_at" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."title", '') || ' ' || coalesce(new."body", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."response", '') || ' ' || coalesce(new."status", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_suggestions";
--> statement-breakpoint
CREATE TRIGGER "search_au_suggestions" AFTER UPDATE ON "suggestions"
WHEN old."code" IS NOT new."code" OR old."submitter_id" IS NOT new."submitter_id" OR old."title" IS NOT new."title" OR old."category" IS NOT new."category" OR old."status" IS NOT new."status" OR old."body" IS NOT new."body" OR old."response" IS NOT new."response" OR old."delete_time" IS NOT new."delete_time" OR old."held_at" IS NOT new."held_at" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."submitter_id", "title" = nullif(trim(new."title"), ''), "subtitle" = coalesce(nullif(trim(new."category"), ''), nullif(trim(new."status"), '')), "deleted" = (new."delete_time" IS NOT NULL OR new."held_at" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'suggestions' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'suggestions' AND "record_id" = new."uuid") AND (old."title" IS NOT new."title" OR old."body" IS NOT new."body" OR old."category" IS NOT new."category" OR old."response" IS NOT new."response" OR old."status" IS NOT new."status");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'suggestions' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."title", '') || ' ' || coalesce(new."body", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."response", '') || ' ' || coalesce(new."status", '') AS "text") WHERE trim("text") <> '' AND (old."title" IS NOT new."title" OR old."body" IS NOT new."body" OR old."category" IS NOT new."category" OR old."response" IS NOT new."response" OR old."status" IS NOT new."status");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_assets";
--> statement-breakpoint
CREATE TRIGGER "search_ai_assets" AFTER INSERT ON "assets" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('assets', new."uuid", new."code", new."assigned_to", nullif(trim(new."name"), ''), coalesce(nullif(trim(new."asset_tag"), ''), nullif(trim(new."status"), '')), 0, 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."asset_tag", '') || ' ' || coalesce(new."serial_number", '') || ' ' || coalesce(new."notes", '') || ' ' || coalesce(new."status", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_assets";
--> statement-breakpoint
CREATE TRIGGER "search_au_assets" AFTER UPDATE ON "assets"
WHEN old."code" IS NOT new."code" OR old."assigned_to" IS NOT new."assigned_to" OR old."name" IS NOT new."name" OR old."asset_tag" IS NOT new."asset_tag" OR old."status" IS NOT new."status" OR old."serial_number" IS NOT new."serial_number" OR old."notes" IS NOT new."notes" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."assigned_to", "title" = nullif(trim(new."name"), ''), "subtitle" = coalesce(nullif(trim(new."asset_tag"), ''), nullif(trim(new."status"), '')), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'assets' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'assets' AND "record_id" = new."uuid") AND (old."name" IS NOT new."name" OR old."asset_tag" IS NOT new."asset_tag" OR old."serial_number" IS NOT new."serial_number" OR old."notes" IS NOT new."notes" OR old."status" IS NOT new."status");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'assets' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."asset_tag", '') || ' ' || coalesce(new."serial_number", '') || ' ' || coalesce(new."notes", '') || ' ' || coalesce(new."status", '') AS "text") WHERE trim("text") <> '' AND (old."name" IS NOT new."name" OR old."asset_tag" IS NOT new."asset_tag" OR old."serial_number" IS NOT new."serial_number" OR old."notes" IS NOT new."notes" OR old."status" IS NOT new."status");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_asset_categories";
--> statement-breakpoint
CREATE TRIGGER "search_ai_asset_categories" AFTER INSERT ON "asset_categories" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('asset-categories', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), nullif(trim(new."tag_code"), ''), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."tag_code", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_asset_categories";
--> statement-breakpoint
CREATE TRIGGER "search_au_asset_categories" AFTER UPDATE ON "asset_categories"
WHEN old."code" IS NOT new."code" OR old."name" IS NOT new."name" OR old."tag_code" IS NOT new."tag_code" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = nullif(trim(new."tag_code"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'asset-categories' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'asset-categories' AND "record_id" = new."uuid") AND (old."name" IS NOT new."name" OR old."tag_code" IS NOT new."tag_code");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'asset-categories' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."tag_code", '') AS "text") WHERE trim("text") <> '' AND (old."name" IS NOT new."name" OR old."tag_code" IS NOT new."tag_code");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_stocktakes";
--> statement-breakpoint
CREATE TRIGGER "search_ai_stocktakes" AFTER INSERT ON "stocktakes" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('stocktakes', new."uuid", new."code", NULL, nullif(trim(new."label"), ''), nullif(trim(new."status"), ''), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."label", '') || ' ' || coalesce(new."notes", '') || ' ' || coalesce(new."status", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_stocktakes";
--> statement-breakpoint
CREATE TRIGGER "search_au_stocktakes" AFTER UPDATE ON "stocktakes"
WHEN old."code" IS NOT new."code" OR old."label" IS NOT new."label" OR old."status" IS NOT new."status" OR old."notes" IS NOT new."notes" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."label"), ''), "subtitle" = nullif(trim(new."status"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'stocktakes' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'stocktakes' AND "record_id" = new."uuid") AND (old."label" IS NOT new."label" OR old."notes" IS NOT new."notes" OR old."status" IS NOT new."status");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'stocktakes' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."label", '') || ' ' || coalesce(new."notes", '') || ' ' || coalesce(new."status", '') AS "text") WHERE trim("text") <> '' AND (old."label" IS NOT new."label" OR old."notes" IS NOT new."notes" OR old."status" IS NOT new."status");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_notifications";
--> statement-breakpoint
CREATE TRIGGER "search_ai_notifications" AFTER INSERT ON "notifications" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('notifications', new."uuid", new."code", new."recipient_id", nullif(trim(new."title"), ''), nullif(trim(new."body"), ''), 0, 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."title", '') || ' ' || coalesce(new."body", '') || ' ' || coalesce(new."type", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_notifications";
--> statement-breakpoint
CREATE TRIGGER "search_au_notifications" AFTER UPDATE ON "notifications"
WHEN old."code" IS NOT new."code" OR old."recipient_id" IS NOT new."recipient_id" OR old."title" IS NOT new."title" OR old."body" IS NOT new."body" OR old."type" IS NOT new."type" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."recipient_id", "title" = nullif(trim(new."title"), ''), "subtitle" = nullif(trim(new."body"), ''), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'notifications' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'notifications' AND "record_id" = new."uuid") AND (old."title" IS NOT new."title" OR old."body" IS NOT new."body" OR old."type" IS NOT new."type");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'notifications' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."title", '') || ' ' || coalesce(new."body", '') || ' ' || coalesce(new."type", '') AS "text") WHERE trim("text") <> '' AND (old."title" IS NOT new."title" OR old."body" IS NOT new."body" OR old."type" IS NOT new."type");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_automations";
--> statement-breakpoint
CREATE TRIGGER "search_ai_automations" AFTER INSERT ON "automations" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('automations', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), nullif(trim(new."description"), ''), 0, 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."trigger_type", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_automations";
--> statement-breakpoint
CREATE TRIGGER "search_au_automations" AFTER UPDATE ON "automations"
WHEN old."code" IS NOT new."code" OR old."name" IS NOT new."name" OR old."description" IS NOT new."description" OR old."trigger_type" IS NOT new."trigger_type" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = nullif(trim(new."description"), ''), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'automations' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'automations' AND "record_id" = new."uuid") AND (old."name" IS NOT new."name" OR old."description" IS NOT new."description" OR old."trigger_type" IS NOT new."trigger_type");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'automations' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."trigger_type", '') AS "text") WHERE trim("text") <> '' AND (old."name" IS NOT new."name" OR old."description" IS NOT new."description" OR old."trigger_type" IS NOT new."trigger_type");
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_ai_table_views";
--> statement-breakpoint
CREATE TRIGGER "search_ai_table_views" AFTER INSERT ON "table_views" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at) VALUES ('table-views', new."uuid", new."code", new."owner_id", nullif(trim(new."name"), ''), coalesce(nullif(trim(new."description"), ''), nullif(trim(new."base"), '')), (new."delete_time" IS NOT NULL), 0, new."created_at");
  INSERT INTO "search_fts" ("rowid", "text") SELECT last_insert_rowid(), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."base", '') AS "text") WHERE trim("text") <> '';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_au_table_views";
--> statement-breakpoint
CREATE TRIGGER "search_au_table_views" AFTER UPDATE ON "table_views"
WHEN old."code" IS NOT new."code" OR old."owner_id" IS NOT new."owner_id" OR old."name" IS NOT new."name" OR old."description" IS NOT new."description" OR old."base" IS NOT new."base" OR old."delete_time" IS NOT new."delete_time" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."owner_id", "title" = nullif(trim(new."name"), ''), "subtitle" = coalesce(nullif(trim(new."description"), ''), nullif(trim(new."base"), '')), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'table-views' AND "record_id" = new."uuid";
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'table-views' AND "record_id" = new."uuid") AND (old."name" IS NOT new."name" OR old."description" IS NOT new."description" OR old."base" IS NOT new."base");
  INSERT INTO "search_fts" ("rowid", "text") SELECT (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'table-views' AND "record_id" = new."uuid"), "text" FROM (SELECT coalesce(new."name", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."base", '') AS "text") WHERE trim("text") <> '' AND (old."name" IS NOT new."name" OR old."description" IS NOT new."description" OR old."base" IS NOT new."base");
END;

-- Adds the IT Admin role on the live database, moves the asset register from HR to it, lets HR reset an app PIN,
-- and hands the IT help desk to the new role. Data only; no schema change. Every statement is idempotent, so a
-- re-run changes nothing. The seed side of the same change is bootstrap/authz/roles/it_admin.json and
-- hr_admin.json; this is what reaches a database the seed has already run on.
--
-- 1. The `it_admin` role row, left alone if the org already made a role by that name. Only on a database that
--    has been seeded (it has roles): a fresh one runs every migration and THEN its seed, which writes it_admin
--    and its rules itself, so here every step finds nothing to do. Each later step keys off this row or off rows
--    the seed writes. `provisioned` is left to its default (false): the column arrives in 0002, and a test that
--    applies migrations around one section may run this file first.
--
-- 2. Its rules. A seeded role file `extends: employee`, but the database has no inheritance: every role is its
--    own flat set of rows. So it_admin starts from a copy of the LIVE employee role's active broad rules (what
--    the org's employees hold today, including any change made in Access Management since the seed), and then
--    gets its own: the asset register, the asset desk and the asset-tag setting. Where both name a pattern
--    (`asset-categories.**`, employee read and it_admin write) the decision takes the higher level, so the pair
--    decides exactly as the seed's single write row does.
--
-- 3. hr_admin loses the asset rules the seed took away, matched on the full rule (pattern, level, effect) and
--    only the seeded broad row (`source = 'acl'`, no match_code) - never a per-record share an admin authored.
--    It keeps reading asset categories like every employee, and gains read on the account list and the
--    `resetPin` verb, which the lock screen has always told people HR can do.
--
-- 4. The IT ticket desk (category key `it`) is serviced by it_admin: `roles: ["it_admin"]` on that category in
--    the `ticket-categories` setting, unless the org has already set roles on it. With no settings row the
--    service falls back to DEFAULT_TICKET_CATEGORIES, which names it_admin already.
--
-- 5. Every IT ticket already filed gets the per-ticket pair services/ticketShares.ts writes for a servicing
--    role: `tickets.<code>.**` at write, and the same pattern as a verb rule. Only when step 4 left the desk
--    serviced by it_admin.
--
-- Nobody holds it_admin until an admin gives it to the IT staff in Settings, Users.
--
-- Ids are this app's 8-byte ids (lib/idCodec.ts genId): 13 Crockford base32 characters, the last from an EVEN
-- index because 64 bits leave its lowest bit as padding, which the canonical decoder rejects when set. The
-- cache counters move on their own: the access_rules and roles triggers (migration 0003) fire on these writes.

INSERT OR IGNORE INTO roles (name, label, protected, created_at, updated_at)
SELECT 'it_admin', 'IT Admin', 1, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE EXISTS (SELECT 1 FROM roles);
--> statement-breakpoint
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
  'it_admin', 'role', r.namespace, r.pattern, r.scope_kind, r.scope_code, NULL, r.level, r.effect, r.condition, r.from_ip, r."window", 'acl', 'active', NULL, r.expires_at,
  CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
  CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
FROM access_rules r
WHERE r.subject = 'employee'
  AND r.subject_kind = 'role'
  AND r.match_code IS NULL
  AND r.status = 'active'
  AND EXISTS (SELECT 1 FROM roles WHERE name = 'it_admin')
  AND NOT EXISTS (
    SELECT 1 FROM access_rules x
    WHERE x.subject = 'it_admin' AND x.subject_kind = 'role' AND x.match_code IS NULL
      AND x.pattern = r.pattern AND x.effect = r.effect AND x.level IS r.level
  );
--> statement-breakpoint
INSERT INTO access_rules (uuid, subject, subject_kind, namespace, pattern, scope_kind, scope_code, match_code, level, effect, source, status, created_at, updated_at)
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
  n.subject, 'role', n.namespace, n.pattern, 'all', '', NULL, n.level, 'allow', 'acl', 'active',
  CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
  CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
-- The rules as a JSON list rather than a UNION ALL of SELECTs: D1 caps the terms of a compound SELECT, and a
-- 16-term one stops the migration there. A JSON null is SQL NULL (a verb rule).
FROM (
  SELECT json_extract(j.value, '$[0]') AS subject, json_extract(j.value, '$[1]') AS namespace,
         json_extract(j.value, '$[2]') AS pattern, json_extract(j.value, '$[3]') AS level
  FROM json_each('[
    ["it_admin", "assets", "assets.**", "write"],
    ["it_admin", "asset-categories", "asset-categories.**", "write"],
    ["it_admin", "asset-requests", "asset-requests.**", "read"],
    ["it_admin", "stocktakes", "stocktakes.**", "write"],
    ["it_admin", "ticket-checklists", "ticket-checklists.**", "read"],
    ["it_admin", "settings", "settings.asset-tags", "write"],
    ["it_admin", "assets", "assets.**", null],
    ["it_admin", "asset-categories", "asset-categories.**", null],
    ["it_admin", "stocktakes", "stocktakes.**", null],
    ["it_admin", "asset-requests", "asset-requests.*.approve", null],
    ["it_admin", "asset-requests", "asset-requests.*.reject", null],
    ["it_admin", "asset-requests", "asset-requests.*.issue", null],
    ["hr_admin", "asset-categories", "asset-categories.**", "read"],
    ["hr_admin", "users", "users", "read"],
    ["hr_admin", "users", "users.**", "read"],
    ["hr_admin", "users", "users.**.resetPin", null]
  ]') j
) n
WHERE EXISTS (SELECT 1 FROM roles WHERE name = n.subject)
  AND NOT EXISTS (
    SELECT 1 FROM access_rules x
    WHERE x.subject = n.subject AND x.subject_kind = 'role' AND x.match_code IS NULL
      AND x.pattern = n.pattern AND x.effect = 'allow' AND x.level IS n.level
  );
--> statement-breakpoint
DELETE FROM access_rules
WHERE subject = 'hr_admin'
  AND subject_kind = 'role'
  AND match_code IS NULL
  AND source = 'acl'
  AND effect = 'allow'
  AND (
       (pattern = 'assets.**' AND level = 'write')
    OR (pattern = 'assets.**' AND level IS NULL)
    OR (pattern = 'asset-categories.**' AND level = 'write')
    OR (pattern = 'asset-categories.**' AND level IS NULL)
    OR (pattern = 'asset-requests.**' AND level = 'read')
    OR (pattern = 'asset-requests.*.approve' AND level IS NULL)
    OR (pattern = 'asset-requests.*.reject' AND level IS NULL)
    OR (pattern = 'asset-requests.*.issue' AND level IS NULL)
    OR (pattern = 'stocktakes.**' AND level = 'write')
    OR (pattern = 'stocktakes.**' AND level IS NULL)
    OR (pattern = 'settings.asset-tags' AND level = 'write')
  );
--> statement-breakpoint
UPDATE settings
SET value = json_set(
      value,
      '$.categories[' || (SELECT c.key FROM json_each(settings.value, '$.categories') c WHERE json_extract(c.value, '$.key') = 'it' LIMIT 1) || '].roles',
      json_array('it_admin')
    ),
    updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE key = 'ticket-categories'
  AND json_valid(value)
  AND EXISTS (
    SELECT 1 FROM json_each(settings.value, '$.categories') c
    WHERE json_extract(c.value, '$.key') = 'it' AND json_type(c.value, '$.roles') IS NULL
  );
--> statement-breakpoint
INSERT INTO access_rules (uuid, subject, subject_kind, namespace, pattern, scope_kind, scope_code, match_code, level, effect, source, status, created_at, updated_at)
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
  'it_admin', 'role', 'tickets', 'tickets.' || t.code || '.**', 'exact', t.code, t.code, l.level, 'allow', 'ticket-share', 'active',
  CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
  CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
FROM tickets t
CROSS JOIN (SELECT j.value AS level FROM json_each('["write", null]') j) l
WHERE t.category = 'it'
  AND t.code IS NOT NULL
  AND EXISTS (SELECT 1 FROM roles WHERE name = 'it_admin')
  AND (
    NOT EXISTS (SELECT 1 FROM settings WHERE key = 'ticket-categories')
    OR EXISTS (
      SELECT 1 FROM settings s, json_each(s.value, '$.categories') c, json_each(c.value, '$.roles') rl
      WHERE s.key = 'ticket-categories' AND json_valid(s.value) AND json_extract(c.value, '$.key') = 'it' AND rl.value = 'it_admin'
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM access_rules x
    WHERE x.subject = 'it_admin' AND x.subject_kind = 'role' AND x.source = 'ticket-share'
      AND x.pattern = 'tickets.' || t.code || '.**' AND x.effect = 'allow' AND x.level IS l.level
  );
--> statement-breakpoint

-- An attendance regularization keeps the day's live punches as they were when it was filed
-- (`recorded_sessions`), so a reader can show the change against them. NULL on requests filed before this.
ALTER TABLE `attendance_regularizations` ADD `recorded_sessions` text;
--> statement-breakpoint

-- Board access: a department on a board, and per-board visibility. The seed side is domain/boardAccess.ts,
-- services/boardShares.ts, bootstrap/authz/roles/*.json and bootstrap/authz/policy.ts; this is what reaches a
-- database the seed has already run on. Every data statement is guarded, so a re-run changes nothing, and on a
-- fresh database (migrations first, then the seed) every one of them finds nothing to do.
--
-- 1. Schema: `boards.department_id` (the department whose managers manage the board) and `boards.shares_json`
--    (its sharing list).
--
-- 2. Codes. The code of a board now starts with its visibility segment (`ve-` everyone works it, `vr-` everyone
--    sees it, `vp-` private) and its cards and sprints are coded under it. Every existing board becomes
--    `ve-<old code>` - everyone sees and works it, exactly as before - a card becomes `<board code>-<task
--    number>`, and a sprint `<board code>-<position on the board>`. Old and new codes pass through a scratch
--    table so any access rule naming an old board, card or sprint code (a per-record share authored in Access
--    Management) is carried to the new one in the same pass. A rule scoped to the OLD employee prefix of a card
--    (`cards.04-*`) has no new home - cards are no longer coded by who filed them - and is left to match nothing.
--
-- 3. Role rules. The org-wide board, card and sprint rules of the seeded roles become rules on the two
--    org-visible segments, and managers and HR lose their manage-every-board rules (they keep creating boards).
--    Only the seeded role names are touched: a rule an org gave a role of its own is its decision.
--
-- 4. The project_manager role (bootstrap/authz/roles/project_manager.json), which manages every board: the
--    role row, a copy of the live employee rules (after step 3), and its own.
--
-- 5. The policy manifest: a card is filed under its board (owner_refs), a sprint needs write on its board
--    (references), and cards no longer offer the employee-relative scope tiers.
--
-- Ids are the 8-byte ids of lib/idCodec.ts genId: 13 Crockford base32 characters, the last from an EVEN index.
-- The cache counters move on their own: the access_rules and roles triggers (migration 0003) fire here.
--
-- Every `END` of a CASE is followed by whitespace: the statement splitter wrangler runs only closes a CASE on
-- `END` + space or `;`, and `END,` would swallow every statement after it (test/searchDdlDrift.test.ts).
ALTER TABLE `boards` ADD `department_id` text REFERENCES departments(uuid);--> statement-breakpoint
ALTER TABLE `boards` ADD `shares_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE INDEX `boards_department_idx` ON `boards` (`department_id`);--> statement-breakpoint
-- A board changing visibility re-codes it and everything under it (services/boardShares.ts recodeBoard), so the
-- uuid->code cache of every instance must hear about it, as it hears about a re-parent (lib/authzResolve.ts).
-- The cards and sprints move in the same batch, so the row of the board itself is enough.
CREATE TRIGGER IF NOT EXISTS "gen_boards_u" AFTER UPDATE OF "code" ON "boards" WHEN OLD."code" IS NOT NEW."code" BEGIN
  UPDATE "cache_generations" SET "codes" = "codes" + 1 WHERE "id" = 1;
END;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `_board_recode` (`ns` text NOT NULL, `old` text NOT NULL, `new` text NOT NULL);--> statement-breakpoint
DELETE FROM `_board_recode`;--> statement-breakpoint
INSERT INTO `_board_recode` (ns, old, new)
SELECT 'boards', code, 've-' || code FROM boards
WHERE code IS NOT NULL AND code NOT GLOB 've-*' AND code NOT GLOB 'vr-*' AND code NOT GLOB 'vp-*';--> statement-breakpoint
-- The leaf of a card is its task number (`seq`, unique per board) in base32, three characters wide - four past
-- 32767, as domain/codes.ts padSeg spills.
INSERT INTO `_board_recode` (ns, old, new)
SELECT 'cards', c.code,
  m.new || '-' ||
  CASE WHEN c.seq >= 32768 THEN substr('0123456789abcdefghjkmnpqrstvwxyz', ((c.seq / 32768) % 32) + 1, 1) ELSE '' END ||
  substr('0123456789abcdefghjkmnpqrstvwxyz', ((c.seq / 1024) % 32) + 1, 1) ||
  substr('0123456789abcdefghjkmnpqrstvwxyz', ((c.seq / 32) % 32) + 1, 1) ||
  substr('0123456789abcdefghjkmnpqrstvwxyz', (c.seq % 32) + 1, 1)
FROM cards c
JOIN boards b ON b.uuid = c.board_id
JOIN `_board_recode` m ON m.ns = 'boards' AND m.old = b.code
WHERE c.code IS NOT NULL;--> statement-breakpoint
INSERT INTO `_board_recode` (ns, old, new)
SELECT 'sprints', o.code,
  m.new || '-' ||
  substr('0123456789abcdefghjkmnpqrstvwxyz', ((o.n / 1024) % 32) + 1, 1) ||
  substr('0123456789abcdefghjkmnpqrstvwxyz', ((o.n / 32) % 32) + 1, 1) ||
  substr('0123456789abcdefghjkmnpqrstvwxyz', (o.n % 32) + 1, 1)
FROM (SELECT code, board_id, row_number() OVER (PARTITION BY board_id ORDER BY created_at, uuid) AS n FROM sprints WHERE code IS NOT NULL) o
JOIN boards b ON b.uuid = o.board_id
JOIN `_board_recode` m ON m.ns = 'boards' AND m.old = b.code;--> statement-breakpoint
-- Rules first, while the old codes still identify them: the id token of the pattern, the narrowing keys with it.
UPDATE access_rules
SET pattern = namespace || '.' || (SELECT m.new FROM `_board_recode` m WHERE m.ns = access_rules.namespace AND m.old = access_rules.scope_code)
              || substr(pattern, length(namespace) + 2 + length(scope_code)),
    match_code = CASE WHEN match_code IS NULL THEN NULL ELSE (SELECT m.new FROM `_board_recode` m WHERE m.ns = access_rules.namespace AND m.old = access_rules.scope_code) END ,
    scope_code = (SELECT m.new FROM `_board_recode` m WHERE m.ns = access_rules.namespace AND m.old = access_rules.scope_code),
    updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE namespace IN ('boards', 'cards', 'sprints')
  AND scope_kind IN ('exact', 'subtree')
  AND EXISTS (SELECT 1 FROM `_board_recode` m WHERE m.ns = access_rules.namespace AND m.old = access_rules.scope_code);--> statement-breakpoint
UPDATE cards SET code = (SELECT m.new FROM `_board_recode` m WHERE m.ns = 'cards' AND m.old = cards.code)
WHERE code IN (SELECT old FROM `_board_recode` WHERE ns = 'cards');--> statement-breakpoint
UPDATE sprints SET code = (SELECT m.new FROM `_board_recode` m WHERE m.ns = 'sprints' AND m.old = sprints.code)
WHERE code IN (SELECT old FROM `_board_recode` WHERE ns = 'sprints');--> statement-breakpoint
UPDATE boards SET code = (SELECT m.new FROM `_board_recode` m WHERE m.ns = 'boards' AND m.old = boards.code)
WHERE code IN (SELECT old FROM `_board_recode` WHERE ns = 'boards');--> statement-breakpoint
DROP TABLE `_board_recode`;--> statement-breakpoint
-- Step 3. Each seeded role holding an old org-wide rule gains its replacements: [old pattern, old level ("*" =
-- any level, null = a verb rule), new namespace, new pattern, scope kind, scope code, new level]. A new level of
-- "create" is the collection gate: write for the roles that create boards, read for everyone else.
INSERT INTO access_rules (uuid, subject, subject_kind, namespace, pattern, scope_kind, scope_code, match_code, level, effect, source, status, created_at, updated_at)
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
  n.subject, 'role', n.namespace, n.pattern, n.scope_kind, n.scope_code, NULL, n.level, 'allow', 'acl', 'active',
  CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
  CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
FROM (
  SELECT DISTINCT r.subject, m.namespace, m.pattern, m.scope_kind, m.scope_code,
    CASE WHEN m.level = 'create' THEN (CASE WHEN r.subject IN ('manager', 'hr_admin') THEN 'write' ELSE 'read' END ) ELSE m.level END AS level
  FROM access_rules r
  JOIN (
    SELECT json_extract(j.value, '$[0]') AS old_pattern, json_extract(j.value, '$[1]') AS old_level,
           json_extract(j.value, '$[2]') AS namespace, json_extract(j.value, '$[3]') AS pattern,
           json_extract(j.value, '$[4]') AS scope_kind, json_extract(j.value, '$[5]') AS scope_code,
           json_extract(j.value, '$[6]') AS level
    FROM json_each('[
      ["boards.**", "*", "boards", "boards", "all", "", "create"],
      ["boards.**", "*", "boards", "boards.ve-*.**", "subtree", "ve", "read"],
      ["boards.**", "*", "boards", "boards.vr-*.**", "subtree", "vr", "read"],
      ["sprints.**", "*", "sprints", "sprints", "all", "", "write"],
      ["sprints.**", "*", "sprints", "sprints.ve-*.**", "subtree", "ve", "read"],
      ["sprints.**", "*", "sprints", "sprints.vr-*.**", "subtree", "vr", "read"],
      ["cards.**", "*", "cards", "cards", "all", "", "write"],
      ["cards.**", "*", "cards", "cards.ve-*.**", "subtree", "ve", "write"],
      ["cards.**", "*", "cards", "cards.vr-*.**", "subtree", "vr", "read"],
      ["boards.*.metrics", null, "boards", "boards.ve-*.metrics", "subtree", "ve", null],
      ["boards.*.metrics", null, "boards", "boards.vr-*.metrics", "subtree", "vr", null],
      ["cards.*.move", null, "cards", "cards.ve-*.move", "subtree", "ve", null],
      ["cards.*.block", null, "cards", "cards.ve-*.block", "subtree", "ve", null],
      ["cards.*.unblock", null, "cards", "cards.ve-*.unblock", "subtree", "ve", null],
      ["cards.*.assign", null, "cards", "cards.ve-*.assign", "subtree", "ve", null],
      ["cards.*.prioritize", null, "cards", "cards.ve-*.prioritize", "subtree", "ve", null],
      ["cards.*.comment", null, "cards", "cards.ve-*.comment", "subtree", "ve", null],
      ["cards.*.addTodos", null, "cards", "cards.ve-*.addTodos", "subtree", "ve", null],
      ["cards.*.toggleTodo", null, "cards", "cards.ve-*.toggleTodo", "subtree", "ve", null],
      ["cards.*.removeTodo", null, "cards", "cards.ve-*.removeTodo", "subtree", "ve", null],
      ["cards.*.promoteTodo", null, "cards", "cards.ve-*.promoteTodo", "subtree", "ve", null],
      ["cards.*.suggestSteps", null, "cards", "cards.ve-*.suggestSteps", "subtree", "ve", null],
      ["cards.*.suggestGoal", null, "cards", "cards.ve-*.suggestGoal", "subtree", "ve", null],
      ["cards.*.watch", null, "cards", "cards.ve-*.watch", "subtree", "ve", null],
      ["cards.*.watch", null, "cards", "cards.vr-*.watch", "subtree", "vr", null],
      ["cards.*.unwatch", null, "cards", "cards.ve-*.unwatch", "subtree", "ve", null],
      ["cards.*.unwatch", null, "cards", "cards.vr-*.unwatch", "subtree", "vr", null],
      ["cards.*.flow", null, "cards", "cards.ve-*.flow", "subtree", "ve", null],
      ["cards.*.flow", null, "cards", "cards.vr-*.flow", "subtree", "vr", null],
      ["cards.*.triage", null, "cards", "cards.ve-*.triage", "subtree", "ve", null],
      ["cards.*.triage", null, "cards", "cards.vr-*.triage", "subtree", "vr", null]
    ]') j
  ) m ON r.pattern = m.old_pattern AND ((m.old_level IS NULL AND r.level IS NULL) OR (m.old_level = '*' AND r.level IS NOT NULL))
  WHERE r.subject IN ('employee', 'team_lead', 'manager', 'hr_admin', 'payroll_admin', 'it_admin')
    AND r.subject_kind = 'role' AND r.match_code IS NULL AND r.effect = 'allow' AND r.status = 'active'
) n
WHERE NOT EXISTS (
  SELECT 1 FROM access_rules x
  WHERE x.subject = n.subject AND x.subject_kind = 'role' AND x.match_code IS NULL
    AND x.pattern = n.pattern AND x.effect = 'allow' AND x.level IS n.level
);--> statement-breakpoint
-- A role that already creates boards keeps a single collection gate: the read the mapping above may have added
-- beside an existing write says nothing the write does not.
DELETE FROM access_rules
WHERE subject IN ('manager', 'hr_admin') AND subject_kind = 'role' AND match_code IS NULL AND effect = 'allow'
  AND pattern = 'boards' AND level = 'read';--> statement-breakpoint
-- The old org-wide rules go: the reads, card work and metrics above replace them, and the manage-every-board
-- rules managers, HR and payroll held are what this change takes away.
DELETE FROM access_rules
WHERE subject IN ('employee', 'team_lead', 'manager', 'hr_admin', 'payroll_admin', 'it_admin')
  AND subject_kind = 'role' AND match_code IS NULL AND source = 'acl' AND effect = 'allow'
  AND (
       pattern IN ('boards.**', 'sprints.**', 'cards.**')
    OR (level IS NULL AND pattern IN (
      'boards.*.metrics', 'cards.*.move', 'cards.*.block', 'cards.*.unblock', 'cards.*.assign', 'cards.*.prioritize',
      'cards.*.comment', 'cards.*.addTodos', 'cards.*.toggleTodo', 'cards.*.removeTodo', 'cards.*.promoteTodo',
      'cards.*.suggestSteps', 'cards.*.suggestGoal', 'cards.*.watch', 'cards.*.unwatch', 'cards.*.flow', 'cards.*.triage'
    ))
  );--> statement-breakpoint
-- Step 4. The project manager: the role row (only on a database that has been seeded), then the live employee
-- rules, then its own.
INSERT OR IGNORE INTO roles (name, label, protected, created_at, updated_at)
SELECT 'project_manager', 'Project Manager', 1, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE EXISTS (SELECT 1 FROM roles);--> statement-breakpoint
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
  'project_manager', 'role', r.namespace, r.pattern, r.scope_kind, r.scope_code, NULL, r.level, r.effect, r.condition, r.from_ip, r."window", 'acl', 'active', NULL, r.expires_at,
  CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
  CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
FROM access_rules r
WHERE r.subject = 'employee' AND r.subject_kind = 'role' AND r.match_code IS NULL AND r.status = 'active'
  AND EXISTS (SELECT 1 FROM roles WHERE name = 'project_manager')
  AND NOT EXISTS (
    SELECT 1 FROM access_rules x
    WHERE x.subject = 'project_manager' AND x.subject_kind = 'role' AND x.match_code IS NULL
      AND x.pattern = r.pattern AND x.effect = r.effect AND x.level IS r.level
  );--> statement-breakpoint
INSERT INTO access_rules (uuid, subject, subject_kind, namespace, pattern, scope_kind, scope_code, match_code, level, effect, source, status, created_at, updated_at)
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
  'project_manager', 'role', n.namespace, n.pattern, n.scope_kind, '', NULL, n.level, 'allow', 'acl', 'active',
  CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
  CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
FROM (
  SELECT json_extract(j.value, '$[0]') AS namespace, json_extract(j.value, '$[1]') AS pattern,
         json_extract(j.value, '$[2]') AS scope_kind, json_extract(j.value, '$[3]') AS level
  FROM json_each('[
    ["boards", "boards.**", "all", "write"],
    ["sprints", "sprints.**", "all", "write"],
    ["cards", "cards.**", "all", "write"],
    ["goals", "goals.my-reports.**", "reports", "write"],
    ["goal-templates", "goal-templates.**", "all", "read"],
    ["boards", "boards.**", "all", null],
    ["sprints", "sprints.**", "all", null],
    ["cards", "cards.**", "all", null],
    ["goals", "goals.my-reports.approve", "reports", null],
    ["goals", "goals.my-reports.requestChanges", "reports", null],
    ["goals", "goals.my-reports.setConfidence", "reports", null],
    ["goals", "goals.my-reports.comment", "reports", null],
    ["goals", "goals.my-reports.watch", "reports", null],
    ["goals", "goals.my-reports.unwatch", "reports", null],
    ["goals", "goals.my-reports.similar", "reports", null],
    ["goals", "goals.my-reports.suggestMeasure", "reports", null],
    ["goal-templates", "goal-templates.*.apply", "all", null]
  ]') j
) n
WHERE EXISTS (SELECT 1 FROM roles WHERE name = 'project_manager')
  AND NOT EXISTS (
    SELECT 1 FROM access_rules x
    WHERE x.subject = 'project_manager' AND x.subject_kind = 'role' AND x.match_code IS NULL
      AND x.pattern = n.pattern AND x.effect = 'allow' AND x.level IS n.level
  );--> statement-breakpoint
-- Step 5. The policy manifest, where it still says what the seed used to.
UPDATE policy
SET value_json = json_set(
      json_remove(value_json, '$.supported_scopes.cards'),
      '$.owner_refs.cards.board', json('{"collection":"boards"}'),
      '$.references.sprints.board.level', 'write'
    ),
    updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE key = 'manifest'
  AND json_extract(value_json, '$.owner_refs.cards.board') IS NULL;

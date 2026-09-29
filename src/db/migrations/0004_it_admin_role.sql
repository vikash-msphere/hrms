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

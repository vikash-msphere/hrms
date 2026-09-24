-- Makes `employees.probation_end_date` a redacted field on the live database, without taking it from anyone who
-- should keep it. Data only; no schema change. Every statement is idempotent, so a re-run changes nothing.
--
-- 1. The policy manifest row. Production reads `policy.redacted_fields` from the `policy` table, not from
--    DEFAULT_POLICY in src/domain/manifests.ts, so the code change alone would never reach it. Three statements
--    cover the three shapes the row can be in: no `redacted_fields` at all, no `employees` entry yet, and an
--    `employees` entry an admin already wrote.
--
-- 2. The access rules that keep the field readable. A redacted field is decided at
--    `employees.<code>.probation_end_date` level read. A rule ending in `**` (`employees.**`,
--    `employees.my-dept.**`, `employees.<code>.**`, which is every shape the ACL editor writes) already reaches
--    it. A 2-token rule (`employees.*`, `employees.me`, `employees.my-dept`, the seeded shape) stops at the row
--    and does not. So every active 2-token allow on an employee row gets a sibling
--    `<pattern>.probation_end_date.**` read rule, with the same holder, scope, conditions and expiry.
--
--    One exception: `employees.*` at level READ gets no sibling. Org-wide read-only is directory breadth, and
--    it is the grant that showed every reader everyone's probation date. Org-wide WRITE (HR editing any
--    record) keeps it, as do self (`me`), the management scopes (`my-dept`, `my-reports`, `my-org`), branch
--    subtrees and single-record shares, at any level.
--
-- Ids are this app's 8-byte ids (lib/idCodec.ts genId): 13 Crockford base32 characters, the last from an EVEN
-- index because 64 bits leave its lowest bit as padding, which the canonical decoder rejects when set.

UPDATE policy
SET value_json = json_set(value_json, '$.redacted_fields', json_object('employees', json_array('probation_end_date'))),
    updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE key = 'manifest' AND json_type(value_json, '$.redacted_fields') IS NULL;
--> statement-breakpoint
UPDATE policy
SET value_json = json_set(value_json, '$.redacted_fields.employees', json_array('probation_end_date')),
    updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE key = 'manifest'
  AND json_type(value_json, '$.redacted_fields') = 'object'
  AND json_type(value_json, '$.redacted_fields.employees') IS NULL;
--> statement-breakpoint
UPDATE policy
SET value_json = json_insert(value_json, '$.redacted_fields.employees[#]', 'probation_end_date'),
    updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE key = 'manifest'
  AND json_type(value_json, '$.redacted_fields.employees') = 'array'
  AND NOT EXISTS (SELECT 1 FROM json_each(policy.value_json, '$.redacted_fields.employees') WHERE value = 'probation_end_date');
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
  r.subject, r.subject_kind, r.namespace, r.pattern || '.probation_end_date.**', r.scope_kind, r.scope_code, r.match_code,
  'read', 'allow', r.condition, r.from_ip, r."window", r.source, 'active', NULL, r.expires_at,
  CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
  CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
FROM access_rules r
WHERE r.namespace = 'employees'
  AND r.effect = 'allow'
  AND r.status = 'active'
  AND r.level IN ('read', 'write', 'admin')
  AND r.pattern LIKE 'employees.%'
  AND r.pattern NOT LIKE 'employees.%.%'
  AND r.pattern NOT LIKE '%**%'
  AND NOT (r.pattern = 'employees.*' AND r.level = 'read')
  AND NOT EXISTS (
    SELECT 1 FROM access_rules x
    WHERE x.subject = r.subject
      AND x.subject_kind = r.subject_kind
      AND x.pattern = r.pattern || '.probation_end_date.**'
      AND x.effect = 'allow'
      AND x.level IS NOT NULL
  );

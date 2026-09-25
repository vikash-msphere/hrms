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

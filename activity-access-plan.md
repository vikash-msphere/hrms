# Activity-log access control

Make **who can see the per-entity activity trail** independently controllable — per-role, per-collection, per-scope — via the existing access-rules data mechanism, not code.

## Today

| Feed | Gate |
|---|---|
| Org-wide (`/v1/activity`, no `?resource`) | `audit.read` capability — private-by-default, admins widen via ACL. **Already controllable.** |
| Per-entity (`?resource=<col>/<id>`) | READ on the target record only. Bare `activity` transport cap held by everyone. **No independent knob.** |

## Design — two-gate per-entity trail

Per-entity activity requires **BOTH**:

1. **READ** on the target record (unchanged) — security invariant: never leak activity for a record you can't read.
2. **`activity` capability** covering the record — the NEW independent knob.

Gate 2 can only *narrow* what gate 1 allows.

### Encoding

Activity gate resource: **`activity.<recordCode>.<collection>`** — scope-code at token[1], target-collection as a sub-resource token[2]. This matches the engine's `<namespace>.<scope>.<subresource>` convention, so `deriveNarrowing` / scope tokens (`me`/`my-dept`/`*`/`**`) work with zero narrowing hacks.

Grant patterns admins can set per role/user:
- `activity.**` — see activity for any readable record (**default**, = today's behavior).
- `activity.my-dept.**` — only records in your dept (per-scope).
- `activity.*.leave-requests` — only leave activity (per-collection, any scope).
- `activity.me.**` — only your own records.
- remove all → no per-entity activity.
- Multiple rules union; a `deny` blocks.

### Default — PRIVATE

`activity` is **not** granted to any role (removed from `COMMON_READ`). Out of the box **no one** sees the per-entity trail except super (via `**`, break-glass). Admins grant it explicitly per role/user/collection/scope through the ACL — same private-by-default posture as the org-wide `audit` cap. Reseed drops the 4 seeded activity rows.

## Work

**Backend**
1. `grants.ts` — `COMMON_READ`: `activity` → `activity.**`.
2. `authz.ts` per-entity branch — after read passes, AND a `decide(grant, activity.<tCode>.<tEntity>, read)` gate.
3. Regenerate `scripts/seed.sql` + `bootstrap/bootstrap.sql` (also folds in the sensitive-collections manifest edit).

**Web**
4. ACL editor (Roles page) — expose `activity` as a configurable resource with a target-collection picker + scope chips, so admins drive it in the UI.
5. Gate the affordances (History icon / Activity tab / RowActivityButton) on the caller's `activity.<collection>` capability so they hide when revoked.

**Tests**
6. New authz tests: per-role / per-collection / per-scope activity visibility + read-invariant.
7. Update seed-drift, grants-drift, collections-drift, existing activity/permission tests.

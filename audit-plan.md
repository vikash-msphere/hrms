# App-wide activity logging (surface the audit trail, done right)

## Context

Every write in the app already appends to `audit_log` via `audit()` (`src/lib/audit.ts`)
— actor email, action code (`card.move`, `leave.approved`…), entity, entityId, meta,
timestamp; indexed on `(entity, entityId)`; called from ~73 services. But the trail is
**write-only and invisible**: `audit_log` has no route, no collection, no UI. `event_log`
(domain events) is admin-only; the Dashboard "team timeline" is a separate curated widget.
There is **no per-entity activity feed** and the record is thin (actor is an email string,
no field diffs).

Greenfield opportunity: the logging backbone is already comprehensive — the job is to
**surface it correctly**: a queryable, access-gated activity API + a reusable Activity feed
for any resource, plus a modest enrichment of the record. Keep `audit()` the single
choke-point (no second logging path).

## Design

### 1. Enrich the audit record (backbone) — strictly append-only
- `audit_log` add `actorId` (user ref) alongside `actorEmail`. Keep
  entity/entityId/action/meta/at + the existing index.
- Change `audit(deps, actor: AppUser, action, entity, entityId?, meta?)` — take the AppUser
  (derive email + id) instead of `actor.email`. Mechanical update across the ~73 call sites.
- **Append-only, enforced:** `audit_log` is INSERT-only — no update, no delete, no purge, no
  soft-delete column, and it is deliberately NOT added to `authzResolve.TABLES` /
  `RESOURCE_COLLECTIONS` (so no CRUD/delete route can ever target it). The only reads are the
  activity API below; the only writes are `audit()` inserts. (Same posture as `event_log`.)

### 2. Queryable, access-gated activity API
- New `activity` virtual capability collection (like `timeline`/`export`; in
  `domain/collections.ts`; no table of its own).
- `GET /v1/activity?resource=<entity>/<id>` → that entity's audit rows, newest-first,
  paginated. Authorized by **read on the target entity**, NOT a blanket grant: resolve
  `<entity>/<id>` → code (reuse `uuidToCode` in `src/lib/authzResolve.ts`) and run the
  same read `decide()` the middleware uses (`src/domain/permissions` + the caller's grant).
  Deny → 404/403. A collection-level feed (`?entity=<entity>` with no id) is gated by
  collection read (admin/HR) for a module-wide activity view.
- Serialize each row: `actor` (employees/users ref + resolved name), `action`, `time`, `meta`.

### 3. Human-readable action vocabulary
- Pure `src/domain/activity.ts`: map action codes → `{ label, icon, tone }`
  ("moved this task", "approved the leave", "left a comment"…), grouped by module; fallback
  to a humanized raw code. Web mirror `web/src/lib/activity.ts` (bundle can't import `src/`).

### 4. Reusable UI — lazy, opened on demand (NOT shown by default)
- `web/src/components/common/ActivityFeed.tsx`: props `{ resource: "cards/<id>" }`; renders
  avatar + actor + action label + relative time (+ meta when useful).
- **Never auto-loaded.** Activity lives behind an explicit **tab/button** ("Activity") and the
  fetch fires only when the user opens it (mount-on-open). It is NOT embedded in the entity's
  GET response and NOT fetched when the detail view opens — so a card/employee view costs zero
  extra reads until someone asks for history.
- Wire into the **task detail dialog** (an "Activity" tab/toggle beside Comments,
  `web/src/pages/Boards.tsx`) and the **employee profile** (`web/src/pages/EmployeeProfile.tsx`),
  each as an opt-in tab/button; roll out to others in P3.

### 5. Read minimization (Cloudflare D1 free plan)
- Activity is a single query per open (one indexed `WHERE entity=? AND entity_id=?` on
  `audit_log`), a small default `limit` (~25) + keyset pagination — no eager loads.
- The activity serializer stays lean (actorId/email/action/time/meta); the client resolves
  actor **name/avatar from its already-cached `employees` collection** (no per-row lookups,
  no N+1). No polling; the feed loads once per open and only refetches on user action.

## Phasing
- **P1 (this build):** `actorId` enrichment + `audit()` signature change; append-only
  `activity` read API + entity-read authz; `domain/activity.ts` labels; lazy `ActivityFeed`
  behind an "Activity" tab/button on card detail + employee profile (fetch on open only).
  Squash migration.
- **P2:** structured field diffs (before→after) in `audit()` meta for high-value mutations
  (employee/comp/card updates) + richer rendering.
- **P3:** roll `ActivityFeed` across remaining detail views; optional org-wide activity admin page.

## Critical files
- `src/db/schema.ts` (`audit_log.actorId`), `src/lib/audit.ts` (signature) + ~73 call sites
  (mechanical `actor.email`→`actor`).
- New: `src/services/activity.ts`, `src/routes/activity.ts` (+ mount in `src/index.ts`),
  `src/domain/activity.ts`; `src/domain/collections.ts` (`activity`); `src/http/serialize.ts`
  (`toActivityResource`); `openapi.yaml` (`/v1/activity`); reuse `authzResolve.uuidToCode` +
  `domain/permissions.decide`.
- Web: `web/src/components/common/ActivityFeed.tsx`, `web/src/lib/activity.ts`,
  `web/src/types.ts` (Activity type), wire into `Boards.tsx` + `EmployeeProfile.tsx`.
- Squash to one migration per [[one-migration-squash]] + regen seed/bootstrap.

## Verification
- `tsc` (backend + web), web build, `api:lint`, drift gates + full `vitest` suite.
- New test: create + update + move a card → `GET /v1/activity?resource=cards/<id>` returns
  those actions newest-first with the actor resolved; a caller lacking read on the entity is
  denied; a collection-level feed lists rows for admins; label mapping resolves known + unknown
  codes. Verify the audit signature change didn't drop any call site (grep + full suite green).
- Confirm append-only: `audit_log` has no update/delete/purge path and is absent from
  authzResolve TABLES; the API is read-only. Confirm lazy load: opening a card/employee makes
  no activity request; only clicking "Activity" fetches (one query, ~25 rows).

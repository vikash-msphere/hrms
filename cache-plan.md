# Server caches held for 30 days, reloaded on change, plus a "Clear caches" button

## Context

Three `access_rules` queries read ~600k D1 rows in one morning with 20 people (free plan: 5M rows/day). Measured
on a copy of the local DB (1312 rules; the `employee` role holds 195):

- **Per-object rules**: read ~205 rows to return 0 (the index only narrowed by `subject`).
- **Role grant**: 205-386 rows per role, cached only 5s per Worker instance. The SPA does not poll, so page loads
  more than 5s apart almost always miss that cache. Every navigation re-read the rules.
- **Rule list** (admin screens): no index on its sort order. Every 100-row page scanned the whole table, so
  "load all rules" read ~18k rows. The access-mode tint re-runs it on every access-dialog close.

Already done, uncommitted, suite green: migration `0003_access_rules_read_indexes.sql` (the two indexes), and a
prototype in `src/lib/policyLoad.ts` (`stampedRows`) that caches rule rows for 10 min against the `access-rules`
stamp in `collection_versions`.

The user wants those caches held for 30 days, cleared automatically when data changes, and a manual clear
button on Settings > Operations.

## Facts that shape the design

1. **The cache lives in each Worker instance's memory.** Code in one instance cannot clear another's, so an
   endpoint (or code calling it) only ever reaches one instance. Every instance learns about a change only by
   reading something shared. A 1-row read every 5s is that step, and it bounds revocation lag at ~5s, as today.
2. **Production uses D1 Sessions (read replicas).** The version a cache entry is filed under must be read in
   the same session and before the data. Otherwise a lagging replica can file old rows under a new version, and
   with a 30-day hold they would never reload.
3. **The prototype's marker is the wrong one to hold for 30 days**:
   - Ticket `:assign`/`:route` write `access_rules` (ticket-share rows), so every assignment would reload every
     role's grant in every instance.
   - The stamp is wall-clock ms, and the prototype's same-millisecond guard keeps entries on 5s for a minute
     after any write. In a busy helpdesk that cancels out the long cache.
   - A clock step backwards could hide a change.
   - It is the client-change feed: bumping it for a manual flush changes every list ETag (`http/listEtag.ts`
     uses `max(at)`), so every browser refetches.
4. **Other caches on the same path** use the same 5s pattern: roles held (`userRoles:`), the policy manifest,
   reporting lines (`reports:`), the provisioned role (`services/roles.ts`), and the automation rule set
   (`services/automationEngine.ts`, which scans ~118 rows on every write request). The uuid-to-code cache
   (`lib/authzResolve.ts`) holds for 10 min, so another instance serves a re-parented employee's old code for
   up to that long.

## Design: cache generation counters

A new one-row table `cache_generations`. It holds one integer counter per kind of cached data, bumped by DB
triggers **inside the same transaction as the write**. So every writer is covered (services, cron, code cascade,
migrations, hand-run SQL), and no code path has to remember to clear anything. That is the "clear on change"
the user asked for, done where it cannot be skipped. The endpoint is only a manual override.

| counter | bumped by | cache bands that depend on it |
|---|---|---|
| `role_rules` | `access_rules` rows with `subject_kind='role' AND match_code IS NULL` (old or new row) | `grant:<role>` (rows, guards) |
| `acl_rules` | every other `access_rules` row (user rules, per-object and ticket-share rows) | `userGrant:<uuid>`, `objRules:<uuid>:<roles>` |
| `user_roles` | any `user_roles` write | `userRoles:<uuid>` |
| `policy` | any `policy` write | `manifest` |
| `roles` | any `roles` write | `role:provisioned` |
| `org` | `employees` insert/delete, or an update that changes `manager_id`, `code`, `delete_time` | `reports:*` |
| `codes` | `employees` / `departments` update that changes `code` (every re-parent does) | uuid-to-code cache |
| `automations` | any `automations` write | enabled automation rules |

The split of `access_rules` into two counters is what keeps ticket assignment from reloading role grants.
Triggers use 0/1 arithmetic, not `CASE` (wrangler's splitter breaks on `CASE`), e.g.
`"role_rules" = "role_rules" + (NEW."subject_kind" = 'role' AND NEW."match_code" IS NULL)`.

How a cached band works (`generational(deps, key, [counters], load)`):

- **Load**: read the counter row first, then the data, in the same request session. D1 Sessions guarantees the
  data is at least as new as the counters it is filed under. Store `{ at, loadedAt, value }` for 30 days.
- **Check**: every read compares the entry's counters with the current row. The row is fetched at most every 5s
  per instance, and one row serves every band. The entry reloads only when one of **its** counters moved.
  Counters only go up, so a replica that returns an older row just keeps the entry, and no clock is involved.
- **One reload per call**: after a reload the fresh value is returned without re-checking, so a lagging replica
  cannot loop it.
- **Fail-safe**: if the counter row cannot be read (migration not applied, row missing), every band falls back
  to the old 5s expiry and logs once. It never holds stale data.

The manual clear adds 1 to every counter (every instance reloads everything within ~5s) and empties the local
instance at once. It touches no `collection_versions` row, so browsers are not made to refetch.

Rejected: KV (1k writes/day on free, eventually consistent), the Cache API (per data centre, no invalidation
guarantee), a Durable Object (a request per check is no cheaper than one D1 row), a longer check interval (longer
revocation lag), and reusing `collection_versions` (fact 3).

## Changes

1. **Migration `0004_cache_generations`**. A new migration, not an edit to `0003`: a local database may already
   have recorded `0003`.
   - Add the table to `src/db/schema.ts` and run `drizzle-kit generate --name=cache_generations`.
   - Append `INSERT INTO cache_generations (id) VALUES (1)` and the triggers named `gen_<table>_<i|u|d>`, one per
     `--> statement-breakpoint` chunk (the test harness runs one statement per chunk). That is 3 on
     `access_rules`, 3 on `user_roles`, 3 on `policy`, 3 on `roles`, 3 on `automations`, 3 on `employees` (the
     update one is `AFTER UPDATE OF manager_id, code, delete_time ... WHEN` something actually changed), and
     1 on `departments` (`UPDATE OF code`).
   - Declare the table in `UNSTAMPED_TABLES` (`src/db/changeDdl.ts`): "server cache counters, never read over
     the wire".
2. **`src/lib/cache.ts`**: `cached(key, ttl, load, stale?)`. On a hit whose resolved value is `stale`, drop the
   entry (only if it is still the same entry) and load once more, without re-checking. Concurrent callers join
   that single reload.
3. **New `src/lib/cacheGenerations.ts`**: `readGenerations`, `currentGenerations` (5s), `generational()`,
   `bumpAllGenerations()`, the fail-safe, and `HOLD_MS = 30 days` / `CHECK_MS = 5s`.
4. **`src/lib/policyLoad.ts`**: replace `stampedRows` with `generational`. Bands: roleRules for `grant:`;
   aclRules for `userGrant:` and `objRules:`; user_roles for `userRoles:`; org for `reports:`; policy for
   `manifest`. Keep the `match_code >= ''` index trick and the `isLive` cut after the cache. Remove the stamp
   code and the unused `TTL_MS`. Rewrite the header notes to describe what the code does now.
5. **Sibling caches**:
   - `services/roles.ts`: provisioned role on `roles`.
   - `services/automationEngine.ts`: `loadEnabled` on `automations`, and `invalidateAutomationCache()` becomes
     `clearCache` of that key.
   - `lib/authzResolve.ts`: the code cache clears itself when `codes` moves. The 10-min TTL stays as a backstop,
     because entries are not filed per snapshot.

   The existing local busts (services/accessRules.ts, users.ts, ticketShares.ts, codeCascade.ts, policy.ts)
   stay: they make the writer's own instance immediate.
6. **Endpoint `POST /v1/operations:clearCache`**:
   - New `src/services/cacheFlush.ts` (bump all, then `clearCache()`, `invalidateCodeCache()`, and the automation
     key) and `src/routes/cacheFlush.ts`, shaped like `routes/cronTrigger.ts`.
   - Mount it in `src/index.ts` before the `/v1/operations` mount. It answers `{ clear_time }` (AEP-142 `_time` suffix).
   - Access: key `operations.clearCache`. No role grants it, so only super_admin reaches it (like
     `cron-runs:run`). No grant lines are added; an admin can delegate it through the button's ACL icon.
   - Verb registries:
     - `src/http/accessHint.ts` (list + glossary line) and `web/src/components/access/customMethods.ts`.
     - `verbMeta.ts`, if its drift test asks for the verb.
     - `openapi.yaml` entry modelled on `/v1/cron-runs:run` (response schema without `required`), then
       `npm run api:types`.
     - `"operations:clearCache"` in the withheld list in `test/grants.test.ts`.
   - Audited automatically as `operations.clearCache`.
7. **`web/src/pages/Operations.tsx`**:
   - A "Server caches" section with one card, and a "Clear caches" button inside
     `<AccessAction collection="operations" verb="clearCache">` (hidden without the right).
   - The button calls `api()` like `runNow`, with a busy state and a toast: "Caches cleared. Every server
     reloads within about 5 seconds."
   - Card copy: servers reload on their own within seconds of any change; clearing is for changes made
     outside the app, such as hand-edited data.
8. **`web/src/components/access/AccessModeProvider.tsx`**: re-fetch the rule list when access mode turns on, and
   on dialog close only when an `access-rules` write happened in the meantime (`subscribeInvalidations`; also
   fires for sibling tabs). A superseded or failed load leaves the flag set.
9. **Docs**: `docs/authz.md` (lines ~44, 383, 400, 416-425: the cost table and the propagation note). Add a short
   entry to `docs/architecture-decisions.md` explaining why counters and not stamps.

## Tests

- **New `test/cacheGenerations.test.ts`** (real D1, migrations applied):
  - Each trigger bumps exactly its counter: role broad rule → `role_rules` only; user rule and exact rule →
    `acl_rules` only; an update that moves a rule between classes → both; `user_roles`, `policy`, `roles`,
    `automations` each bump their own.
  - Employees: insert/delete/manager change → `org`; code change → `org` + `codes`; a name edit → nothing.
    A department code change → `codes`.
  - `generational`:
    - it keeps serving across a counter refresh when nothing moved;
    - it reloads when its counter moves and ignores an unrelated one;
    - with the row missing it falls back to 5s expiry.
- **`test/cache.test.ts`**: the `stale` path reloads once, concurrent callers share it, and there is no second
  check after a reload.
- **`test/accessLifecycle.test.ts`**: rework the stamp test to the counter key.
- **New `test/cacheFlush.test.ts`** (harness of `test/exportAudit.test.ts`):
  - super_admin gets 200, and every counter goes up by 1;
  - a warm grant reloads immediately after the flush;
  - an employee caller gets 403;
  - an audit row is written.
- **`test/auditAccess.test.ts`**: the `mutationAudit` mapping for the new path.
- **Drift guard**: every `cached(` call in `src` is either a `generational` band or on a short allow-list with a
  reason (strip comments before scanning). A future cache then cannot escape the flush.
- **`e2e/operations.spec.ts`**: super clicks "Clear caches" and sees the toast, and the two "Run now" buttons
  still count 2. Run only this spec, via `npm run test:e2e -- e2e/operations.spec.ts`.

## Verification

- `./node_modules/.bin/tsc --noEmit` for root, `web/tsconfig.json` and `e2e/tsconfig.json` (check `$?`), and
  `eslint` on the touched files.
- `npm run db:generate` must print "No schema changes" and pass both DDL checks.
- On a sqlite copy of the local DB: apply `0004` and fire each trigger by hand to confirm the counters.
- Ask for permission again to run the full vitest suite unsandboxed (the earlier yes was for the earlier run).
- **Measure**: have the user run
  `! npx wrangler d1 insights hrms --sort-by reads --limit 20 --time-period 1d` once before deploy (baseline)
  and again a day after. The three queries should drop out of the top reads.

## Rollout

- CI's deploy runs `db:migrate:remote` before `wrangler deploy`, so `0003` and `0004` land before the code that
  reads them. If the order ever slips, the fail-safe keeps things correct at the old cost.
- After the deploy: run `scripts/freezeMigrations.ts` and commit `_frozen.json` (docs/deploy.md step 7a).
- Before writing under `src`, `web/src`, `e2e`: check the other session (hrms-72) isn't mid e2e run.

## Expected effect

- Freshness: at most 1 row per instance per 5s of traffic.
- Cold instance: each role's rules once.
- A role-rule edit: that role reloads once per instance.
- A ticket assignment: a few rows per active caller.
- Admin screens: ~1.4k rows per access dialog open (was ~18k), and nothing extra while browsing in access mode.

## Later, only if the insights data says so

- Filters on the rule list (`subject`/`subject_kind`, `collection`, `effect=deny`), so each panel reads only
  what it shows. The subject filter can use the new index.
- Take the access dialog's user, employee and role lists from the resource store instead of `listAll` on every
  open.
- Whatever the insights data ranks next.

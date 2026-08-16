# One collection system

## Context

Every collection used to hand-roll the AEP standard methods: list with cursor paging, get, create, patch with
`If-Match`, delete with `?force`, plus the shared lifecycle verbs and `:restore`. The same ~60 lines were copied
into each route file. The duplication is not a tidiness problem, it is a defect generator - converting the
collections surfaced defect after defect of one class, present only because the code was copied rather than
shared:

- `?id=` (the AEP user-specified id) spread as a non-existent `id` column in at least six collections and was
  silently dropped.
- `POST /v1/pay-grades/{id}:lock` returned 500: shared lifecycle verbs mounted over a table with no `locked`
  column.
- `assertNotLocked` present in some updates, absent in others, for no reason.
- A PATCH of a soft-deleted row 404'd in two collections and succeeded in the rest.
- `pay-grades` had no tests at all; `expense-categories` had none of its own.
- Auto-mounting DELETE on `positions` / `compensation` would have handed HR a way to delete role and salary
  history (caught during conversion, before it shipped).

The end state is exactly one way to define a collection. `src/http/collectionRoute.ts` + `src/services/crud.ts`
generate the standard lane from a spec; per-collection domain logic stays in the collection's service.
`test/collectionLaneDrift.test.ts` enforces it, so the rule survives without anyone remembering it.

Authorization is untouched throughout: `src/middleware/authz.ts` remains the single source of access control and
the factory decides no permission.

## Current state

**Every collection is on the lane: 78 of 106 route files, and nothing is pending.** The six route files that
expose a standard-method surface without going through the factory each carry a recorded reason and a test that
fails if the reason stops being true - five key/value config surfaces (`NOT_COLLECTIONS`) and `roles`, whose
identity is its name (`KEYED_BY_NAME`). Green at the time of the conversion at 1241 tests across 108 files;
the suite has since grown to 1252 across 110. Every commit typechecks and passes the
full suite with pre-existing tests unmodified, and each is independently shippable.

The other 28 non-factory route files are not collections at all - sub-resource routes and action surfaces.

The lane is now hardened as well as shared: it pages in SQL, binds the caller's scope, hands the resolved paging
to a route-level list, applies derived data on every path it owns, lets a collection's own verb beat the shared
one, is typed against its table, and computes the access hint before serializing.

### The spec, as it stands

Required: `table`, `collection`, `auditName`, `notFound`, `param`, `serialize`.

Optional: `insert`, `patch` (omit either to mount no POST / no PATCH), `writeSchema` or `createSchema` +
`updateSchema`, `sort`, `decorate`, `afterCreate`, `afterUpdate`, `allocCode`, `lifecycleName`, `publish`,
`publishTime`, `softDelete: false`, `overrides`, `list`, `verbs`.

That is the same 15 knobs the conversion started with. Nothing was added: every collection went on the lane with
them. The five that once looked like they needed a 16th did not - four were unblocked by hardening the lane
(`list(c, page)`, the collection-verb precedence, the hint computed before serializing) or by a schema/property
correction, and the fifth (`roles`) is an identity decision, not a missing knob.

Behaviours worth knowing before converting anything:

- The delete lane is described, never assumed. No `delete_time` column means no DELETE and no `:restore`.
  `softDelete: false` opts a history collection out even when the column exists. `overrides.remove` gives a
  permanent delete with no restore and no `?force`.
- POST/PATCH mount when EITHER the generic mapper or an override supplies the method.
- `decorate` is applied by the FACTORY, on the one path every answer passes through: the list (route-level or
  generic), get, create, patch, restore and every non-raw verb. Nothing can bypass it - an `overrides` entry
  replaces a service method, not the decoration - so a POST answers with the shape a GET would and a route-level
  `list` carries the same derived field the item read does, computed by the same code.
- `decorate` receives the whole PAGE, so it costs one query per response. Derived data that must NOT ride a page
  therefore cannot be a `decorate`: it goes in the collection's own item path instead. Two do this, each for a
  stated reason - an employee's profile-completeness flags decrypt three blobs per row (`overrides.get`), and a
  payroll run's staleness costs a query per input table (`withStaleness`, called by `get` and the three verbs
  that answer with a run).
- `serialize(row, user, can)` is for viewer-dependent resources (an employee's signature marker, a review's
  withheld manager assessment) and, through `can`, for a resource whose shape depends on what the caller may DO.
  The access hint is computed BEFORE serializing, on both the item path and the list, so `can` is the same verb
  list the response ships as `access.can`.
- The access hint is derived from what the route actually mounted, not from `ACCESS_VERBS`. A factory-built
  collection never consults that table.
- A collection's OWN verb is answered first; `:restore` and the shared lifecycle lane are the fallback. So a
  collection that means something specific by `:enable` says so in `verbs` instead of being answered by the
  generic column write, and `collectionLaneDrift.test.ts` names every such overlap so one is visible.
- A caller-supplied `?id=` that is already taken is a 409 ALREADY_EXISTS, not a 500.
- The spec is typed against its own table. `CrudSpec<Input, typeof schema.x>` makes `insert` / `patch` return
  `SetOf<T>` - this table's insert columns, all optional - so a mistyped column is a compile error rather than a
  value that never lands. Write the `set` object with that type too (`const set: SetOf<typeof schema.x> = {}`):
  a block-bodied `return {...}` gets no excess-property check from TypeScript, so the typed `set` is what
  actually catches a typo, and it covers the hand-written `update<X>` functions wired as `overrides.update`.
  `collectionLaneDrift.test.ts` fails a `collectionRoutes<Input>(...)` that omits the table type.
- The lock guard lives in `src/services/lockGuard.ts` (a leaf). Importing it from `services/lifecycle.ts` inside
  `crud.ts` created a cycle through notifications and left `crudService` undefined at module-init.
- The generic list pages in SQL through `services/keysetPage.ts`: one page per request, ordered and seeked on
  (createdAt, uuid), with `isNull(delete_time)` unless `?show_deleted` and no soft-delete predicate at all for a
  table without the column. The page token carries the row's WIRE token, never its internal uuid.
- `sort` therefore orders WITHIN a page, not across the table. A catalog expected to exceed the 100-row
  truncation cap should be ordered client-side rather than re-reading the whole table to sort it.
- The generic list binds the caller's scope through `applyScope`, exactly as a hand-written scoped list does,
  and decides nothing itself. A generic-list table is a flat catalog (a `code`, no owner column), so a caller
  narrowed to `dept` or `own` gets NO rows - fail closed. `collectionLaneDrift.test.ts` asserts every seeded
  role reads all 15 of them org-wide, so narrowing one in `domain/grants.ts` fails there rather than emptying a
  dropdown in the SPA.
- A shared lifecycle verb answers through `item()` too: `http/lifecycleVerb.ts` performs the transition and hands
  the row back, so `:disable` / `:lock` / `:publish` carry the access hint and the collection's derived fields like
  any other item response. A collection's own verb of the same name still wins (see above).
- A route-level `list(c, page)` is HANDED the resolved paging (`maxPageSize` clamped to the 100-row cap,
  `pageToken`, `showDeleted`); it does not re-read the query string for them. It still reads its own filters
  (`?employee`, `?state`, `?q`) off the context. Five lists are unpaged by nature (positions, compensation,
  assets, bonuses, settlements) and simply ignore the argument.
- A collection with a `STATE_VISIBILITY` rule binds `scope.seeRestricted` in its own list. `announcements` is
  the only one, and `visibleWhere` in its service is the single predicate its list and `:markAllRead` share.
- `announcements` is on the lane, so a board card's hint is derived from the methods it mounts. Its three
  COLLECTION-level custom methods (`:post`, `:giveKudos`, `:markAllRead`) are separate routes gated by their own
  verbs, so they still probe `ACCESS_VERBS.announcements`; they answer one row through the same
  decorate/hint/serialize steps the factory uses.
- `scope.seeRestricted` (state visibility) is still bound by hand in the services that have it. Only
  `announcements` carries a `STATE_VISIBILITY` rule and it is hand-rolled, so the generic list has nothing to
  honor yet; when a factory collection gets a state rule, the generic list must bind it.

## Decided policy

**1. Key/value config surfaces are not collections, and a test checks that.** `policy`, `preferences`,
`settings`, `payrollDebit` and `bankFormats` borrow the route shape but the item id is a key the caller names,
so PATCH upserts and there is nothing to create or delete. They sit in a named `NOT_COLLECTIONS` category in the
drift test, each with a one-line reason, and the test asserts **no collection-level `POST /` and no DELETE** - if
one grows either, it has become a collection and the test pulls it into the lane.

**2. The spec surface is frozen.** No new optional fields. A collection that appears to need a 16th knob goes
into `PENDING` with its reason instead, to be reviewed on its own merits. Custom methods, the biggest source of
variation, are already covered by `verbs`, so this rarely binds. It bound five times out of eighty, and every one
of those five turned out to want something other than a knob: three wanted a signature change in the lane, one
wanted a property rename, and one wants an identity decision.

**3. Convert biggest-first, in batches of 3-6.** Verb-heavy files pay the most: they are the files people edit.

**4. A collection keyed by a natural key stays off the lane, and a test checks that too.** `roles` has no `uuid`
column: the role NAME is the identity, and it is what `users.role` and `access_rules.subject` store. Every
generic method in `crud.ts` keys on `table.uuid`, so the lane cannot serve it, and giving it a uuid would add a
second identity nothing references - making that uuid the REAL identity means re-keying the authz tables, which
is a far bigger change than the list shape it would buy. It sits in a named `KEYED_BY_NAME` category in the drift
test, and the test pins the claim: the table has **no `uuid` column**, its declared key **is** a primary key, and
the columns that carry that key by value still exist. If `roles` ever gains a `uuid`, the claim is stale, the
test fails, and it moves onto the lane. This is a second exemption rather than a `NOT_COLLECTIONS` entry because
`roles` genuinely creates and deletes - it is a collection, just not a uuid-keyed one.

## Nothing pending

Every collection is on the lane. `PENDING` in the drift test is empty, so a hand-rolled standard-method surface
appearing in `src/routes` fails the suite rather than joining a budget. The two permanent exemptions
(`NOT_COLLECTIONS`, `KEYED_BY_NAME`) each carry a reason and a pinned property that fails if the reason stops
being true.

The 28 remaining non-factory route files are sub-resource routes and action surfaces, not collections.

## Per-collection recipe

1. `git show HEAD:src/routes/<name>.ts` and `git show HEAD:src/services/<name>.ts` - **not** the Read tool, which
   went stale mid-session three times and led to services written from memory.
2. Check the table for `delete_time` / `locked` / `disabled`, and check whether the current route exposes DELETE.
   Column present + route absent means `softDelete: false`. A hard `db.delete` in the service means
   `overrides.remove` plus `softDelete: false`. Read the table definition itself - a `sed` range over schema.ts
   runs past the end of a table that closes with `}, (t) => ({...}));` and reports the next table's columns.
3. Move the field mapping into `insert` / `patch` verbatim, including validation and exact error strings. Do not
   invent a tighter zod schema than the original had: a verb whose body was taken as sent stays that way.
4. Keep audit stems byte-identical where you can (`auditName`, plus `lifecycleName` when the lifecycle verbs used
   a different singular). Where a service used one stem for create/update and another for delete/restore/purge,
   they unify on the create/update stem - check nothing reads the old one first. `test/apiKeys.test.ts` asserts
   on `holiday.%`; the activity feed renders these.
5. A scoped list becomes a route-level `list(c, page)` - it is handed the resolved paging and reads only its own
   filters. An owned code becomes `allocCode(deps, table, values)`. Side effects become `afterCreate` /
   `afterUpdate`. Derived data becomes `decorate`, written to take the whole PAGE: the factory applies it to the
   list, the item read and every write response, so the list hook must NOT attach it a second time. Derived data
   that must not ride a page cannot be a `decorate` - put it in the collection's own item path and say why.
6. **A bespoke purge means the row has children.** Before deleting a `purge<X>` helper, read it: a board's cards,
   a cycle's reviews, a transition's tasks and a suggestion's votes are all torn down by hand before the row.
   Wire it as `overrides.purge` or the parent goes and the children are orphaned.
7. Do NOT re-export what the lane now serves. If the generic method is byte-equivalent, delete the wrapper; if
   the function is still called inside its own service, drop the `export` instead of the function.
8. `npm run typecheck && npm run test`. Pre-existing tests must pass **unchanged** - that is the equivalence
   proof. Commit the batch.

### Audits to run per batch (each has caught a real defect)

**Did anything gain a destructive route it did not have?** For every converted file, compare the pre-factory
baseline against what the factory now mounts:

```sh
for f in $(grep -ln collectionRoutes src/routes/*.ts); do
  git show b12d009:$f | grep -c '\.delete(' ;  # 0 here + no `softDelete: false` in the new file = ADDED delete
done
```

**Did the list lose a filter?** The query parameters a route reads are its whole filter surface, and dropping one
is silent - the list just returns everything:

```sh
git show b12d009:src/routes/<name>.ts | grep -oE 'query\("[a-z_]+"\)' | sort -u   # minus force/id, which the factory owns
grep -oE 'query\("[a-z_]+"\)' src/routes/<name>.ts | sort -u
```

**Are there dead exports?** For every converted service, each name must be used outside its own file:

```sh
grep -rn "\b<exportedName>\b" src test web/src | grep -v "^src/services/<file>.ts:"
```

## Verification

- Per batch: `npm run typecheck`, `npm run test` (108 files / 1241 tests today), pre-existing tests unmodified.
- `test/collectionFactory.test.ts` (31 tests) pins the shared surface: paging cursor, keyset paging across a page
  boundary under a custom `sort`, no internal id in the page token, the bound list scope (and no rows for an
  unscoped request), the resolved paging handed to a route-level list, `decorate` on list + get + write, a
  collection verb beating the shared lifecycle verb, a serializer reading `can`, a lifecycle verb answering with
  the hint and the derived field, If-Match, the lock guard,
  delete/`?show_deleted`/restore/`?force`, unknown-verb 404, unsupported lifecycle verb 404, audit stems,
  create/update schema split, verb entries (schema / no schema / raw), append-only tables, read-only specs,
  `?id=` conflict, and that the hint lists only mounted actions.
- `test/collectionLaneDrift.test.ts` gates the lane itself: the (now empty) PENDING budget, both exemptions and
  their pinned properties, that every factory spec names its table type, which collection verbs shadow a shared
  lifecycle verb, that every generic-list catalog stays readable org-wide, and that every bespoke purge has a
  caller.
- Existing contract gates stay: `openapiRoutesDrift`, `customMethodsDrift`, `serializerContractDrift`,
  `accessHint`, `parity` (route × role), `bola` (item-level isolation), plus `npm run api:lint` (spectral) in the
  pre-commit `verify` hook.

## What the conversion found, and what it cost

Defects the copied code was hiding, now fixed:

- `?id=` written to a non-existent column (departments among them), so a caller-supplied id was dropped without
  a word. The generic create writes `uuid` and answers 409 when the id is taken.
- Access hints that advertised actions the route did not have: read-only collections offering update+delete,
  `leave-requests` offering a phantom update+delete pair, `settlements` the same. And the reverse - the tickets
  list's bulk Resolve/Close read verb names out of `access.can` that the hint never supplied, so they could
  never enable. The hint is now derived from the mounted surface, in one place.
- `ticket-checklists` had a soft delete with no `:restore` route: deleted rows were recoverable in the database
  but not through the API.
- `operations` answered 400 for an unknown verb where every other collection answers 404.
- `access-rules` was recorded as blocked on identity because it "has neither the `uuid` every generic method keys
  on nor the `code` the access hint decides against". Half of that was wrong: `pk()` names its column `uuid`, so
  the column had always been there and only the drizzle PROPERTY was called `id`. Renaming the property put the
  collection on the lane with no schema change, no migration and no overrides beyond its own create and delete.
  It has no `code`, which is honest - a rule is not a hierarchy node - so its rows carry no per-row access hint.
- `access-rules` also serialized INSIDE its list and get, which is why it looked like it needed both. The
  object-id resolution is a `decorate` and the shape is a `serialize`, the same split as every other collection.
- `roles` is the one collection that stays hand-rolled, by decision rather than by debt (see Decided policy 4).
  Its name is a text primary key that `users.role` and `access_rules.subject` store by value; a uuid would be a
  second identity nothing references, and promoting it to the real one means re-keying the authz tables. The
  drift test's `KEYED_BY_NAME` entry pins exactly that claim, so the exemption cannot outlive its reason.
- **`GET /v1/users` leaked every account.** Its list bound no scope at all, and everyone holds `users.me.**` -
  which resolves to breadth `own`, i.e. they may reach the list - so any employee could read a page carrying
  every colleague's email and role. The list is now scoped on the account's employee link, so an admin
  (`users.**`) sees all accounts and everyone else sees their own. Found by the drift guard added in A2: `users`
  joined the generic-list set, and the guard failed because four seeded roles read it as `own`.
- The users PATCH schema hardcoded five role names while `updateUser` validated the role against the roles
  TABLE, so a role added through the roles catalog could never be assigned. The schema now takes any string and
  lets the table decide - which is what "roles are data" means. `openapi.yaml` already typed it as a plain string.
- `automations` carried TWO columns meaning "this rule does not fire": its own `enabled` and the shared
  lifecycle `disabled`. The engine had to check both, and a lifecycle `:disable` would have written the one the
  engine ignored. Collapsed onto `disabled` (the shared column every collection uses); the wire field is still
  `enabled`, so no API changed. The collection keeps its OWN `:enable` / `:disable`, which write the same column
  and record the same audit stem but also drop the engine's rule cache - without that, a rule switched off keeps
  firing until the cache expires. That is what A5 exists for.
- Converting `automations` also mounted `:lock` / `:unlock`, which its table's `locked` column had always
  earned and the hand-written route never offered. Added to `openapi.yaml` in the same commit, because the local
  dev proxy 404s an unspecified path.
- `automations` item and write responses carried NO `access` hint at all - the hand-written handlers called
  `toAutomationResource` directly and only the list wrapped it. On the lane they carry it like every other
  collection.
- `announcements` had the board's visibility rule written twice, in JS, over a whole-table read: the list and
  `:markAllRead` each filtered `scope.seeRestricted || (published && !disabled)` in their own loop. It is now one
  SQL predicate (`visibleWhere`) that both bind, and the caller's breadth is bound with it - the list had never
  bound `applyScope` at all. Four service exports went with the conversion (`getAnnouncement`,
  `deleteAnnouncement`, `restoreAnnouncement`, `purgeAnnouncement`) because the generic methods are
  byte-equivalent; `getAnnouncement` stays as an internal fetch its own verbs share.
- Three test files stubbed the middleware's list scope as `{ seeRestricted: true }`, which was enough while the
  board ignored breadth. Binding `applyScope` made those stubs fail closed, which is the fix working: they now
  carry a complete scope. No assertion changed.
- Typing the spec against its table found seven places where a validated wire string was written to an enum
  column without narrowing: the guard was `if (!ALLOWED.includes(v as any)) throw`, which checks at runtime and
  tells the compiler nothing, so the column's type was satisfied by a cast rather than by the check. They now go
  through `oneOf(v, ALLOWED, detail)` (`lib/errors.ts`), where the check and the narrowing are one statement.
  Same 400s, same messages.
- Four `set` objects stay `Record<string, unknown>` because their table is a parameter, not a constant: the
  generic patch in `crud.ts`, the two document-service writers, and the e-sign callback (both run over either
  document table). `announcements` is the fifth and is still hand-rolled.
- A shared lifecycle verb built its own response (`c.json(serialize(row))`), so `:disable` / `:lock` / `:publish`
  answered without `access.can`, without the collection's derived fields, and with a viewer-dependent serializer
  called without a viewer. It bit for real on the board: `publishDraft` folds the response into the cached row, so
  publishing a draft took every control off the card and blanked its reaction thread until a refetch. Fixed - the
  verb hands back the row and `item()` answers it.
- **A regression the conversion introduced and this pass fixed:** `profile_completeness` disappeared from
  `GET /v1/employees/{id}`. The employees spec expressed it as `decorate`, but `overrides.get` replaces the
  service method that applied decorate, and create/update are overridden too - so the flags were computed on
  `:restore` and nowhere else, and the Profile page's record-quality card had nothing to render. No test covered
  the field. `test/employeeCompleteness.test.ts` now pins both halves: on the item read, off a page.
- Derived data was implemented twice in 13 collections, because a route-level `list` bypassed `decorate`. The two
  shapes had already diverged in cost: `tax-declarations`, `candidates`, `expenses`, `referrals` and
  `reimbursements` resolved their attachment flag per row in `decorate` (N queries) and once per page in the list
  hook. There is now one batched implementation each, and `attachedObjectIds` takes the ids it is answering for,
  so the item read costs one row rather than a scan of the collection's whole attachment history.
- The generic list never read `c.get("scope")`, so the 15 collections on it returned every row whatever the
  caller's breadth. Safe only by accident: every grant on those catalogs is unscoped, so `actorScope` answered
  `all` for every reader. A single narrowed grant would have listed the whole table.
- A custom `sort` silently broke paging. `pay-grades`, `projects` and `shifts` presented the table in their own
  order while the cursor compared `createdAt` against that order, so page 2 skipped rows outright - paging
  `pay-grades` by 2 over levels 5, 1, 3 (created in that order) answered [1, 3] and then nothing, losing the row
  created first. Pre-existing, copied three times on dev, and invisible because these catalogs fit one page.
  The DB now orders the page and `sort` presents within it.

Defects the conversion itself introduced, all found and fixed:

- ~120 dead re-exports, a 500 on a colliding `?id=`, and read-only collections advertising update/delete.
- **Two child-aware purges dropped** (transitions' tasks, review-cycles' feedback + reviews). `?force=true` would
  have deleted the parent and orphaned the children, and the full suite stayed green through it - no test
  covers `?force` on those collections. The lane test now fails on a bespoke purge that nothing calls, and the
  recipe says to read a purge before deleting it.
- A dropped `?status` filter on tax-declarations, caught by the query-parameter audit that is now in the recipe.

The lesson repeats: a conversion adds behaviour easily and removes it just as easily, so audit the delta rather
than trusting a green suite.

Known cost:

- `compliance-rules` lost `{generated: N}` meta on its create audit row; the count stays derivable from
  `compliance_events.rule_id`.
- Indirection: a route file no longer shows the mechanics. `collectionRoute.ts` + `crud.ts` (~340 lines) are one
  file to learn.
- Override-heavy collections are LOC-neutral or slightly worse (`holiday-selections` 33 -> 39 lines, `assets`
  51 -> 45). The win is one lane and one test, not line count. The "-70 lines each" arithmetic from the first
  three collections does not generalize.

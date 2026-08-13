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

**75 of 106 route files are on the factory. Four collections remain, and every one of them carries a recorded
reason - none is simply unstarted work.** 1235 tests across 107 files green. Every commit typechecks and passes the full suite with pre-existing tests unmodified,
and each is independently shippable.

The remaining 36 non-factory route files are not collections at all - sub-resource routes, action surfaces and
the five key/value config surfaces the drift test names.

The lane is now hardened as well as shared: it pages in SQL, binds the caller's scope, hands the resolved paging
to a route-level list, applies derived data on every path it owns, lets a collection's own verb beat the shared
one, is typed against its table, and computes the access hint before serializing.

### The spec, as it stands

Required: `table`, `collection`, `auditName`, `notFound`, `param`, `serialize`.

Optional: `insert`, `patch` (omit either to mount no POST / no PATCH), `writeSchema` or `createSchema` +
`updateSchema`, `sort`, `decorate`, `afterCreate`, `afterUpdate`, `allocCode`, `lifecycleName`, `publish`,
`publishTime`, `softDelete: false`, `overrides`, `list`, `verbs`.

That is the same 15 knobs the conversion started with. Nothing was added: every collection converted went on
the lane with them, and the five that could not be expressed are recorded as blocked rather than as a 16th
knob.

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
variation, are already covered by `verbs`, so this rarely binds - it bound five times out of eighty, and all
five are in the table below.

**3. Convert biggest-first, in batches of 3-6.** Verb-heavy files pay the most: they are the files people edit.

## Remaining work

Track A is done: the lane itself is hardened. What remains is **B**, converting the four collections that are
still hand-rolled.

Each step is one commit: `npm run typecheck && npm run test` green, pre-existing tests unmodified, independently
shippable.

### Track B - the hand-rolled collections

**B2. `automations`** (plus a schema change). The table carries both `enabled` (the rule's own
switch, written by `setAutomationEnabled`) and the generic lifecycle `disabled` / `locked`. A5 stops the shared
verb from answering `:enable` first (a collection's own verb now wins), which is enough to convert safely, but
the duplicate state is still wrong:
collapse `enabled` and `disabled` into one column in the same squashed migration, and keep exactly one meaning
of "this rule does not fire".

**B3. `roles` and `accessRules`** (identity). `roles` keys on the role NAME, the FK target every grant and user
row points at; `accessRules` keys on an `id` column and has neither `uuid` nor `code`, and serializes inside
list/get. Both need an identity decision before a conversion, not a conversion that overrides every method:
either give the tables the standard `uuid` + `code` pair and keep the name/id as the display key, or accept
that these two are configuration surfaces and move them to `NOT_COLLECTIONS` with that reason. Decide first,
then act - a five-override conversion buys the list shape and nothing else.

**B4. `users`.** `GET /v1/users/me` answers with a caller-identity envelope (capabilities plus grantable scope
tiers) and synthesizes a row for a simulated principal who has never signed in. That endpoint is not a
collection item and never will be. Split it out as its own route, then convert what is left (list / get /
update over real user rows) on the lane. If the residue turns out to be only `me`, the file moves to
`NOT_COLLECTIONS` instead.

### Not in scope

The 36 remaining non-factory route files are sub-resource routes and action surfaces, not collections. The five
`NOT_COLLECTIONS` key/value surfaces stay where they are, with the drift test holding them to the claim (no
collection-level `POST /`, no DELETE).

### What each step has to prove

The standing gates are under "Verification" below and all of them apply. On top of that: A4 changes behavior
under all 74 converted collections at once, so it runs the three delta audits in "Audits to run per batch" as
well - a lane-wide change is exactly where a green suite is least convincing. Extend
`test/collectionFactory.test.ts` per step: one derived field on both list and get (A4), a collection verb that
shadows a lifecycle verb (A5), and a serializer that reads `can` (A7).

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
5. Scoped list becomes a route-level `list(c)`. An owned code becomes `allocCode(deps, table, values)`. Side
   effects become `afterCreate` / `afterUpdate`. Derived data attached to every answer becomes `decorate` - and
   because a route-level `list` bypasses `decorate`, attach it in the list hook too, in one query for the page.
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

- Per batch: `npm run typecheck`, `npm run test` (105 files / 1219 tests today), pre-existing tests unmodified.
- `test/collectionFactory.test.ts` (22 tests) pins the shared surface: paging cursor, If-Match, lock guard,
  delete/`?show_deleted`/restore/`?force`, unknown-verb 404, unsupported lifecycle verb 404, audit stems,
  create/update schema split, verb entries (schema / no schema / raw), append-only tables, read-only specs,
  `?id=` conflict, and that the hint lists only mounted actions.
- `test/collectionLaneDrift.test.ts` gates the lane itself: the PENDING budget, the NOT_COLLECTIONS exemption and
  its no-create/no-delete property, and that every bespoke purge has a caller.
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
- Still open, recorded here rather than fixed: a shared lifecycle verb's response does not go through the
  factory's item path (`http/lifecycleRoute.ts` serializes and answers itself), so `:disable` / `:lock` /
  `:publish` answer WITHOUT `access.can` and without the collection's derived fields, unlike every other item
  response. Routing it through `item()` means making the lifecycle helper return the row instead of a Response,
  which changes the response shape of ~40 collections at once - its own change, not a rider on another step.
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

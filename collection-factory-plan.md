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

**74 of 106 route files are on the factory. Five collections remain, and every one of them carries a recorded
reason - none is simply unstarted work.** 1219 tests across 105 files green. Every commit typechecks and passes the full suite with pre-existing tests unmodified,
and each is independently shippable.

The remaining 36 non-factory route files are not collections at all - sub-resource routes, action surfaces and
the five key/value config surfaces the drift test names.

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
- `decorate` runs on write responses too, so a POST answers with the shape a GET would.
- `serialize(row, user)` is for viewer-dependent resources (an employee's signature marker, a review's withheld
  manager assessment).
- The access hint is derived from what the route actually mounted, not from `ACCESS_VERBS`. A factory-built
  collection never consults that table.
- A caller-supplied `?id=` that is already taken is a 409 ALREADY_EXISTS, not a 500.
- The lock guard lives in `src/services/lockGuard.ts` (a leaf). Importing it from `services/lifecycle.ts` inside
  `crud.ts` created a cycle through notifications and left `crudService` undefined at module-init.

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

Five files, each blocked on something that is not a spec knob. All are in `PENDING` in the drift test, which
carries the same reasons inline. Three want a schema or an identity change first; two want a factory change
that has to be decided on its own merits, not slipped in to finish a conversion.

| file | why it is still hand-rolled |
| --- | --- |
| `automations` | **Blocked on the schema.** The table carries BOTH `enabled` (the rule's own switch, which :enable/:disable write through `setAutomationEnabled`) and the generic lifecycle `disabled`/`locked` columns. On the factory the shared lifecycle verb answers :enable/:disable first and would write the wrong column, leaving a rule that reads disabled but still fires. Collapse the duplicate columns first - that is a schema change, not a spec knob. |
| `roles` | **Blocked on identity.** The item id is the role NAME (the FK target every grant and user row points at), not the uuid every generic method keys on. Converting means overriding all of get/update/delete, which buys the list shape and nothing else. |
| `accessRules` | **Blocked on identity.** Rows are keyed by an `id` column and have neither the `uuid` every generic method keys on nor the `code` the access hint decides against; the service also serializes inside list/get. |
| `users` | **Blocked on the response.** `GET /v1/users/me` answers with a caller-identity envelope (capabilities + grantable scope tiers) and synthesizes a row for a simulated principal who has never signed in. The factory serializes a row; this endpoint answers about the caller. |
| `announcements` | **Blocked on ordering.** A board post carries `read_by`/`read_count` only for its author or someone who may edit it, and that second half is read off `access.can` - the hint the factory computes AFTER serializing, from the per-object grant only it holds. `serialize(row, user)` runs before that and sees the caller's broad grant, so it cannot make the same call. Expressing it needs a post-serialize hook - the 16th knob, so it goes here instead. |

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

# One collection system

## Context

Every collection used to hand-roll the AEP standard methods: list with cursor paging, get, create, patch with
`If-Match`, delete with `?force`, plus the shared lifecycle verbs and `:restore`. 86 route files, the same ~60
lines copied into each. That duplication is not a tidiness problem, it is a defect generator - converting the
first 34 collections surfaced six defects of one class, each present because the code was copied rather than
shared:

- `?id=` (AEP user-specified id) was spread as a non-existent `id` column in at least five collections and
  silently dropped.
- `POST /v1/pay-grades/{id}:lock` returned 500: the shared lifecycle verbs were mounted over a table with no
  `locked` column.
- `assertNotLocked` was present in some updates and absent in others for no reason.
- PATCH of a soft-deleted row 404'd in two collections and succeeded in the rest.
- `pay-grades` had no tests at all; `expense-categories` had none of its own.
- Auto-mounting DELETE on `positions` / `compensation` would have handed HR a way to delete role and salary
  history (caught during conversion, before it shipped).

The end state: exactly one way to define a collection. `src/http/collectionRoute.ts` + `src/services/crud.ts`
generate the standard lane from a spec; per-collection domain logic stays in that collection's service.
`test/collectionLaneDrift.test.ts` enforces it, so the rule survives without anyone remembering it.

Authorization is untouched throughout: `src/middleware/authz.ts` remains the single source of access control and
the factory decides no permission.

## Current state

**34 of 86 collections on the factory.** 1212 tests green; every commit typechecks, passes the full suite with
pre-existing tests unmodified, and is independently shippable.

| commit | what |
| --- | --- |
| `d95464e` | the factory + holidays, pay-grades, expense-categories |
| `3608482` | reimbursement-categories, vendors, projects, shifts, leave-types, pay-periods |
| `2b6b1a4` | salary-structures, background-checks, compliance-events (route-level `list` hook) |
| `8887e2c` | create/update schema split, verb entries, optional insert/patch |
| `2b523a2` `d3b7d24` | benefit-plans, compliance-rules, letter-templates, expense-budgets, pay-components |
| `7b7c6ff` | read-only + append-only: document-acknowledgements, leave-balances, event-log, cron-runs, automation-runs, workflow-instances |
| `a936df9` … `0d0ab95` | events, dependents, positions, approval-delegations, holiday-selections, transition-tasks, compensation, assets, notifications |
| `a4e4484` | the lane drift test with its shrinking PENDING ledger |

### The spec, as it now stands

Required: `table`, `collection`, `auditName`, `notFound`, `param`, `serialize`.
Optional: `insert`, `patch` (omit either to mount no POST / no PATCH), `writeSchema` or `createSchema` +
`updateSchema`, `sort`, `decorate`, `afterCreate`, `afterUpdate`, `allocCode`, `lifecycleName`, `publish`,
`publishTime`, `softDelete: false`, `overrides`, `list`, `verbs`.

Behaviours worth knowing before converting anything:

- The delete lane is described, never assumed. No `delete_time` column → no DELETE and no `:restore`.
  `softDelete: false` opts a history collection out even when the column exists. `overrides.remove` gives a
  permanent delete with no restore and no `?force`.
- POST/PATCH mount when EITHER the generic mapper or an override supplies the method.
- `decorate` runs on write responses too, so a POST answers with the shape a GET would.
- `serialize(row, user)` for viewer-dependent resources; `list` may return `extra` for an aggregate beside the
  page.
- `assertNotLocked` lives in `src/services/lockGuard.ts` (a leaf). Importing it from `services/lifecycle.ts`
  inside `crud.ts` created a cycle through notifications that left `crudService` undefined at module-init.

## Decided policy

**1. Key/value config surfaces are not collections, and the test checks that.** `policy`, `preferences`,
`settings` and `payrollDebit` have a collection's route shape but a key as their item id and an upsert as their
PATCH; `payrollDebit` is not even backed by its own table (it is a `settings` key). They stay hand-written in a
named `NOT_COLLECTIONS` category in the drift test, each with a one-line reason, and the test asserts they have
**no POST and no DELETE** - if one grows a create or a delete it has become a collection and the test pulls it
into the lane.

**2. The spec surface is frozen.** No new optional fields from here. A collection that appears to need a 16th
knob goes into `PENDING` with the reason instead, to be reviewed as a batch. Step 5's variation is custom
methods, which `verbs` already covers, so this should rarely bind.

**3. Convert biggest-first, in batches of 3-6, one batch per session.** Verb entries pay most in the files with
the most hand-written verb blocks, and those are the files people edit. Long sessions caused the only two
mistakes so far (writing a service from a stale read; inventing a tighter zod schema than the original), so
batch size is a quality control, not a preference.

## Remaining work

### Batch 0 - the exempt category (small, do first)

Edit `test/collectionLaneDrift.test.ts`: split the list into `PENDING` (conversion budget) and
`NOT_COLLECTIONS` (`policy`, `preferences`, `settings`, `payrollDebit`, each with its reason). Add the
assertion that a `NOT_COLLECTIONS` file registers neither `.post("/"` nor `.delete(`. Verify the new assertion
fails when violated (add a POST to one temporarily), then revert and commit.

### Step 4 remainder - 11 files

Each keeps its scope-filtered list behind the route-level `list` hook; owned codes via `allocCode`; write side
effects via `afterCreate` / `afterUpdate`.

| batch | collections | route/service lines | notes |
| --- | --- | --- | --- |
| 4a | settlements, payslips, bonuses | 37/425, 31/46, 61/195 | money-adjacent; settlements' service is large and stays bespoke behind overrides |
| 4b | leaveEncashments, benefitEnrollments, noticePeriods | 52/344, 51/132, 61/142 | all scoped + owned + effects |
| 4c | attendance, attendanceRegularizations, checkIns | 39/75, 49/123, 57/105 | 2-3 verbs each (clockIn/clockOut, approve/reject/cancel) |
| 4d | departments, shiftAssignments | 53/89, 50/90 | departments allocates dept codes and re-parents subtrees - read `src/services/departments.ts` fully before touching it |

### Step 5 - 34 files, the verb-heavy population

Each hand-written verb block (parse body → call service → serialize → access hint) becomes one `verbs` entry.
Use `{raw}` only for a verb that does not answer with a resource.

| batch | collections | verbs each |
| --- | --- | --- |
| 5a | tickets, expenses, loans | 8, 7, 5 |
| 5b | transitions, reviews, reviewCycles | 5, 7, 5 |
| 5c | reimbursements, taxDeclarations, leaveRequests | 6, 5, 3 |
| 5d | goals, timeEntries, overtimeRequests, remoteWorkRequests | 2, 4, 3, 3 |
| 5e | offers, interviews, interviewFeedback, candidates, applications, requisitions | 6, 3, 1, 3, 3, 1 - the ATS group; their logic lives in `src/services/ats.ts`, not per-collection files |
| 5f | referrals, suggestions, sprints, boards, automations | 4, 4, 3, 3, 3 |
| 5g | documentRoutes, payrollRuns, bankFormats | 5, 5, 1 - byte streams: `{raw}` verbs |
| 5h | apiKeys, accessRules, users, roles, operations, ticketChecklists, reviewFeedback | 0-2 each; cheap cleanup tail |

### Step 6 - the heavy three, converted last

- **cards** (127/423): distinct create/update schemas, 9 verb entries, scoped list with `?board`,
  `overrides.get` for `getCardWithComments`.
- **announcements** (216/502): 6 verbs, owned code, publish/unpublish (`publish: true`).
- **employees** (211/207): `list` hook (scope + `?q`), `decorate` for the viewer-dependent signature strip and
  `profile_completeness`, `serialize(row, user)`, `{raw}` verbs for photo / signature / identity-doc bytes, and
  its ten singleton sub-resource routes (`/bank-account`, `/identity`, `/personal-info`, `/tax`,
  `/notification-prefs`, `/bio`) chained onto the Hono app the factory returns.

Expect these three to be roughly LOC-neutral. They are converted so no collection sits outside the lane.

### Step 7 - close it out

- `PENDING` is empty; the drift test's `toBeGreaterThanOrEqual` floor becomes the real count.
- `docs/authz.md` collection-authoring section and the add-collection checklist describe ONE path: write a spec,
  mount it, done.
- This file records the final state and the knob inventory.

## Per-collection recipe

1. `git show HEAD:src/routes/<name>.ts` and `git show HEAD:src/services/<name>.ts` - **not** the Read tool,
   which went stale mid-session three times and led to services written from memory.
2. Check the table for `delete_time` / `locked` / `disabled`, and check whether the current route exposes a
   DELETE. Column present + route absent → `softDelete: false`. Hard `db.delete` in the service →
   `overrides.remove` + `softDelete: false`.
3. Move field mapping into `insert` / `patch` verbatim, including validation and its exact error strings.
4. Keep audit stems byte-identical (`auditName`, plus `lifecycleName` where the lifecycle verbs used a different
   singular). `test/apiKeys.test.ts` asserts on `holiday.%`; the activity feed renders these.
5. Scoped list → route-level `list(c)`. Owned code → `allocCode(deps, table, values)`. Side effects →
   `afterCreate` / `afterUpdate`. Anything else genuinely bespoke → `overrides`.
6. `grep -rn "<serviceFn>" src test` before renaming or dropping an export - `test/listTruncation.test.ts`
   imports `listHolidays` directly, and cron imports several services.
7. `npm run typecheck && npm run test`. Pre-existing tests must pass **unchanged** - that is the equivalence
   proof. Commit the batch.

## Verification

- Per batch: `npm run typecheck`, `npm run test` (105 files / 1212 tests today), pre-existing tests unmodified.
- `test/collectionFactory.test.ts` (21 tests) pins the shared surface: paging cursor, If-Match, lock guard,
  delete/`?show_deleted`/restore/`?force`, unknown-verb 404, unsupported lifecycle verb 404, audit stems, the
  create/update schema split, verb entries (schema / no schema / raw), append-only tables, read-only specs.
- `test/collectionLaneDrift.test.ts` gates the lane itself.
- Existing contract gates stay: `openapiRoutesDrift`, `customMethodsDrift`, `serializerContractDrift`,
  `accessHint`, `parity` (route × role), `bola` (item-level isolation), plus `npm run api:lint` (spectral) in the
  pre-commit `verify` hook.
- Per batch, diff audit action stems and 404 wording against `git show HEAD~1` for the converted collections.
- No screenshot/boot verification (project convention): reason plus `tsc` plus the suite.

## Known consequences, accepted

- Uniform semantics replace per-collection accidents: `?id=` honored via `uuid`, `assertNotLocked` on every
  update, PATCH of a soft-deleted row 404s, item responses always carry the per-object access hint, delete-side
  audit stems normalize to the create/update stem, GET of a soft-deleted row resolves rather than 404ing.
- `compliance-rules` lost the `{generated: N}` meta on its create audit row; the count stays derivable from
  `compliance_events.rule_id`.
- Indirection: a route file no longer shows the mechanics. `collectionRoute.ts` + `crud.ts` (~300 lines) is the
  one file to learn.
- Override-heavy collections are LOC-neutral or slightly worse (`holiday-selections` 33 → 39 lines, `assets`
  51 → 45). They convert for one lane and one test, not for line count. The "−70 lines each" arithmetic from
  the first three collections does not apply to what remains.

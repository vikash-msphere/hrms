# One collection system

## Context

`src/http/collectionRoute.ts` + `src/services/crud.ts` (added in commits `d95464e`, `3608482`, `2b6b1a4`) now
serve 12 collections from a spec. The other 74 collection route files still hand-roll the same standard
methods. That split is the problem to remove: not because of line count, but because hand-copied standard
methods drift, and the drift is silent.

Evidence from converting only 12: `?id=` (AEP user-specified id) was spread as a non-existent `id` column in at
least five collections and silently dropped; `assertNotLocked` was present in some updates and absent in others
for no reason; `POST /v1/pay-grades/{id}:lock` returned 500 because the shared lifecycle verbs were mounted over
a table with no `locked` column; PATCH of a soft-deleted row 404'd in two collections and succeeded in the rest;
`pay-grades` had no tests at all. Six defects of one class, all produced by duplication. The remaining 74 files
carry the same class today.

Outcome: exactly one way to define a collection. The standard lane (list/get/create/update/delete/restore +
shared lifecycle verbs) is always generated from a spec; per-collection domain logic lives in that collection's
service, where it already lives. A drift test makes the rule mechanical instead of a matter of my judgment.

## What "one system" means precisely

- **In scope (86 files):** every route file that registers the standard methods — a collection-level `GET /`
  plus an item-level `GET /:id`. These must be built by `collectionRoutes`.
- **Out of scope (~21 files):** endpoints that are not collections and have no standard methods — auth
  (`src/routes/authRoutes.ts`), `search`, `batch`, key/value `settings` and `policy`, report/preview endpoints
  (`payslipTemplatePreview`, `accessPreview`, `statutoryReport`-style downloads). These are not a second CRUD
  system; they have no CRUD to duplicate.
- **Not affected:** authorization. The middleware stays the single source of access control
  (`src/middleware/authz.ts`); the factory decides no permission. Bespoke *services* (payroll, settlements, ATS
  scoring) stay bespoke — the factory owns transport shape, not domain logic.

## Three factory additions (the whole gap)

1. **Separate create/update schemas.** `cards` requires `board` + `title` on POST and forbids them on PATCH
   (`src/routes/cards.ts:18-50`), so today's single `writeSchema` cannot express it. Add
   `createSchema`/`updateSchema`, keeping `writeSchema` as the shorthand for the common case where they match.
2. **Verb entries.** Replace the current opaque `verbs?: Record<string, handler>` with entries that carry an
   optional zod body schema and a runner: `{schema?, run: (deps, user, id, body) => Promise<row>}`, serialized
   and access-hinted by the factory. `cards` has nine such blocks that are pure boilerplate
   (`src/routes/cards.ts:92-125`). Keep a raw escape (`raw: (c, id) => Promise<Response>`) for verbs that
   stream bytes or return a non-resource body — `employees` `getPhoto`/`downloadIdentityDoc`
   (`src/routes/employees.ts:172-201`).
3. **Optional `insert`/`patch`.** Omitting `insert` mounts no POST, omitting `patch` mounts no PATCH — so a
   read-only or externally-written collection (`documentAcknowledgements`, `eventLog`, `leaveBalances`,
   `cronRuns`, `automationRuns`) states that once in its spec instead of as a route somebody has to notice
   missing. (Partly drafted already in `src/services/crud.ts`.)

Everything else needed already exists: `list` (scoped lists via `applyScope` + `keysetPage`), `overrides`,
`allocCode` (owned/dept codes), `afterCreate`/`afterUpdate`, `sort`, `decorate`, `lifecycleName`, `publish`.
`decorate` already receives the actor, which is what `employees` needs for its viewer-dependent
`signature` strip and `profile_completeness` enrichment (`src/routes/employees.ts:58-83`) — no new hook.

**Hard rule:** a collection that would require a fourth addition stays hand-written *and* gets an explicit
allow-list entry in the drift test with a one-line reason. No silent exceptions.

## Progress

Steps 1 and 2 are done; 17 of 86 collections are on the factory. Every commit below is green
(typecheck + full suite, pre-existing tests unmodified).

| commit | step |
| --- | --- |
| `d95464e` | factory + holidays, pay-grades, expense-categories |
| `3608482` | reimbursement-categories, vendors, projects, shifts, leave-types, pay-periods |
| `2b6b1a4` | salary-structures, background-checks, compliance-events (route-level `list` hook) |
| `8887e2c` | step 1: create/update schema split, verb entries, optional insert/patch |
| `2b523a2` | benefit-plans, compliance-rules |
| `d3b7d24` | letter-templates, expense-budgets, pay-components (step 2 complete) |

Two spec refinements the conversions earned after the plan was written:
- `decorate` now also runs on create/update/restore responses, so a write answers with the same resource shape
  a read would (expense-budgets derives spend on every row).
- A verb entry is `{schema?, run}` or `{raw}`; `run` returns the row and the factory serializes + hints it.

Next: step 3 (read-only / partial collections), which exercises optional `insert`/`patch` in anger.

## Sequence

Each batch: convert, `npm run typecheck`, `npm run test`, commit. Pre-existing tests must pass **unchanged** —
that is the equivalence proof. Batches are independently shippable; stop between any two.

1. **Factory additions** (the three above) + extend `test/collectionFactory.test.ts` to pin them: distinct
   create/update schemas, a verb entry with and without a body schema, a raw verb, and 405/404 behavior for a
   collection with no `insert`/`patch`.
2. **Plain collections (5):** `payComponents`, `complianceRules`, `expenseBudgets`, `benefitPlans`,
   `letterTemplatesRoutes`. No new hooks; ~−70 lines each.
3. **Read-only / partial (6):** `documentAcknowledgements`, `eventLog`, `leaveBalances`, `cronRuns`,
   `automationRuns`, `workflowInstances`. Exercises addition 3.
4. **Scoped + owned-code (≈20):** `events`, `dependents`, `noticePeriods`, `benefitEnrollments`,
   `departments`, `shiftAssignments`, `positions`, `approvalDelegations`, `assets`, `compensation`,
   `holidaySelections`, `settlements`, `payslips`, `leaveEncashments`, `notifications`, `bonuses`,
   `transitionTasks`, `attendance`, `attendanceRegularizations`, `checkIns`. Uses `list` + `allocCode` +
   `afterCreate`. Expect ~−35 each; these are converted for uniformity, not line count.
5. **Verb-heavy (≈30):** `loans`, `expenses`, `tickets`, `transitions`, `reviews`, `reviewCycles`,
   `reviewFeedback`, `taxDeclarations`, `reimbursements`, `overtimeRequests`, `remoteWorkRequests`,
   `leaveRequests`, `goals`, `sprints`, `boards`, `offers`, `interviews`, `interviewFeedback`, `candidates`,
   `applications`, `requisitions`, `referrals`, `suggestions`, `timeEntries`, `automations`, `bankFormats`,
   `documentRoutes`, `payrollRuns`, `apiKeys`, `accessRules`, `users`, `roles`, `operations`,
   `ticketChecklists`. Biggest LOC win, via addition 2.
6. **Heavy last (3):** `cards`, `announcements`, `employees`. Near LOC-neutral; converted so no collection is
   outside the lane. `employees` keeps its ten sub-resource routes chained onto the returned Hono app.
7. **Enforcement + docs:** the drift test, then update `docs/authz.md` (collection-authoring section) and the
   add-collection checklist to describe one path only.

## Enforcement (the part that makes it durable)

New `test/collectionLaneDrift.test.ts`, in the style of the existing source-scanning drift tests
(`test/openapiRoutesDrift.test.ts` reads `src/index.ts` via `import.meta.glob(..., "?raw")`): for every file
under `src/routes/`, if the source registers a collection-level `GET /` **and** an item-level `GET /:`, assert
it imports `collectionRoutes` — unless its basename is in a small documented allow-list. A new hand-rolled
collection then fails CI with a message naming the factory.

## Verification

- `npm run typecheck` and `npm run test` green after every batch, with pre-existing tests unmodified.
- `test/collectionFactory.test.ts` covers the shared surface (paging cursor, If-Match, lock guard,
  delete/`?show_deleted`/restore/`?force`, unknown-verb 404, unsupported lifecycle verb 404, audit action
  stems) and grows with each factory addition.
- Existing gates already protect the wire contract: `test/openapiRoutesDrift.test.ts`,
  `test/customMethodsDrift.test.ts`, `test/serializerContractDrift.test.ts`, `test/accessHint.test.ts`,
  `test/parity.test.ts` (route x role), `test/bola.test.ts` (item-level isolation), plus
  `npm run api:lint` (spectral) via the pre-commit `verify` hook.
- Per batch, diff the audit action stems and 404 wording against `git show HEAD~1` for the converted
  collections — those strings are asserted by feed rendering and by `test/apiKeys.test.ts`.
- No screenshot/boot verification (project convention): reason plus `tsc` plus the suite.

## Known consequences to accept

- Uniform semantics replace per-collection accidents: `?id=` honored via `uuid`, `assertNotLocked` on every
  update, PATCH of a soft-deleted row 404s, item responses always carry the per-object access hint,
  delete-side audit stems normalize to the create/update stem (e.g. `"background check.delete"` →
  `"background-check.delete"`), GET of a soft-deleted row resolves rather than 404ing.
- Indirection: a route file no longer shows the mechanics; `collectionRoute.ts` + `crud.ts` (~230 lines) is
  the one file to learn.
- Roughly ten heavy collections come out LOC-neutral. That is the price of a single lane, paid deliberately.
- This is a multi-session grind (74 files). The branch stays green and shippable at every commit.

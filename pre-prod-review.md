# Plan: fix open production-readiness issues

> **Where this stands (2026-08-16).** Phases 1 and 2 shipped. Phase 3 was rejected in favour of the
> harden-only alternative; only its follow-up tripwire is still open. Phase 4 is superseded by
> `production-readiness.md`, which is the current release-readiness ledger. This file is kept for the
> reasoning behind the concurrency and re-parenting work.

## Context

An independent pre-prod review (see memory `concurrency-money-atomicity`) fixed the money/balance
double-apply races and confirmed the rest of the app is well-hardened. A handful of open issues remain
before production. This plan closes them. Two are large enough to be their own phase (re-parenting,
money precision); the rest are bounded hardening + ops.

Root architecture fact that shapes this plan: the internal `code` column is a hierarchical scope key
(`dept-subdept-employee-leaf`). Dept-scope is a pure code-prefix `LIKE` (`listScope.ts:26`), and every
employee-owned row derives its code from the owner's code (`codeAlloc.ts allocOwnedCode`). So anything
that changes an entity's place in the hierarchy must recompute a whole code subtree.

---

## Phase 1 — Exactly-once state transitions (bounded hardening) — ✅ DONE (654 tests green)

**Problem:** most approval/workflow services validate state with a READ, then do an UNGUARDED
`update().where(eq(uuid,id))` flip, then apply a side-effect. TOCTOU: a double-clicked/concurrent call
passes the read twice → applies the side-effect twice. The money-moving ones (leave, encashment) are
already fixed; the rest currently only risk double notifications/events, but should be uniformly guarded
for correctness + idempotency.

**Fix pattern (already applied in `leaveRequests.decide` / `leaveEncashments`):** guard the flip on the
state read — `.where(and(eq(uuid,id), eq(state, from))).returning()`; treat 0 rows as "already decided"
(throw `failedPrecondition`); run side-effects only for the winning row. For approve-then-money, claim
the transition first, then move money, revert claim on money failure.

**Files (shared `transition`/`decide` helper in each):**
- `src/services/overtimeRequests.ts:64` (transition)
- `src/services/remoteWorkRequests.ts:66` (transition)
- `src/services/attendanceRegularizations.ts:77` (transition)
- `src/services/reimbursements.ts:75` (decide) + `:144` (`payReimbursement`) + `:147` settle marker
- `src/services/loans.ts` approve/reject/disburse (`setStatus` calls) — guard the status flip
- `src/services/taxDeclarations.ts:94` verify / `:103` reject
- `src/services/tickets.ts:200`, `timeEntries.ts:95`, `reviews.ts` submit stages, `reviewFeedback.ts:79`
- `src/services/ats.ts` `rejectApplication:309`, `acceptOffer:571/607/643` (offer accept already needs a
  `WHERE status='extended'` guard — highest value here, prevents a double createEmployee)

**Verify:** extend `test/moneyFlow.test.ts` + relevant flow tests with a "second call rejects, side-effect
applied once" case per family (leave/encashment already covered). `npm run verify` green.

---

> **DECISION (superseded 2026-08-14):** the original decision here was a full integer minor-units
> conversion for Phase 3. What shipped is the harden-only alternative, and that is now the standing
> decision: money stays `real`, with `round2` / `sum2` as the single rounding discipline
> (`src/domain/money.ts`, ~160 call sites, `src/db/schema.ts:6` states the invariant). Phase 2 shipped as
> planned (full re-parenting cascade).

## Phase 2 — Department / employee re-parenting (feature) — ✅ DONE (657 tests green)

Implemented: `src/services/codeCascade.ts` (`HIERARCHICAL_TABLES` = 39, `reprefixSubtree`, `moveEmployee`,
`moveDepartment`); wired into `departments.ts`/`employees.ts` update (replaced the `unimplemented` throws);
`authzResolve.ts` uuid→code cache gained a 10-min TTL + `invalidateCodeCache()` (called after a move);
`test/reparenting.test.ts` (cascade + cycle-guard + coverage tripwire). `assets` correctly EXCLUDED (flat-coded).

**Problem:** `departments.ts:70` and `employees.ts:149` throw `unimplemented` on a parent/department
change. Reorgs are core HRMS. Because scope = code prefix, a move must recompute the moved entity's code
+ every descendant + every owned row + `access_rules.match_code`.

**Approach (subtree reprefix over the HIERARCHICAL table set only):**
- Correctness rule discovered: reprefix must run ONLY over tables whose codes live in the dept/employee
  hierarchy — `departments`, `employees`, and the 39 employee-owned tables (every `allocOwnedCode` site;
  enumerated). Flat tables (holidays, leave-types, pay-periods, payroll-runs, users, boards, projects,
  candidates, ...) must be EXCLUDED — a flat code (`04`) can coincide with a dept's top-level code (`04`),
  so an org-wide prefix reprefix would corrupt them. Within the hierarchical set there is no such collision,
  so `code = oldPrefix OR code LIKE oldPrefix||'-%'` is exact.
1. New `src/services/codeCascade.ts`: `HIERARCHICAL: {table, collection}[]` (the 39) + `reprefixSubtree(deps,
   oldPrefix, newPrefix)` running per table
   `UPDATE SET code = newPrefix || substr(code, len(oldPrefix)+1) WHERE code=oldPrefix OR code LIKE oldPrefix||'-%'`,
   plus `access_rules.match_code` reprefixed the same way but scoped to `namespace IN (hierarchical collections)`.
2. `moveDepartment` (cycle-guard: new parent not a descendant; `allocUnderDept` new seg; `reprefixSubtree`;
   set parentId) + `moveEmployee` (`allocUnderDept(newDept)`; `reprefixSubtree(oldEmpCode,newEmpCode)`;
   set departmentId). Wire `id`s never change → zero client/wire-token impact.
3. Replace the two `unimplemented` throws (`departments.ts:70`, `employees.ts:149`) with these. Org-chart UI
   already sends reparent PATCHes (`OrgChart.tsx`).
4. **Immutable-code invariant (DECISION):** `authzResolve.ts` caches uuid→code per-isolate assuming code is
   immutable. Re-parenting breaks that — other isolates keep stale codes → wrong scope until recycle. Fix:
   add a short TTL (e.g. 5 min) to `codeCache` + clear affected keys in the acting isolate after a move. Rare,
   admin-only op → bounded 5-min scope-staleness for a just-moved person is acceptable + documented. (The
   alternative — decouple authz scope from code onto a live dept lookup — is a far bigger engine rewrite; not
   chosen.)
5. Drift test: assert `HIERARCHICAL` covers exactly the `allocOwnedCode` table set + {employees, departments}.

**Risk:** a missed hierarchical table = orphaned scope. Mitigated by the drift test above.

---

## Phase 3 — Money precision — NOT DONE, and deliberately not doing it

**Status:** the integer conversion below was designed and then rejected. 55 `real()` columns remain and
`src/domain/money.ts` exposes only `round2` / `sum2`. Reason: the conversion touches every money column,
every domain calculation and every money test to close a gap that no test or production incident has shown,
right before launch. 1252 tests cover the money flows end to end (EMI recovery, settlement, statutory,
arrears) with the discipline in place.

**What to do instead (still open, ~1 h):** convert the convention into a gate. A drift test in the style of
`serializerContractDrift` / `collectionLaneDrift` that scans `src/domain` and `src/services` for writes to
known money columns and fails when the value did not come from `round2` / `sum2` or a bound parameter.

The original design is kept below for the record; do not implement it without re-deciding.

**Problem:** all monetary + leave-day columns are SQLite `REAL` (IEEE-754). Correct-by-construction fix =
store integers internally, never float.

**Design:**
- **Storage:** money columns → `integer` **paise** (×100); leave-day columns → `integer` **centidays** (×100,
  preserves half-day + fractional accrual exactly). ~49 `real()` columns in `schema.ts` reclassified as
  money vs day (list at `schema.ts` real() grep). `hours` (overtime) and `rank` (goal ordering) are NOT
  money — `hours` → integer centi-hours, `rank` stays real (pure ordering, no arithmetic/drift concern).
- **One money module** `src/domain/money.ts`: replaces the 9 duplicated `round2` defs. Exposes integer-safe
  helpers — `rupeesToPaise(n)`, `paiseToRupees(p)`, `pct(basePaise, percent)` (round-half-up to nearest
  paise), `sumPaise(...)`. Days: `daysToCenti`/`centiToDays`. All domain math (`domain/payroll.ts`,
  `settlement.ts`, `encashment.ts`, `loans.ts`, `carryForward.ts`, `statutory.ts`, `incomeTax.ts`,
  `leave.ts`) moves to integer arithmetic; percentage/proration boundaries round to the minor unit.
- **Wire/API unchanged (critical):** the openapi contract + web keep DECIMAL rupees/days. Convert at the
  edges only — `http/serialize.ts` maps paise→rupees on read; each route/service parses rupees→paise on
  write (input still arrives as decimal numbers). So NO openapi change, NO web change. Verified boundary:
  `serialize.ts` emits `amount`/`monthly_amount`/`declared_amount`/etc. — wrap each in `paiseToRupees`.
- **Rounding policy:** define once (round-half-up, half-paise → up). Statutory/tax percentages and proration
  factors are the drift sources — each rounds to whole paise at its component line, matching payslip display.

**Files:** `schema.ts` (columns), new `domain/money.ts`, all `domain/*` money math + their services,
`http/serialize.ts` (paise→rupees out) + write paths (rupees→paise in), every money test in `test/`.

**Verify:** existing 654 tests re-asserted (values unchanged at the wire), + a new test that builds a large
multi-employee run and asserts totals are EXACT (integer paise, zero drift) and that wire output still reads
in rupees. One-migration squash for the column type changes.

---

## Phase 4 — Ops / deploy — superseded by `production-readiness.md`

The live ops punch list is `production-readiness.md` (2026-08-14). State of the three items raised here:

- Staging `database_id` is still `REPLACE_WITH_STAGING_D1_ID` — **open** (production-readiness item 10).
- Identity perimeter — **done**: `ALLOWED_EMAIL_DOMAINS` gates first-login auto-provisioning, fail-closed,
  and `makeDeps` refuses to boot Google mode without it (`test/productionReadiness.test.ts`).
- DR export — **done**: `.github/workflows/d1-backup.yml` exports D1 to R2 nightly plus a 30-day artifact.
  R2 object backup is the remaining gap (production-readiness item 11).

---

## Verification (whole plan)
- `npm run verify` (spectral lint 0/0, tsc clean, tests green) after each phase.
- Web: `cd web && npx tsc --noEmit`.
- Re-parenting: a DB-backed test that creates dept A>emp>leave-request, moves emp to dept B, and asserts
  emp code + the leave-request code + any access_rule match_code all now sit under B (and old-dept manager
  scope no longer lists them, new-dept manager does).
- One-migration squash after the (only) schema touch, if any (Phase 3 alt / none otherwise): rm 0000
  sql+snapshot, empty journal, `npx drizzle-kit generate`.



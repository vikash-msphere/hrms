# Leave policy engine: restrictions on leave types

## Context

`leave_types` today carries accrual, probation, encashment and carry-forward policy only
(`src/db/schema.ts:299`). Every rule a request is actually checked against is hard-coded in
`createLeaveRequest` (`src/services/leaveRequests.ts:168`): overlap, disabled type, probation
availability, probation cap, balance, plus one org-wide back-dating toggle
(`settings/leave-requests`). There is no way to express any of the policy an HR team normally
writes down: notice requirements, frequency caps, sandwich counting, combinations, exit-process
limits, joining-month cutoffs, blackout windows, coverage floors.

This adds a **leave policy engine**: an optional restrictions blob, settable **org-wide for the
whole collection** and **per leave type**, with a pure rule evaluator shared by the server and the
SPA. Everything defaults off, so an org that configures nothing behaves exactly as today. The five
restrictions asked for are Phase 1 along with every rule that rides the same plumbing; the rest is
phased by what new data each needs.

## Model

One JSON blob, the same shape in both places:

- **Org baseline** - `settings/leave_restrictions` (new settings key; `settings.**` is already
  granted at `src/domain/grants.ts:22`, so no grant or seed change).
- **Per type** - a new `leave_types.restrictions` JSON column.

**Inheritance: per leaf, two levels deep.** The blob is `{ group: { key: value } }`; a leaf present
in the type's blob wins, a leaf absent inherits the org baseline, and an explicit `null` leaf means
"no restriction for this type" (it blocks inheritance rather than falling back). Arrays are
replaced wholesale, never merged. This keeps a type able to relax exactly one org rule without
restating the group.

**Hard vs soft.** Every violation carries a stable `code`. `soft_rules: ["advance_notice", …]`
lists codes that **warn instead of block**: the request is created, the warnings are stored on a
new `leave_requests.policy_warnings` column, shown to the approver on the Approvals card, carried
in the `leave.requested` event payload and written into the audit meta. That is what makes
"emergency, approver's discretion" expressible without a second policy system.

**When rules run.** At create time only. An approval never re-checks policy (a policy edited after
someone filed must not silently invalidate their pending request), and the balance guard on the
decide path is unchanged.

**HR on behalf.** Planning courtesies - advance notice, max advance, blackouts, weekday blocks -
are skipped when HR files for someone else (the existing `onBehalf` flag,
`src/services/leaveRequests.ts:183`, the same exemption back-dating already uses). Entitlement
rules apply to everyone.

## The rule catalogue

Grouped as the blob is grouped. `P` = phase.

### `eligibility` - who may take this type at all

| Key | Meaning | Enforced in | P |
|---|---|---|---|
| `min_tenure_days` | No requests until N days of service | create | 1 |
| `max_occurrences_lifetime` | At most N separate instances ever (e.g. 2 maternity) | create | 1 |
| `max_lifetime_days` | At most N days of this type over the whole employment | create | 1 |
| `genders` | Restricted to these genders (maternity/paternity) | create | 2 |
| `employment_types` | full_time / part_time / contract / intern / temporary | create | 2 |
| `departments`, `locations`, `pay_grades` | Restricted to these | create | 2 |

Probation eligibility stays in the existing `available_during_probation` /
`probation_cap_days` columns - they work, they are surfaced, and moving them would churn the
serializer, the bootstrap and three UIs for no behaviour change. The editor shows them inside the
new Eligibility panel so the policy reads as one thing.

### `request` - the shape of one request

| Key | Meaning | P |
|---|---|---|
| `min_days`, `max_days` | Bounds on one request (`min_days: 1` also bans half days) | 1 |
| `max_consecutive_days` | Cap on the merged contiguous run of this type, not just this row | 1 |
| `half_day_allowed` | Whether sessions may split a day at all | 1 |
| `blocked_weekdays` | e.g. no leave on a Monday or Friday | 1 |
| `must_be_single_block` | The whole entitlement in one stretch (maternity) | 1 |
| `reason_required`, `reason_min_length` | Force a stated reason | 1 |
| `document_required_over_days` | Sick note past N days (the dialog already takes an attachment) | 1 |
| `backdate_days` | Per-type back-dating window; overrides the org-wide toggle | 1 |

### `timing` - when it may be asked for

| Key | Meaning | P |
|---|---|---|
| `advance_notice.tiers[]` + `beyond_notice_days` | Tiered notice: `{ up_to_days, notice_days }`, smallest tier covering the request wins | 1 |
| `max_advance_days` | No booking further out than this | 1 |
| `blackouts[]` | `{ from, to, label }` fixed windows | 1 |
| `blackout_days_of_month[]` | Recurring windows (month-end close) | 1 |
| `block_adjacent_to_holiday` | No bridging a company holiday | 1 |

### `quota` - how much, how often

| Key | Meaning | P |
|---|---|---|
| `max_days_per_month`, `max_days_per_year` | Volume caps | 1 |
| `max_requests_per_month`, `max_requests_per_year` | Frequency caps | 1 |
| `min_gap_days` | Minimum gap from the previous/next request of this type | 1 |
| `year_basis` | `calendar` \| `fiscal` \| `anniversary` - which year the yearly caps count over | 1 |

### `combinations` - across leave types

| Key | Meaning | P |
|---|---|---|
| `no_combination_with[]` | Leave-type refs this may not be taken with | 1 |
| `gap_days` | 0 = may not abut; N = may not come within N days | 1 |
| `requires[]` | Must be adjacent to / follow one of these types | 2 |
| `cap_groups[]` *(org-level only)* | `{ name, types[], max_days_per_year, max_consecutive_days }` - a shared cap across several types | 2 |

The check is **symmetric**: the new request's own list is evaluated, and so is the list of any
neighbouring request's type that names this one.

### `counting` - what a day costs

| Key | Meaning | P |
|---|---|---|
| `sandwich.weekends`, `sandwich.holidays` | `exclude` (today) \| `intervening` (charged when they fall between charged leave days) \| `flanking` (also charged when the leave abuts them) | 1 |

Weekends and holidays are separate leaves because real policies differ on them. This changes the
stored `days`, so balance, encashment, analytics and payroll all see one number.

### `exit` - notice period / offboarding

| Key | Meaning | P |
|---|---|---|
| `during_notice` | `allowed` \| `blocked` \| `capped` | 1 |
| `notice_cap_days` | The cap for `capped` | 1 |
| `accrual_during_notice` | `accrue` (today) \| `stop` from the notice date | 2 |

The exit window is a `notice_periods` row with `status = "serving"`
(`src/db/schema.ts:2616`), from `notice_date` to `last_working_day`; with no such row but an
`employees.end_date` in the future, the window is today → end date.

### `accrual` - the earning side

| Key | Meaning | Enforced in | P |
|---|---|---|---|
| `joining_rule` | `{ cutoff_day, if_on_or_before: full\|prorate, if_after: none\|prorate }` - joined after the cutoff ⇒ the joining month earns nothing **and** a request starting in it is refused | `computeAccrual` + create | 1 |
| `exit_rule` | The mirror for the leaving month | `computeAccrual` | 2 |
| `max_balance_days` | Accrual ceiling; the balance stops growing at N | accrual cron | 2 |
| `expiry_months` | Accrued days lapse N months after they were credited | accrual/carry-forward cron | 2 |
| `usable_after_days` | Credited but not yet spendable | create | 2 |
| `accrue_during_unpaid_leave` | Suppress accrual for a month spent on LOP | accrual cron | 2 |
| `timing` | `advance` (today, credited on the 1st) \| `arrears` (credited at period end) | `computeAccrual` | 2 |

### `balance` - what happens when there isn't enough

| Key | Meaning | P |
|---|---|---|
| `overdraft_days` | May go negative up to N days | 2 |
| `excess_becomes` | `reject` (today) \| `lop` - the excess is auto-split onto a named unpaid type | 2 |
| `basis` | `current` (today) \| `projected_at_start` - count what will have accrued by the leave date | 2 |

### `coverage` - team availability

| Key | Meaning | P |
|---|---|---|
| `max_concurrent_per_department` | At most N of a department away on the same day | 2 |
| `max_concurrent_pct` | …or at most N% of it | 2 |

The request dialog already computes the department overlap it needs for this
(`RequestLeaveDialog.tsx:229`); the server needs one bounded count.

### `approval` - routing

| Key | Meaning | P |
|---|---|---|
| `auto_approve_up_to_days` | Short requests land APPROVED | 2 |
| `second_approver_over_days` | `hr` \| `skip_level` for long requests | 2 |

### Per-employee exceptions - Phase 3

A `leave-policy-exceptions` collection (`{ employee, leave_type, rule_codes[], reason,
valid_from, valid_to }`) consulted by the evaluator, so "this person is exempt from the notice
rule until March" stops being a reason to weaken the org policy. It is a new collection, so it
carries the full add-collection checklist (grants, manifests, routes, UI) - deliberately deferred,
not forgotten.

## Plan

### 1. Domain (pure, shared with the SPA)

`web/src/lib/leaveDays.ts` already imports `src/domain/leave.ts` straight into the browser bundle,
so the evaluator can be one implementation for both sides.

**New `src/domain/leaveRestrictions.ts`:**

- `LeaveRestrictions` type + `DEFAULT_LEAVE_RESTRICTIONS` (every leaf null/off).
- `parseRestrictions(raw)` - lenient, for the read path (a malformed blob degrades to "no
  restrictions" rather than 500ing every leave request); `validateRestrictions(raw)` - strict,
  throws `invalidArgument`, for the write path. The same lenient-read/strict-write split
  `src/domain/policyValidate.ts:1` documents.
- `mergeRestrictions(orgBaseline, typeOverride)` - the per-leaf merge above.
- `requiredNotice(rules, days)` - the tier lookup.
- `checkLeaveRestrictions(input): Violation[]` - the whole catalogue as one pure function over
  already-gathered facts (effective rules, chargeable days, the per-month split, the employee's
  live neighbouring requests, lifetime totals, the exit window, tenure, eligibility attributes,
  org today). Returns `{ code, severity, message }`; `severity` comes from `soft_rules`.
- `describeRestrictions(rules)` - the human sentence, reused by the leave-type dialog summary and
  the request dialog (the page already builds a `policySummary`, `web/src/pages/LeaveTypes.tsx:106`).
- `historyWindow(rules, start, end)` - the single date window every history-dependent rule needs,
  and `null` when no configured rule needs one. This is what keeps the no-policy org paying zero
  extra reads (the D1 read-minimisation rule).

**`src/domain/leave.ts`:**

- `leaveDays(...)` gains a trailing `sandwich` argument (`{ weekends, holidays }`); `exclude`
  keeps every existing caller identical.
- New `daysByMonth(...)` - the same walk, split per `YYYY-MM`, for the monthly quota checks.
- `AccrualInputs` gains `joiningRule` (Phase 1), then `exitRule` / `maxBalanceDays` / `timing`
  (Phase 2); `monthFraction` and `halfFraction` return 0 or 1 for the joining month per the rule,
  and the exit reconciliation is untouched.

### 2. Storage

- `src/db/schema.ts` - `leaveTypes.restrictions` (`text(..., { mode: "json" })`, nullable) and
  `leaveRequests.policyWarnings` (same, nullable), in the style of `letterTemplates.blocks`
  (`src/db/schema.ts:2673`).
- Phase 2 adds `employees.employmentType` (reusing the ATS enum at `src/db/schema.ts:1900`) -
  employees have no employment type today, and several eligibility rules key on it.
- Regenerate the single squashed migration `src/db/migrations/0000_*.sql` (one migration is the
  repo rule; `test/changeDdlDrift.test.ts` pins schema/DDL agreement). `bootstrap/bootstrap.sql`
  needs no regeneration - its `leave_types` INSERT names its columns explicitly. Optionally seed
  sensible starting restrictions for the bootstrap leave types in
  `bootstrap/collections/leaveTypes.ts`.

### 3. Server

- `src/services/leaveTypes.ts` - `insert`/`patch` accept `restrictions` through
  `validateRestrictions`; `afterUpdate` also re-accrues when an accrual-affecting leaf changed
  (`joining_rule`, later `exit_rule` / `max_balance_days` / `timing`), beside the existing
  rate-change re-accrual.
- `src/services/leaveRequests.ts` (`createLeaveRequest`):
  1. read the effective rules - `getSettingValue(deps, "leave_restrictions", …)` merged with
     `parseRestrictions(lt.restrictions)`;
  2. widen the existing `holidaysInRange` call to `historyWindow(...)` and pass
     `rules.counting.sandwich` into `leaveDays`, so `days` already reflects the sandwich rule
     before the balance check reads it;
  3. **one** bounded query for the history-dependent rules (quota, gap, combinations, merged
     consecutive run, lifetime totals, `during_notice: "capped"`), reusing `liveLeaveInWindow`
     (`src/services/leaveRequests.ts:87`) over that window - **skipped entirely when
     `historyWindow` returns null**;
  4. a `notice_periods` lookup only when `exit.during_notice !== "allowed"`, and an eligibility
     read (position/compensation/personal-details) only when an eligibility rule is configured;
  5. `checkLeaveRestrictions`, then `throw failedPrecondition(first hard violation)`; soft
     violations are stored on `policy_warnings`, added to the audit meta and to the
     `leave.requested` event payload.
- Gender eligibility reads the employee's encrypted personal-details blob server-side and never
  returns it; the refusal names the policy, not the attribute.
- `src/services/leaveAccrual.ts` - read the org baseline once per tick, merge per type, pass the
  accrual leaves into `computeAccrual`.
- `src/http/serialize.ts` - `toLeaveTypeResource` emits `restrictions`
  (`src/http/serialize.ts:483`); the leave-request serializer emits `policy_warnings`.
  `test/serializerContractDrift.test.ts` covers the contract.
- `src/routes/leaveTypes.ts` - `writeSchema` gains a `restrictions` zod object (nullable,
  `.strict()` per group) mirroring the domain type.
- `openapi.yaml` - `restrictions` on the `leave-type` schema (around line 1112),
  `policy_warnings` on `leave-request`, and the `leave_restrictions` settings key documented;
  then `npm run api:types` to regenerate `src/http/openapi.d.ts` (where `web/src/types.ts` gets
  `LeaveType`).

### 4. Web

- `web/src/pages/LeaveTypes.tsx` - a Restrictions section in the existing `WriteDialog`, one
  collapsible panel per group above (Eligibility · Request · Timing · Quota · Combinations ·
  Counting · Exit · Accrual). Every control has an explicit **Inherit (org: …)** state against an
  override, so what a type actually changes is visible at a glance, and `policySummary` is
  extended through `describeRestrictions`.
- `web/src/pages/Settings.tsx` - the org baseline as further tabs in `LeaveCapsTab` (line 3401),
  written through the existing `useSettingsBatch`; keywords updated in
  `web/src/settings/registry.ts:62`.
- `web/src/lib/leaveDays.ts` - pass `sandwich` through.
- `web/src/components/common/RequestLeaveDialog.tsx` - fetch the org baseline the way it already
  fetches `attendance` and `leave-requests` (line 108), merge with the selected type's
  `restrictions`, then: charge the day count with the sandwich rule; run `checkLeaveRestrictions`
  locally as a live preview that blocks `canSubmit` on hard violations and shows soft ones as
  "this will need your manager's discretion"; disable outright-barred types in the picker beside
  the existing probation case (line 455); surface the required notice, the blackout and the
  document requirement as hints on the fields that decide them. The server stays authoritative -
  the client only avoids a round trip that would be refused.
- `web/src/pages/Approvals.tsx` - render `policy_warnings` on the leave card, so an approver sees
  exactly which rule was waived before deciding.

### 5. Tests

- New `test/leaveRestrictions.test.ts` - the pure evaluator, a case per rule, plus merge semantics
  (inherit / override / explicit-null), the notice tier lookup, and `soft_rules` turning a block
  into a warning.
- Extend `test/leave.test.ts` - `leaveDays` sandwich cases (weekends vs holidays, intervening vs
  flanking, half-day holiday interaction), `daysByMonth`, and `computeAccrual` joining-rule cases
  on both frequencies.
- Extend the D1-backed harness in `test/leaveOrgDayAndOverlap.test.ts` (same `makeDeps` +
  migration bootstrap) or a sibling `test/leaveRestrictionsRoute.test.ts`, for the end-to-end
  refusals: notice, month cap, gap, combination, notice-period block, joining month, lifetime cap,
  a soft rule recording a warning, and the **no-rules-configured path issuing no extra query**.
- `e2e/leaveTypePolicySummary.spec.ts` asserts the summary text and needs updating once
  `describeRestrictions` extends it.

## Assumption to flag

"The minimum time period" reads two ways, so both knobs exist and are independent:
`request.min_days` (a request of this type must be at least N days) and
`eligibility.min_tenure_days` (the type can't be requested until N days of service). Drop either
if only one was meant.

## Verification

```bash
./node_modules/.bin/tsc -p tsconfig.json && echo OK   # tsc output is filtered; check the exit code
npm run api:lint                                       # spectral over openapi.yaml
npm run test -- leave                                  # unit + service-level leave tests
npm run lint
```

Then end to end on the local stack (via localhost:4010):

1. `PATCH settings/leave_restrictions` with
   `{"timing":{"advance_notice":{"tiers":[{"up_to_days":1,"notice_days":2}]}}}`, then
   `POST /v1/leave-requests` for tomorrow → 400 naming the notice requirement; three days out →
   created.
2. `PATCH leave-types/<privilege>` with `{"timing":{"advance_notice":null}}` → the same next-day
   request now succeeds (a per-type null overrides the org baseline).
3. Add `soft_rules: ["advance_notice"]` → the next-day request is created and comes back with
   `policy_warnings`, and the Approvals card shows it.
4. `{"counting":{"sandwich":{"weekends":"intervening"}}}` and file Fri→Mon → `days: 4`.
5. Open a serving `notice_periods` row and set `{"exit":{"during_notice":"blocked"}}` → a request
   inside the notice window is refused.
6. `{"accrual":{"joining_rule":{"cutoff_day":15,"if_after":"none"}}}` with an employee who started
   on the 20th → the accrual run credits 0 for the joining month, and a request starting in that
   month is refused.
7. SPA: Leave Types → edit a type → each panel shows inherit vs override and the summary sentence
   updates; Request leave → the notice hint, blackout note and blocking message all appear before
   submit.

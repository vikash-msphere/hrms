# Opening balances: bringing pre-HRMS history into a live HRMS

Status: Phase 1 (records start date, loss of pay and absence) DONE: column + migration 0004, `employees:setTrackedFrom`,
the LOP/analytics cutoff, the grid, the profile field, and the Opening balances page with its "When HRMS records start"
section. Phase 2 (leave) DONE: accrual floor + `creditedBeforeFloor`, `leave-adjustments` (migration 0005, ledger,
corrections, `:importOpenings`), encashment cap, the balance history sheet, the Adjust dialog and the page's leave
section. Phase 3 (pay and tax) DONE: `payroll-openings` (migration 0006, one live row per person per FY,
`:importOpenings`), folded into `finalizedTotals` (TDS, PT cap, settlement, Tax page, Form 16), ESI stickiness in the
build and the settlement, a staleness source, and the page's pay section. Phase 4 (leave history) DONE:
`leave_requests.source` (migration 0007), `leave-requests:importHistory`, the no-refund HR-only cancel, the "Before HRMS"
badge and the page's history section. Phase 5: `e2e/openingBalances.spec.ts`. Follow-up pass DONE: backdated-raise arrears count the months a payroll
opening covers (services/compensation.ts `beforeHrmsMonthsPaid`); the history import also takes BOOKED leave (from
the records start on: approved, debits the balance once; a row across the day is refused); runbook covers unpaid
days before go-live (imported as Loss of Pay), last year's Form 16 and optional holidays. Phase 6: `docs/opening-balances.md` (there
is no `money-audit.md` any more, so that half of step 6 has nothing to update).

## Context

HRMS went live on 2026-09-24 with employees who joined years earlier. Every part of the app that works things
out from "history since the start date" is wrong for them, because that history happened outside HRMS:

- **Leave balances are inflated.** With no balance row yet, the nightly accrual (`src/services/leaveAccrual.ts`
  -> `computeAccrual` in `src/domain/leave.ts`) walks from `start_date`. So the first night credited every
  month since the start date in one go, with no year-end caps and nothing deducted for leave used before HRMS.
  Balances are read-only over the API (`src/services/leaveBalances.ts`), so there is no way to correct them. The
  1 January rollover (`cron.ts` `carryForwardLeave`) may then auto-encash the excess as cash.
- **Leave already taken this year is missing.** Quota, lifetime, gap and probation-cap rules
  (`src/domain/leaveRestrictions.ts`, enforced in `createLeaveRequest`) count `leave_requests` rows, so leave
  taken before HRMS doesn't count against them.
- **TDS will be wrong on the first HRMS payroll.** `finalizedTotals` (`src/services/taxProjection.ts`) only sees
  runs made in HRMS, so it misses the April-August pay and TDS. Depending on the compensation row's effective
  date, the whole year's tax is spread over the remaining months (TDS roughly doubles), or those months' income
  is left out. The PT annual cap (the most professional tax a state allows per year) and the ESI rule (once in,
  an employee stays in until the half-year ends) read the same totals. So does Form 16.
- **Loss of pay docks the days before go-live.** `periodLop` (`src/domain/punctuality.ts`, the one function
  behind the payroll build, the payslip strip, restating a closed period and the final settlement) counts every
  working day with no punches after the start date, while the attendance screens show those days as
  "Before HRMS". The "days absent" figure in people analytics has the same problem.

Outcome: one explicit "HRMS records start" date per employee. The attendance, loss-of-pay and accrual logic all
respect it. Pre-HRMS facts (leave balances, leave taken, pay and tax so far this year) are entered through an
**Opening balances** admin page, with preview then apply.

**Why it is built in the app rather than as a one-off script:** the database is live, and writes have to go
through the services. The services allocate each row's access-scoping code, audit the change, and guard money
fields against concurrent writes. A script would still need the same engine changes and new places to store
the data, so the UI is the only extra work. With it, HR can review and fix the data themselves.

It also stays useful after go-live:
- a correct way to adjust leave balances,
- opening figures for anyone added later who has pre-HRMS history (an acquisition, a rehire, someone missed at
  import).

## The model

- **`employees.tracked_from`** (date, nullable): the first day HRMS holds records for the person. Empty means
  records start on their start date, which is correct for everyone hired after go-live. It is set in bulk once
  and editable per person. Changing it is refused once leave openings are applied (they were computed against it).
- **Accrual periods that start before `tracked_from` belong to the opening balance.** For go-live on
  24 September, September itself is pre-HRMS, so the opening includes September's credit. HRMS accrues from
  October onward.
- **`leave-adjustments`** is a ledger of balance changes, each row a signed number of days.
  - `kind: opening` rows come from the import. Each stores:
    - the figure HR entered,
    - the days HRMS had credited for pre-HRMS periods (removed by this row),
    - optional days already encashed this year.

    Re-importing stores only the difference from the last opening, so applying the same file twice changes
    nothing.
  - `kind: correction` rows are a plain adjustment with a reason.

  Rows are never edited.
- **`payroll-openings`** holds one row per employee per financial year: paid through (month), gross, taxable,
  TDS, PT, and whether they were contributing to ESI.
- **`leave_requests.source`** is `app` (the default) or `import`. Imported rows are APPROVED history: they don't
  touch the balance, send no notifications or events, and count toward policy rules.

## Changes

### 1. Records start date, and loss of pay / absence respecting it
- New migration (generated with drizzle-kit) adding `employees.tracked_from`.
- `tracked_from` on `toEmployeeResource` (`src/http/serialize.ts`) and in PATCH in `updateEmployee`
  (`src/services/employees.ts`). The change is refused with 409 when opening adjustments exist for the employee.
  `openapi.yaml`, then `npm run api:types`.
- Collection verb `employees:setTrackedFrom {date, dry_run}`. It sets `max(date, that employee's creation day in
  the org timezone)` for everyone with `start_date < date` and no date yet. It is idempotent, and one read plus
  batched writes, which fits D1's per-request limits. Six-registry custom-method checklist: route,
  `accessHint.ts`, web `customMethods.ts`, `authz.ts` verb lists, openapi, and `grants.ts` plus the regenerated
  `scripts/seed.sql` and `bootstrap/bootstrap.sql`.
- `lopDayUnits` (`src/domain/attendance.ts`) takes `trackedFromYmd`. A working day before it owes nothing unless
  it has punches, event credit, an HR mark, or any approved leave. Unpaid leave still docks; paid leave still
  excuses. `periodLop` and `owedDays` in `src/domain/punctuality.ts` pass it through.
- Callers pass the employee's `tracked_from`:
  - `src/services/payroll.ts`: the build, the payslip attendance strip, `recomputeLopUnits`.
  - `src/services/settlements.ts`: `finalMonthLopDays`.
- `src/services/peopleAnalytics.ts` "days absent": the later of start date and `tracked_from` as the joined date
  to `expectedWorkingDays`.
- Web: `trackedFromOf` (`web/src/lib/attendance.ts`) reads `e.tracked_from`. That flows to the Attendance page,
  `AttendanceHistory`, `TeamTimeline` and `EmployeeProfile`.
  - The `untracked` branch in `buildAttendanceRows` matches the server: it applies only when no leave touches
    the day, whether paid or unpaid (`leaveHalves` from domain/punctuality).
  - `Directory.tsx`: an "HRMS records start" field on the employee edit form.
  - `EmployeeProfile.tsx`: the date under employment details.

### 2. Leave: accrual start and opening balances
- `computeAccrual` gets `floorMs`. Periods starting before it are never priced, in either the forward walk or
  `windowCorrection`, in the monthly and semi-monthly versions. So setting the date never claws anything back,
  and a later start-date fix never re-credits pre-HRMS months.
- A pure helper, `creditedBeforeFloor(inputs)`, works out what a balance row holds for pre-HRMS periods. It uses
  the row's recorded window (`accrualPricedStart/End`) and the same period helpers as the accrual itself.
- `leaveAccrual.ts` selects `trackedFrom` and passes it. `web/src/lib/leaveForecast.ts` does the same.
- Collection `leave-adjustments`: table, factory spec, serializer, and the add-collection registries.
  - Registries: `authzResolve` TABLES, `encodeWireIds` ENCODABLE, `domain/collections`, OWNER_REFS pointing at
    employees, a `purgeCascade` entry on the employees spec, openapi, activity labels, and the change-stamp
    triggers that `scripts/genChangeDdl.ts` prints.
  - Private by default. Standard methods are list, get and create (corrections only).
  - The write, for opening and correction alike:
    - The ledger row is inserted first and acts as a lock. For openings, a unique index on
      (employee, type, previous opening) makes a racing duplicate fail and roll back its batch.
    - The balance then moves by the difference, in SQL, which is safe alongside the nightly accrual and
      reserve/release. This is the rule in "A checked batch is not an atomic one" in
      `docs/architecture-decisions.md`.
    - A result that would go below zero is refused per row. The nightly run would silently round it up to zero.
    - A missing balance row is created with batch code allocation (`allocOwnedCodeRuns`).
- Verb `leave-adjustments:importOpenings {rows, dry_run}`. The server computes each preview row: current
  balance, credited for before the start date, change since go-live, opening, and result. It then applies in
  one pass (bulk reads, batched writes, client sends chunks of about 100 rows). Afterwards each affected
  employee gets one summary notification. Blank = keep what HRMS has.
- `encashedDaysThisYear` and `encashedDaysThisYearAll` (`src/services/leaveEncashments.ts`) add the latest
  opening's encashed days for that leave year.
- Web `Leaves.tsx`:
  - The balance history sheet adds adjustment rows when the caller can read them. Otherwise it says the change
    sits inside the opening figure, the way it does for encashments.
  - The sheet leaves out `source: import` requests and accrual before the records start date.
  - The approver balances table gets an "Adjust" action (signed days and a required reason, in AccessAction).

### 3. Pay and tax so far this year
- Collection `payroll-openings` with the same registries. Unique (employee, financial year). Validation:
  "paid through" must fall inside the financial year and before any finalized HRMS run for that employee in
  that year, and amounts must not be negative. Verb `payroll-openings:import {rows, dry_run}`.
- `finalizedTotals` (`taxProjection.ts`) merges openings for the year into gross, taxable gross, tax, PT and
  months, and adds the covered months to both month sets.
  - That one change reaches the payroll build's TDS and PT cap, the Tax page projection, the settlement's TDS
    and PT, and Form 16.
  - `unpaidEarningMonths` and `collectibleMonths` then skip the covered months without further changes.
- ESI rule:
  - Payroll build: its set of employees already contributing this half-year adds openings flagged ESI whose
    "paid through" month falls in the current half-year.
  - Settlement: `esiContributingAtExit` does the same.
- `payroll_openings` joins the tables `runStaleness` watches, so a built draft run shows "Rebuild".
- Tax page (`EmployeeTaxDetails.tsx`): a line saying the total includes ₹X paid and ₹Y TDS before HRMS.
  Form 16 labels the same amount.

### 4. Leave history (consumption)
- Migration adding `leave_requests.source`.
- Verb `leave-requests:import {rows, dry_run}` (employee, type, start, end, optional half-day sessions, days,
  reason). Validation:
  - the leave must end before the employee's `tracked_from` and start on or after their start date,
  - no overlap with live requests or within the file,
  - `days` comes from the file when given, otherwise from `leaveDays` (the file wins, because holidays before
    go-live may not be entered in HRMS).

  Rows are inserted APPROVED with `source: import`: no balance change, no notify or event, one summary audit
  entry.
- `decide()` in `leaveRequests.ts`: HR may cancel an imported row with no refund and no notification. Imported
  rows can't be edited. Web: a "Before HRMS" badge on history rows, and no cancel for the employee.

### 5. The Opening balances panel
- Settings panel `opening-balances` (`web/src/settings/registry.ts`, Company group, `/settings/opening-balances`),
  shown when the user can use any of the verbs above. Sections:
  - **Records start**: the date is pre-filled with the org-local day of the earliest employee record. The page
    previews who gets which date, then applies.
  - **Leave balances**: download a template (one row per employee, a column per leave type), paste or upload,
    see the server preview, apply.
  - **Leave history**.
  - **Pay and tax so far**.
  - **Also bring over**: links to Loans (create, approve, disburse, record the repayment made so far),
    compensation (effective from before the first HRMS payroll month), prior-employer income on the Tax page,
    documents and assets.
- Parsing lives in pure `web/src/lib/openingImport.ts`, following `holidayBulk.ts` and `assetBulk.ts`: nothing
  is written until the preview looks right. Every action goes through AccessAction and `confirmDecision`.

### 6. Docs
- `docs/opening-balances.md` runbook: what to export from the old system (closing leave balances on the day
  before go-live, April to last-paid-month pay and TDS per employee), the order of steps, spot checks, and the
  ACL grant so employees can read their own `leave-adjustments`.
- `money-audit.md`: the pre-HRMS figures in the TDS, PT and ESI calculations.

## Order
1 -> 2 -> 3 -> 4; each lands green on its own, and the page gains its section with each. If the first HRMS
payroll is due before step 3 lands, build it but keep it in draft. It can be rebuilt once the openings are in,
and the staleness banner will ask for that.

## Verification
- Unit tests:
  - `test/attendanceLop.test.ts`: the cutoff, including unpaid leave, marks and punches before it.
  - `test/attendanceGrid.test.ts`: the `tracked_from` field, and leave touching a day.
  - Leave accrual tests: the cutoff in both versions, no clawback when it's set, a start-date fix not
    re-crediting pre-HRMS months, and `creditedBeforeFloor`.
  - `test/taxProjection.test.ts`: openings folded in, covered months skipped, the PT cap.
  - `test/openingImport.test.ts`: the parser.
- Service tests:
  - `test/openingBalances.test.ts`: `setTrackedFrom`; opening import with preview matching apply; in-HRMS usage
    kept; re-import applies only the difference; negative refused; one notification; two imports racing
    through `Promise.allSettled` apply once.
  - `test/payrollOpenings.test.ts`: overlap with a finalized run refused, staleness, ESI, Form 16 totals.
  - `test/leaveHistoryImport.test.ts`: no balance change and no notify; overlap refused; cancel has no refund;
    quotas count it.
- Existing payroll and accrual suites stay unchanged, since `tracked_from` is null there. Full vitest suite
  with the sandbox bypass, plus `./node_modules/.bin/tsc --noEmit` for root and web.
- E2E: `e2e/openingBalances.spec.ts` (set the date, paste balances, apply, then check the balance and its
  history entry on My Leave) plus `e2e/attendanceViews.spec.ts`. Only these specs, via `npm run test:e2e -- <spec>`.
- Manual run through the Prism proxy on :4010: build a September run with loss of pay on and a payroll opening
  entered, then check the payslip strip, the TDS and the Tax page.

## Assumptions
- Go-live date 2026-09-24 for everyone. Anyone whose record was created later gets their own creation day.
- The old system can give, per employee: closing leave balance per type on 23 September, and April-August gross,
  taxable pay, TDS and PT.
- Leave history import is optional: the current calendar year, plus lifetime-limited types (e.g. maternity).
- Opening balances are applied by a super admin. Other roles get access through the ACL screen, not code.

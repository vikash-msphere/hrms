# Table enrichment plan

Every DataTable in the app, page by page, with what it could say that it does not say yet.

The rule this plan is written against, from [docs/07-table-interactions.md](docs/07-table-interactions.md):
a table earns an enrichment when it answers a question somebody actually asks of those rows and can act on.
A chip nobody would click is a fact, and facts belong in a column. A column nobody sorts or filters by is
decoration. Everything below is either an ACTION (something is wrong, go fix it) or a MEASURE somebody
compares across (per group, per person, per period).

Scope: the 38 `<DataTable>` sites. Section 4 covers the list pages that are not on DataTable at all.

---

## 1. What a table can already do

Cite these by name rather than re-describing them per page.

| Knob | What it gives |
|---|---|
| `filter: "number"` | `>`, `between`, `=0`, plus the column's own min / median / max / total in the panel |
| `filter: "date"` + `dateHint` | calendar windows against the ORG's today |
| `filter: "select"` | distinct values with row counts, `(Blank)`, alt-click to exclude |
| `groupBy: true` | folds with per-group counts and per-group subtotals, and now Collapse all / Expand all |
| `aggregate: "sum"` + `formatTotal` | footer total over every filtered row, and the selection total |
| `insights` | chips that count something actionable and carry the filter that isolates it |
| `defaultHidden` | ships a column off, still one click away and still in the export |
| `defaultFilter` / `hideValueByDefault` | opens the table on the rows that matter |
| `filterOptions` + `onFilterChange` | offer a value whose rows are fetched on demand |
| `bulkActions` | multi-select, range select, per-selection totals |
| `getSubRows` | one level of nesting under a row |
| saved views + prefs | sort, filters, search, columns, grouping, and now shape |
| `useKpiFocus` | tiles that drill into the table's own filter state |

The gap in almost every case below is not a missing feature. It is a DERIVED COLUMN that does not exist, so
the question cannot be asked at all.

---

## 2. Shared primitives worth building first

Each is cheap, and each unlocks several pages. Ordered by how many pages want it.

**P1. `aggregate: "avg" | "min" | "max" | "count"`.** Today the footer can only sum. "What is the average age
of an open ticket", "what does a background check take", "what is the median expense" are asked constantly
and cannot be answered. Wanted by: Tickets, BackgroundChecks, Expenses, Leaves, Overtime, Stocktakes, Boards.

**P2. `bar?: (row) => number` (0..1) on a column.** Renders a proportion behind the cell, so a ratio reads at
a glance down a column instead of one row at a time. ExpenseBudgets already hand-rolls exactly this for
utilization; generalize it from there. Wanted by: ExpenseBudgets, Stocktakes, Documents (ack progress),
Leaves balances (% used), Boards (checklist), NoticePeriods (offboarding progress), Events (RSVP rate).

**P3. `lib/tableSignals.ts`: `duplicates(rows, keyOf)` and `outliers(rows, valueOf)`.** Two insight builders,
written once. Duplicates catch double-entry (same payee + amount + day, same serial, same invoice number);
outliers catch the row that is unlike its own population (an expense 5x the category median, a check open
three times as long as that vendor's usual). Wanted by: Expenses, Reimbursements, Assets, Payslips,
BackgroundChecks, Vendors.

**P4. Derived `month` / `weekday` select columns.** Date columns are deliberately not groupable (they fold
into one-row heaps), so "how much per month" is currently unanswerable on a table that has the dates. A
small helper that projects a date column onto a groupable, sortable period label closes that. Wanted by:
Overtime, RemoteWork, Leaves, Expenses, Payslips, Holidays, Events.

**P5. "Days since / days until" helper for date columns.** Half the pages below want a number beside a date
so the reader can say `>90`. Assets has `last_verified` but no `days since sighting`; Documents has an expiry
date but no `days to expiry`. One helper, applied as a `defaultHidden` companion column.

**P6. `Column.actions?: (row) => MenuItem[]`.** The cell menu is derived from the column's kind today. Let a
page add its own items so a row can jump to the same person's other records ("their leave", "their assets",
"their tickets"). Turns 38 tables into one connected set rather than 38 lists.

**P7. Scope chips from the caller's identity.** "Mine", "My team", "My department" as a first-class seed of
the table's own filters, off `access.subject` and the manager chain. Several pages hand-roll a tab bar for
exactly this (Tickets, Expenses, Leaves), and every other page has no way to ask it.

**P8. Group header percentage.** A group's subtotal already renders; add its share of the filtered total
("Travel  ₹4.2L  31%"). Free once grouping is on, and it is the whole question on Expenses and Payslips.

**P9. Cross-collection counts without a new fetch per page.** Most "N with no X" insights below need one
adjacent collection (leavers and their assets, categories and their spend, roles and their users). Some
pages already load both. A shared pattern for "count rows of B per row of A, from what is loaded, and say
`of loaded` when the set is a window" keeps these honest against page truncation.

**P10. Column kind metadata on TableBuilder-built tables.** `TableBuilder` already maps `kind === "money"` to
`aggregate: "sum"`. Extend it: `date` gets `filter: "date"` and a `dateHint`, low-cardinality enum gets
`filter: "select"` and `groupBy: true`, counts get `filter: "number"`. One change enriches every custom table
anyone builds, forever.

---

## 3. Page by page

Each entry lists the table's id, what it already carries, then what to add. "(server)" marks work that needs
a field or an aggregate the API does not return today.

### People

**Directory - `employees`**
Has: title / department / manager as select + group, start and probation dates, insights for probation in 30
days, joined in last 30, no manager. KPI tiles with drill-through.
Add:
- `tenure` (months since start date), `filter: "number"`, `formatTotal: yrs`. Unlocks "over 5 years", sorting
  by service, and grouping-free seniority questions.
- Insight: work anniversaries this month, filtered by a derived `anniversary_month`. The one HR chip that
  produces an action rather than a report.
- Insight: `employee_number` blank. A person with no employee ID blocks letters and payroll; today nothing
  surfaces it.
- Insight: department blank. It breaks org chart rollups and department-scoped authz.
- `reports` (direct reports, counted from the loaded set) as a number column, so "managers with 8 or more
  reports" and "managers with one report" are both one filter. Pair with P9's "of loaded" honesty.
- Profile completeness as a `bar` column (P2), reusing the chips already on the profile page.
- `Column.actions` (P6): their leave, their assets, their tickets, their documents.

**Departments - `departments`**
Has: parent as select + group, `managers` as a count (so `=0` finds unmanaged departments).
Add:
- `headcount` (direct) and `headcount_rollup` (subtree), `aggregate: "sum"`. The org chart computes rollups
  already; the table cannot ask "which departments are under three people".
- Insight: departments with no members. Usually a leftover from a reorg.
- `defaultGroupBy: "parent"` so the table opens as the shape of the org.
- Open tickets / open requisitions per department as counts (server or P9), which turns this catalogue into
  the operational view managers actually want.

**Delegations - `delegations`**
Has: delegate as select + group, period as a date, reason.
Add:
- `status` derived (Upcoming / Active now / Expired) as select + group, with `defaultFilter: "Active now"`.
  A delegation list that opens on expired rows is answering last quarter's question.
- `days` (length of the delegation) as a number: "who has handed off for more than a month".
- Insight: expiring in the next 7 days, sorted by end date. Approvals silently fall back when one lapses.
- Insight: two active delegations covering the same approver (P3 duplicates) - a real routing bug.

**NoticePeriods - `notice-periods`**
Has: remaining days, last working day, status, type, insights for leaving within two weeks and past LWD.
Add:
- Offboarding progress as a `bar` (P2) from the transition tasks that already exist.
- `assets_out` count: assets still assigned to a leaver. Insight: "N leaving with kit still out, sorted by
  last working day". This is the single highest-value cross-collection chip in the app.
- `department` column (select + group), so a manager can see their own leavers.
- Insight: serving with no handover owner recorded.

**Documents - `documents`**
Has: type / owner / content type groups, expiry buckets, acknowledgement state, five insight chips
(expired, expiring in 30, awaiting signature, not acknowledged, no file).
Add:
- `days_to_expiry` (P5) as a number, so "expiring inside 90 days" is possible without a new bucket each time.
- `size_bytes` as a number with `aggregate: "sum"` and a bytes `formatTotal`. "What is this costing us in
  storage" and "which record is a 40MB scan" both fall out.
- Acknowledgement progress as a `bar` (P2): acknowledged / audience, on documents that require it.
- Insight: requires acknowledgement, published over 14 days ago, under half acknowledged. Chasing is the job;
  the current chip only says some are outstanding.
- Insight: locked but unpublished, and published but unlocked - the two states that are usually mistakes.

**BackgroundChecks - `background-checks`**
Has: `open_days`, vendor / type / status groups, insights for open over two weeks and adverse results.
Add:
- Average `open_days` per vendor via P1 plus the existing vendor grouping. Choosing a vendor is the decision
  this table informs and it cannot currently be made from it.
- Insight: open far longer than that vendor's own median (P3 outliers), which is the actionable half of the
  same fact.
- `cost` per check (server) with `aggregate: "sum"`, grouped by vendor.
- Insight: candidate started before the check cleared - a compliance question, joinable to start dates.

### Time and attendance

**Leaves - requests table**
Has: type / state / employee groups, days with `aggregate: "sum"`, start and end dates.
Add:
- `waiting` (days since submission, pending rows only), exactly as Expenses does. Insight: "N pending over 3
  days", sorted worst first. Approval latency is invisible today.
- `notice` (days between submission and start date). Insight: booked with under 2 days' notice.
- `clash` count: approved leave overlapping the same team over the same dates. Insight: "N overlap a
  teammate". Approvers ask this every single time and currently open the calendar to answer it.
- Derived `month` (P4) as a groupable column, so "how many days in March" is one fold.
- `working_days` beside `days`, honouring holidays and the working-day calendar, since the two differ and
  only one of them is payroll-relevant.

**Leaves - team balances table `lv-team-balances`**
Has: left / used / pending / entitled / surplus, insights for "taken none this year" and "carrying over a
year's accrual".
Add:
- `% used` as a `bar` (P2). A balance table without a proportion makes every reader do division.
- Insight: will lose days at year end (surplus above carry-forward cap, nothing booked). The current "banked"
  chip says they have a surplus; this one says it is about to expire.
- `department` group, so this reads per team rather than per person.
- `forecast_balance` at year end (accrual to date + remaining accrual - booked), as a number.

**LeaveTypes - `leave-types`**
Has: accrual per year as a number, paid / probation / encashable / carry-forward flags.
Add:
- `in_use` count (requests this year). Insight: types nobody has used in a year - catalogue rot is the whole
  problem with this page.
- Group by paid / unpaid.

**LeaveEncashments - encashments table**
Has: days and amount with sums, leave type and state groups.
Add:
- `% of entitlement` encashed, as a number: the policy question is whether somebody is cashing out too much.
- Insight: above the type's encashment cap (policy is per leave type).
- Group by derived `month` (P4) for the payroll cut-off view.

**Overtime - overtime table**
Has: duration with sum, state group, date.
Add:
- Derived `month` (P4) plus P1's average: "who is over 20 hours this month" needs both.
- `cost` (minutes x rate) as money with `aggregate: "sum"` (server, needs pay data). Overtime is a budget
  line and this table cannot price itself.
- Insight: pending over 3 days (same `waiting` pattern as everywhere else).
- Insight: repeated weekend work by the same person - a wellbeing signal and a rota problem.

**RemoteWork - remote work table**
Has: days with sum, location and state groups.
Add:
- Derived `month` (P4), and insight: over the monthly remote allowance.
- `team_out` count: how many of the same team are remote on the same dates. Coverage is the actual question.
- Insight: pending over 3 days.

**Holidays - `holidays`**
Has: date, type, applies-to, "when".
Add:
- Derived `weekday` as a select + group. Insight: "N fall on a weekend this year" - each one is a holiday
  the staff never get, and the fix is a decision somebody has to make.
- `days_until` (P5) as a number for the upcoming view.
- Group by region, with a coverage insight: regions with noticeably fewer holidays than the rest.
- Insight: no holidays recorded for next year once the current year is more than three quarters gone.

**Events - `events`**
Has: attendees and RSVP counts as numbers, counts-as-work group, start time.
Add:
- RSVP rate as a `bar` (P2) - going / invited.
- Insight: in the next 7 days with under half confirmed. Catering and rooms depend on it.
- Insight: no RSVPs at all on an event inside a week.
- `duration` as a number, and derived `month` (P4).

### Money

**Payslips - `payslips`**
Has: gross / deductions / TDS / net all summed with money formatting, pay run group, issue date.
Add:
- `take_home_pct` (net / gross) as a number. Insight: below 50% - almost always a deduction set up wrong.
- `delta_net` against the same employee's previous payslip (needs two periods loaded, or server). Insight:
  net moved more than 20% - the one check that catches a payroll error before the money leaves. Highest value
  item in this section.
- `department` group, which is how payroll cost is actually discussed.
- P8 group percentages, so a fold reads "Engineering ₹42L, 38%".

**PayrollRuns - `payroll-runs`**
Has: period / state / submitted-by / approved-by groups.
Add:
- `headcount`, `gross`, `net` on the row with money `formatTotal` and sums. A run list that does not show the
  size of each run makes you open every one.
- `stale` as a select column (the staleness flag already exists in the model), with an insight: "N editable
  runs are stale" - inputs changed after the build.
- `days_to_pay_date` (P5), for the run that has not been approved with pay date approaching.

**PayPeriods - `pay-periods`**
Has: start, end, pay date.
Add:
- `status` derived (Open / Run built / Paid) as select + group.
- `runs` count. Insight: periods with no run - the quiet way payroll gets missed.
- Insight: pay date falls on a weekend or a holiday. Banking does not process it, and this is exactly the
  table where that should be caught.

**PayComponents - `pay-components`**
Has: kind / method / recurring groups, amount.
Add:
- `in_ctc` as a select + group (the field exists per component).
- `used_by` count across salary structures and employees. Insight: components nothing references - the
  catalogue everybody is afraid to prune.

**PayGradesAdmin - `pay-grades`**
Has: level, band.
Add:
- `employees` count per grade, and `median_actual` against the band midpoint as a compa-ratio number.
  Insight: grades whose median sits outside their own band - the review that pay grades exist for.
- Insight: bands that overlap the next grade by more than half their width.

**SalaryStructuresAdmin - `salary-structures`**
Has: name, earning components.
Add:
- `employees_on_it` count. Insight: structures nobody is on.
- `total_pct` validity column. Insight: structures that do not total 100% - today this is only discovered at
  run time.

**Reimbursements - reimbursement tables**
Has: amount summed, category / state / employee groups, receipt attached, incurred date.
Add:
- `waiting` days and the "over a week" insight, matching Expenses. Same queue, same question, different page.
- Insight: probable duplicates (P3) - same person, same amount, same day. The classic double-claim.
- Insight: over the category's cap (policy lives on the category).
- `days_to_reimburse` for paid rows, with P1's average: "how long do we take to pay people back" is a
  satisfaction metric nobody can currently produce.

**Expenses - ledger table**
Has: amount summed, waiting days, invoice attached, category / GL / cost centre / state groups, insights for
waiting over a week, no invoice, incurred over 90 days ago.
Add:
- Insight: duplicate invoice numbers per vendor, and same payee + amount + day (P3).
- `budget_remaining` for the budget this expense lands in, plus an insight for claims that would take a
  budget over. The budgets page knows this; the ledger, where the decision is made, does not.
- `first_time_vendor` flag on the row. New payee plus large amount is the pair worth a second look.
- P8 group percentages on category and cost centre.
- P1 average days to pay, per cost centre.

**Expenses - recurring table**
Has: amount summed, rule, next occurrence, last generated, cost centre and state groups.
Add:
- Insight: next occurrence is in the past - the schedule has stopped generating and nobody notices until the
  vendor chases.
- `annualised` (amount x occurrences per year) with `aggregate: "sum"`. "What do our subscriptions cost a
  year" is the only question this table exists to answer and it cannot answer it.
- Insight: last generated is older than the rule implies.

**ExpenseBudgets - `expense-budgets`**
Has: budget / spent / pending / remaining all summed, utilization, projected, health status, cost centre
group.
Add:
- Utilization as the shared `bar` (P2) rather than the local one, once P2 exists.
- `days_left` in the period and `burn_per_day`, giving `days_of_runway` as a number. Insight: will run out
  before the period ends.
- Insight: budgets with no spend at all past the halfway mark - usually a cost centre pointing at the wrong
  category.
- Spend sparkline per budget (server, needs history).

**ExpenseCategories / ReimbursementCategories - catalogues**
Has: name, GL code, receipt-required.
Add:
- `spend_ytd` (money, summed) and `claims` count per category. A category catalogue with no volume beside it
  cannot be pruned or re-mapped.
- Insight: categories with no spend this year.
- Insight: receipt not required on a category whose average claim is large - a control gap.

**Vendors - `vendors`**
Has: default category and terms as groups, tax ID, contact.
Add:
- `spend_ytd` with a sum, `last_invoice` date, `open_invoices` count.
- Insight: no spend in 12 months - the list to archive.
- Insight: missing tax ID, and missing payment terms. Both block clean payment runs.
- Insight: near-duplicate vendor names (P3), which is how the same supplier ends up paid twice.

### Assets and workplace

**Assets - `assets`**
Has: category / status / assignee / sighted-by groups, assigned, purchased, tag printed, last verified dates,
insights for never verified, unseen for 6 months, free in stock.
Add:
- `age_years` from purchase date, as a number. Insight: past the refresh age - this is how a hardware budget
  gets planned instead of guessed.
- `days_since_sighting` (P5), so the existing sighting chips become one filterable column.
- `book_value` (server) with a sum, so "what are we holding" has an answer.
- Insight: assigned to somebody serving notice (join to notice periods). Pairs with the NoticePeriods chip
  from the other direction.
- Insight: duplicate serial numbers (P3) - double-registered kit inflates every count on this page.

**AssetCategories - `asset-categories`**
Has: name, tag code, serial policy.
Add: `assets` count and average age per category; insight for categories with no assets.

**Stocktakes - `stocktakes`**
Has: sighted / scan-proved / missing / still-missing / flagged / unexpected, all numeric, most summed.
Add:
- `accuracy` as a `bar` (P2): sighted / expected. The headline number of a stocktake is currently arithmetic
  the reader has to do.
- `duration` (closed minus opened) as a number, and an insight for counts left open over a week.
- Trend against the previous count, computed from the rows already loaded and sorted by close date. "Accuracy
  down on last count" is the finding that makes anyone act.

**Tickets - tickets table**
Has: category / department / requester / assignee / priority / state groups, `age`, checklist count, insights
for unassigned, open over a week, urgent still open.
Add:
- `first_response` and `time_to_resolve` as numbers (server needs the timestamps). With P1's average this
  page becomes a service report instead of a queue.
- `sla_breach` derived from priority plus age, as a select. Insight per breach level.
- Insight: reopened tickets - the quality signal that a queue length hides.
- P8 group percentages on category, which is how ticket load gets argued about.

**Boards - `board-list`**
Has: status / assignee / reporter / priority groups, points summed, due date, blocked, labels.
Add:
- `days_in_column` as a number. Insight: sat in the same column over a week. Ageing WIP is the point of a
  board and the list view cannot see it.
- `cycle_time` on done cards, with P1's average per assignee or per label.
- Insight: unestimated cards (points blank) when the board uses points, since the CFD and every forecast
  quietly drop them.

### Governance, catalogues and settings

**Compliance - `compliance-events`**
Has: authority / frequency / status / owner groups, due date, insights for overdue, due this month, unowned.
Add:
- `days_late` as a number on overdue rows, so the worst is first and "over 30 days late" is one filter.
- `evidence` attached as a select. Insight: filed with no evidence - a filing that cannot be proved is not a
  filing.
- Insight: the same obligation late more than once in the last year (repeat offender), which is a process
  problem rather than a date problem.

**Compliance - `compliance-rules`**
Has: authority / schedule / owner / state groups.
Add:
- `next_due` derived from the rule, and `events_generated` count.
- Insight: active rules that have never generated an event - a misconfigured recurrence that looks healthy.

**GoalTemplates - `goal-templates`**
Has: set group, weight summed, due-in-days, suggested-for group.
Add:
- `used` count (goals created from the template). Insight: templates never used.
- Insight: sets whose weights do not total 100. The group subtotal already shows the number; the chip makes
  it an action.

**TableBuilder - `table-views` and built tables**
Has (views list): base group, column count, updated date.
Has (built tables): money columns get `aggregate: "sum"` and money formatting.
Add:
- P10 on built tables: date kinds get a date filter and a hint, enum kinds get select plus `groupBy`, counts
  get a number filter. One change, every custom table.
- Views list: `owner`, `last_opened`, and an insight for views nobody has opened in 90 days.

**ApiKeysPanel - `api-keys`**
Has: state, scope, expiry and last-used dates.
Add:
- `days_to_expiry` and `idle_days` (P5) as numbers.
- Insight: unused for 90 days - the revoke list.
- Insight: no expiry set at all. That is the policy question this table exists to answer.

**RolesPanel - `users`**
Has: role group, status, linked employee.
Add:
- Insight: users with no linked employee - they bypass every employee-scoped rule.
- Insight: disabled accounts that still hold a privileged role.
- `last_seen` (server) as a date, with an insight for dormant privileged accounts.

**RolesManagePanel - `roles`**
Has: users count.
Add: insight for roles with no users; a `collections_granted` count with an insight for roles that reach an
unusually large share of the app.

**PermissionsPanel - `user-perms-matrix`**
Has: a column per collection.
Add: a "differences only" toggle that hides columns where every visible row agrees, which is the only way a
wide matrix is readable; group by role; a legend chip row. This table is wide by nature, so the enrichment is
subtraction.

**FineRulesEditor - `fine-rules-*`**
Has: subject / collection / scope / permission / state groups.
Add:
- `expires_in` as a number. Insight: temporary rules expiring this week - they lapse silently and somebody
  loses access mid-task.
- Insight: rules awaiting approval, which already exists as a state but not as a chip.
- Insight: deny rules that no current grant could match (needs evaluation support) - dead policy that reads
  as protection.

---

## 4. List pages that are not on DataTable

These render their rows by hand or as cards, so none of the above is available to them. Listed with the one
enrichment that would justify the move.

| Page | Why it matters |
|---|---|
| Approvals | The queue everybody lives in. Wants `waiting` days, grouping by kind, and bulk decisions. |
| Attendance | Wants a number column per day worked and grouping by month; the grid cannot be filtered. |
| Timesheets | Wants summed hours per project with group subtotals - exactly what `aggregate` does. |
| Loans | Wants outstanding balance summed, and an insight for loans whose EMI exceeds a share of net pay. |
| TaxDeclarations | Wants verified / unverified counts and an insight for declared-but-unproved amounts. |
| Benefits | Wants enrollment counts per plan and an insight for employees with no plan. |
| Candidates / Interviews / Offers / Requisitions | Wants ageing (`days in stage`) and per-stage grouping. |
| Onboarding | Wants progress bars and an insight for tasks overdue before a start date. |
| Suggestions / Notifications / Activity | Wants date filters and grouping more than anything else. |
| Referrals / ProjectsAdmin / ShiftsAdmin | Deliberate card lists; they want the insight chips, not the grid. |

Moving all of these is not the proposal. Naming the affordance each one is missing is.

---

## 5. Sequencing

1. **P1, P2, P5** - average aggregates, proportion bars, days-since companions. They are small, and roughly
   half the per-page items above are blocked on one of them.
2. **The money pages**: Payslips net-change, Expenses duplicates and budget impact, Reimbursements waiting
   and duplicates. Highest cost of being wrong, and each one catches an error before money moves.
3. **The queue pages**: Leaves, Overtime, RemoteWork, Tickets - all want the same `waiting` column and the
   same "pending over 3 days" chip. One pattern, four pages, consistent wording.
4. **P3 and P4** - signals and period columns, once there are three or more callers for each.
5. **The catalogues** (leave types, pay components, categories, vendors, templates, roles): all want the same
   "used by" count and the same "nothing references this" chip. Do them in one pass so the wording matches.
6. **P6, P7, P10** - cross-page row actions, identity scope chips, and the built-table kind mapping. Each
   changes how the whole app reads rather than one page.

A per-page item is worth building when somebody can say out loud what they would do about the number. Where
this plan lists a chip nobody would act on, it is wrong and should be dropped rather than built.

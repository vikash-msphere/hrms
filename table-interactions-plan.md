# Table interactions plan

What the shared `DataTable` gains, and how each page states its own context.

The table already does layout (columns, order, widths, density), narrowing (text/select filters, server search,
saved views), selection (bulk actions), totals and export. What it cannot do is read a column for what it *is*:
an amount filters as a substring, a date filters as a substring, and a page that knows "these three rows have
been sitting unapproved for a fortnight" has nowhere to say so. Everything below is that gap.

## Shared mechanism

1. **Typed column filters.** `filter: "number" | "date"` alongside the existing `"text" | "select"`.
   Values stay strings (`">5000"`, `"1000..2000"`, `"last30"`, `"2026-01-01..2026-03-31"`), so URL deep links,
   saved views and the filter chips all keep working untouched. `lib/tableFilter.ts` owns the grammar.
2. **Distribution in the filter popover.** A number filter shows min / median / max / sum over the loaded rows
   and offers "above median" as one click. A select filter shows a count against each value, and a "(Blank)"
   option when some rows have none. Both answer "what is in this column" before you filter by it.
3. **Cell menu.** Right-click (or the ⌥-click/keyboard menu key) on any cell: filter to this value, exclude it,
   copy it, sort by the column, group by the column, hide the column. The items offered come from the column's
   own capabilities and the cell's value, so the menu on an amount is not the menu on a status.
4. **Group by.** Any column marked `groupBy` can group the table: collapsible group headers carrying the
   group's row count and its own subtotal for every `aggregate: "sum"` column. Persisted with the other table
   prefs and carried in the URL, so a grouped view is shareable and savable as a named view.
5. **Insights.** `insights={(rows) => TableInsight[]}` - a page states what is worth noticing about its own
   rows ("7 waiting more than 5 days", "₹1.2L unclaimed"), and each chip applies the filter that isolates the
   rows it counted. Page-supplied, so it is domain knowledge, not a generic count.
6. **Selection and keyboard.** Shift-click a checkbox for a range, `/` to reach the search box, `j`/`k` to walk
   rows, `x` to select the focused one - the shortcuts the help dialog already advertises.

## Per-page context

Each table declares what its columns mean and what is worth noticing. The conventions, the filter grammar
and the rules an insight chip has to keep are in [docs/07-table-interactions.md](docs/07-table-interactions.md).

## Status

Shared mechanism: DONE - `lib/tableFilter.ts` (grammar + tests in `test/tableFilter.test.ts`),
`components/common/tableFilterPanels.tsx` (the three panels), `components/common/TableInsights.tsx`, and the
grouping, cell menu, shift-select and keyboard work inside `DataTable.tsx`.

Wired, with insight chips: Expenses (review and pay queues), Leaves (team balances), Assets, Tickets,
Compliance, Documents, Background checks, Notice periods, Directory, Boards (list view).

Wired, typed columns and grouping only: Reimbursements, Overtime, Remote work, Leave encashments, Payslips,
Payroll runs, Pay periods, Pay components, Pay grades, Leave types, Goal templates, Holidays, Events,
Delegations, Departments, Vendors, Stocktakes, Expense budgets, Table builder (from the field KIND, so a
user-built grid types itself), API keys, Roles, Access rules. `metaColumns()` and `stateColumn()` carry
their own typing, so Created / Updated / State are typed on every table in the app.

Not wired, deliberately: the small catalogues (asset / expense / reimbursement categories, salary
structures) have nothing but a name and a state, which `stateColumn()` already covers.

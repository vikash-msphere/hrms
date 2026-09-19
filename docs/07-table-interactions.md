# Tables: filters, grouping, the cell menu and insights

Every list in the app is one component, `web/src/components/common/DataTable.tsx`. This page is about the
half of it a PAGE has to declare: what its columns mean, and what is worth noticing about its rows. The
layout half - column order, widths, density, saved views, export, bulk actions, the phone card layout - needs
nothing from the page and is documented in the component itself.

Three ideas run through all of it:

1. **A column states what it IS, and the table works out the rest.** A money column says `filter: "number"`
   and gets comparisons, ranges and its own distribution; a day column says `filter: "date"` and gets
   calendar windows. Nothing about the popovers, the chips or the URL encoding is the page's problem.
2. **A filter is always a string.** Filters travel in the URL (`t.<table>={"f":{…}}`), in saved views and in
   the per-user prefs blob, all of which are string maps. Typing a column gives that string a grammar, read
   by `web/src/lib/tableFilter.ts`. Deep links and saved views therefore carry a typed filter with no extra
   work, and an older saved view keeps working.
3. **Anything the table cannot know, the page says in one line.** That is what `insights` is for.

---

## 1. Column filter kinds

`Column.filter` is one of `"text" | "select" | "number" | "date" | "none"`. It defaults to `"text"` when the
column has an accessor.

| kind | What the reader gets | Use it for |
|---|---|---|
| `text` | Substring match, case-insensitive. `!foo` excludes. | Names, free text, references, codes |
| `select` | The column's distinct values, **each with a row count**, plus `(Blank)` when some rows have none. Alt-click a value to exclude it. | A small set of repeated values: status, category, department, owner |
| `number` | `>`, `≥`, `<`, `≤`, `=`, `between`, plus the column's own lowest / highest / median / total and a one-click "above median" | Money, days, counts, ages, percentages |
| `date` | Calendar windows (today, last 7/30 days, this month, before today, next 30 days…) and an explicit from/to | Any `YYYY-MM-DD` or timestamp column |
| `none` | No filter | Action columns, and columns whose accessor is a rendering detail |

Two column fields tune the typed kinds:

- `dateHint: "past" | "future"` puts the half of the calendar this column lives in first. A "Created" column
  is asked about the past; a "Due" column about what is coming. Ordering only - both halves stay offered,
  because the reverse question gets asked often enough to matter.
- `formatTotal: (n) => …` is how the table prints any figure from this column: the footer total, the stats in
  the filter panel, and the filter chip ("Amount: > ₹5,000" rather than "Amount: >5000"). Worth setting on
  any numeric column with a unit, not only on the ones that are summed.

### The value grammar

Written out in full in `web/src/lib/tableFilter.ts`. The short version, because insight chips and tests write
these strings by hand:

```
number   ">5000"  ">=5000"  "<100"  "<=100"  "=0"  "100..200"  "100.."  "..200"
date     "today" "yesterday" "last7" "last30" "thismonth" "lastmonth" "thisyear" "past"
         "tomorrow" "next7" "next30" "nextmonth" "future"
         "2026-01-01..2026-03-31"   "..2026-03-31"   "2026-03-31.."   "2026-03-31"   "2026-03"
any      "is:blank"  - rows with no value; "!is:blank" - rows with one
text     "!draft"    - a leading "!" excludes, on text and select alike
```

A string the grammar cannot read matches **everything**, not nothing. These are typed a character at a time,
and a half-finished `>` that emptied the table would take the rows away exactly while the reader is still
saying which ones they want.

Named date windows resolve against the ORG's today (`lib/orgDay`), never the browser's.

---

## 2. Grouping

`groupBy: true` on a column offers it in the group-by picker (in the Columns popover on a desktop, in the
Sort & filter sheet on a phone, and in the cell menu). Grouping folds the table by that column's value, with
each fold carrying its row count and a subtotal for every `aggregate: "sum"` column.

Mark a column groupable when it holds **a small set of repeated values people compare across**: department,
category, status, owner, assignee, priority, pay run. Not a name, not an id, and never a date - a date groups
into a heap of one-row folds.

Each fold's own chevron opens and shuts it; a "Collapse all" / "Expand all" button sits beside the "Grouped
by" chip at the top of the table and does the lot at once (shown once there is more than one fold). Which
folds are shut is a reading gesture, not a layout choice, so it is not persisted.

What folding does to the numbers, because it is worth stating once: a folded group's rows leave the paged set
(so folding shortens the table rather than leaving a page of nothing), and the pager says how many are hidden
that way. The footer totals and the export keep covering every filtered row - what is folded is hidden, not
excluded.

Grouping is saved with the table's other prefs, captured by a saved view, and carried in the URL, so a
grouped view is shareable.

---

## 3. What the table remembers

Three stores, and they hold different things on purpose. All of it is keyed by `tableId`; a table without
one persists nothing.

**Per-user prefs** (`web/src/lib/tablePrefs.ts`, server row via `/v1/preferences` with a localStorage cache)
hold how this reader keeps the table: column `order`, `hidden`, `widths`, `pageSize`, `density`, `groupBy`,
`sort`, and the saved `views` themselves. Filters and the search box are NOT here - a narrowing that came
back on its own the next time you opened a page would read as missing rows.

**A saved view** is a named snapshot: `filters`, `sort`, `search`, `hidden`, `groupBy`, plus the shape
(`order`, `widths`, `pageSize`, `density`). Applying one gives the table back the way it was saved. Every
field but `filters` is optional, and silence is not an instruction: a view saved before a field existed
leaves that part of the table alone rather than resetting it. The built-in "Default" resets which rows and
columns show, not the shape - order, widths, page size and density are how this reader likes the table, not
part of the narrowing being cleared. Which view is showing is matched on rows and columns only, so dragging
a column wider does not drop the view's name off the table.

**The URL** (`t.<key>`) carries `s` sort, `f` filters, `g` grouping - what makes a link worth sending. A deep
link beats both saved layers, including when the server prefs land after the first render.

Not persisted anywhere: which groups are folded, which sub-rows are expanded, the selection, and the page
number. Each is a gesture within one sitting.

---

## 4. The cell menu

Right-click any cell with an accessor. The items come from the COLUMN's kind and the CELL's value: an amount
offers "exactly", "more than", "less than"; a day offers "only that day", "on or before", "on or after",
"that month"; a status offers itself and its opposite. Then: sort, group by (if the column is groupable),
copy the value, hide the column.

Nothing is wired per page. A page gets the menu by typing its columns.

---

## 5. Insights

```ts
insights={(rows) => TableInsight[]}
```

A page's own reading of its rows, rendered as chips above the table. Each chip carries the narrowing that
isolates exactly the rows it counted, so clicking it is the same as reading it and then filtering by hand.

The contract, from `web/src/components/common/TableInsights.tsx`:

- **It counts something actionable.** A chip nobody would act on is a fact, and facts belong in a column.
- **Its `filters` leave exactly the rows it counted.** A chip whose filter disagrees with its own number
  teaches people to distrust both. In practice this is the constraint that shapes them: a select filter
  cannot say "either of these two states", so two states means two chips - or a derived column that can say
  it in one (see `open_days` on Background checks, `surplus` on leave balances).
- **It is absent at zero.** "0 overdue" is a good state and needs no chip; the empty strip is the good news.
- It is called with every LOADED row, not the filtered set, so the figure holds still once its own filter is
  applied.

```tsx
const ticketInsights = (ts: Ticket[]): TableInsight[] => {
  const open = ts.filter((t) => ticketStatusLabel(t.state) === openLabel);
  const aged = open.filter((t) => ticketAge(t) >= 7);
  return aged.length === 0 ? [] : [{
    id: "aged",
    label: `${aged.length} open over a week`,
    tone: "warning",
    filters: { age: ">=7", state: openLabel },
    sort: "age.desc",
  }];
};
```

Where a page already has KPI tiles with drill-through (`useKpiFocus`), insights are for what the tiles do NOT
say. Two surfaces counting the same thing is one too many.

---

## 6. Selection and keyboard

- **Shift-click** a row checkbox to select the range from the last one clicked, in the order the table is
  showing. The range spans pages, like the header's select-all.
- A group header carries a checkbox that selects the whole fold.
- `/` puts the cursor in the table's search box, `j`/`k` (and `↑`/`↓`) walk the rows, `Enter` opens the
  focused one, `x` selects it. These are the shortcuts the `?` reference already advertises.

---

## 7. Adding a table

Beyond the usual (`columns`, `rows`, `getRowId`, `accessCollection`):

1. Give every money, count and duration column `filter: "number"`, and `formatTotal` if it carries a unit.
   Add `aggregate: "sum"` when a total of the column is a question anyone asks.
2. Give every date column `filter: "date"` and a `dateHint`.
3. Mark the repeated-value columns `groupBy: true`.
4. Write `insights` only if there is something a person who knows the domain would say out loud on opening
   the page. Most catalogue tables have nothing, and that is the right answer for them.

`test/tableFilter.test.ts` pins the filter grammar. `metaColumns()` and `stateColumn()` already carry their
own typing, so Created/Updated and State are done for you on every table in the app.

# Table builder (custom cross-collection grids)

Built. This describes the feature as it is.

## What it is

A user picks a base ("one row is a person", "one row is a ticket"), picks fields from anywhere they have
access - employee columns, identity fields like PAN, personal and work email, bank details, the salary
breakdown component by component, leave balances, assets held, loans, benefits, payslip figures, tax
declarations, and the whole people-analytics measure catalogue - and gets one grid. It is named, saved,
re-openable, shareable through the ordinary ACL, filterable, sortable and exportable.

The salary sheet the feature was asked for is: base People, columns `first_name`, `@identity.pan`,
`@personal.personal_email`, `work_email`, `@comp.ctc_annual` and one column per pay component.

## The design in one line

A saved grid is a resource (`table-views`), its columns come from a server-side field catalogue derived from
the schema, and running one fans out over the source collections through `scopesForCollections` - so every
column is gated by the exact list decision a real `GET /v1/<collection>` would get.

**No SQL, no JOIN and no field list arrives from the wire.** A wire-supplied query would bypass `applyScope`
(row scope), `deniedFieldKeys` (field scope), the sensitive-read audit rows and the wire-id codec. Every
authorization guarantee in this app is expressed as "the middleware decided, the service only binds it to
columns"; a generic query surface cannot inherit that. So the catalogue is a closed set of fields, each
naming the collection whose list decision gates it - the same contract `people-analytics` lives under.

## Server

### The catalogue

`src/domain/tableFields.ts` (pure - the authz middleware imports `TABLE_SOURCE_COLLECTIONS` from it) holds
the rules: which collections may be a base, which columns may never be offered, and which per-employee
sources exist. `src/services/tableCatalog.ts` derives the actual fields from the schema:

- **Base columns** come from the drizzle table, so a column added to the schema appears in the builder.
  Global denies drop encrypted blobs (`*Enc`), JSON blobs (`*Json`), object-store keys and secrets
  (`*Key`, `*Secret`, `*Hash`), the identity columns (`uuid`, `code`, `delete_time`) and every id-shaped
  column (`*Id`, `*Ids`, `*By`, `*Ref`) - `*Ids` because `departments.manager_ids`, `interviews.
  interviewer_ids` and `events.attendee_ids` hold a LIST of internal ids in one column, which the runner's
  single-id guard would not have caught. Per-collection denies drop columns whose WIRE form is conditional - a suggestion's `submitter_id`
  is hidden when it is anonymous, so projecting the raw column would be a way round the anonymity the
  serializer promises.
- **Links** come from the table's own FOREIGN KEYS (`getTableConfig(...).foreignKeys`), so the join graph
  cannot drift from the schema. A link is offered only when its target is itself a registered base AND the
  caller may list it - one allowlist governs both.

  The catalogue is served **one node at a time**: `?base=` answers with that collection's own fields plus the
  links leading out of it, and `?path=employee_id.department_id` answers the same for the collection at the
  end of that chain. So the picker walks the join like a file tree ("Tickets -> Requester (People) ->
  Department") and a join can be four hops deep without any response having to carry the whole reachable
  tree. Repeats are allowed - "manager -> manager -> department" is a real question, and banning a revisit
  would have taken `manager` off People. `resolveFields` is the other half: a saved view holds keys from
  several nodes, so the runner builds one node per distinct path its keys name, not one per key.
- **Sources** are the bundles that are not columns: `@identity`, `@personal`, `@bank`, `@comp` (including
  one column per pay component, from `ctcLines` - the same lines the CTC annexure and the offer letter
  state), `@position`, `@payslip`, `@leave` (one column per leave type), `@asset`, `@loan`, `@benefit`,
  `@dependent`, `@tax`, and `@metric` (every measure in `domain/peopleAnalytics.ts`, unchanged). They hang
  off the base row when the base IS an employee, and off every foreign key to employees otherwise - so a
  tickets grid can carry both the requester's department and the assignee's.

Identity fields, pay components and leave types are read from the org's own configuration, so a custom
identity field becomes a column without a code change. The `@` prefix on a source segment is not decoration:
`payslips.tax` and `transition-tasks.position` are real columns whose names are also source keys, and the
prefix is what keeps the two namespaces apart (pinned by `test/tableFields.test.ts`).

Endpoint: `GET /v1/table-fields[?base=]` - a virtual capability with no table, like `workflow-meta`. It
returns only fields whose gating collection the caller may list, so the builder cannot offer a column that
would 403.

### The saved view

`table-views`, a collection through the standard factory (`src/routes/tableViews.ts` + a `CrudSpec` in
`src/services/tableViews.ts`). Owner-coded, so `me`-scoped rules reach the author's own views and **sharing
one is an ordinary object share on its code** - the existing ACL, not a mechanism of its own. Locking, soft
delete, restore, If-Match and audit diffs come from the lane.

Writes validate the spec structurally (base registered, operators known, caps held). Whether a particular
field EXISTS, and whether the reader may see it, is decided at run time - which is what lets an admin's view
keep its columns while a narrower reader quietly loses the ones they may not have.

**The base is editable.** Picking the wrong one is the first mistake anybody makes, and it is an ordinary
edit rather than a reason to delete the table: PATCH the base and the spec is cleared, because a column key
names a field of the base it was picked from (`first_name` on People is not a column of Tickets). Only on a
REAL change - re-sending the same base, which a rename does, leaves the columns alone. The run parameters
survive either way: a window and a department are about the reader, not about the base. The SPA asks about
the cost at the moment the base is picked, not after Save.

### Running one

`POST /v1/table-views/{id}:run` (a `raw` verb - it answers with a grid, not a resource).

1. The middleware authorizes `table-views.<code>.run` like any custom method.
2. It also parks `tableScopes = scopesForCollections(deps, user, TABLE_SOURCE_COLLECTIONS)` on the request -
   one line beside the `dashboard-summary` / `people-analytics` lines in `src/middleware/authz.ts`.
3. Columns whose collection is absent from that map are dropped and reported in `dropped`, with the reason.
4. Base rows are bound by `applyScope`, and so is every linked row.
5. Identity / personal / bank columns are additionally gated per row and per field by
   `src/http/tableFieldAccess.ts` - the same in-memory `decide()` the profile endpoint runs, zero extra
   reads. A denied cell is `null` **and listed in `denied`**, so the grid shows a restricted marker rather
   than an empty value that would read as "not set".

**A shared view is not an escalation**: the recipient runs it under their own scopes, so they get the same
grid with fewer columns and fewer rows. That is the property the whole design rests on.

Loading is batched per source (`inArray` over the page's ids), never per row, and a source nobody selected is
never queried. Pages go through `clampPageSize` and return a cursor; the grid follows it, so a 500-person
sheet is one screen and one export rather than a silent 100-row window.

### Masking and `unmask`

`identityDetails` masks any field the org flags sensitive (`•••• 1234`) for everybody. The grid does not
become the one path that quietly unmasks:

- Default: exactly what the profile shows, masked.
- Real values need the virtual `unmask` capability - COLLECTIONS only, no table, no route, like `export` and
  `timeline` - **and** the per-field read. Private by default.
- A run that touched masked fields writes one audit row (`table-views.run.sensitive`) naming the view, the
  field keys and the row count. One row per run, not per person: a per-record row would put a page of rows in
  the feed for one report and bury the trail it exists to be. Field keys only, never values.

## Web

`web/src/pages/TableBuilder.tsx`. The saved tables are a `DataTable`; a table opens at `#/tables/<id>`. The
grid IS `DataTable`, so column hide/reorder, per-column filters, saved layouts, CSV/Excel export (gated by
the existing `export` capability) and the truncation notice all come for free. The column picker is a Sheet
over the server's catalogue: a breadcrumb of where you are standing in the join, this node's fields (grouped,
searchable, masked ones marked), and a "Related records" list that walks one hop further. Picked columns are
chips that survive the walk, because the trail is where you are standing, not what you have chosen. Run parameters (measure window,
pay period, department) live in the URL, so a narrowed report is a link - and are never written back to the
view by simply looking at it.

Registered in `nav.ts` (Admin -> Tables), `App.tsx`, `lib/quickActions.ts` ("Build a table"), and
`domain/searchIndex.ts` so a saved table is findable by name from Cmd-K.

## Access

Private by default, deliberately: no seeded grant names `table-views`, `table-fields` or `unmask`, so only
super has them until an admin grants them through the ACL. Granting the builder means granting
`table-views` (read/write) **and** `table-fields` (read) - the page says so when it has one and not the
other. `unmask` is a separate, deliberately harder-to-hand-out decision.

## Tests

- `test/tableFields.test.ts` - the registry gates: every base is a registered collection with a table, nothing
  excluded is also registered, every exclusion states why, no denied column can be projected, a source segment
  can never collide with a column name.
- `test/tableViewRun.test.ts` - the access matrix on real D1: columns dropped when their collection is not
  listable, refusal when the base is not, a per-field deny blanking a cell on that row, a whole sub-resource
  hidden, masked by default and unmasked only with the capability, exactly one audit row per sensitive run,
  no bare internal id in any cell, filters in SQL and in memory agreeing, and paging.
- `e2e/tableBuilder.spec.ts` - build a table mixing three collections through the UI, prove it reads back
  after a reload, and delete it.

## Still open

- Sorting is applied per page (base rows page in the cursor's own order) and then across the loaded set by
  DataTable. A sort that must span more rows than the grid has loaded is not a server-side sort.
- `@metric` columns compute the whole people-analytics report for the window and join it, so a grid with a
  measure column costs what that report costs. Selected only when asked for.
- The base picker offers one base per table. A grid that is a union of two bases is not expressible, by
  design.
- Links are to-ONE only: a foreign key on the base row leads to exactly one record, which is what keeps one
  grid row one row. To-many ("every leave request this person filed") is not a link - it is what the curated
  sources and the measure catalogue answer, as counts and sums rather than as a row explosion.
- The picker's search covers the node you are standing on, not the whole tree.

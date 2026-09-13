# Frontend review - live findings

Appended as each issue is confirmed.

---

## 1. "Copy last week" duplicates entries after a partial failure, ten lines below the function that documents the fix

`web/src/pages/Timesheets.tsx:243-266`

```ts
async function copyLastWeek() {
  setCopying(true);
  try {
    const r = await getAllPages<TimeEntry>(`time-entries?employee=…&from=${from}&to=${to}`, ENTRY_ROW_CAP);
    const todo = r.results.filter(…)
      .map((e) => ({ e, date: addDaysYmd(e.date!, 7) }))
      .filter(({ e, date }) => days.includes(date) && !byCell.get(`${idOf(e.project!)}|${date}`));
    …
    for (const { e, date } of todo) {
      await create("time-entries", { project: e.project, date, hours: e.hours, … });
    }
    toast({ title: `Copied ${todo.length} …`, variant: "success" });
    void loadWeek();                                   // <-- inside the try, after the loop
  } catch (e) {
    toast({ title: "Couldn't copy last week", description: (e as Error).message, variant: "destructive" });
  }                                                     // <-- no reload here
  finally { setCopying(false); }
}
```

A failure on entry 3 of 8 leaves two entries created on the server, and `loadWeek()` never runs - so `byCell`,
which is derived from the loaded week, still describes the grid as it was before the copy.

The guard that makes a second press safe is exactly that map:

```ts
.filter(({ e, date }) => days.includes(date) && !byCell.get(`${idOf(e.project!)}|${date}`))
```

With `byCell` stale it excludes nothing, so pressing "Copy last week" again **creates the two entries a second
time**. The function's own comment claims the opposite:

> *"Cells that already hold an entry this week are left alone, so it is safe to run twice."*

True only while the grid is current, which the error path is precisely when it is not.

`submitWeek`, immediately above at `:201-240`, is the same page's correct handling of the same failure, and its
comment states the rule this one breaks:

> *"This used to be a bare loop with the toast and the reload inside the `try`, which made a partial failure a
> dead end rather than a setback … Same shape the attendance correction dialog already uses: stop at the first
> refusal, say which entries went through, and **ALWAYS re-read the week** so the next attempt is computed from
> what the server holds."*

**Fix.** Count what was created, report it on the failure path too, and move `loadWeek()` to a `finally` - the
shape `submitWeek` already uses twelve lines above.

---

## 2. No department read in the app follows the cursor, so past 100 departments every name lookup and picker is silently short

`web/src/hooks/useCollection.ts:76-93`, and all 30 `departments` reads

`useCollection`'s `all` flag exists for one shape, and its doc names it exactly:

> *"For the readers whose answer is WRONG rather than merely short on a window: a picker that cannot offer the
> hundred-and-first employee, a `new Map(employees.map(...))` name lookup that renders "Employee" for everyone
> past the page, a grid with one row per person. **Those are not list pages - there is no "load more" for a
> reader to press and nothing on screen that reads as incomplete** - so the fetch has to be the one that
> completes itself."*

For `employees` the codebase applies it consistently - OrgChart, CommandPalette, Stocktakes, Leaves, Overtime,
Reimbursements, ReviewCycles, GoalTemplates and others all pass `{ all: true }`.

For `departments` it is applied **nowhere**. Every one of the 30 reads takes a single page, which the server
caps at 100 (`http/pagination.ts#clampPageSize`):

```ts
const { rows: departments } = useCollection<Department>("departments");
```

in `Directory`, `Tickets`, `Goals`, `Expenses`, `ExpenseBudgets`, `Documents`, `Announcements`,
`LeaveCalendar`, `Schedule`, `Referrals`, `Requisitions`, `Reviews`, `ReviewCycles`, `GoalTemplates`,
`TeamAnalytics`, `Profile`, `EmployeeProfile`, `OrgChart`, `Settings` (×2) and the rest - the only variations
are `enabled` and `showDeleted`, never `all`.

And what they do with the rows is precisely the two shapes the doc calls out:

```ts
// ExpenseBudgets.tsx:198 - the lookup
const deptName = useMemo(() => {
  const m = new Map(departments.map((d) => [idOf(d.path), d.display_name]));
  return (p?: string) => (p ? m.get(idOf(p)) ?? idOf(p) : "Org-wide");
}, [departments]);
```

so past the page a department column renders **the raw wire id** instead of a name - the same "internal
identifier leaked into the UI" failure `lib/utils.ts#personName` was written to stop. The pickers (budget
scope, requisition, ticket category, board swimlane) simply cannot offer those departments, so a record cannot
be scoped to one.

Departments here are hierarchical - `parent`, subtree codes, `moveDepartment` cascading a whole subtree - so a
region → country → function → team structure reaches 100 nodes in an ordinary mid-size org, not an extreme one.
`OrgChart.tsx:51` is the sharpest instance: it renders a **tree**, applies `{ all: true }` to employees on the
line above (`:50`) for this exact reason, and leaves departments on one page - so the department view presents a
truncated org chart as a complete one.

No `TruncationNotice` is wired to `departments` anywhere, and `collectionHasMore("departments")` is never read,
so nothing on screen admits it.

**Fix.** `{ all: true }` on the department reads that build a lookup or a picker. `departments` is already in
`CATALOG_COLLECTIONS` (`lib/resourceStore.ts:28-32`) with a 5-minute TTL and a disk copy, so walking the cursor
costs one extra request per five minutes at worst, not per page view.

---

## 3. Past 100 projects, the timesheet drops whole rows of logged hours from the grid

`web/src/pages/Timesheets.tsx:60`, `:79`, `:153-157`, `:295`

```ts
const { rows: projects, state: projectsState } = useCollection<Project>("projects");   // :60 - one page
const projectById = useMemo(() => new Map(projects.map((p) => [idOf(p.path), p])), [projects]);   // :79
```

`gridProjects` is what the week grid renders a row for, and it resolves every project **through that map**:

```ts
const gridProjects = useMemo(() => {
  const ids = new Set<string>([...mine.map((e) => idOf(e.project ?? "")), ...extraProjects].filter(Boolean));
  return [...ids].map((id) => projectById.get(id)).filter(Boolean) as Project[];   // <-- .filter(Boolean)
}, [mine, extraProjects, projectById]);
```

A project past the server's 100-row page cap is absent from `projectById`, so `projectById.get(id)` is
`undefined` and `.filter(Boolean)` **silently removes it**. The employee's entries against that project exist
on the server and are in `mine`, but the grid has no row for them: the hours are simply not on screen, and the
week total beside them (`weekTotal`, `:198`, summed from `mine`) still counts them. So the columns add up to
more than the rows show, with nothing saying why.

The name lookup fails the same way, and the fallback makes it plain:

```ts
// :295
{projectById.get(idOf(e.project ?? ""))?.name ?? "Project"}
```

which is verbatim the failure `useCollection`'s `all` doc describes - *"a `new Map(employees.map(...))` name
lookup that renders "Employee" for everyone past the page"*.

`ProjectsAdmin.tsx:40` reads the same collection with `{ all: true }`, so the admin list is complete while the
page people actually log hours on is not. Projects are the collection most likely to exceed 100 in a services
org - one per client engagement.

Same shape, same page-cap, one line each:

- `web/src/pages/Expenses.tsx:116` - `useCollection<Vendor>("vendors")` feeding the vendor name and picker on
  every expense. `Vendors.tsx:36` is also one page, though that one is a list with a table behind it.
- The catalog set generally (`asset-categories`, `expense-categories`, `pay-components`, `letter-templates`,
  `ticket-checklists`, `shifts`) is read one page deep in lookup positions, though most of those have a
  practical ceiling well under 100.

Worth noting how narrowly this has been fixed so far: `{ all: true }` for employees, and
`PermissionsPanel.tsx:96` using `listAll<Role>("roles")` with the comment *"Every role, not the first page: a
rule whose subject is a role past the cap would otherwise render as a bare machine name here and be missing
from the copy-permissions picker entirely."* - both added after the failure was met, not from the rule.

**Fix.** `{ all: true }` on `Timesheets.tsx:60` and `Expenses.tsx:116`. Both collections are in
`CATALOG_COLLECTIONS` with a 5-minute TTL and a disk copy, so the cursor walk is amortised.

---

## 4. 27 name lookups fall back to a raw 26-character wire id - the failure `personName` was written to end

`web/src/lib/utils.ts:14-35` and 27 call sites

`personName` exists for one reason, and states it:

> *"**The FALLBACK is the point of this helper.** Every page that shows "whose request is this" reads
> `employees` under its own access, so a ref to somebody outside that slice resolves to nothing - an ordinary
> employee cannot read their own manager's row, for one. **Six pages each open-coded this and each fell back to
> the raw internal id, which put a 26-character uuid on screen in place of a name ("Goes to 5q5an4xdav8t… for
> approval"): meaningless to the reader, and an internal identifier leaked into the UI.** So an unresolvable ref
> reads as `unknown`."*

Seven files use it. Twenty-seven lookups still open-code the pattern with the banned fallback:

```ts
// Tickets.tsx:226 - the Assignee column
const m = new Map(employees.map((e) => [idOf(e.path), …]));
return (p?: string) => (p ? m.get(idOf(p)) ?? idOf(p) : "Unassigned");
```

and the same line, near-verbatim, in `Reimbursements.tsx:93`/`:97`, `Expenses.tsx:267`, `Assets.tsx:136`/`:144`,
`Documents.tsx:175`, `Directory.tsx:241`/`:245`, `PayrollRuns.tsx:311`, `Vendors.tsx:65`, `Tickets.tsx:230`,
`ExpenseBudgets.tsx:197`/`:198`, `Compliance.tsx:108`, `EmployeeProfile.tsx:123`, `Events.tsx:159`,
`LeaveEncashments.tsx:65`/`:69`, `EmployeeRoleHistory.tsx:33` and others.

The trigger is not paging - `Tickets`, `Documents`, `Assets`, `Compliance` and `Events` all read employees with
`{ all: true }`, so the cursor is followed. It is the one the doc names: **the server scopes the list to what
the caller may read.** A caller holding `employees.read` at `dept` scope gets only their department, so:

- a ticket assigned to someone in another team renders `5q5an4xdav8t…` in the Assignee column;
- an asset held by someone outside the reader's department shows a uuid as its holder;
- a compliance item's owner, a document's issuer, a payroll run's approver, an expense's submitter - all the
  same.

Tickets, assets, documents and compliance are cross-departmental by nature, so this is the ordinary case for
anyone without org-wide `employees.read`, not an edge.

The department/category variants (`ExpenseBudgets.tsx:197-198`, `Directory.tsx:241`) have the same shape
against a different collection, and there the page cap is a second trigger (finding 2).

**Fix.** `personName(employees, ref, "…")` at the employee sites, and the same treatment - a word, never an id -
for the catalog lookups. A lint rule banning `?? idOf(` in a render path would close the class; it has now
grown from the six sites the helper was written for to twenty-seven.

---

## 5. [FIXED while this review was running - see the note at the end] Rejecting a tax declaration is a one-click irreversible decision with no confirm, on both surfaces

`web/src/pages/Approvals.tsx:57-68`, `web/src/components/common/EmployeeTaxDetails.tsx:77-87`

```ts
// Approvals.tsx - the inbox card
async function decide(v: TaxVerification, action: "verify" | "reject") {
  setBusy(v.employee + action);
  try {
    await patch(`employees/${idOf(v.employee)}/tax`, { values: { action } });
    toast({ title: action === "verify" ? "Previous employer details verified" : "Declaration rejected", … });
```

```ts
// EmployeeTaxDetails.tsx - the profile panel, same endpoint
async function decide(action: "verify" | "reject") {
  setDeciding(true);
  try {
    setData(await patch<TaxDetails>(`employees/${employeeId}/tax`, { values: { action } }));
```

Neither asks. `lib/confirmDecision.ts` is the app's rule for exactly this shape:

> *"A decision is not an edit: approving, rejecting or cancelling a request lands in somebody's notifications,
> moves money or time off, and cannot be taken back from the same button that made it. Those all deserve the
> same beat of friction, and they were spread across a dozen pages as bare one-click handlers - so the copy
> lives here and every page asks the same way."*

and twelve pages follow it - `Reimbursements:174`, `Overtime:180`, `Leaves:383`, `Expenses:541`,
`Timesheets:205`/`:269`, `Pipeline:142`/`:906`, `Attendance:170`/`:1391`, `RemoteWork:139`, `Dashboard:544`.

These two are the exception, and the likely reason is mechanical: every other decision goes out as
`invoke(path, verb)`, while this one is a `patch` with `{ values: { action } }`, so it does not look like a
decision to anything scanning for one. The `reject` copy in `confirmDecision` already fits it verbatim -
*"…is rejected and the requester is notified. They would have to file again."*

Rejecting here un-applies declared prior-employer income and TDS from the employee's tax projection, which
changes their withholding on the next run, and the employee is notified. It is the same weight as the
reimbursement reject two files over, which does ask.

Second, smaller gap in the same card (`Approvals.tsx:86-93`): **Verify** is wrapped in an `AccessAction`
carrying the manage-access key -

```tsx
<AccessAction collection="employees" objectPath={v.employee} field="tax" label="Verify prior-employer tax">
  <Button …>Verify</Button>
</AccessAction>
<Button size="sm" variant="ghost" className="text-destructive" … >Reject</Button>   {/* bare */}
```

- and **Reject** beside it is bare, so in access mode the control pair shows a key on one half. Both are
already behind the same `canDecide` gate, so this is an affordance gap rather than an authorization one.

**Fix.** `confirmDecision(confirm, "reject", …)` on both handlers, and wrap the Reject button in the same
`AccessAction` as its neighbour.

**Status (re-checked against the working tree).** Both changes are now present and uncommitted:
`Approvals.tsx:65` and `EmployeeTaxDetails.tsx:91` call `confirmDecision(confirm, "reject", …)`, and both
buttons in the Approvals card are wrapped in `AccessAction`. The finding above describes the state before that.

What still stands is the other half of the pair: **Verify** asks nothing on either surface. It is the direction
that *applies* prior-employer income and TDS to the projection and so *cuts* the tax withheld on the next run -
the same "moves money" test `confirmDecision` states - and `approve` is in its `Decision` union with copy that
fits. A far more serious gap on the same two calls is filed separately as finding 42.

---

## 6. Retrying a partly-failed holiday year-copy duplicates the holidays that already landed, and nothing stops a duplicate

`web/src/components/holidays/CopyYearDialog.tsx:78-97`

Both holiday bulk dialogs loop `await create("holidays", …)` and collect failures, and both - correctly - keep
the dialog open when anything failed so the operator can retry. `BulkAddDialog` then rewrites its box to the
failures alone (`:76`), so a retry does not re-create what landed; that rewrite has its own defect, filed
separately as finding 23. `CopyYearDialog` leaves its plan untouched:

```ts
// CopyYearDialog
for (const r of taking) {
  try { await create("holidays", { display_name: r.name, date: r.date, kind: r.kind, half_day: r.half_day, location: r.location }); }
  catch { failed++; }
  setProgress((n) => n + 1);
}
…
onDone();
if (!failed) onOpenChange(false);     // <-- stays open on failure, with `taking` unchanged
```

`CopyYearDialog` does not record which rows landed. Pressing the button again re-runs the whole list, so every
holiday that succeeded the first time is **created a second time** - and there is nothing to stop it:

```ts
// src/db/schema.ts:371-389 - the whole table
export const holidays = sqliteTable("holidays", {
  uuid: pk(), code: codeCol(),
  date: integer("date", { mode: "timestamp_ms" }).notNull(),
  name: text("name").notNull(), kind: …, location: …, halfDay: …,
}, (t) => ({ pageIdx: index("holidays_page_idx").on(t.createdAt, t.uuid) }));
```

One paging index, no unique constraint on `(date, location)` or anything else, and no duplicate check in
`src/services/holidays.ts`. So the retry succeeds and the calendar ends up with two "Diwali" rows on the same
date - which then show twice on the holiday list, twice in the year grid, and feed the holiday lookups that
leave-day charging and the attendance grid read.

This is the third instance of the same shape. The codebase already has three correct implementations to copy:

- `pages/Attendance.tsx:426-461` - `filedThisDialog` set, skips days already filed on a retry, reports
  "Filed 3 of 5";
- `pages/ExpenseBudgets.tsx:419-450` - counts what it made and says so on the failure path;
- `components/access/AclModal.tsx:392-416` - restores what it removed and reports what it could not.

and `lib/batchRun.ts#runSequential` exists precisely for this - it already collects `{ label, message }` per
failure and returns a `BatchProgress`. Neither holiday dialog uses it.

**Fix.** Track the rows that succeeded (or switch both to `runSequential`) and skip them on a retry. A unique
index on the holiday's natural key would be the belt to that braces.

---

## 7. A failed "unexpected find" is latched as done, so the stocktake loses it for the rest of the walk

`web/src/components/assets/Stocktake.tsx:193-206`

```ts
async function recordFound(raw: string) {
  if (!session) return;
  // The camera re-reads whatever is in front of it every few seconds, so an unknown sticker left in frame
  // would log the same find over and over. Once per payload per session is the finding.
  if (foundRef.current.has(raw)) return;
  foundRef.current.add(raw);                    // <-- latched BEFORE the write
  try {
    const updated = await invoke<Count>(session.path, "recordFound", undefined, { scan: raw });
    …
  } catch (e) {
    toast({ variant: "destructive", title: "Couldn't log that scan", description: (e as Error).message });
  }                                             // <-- nothing un-latches it
}
```

The dedupe is right for its stated purpose - a sticker left in frame must not log forty times. But it marks the
payload handled before knowing whether the write landed, and the catch only toasts. So a scan that fails once
(a 502 from a rolling isolate, a dropped connection on a warehouse floor, a rate-limit refusal past the retry
cap) can **never be logged again in that session**: pointing the camera at the same sticker returns at the
`foundRef.current.has(raw)` guard, and so does typing the tag into the manual box (`submitManual` →
`handleScan` → `recordFound`).

An unexpected find is the one output this feature exists to produce - `handleScan:211` even returns `true` on
that branch with the comment *"it WAS handled: the find is now on the record"*, which is exactly what is not
true after a failure.

Its sibling ten lines above gets this right. `recordSighting` records the failure per asset so the row stays
visibly uncounted:

```ts
} catch (e) {
  // A failed save must not silently look like a sighting: the row stays in "not seen" and says why.
  setFailed((prev) => ({ ...prev, [a.path]: (e as Error).message }));
  toast({ variant: "destructive", title: `Couldn't record ${a.asset_tag ?? a.name}`, … });
}
```

**Fix.** `foundRef.current.delete(raw)` in the catch - the dedupe should mean "already logged", not "already
attempted". Better still, surface failed finds the way `recordSighting` surfaces failed sightings, so the
walker can see there is something still to re-scan before they close the count.

---

## 8. Retrying a partly-failed letter batch files a duplicate letter for everyone it already succeeded for

`web/src/components/common/GenerateLetterDialog.tsx:120`, `:179-191`, `:218`

```ts
const recipients = React.useMemo(…, […]);            // :120 - derived from the form, never narrowed

async function submit() {
  if (recipients.length > 1) {
    const result = await runSequential(recipients, empNameOr, generateFor, setProgress);
    setProgress(null);
    onGenerated?.();
    if (result.failures.length) {
      // Thrown, not toasted: the dialog stays open with the list of who was missed.
      throw new Error(`${batchSummary(result, "letter")} Not done: ${result.failures.map((f) => `${f.label} (${f.message})`).join("; ")}`);
    }
    …
```

The reporting half is right - `runSequential` (`lib/batchRun.ts`) walks sequentially, collects
`{ label, message }` per failure, and the throw names exactly who was missed. `WriteDialog`'s `run()` then pins
that message and keeps the form as typed, which is the intended recovery.

What is missing is the resume point. `recipients` is a `useMemo` over the form and is never narrowed, so
pressing Generate again re-runs **the whole list**. For a 40-person batch with 3 failures that files 37
duplicate letters - each one a real document written to that employee's record, and, where the template carries
an `esignature` block, each one asking them to sign a second copy.

`batchRun.ts` already returns what a narrowed retry needs; nothing consumes it:

```ts
export type BatchProgress = { done: number; total: number; failures: BatchFailure[]; current?: string };
```

and the module's own header states the goal it stops one step short of:

> *"The other half is honesty. A batch where record 12 fails must not report success, and must not stop either:
> each failure is collected with the name it belongs to, so the caller can say exactly who was missed."*

It says who was missed. It does not let the caller act on only those.

**Fix.** Keep `result.failures` in state and, when it is non-empty, run the next attempt over just those
recipients (`Attendance.tsx:426-461`'s `filedThisDialog` is the same idea with a `Set`). A `?id=` idempotency
key on the generate call would be the belt.

---

## 9. Same defect, second site: retrying a partly-failed Form 16 batch files duplicate statutory documents

`web/src/components/common/Form16BatchButton.tsx:51-69`

Identical shape to finding 8, and worth listing separately because of what gets duplicated:

```ts
const result = await runSequential(targets, empName,
  (e) => invoke<DocumentResource>("personal-documents", "generateForm16", undefined, {
    employee: `employees/${idOf(e.path)}`, financial_year: fy,
  }),
  setProgress);
setProgress(null);
onGenerated?.();
if (result.failures.length) {
  // Thrown so the dialog stays open holding the list: usually a handful of people with no finalized payroll
  // for the year, which is a real answer, not a glitch.
  throw new Error(`${batchSummary(result, "Form 16")} Not done: …`);
}
```

The comment is right that the common failure is benign - people with no finalized payroll for the year. That is
exactly why a retry is the expected next step once payroll is closed for them, and `targets` is unchanged when
it happens, so the retry regenerates Form 16 for **everyone who already had one**.

A Form 16 is a statutory document filed under the employee's records; two copies for one financial year is a
real problem for whoever later has to say which is authoritative, and `personal-documents` has no dedupe on
`(employee, financial_year, document_type)`.

For contrast, the third `runSequential` caller takes the opposite trade and is safer for it:
`Pipeline.tsx:262-269` clears the selection after a bulk stage move (`setSelected(new Set())`) and reports the
failures in a toast, so nothing is re-run - at the cost of making the operator re-select the ones that failed.
A stage move is idempotent, so that trade costs nothing there; filing a document is not.

**Fix.** As finding 8 - narrow the next attempt to `result.failures`.

---

## 10. A board column added after a delete can collide, and reordering it makes another column's cards jump to the wrong place

`web/src/settings/BoardConfigPanel.tsx:56`, `:58`, `:93-103`

New columns get a key from the array length:

```ts
const addCol = () => setCols((cs) => [...cs, { key: `col_${cs.length + 1}`, label: "New column", … }]);
```

This is the exact generator `Settings.tsx:913-921` documents as broken, and fixed, for ATS stages:

> *"A key that is FREE, not one derived from how many stages there happen to be. `stage_${stages.length + 1}`
> collides the moment the list has ever shrunk: add a sixth stage (`stage_6`), delete an earlier one, add
> another, and the length is 5 again - so the new stage is `stage_6` too. **An application's stage is stored AS
> this key**, so two stages sharing one are the same stage to everything downstream."*

A card's `column_key` is stored the same way. Default boards use named keys (`backlog`, `ready`,
`in_progress`, `review`, `done` - `src/domain/boards.ts:37-43`), so `col_N` only collides with other
hand-added columns, which is reachable in four clicks: add three columns (`col_6`, `col_7`, `col_8`), delete
`col_7`, add another → length is 7 again → `col_8`, which already exists and holds cards.

`save()` repairs the duplicate - but **in array order**:

```ts
const seen = new Set<string>();
const columns = cols.map((c) => {
  let k = slug(c.key || c.label);
  while (seen.has(k)) k = `${k}_`;      // the SECOND occurrence is renamed
  seen.add(k);
  return { ...c, key: k, … };
});
```

and columns can be reordered (`moveCol`, `:58`, with the arrow buttons at `:185`). Put the new column before
the old one and the walk hands `col_8` to the **new, empty** column and renames the **existing** one to
`col_8_`. Every card stored as `column_key: "col_8"` now belongs to the new column; the original is empty. The
server cannot catch it - it receives a valid, unique column list.

The repair pass was added for a different reason, and its own comment says so:

> *"THE SAME PASS FOR LANES AND LABELS, which had the slug and not the uniquing … a save that produced one
> failed at the server with a message naming a key the user never typed."*

So the collision was made survivable without the generator being fixed - and it is the repair that relocates
the cards.

**Fix.** The `addStage` shape from `Settings.tsx:922-927` - pick a key that is free rather than one derived from
the length:

```ts
const addCol = () => setCols((cs) => {
  const taken = new Set(cs.map((c) => c.key));
  let n = cs.length + 1;
  while (taken.has(`col_${n}`)) n++;
  return [...cs, { key: `col_${n}`, label: "New column", … }];
});
```

and make `save()`'s uniquing prefer the key that already has cards, rather than whichever comes first in the
array.

---

## 11. The workflow singularizer strips two letters off any collection ending in "ses", so rules read "Create expen"

`web/src/components/workflows/describe.ts:11`

```ts
// Naive singularizer for a collection token: tickets->ticket, bonuses->bonus, requisitions->requisition.
const singular = (s: string) => s.replace(/ies$/, "y").replace(/ses$/, "s").replace(/s$/, "");
```

The three replaces run in sequence, so the `ses$` rule's output is fed straight into the `s$` rule, which eats
the `s` it just produced. The comment's own example is wrong:

```
tickets      -> ticket        ✓
requisitions -> requisition   ✓
policies     -> policy        ✓
bonuses      -> bonu          ✗   (comment claims "bonus")
expenses     -> expen         ✗
addresses    -> addres        ✗
```

Both `bonuses` and `expenses` are real collections (`src/domain/collections.ts:16,18`), and `apiCallLabel`
(`:56-68`) feeds every `apiCall` action's path through it:

```ts
return isTemplate(coll) ? `${verb} a record` : `${verb} ${humanize(singular(coll)).toLowerCase()}`;
```

So a rule with `{ kind: "apiCall", method: "POST", path: "/v1/expenses" }` renders in the Workflows list as
**"Create expen"**, and `/v1/bonuses` as **"Create bonu"**. `apiCall` is a live action kind
(`src/domain/automations.ts:151,181`) whose path is only validated for a `/v1/` prefix (`:310`), so both paths
are ordinary super-admin-authored rules.

The file's whole purpose is that "nobody scanning the list should have to decode those" (`:3-4`) - a label that
is a truncated word is worse than the raw path, because it reads as a different collection.

**Fix.** Make the `ses` rule terminal instead of letting the next one run on its output:

```ts
const singular = (s: string) =>
  /ies$/.test(s) ? s.replace(/ies$/, "y")
  : /ses$/.test(s) ? s.replace(/es$/, "")
  : s.replace(/s$/, "");
```

(`expenses` -> `expense`, `bonuses` -> `bonus`, `addresses` -> `address`, and the other two branches are
unchanged.)

---

## 12. A workflow condition's value is typed by how it looks, not by the field's declared type, and a mismatch silently never fires

`web/src/components/workflows/ConditionBuilder.tsx:66-71`, `:20`, `:54`

```ts
// Numbers/booleans typed into the value box become real JSON values (so gt/lt compare numerically).
function coerce(s: string): unknown {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s !== "" && !Number.isNaN(Number(s))) return Number(s);
  return s;
}
```

The event catalogue carries a declared type for every field - `{ name: "amount", type: "number" }`,
`{ name: "assetTag", type: "string" }` (`src/domain/events.ts:131,155`) - and the builder throws it away. Line
20 reads only `f.name`, and line 47 renders only `f.name`. Nothing anywhere maps a field to its type.

The server is strict in both directions (`src/domain/automations.ts:66-71`):

```ts
case "eq":  return actual === c.value;                                                   // no coercion
case "gte": return typeof actual === "number" && typeof c.value === "number" && actual >= c.value;
```

and the validator checks the field's **name** against the catalogue and never its **value's type**
(`:274-283`). So a mismatch saves cleanly and then matches nothing, forever, with no error at save time, no
error at evaluation time, and no trace in the run history beyond "did not fire".

Two reachable shapes:

1. **A number that doesn't look like one.** The shipped "Flag a large expense" recipe
   (`recipes.ts:56-67`) seeds `{ field: "amount", op: "gte", value: 50000 }` and invites the reader to edit
   the threshold ("the wording is meant to be changed, not accepted", `recipes.ts:9`). This app formats money
   as `en-IN`, so typing the threshold back the way it is displayed - `1,00,000` - gives `Number("1,00,000")`
   = `NaN`, `coerce` returns the **string**, and `gte`'s `typeof c.value === "number"` is false for every
   expense ever submitted. The rule is saved, listed, and enabled, and is dead.

2. **A string that does look like one.** `assetTag` is declared `string`; asset creation accepts an explicit
   tag override (`src/services/assets.ts:267`), so a numeric tag is possible. Typing it into an `eq` row
   writes the number `1042`, and `"1042" === 1042` is false.

The `Number.isNaN(Number(s))` test also accepts things nobody typed as a number: `Number(" ")` is `0`, so a
value of a single space becomes `0`.

**Fix.** The catalogue already has what's needed - carry the type through:

```ts
const fieldType = new Map(fields.map((f) => [f.name, f.type]));
const coerce = (s: string, t?: string) =>
  t === "string" ? s
  : t === "boolean" ? s === "true"
  : t === "number" ? (s.trim() === "" ? s : Number(s.replace(/,/g, "")))
  : /* unknown */ looksLike(s);
```

and, for a `number` field, show the row as invalid when the box doesn't parse rather than saving a rule that
can never match. The existing `looksLike` behaviour stays as the fallback for a dotted payload path, where no
declared type exists.

---

## 13. Edits made in the workflow builder's JSON escape hatch are silently discarded by Save

`web/src/components/workflows/WorkflowBuilder.tsx:19-35`, `web/src/pages/Workflows.tsx:470-471`, `:496-499`

The JSON toggle holds its text in local state and commits it to the draft only from the **"Back to builder"**
button:

```ts
const [jsonText, setJsonText] = useState("");
const toJson  = () => { setJsonText(JSON.stringify({ condition: draft.condition, actions: draft.actions }, null, 2)); … setJson(true); };
const fromJson = () => { … set({ condition: parsed.condition ?? null, actions: parsed.actions }); setJson(false); … };
```

The Save button is not in this component - it belongs to the enclosing `WriteDialog`
(`Workflows.tsx:508-536`), and `save()` reads the draft:

```ts
const body = { …, condition: draft.condition, actions: draft.actions, … };
```

So: open a rule, press **Edit as JSON**, rewrite the actions, press **Save changes**. The old actions are
written, the toast says **"Rule saved"**, and the textarea's contents are gone when the dialog closes.

Nothing on screen contradicts it, because everything else is also reading `draft`:

- `dirty` (`:496-499`) compares `draft` to `cur`, so the builder believes nothing has changed;
- `WriteDialog`'s unsaved-changes guard takes `form={draft}` (`:524`), so **closing** the dialog does not warn
  either - the work is lost on both exits;
- `FlowPreview` and the `consequence` line beside the button (`:502-505`) keep describing the old actions.

And `canSubmit` (`:529`) is `draft.actions.length > 0`, so on a **new** rule authored entirely in JSON the Save
button stays disabled, with `whyNot` saying "Add at least one action" while the textarea in front of the reader
plainly contains several.

This is the escape hatch for exactly the rules the guided form cannot express - nested `not` / mixed all-any
conditions (`ConditionBuilder.tsx:78` refuses them by design) and array or nested `apiCall` bodies (see the
next finding) - so it is the power user, mid-way through the only editor that can do the job, who loses the
work.

**Fix.** Commit on every keystroke, the way every other control in the builder does, and let the toggle be a
view mode rather than a staging buffer:

```tsx
<Textarea value={jsonText} onChange={(e) => { setJsonText(e.target.value); tryCommit(e.target.value); }} … />
```

where `tryCommit` parses and calls `set(...)` on success and only sets `jsonErr` on failure. Then `dirty`, the
close guard, `canSubmit` and Save all see the same thing the reader does. Failing that, `WriteDialog` must at
minimum refuse to submit while `json` is true, with the reason naming the un-applied JSON.

---

## 14. Opening a rule with an array or nested apiCall body in the builder turns it into a string on the first body edit

`web/src/components/workflows/ActionList.tsx:259-268`, `:300-312`

The body form round-trips an object through `{key, value}` string rows:

```ts
function bodyToRows(body: unknown): BodyRow[] {
  return body && typeof body === "object" && !Array.isArray(body)
    ? Object.entries(body as Record<string, unknown>).map(([k, v]) => ({ key: k, value: typeof v === "string" ? v : JSON.stringify(v) }))
    : [];
}
function rowsToBody(rows: BodyRow[]): Record<string, unknown> | undefined {
  …
  for (const r of entries) { const v = r.value; out[r.key] = v === "true" ? true : v === "false" ? false : v !== "" && !Number.isNaN(Number(v)) && !v.includes("{{") ? Number(v) : v; }
```

Numbers and booleans survive the trip. Anything else does not:

| stored body value | shown in the row | written back |
|---|---|---|
| `7` | `7` | `7` ✓ |
| `true` | `true` | `true` ✓ |
| `["employees/a1"]` | `["employees/a1"]` | `'["employees/a1"]'` **string** |
| `{ values: { action: "verify" } }` | `{"values":{"action":"verify"}}` | that JSON **as a string** |
| `null` | `null` | `'null'` **string** |

`rowsToBody` has no branch that parses a value back into an array or object - the `Number()` test fails on
`["…"]`, so it falls through to the raw string. And any edit to **any** row re-serialises **all** of them
(`setRows` at `:307-312` rebuilds the whole body), so changing an unrelated field is enough.

Worse, when the body **is** an array, `bodyToRows` returns `[]` - the Fields form renders empty, as if the
action had no body at all, and the first "Add field" writes that emptiness back.

This is reachable, not theoretical. Several write schemas require arrays:

```ts
src/routes/goalTemplates.ts:19   employees: z.array(z.string()).min(1).max(200)     // POST /v1/goal-templates/<id>:assign
src/routes/cards.ts:36           initial_todos: z.array(z.string()…).max(…)
src/routes/announcements.ts:87   options: z.array(z.string().min(1).max(200)).min(2)
```

"Assign a goal template to these people" is an ordinary rule to want. The guided body form cannot author it at
all (typing `["employees/a1"]` into the value box produces the string, not the array), so it has to be written
through the JSON hatch - and then merely **opening** that rule in the builder and touching the body form
converts it back to a string, which the server rejects with a 400 that names a field the reader never typed
wrong.

**Fix.** Keep the round-trip lossless: parse a row's value as JSON when it parses and is not a bare number
already handled, and render non-scalars in a way that says they are JSON:

```ts
const parseValue = (v: string): unknown => {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v.includes("{{")) return v;                       // template - always a string
  if (/^[[{]/.test(v.trim())) { try { return JSON.parse(v); } catch { return v; } }
  return v !== "" && !Number.isNaN(Number(v)) ? Number(v) : v;
};
```

and make `bodyToRows` handle a non-object body by surfacing it (a read-only "this body is not a field map -
edit it as JSON" note) rather than returning `[]` and letting the next write erase it.

---

## 15. One failed workflow-metadata fetch poisons the builder for the rest of the session

`web/src/components/workflows/useWorkflowMeta.ts:7-18`

```ts
let cached: WorkflowMeta | null = null;
let inflight: Promise<WorkflowMeta> | null = null;

useEffect(() => {
  if (cached) { setMeta(cached); return; }
  inflight ??= get<WorkflowMeta>("workflow-meta").then((m) => (cached = m));
  inflight.then(setMeta).catch((e) => setError(String((e as Error).message)));
}, []);
```

`inflight` is set once and never cleared. On success that is harmless - `cached` short-circuits the next mount.
On **failure** the rejected promise stays in the module variable forever: `cached` is still null, so every
later mount falls to `inflight ??=`, finds the settled rejection already there, skips the request, and
re-renders the same error. A single transient 5xx or a dropped connection on the first visit to Workflows
leaves the builder metadata-less for the whole SPA session - navigating away and back never retries, because
nothing in the app reloads the page.

What that costs is not just the error line. Every dropdown in the builder reads `meta`:

- the trigger list (`WorkflowBuilder.tsx:59-64`) is empty, so no rule can be created or retargeted;
- the resource and verb lists in the apiCall editor (`ActionList.tsx:354`, `:421`, `:428`) are empty;
- `variablesFor` (`useWorkflowMeta.ts:32-33`) returns only the five generic tokens, so the `{{ }}` picker
  silently stops offering the trigger's own fields;
- `ConditionBuilder`'s field list (`:20`) collapses to `employeeId`/`subject`/`actorId`, and its operator list
  falls back to a hardcoded array (`:22`) that can drift from the server's.

Several of those degrade **silently** - a shorter list is not visibly a broken one - so a reader can author and
save a rule against a half-empty catalogue without ever seeing `metaErr`.

**Three sibling module-level caches get this right by catching INSIDE the memo**, so the stored promise always
resolves to a usable value and a failure is a default rather than a permanent error:

```ts
lib/ticketWorkflow.ts:47-54   hydrating ??= readSetting<StateMachine>("ticket-workflow").then(…).catch(() => active);
lib/orgDay.ts:45-48           hydrating ??= readSetting<{timezone?: string}>("attendance").then(…).catch(() => {});
lib/prefs.ts:25-29            loaded    ??= listAll<Row>("preferences").then(…).catch(() => new Map());
```

`useWorkflowMeta` is the one that attaches its `.catch` to the *caller's* derived promise instead
(`inflight.then(setMeta).catch(...)`), which handles the rejection for that render and leaves the rejected
promise itself in the module slot forever.

And both module-level request caches that hold a slot per request clear it no matter how the request ends:

```ts
lib/resourceStore.ts:571-573   .finally(() => { e.inflight = null; });
lib/getCoalescer.ts:186-190    function take(key) { … inflight.delete(key); … }   // called from both settle and fail
```

**Fix.** Same shape here:

```ts
inflight ??= get<WorkflowMeta>("workflow-meta")
  .then((m) => (cached = m))
  .finally(() => { inflight = null; });
```

so the next mount re-requests. (Keeping `cached` as the success memo means a successful fetch still costs one
request per session.)

---

## 16. The quarter heat map renders a sub-pixel shade for small teams-away counts, so most days that have people out look empty

`web/src/components/calendar/QuarterGrid.tsx:45-51`

```tsx
{cover !== "none" && (
  <span
    className={cn("absolute inset-x-0 bottom-0 rounded-[3px] opacity-60", COVER_BAR[cover])}
    style={{ height: `${Math.min(100, Math.round((away / Math.max(1, total)) * 100))}%` }}
    aria-hidden
  />
)}
```

`coverOf` (`lib/leaveCalendar.ts:101-102`) returns `"some"` for **any** `away >= 1`, so the fill renders
whenever anybody is out. Its height is the raw percentage with no floor, on a cell that is `h-7` (28px):

| in-scope team | away | height | pixels |
|---|---|---|---|
| 8 | 1 | 13% | 3.6px - visible |
| 60 | 1 | 2% | 0.6px |
| 100 | 2 | 2% | 0.6px |
| 150 | 1 | 1% | 0.3px |

Below roughly 4% the fill is sub-pixel and, at `opacity-60` over a cell that already has a
`bg-muted/40`/holiday/weekend tint, invisible. So on any org-wide or large-department view, a day with one to
three people out is drawn exactly like a day with nobody out.

That is the one thing this view exists to say. Its own header comment:

> *"at this zoom the question is no longer 'who is out' but 'when is this team actually available', and a
> shaded day answers that in one glance across a planning window a single month is too narrow to show."*

Both sibling views floor the same computation:

```ts
components/calendar/TeamGrid.tsx:137   height: `${Math.max(12, Math.min(100, (away / Math.max(1, total)) * 100))}%`
components/calendar/shared.tsx:32      width:  `${Math.min(100, Math.round(…))}%`   // on a 3px strip with a bg-muted/50 track behind it
```

TeamGrid's `Math.max(12, …)` is the guard QuarterGrid is missing, and CoverStrip at least draws its 1% against
a visible track so the *absence* of fill is legible. The quarter cell has neither.

Nothing else in the cell compensates: there is no count, badge or icon - only the hover card. The
`aria-label` does carry `"${away} of ${total} away"`, so a screen-reader user gets the number a sighted user
cannot see.

**Fix.** Floor it the way TeamGrid does, so "some" always draws something:

```ts
style={{ height: `${Math.max(12, Math.min(100, (away / Math.max(1, total)) * 100))}%` }}
```

(Separately, that `aria-label` is the only one of the four calendar grids to announce the raw ISO date -
`MonthGrid.tsx:136` uses `longDate(ymd)` and `YearGrid.tsx:78` uses `dmy(ymd)`. A screen reader reads
"2026-09-13" as digits.)

---

## 17. The leave-balance forecast reads "today" in UTC, so around every org midnight it forecasts the wrong period - and double-counts a credit the cron already made

`web/src/lib/leaveForecast.ts:24`, `:39`, `:46`, `:52`, `:81`, `:91`, `:99`, `:106`, `:114`

The module's own header states the invariant it is built to hold:

> *"The arithmetic is the SERVER'S (src/domain/leave.ts accrual, src/domain/carryForward.ts split) imported
> directly rather than restated here - a forecast that disagrees with the cron that later runs it is worse than
> no forecast."*

It imports the arithmetic and then restates the **clock**, which is the half the server was deliberately moved
off:

```ts
export function forecastBalance(…, now = new Date()) {
  const yearEndMs = Date.UTC(now.getUTCFullYear(), 11, 31);
  … lastAccrualYm: frequency === "semi_monthly" ? `${ymOf(+now)}-H${now.getUTCDate() >= 16 ? 2 : 1}` : ymOf(+now),
function nextCreditDate(now: Date, frequency: AccrualFrequency) {
  const y = now.getUTCFullYear(); const m = now.getUTCMonth();
  if (frequency === "semi_monthly" && now.getUTCDate() < 16) return ymd(new Date(Date.UTC(y, m, 16)));
  return ymd(new Date(Date.UTC(y, m + 1, 1)));
```

Neither call site passes `now` (`pages/Leaves.tsx:579`, `:750`), so it is the viewer's wall clock read in UTC.

The cron this is forecasting anchors on the **org's** calendar day, and says why at length
(`src/services/leaveAccrual.ts:29-42`):

> *"WHICH DAY IT IS, in the ORG's timezone and off the injected clock - not `Date.now()` in UTC, which is what
> this used to be. … `computeAccrual` keys the credited month off `currentMs` read in UTC … so on the 1st of a
> month the new month's entitlement was credited a day early - the same class of bug services/orgDay.ts exists
> to end, and carry-forward (which runs immediately before this in the same tick) already goes through."*

```ts
const now = dayStartMs(await orgToday(deps));
```

In IST the two clocks disagree for the first 5.5 hours of every org day, and that is exactly when the cron
has just run. Two concrete results:

**1 Sep 2026, 02:00 IST** (UTC is still `2026-08-31T20:30Z`). The cron credited September at org midnight, so
`balance.balance_days` already contains it. But `ymOf(+now)` is `"2026-08"`, so `lastAccrualYm` says August was
the last credited period and `remaining` runs **September through December - four credits**. The September
credit is counted twice, and `yearEnd` on the card is a whole month's accrual too high. `nextCreditDate` then
announces "next credit: 1 Sep" for a credit that landed two hours ago.

The same reading breaks the ledger beside it: `accrualEntriesThisYear` loops `for (let m = 0; m <= now.getUTCMonth(); m++)` (`:52`), so it stops at August and the list of credits does not add up to the balance printed above it.

**1 Jan 2027, 02:00 IST** (UTC `2026-12-31T20:30Z`). `now.getUTCFullYear()` is 2026, so `yearEndMs` is 31 Dec
**2026** and `accrualEntriesThisYear` lists last year's twelve credits as "this year". The `excess` line then
warns the reader how many days they are about to lose at a year end that passed two hours ago - and, because
carry-forward runs in the same org-day tick as the accrual, has already been settled.

Leave days are encashable, so this is a number about money, shown on the card people check before booking.

The client already has the org clock, in a module whose doc names this precise failure
(`web/src/lib/orgDay.ts:4-10`):

> *"Twenty-odd files each defined `const todayStr = () => new Date().toISOString().slice(0, 10)`, which is the
> day in UTC - not the viewer's day and not the org's. … The server was moved off UTC deliberately; this is the
> half that was left behind."*

**Fix.** Anchor on the org day the same way `dayStartMs` does, and derive every part from that string rather
than from a live Date:

```ts
import { todayStr } from "./orgDay";

// The org's calendar day anchored at UTC midnight - the same instant `dayStartMs(orgToday())` produces server-side.
const orgNow = (now?: Date) => new Date(now ? now.getTime() : Date.parse(`${todayStr()}T00:00:00Z`));
```

then keep the existing `getUTC*` reads, which are now correct because the instant is the org day's own
midnight. The `now` parameter stays for tests. Both call sites in `Leaves.tsx` need no change.

---

## 18. The encashment form's cap guardrail disagrees with the server three ways, and it blocks submission

`web/src/pages/LeaveEncashments.tsx:81`, `:84-95`, `:108`, `:114`

```ts
const yearStart = `${new Date().getFullYear()}-01-01`;

const encashedThisYear = useMemo(() => {
  …
  .filter((r) => ["PENDING", "APPROVED", "PAID"].includes(upper(r.state)) && (r.create_time ?? "") >= yearStart)
  .reduce((n, r) => n + (r.days || 0), 0);
}, …);
const yearCap = selectedType?.encashment_cap_days_per_year ?? null;
const capLeft = yearCap != null ? Math.max(0, yearCap - encashedThisYear) : null;
const maxEncashable = selectedBalance == null ? null : Math.max(0, Math.min(selectedBalance - retained, capLeft ?? Infinity));
```

and it is not advisory - it gates the button:

```ts
const canSubmit = … && (maxEncashable == null || daysNum <= maxEncashable);   // :108
```

The comment above it says these are the rules "that bound how many days can actually be encashed right now".
Compared with `src/services/leaveEncashments.ts:198-213`, which is what actually decides, it is wrong on all
three inputs.

**a. The year is the viewer's, not the org's.** The server passes `await orgYear(deps)` and the function it
passes it to spells out why (`src/services/leaveEncashments.ts:103-112`):

> *"The year is the ORG's (services/orgDay `orgYear`) … `created_at` is an instant, not a date-only column, so
> the window has to be the org's year and not UTC's … against the PREVIOUS year's cap, which both
> under-counted this year's usage (letting an employee encash past the annual cap) and over-counted last
> year's."*

`new Date().getFullYear()` is the **viewer's** local year, which is a third clock again - wrong against the
org for part of every New Year's Eve/Day, in whichever direction the viewer's offset runs. `paidThisYear`
(`:114`) uses the same window for its stat.

**b. It counts PENDING; the server counts only what is committed.** `encashedDaysThisYear` is documented as
"Days already committed (APPROVED or PAID)" and filters to those states. The client adds `PENDING`, so one
un-decided request shrinks `capLeft` in the UI by days the server has not charged against the cap. Combined
with (a)'s gate, an employee with a pending request cannot submit a second one the server would accept - the
button is simply disabled, and `whyNot` says nothing because the blocker is inside `canSubmit`.

**c. Cumulative mode is not handled at all.** The server branches on the org policy
(`src/services/leaveEncashments.ts:202-205`):

```ts
const cumulative = caps.encashment_mode === "cumulative";
const capDays = cumulative ? caps.encashment_cumulative_cap_days : lt.encashmentCapDaysPerYear;
const alreadyEncashed = … await encashedDaysThisYear(deps, employeeId, await orgYear(deps), cumulative ? undefined : leaveTypeId);
```

so in cumulative mode there is **one org cap measured across every leave type**. The page has no occurrence of
`cumulative` or `encashment_mode` anywhere; it always reads the per-type field and counts only the selected
type. With a cumulative policy set, the form offers a number that ignores every other type's usage, and the
create call then fails a `failedPrecondition` the reader was told they were inside.

The codebase already draws exactly this distinction elsewhere and refuses to guess -
`web/src/lib/leaveForecast.ts:121-126`:

> *"Cumulative mode shares ONE cap across every eligible type, so a per-type figure would be a guess - say
> nothing about the excess rather than mis-state it."*

**Fix.** `settings/leave_caps` is already read on the client (`pages/Leaves.tsx:145` reads its carry-forward
half), so all three are available:

1. `const yearStart = \`${thisYearStr()}-01-01\`;` from `lib/orgDay`.
2. Count `["APPROVED", "PAID"]` only, matching `encashedDaysThisYear`.
3. Read `encashment_mode` / `encashment_cumulative_cap_days` from `leave_caps`; in cumulative mode use that cap
   and drop the `leave_type` filter from `encashedThisYear`.

If the cumulative figures cannot be had, take `leaveForecast`'s posture: leave `capLeft` null (so the gate
falls away) and let the server's `failedPrecondition` be the authority, rather than blocking on a number known
to be for the wrong policy.

---

## 19. Abandoning a date-range drag outside the calendar leaves the anchor live: the grid shows one day, the form holds two, and the next click extends the old range

`web/src/components/common/DateRangeCalendar.tsx:84-88`, `:118-133`, `:164-167`

The gesture state machine has two exits and each one cleans up the **other** exit's state.

**Drag that ends inside the grid** - `releaseDay` clears `anchor` and `hover` but leaves `dragged.current`
true:

```ts
function releaseDay(ymd: string) {
  if (dragged.current && pressedOn.current && pressedOn.current !== ymd) {
    setAnchor(null);
    setHover(null);
    if (!disabled(ymd)) onSelect(orient(pressedOn.current, ymd));
  }
  pressedOn.current = null;          // dragged.current is never reset here
}
```

A mouse click recovers, because `pressDay` resets `dragged` on pointerdown. The **keyboard** does not:
`pick()` opens with `if (dragged.current) { dragged.current = false; return; }`, so the first Enter or Space
after any mouse drag is swallowed and the reader has to press it twice.

**Drag that ends outside the grid** - the container handler clears `dragged` but leaves `anchor`:

```tsx
onPointerLeave={() => { pressedOn.current = null; dragged.current = false; setHover(null); }}
```

with the comment

> *"Releasing outside the grid ends the gesture: clear the drag too, or the next click would be swallowed as if
> it were the end of one."*

It fixed the swallowed click and left the anchor behind, which is worse, because `preview` falls through to
its single-day branch:

```ts
const preview = useMemo(() => {
  if (anchor && hover) return anchor <= hover ? { start: anchor, end: hover } : { start: hover, end: anchor };
  if (anchor) return { start: anchor, end: anchor };      // <- hover was just cleared, so this is what draws
  return start && end ? { start, end } : null;
}, [anchor, hover, start, end]);
```

So after pressing on the 3rd, dragging to the 9th and leaving the calendar to release - the ordinary way to
abandon a drag - the state is:

- the parent has been told `{start: "…-03", end: "…-09"}` by the last `enterDay`, so the date inputs beside the
  calendar read 3 → 9;
- `range={preview}` draws **only the 3rd** selected, because `anchor` is set and `hover` is not;
- `anchor` is still `"…-03"`, so the next click - which the reader means as "start again on the 15th" - is
  taken as closing a range and emits `{start: "…-03", end: "…-15"}`.

On the dialog this feeds (leave requests), that range is the number of days being booked.

**Fix.** Make each exit clear the whole gesture. `releaseDay` should end with `dragged.current = false;`
alongside `pressedOn.current = null`, and `onPointerLeave` should clear the anchor too:

```tsx
onPointerLeave={() => {
  pressedOn.current = null;
  dragged.current = false;
  setHover(null);
  setAnchor(null);          // a drag that left the grid is finished, not half-open
}}
```

With `anchor` cleared, `preview` falls to its `start && end` branch and draws the range the parent actually
holds, and the next click starts a fresh selection.

(While here: the day buttons' accessible name is the raw ISO string - `aria-label={\`${ymd}…\`}` at `:296` -
so a screen reader on a date picker announces "2026-09-13" as digits. `MonthGrid.tsx:136` uses `longDate`.)

---

## 20. The ATS pages build their name lookups from a 100-row window, so older cards render as "Candidate" with no role - and no page admits it

`web/src/pages/Pipeline.tsx:45-49`, `:55`, `:75-97`; `Offers.tsx:65`, `:73-75`, `:101-103`, `:137-138`;
`Interviews.tsx:57`, `:66-68`, `:77-101`; `Candidates.tsx:44`, `:51`; `Requisitions.tsx:63`, `:67`, `:89-90`

`useCollection`'s own documentation names this failure and the flag that prevents it
(`web/src/hooks/useCollection.ts:76-84`):

> *"`all: true` - follow the cursor to the end … For the readers whose answer is WRONG rather than merely short
> on a window: a picker that cannot offer the hundred-and-first employee, **a `new Map(employees.map(...))`
> name lookup that renders "Employee" for everyone past the page**, a grid with one row per person. Those are
> not list pages - there is no "load more" for a reader to press and nothing on screen that reads as
> incomplete - so the fetch has to be the one that completes itself."*

Every one of these pages applies that rule to `employees` and to nothing else:

```ts
Pipeline.tsx:832       useCollection<Employee>("employees", { all: true })      // <- the rule, known
Pipeline.tsx:48        useCollection<Candidate>("candidates", { enabled: apps.length > 0 })
Pipeline.tsx:49        useCollection<JobRequisition>("job-requisitions", { enabled: apps.length > 0 })
Pipeline.tsx:76-77     const m = new Map(candidates.map((c) => [idOf(c.path), c.name]));
                       return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Candidate" : "");
Pipeline.tsx:96-97     const m = new Map(reqs.map((r) => [idOf(r.path), r.title]));
                       return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "" : "");
```

The placeholder in the documented failure is already written into the code.

Pages are 100 rows over a `(create_time, uid)` **descending** sort (`src/http/pagination.ts:43-46`,
`clampPageSize`), so what is in the window is the hundred **newest** rows - and an application that has been
active for a few months is labelled from a candidate record that is not among the hundred newest candidates.
In a pipeline that sees a hundred new applicants a quarter, which is an ordinary rate, cards on the board
start reading:

> **Candidate** · *(no role)*

with a working drawer behind them. Nothing about that says "we could not load this"; it reads as a record with
a missing name.

`Interviews.tsx` chains two windows, so it fails twice over (`:77-79`, `:89-91`):

```ts
const cName = new Map(candidates.map((c) => [idOf(c.path), c.name]));
const m = new Map(apps.map((a) => [idOf(a.path), a]));
return (appRef?: string) => { const a = appRef ? m.get(idOf(appRef)) : undefined; return a?.candidate ? cName.get(idOf(a.candidate)) ?? "Candidate" : ""; };
```

An interview whose **application** is past the applications window resolves to `""` for the candidate *and*
`""` for the role - so the card shows an interview scheduled with nobody, for nothing.

The board's own rows are a window too: `apps` (`Pipeline.tsx:45`), `rows` in `Offers`/`Interviews`/
`Candidates`/`Requisitions`, and `boardOffers` (`Pipeline.tsx:55`, which feeds the `liveOffer` map). The KPI
strip counts off `apps`, so "N applications in the pipeline" is "N of the newest hundred".

**And none of these pages renders a `TruncationNotice`**, which exists precisely for the views that are not
tables and says of itself (`components/common/TruncationNotice.tsx:10-11`):

> *"DataTable derives this itself … this is for the views that aren't tables. Renders nothing at all when the
> collection fits in one page, **so it is safe to drop in unconditionally**."*

Eleven pages use it (`Leaves`, `Payslips`, `OrgChart`, `Documents`, `Reimbursements`, `Overtime`,
`LeaveCalendar`, …). The whole ATS uses none.

The same shape, outside the ATS:

| file | windowed read | what it feeds |
|---|---|---|
| `Onboarding.tsx:46` | `transition-tasks` | the **"Your tasks"** to-do list at the top of the page, filtered client-side to `status === "TODO"` (`:114`) - so a reader's open tasks can be entirely outside the window, and the section renders empty |
| `Onboarding.tsx:45` | `transitions` | the card list, sorted client-side by state (`:116`), so an ACTIVE process past the window never appears |
| `Reviews.tsx:83`, `:88` | `review-cycles`, `review-feedback` | cycle lookup (`:108`) and the feedback queue |
| `Schedule.tsx:38`, `:44` | `shifts`, `holidays` | `shiftById` (`:111`) - every roster cell's shift label, which falls back to the literal `"Shift"` (`:278`). This page *does* warn about truncation, but its banner covers only the roster and the employee walk (`:215-220`); a shift or holiday past the window is not in it |
| `Benefits.tsx:41` | `benefit-enrollments` | per-plan enrolment state |

The `departments` reads on several of these same pages (`Referrals.tsx:87`, `Requisitions.tsx:65`,
`Schedule.tsx:42`, `Reviews.tsx:87`, `ReviewCycles.tsx:87`) are the same defect and are covered in full by
finding 2 - they are listed there rather than repeated here.

**Fix.** Two mechanical changes, both already in the codebase:

1. Add `{ all: true }` to every read whose rows become a `new Map(...)` lookup or a picker - `candidates`,
   `applications`, `job-requisitions`, `offers`, `departments`, `review-cycles`, `shifts`, `holidays`,
   `benefit-enrollments`, `transition-tasks`.
2. Drop `<TruncationNotice collection={[…]} what="…" />` at the top of each of these pages, naming the
   collections the view is assembled from (it accepts an array for exactly that). It renders nothing when
   everything fits, and `all: true` still leaves `hasMore` true at `ALL_CAP`, so the two are complements, not
   alternatives - which is what the notice's own doc says at `:15-19`.

---

## 21. Spreading a shift across the week stops at the first failure, never reloads, and the retry is guaranteed to 409

`web/src/pages/Schedule.tsx:327-343`, `:390-393` (the dialog's `save`), `src/db/schema.ts:1412-1418`

```ts
// Failures propagate: the dialog stays open and pins the reason in the form, which is where the data
// that caused it still is.
onSave={async (shiftRef, note, dates) => {
  for (const d of dates) {
    const at = cellFor(editing.employee, d);
    if (at) await patch(`shift-assignments/${idOf(at.path)}`, { shift: shiftRef, note: note || "" }, at.etag);
    else await create("shift-assignments", { employee: editing.employee, shift: shiftRef, date: d, note: note || undefined });
  }
  toast({ title: dates.length > 1 ? `${dates.length} days scheduled` : … });
  setEditing(null); void load();
}}
```

"Same shift Mon-Fri" is the dialog's headline feature - its own comment calls day-by-day rostering "the tedious
part". If any one day fails, the loop throws out of the middle:

- the days before it **are written** and the days after it are not;
- `void load()` is on the success path only, so `assignments` - and therefore `byCell` and `cellFor` - keep the
  state from before the save;
- the dialog stays open with `dates` still Mon-Fri and the error pinned, inviting a retry.

The retry cannot work. `cellFor` still reports Monday empty, so the loop calls `create` for a day that now has
a row, and `shift_assignments` has a partial unique index on `(employee_id, date)` (`src/db/schema.ts:1418`)
which the service checks explicitly (`src/services/shiftAssignments.ts:76`):

```ts
if (await rosteredOn(deps, employeeId, date)) throw alreadyExists(`that employee is already rostered on ${input.date} - change the existing entry instead`);
```

So pressing Save again fails on **Monday** - a day the scheduler believes they just failed to book - with a
message telling them to change an entry they cannot see, because the grid behind the dialog has not reloaded.
The only way out is to close the dialog (losing the day selection and the note), let the grid refresh, and
work out by eye which days landed.

Nothing on screen ever says which days were written. The success toast is the only report, and it is
unreachable on this path.

This is not a knowledge gap - the codebase has the helper for exactly this, and its header says so
(`web/src/lib/batchRun.ts:8-9`):

> *"A batch where record 12 fails must not report success, and must not stop either: each failure is collected
> with the name it belongs to, so the caller can say exactly who was missed."*

**Fix.** Use `runSequential` and reload unconditionally:

```ts
onSave={async (shiftRef, note, dates) => {
  const res = await runSequential(dates, (d) => dayFull(d), async (d) => {
    const at = cellFor(editing.employee, d);
    if (at) await patch(`shift-assignments/${idOf(at.path)}`, { shift: shiftRef, note: note || "" }, at.etag);
    else await create("shift-assignments", { employee: editing.employee, shift: shiftRef, date: d, note: note || undefined });
  });
  void load();                                    // whatever happened, the grid must show it
  if (res.failures.length) throw new Error(`${batchSummary(res, "day")} ${res.failures.map((f) => f.label).join(", ")}`);
  toast({ title: … }); setEditing(null);
}}
```

The dialog then stays open only for the days that genuinely failed, names them, and - because the grid has
reloaded - a retry patches the rows that exist instead of re-creating them. (The `onRemove` handler directly
below has the same success-only `void load()` at `:354`, but it is a single write, so it fails cleanly.)

---

## 22. Working a Saturday makes the attendance grid call you late, "under hours", and a full day further behind

`web/src/lib/attendance.ts:236-247`, `:202-211`; `web/src/pages/Attendance.tsx:85-112`

`buildAttendanceRows` decides what a day is by testing for punches **first**:

```ts
for (const day of enumerateDays(fromYmd, toYmd)) {
  …
  if (s || credit > 0) {
    const total = (s?.workedMinutes ?? 0) + credit;
    const status = dayStatus(s, total, sched);       // <- the weekday shift window, unconditionally
    …
  } else if (!sched.work_days.includes(weekdayOf(day))) {
    continue;                                        // <- work_days is only consulted for days with NO punch
  } else if (holidays.has(day)) {
    rows.push({ day, status: "holiday" });
  } …
```

So `work_days` and `holidays` gate only the **empty** days. A day that has punches is judged against
`shift_start`, `shift_end`, `grace_minutes`, `half_day_minutes` and `full_day_minutes` whether or not anyone was
supposed to be working. For the default schedule (Mon-Fri, 09:00-18:00, half 240, full 480):

| what happened | status shown | pill |
|---|---|---|
| Saturday, popped in for 2 hours | `insufficient` → **"Under hours"** | `destructive`, rose (`:322`) |
| Saturday, 6 hours | `half_day` → **"Half day"** | `warning`, amber |
| Saturday, full 8 hours from 11:00 | `late` → **"Late"** | `warning`, amber |
| punched on a company holiday | same ladder - never reaches the `"holiday"` branch at `:250` | |

The server never measures any of those days. `lopDayUnits` skips them on its first line
(`src/domain/attendance.ts:246`):

```ts
if (!workDays.includes(weekdayOf(d)) || holidays.has(d)) continue;
```

and so does `workingDaysInRange` (`:128-129`). Nothing is docked; nothing is even counted. The grid is showing a
violation for work that earns nothing but goodwill.

**This file states that agreement as its own invariant**, twice. Its header (`lib/attendance.ts:3-6`):

> *"The server's own leave-coverage rule, imported rather than mirrored … a copy of this particular rule is what
> let the grid and the payroll build disagree about which days leave excuses."*

and at `:193-196`, on why `half_day_leave` exists at all:

> *"It is deliberately distinct from `on_leave`: they are the two sides of the drift this grid used to have with
> `lopDayUnits`."*

The drift was closed for leave and left open for the working week.

**It reaches the month's headline numbers too.** `statsOf` (`pages/Attendance.tsx:85-112`) excludes only
holiday and on-leave rows:

```ts
const counts = r.status !== "holiday" && r.status !== "on_leave";
if (counts) workingDays++;
if (counts && r.day < todayYmd) expectedDays++;
…
if (!s.open) { judged++; if (!s.late) punctual++; }
if (r.status === "late" || r.status === "late_early") late++;
…
expectedMinutes: expectedDays * fullDayMinutes,
```

A punched Saturday is not `holiday` and not `on_leave`, so it passes every one of those:

- **`workingDays`** gains a day the server's `workingDaysInRange` does not count;
- **`expectedMinutes`** gains a whole `full_day_minutes` - so coming in on a Saturday moves the "done vs
  expected" bar **backwards**, because 2 hours of voluntary work added 8 hours of expectation;
- **`late`** and **`onTimePct`** both take the verdict, so a Saturday arrival after 09:15 lowers the reader's
  punctuality score for the month.

A holiday that was worked does the same, because it never gets the `"holiday"` status that `counts` filters on.

**Fix.** Let the schedule decide the day's *kind* before the punches decide its *quality*. In
`buildAttendanceRows`, test the calendar first and keep the worked minutes:

```ts
const offDay = !sched.work_days.includes(weekdayOf(day)) || holidays.has(day);
if (s || credit > 0) {
  const total = (s?.workedMinutes ?? 0) + credit;
  const status = offDay ? "worked_off_day" : dayStatus(s, total, sched);
  …
}
```

with a new `worked_off_day` entry in `STATUS_UI` ("Worked - not a working day", `badge: "secondary"`, the
violet/teal end of the palette rather than amber or rose), and add it to `statsOf`'s exclusion beside `holiday`
and `on_leave` so it stops inflating `workingDays`, `expectedMinutes`, `late` and `onTimePct`. The minutes
should still show on the row and in `minutes`/`doneMinutes` - the hours were worked; they just were not owed.

---

## 23. Retrying a failed holiday bulk-add turns optional and half-day holidays into company-wide closures

`web/src/components/holidays/BulkAddDialog.tsx:76`, `web/src/lib/holidayBulk.ts:62-67`

The failure path rewrites the textarea with just the rows that failed, so the operator can fix and resubmit:

```ts
// Leave the failures in the box so they can be fixed and re-submitted; drop what succeeded.
setText(failed.map((f) => `${f.draft.date}  ${f.draft.name}`).join("\n"));
```

That line serialises **two** of the draft's five fields. `kind`, `half_day` and `location` are not written at
all, so on the retry every re-submitted holiday comes back as `kind: "fixed"`, `half_day: false`,
`location: null`.

`fixed` versus `optional` is not cosmetic in this app - it is the difference between a closure and an
elective day, and the rest of the codebase treats it that way:

```ts
// pages/Schedule.tsx:158-160
// date -> the fixed holiday falling on it. Optional holidays are elective, so they are not closures and
// rostering across one is not a mistake worth flagging.
for (const h of holidays) if (h.date && !h.delete_time && h.kind !== "optional") m.set(h.date, h);
```

and `components/holidays/YearGrid.tsx:115` renders an optional day as "· optional" / "· picked" precisely
because the employee chooses it. So an admin who pastes a year of holidays, hits one transient failure, and
presses the button again has quietly converted those rows into days off for everybody - which then feed the
leave calendar, the attendance grid's `holidays` set, and `workingDaysInRange` on the payroll side.

**And the format it writes cannot carry the flags even if they were added**, because `parseHolidayLines` only
recognises them when the line has a separator:

```ts
const parts = /[\t|,]/.test(trimmed)
  ? trimmed.split(/\s*[\t|,]\s*/)                      // fields -> flags are matched per field
  : (() => {
      const [first, ...rest] = trimmed.split(/\s+/);
      return [first ?? "", rest.join(" ")];            // everything after the date collapses into ONE field
    })();
```

In the whitespace form there is exactly one field after the date, so no flag can ever match it. The module's
own documentation advertises that form anyway (`holidayBulk.ts:47-49`):

```
 *     2026-01-26, Republic Day
 *     26/01/2026 | Republic Day | optional | half day | Mumbai
 *     2026-03-04  Holi  optional              <-- the third example does not work
```

Verified:

```
"2026-03-04  Holi  optional"  -> { name: "Holi optional", kind: "fixed", half_day: false, location: null }
"2026-03-04 Holi half day"    -> { name: "Holi half day", kind: "fixed", half_day: false, location: null }
"2026-03-04, Holi, optional"  -> { name: "Holi",          kind: "optional", half_day: false, location: null }
```

so that paste creates a *fixed* holiday literally named "Holi optional". `test/holidayBulk.test.ts:31-35`
covers only the pipe and comma forms, which is why it passes.

**Fix.** Two changes:

1. Round-trip the whole draft, in the separator form the parser actually supports:

```ts
const toLine = (d: HolidayDraft) =>
  [d.date, d.name, ...(d.kind === "optional" ? ["optional"] : []), ...(d.half_day ? ["half day"] : []), ...(d.location ? [d.location] : [])].join(", ");
setText(failed.map((f) => toLine(f.draft)).join("\n"));
```

2. Either make the whitespace branch split flags off the tail as well, or delete the third example from the
doc comment so it stops promising a form that silently produces a wrong holiday. The first is better - a plain
text paste is exactly what people have - and needs only that the trailing tokens be tested against the flag
patterns before the remainder is taken as the name. Add a test for the whitespace-with-flags line either way.

---

## 24. The 80C headroom in the declaration dialog is computed from the KPI-filtered rows, so clicking a tile first makes it overstate what is left

`web/src/pages/TaxDeclarations.tsx:244-250`, `:76`, `:285-287`, `:330-332`

The dialog's cap note is fed from `items`:

```ts
sameSectionTotal={(section) =>
  items
    .filter((d) => mine(d) && d.section === section && (dialog === "new" || d.path !== dialog.path))
    .reduce((s, d) => s + (d.status === "VERIFIED" ? d.verified_amount ?? d.declared_amount : d.declared_amount), 0)
}
```

and `items` is the KPI-**focused** list, not the year's list:

```ts
const items = useMemo(() => kf.apply(inYear), [inYear, kf.focus]);   // :76
// lib/kpiFocus.ts:33
apply: (rows: T[]) => (focus ? rows.filter(specs[focus].match) : rows),
```

The prop's own contract says otherwise (`:267`):

> *"What this employee has already declared under the chosen section this year, excluding the row being edited."*

So pressing any tile in the summary strip - "Awaiting verification", "Rejected", "No proof attached",
"Verified" - narrows the set the headroom is subtracted from, while the "Add declaration" button in the header
stays available throughout. With ₹1,20,000 already declared under 80C, focusing "Rejected" (say one ₹10,000
row) makes the dialog say:

> *80C caps at ₹1,50,000 a year. You've already declared ₹10,000 under it, so ₹1,40,000 is left.*

when ₹30,000 is left. `overCap` (`:287`) goes quiet for the same reason, so the "Anything past the cap won't
reduce your tax" warning does not fire either.

`useKpiFocus` keeps the focus in the URL (`?focus=<key>`, `lib/kpiFocus.ts:6-7`) specifically so a narrowed
page survives a reload and can be linked - so the wrong figure is not only reachable by a stray click, it is
reachable by opening a bookmark.

What makes this worth fixing rather than tolerating is that the note exists to prevent exactly the error it
now causes (`:327-328`):

> *"The cap is the thing people get wrong: they declare the full premium under a section already filled by PF
> and EPS, and wonder why their tax didn't move."*

**Fix.** Sum over the year, not over the current view:

```ts
sameSectionTotal={(section) =>
  inYear
    .filter((d) => mine(d) && d.section === section && (dialog === "new" || d.path !== dialog.path))
    .reduce(…)
}
```

`inYear` (`:62`) is already in scope and is the set the prop's doc describes. (It is still one page of the
collection, but that is admitted by the `TruncationNotice` at `:144`; the KPI filter is not admitted anywhere.)

---

## 25. Both compensation cards print two different CTCs for the same revision, because the history table divides while the headline uses the priced figure

`web/src/components/common/MyCompensation.tsx:48`, `:150`;
`web/src/components/common/EmployeeCompensation.tsx:205`, `:496`, `:578`

`MyCompensation` takes its headline from the server's priced monthly CTC and its history row from arithmetic on
the stored annual:

```ts
const ctcTotal = current ? (unit === "annual" ? current.annual_ctc : current.ctc_monthly ?? current.annual_ctc / 12) : 0;   // :48
…
<td data-label={`CTC (${unit})`} …>{money(r.annual_ctc / (unit === "annual" ? 1 : 12))}</td>                                  // :150
```

`rows.map` includes the `current` row (it is the one badged "current"), so in **monthly** mode - the default
(`:31`) - the same revision is printed twice from two different numbers. And those two numbers are **documented
not to agree**.

`annual_ctc` is the target as typed (`src/services/compensation.ts:375`, `:464` store `ctcAnnual: annualCtc`
verbatim). `ctc_monthly` is what the split could actually reach:

```ts
// src/domain/payroll.ts:240
const ctcMonthly = round2(lines.reduce((s, l) => s + (l.aboveCtc ? 0 : l.monthly), 0));
// src/domain/payroll.ts:333
return bestResidual <= CTC_TOL ? { basePay, specialAllowance: bestPlug } : null;
```

and `CTC_TOL` is one rupee, on purpose (`src/domain/payroll.ts:270-276`):

> *"ONE RUPEE, and the reason is the staircase rather than the arithmetic. Some targets are not attainable at
> all: ESI is rounded UP to the next rupee (ESIC's own rule, domain/statutory.ts), so the CTC curve climbs in
> one-rupee steps and a target can land in the gap between two of them. The closest reachable split is the right
> answer there - **it is off by under a rupee on a figure entered in whole currency** …"*

So for any revision whose target falls in one of those gaps, the card reads:

> **Cost to company**
> **₹83,334** a month · effective 2026-04-01
> …
> **Salary history**
> 2026-04-01 · **₹83,333** · current

Two different salaries, six inches apart, on the page an employee opens to find out what they are paid. There
is nothing to distinguish which one is right.

The module's header is explicit that it does not do this:

> *"no client-side split math … The build-up arrives priced on the resource (`breakdown` / `ctc_monthly`, from
> the same domain function the CTC letter and the payroll run use)."*

Line 150 is the client-side derivation that sentence disclaims.

**`EmployeeCompensation` has the same split and multiplies the error by twelve.** Its build-up total is the
derived monthly figure scaled by the unit (`:496`):

```ts
<span className="text-lg font-bold tabular-nums">{money(breakdown.ctcMonthly * mult, cc)}</span>   // mult = 12 in annual mode
```

while its history table (`:578`) is the same `r.annual_ctc / (unit === "annual" ? 1 : 12)`. In **annual** mode
the build-up totals `ctcMonthly * 12` and the history row shows `annual_ctc`, so the sub-rupee monthly residual
is rendered as a difference of up to **twelve rupees** between the annual CTC in the build-up and the annual CTC
in the table directly beneath it. This is the HR card - the one used to check a revision before it is approved.

**Fix.** One number per revision, from the server. In both tables:

```ts
{money(unit === "annual" ? r.annual_ctc : (r.ctc_monthly ?? r.annual_ctc / 12), …)}
```

`ctc_monthly` is only attached to the current row of a single-employee read
(`src/http/serialize.ts:1078-1082`), so the `?? annual_ctc / 12` fallback still covers the historical rows -
but the current row, which is the one the headline is also describing, then agrees with itself. For
`EmployeeCompensation`, either show `annual_ctc` as the annual build-up total instead of `ctcMonthly * 12`, or
label the build-up total as the priced cost and the history column as the contracted CTC so the two are not
read as the same quantity.

---

## 26. A card picture that fails to load is hidden by writing to the DOM, and never comes back when a good one is picked

`web/src/components/common/CardSticker.tsx:760-774`; `PostCardBody.tsx:60-79`, `:91`;
`KudosCardBody.tsx:153`

```tsx
export function StickerImage({ url, onAspect }: { url: string; onAspect?: (a: number) => void }) {
  return (
    <img
      src={url}
      …
      onError={(e) => { e.currentTarget.style.display = "none"; }}
    />
  );
}
```

The hide is an imperative write to a node React owns, and there is no `style` prop and no `key` on `url` at
either call site (`PostCardBody.tsx:77`, `KudosCardBody.tsx:153`), so:

- React reuses the **same** `<img>` element when `url` changes - it only patches `src`;
- nothing ever clears `style.display`, because React has no idea it was set;
- `onLoad` fires for the new picture and updates `aspect`, but the element stays `display: none`.

So once any picture on a card 404s, **every** picture picked afterwards is invisible until the component
unmounts. In the composer that means: open a kudos whose stored `illustration` names a file no longer in the
bundle, watch the card show nothing, pick a different sticker from the tile row - still nothing. The author has
no way to tell the picture from the picker.

**The layout does not collapse with it**, which is what makes it read as broken rather than empty. Everything
else keys off `artUrl` being truthy, not off the image having loaded (`PostCardBody.tsx:60-66`):

```ts
const floated   = !!artUrl && isWrapped(wrap);
const banded    = !!artUrl && wrap === "top-bottom";
const beside    = !!artUrl && wrap === "inline";
const twoColumn = !!artUrl && needsColumns(stickerLayout, POST_STICKER_LAYOUT);
…
<CardCanvas reserve={artUrl ? reserveFor(stickerLayout, POST_STICKER_LAYOUT, aspect) || undefined : undefined}>
```

so the card still reserves the picture's height (`reserve`), still floats the words around a box that draws
nothing, and - in the middle position - still **splits the body into two columns** with an empty gutter between
them. The reader gets a card whose text has been broken in half around nothing.

`CardSticker`'s own header says a failed trace should degrade to "no shape, so the mode falls back to wrapping
the box … it is decoration" (`:167-168`). A failed *image* is not given the same treatment.

**Fix.** Make the failure state real state, and let it clear itself when the URL changes:

```tsx
export function StickerImage({ url, onAspect }: { url: string; onAspect?: (a: number) => void }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);      // a new picture is not the old one's failure
  if (broken) return null;
  return <img src={url} … onLoad={…} onError={() => setBroken(true)} />;
}
```

and hoist that outcome to the card, so `floated` / `banded` / `beside` / `twoColumn` / `reserve` all read
"there is a picture" rather than "there is a URL" - a `onBroken` callback beside the existing `onAspect` is
enough. A card with a picture that will not load should lay out as a card with no picture.

The same imperative hide appears at `pages/Dashboard.tsx:1537`, on a row keyed by the announcement rather than
by the picture, so it has the same stuck-hidden behaviour if that row's `illustration` changes under a live
refresh. The two picker grids (`StickerField.tsx:143`, `KudosArtPicker.tsx:48`) do the same thing but are keyed
per art file, so a new picture is a new node there and they are unaffected.

---

## 27. The API-keys panel documents a privilege-escalation hole that was closed, in the present tense, on the one screen keys are audited from

`web/src/components/common/ApiKeysPanel.tsx:113-124`

```
// A scope has three axes and `max_level` is only one of them: custom methods are gated by `verbs`, and the
// ceiling does not apply to them (domain/keyScope.ts `inScope` checks the collection and the verb list, never
// the level - a verb is not on the read/write/admin ladder). So a key minted with `max_level: "read"` and the
// "Allow actions" box ticked can approve a leave request and publish a payroll run, and this column called it
// "read only, all collections".
```

Every claim in that paragraph is now false, and the file it names is where the fix lives
(`src/domain/keyScope.ts:131-140`):

```ts
const VERBS_NEED = "write" as const;
export const verbsAllowedAt = (maxLevel: Level): boolean => LVL[VERBS_NEED] <= LVL[maxLevel];
…
export function inScope(r: Resolved, scope: KeyScope): boolean {
  if (!collectionAllowed(scope, firstToken(r.resource))) return false;
  if (r.kind === "standard") return LVL[r.level] <= LVL[scope.maxLevel];
  // The LEVEL CEILING APPLIES TO A VERB TOO - see verbsAllowedAt. …
  if (!verbsAllowedAt(scope.maxLevel)) return false;
  return scope.verbs === "*" || scope.verbs.includes(r.verb);
}
```

It is closed on all four surfaces: `inScope` refuses the request, `narrowAllow` (`:93-98`) drops every allow
pattern for a read-ceilinged scope, `parseScope` (`:178`) empties the `verbs` axis when it reads one back, and
`services/apiKeys.ts` refuses the combination at mint. The panel's own UI enforces it too - `:512` clears
`allowVerbs` when the level drops to read, `:621` disables the checkbox, and `:633` explains why:

> *"Unavailable on a read-only key: an action runs a service, so it counts as a write. Raise the access level
> to allow actions."*

So the code around this comment is right and the comment contradicts it, in the present tense, with a worked
example ("can approve a leave request and publish a payroll run"). This is the screen an admin opens to audit
machine credentials. The next reader either re-fixes something already fixed, or reads it as evidence that
`max_level` cannot be trusted and widens a key's scope to compensate - which is the outcome the ceiling exists
to prevent.

The rest of the block - why `scopeSummary` names the actions axis at all, and why the list and the mint
sentence must use the same words - is still true and worth keeping.

**Fix.** Restate it as the rule rather than as a defect report, e.g.:

```
// THE ACTIONS AXIS BELONGS IN THIS SENTENCE. A scope has three axes and `max_level` is only one of them:
// custom methods are gated by `verbs`, and a key that carries them can approve a leave request or publish a
// payroll run. (The level ceiling does bound them - a verb counts as a write, so a read-ceilinged scope holds
// no verbs at all; see domain/keyScope.ts verbsAllowedAt.) Naming only the level called such a key
// "read & write, all collections" and left the actions unsaid, in the list a key minted months ago is
// actually looked at.
```

---

## 28. The team timeline's tooltips still say "Tomorrow" about the column it has ringed as today

`web/src/components/common/TeamTimeline.tsx:163-169`, and its seven call sites

The grid was moved onto the org's calendar day and the tooltip helper was not:

```ts
// Relative ETA for a calendar date vs today (both as UTC days, matching the timeline's columns).
const relDay = (ymd?: string): string => {
  if (!ymd) return "";
  const now = new Date();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return relFromDays(Math.round((parseYmd(ymd) - todayMs) / DAY_MS));
};
```

The parenthetical is no longer true. The columns are anchored on `todayStr()` (`:227`, `:263-265`), and the
file says so twice:

```ts
const todayYmd = orgToday;   // the ORG's day; the UTC one this replaced disagreed for part of every day  :263
// Off the same clock as the window's anchor, so the "today" column and the window can't disagree.
const todayCol = colOf(Date.parse(`${todayYmd}T00:00:00Z`));                                              :265
```

and `weekStartUtc`'s header (`:171-178`) documents the identical fix for the window:

> *"It used to take `Date.now()` and read the UTC calendar off it, so for an IST org the week rolled over 5½
> hours late: between 00:00 and 05:30 the timeline's "this week" was still last week's window while
> `todayStr()` - which every other surface uses … - had already moved on."*

`relDay` is the one that was left behind, and it feeds the `eta` chip on almost every tooltip on the widget:

| line | tooltip |
|---|---|
| `:401` | the attendance dot for a day ("Full day · Today") |
| `:420` | a holiday |
| `:428` | a leave pill - `todayY < start ? relDay(start) : todayY <= end ? "Ongoing" : relDay(end)`, so the **branch** uses the org day and the **phrase** uses the UTC day |
| `:457` | a calendar event |
| `:1018` | a new joiner |
| `:1023` | a probation ending |

For an IST org between 00:00 and 05:30 the UTC date is still yesterday, so every one of those is one day out:

- hovering the attendance dot in the column ringed as **today** gives an `eta` of **"Tomorrow"**;
- a leave starting tomorrow reads **"in 2 days"**;
- a probation ending today reads **"Tomorrow"**.

And the two clocks are visibly side by side: the per-column "N away" tooltip at `:800` uses
`relFromDays(i - todayCol)`, which **is** org-anchored, so the column header and the pills inside that same
column disagree about what day it is.

**Fix.** Read the same clock the grid does:

```ts
const relDay = (ymd?: string): string =>
  ymd ? relFromDays(Math.round((parseYmd(ymd) - Date.parse(`${todayStr()}T00:00:00Z`)) / DAY_MS)) : "";
```

`todayStr` is already imported at `:5`, and both sides are then UTC-anchored calendar days, which is the unit
`parseYmd` and the columns are in. The comment on line 163 should say "vs the ORG's today" so the next reader
does not re-derive the UTC one.

---

## 29. The dashboard's team timeline reads one page of attendance, so the older half of the fortnight shows everybody as "No log"

`web/src/components/common/TeamTimeline.tsx:233-241`, `:330-391`

```ts
const [sessions, setSessions] = useState<AttendanceSession[]>([]);
useEffect(() => {
  let live = true;
  const q = `attendance?from=${encodeURIComponent(new Date(startMs).toISOString())}&to=${encodeURIComponent(new Date(endMs).toISOString())}`;
  get<{ results: AttendanceSession[] }>(q)
    .then((r) => live && setSessions(r.results ?? []))
    …
}, [startMs, endMs, refreshKey]);
```

A bare `get`, with no `max_page_size` and no cursor. The server's default page is **50**
(`src/http/pagination.ts:41`, `clampPageSize = Math.min(Math.max(n ?? 50, 1), 100)`) and the list is keyset-paged
**most recent first** (`src/services/attendance.ts:34-42`):

> *"Most recent first (open sessions and today's punches surface at the top), keyed on the PUNCH rather than the
> row's creation …"*

The widget's window is **14 days × every employee the caller can see**. Two punches per person per working day
is the shape this table has (`src/services/attendance.ts:26-28` calls it "the highest-volume table in the app,
two rows per employee per working day"). So:

| team size | sessions in a 14-day window (1 session/day) | fetched |
|---|---|---|
| 4 | ~56 | 50 |
| 8 | ~112 | 50 |
| 20 | ~280 | 50 |

Everything past the newest 50 is simply absent from `sessions`, and `statusByEmp` (`:330-391`) hands whatever
arrived to `buildAttendanceRows`. A past working day with no session, no leave and no holiday is classified
`absent` (`lib/attendance.ts:260-261`), which on this widget is:

```ts
absent: "bg-red-400",              // STATUS_DOT   :105
absent: "No log",                  // STATUS_LABEL :120
absent: "text-red-600 …",          // STATUS_TEXT  :137
```

So for any team bigger than about four people, the left-hand (older) days of the timeline fill with red **"No
log"** dots for employees who did clock in - on the Dashboard, which is the surface a manager looks at. Paging
back (`page`, `:224`) refetches and truncates the same way, so the past is never recoverable by scrolling.

**Every other attendance-window read in the app follows the cursor**, through a helper written for exactly this:

```ts
// web/src/lib/clock.tsx:17-35
export async function listAllSessions(query: string): Promise<AttendanceSession[]> {
  …
  for (let i = 0; i < 10; i++) {
    const page = await get<…>(`${query}&max_page_size=100${pageToken ? … : ""}`);
    all.push(...(page.results ?? []));
    …
  }
}
```

used by `pages/Attendance.tsx:375`, `:388`, `:424` and `pages/Overtime.tsx:147`. `TeamTimeline` is the only
attendance-window read in the codebase that does not use it, and `src/services/attendance.ts:29` names that
helper by path when explaining the server-side paging - so the two were written with each other in mind.

**Fix.** One import and one call:

```ts
import { useClock, listAllSessions } from "@/lib/clock";
…
listAllSessions(`attendance?from=${encodeURIComponent(new Date(startMs).toISOString())}&to=${encodeURIComponent(new Date(endMs).toISOString())}`)
  .then((rows) => live && setSessions(rows))
  .catch(() => live && setSessions([]));
```

`listAllSessions` caps at ten pages of 100, so a very large team still truncates - and because a missing
session reads as an accusation rather than as a gap, that case is worth saying out loud: when the walk stops on
its page ceiling, the widget should suppress the `absent` status (leave the cell blank) rather than print "No
log" for days it did not load.

---

## 30. "Nothing in stock" is printed whenever the 50 newest assets happen to be issued

`web/src/components/common/EmployeeAssets.tsx:89-98`, `:255-260`

The assign-a-device picker is built by reading the assets collection and filtering it in the browser:

```ts
function openAssign(request?: AssetRequest) {
  setPick(""); setOn(today()); setPool(null); setIssuing(request ?? null); setOpen(true);
  get<{ results: Asset[] }>("assets")
    .then((r) => {
      const stock = (r.results ?? []).filter((a) => a.status === "in_stock");
      …
      setPool(…);
    })
    …
}
```

A bare `get` with no page size and no cursor: the server default is 50 (`src/http/pagination.ts:41`), keyset
paged **newest first**. So `stock` is "whichever of the 50 most recently created assets are in stock", and the
route offers no way to narrow it server-side - `listAssets` accepts only `employee`
(`src/routes/assets.ts:115-123`), never `status`.

Recently-added kit is the kit most likely to have been handed out, so the newest 50 skewing toward `assigned`
is the **normal** state of an asset register, not an edge case. When it happens the dialog says, in as many
words (`:260`):

> **Nothing in stock. Add stock on the Assets page.**

which sends HR to buy hardware they already own. There is no "load more", no truncation notice, and no hint
that the list is a window - `pool.length === 0` is presented as a fact about the inventory.

The same read also silently caps the picker in the ordinary case: with 200 assets and 60 in stock, the dialog
offers at most the handful of those that fall inside the newest 50.

`api.ts` already has the walk this needs, and it is used for exactly this shape elsewhere
(`components/access/subjectOptions.ts:14-15`, `AclModal.tsx:167-176`, `lib/prefs.ts:25`):

```ts
// api.ts:468
export async function listAll<T>(collection: string): Promise<T[]> { … }   // follows the cursor, 100/page, 50 pages
```

**Fix.** Either walk the collection:

```ts
listAll<Asset>("assets")
  .then((rows) => { const stock = rows.filter((a) => a.status === "in_stock"); … })
```

or - better, since this is the read that grows with the register - add `status` to `listAssets`' filters
alongside `employee` and ask the server for `assets?status=in_stock`, which is one indexed query instead of up
to fifty pages. Either way, the empty state must distinguish "nothing is in stock" from "nothing in stock was
loaded"; the current sentence asserts the first and is shown for the second.

---

## 31. Changing a task's status from its dialog makes the next Save report a conflict with the person who made it

`web/src/pages/Boards.tsx:1357-1371`, and the rule it misses at `:1321-1326`

Every other write in this dialog sends the live etag and takes the new one back. `moveStatus` does neither:

```ts
async function moveStatus(toCol: string, undoing = false) {
  const from = curColumn;
  setBusy(true);
  try {
    await invoke(`cards/${idOf(card!.path)}`, "move", undefined, { to_column: toCol });   // no etag in, none out
    setCurColumn(toCol);
    …
```

The rule it breaks is stated four functions above it, in `act` (`:1321-1326`):

> *"Take the etag the write just produced. Every verb here bumps the card's updated_at, which IS the etag, so
> dropping the response left this dialog holding a stale one - and the next Save reported a conflict with
> "somebody else" who was in fact the same person, one click earlier. todoAct and addComment already did this;
> act and submit did not."*

Four functions were audited against that rule and fixed. `moveStatus` was not - and the comment immediately
above `act` even points at it by name ("`invoke` already invalidates the cards cache (see `moveStatus`
below)").

The dialog keeps one live `etag` in state (`:1033`) and refreshes it after every other write (`:1189`, `:1201`,
`:1215`, `:1257`, `:1296`, `:1329`). So:

1. Open a task from the board.
2. Pick a different status from the dialog's picker. The server bumps `updated_at`; `etag` here does not move.
3. Edit the title and press **Save**.

`patch(..., etag)` now carries the pre-move version, the server refuses it, and the catch at `:1303-1309` says:

> **"Somebody else changed this task while you had it open. What they changed is listed below - press Save again
> to overwrite it."**

with a diff banner showing the change the reader made themselves, from that same dialog, seconds earlier. The
**Delete** button has the same problem - `remove(..., etag)` at `:1348` - and so does Block/Unblock
(`act`, `:1329`), which is the function whose comment describes the bug.

**The write is also unguarded in the other direction.** `moveCard` reads `If-Match`
(`src/routes/cards.ts:107` → `src/services/cards.ts:672` `checkEtag(row, ifMatch)`), and both of the board's own
drag-and-drop moves pass it:

```ts
Boards.tsx:631   await invoke<CardT>(`cards/${id}`, "move", card.etag, move);
Boards.tsx:643   await invoke<CardT>(`cards/${idOf(card.path)}`, "move", card.etag, { to_column: toCol, rank });
```

so a status change from the dialog silently overwrites a concurrent move that a drag on the board would have
refused. And the Undo offered in the toast re-invokes with `from` - the column *this dialog* last knew about -
so undoing after someone else moved the card puts it back to a stale place.

**Fix.** The same two lines every sibling has:

```ts
const res = await invoke<CardT>(`cards/${idOf(card!.path)}`, "move", etag, { to_column: toCol });
setEtag(res.etag);
setCurColumn(toCol);
```

and give it the conflict handling the Save path already has, so a genuine lost race says so instead of moving
the card anyway.

---

## 32. The "this allow is already denied" warning covers three of the four ACL editors, and not the one for custom methods

`web/src/components/access/AclModal.tsx:421-425` vs `:382-387` and `:488-491`

Three of the modal's four grant paths lint an allow against an existing deny before writing it. The role-level
editor (`:382-387`):

```ts
// Authoring an allow where a deny already covers the target writes a DEAD rule: the dropdown will read
// "write" and the person still gets 403. Say so before it lands, not after someone debugs it.
if (value !== "none" && value !== "deny") {
  const blocker = denyBlocking({ subject_kind: "role", subject: name, collection: collection ?? "", scope: scopeSel, field, verb: activeVerb }, rules);
  if (blocker && !(await confirm({ title: "A deny is already in place", … }))) return;
}
```

and `addUserRule` (`:488-491`) does the same for people, in both level and verb mode (`:494` picks
`verbBody` or `levelBody` off `verbMode`).

`setRoleVerb` - the per-role dropdown in verb mode (`:1022`) - has only the destructive-deny confirm and no
lint at all:

```ts
async function setRoleVerb(name: string, v: string, value: string) {
  if (value === "deny") {
    const ok = await confirm({ title: `Deny ${roleLabel(name)} the "${v}" method here?`, description: await impactLine(), destructive: true, confirmLabel: "Deny" });
    if (!ok) return;
  }
  setBusy(true);
  // …straight to the delete-then-create, no denyBlocking
```

`denyBlocking` already takes a verb (`ruleLogic.ts:143-149`), matches on it (`sameTarget`, `:80-82`), and
folds in the `everyone` pseudo-role (`appliesToSameSubject`, `:87-91`). So an admin who denies a role
`approve` at the collection scope and later grants that role `approve` on one object gets a dropdown reading
**allow**, a person who still gets a 403, and no warning - which is the exact outcome the comment above
`setRoleLevel` says the lint exists to prevent.

`ruleFlags` does mark the rule `denied` afterwards (`ruleLogic.ts:105-112`), but it is rendered only in
`FineRulesEditor` (`FineRulesEditor.tsx:131`), not on the role matrix where the rule was authored - so the
badge is not where the admin is looking when they make the change.

**Fix.** The same three lines, with `v` as the verb:

```ts
if (value !== "none" && value !== "deny") {
  const blocker = denyBlocking({ subject_kind: "role", subject: name, collection: collection ?? "", scope: scopeSel, field, verb: v }, rules);
  if (blocker && !(await confirm({ title: "A deny is already in place", description: `${ruleSentence(blocker, roleLabel(blocker.subject))}. A deny always wins, so this allow will have NO effect until that rule is removed. Add it anyway?`, confirmLabel: "Add anyway" }))) return;
}
```

(Separately, `sameTarget` compares verbs with `(a.verb ?? "") === (b.verb ?? "")`, so a wildcard `verb: "*"`
deny is not matched against a specific-verb allow by either the lint or `ruleFlags` - a broad "deny all custom
methods" rule therefore silences neither. Widening that comparison to treat `ALL_VERBS` as covering any verb
would close the same gap on both surfaces at once.)

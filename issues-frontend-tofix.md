# Frontend review - live findings (continued)

Continues `issues-new.md` (findings 1-32). Numbering carries on so cross-references stay valid.
Appended as each issue is confirmed.

---

## 33. Approving a pending access rule is the one change in the ACL modal with neither a confirm nor an undo

`web/src/components/access/AclModal.tsx:536-546`, `:836-840`, `:996-997`;
`web/src/components/common/PermissionsPanel.tsx:73-83`;
`web/src/components/access/SubjectPermissionsDialog.tsx:138-148`

Three identical copies of the four-eyes decision handler, none of which asks:

```ts
async function decide(r: AccessRule, decision: "approve" | "reject") {
  setBusy(true);
  try {
    await invoke("access-rules", decision, undefined, { rule: r.path });
    toast({ title: decision === "approve" ? "Change approved" : "Change rejected", variant: "success" });
    await reload();
  } catch (e) { … }
}
```

`approve` and `reject` are both members of `Decision` in `lib/confirmDecision.ts:14`, and that module states the
rule they are the archetype of (`:5-8`):

> *"A decision is not an edit: approving, rejecting or cancelling a request lands in somebody's notifications,
> moves money or time off, and cannot be taken back from the same button that made it. Those all deserve the
> same beat of friction, and they were spread across a dozen pages as bare one-click handlers - so the copy
> lives here and every page asks the same way."*

Approving a pending rule is the step that makes a grant **live**; the server announces an allow to its subject
(`src/services/accessRules.ts:174`), and once approved the buttons are gone, so it cannot be taken back from
where it was made.

**What makes it stand out is that everything around it is guarded.** In the same file:

| action | guard |
|---|---|
| deny a role / person | `confirm` with a live impact line (`:379`, `:423`) - "Right now N people can see this…" |
| author an allow a deny would kill | `confirm` (`:384-387`) |
| remove a rule | `confirm` + impact line (`:521-524`) |
| any successful rule change | 8-second **Undo** toast (`undoable`, `:360-375`) |
| **approve / reject a pending change** | nothing |

`undoable`'s own comment says why the others have it:

> *"Every rule change is one click from being taken back. Permissions are exactly the kind of edit where the
> wrong pick is noticed one second later, and an 8s Undo beats reconstructing the previous rule by hand."*

So the modal adds friction before *proposing* a change and none before *approving* one - and the approval is the
half that takes effect. `SubjectPermissionsDialog` draws the same line for its own matrix (`:151-154`):

> *"Two directions of this dropdown are worth stopping for: taking access away … and handing out admin (the
> widest thing this dialog can do)."*

and then approves a pending rule - which can be either of those things - with no stop at all.

**The target is also tiny.** One of the two AclModal call sites renders the pair as bare 11px text links
(`:996-997`):

```tsx
<button type="button" disabled={busy} onClick={() => decide(pendingRule, "approve")} className="text-[11px] font-medium text-emerald-700 …">approve</button>
<button type="button" disabled={busy} onClick={() => decide(pendingRule, "reject")} className="text-[11px] font-medium text-destructive …">reject</button>
```

Two 11px words, adjacent, opposite in effect, both irreversible, with no confirm between the press and the
write. The other site (`:836-840`) is a pair of icon buttons whose only label is a `title`.

**Fix.** Route all three through the shared copy, with the rule itself as the subject so the dialog cannot be
mistaken for the row above or below (which is what `confirmDecision`'s `subject` argument is for, `:18-19`):

```ts
async function decide(r: AccessRule, decision: "approve" | "reject") {
  if (!(await confirmDecision(confirm, decision, ruleSentence(r, subjectLabel(r))))) return;
  …
}
```

`ruleSentence` is already imported in `AclModal` and `SubjectPermissionsDialog` and is what the deny-lint uses
to name a rule in prose. For `approve`, `impactLine()` would be a better description still - it already exists
in `AclModal` and states how many people the change affects.

---

## 34. The per-user permissions matrix loads one page of users, on the line after the comment explaining why roles must not

`web/src/components/common/PermissionsPanel.tsx:95-101`, `:241-244`, `:483-486`;
`web/src/components/common/RolesManagePanel.tsx:41`, `:57-61`, `:136-141`

```ts
// Every role, not the first page: a rule whose subject is a role past the cap would otherwise render
// as a bare machine name here and be missing from the copy-permissions picker entirely.
const [ro, us] = await Promise.all([listAll<Role>("roles"), list<User>("users")]);
registerRoleLabels(ro);
setRoles(ro);
setUsers(us.results.map((u) => ({ path: u.path, email: u.email })));
setRules(await fetchAllAccessRules());
```

`listAll` for roles, bare `list` for users - in the same destructuring, one argument apart. `list()` sends
`max_page_size=100` (`api.ts:398`), so `users` is the **first hundred** login accounts and nothing follows the
cursor.

What those rows are is not a label; it is the editor. `userMatrixCols` (`:242-244`) builds one row per user
with `levelCell("user", u.path, c, u.email)` in every collection column - the control that authors, changes and
removes that person's per-user access rules. So for an org past a hundred accounts:

- a person outside the window **has no row**, and their per-user grants cannot be seen or changed from this
  panel at all;
- any existing rule whose subject is such a user is invisible here, while the roles half of the same screen is
  guaranteed complete - so the matrix reads as the whole access model and is not;
- the `everyoneLevel` / `narrowerCount` context columns are computed per row, so they simply never run for
  those people.

There is no truncation affordance either: the table is rendered without `accessCollection`
(`:486`), which is what makes `DataTable` admit a window. The comment beside it says the opposite twice
(`:241`, `:483`):

> *"Users matrix: one row per user (DataTable paginates them), one column per collection."*

`DataTable` pages the rows it is **handed**; it cannot page a collection it never fetched. A reader clicking to
page 3 of a 100-row table has no way to know the other 400 accounts were never asked for.

**The same read feeds a destructive confirm one file over.** `RolesManagePanel` counts role holders from its own
single page of users (`:41`, `:57-61`):

```ts
const { rows: users } = useCollection<User>("users");
…
const userCount = useMemo(() => { const m = new Map<string, number>(); for (const u of users) if (u.role) m.set(u.role, (m.get(u.role) ?? 0) + 1); return m; }, [users]);
```

and `del` (`:136-141`) branches the wording on it:

```ts
const inUse = userCount.get(r.name) ?? 0;
const ok = await confirm({
  title: `Delete role "${r.label}"?`,
  description: inUse ? `${inUse} user${inUse === 1 ? "" : "s"} still have this role - reassign them first.` : "This removes the role and all its permission rules.",
```

A role held only by accounts outside the window counts **0**, so the dialog says "This removes the role and all
its permission rules" about a role that is in active use. The server refuses the delete (roles still held by a
user cannot be deleted - `:35`), so nothing is lost; the operator is simply told the opposite of the truth and
then given a failure they were not prepared for. The "Users" column in that table is wrong by the same amount.

**A third surface reads the same window.** `components/common/RolesPanel.tsx:32` is the Users table itself
(`useCollection<User>("users")`, no `all`), and its `DataTable` at `:170` carries no `accessCollection`, so the
list of login accounts presents its first hundred as all of them with no notice. The same rows also build the
"is this employee already linked to a login?" hint (`:47-56`):

```ts
const heldBy = new Map<string, string>();
for (const u of rows) if (u.employee && u.path !== editing?.path) heldBy.set(idOf(u.employee), u.email);
…
label: `${e.first_name} ${e.last_name}${holder ? ` · already linked to ${holder}` : ""}`
```

so past a hundred accounts the warning silently stops appearing and an admin links a second login to an
employee who already has one - the one thing that hint exists to prevent.

**Fix.** `listAll<User>("users")` in `PermissionsPanel.reload` - the helper is already imported on that line for
roles - and `{ all: true }` on `RolesManagePanel`'s and `RolesPanel`'s `useCollection<User>("users")`, plus
`accessCollection="users"` on the Users table. Both are catalog-sized reads
behind an admin screen, which is the case `useCollection`'s `all` doc calls "readers whose answer is WRONG
rather than merely short". Correct the two comments that claim DataTable is paginating the collection, and add
`accessCollection="users"` to the matrix so the ceiling at `ALL_CAP` is still admitted.

---

## 35. An employee's document file is read as "the newest 100 documents in the org, then filtered" - so to HR it looks empty

`web/src/components/common/EmployeeDocuments.tsx:17-25`;
`web/src/components/common/EmergencyQuickView.tsx:76-83`

Both components want one employee's `personal-documents` and both fetch the collection unfiltered, then filter
in the browser.

```ts
// EmployeeDocuments.tsx:17-25
// Personal (employee-owned) documents; the server scopes the list to what the caller may see, and we
// narrow to this employee. Org-wide documents live on the Documents page, not the profile.
const { rows } = useCollection<DocumentResource>("personal-documents");
…
const docs = useMemo(() => rows.filter((d) => d.employee && idOf(d.employee) === employeeId), [rows, employeeId]);
```

```ts
// EmergencyQuickView.tsx:76-83
async function loadInsurance() {
  try {
    const r = await list<DocumentResource>("personal-documents");
    setInsDocs((r.results ?? []).filter((x) => x.employee === `employees/${employeeId}` && x.document_type === "INSURANCE"));
  } catch { setInsDocs([]); }
}
```

The comment's premise is the bug. The server scope is an **authz** scope, not a per-employee one: it decides
*which rows the caller may see*, not *whose file this is*. For the employee themselves the two coincide (owner
scope returns only their own documents, so the filter is a no-op and everything works). For **HR** - the caller
these panels exist for - the scope is the whole org, so `rows` is the newest 100 personal documents belonging
to everybody, and the client-side filter keeps whichever of them happen to be this person's.

`personal-documents` is the collection that accumulates fastest per head: offer letter, contract, PAN, Aadhaar,
address proof, insurance card, every generated Form 16, every issued letter. A hundred org-wide rows is a few
weeks of a mid-size company. After that, opening a colleague's profile shows a Documents panel that is empty or
missing most of the file, with nothing saying the list was cut - and the emergency panel shows **no insurance
card** for someone who has one, next to an "upload one" affordance that would file a duplicate.

`EmergencyQuickView` is the sharper of the two because it hides its own failure: `uploadInsurance` calls
`loadInsurance()` immediately afterwards (`:93`), and the document it just created is the newest row in the
collection, so it is always inside the first page. The card appears, the flow looks correct, and it disappears
silently some weeks later once a hundred other documents have been filed.

There is also no reason to read other people's document rows to find one person's: the list route already takes
the filter.

```ts
// src/routes/documentRoutes.ts:71
list: (c, page) => svc.list(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, page.showDeleted, c.get("user"), c.req.query("employee") || undefined),
```

and the app passes exactly that filter elsewhere (`pages/EmployeeProfile.tsx:110`, `:129`,
`components/common/GenerateLetterDialog.tsx:137`, `components/common/UploadForm16Button.tsx:33`).

**Fix.** Ask the server for the person, and drop the client-side filter:

```ts
// EmployeeDocuments.tsx
const { rows: docs } = useCollection<DocumentResource>("personal-documents", {
  all: true,
  params: { employee: `employees/${employeeId}` },
});

// EmergencyQuickView.tsx
const r = await list<DocumentResource>("personal-documents", { params: { employee: `employees/${employeeId}` } });
setInsDocs((r.results ?? []).filter((x) => x.document_type === "INSURANCE"));
```

`all: true` on the profile panel because a long-tenured employee's own file can itself pass a page, and the
panel is a file rather than a feed - there is no "load more" on it. This also stops both panels pulling other
people's personal-document rows into the browser, which matters on the one collection
`instrument.ts#SENSITIVE_PAGES` singles out as "scanned identity documents, contracts, insurance cards" and
which `EmployeeDocuments` itself wraps in `sentry-mask` for that reason (`:34-40`).

---

## 36. "Rebalance weights" normalises to 100 across whichever of the owner's goals are on the loaded page

`web/src/pages/Goals.tsx:131`, `:1122-1125`, `:1290-1341`

The dialog is handed its goals by filtering the page's rows:

```ts
<RebalanceDialog
  key={rebalanceFor ?? "none"}
  ownerId={rebalanceFor}
  goals={rebalanceFor ? sortGoals(rows.filter((g) => g.employee && idOf(g.employee) === rebalanceFor && isOpen(g))) : []}
  ownerName={rebalanceFor === me.employee_id ? "your" : `${empName(`employees/${rebalanceFor}`)}'s`}
```

and `rows` is one page of the collection (`:131`):

```ts
const { rows, state, error, reload } = useCollection<Goal>("goals", { params: cycleFilter === "all" ? undefined : { cycle: cycleFilter } });
```

The goals list route takes `status`, `cycle`, `burnup` and `stage` filters but **no `employee`**
(`src/routes/goals.ts:124`), so there is no server-side way to ask for one person's goals - the page reads the
first hundred rows its caller can see and the dialog narrows those in the browser.

For an employee the authz scope is self, so the window is their own handful of goals and the filter is exact.
For a **manager or HR** the scope is the department or the org, and a hundred rows is a small org's single
cycle (50 people × 2-3 goals). Past that, some of the owner's open goals are simply not in `rows`, and the
dialog computes everything from what is left:

```ts
const total = goals.reduce((s, g) => s + val(g), 0);
const lockedTotal = goals.filter((g) => !(g.access?.can ?? []).includes("update")).reduce((s, g) => s + val(g), 0);
const room = Math.max(0, 100 - lockedTotal);
```

`even()` and `normalise()` then spread exactly `room` across the rows it can see, so pressing either one writes
a set of weights that sums to 100 **over a subset** while the owner's missing goals keep their old weights. The
real total goes over 100, and the dialog's own description states the opposite:

> *"Spread {owner} open goals' weights; 100 total is the convention. Completed and cancelled goals don't count."*

That total is not decoration. Goal weights drive weighted attainment in a review cycle, which is what variable
pay is computed from - so an over-100 spread inflates the attainment of whichever goals were on the page.

Both entry points reach it. `:762` opens it for `me.employee_id` and `:1017` for `dialogOwnerId`, i.e. whoever
owns the goal that is open - so a manager rebalancing a report is the ordinary path, and it is the one where
the window is org-wide.

The page does carry a `TruncationNotice` (`:708`), which is the right thing for the list; it says nothing about
the dialog, which is not a list and presents itself as holding the whole set.

**Fix.** Preferably add an `employee` filter to the goals list route beside the four it already has, and have
the dialog fetch the owner's open goals itself - it is a handful of rows and the dialog is user-opened, so the
request is cheap and exact:

```ts
// src/routes/goals.ts
list: (c, page) => listGoals(…, c.req.query("employee") || undefined, …)
```

Failing that, `{ all: true }` on the page read bounds the gap at `ALL_CAP` rather than at one page. Either way
the dialog should refuse to claim completeness it cannot have: when the set it was handed is not known to be
the owner's whole open set, disable `even`/`normalise` and say so, rather than writing a spread that is only
correct if nothing was missing.

---

## 37. A company-wide bonus is listed with the headcount and total of however much of it fits on one page

`web/src/components/common/PayrollBonuses.tsx:35`, `:53-71`, `:82-93`, `:157-179`

```ts
const { rows, state, error, reload } = useCollection<Bonus>("bonuses");          // one page
const { rows: employees } = useCollection<Employee>("employees", { all: true }); // …and the two beside it walk
const { rows: departments } = useCollection<Department>("departments", { all: true });
```

`bonuses` is **one row per recipient**: an `award` with `scope: "company"` creates a row for everybody. So a
200-person company bonus is 200 rows, and the page's single hundred-row window holds half of it.

`entries` (`:53-71`) groups those rows by `batch_id`, and the list renders the group's size and sum
(`:167`, `:173-178`):

```tsx
{e.scope !== "individual" && <Badge variant="secondary">{e.rows.length} {e.rows.length === 1 ? "person" : "people"}</Badge>}
…
<div className="font-medium tabular-nums">{money(b.amount, b.currency_code)}{e.scope !== "individual" ? " ea" : ""}</div>
{e.scope !== "individual" && <div className="text-xs tabular-nums text-muted-foreground">{money(total, b.currency_code)} total</div>}
…
{paidCount === 0 ? "Pending" : paidCount === e.rows.length ? "Paid" : `${paidCount}/${e.rows.length} paid`}
```

`total` is `e.rows.reduce(...)` over the rows that were loaded. Rows are keyset-paged newest-first and a batch
is created in one go, so a batch is contiguous and gets cut at the page boundary. A ₹5,000 award to 200 people
therefore lists as:

> **Company-wide** · `100 people` · **₹5,000 ea** · ₹500,000 total · `100/100 paid`

Half the headcount, half the money, and a "Paid" badge that is complete only over the half it can see. This is
the page whose own description is *"All bonuses … Paid as a taxable earning by the next payroll run."*

**The double-award guard reads the same window.** `duplicate` (`:82-93`) searches `entries` for an award with
the same scope, target, amount and date, and its comment says what it is for:

> *"An award repeated by accident pays twice, and group awards make it easy: same scope, same amount, same
> day."*

After one company-wide award of a couple of hundred people, every award made before it is outside the window,
so the warning at `:245-247` - *"An identical award already exists … Awarding again pays it twice."* - simply
stops appearing. The guard is at its weakest exactly in the situation it names as the dangerous one.

The two reads on the lines below this one both pass `{ all: true }`, and `recipients` (`:95-100`) is built from
that complete employee list - so the confirm dialog's headcount and total are right while the list of what was
already awarded is not. There is no `TruncationNotice` on the page either.

**Fix.** `{ all: true }` on the bonuses read is the one-line version and covers ordinary use (`ALL_CAP` is 1000
rows). Because that ceiling is still reachable on a money list, pair it with
`<TruncationNotice collection="bonuses" what="bonuses" />` and suppress the per-batch **total** and the
`paidCount/rows.length` badge whenever `collectionHasMore("bonuses")` is true - a partial sum printed as a
total is worse than no sum. The durable fix is for the server to return the batch's size and sum on each row
(it already groups them by `batch_id`), so the list never has to add up rows it may not have.

---

## 38. DataTable's money total is the one piece of its chrome that does not admit a truncated set

`web/src/components/common/DataTable.tsx:578-587`, `:1335-1341`, `:1570-1591`, vs `:1064`, `:1190-1194`,
`:1220-1222`, `:1597-1601`

Every other part of the table says out loud when the rows are only the first page. `truncated` (`:564`) is in
scope throughout, and four separate places use it:

```tsx
:1064   {total} row{…} shown{truncated ? " of the records loaded so far" : ""}
:1194   Export …{truncated ? " (only the records loaded on this page)" : ""}
:1220   {truncated && anyFilter ? `No matches in the ${rows.length} loaded records` : emptyTitle}
:1599   {total === 0 ? "No records" : `Showing ${from}-${to} of ${truncated ? `${total}+` : total}`}
:1601   {truncated && !onLoadMore ? " — first page only" : ""}
```

The totals strip does not:

```tsx
// desktop footer, :1583-1587
{col.aggregate === "sum" ? (
  fmtTotal(col, sumOf(filtered, col))
) : col.id === totalLabelColId ? (
  <span className="uppercase tracking-wide text-muted-foreground">Total · {total} row{total === 1 ? "" : "s"}</span>
) : null}

// phone, :1336-1340 - same, with the sums beside the label
```

`sumOf` folds `filtered`, which is the loaded rows after client-side filtering (`:582-585`). The comment above
it explains the half of the problem it does solve (`:579-580`):

> *"Summed over the FILTERED rows, not the visible page: a total that changed when you turned the page would
> answer a question nobody asked."*

but the rows it sums are still one server page, so on a truncated collection the figure is a partial sum
printed as **"Total"**, with no `+`, no note, and an exact row count beside it.

**Every column that uses this is money**:

```
pages/Expenses.tsx:778, :834           amount              formatTotal: money
pages/ExpenseBudgets.tsx:511-516       budget / spent / pending / remaining
pages/TableBuilder.tsx:426             any column of kind "money"
```

and the column doc says this figure is the point of the feature (`:51-54`):

> *"Money columns pass `formatTotal` so the total reads in the same units as the cells - 'what am I looking
> at, in total' is the question a finance table gets asked most, and reaching for a spreadsheet to answer it
> is a page failing."*

So on an Expenses ledger past a hundred rows - which is a few weeks - the page shows, a few pixels apart:

> `Total · 100 rows` · **Amount: ₹4,82,300**
> `Showing 1-25 of 100+ (filtered from 100+)` &nbsp; **[Load more]**

The pager says the set is bigger than it is showing; the total says it is exactly a hundred rows and states a
sum. The second is the number that gets read out in a meeting.

(The bulk-bar total at `:1301-1303` sums `selectedRows` and is exact by construction - a selection is whatever
was ticked. Only the footer strip is affected.)

**Fix.** Mark it the way the pager already does, from the same flag:

```tsx
{col.aggregate === "sum" ? (
  <>{fmtTotal(col, sumOf(filtered, col))}{truncated ? "+" : ""}</>
) : col.id === totalLabelColId ? (
  <span className="uppercase tracking-wide text-muted-foreground">
    Total · {total}{truncated ? "+" : ""} row{total === 1 ? "" : "s"}{truncated ? " loaded" : ""}
  </span>
) : null}
```

A trailing `+` and the word "loaded" are enough: they match the vocabulary the pager and the export button
already use, so the three agree instead of contradicting each other. The same change applies to the phone strip
at `:1336-1340`.

---

## 39. Every board write throws away the card the server hands back, so a second drag inside the refetch window is refused

`web/src/pages/Boards.tsx:631-638`, `:644-652`, `:2263-2299`, against the rule the same file states at
`:1321-1326`

Seven card writes on the board and the sprint planner apply an optimistic row, send the etag, and discard the
response:

```ts
:632   setRows((prev) => prev.map((c) => (idOf(c.path) === id ? { ...c, ...patch } : c)));   // optimistic - etag untouched
:634   await invoke<CardT>(`cards/${id}`, "move", card.etag, move);                          // …result dropped
:646   try { await invoke<CardT>(`cards/${idOf(card.path)}`, "move", card.etag, { to_column: toCol, rank }); }
:651   try { await patch<CardT>(`cards/${idOf(card.path)}`, body as Record<string, unknown>, card.etag); }
:2266  await invoke<CardT>(`cards/${id}`, "move", card.etag, { to_column: colKey, rank, … });
:2283  await invoke<CardT>(`cards/${id}`, "move", card.etag, { to_column: card.column_key, to_sprint: null, … });
:2293  try { await invoke<CardT>(`cards/${idOf(card.path)}`, "move", card.etag, body); }
:2298  try { await patch<CardT>(`cards/${idOf(card.path)}`, body as Record<string, unknown>, card.etag); }
```

The optimistic patch carries only the changed fields, so the row in the store keeps the **pre-write etag**. What
eventually corrects it is the invalidation refetch - `withInvalidation` (`api.ts:322-328`) fires
`affectedCollections("cards", "move")` after the response, which forces a re-read of the collection - and that
is a full round trip.

Inside that window the card on screen has moved and its etag has not. A second write on the same card reads
`cards.find(...)`, sends the stale etag, and the server refuses it (`src/services/cards.ts:672`
`checkEtag(row, ifMatch)`). The catch does the honest thing and makes it visible:

```ts
catch (e) { reload(); toast({ title: "Couldn't move", description: (e as Error).message, variant: "destructive" }); }
```

so the reader gets **"Couldn't move — etag mismatch"** and watches the card snap back to where it was, having
done nothing but drag the same card twice - which on a kanban board (nudge it into a column, then adjust its
position in that column) is an ordinary gesture, not an unusual one.

**The fix is already written, twelve hundred lines down, for the dialog's verbs** (`:1321-1331`):

> *"Take the etag the write just produced. Every verb here bumps the card's updated_at, which IS the etag, so
> dropping the response left this dialog holding a stale one - and the next Save reported a conflict with
> "somebody else" who was in fact the same person, one click earlier. todoAct and addComment already did this;
> act and submit did not."*

```ts
const res = await invoke<CardT>(`cards/${idOf(card!.path)}`, verb, etag, body);
setEtag(res.etag);
```

That audit covered the dialog and stopped there. The board's own writes - the ones used far more often - were
not in it.

**Fix.** Fold the returned card back into the store instead of dropping it. `setRows` is already in hand at
every one of these sites, and the response is the authoritative row (the server may also have adjusted `rank`,
so this makes the optimistic guess exact as well as unblocking the next write):

```ts
setRows((prev) => prev.map((c) => (idOf(c.path) === id ? { ...c, ...patch } : c)));
try {
  const res = await invoke<CardT>(`cards/${id}`, "move", card.etag, move);
  setRows((prev) => prev.map((c) => (c.path === res.path ? res : c)));
} catch (e) { reload(); toast({ … }); }
```

With the fresh row in the store the invalidation refetch becomes a confirmation rather than a correction, and
the window in which a second drag is refused closes entirely.

---

## 40. The rating trend on a shared review can name the wrong previous cycle, in green, because the real one fell off the page

`web/src/pages/Reviews.tsx:82-83`, `:302-318`, `:769-773`, `:259-267`

```ts
const prevRatingFor = useMemo(() => {
  const byEmp = new Map<string, { start: string; rating: number; path: string }[]>();
  for (const r of reviews) {                                   // <- one page of the collection
    if (!r.employee || r.overall_rating == null) continue;
    const start = cycleOf(r.cycle)?.period_start;              // <- …resolved against one page of cycles
    if (!start) continue;
    …
  }
  return (r: Review): number | undefined => {
    …
    const prior = (byEmp.get(idOf(r.employee)) ?? []).filter((x) => x.path !== r.path && x.start < start);
    return prior.sort((a, b) => b.start.localeCompare(a.start))[0]?.rating;   // the most recent prior LOADED
  };
}, [reviews, cycleOf]);
```

and what it renders, next to the overall rating on a shared review (`:769-773`):

```tsx
{prevRating != null && prevRating !== review.overall_rating && (
  <span className={cn("ml-1", review.overall_rating! > prevRating ? "text-success" : "text-destructive")}>
    ({review.overall_rating! > prevRating ? "up" : "down"} from {prevRating})
  </span>
)}
```

`reviews` (`:82`) and `review-cycles` (`:83`) are both single-page reads, keyset-paged **newest first**, and
`reviews` is one row per employee per cycle. A 60-person org running two cycles a year passes a hundred rows
inside the first year - and the rows that fall out are, by construction, **the older cycle**: exactly the ones
`prevRatingFor` exists to find.

Two outcomes, and the second is the bad one:

1. The previous cycle is entirely outside the window → `prior` is empty → no trend at all. A silently missing
   comparison.
2. The previous cycle is outside the window but a cycle **before** it is still in → `prior.sort(...)[0]` is
   that older one, and it is labelled as the comparison. An employee who went 4 → 3 → 4 (rated in three
   cycles, with the middle one aged off the page) is shown, on their current 4:

   > **4** *(up from 3)* &nbsp; ← in green

   when the honest reading is "unchanged from two cycles ago, recovered from a dip". The arrow says "improving"
   about someone whose last cycle it never saw.

`cycleOf` compounds it: a review whose cycle is past the `review-cycles` page has no `period_start`, so
`continue` (`:307`) drops it from `byEmp` even when the review itself was loaded.

**And the page offers no way to reach the missing rows.** `cycleOptions` (`:259-267`) is built by walking
`reviews` and collecting the cycles they name, so a cycle whose reviews all fell off the page is not in the
filter dropdown either - the reader cannot select the previous cycle to check. `Reviews.tsx` renders no
`TruncationNotice`, so nothing on the page says the list is a window.

The same window feeds the rating-distribution chart (`:245-257`), which is offered as the cycle's shape
("Rating distribution … Shared and acknowledged reviews").

**Fix.** A trend is a lookup, not a list, so it should not be inferred from whatever a list page happened to
load. Two options, in order of preference:

1. Have the server put the previous rating on the review (it already attaches `review.goals` scored
   server-side, which the file notes at `:648` is done precisely so "the page never guesses"). One field,
   always right, no extra read.
2. Failing that, `{ all: true }` on both `reviews` and `review-cycles`, plus a `TruncationNotice` - and, when
   the set is known to be incomplete, suppress the trend rather than compute it from a partial history. A
   missing arrow is a non-statement; a green "up from 3" about the wrong cycle is a false one, on the document
   a pay decision is argued from.

---

## 41. "Bring forward" duplicates the carried items when a source retire fails, and writes every check-in without a version

`web/src/pages/CheckIns.tsx:54`, `:149-161`, `:163-183`, `:236`, `:649-657`

```ts
const retireOpenItems = (c: CheckIn) =>
  patch(`check-ins/${idOf(c.path)}`, { action_items: (c.action_items ?? []).map((i) => (i.done ? i : { ...i, done: true })) });

async function bringForward(target: CheckIn) {
  const sources = openByPerson.get(idOf(otherRef(target) ?? "")) ?? [];
  const moved = sources.flatMap((s) => s.items);
  if (!moved.length) return;
  try {
    await patch(`check-ins/${idOf(target.path)}`, {
      action_items: [...(target.action_items ?? []), ...moved.map((i) => ({ text: i.text, done: false }))],
    });
    for (const s of sources) await retireOpenItems(s.c);
    reload();
    toast({ title: `Brought ${moved.length} item${moved.length === 1 ? "" : "s"} forward`, … });
  } catch (e) {
    toast({ title: "Couldn't bring items forward", … });
    reload();
  }
}
```

**a. A retry duplicates.** The copy into the target lands first, then the sources are retired one at a time. If
the retire of source 2 of 3 fails, the state is: target holds items from 1, 2 and 3; source 1 is retired;
sources 2 and 3 still hold theirs as open. The reload then rebuilds `openByPerson` from what the server holds,
so the amber button comes back reading *"N open items from last time · Bring forward"* - and pressing it copies
sources 2 and 3's items into the target **again**. The target ends up with two copies of each, and the reader
has no way to tell a duplicate from a genuinely repeated action item ("follow up with Finance" twice is not
obviously wrong).

This is the same partial-batch shape the codebase has already fixed three times - `Attendance.tsx:426-461`
(`filedThisDialog`), `ExpenseBudgets.tsx:419-450`, `AclModal.tsx:392-416` - and `lib/batchRun.ts#runSequential`
exists for it, with its header stating the rule:

> *"A batch where record 12 fails must not report success, and must not stop either: each failure is collected
> with the name it belongs to, so the caller can say exactly who was missed."*

The ordering is also the wrong way round: retiring a source **after** the copy means a failure leaves items in
two places, while retiring each source immediately after the copy it contributed to (or, better, sending one
write per source-and-target pair) leaves them in one.

**b. No version on any of the three writes.** Both `patch` calls omit the third argument, so no `If-Match` is
sent. A check-in is a pair-private record that **two** people edit - the report and their manager - and
`action_items` is the field they both work in. A manager pressing "Bring forward" while the report is ticking
an item off replaces the whole array with the copy this page read, and the tick is gone with no conflict and no
sign. The rest of the app pins writes like this (`patch(path, body, row.etag)` is the norm, e.g.
`Compliance.tsx:206`, `:221`, `TaxDeclarations.tsx:93`), and `isConflict` + the "somebody else changed this"
recovery is a pattern this codebase already has in five dialogs.

**c. The source list is one page.** `openByPerson` (`:149-161`) walks `rows`, and `check-ins` is read as a
single page (`:54`, no `all`), keyset-paged newest-first. Check-ins are one row per pair per cadence - a manager
with six reports on a weekly rhythm files over 300 a year - so the older meetings, which is where a stranded
action item most likely sits, are exactly what falls out of the window. `carryCount` (`:236`) undercounts and
the amber button simply does not appear for items it cannot see. The page renders no `TruncationNotice`.

**Fix.**

1. Retire each source as part of the same step that copies it, and use `runSequential` so one failure does not
   stop the rest and is reported by name; skip any source already retired on a retry (its items are `done`, so
   `openByPerson` already excludes it - the duplicate arises only because the *target* was written before the
   sources were).
2. Pass the etag on all three writes: `patch(path, body, c.etag)`, with the existing `isConflict` recovery.
3. `{ all: true }` on the `check-ins` read, plus a `TruncationNotice`, so "from last time" means the last time
   and not the last time on this page.

---

## 42. The version guard that stops a tax declaration being verified at an amount nobody reviewed is unreachable: no client sends it, and no endpoint returns it

`web/src/pages/Approvals.tsx:68`, `web/src/components/common/EmployeeTaxDetails.tsx:76`, `:94`;
`src/services/taxDetails.ts:142-155`; `src/services/versionGuard.ts:40-42`

The server guards this write and says at length why (`src/services/taxDetails.ts:143-155`):

> *"VERSION-GUARDED, and here that is load-bearing rather than merely correct. Maker-checker says WHO decides;
> it said nothing about WHAT is being decided. Re-declaring is the subject employee's own action, takes no
> state precondition and resets the record, so **HR could open the queue, read 50,000, click Verify - and stamp
> VERIFIED on the 5,00,000 the employee declared in between**, because `raw` is re-read inside this function and
> `?? raw.priorEmployerIncome` takes whatever it now says. Only VERIFIED figures feed withholding, so the
> amount nobody reviewed is the amount that cuts the tax deducted. And the whole declaration is ONE ENCRYPTED
> BLOB rewritten from a read, so a declare landing between the read and the write was not just decided unseen -
> it was overwritten and gone."*

The guard is a no-op unless the caller sends a header (`src/services/versionGuard.ts:40-42`):

```ts
export function checkEtag(row: VersionedRow, ifMatch?: string): void {
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
}
```

**No client sends one.** Both decision surfaces PATCH with two arguments:

```ts
// Approvals.tsx:68 - the review queue
await patch(`employees/${idOf(v.employee)}/tax`, { values: { action } });
// EmployeeTaxDetails.tsx:94 - the profile panel, same endpoint
setData(await patch<TaxDetails>(`employees/${employeeId}/tax`, { values: { action } }));
// EmployeeTaxDetails.tsx:76 - the employee's own declare, same endpoint
setData(await patch<TaxDetails>(`employees/${employeeId}/tax`, { values }));
```

**And no endpoint gives them one to send.** `GET /v1/employees/:id/tax` returns
`{ path, ...redactedSub(c, "tax", view) }` (`src/routes/employees.ts:226-230`) with no `etag`, and the queue's
payload type has four fields and no version (`src/services/taxDetails.ts:106`):

```ts
export type PendingTaxVerification = { employee: string; employee_name: string; prior_employer_income: number; prior_employer_tds: number };
```

So the guard is dead code reachable only from a hand-made request, and the scenario its comment describes is
live exactly as written:

1. HR opens Approvals. The card prints the figures it is asking them to approve
   (`Approvals.tsx:89`): *"Income ₹50,000 · TDS ₹5,000"*.
2. The employee re-declares ₹5,00,000. The row resets to DECLARED; nothing on HR's open page changes.
3. HR clicks **Verify**. The body is `{ values: { action: "verify" } }` - **no amounts and no version**.
4. `checkEtag(emp, undefined)` does nothing. `raw` is re-read as ₹5,00,000, and
   `verifiedIncome: num(input.verified_income) ?? raw.priorEmployerIncome` takes it
   (`src/services/taxDetails.ts:171-174`).
5. The row is stamped VERIFIED at ₹5,00,000, which is what cuts withholding on the next run.

The reviewer saw ₹50,000, approved ₹50,000, and verified ₹5,00,000, with no conflict, no 409 and no trace that
the figure moved. Verify also asks nothing at all (see finding 5), so there is not even a dialog restating the
amount between the click and the write.

**The same gap is on the three sibling sub-resources**, each of which plumbs `If-Match` through the route into
a `checkEtag` that no client feeds:

| route | server | client |
|---|---|---|
| `PATCH employees/:id/bank-account` | `employees.ts:203` → `bankDetails.ts:93-95` *"the precise 409 for a caller that already knows its read is stale"* | `EmployeeBankDetails.tsx:73` - no etag |
| `PATCH employees/:id/identity` | `employees.ts:214` → `identityDetails.ts:103-105` | `EmployeeIdentityDetails.tsx:69` - no etag |
| `PATCH employees/:id/personal-info` | `employees.ts:240` → `personalDetails.ts:70-72` | `EmployeePersonalDetails.tsx:48`, `EmployeeProfilePersonal.tsx:70`, `EmergencyQuickView.tsx:108` - no etag |

`personal-info` is the sharpest of those three because all three of its callers PATCH the **whole** record -
`EmergencyQuickView.save()` says so in as many words (`:107`: *"Save the full record so the contact fields
(edited elsewhere) are preserved"*) - so an employee updating their emergency contact on `#/profile` and HR
correcting an address on the same person's page are two full-blob writes racing, last one wins, silently.

**Fix.** Two sides, and both are small:

1. Return the employee's `etag` from each sub-resource GET (`{ path, etag, ...redactedSub(...) }`) and include
   it on `PendingTaxVerification`, so a client has a version to hold.
2. Send it: `patch(path, body, view.etag)` at all six call sites, with the `isConflict` recovery the five write
   dialogs already use ("Somebody else changed this while you had it open - press Save again").

For the verify path specifically, send the reviewed figures too -
`{ values: { action: "verify", verified_income, verified_tds } }` - so that even without a version the amount
that is stamped is the amount that was on screen, rather than whatever the re-read finds.

---

## 43. The emergency dialog shows blood group, allergies and medical notes to session replay - the one `personal-info` surface the mask gate does not list

`web/src/components/common/EmergencyQuickView.tsx:154`, `:131-137`, `:183-206`;
`web/src/instrument.ts:104-113`; `test/replayMaskCoverage.test.ts:25-33`

Session replay is **unmask-by-default** in this app (`instrument.ts:76-78`), and the exception for dialogs is a
hand-maintained list of seven components carrying `className="sentry-mask"`:

```
EmployeeBankDetails, EmployeeCompensation, EmployeeTaxDetails, EmployeeSettlement,
EmployeeBonuses, EmployeeIdentityDetails, EmployeePersonalDetails
```

The reason the list exists is stated in both places, and it names the failure mode exactly
(`test/replayMaskCoverage.test.ts:12-15`):

> *"Per-dialog means someone has to remember, which is exactly the kind of thing that gets forgotten in a
> refactor and fails SILENTLY: the dialog still works, the replay still records, and the account number is
> simply in it. So it is asserted here rather than trusted."*

`EmergencyQuickView` is an eighth dialog over the same encrypted sub-resource, and it is on neither list. It
renders a `DialogContent` - a portal, so `instrument.ts`'s `[data-page="…"]` route rule cannot reach it
(`:105-107` says so) - with no `sentry-mask`:

```tsx
:154   <DialogContent scrollBody onEnterSubmit={…}>
```

and what is inside it is the most sensitive personal data the app holds (`:131-137`, `:183-206`):

```
Emergency contact name / phone / relation        (×2)
Blood group
Allergies
Medical notes            hint: "Anything a paramedic should know"
```

`EmployeePersonalDetails` **is** masked, and its entry in the gate reads *"date of birth, address, personal
contact"*. `EmergencyQuickView` reads and PATCHes the very same `employees/<id>/personal-info` record
(`:66`, `:108`) and shows the health fields that one does not - so the surface with the strongest data is the
one outside the protection.

**The replay is not hypothetical exhaust.** "Report a problem" keeps the SDK's replay the moment its dialog
opens and attaches it to a ticket (`ReportProblemDialog.tsx:32`, `:56-64`;
`RecordingChip.tsx:49` → `tickets/<id>:attachRecording`), so a colleague's allergies and medical notes can be
carried into the helpdesk queue by anyone who happened to open the emergency card before reporting an
unrelated bug.

Reachability is ordinary: the dialog is the heart-pulse button on the directory, the employee page and the org
chart (`:23-24` - *"the single place to break glass for somebody's emergency info"*), none of which is in
`SENSITIVE_PAGES` (`instrument.ts:53-71`) - and deliberately so, because the design is that the dialogs carry
their own mask.

**Fix.** One attribute and one line of test:

```tsx
<DialogContent scrollBody className="sentry-mask" onEnterSubmit={…}>
```

```ts
const SENSITIVE_DIALOGS = [
  …,
  "EmergencyQuickView", // emergency contacts, blood group, allergies, medical notes
];
```

Adding it to `SENSITIVE_DIALOGS` is the part that matters beyond this one dialog: the list is the only thing
that makes the next omission visible, and it currently describes seven of the eight surfaces that qualify.

---

## 44. A person's handwritten signature is recorded into session replay as a full data-URL image, on an unmasked route and inside an unmasked dialog

`web/src/components/common/SignatureField.tsx:37-41`, `:112`; `web/src/pages/Profile.tsx:202`;
`web/src/components/common/SignDocumentDialog.tsx:229`; `web/src/instrument.ts:53-71`, `:95-98`

The signature is fetched as a **data URL** and rendered as a plain `<img>`:

```tsx
// SignatureField.tsx:37-41
export function SignatureImage({ employeeId, signature, className }: …) {
  const src = useSignatureUrl(employeeId, signature);        // dataUrl(`employees/${id}`, { verb: "getSignature" })
  if (!signature || !src) return null;
  return <img src={src} alt="Signature" className={className ?? "h-12 object-contain"} />;
}
// :112 - the editor's own preview
<img src={src} alt="Your signature" className="max-h-24 max-w-full object-contain" />
```

Replay records media (`instrument.ts:95-98`):

```ts
maskAllText: false,
maskAllInputs: false,
blockAllMedia: false,
```

so the `src` attribute is serialised into the recording - and because it is a `data:` URL rather than a link,
**the image bytes themselves go into the replay**, not a reference that would need a session to fetch.

Neither place it renders is covered:

| where | route | masked? |
|---|---|---|
| `Profile.tsx:202` - the signature setup card | `#/profile` | **no** - `SENSITIVE_PAGES` is payslips, payroll-runs, documents, reviews, suggestions, check-ins, tax-declarations, background-checks (`instrument.ts:53-71`) |
| `SignDocumentDialog.tsx:229` - shown beside "sign this document" | opened from `#/documents`, which **is** masked | **no** - it is a `DialogContent`, i.e. a portal outside `<main data-page="documents">`, which `instrument.ts:105-107` says the route mask cannot reach |

Neither component carries `sentry-mask` or `data-sentry-mask`, and neither is in
`test/replayMaskCoverage.test.ts`'s list.

`instrument.ts` gives the rule this breaks, in the paragraph directly above the config (`:89-91`):

> *"When adding UI that shows money, an identity number, a bank account, a medical or a document, put
> `data-sentry-mask` on it (or `data-sentry-block` to hide the element entirely) if it can appear outside these
> routes - a dialog opened from the dashboard, a drawer on a board."*

What makes this worse than an ordinary leak is what the image **is**. This app e-signs documents with it: an
`esignature` template block stamps it onto letters and contracts, and `SignedPdfViewer` renders a validity
stamp over the result. A clean, background-free PNG of somebody's signature, extractable from a recording, is
the whole input to forging any of those - and replays are not only held by Sentry: "Report a problem" keeps the
current replay and attaches it to a support ticket (`ReportProblemDialog.tsx:32`, `:56-64`;
`RecordingChip.tsx:49` → `tickets/<id>:attachRecording`), so it lands in the helpdesk queue as an ordinary
attachment.

(The PDF surfaces next to it are fine, and for instructive reasons: `PdfPreviewDialog` hands the file to an
`<iframe>` (`:131`) whose document rrweb does not record, and `PdfReader`/`SignedPdfViewer` draw to `<canvas>`
(`PdfReader.tsx:122-136`, `SignedPdfViewer.tsx:160`), which rrweb leaves blank without `recordCanvas`. It is
only the `<img>` path that is captured.)

**Fix.** Mask both, and add the component to the gate so the next signature surface is caught:

```tsx
return <img src={src} alt="Signature" data-sentry-mask className={…} />;      // SignatureField.tsx:41 and :112
```

`data-sentry-block` would be the stronger choice here - a masked `<img>` still ships the element, and there is
no diagnostic value in seeing a signature's shape - and `SignatureField` should join `SENSITIVE_DIALOGS` (or a
sibling list for non-dialog surfaces) in `test/replayMaskCoverage.test.ts`, which is the only thing that makes
the omission visible next time.

---

## 45. Retrying a partly-failed asset delivery creates the whole delivery again - and the toast tells you to retry

`web/src/components/assets/BulkAddAssets.tsx:89-117`; `src/services/assets.ts:326-380`;
`src/db/schema.ts:2045`

```ts
const calls: Record<string, unknown>[][] =
  mode === "quantity"
    ? batchSizes(form.quantity, PER_CALL).map((n) => [{ ...shared, quantity: n }])
    : chunkList(rows.map((r) => ({ …, serial_number: r.serial })), PER_CALL);

const created: Asset[] = [];
setProgress({ done: 0, total });
try {
  for (const items of calls) {
    const { results } = await invoke<{ results: Asset[] }>("assets", "batchCreate", undefined, { items });
    created.push(...(results ?? []));
    setProgress({ done: created.length, total });
  }
} catch (e) {
  // Whatever landed before the failure is real and already tagged, so say so instead of implying nothing
  // happened - and let WriteDialog show the error with the rest of the list still in the box.
  if (created.length) {
    onCreated(created);
    toast({ variant: "destructive", title: `${created.length} of ${total} added`, description: "The rest were not created - fix the message below and add them." });
  }
  throw e;
}
```

The failure path is honest about what happened and then leaves the form holding **everything**. Nothing removes
the created serials from the textarea, and nothing reduces `form.quantity`. `throw` keeps the dialog open with
the same `form`, so pressing **Add** again rebuilds `calls` from the full list and re-sends the calls that
already succeeded.

- **Quantity mode:** 120 adapters, 80 created, one call fails → retry creates **another 120**. The register
  ends up with 200 assets, each with its own printed tag, each awaiting a check-in scan.
- **Serials mode:** every already-created serial is sent again. `serial_number` is `text("serial_number")` with
  **no unique index** (`src/db/schema.ts:2045`) and `createAssetsBatch` does no duplicate check beyond the
  category's `assertSerial` rule - so the second record is created cleanly. Two asset rows now claim one
  physical device; custody is claimed by scanning the tag (one tag per row), so one of the two can never be
  found, and every stocktake from then on reports it missing.

**The server built the atomicity that makes a correct retry possible, and the client does not use it.** From
`src/services/assets.ts` (the note on the tag-allocation race):

> *"the whole delivery rolled back (**the insert is one atomic batch, which is what makes retrying it safe**)…"*

A failed `batchCreate` call creates nothing, so the boundary is exactly at chunk granularity: the calls before
it landed in full, the failing one landed not at all, the ones after it never ran. "Retrying it" means resending
**that call and the ones after it** - which is precisely what the client does not do.

This is the fourth instance of the same shape in this review (findings 6, 21, 41), and the one with the least
recoverable consequence: a duplicated holiday can be deleted, a duplicated roster entry corrected, but a
second asset record with a real printed tag on nothing is a permanent hole in the inventory.

**Fix.** Track the calls, not just the count, and resume from the first unsent one:

```ts
const doneCalls = useRef(0);           // survives the throw, reset when the dialog closes / the form changes
…
for (let i = doneCalls.current; i < calls.length; i++) {
  const { results } = await invoke<…>("assets", "batchCreate", undefined, { items: calls[i] });
  created.push(...(results ?? []));
  doneCalls.current = i + 1;
  setProgress({ done: created.length, total });
}
```

and make the toast's promise true by narrowing the form to the remainder - drop the created serials from the
textarea, or subtract `created.length` from the quantity - so "add them" adds *them* rather than all of it
again. `lib/assetBulk.ts` already has `batchSizes` and `chunkList`, so the remainder is one slice.

---

## 46. Every Undo toast is capped at 5 seconds: the `duration` option is honoured by the store and then overridden by Radix

`web/src/components/ui/toaster.tsx:25-27`; `web/src/components/ui/use-toast.ts:14-15`, `:34-41`, `:71`

`toast({ duration })` is a documented option and the store implements it (`use-toast.ts:14-15`, `:71`):

```ts
/** How long the toast stays up (ms). Defaults to TOAST_REMOVE_DELAY; undo toasts pass a longer window. */
duration?: number;
…
scheduleRemove(id, props.duration);
```

`Toaster` then strips it before rendering, so it never reaches the primitive
(`toaster.tsx:25-27`):

```tsx
<ToastProvider swipeDirection={phone ? "down" : "right"}>
  {toasts.map(({ id, title, description, variant, action, duration: _duration, ...props }) => (
    <Toast key={id} variant={variant} {...props}>
```

`ToastProvider` is rendered with no `duration`, so Radix falls back to its own default and runs its own close
timer (`@radix-ui/react-toast/dist/index.mjs:27`, `:313`):

```js
duration = 5e3,                              // ToastProvider default
…
const duration = durationProp || context.duration;   // durationProp is always undefined here
```

When that timer fires, Radix calls `onClose` → `onOpenChange(false)` → the store's own handler
(`use-toast.ts:61-65`) removes the toast. So **whichever timer is shorter wins, and Radix's is always 5000ms**.
A `duration` below 5000 works (the store removes it first); a `duration` above 5000 is silently ignored.

Every use in the app is above it, and every one is an **Undo**:

```
pages/Tickets.tsx:371    duration: 8000   Undo a ticket status move
pages/Tickets.tsx:949    duration: 8000   Undo a ticket move
pages/Boards.tsx:1367    duration: 8000   Undo a task status change
pages/Goals.tsx:567      duration: 8000   Undo a quarter carry-over (deletes the copies, restores the originals)
components/access/AclModal.tsx:363  duration: 8000   Undo an access-rule change
```

so the one control the app deliberately gives extra time gets none of it. `AclModal`'s comment states what the
8 seconds was for (`:358-359`):

> *"Every rule change is one click from being taken back. Permissions are exactly the kind of edit where the
> wrong pick is noticed one second later, and an 8s Undo beats reconstructing the previous rule by hand."*

and `Toaster` itself calls the Undo button *"the most time-pressured button in the app"* (`:39-41`) while
giving it 5 seconds, three of which are the reader noticing the toast and reading it.

It fails closed rather than dangerously - the action already happened and the Undo merely vanishes early - but
it is a feature that is written, typed, documented in three places and does not work.

**Fix.** Pass it through instead of dropping it. Radix's `Toast` takes `duration` and it overrides the
provider's:

```tsx
{toasts.map(({ id, title, description, variant, action, duration, ...props }) => (
  <Toast key={id} variant={variant} duration={duration} {...props}>
```

The store's `scheduleRemove` then becomes the belt to that braces (it already tolerates the toast being gone -
`cancelRemove` is called from `onOpenChange`). If the strip was deliberate to avoid two timers, the honest
version is the opposite: give Radix the duration and let it own the close, and have `scheduleRemove` use the
same value so the two cannot disagree.

---

## 47. The Combobox has no ARIA roles at all, so the app's 34 longest option lists are the ones a screen reader cannot navigate

`web/src/components/ui/combobox.tsx:65-141`

The control is built out of a `Popover`, a plain `<button>` trigger, a bare `<input>` and a list of `<button>`s.
None of the combobox pattern's roles or relationships are present:

```tsx
<PopoverTrigger asChild>
  <button type="button" id={id} disabled={disabled} autoFocus={autoFocus} className={…}>
    <span className="min-w-0 truncate text-left">{selected ? selected.label : placeholder}</span>
    <ChevronsUpDown … />
  </button>
</PopoverTrigger>
…
<input autoFocus value={query} onChange={…} onKeyDown={…} placeholder={searchPlaceholder} … />
…
{filtered.map((o, idx) => (
  <button key={o.value} type="button" data-idx={idx} onMouseMove={() => setActive(idx)} onClick={() => choose(o)} …>
```

Missing: `role="combobox"` / `aria-expanded` / `aria-controls` on the trigger, `role="listbox"` on the list,
`role="option"` + `aria-selected` on the rows, and - the one that matters most here -
`aria-activedescendant` on the search input.

`active` is real state: arrow keys move it (`:94-99`), it is highlighted with `bg-accent` (`:130`), and Enter
commits it (`:100-103`). A sighted user sees the highlight travel. A screen-reader user gets nothing - the
focus never leaves the search input, and without `aria-activedescendant` there is no way for the highlight to
be announced. Pressing Enter picks an option they were never told about.

The list is also unbounded silence: no `aria-live`, no option count, and `emptyText` (*"No matches."*) renders
as an ordinary `<p>` that is never announced when filtering empties the list.

**This is the codebase's own standard, applied everywhere except here.** The file's header says why the control
exists (`:8-11`):

> *"A searchable single-select, styled to match SelectTrigger so it's a drop-in for long option lists (people,
> departments) where the native Select's scroll-and-hunt gets unwieldy."*

so by construction it replaces `ui/select.tsx` - Radix Select, which is fully ARIA-correct - on exactly the
lists that are too long to scan. And the same judgement is made explicitly one directory over
(`components/workflows/WorkflowBuilder.tsx:55-58`):

> *"`SelectGroup` + `SelectLabel`, which Radix wires together with `aria-labelledby` - not a bare `<div>` with a
> styled heading, which is visual only. This is the app's longest Select, and a screen-reader user was getting
> one flat list of every event with no sense of which module each belonged to."*

It is used in **34 files**: the kudos recipient picker, the expense and asset pickers, letter subjects,
timesheet projects, offer candidates, background-check subjects, onboarding employees, and the rest.

**Fix.** The roles are additive - no behaviour changes, and `active` already has everything they need:

```tsx
<button
  type="button" id={id} role="combobox"
  aria-expanded={open} aria-haspopup="listbox" aria-controls={`${listId}`}
  …
/>
…
<input
  role="combobox" aria-expanded aria-controls={listId} aria-autocomplete="list"
  aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined}
  …
/>
<div ref={listRef} id={listId} role="listbox" …>
  {filtered.map((o, idx) => (
    <button key={o.value} id={`${listId}-${idx}`} role="option" aria-selected={o.value === value} …>
```

plus `aria-live="polite"` on the empty-state paragraph so "No matches." is spoken when the filter empties. A
`React.useId()` gives the ids.

---

## 48. Sign out silently deletes every unsaved draft on the machine, with no warning and no confirmation

`web/src/components/layout/UserMenu.tsx:24-33`, `:119-122`; `web/src/lib/clientStore.ts:450-490`,
`:504-509`

```tsx
async function signOut() {
  await purgeAll();
  try { … } catch { window.location.href = "/"; }
}
…
<DropdownMenuItem onClick={signOut}>
  <LogOut className="h-4 w-4" />
  Sign out
</DropdownMenuItem>
```

One click, no dialog. `purgeAll` deletes the **whole** IndexedDB database and clears `localStorage` and
`sessionStorage` (`clientStore.ts:450-490`), which takes the `draft` class with it.

The codebase already knows what that class holds, and says so where it deliberately spares it
(`clientStore.ts:504-506`):

> *"A 401 is not a decision the person made - it arrives mid-sentence. `purgeAll` deletes the `draft` class too
> (the announcement composer's post, a review write-up: **real writing, minutes or days of it**), and
> destroying that because a cookie expired would be a worse bug than the one being fixed."*

`purgeCachedData` was written to avoid exactly this on a session lapse. Sign-out keeps the full purge - which is
defensible for a shared machine - but it is presented as an ordinary menu row, directly under "View my profile"
and separated only by a divider, with nothing saying what leaves with it.

What is actually in there is not incidental:

| draft | written by |
|---|---|
| a review write-up and its whole ratings grid, per review | `pages/Reviews.tsx:603-615` - *"Long-form review text survives navigating away"*, *"half a rating grid is as expensive to redo as the write-up"* |
| an announcement / post / poll / kudos being composed | `components/common/PostComposer.tsx:360`, `:372` - *"The composer holds real writing, and a modal is one stray click from gone"* |
| an unsent bulk asset delivery, a new offer, referral, requisition, review cycle, goal template, background check | `draftKey=` on eight `WriteDialog`s |

So an employee who has half-written three reviews, signs out on Friday, and comes back on Monday finds them
gone - and nothing at any point told them that would happen. Every other place this data can be lost asks
first: `PostComposer.requestClose` (`:660-679`) raises *"Discard this post? What you've written here will be
lost."*, `useDialogGuard` does the same for every write dialog, and `PhotoAvatar.requestClose` asks before
dropping a cropped image.

**Fix.** Ask when there is something to lose, and only then - a confirm on every sign-out would be noise:

```ts
async function signOut() {
  const drafts = draftCount();            // clientStore already indexes the `draft` class in memory
  if (drafts > 0 && !(await confirm({
    title: "Sign out?",
    description: `${drafts} unsaved draft${drafts === 1 ? "" : "s"} on this device will be deleted - they are not saved on the server.`,
    confirmLabel: "Sign out",
    destructive: true,
  }))) return;
  await purgeAll();
  …
}
```

`clientStore`'s `index` already holds one `Meta` per stored record with its class, so a `draftCount()` export is
a filter over a map already in memory - no read, no await. If the product decision is that sign-out must never
be delayed, the honest alternative is to say it in the menu row itself ("Sign out · clears drafts on this
device") rather than leave it unsaid.

---

## 49. Four surfaces put their controls *inside* a `role="button"`, where ARIA says the contents are presentational

`web/src/components/layout/NotificationBell.tsx:126-170`;
`web/src/components/notifications/NotificationRow.tsx:18-52`;
`web/src/pages/Directory.tsx:151-166`; `web/src/pages/Boards.tsx:825-838`

Each of these wraps a whole card or row in `role="button" tabIndex={0}` and then nests real controls inside it:

```tsx
// NotificationBell.tsx:126-131 - one notification in the bell
<div role="button" tabIndex={0} onClick={() => rowClick(n)} onKeyDown={…}>
  …
  {isSnoozed ? (
    <button onClick={(e) => { e.stopPropagation(); void unsnooze(n); }} title="Wake now" aria-label="Wake now">…</button>
  ) : (
    <div …><NotificationRowMenu n={n} /></div>      // a DropdownMenu trigger
  )}
</div>

// NotificationRow.tsx:18-51 - the same row on the Notifications page
<div role="button" tabIndex={0} onClick={open} …>
  …
  <div …><NotificationRowMenu n={n} /></div>
</div>

// Directory.tsx:151-165 - a person card
<div role="button" tabIndex={0} onClick={() => navigate(`employees/${idOf(e.path)}`)} …>
  <div className="absolute right-2 top-2 …">
    <button title="View in org chart" onClick={(ev) => { ev.stopPropagation(); navigate(…); }}>…</button>
  </div>

// Boards.tsx:825-838 - a task tile
<div draggable role="button" tabIndex={0} aria-label={`Open ${card.title}`} …>
  <div className="absolute right-1 top-1 z-10 flex items-center" onClick={(e) => e.stopPropagation()}>
    {menu}
    <AccessTarget … />
  </div>
```

ARIA gives `button` **presentational children** (WAI-ARIA 1.2 §5.2.7): the roles of everything inside a button
are removed from the accessibility tree and its content is flattened into the button's accessible name. So to a
screen reader each of these is a single button whose name is the entire card - and the nested control is not a
control at all.

The consequences are not symmetric across the four, because in two of them the nested control is the **only**
route to its action:

- **"Wake now"** (`NotificationBell.tsx:155-163`) is the sole way to un-snooze from the bell. The Snoozed tab's
  rows otherwise only navigate.
- **The task tile's actions menu** (`Boards.tsx:836`) is the keyboard/touch path to move, assign, block and
  delete a card - the comment above it says the tile was made a `role="button"` precisely so *"a keyboard could
  not reach a single card on the board"* stopped being true, and the menu inside it is what that keyboard user
  then cannot reach.
- `NotificationRow`'s and `Directory`'s nested controls have page-level equivalents, so they degrade to
  "harder" rather than "impossible".

The pointer half of the problem was solved and the ARIA half was not - every one of these carries
`e.stopPropagation()` on the inner control, and `Boards.tsx:831` even guards the key handler with
`e.target === e.currentTarget` so a keypress inside the tile does not also open it. The awareness is there; the
container's role is what defeats it.

**Fix.** Keep the card a plain container and move the button role to something that has no children - the
"stretched link" pattern, which is what every other clickable card in this app that carries controls would want
too:

```tsx
<div className="group relative …">                         {/* no role, no tabIndex */}
  <button
    type="button"
    className="absolute inset-0 z-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    aria-label={`Open ${card.title}`}
    onClick={onClick}
  />
  <div className="pointer-events-none relative">…card body…</div>
  <div className="pointer-events-auto absolute right-1 top-1 z-10">{menu}</div>
</div>
```

The overlay is the button (childless, so nothing is flattened), the body is inert to the pointer, and the
controls sit above it with their own roles intact. `e.stopPropagation()` and the `e.target === e.currentTarget`
guard can then go, because the two are no longer nested.

---

## 50. A manager filing their own leave can be told they have 0 days and blocked from submitting, because their balance row is not on the first page

`web/src/components/common/RequestLeaveDialog.tsx:67-74`, `:200-208`, `:335`; `pages/Leaves.tsx:90-93`

The dialog reads four collections unfiltered and unwalked, and resolves the caller's own rows out of them in
the browser:

```ts
const { rows: types } = useCollection<LeaveType>("leave-types");
const { rows: balances } = useCollection<LeaveBalance>("leave-balances");        // one page
const { rows: holidays } = useCollection<Holiday>("holidays", { all: true });    // walked
const { rows: requests } = useCollection<LeaveRequest>("leave-requests");        // one page
const { rows: employees } = useCollection<Employee>("employees", { all: true }); // walked
…
const balanceByType = useMemo(() => {
  const m = new Map<string, number>();
  for (const b of balances) if (me.employee_id && b.employee && idOf(b.employee) === me.employee_id && b.leave_type) m.set(idOf(b.leave_type), b.balance_days);
  return m;
}, [balances, me.employee_id]);
const availableFor = (t: LeaveType): number | null => (t.paid ? (balanceByType.get(idOf(t.path)) ?? 0) : null);
```

Two of the five reads walk the cursor and three do not - and the two that do are the ones whose rows are the
same for everybody. The three that do not are the ones filtered down to `me.employee_id`.

For an ordinary employee this works, because the authz scope on `leave-balances` and `leave-requests` is
self: the page holds their own handful of rows and the filter is a no-op. For anyone whose scope is wider - a
**manager or HR filing their own leave** - `rows` is the newest hundred rows belonging to their whole
department or the whole org, and their own may simply not be among them. `leave-balances` is one row per
employee per leave type, so a 60-person org with five types has 300 of them.

When that happens:

```ts
availableFor → balanceByType.get(...) ?? 0        // "0 days available"
const insufficient = selectedAvail != null && formDays != null && formDays > selectedAvail + 1e-9;
…
const canSubmit = !!form.leave_type && !!form.start_date && !!form.end_date && !!formDays && !insufficient && myConflicts.length === 0;   // :335
```

`?? 0` turns "not loaded" into "none left", `insufficient` becomes true for any positive number of days, and
`canSubmit` is false - so the dialog shows a manager with eighteen days of annual leave a red panel saying they
have none and **refuses to let them file at all**. There is no "load more" in a dialog and nothing on it admits
a window.

The same read makes two warnings quietly unreliable in the other direction:

- `myConflicts` (`:236-254`) is the caller's own double-booking guard, and it also gates `canSubmit` - leave
  already booked over the same dates is invisible if that request is off the page, so the clash is only caught
  by the server.
- `overlaps` (`:215-228`) is the "who else on your team is away then" panel, drawn from the same window.

**The route already takes the filter.** `listLeaveBalances` accepts `employee`
(`src/routes/leaveBalances.ts:10-16`), and `pages/EmployeeProfile.tsx:110` passes exactly that:

```ts
const { rows: balances } = useCollection<LeaveBalance>("leave-balances", { params: { employee: `employees/${id}` } });
```

**Fix.** Ask for the caller's own rows rather than filtering the org's:

```ts
const mine = me.employee_id ? { employee: `employees/${me.employee_id}` } : undefined;
const { rows: balances } = useCollection<LeaveBalance>("leave-balances", { params: mine, enabled: !!mine });
const { rows: myRequests } = useCollection<LeaveRequest>("leave-requests", { params: mine, enabled: !!mine });
```

keeping the unfiltered `leave-requests` read (walked, or with its own notice) only for the department `overlaps`
panel, which is advisory. And `availableFor` should distinguish the two cases it currently merges: return
`null` (unknown - do not block) when there is no row for a paid type, and `0` only when the row says zero. A
balance the client could not load must not read as a balance of nothing.

**That distinction already exists one file away, in the sibling helper for the same data.**
`lib/leaveApproval.tsx:13-17` reads a balance out of the very same windowed collection and returns `undefined`
when there is no row - documented as *"(undefined = not visible / untracked)"* - and
`leaveDecisionContext` (`:31-39`) then simply omits the balance line rather than printing a number. So the
approver's side of the same read degrades to "no context shown" and the requester's side degrades to "you have
none, and you may not file". Only one of those is a safe default, and it is the one the dialog does not use.

The same one-page `leave-balances` read backs the balance cards on `pages/Leaves.tsx:93`, where the page's
`TruncationNotice` covers `leave-requests` but not balances.

**Two more instances of the identical shape**, both on the Holidays page and both filtering the org's newest
hundred down to `me.employee_id`:

```ts
// pages/Holidays.tsx:867-871 - BridgeAction, the "take this day and it's a 4-day break" button
const { rows: balances } = useCollection<LeaveBalance>("leave-balances");
const available = useMemo(
  () => balances.filter((b) => (me.employee_id ? idOf(b.employee ?? "") === me.employee_id : false)).reduce((n, b) => n + (b.balance_days ?? 0), 0),
  [balances, me.employee_id],
);
…
const short = bridge.take.length > available;        // 0 available -> every bridge reads as unaffordable
```

whose own header says *"Proposing leave someone hasn't got is worse than not proposing it"* - so the guard is
deliberate, and it misfires in the one direction that silently removes the feature.

```ts
// pages/Holidays.tsx:965-975 - the year grid's "your approved leave" shading
const { rows: leaves } = useCollection<LeaveRequest>("leave-requests");
const myLeave = useMemo(() => { … if (idOf(l.employee ?? "") !== me.employee_id) continue; … }, …);
```

Both take the same fix: a `params: { employee: … }` read scoped to the caller instead of a
client-side filter over everybody's rows.

---

## 51. The stocktake walk lists only the first 100 assets, then closes a count whose missing list the server computes over all of them

`web/src/components/assets/Stocktake.tsx:46`, `:109`, `:122-123`, `:260-268`, `:485`;
`web/src/pages/Stocktakes.tsx:48`, `:78-95`; `src/services/stocktakes.ts:166`, `:178-205`

The scanner screen builds the whole walk out of one page of the asset register:

```ts
const { rows: assets, setRows: setAssets } = useCollection<Asset>("assets");     // one page, no `all`, no notice
…
// The audit scope, as the COUNT declared it … the stored scope is what its missing list will mean, so the walk
// and the report have to be filtering the same set.
const scope = useMemo(() => (session ? assets.filter((a) => inScopeWire(session.scope, a)) : []), [assets, session]);
const seen      = useMemo(() => (session ? scope.filter((a) => sightedIn(session, a)) : []), [scope, session]);
const remaining = useMemo(() => (session ? scope.filter((a) => !sightedIn(session, a)) : []), [scope, session]);
```

That comment states the invariant the code then breaks. `assets` is the first hundred rows the server returns
(newest first - `src/http/pagination.ts:41`, `clampPageSize` defaults to 50 and `useCollection` asks for 100),
and the assets route takes no `status` filter to narrow it with (`src/routes/assets.ts:115-123` accepts only
`employee`). **`scope` is therefore not the count's scope - it is the count's scope intersected with the newest
hundred assets.**

The server is not: it says so in the header of the very verb this screen calls
(`src/services/stocktakes.ts:166`):

> *"The missing list is computed HERE, over the whole inventory in scope, and stored. A list derived live would
> …"*

and `closeStocktake` (`:178-205`) re-queries the assets table under the stored scope and scores against
`foundJson`.

So for a register of 400 assets and a scope of "everything in use":

1. The walk shows **"83 / 83"** (`:485`), because 83 in-scope assets were among the newest hundred.
2. The "Not seen yet" list (`:507-513`) empties, and the operator - correctly - believes the count is done.
3. The close confirm (`:260-268`) reads the same window:
   > *"83 of 83 sighted, 0 missing. The result is frozen as it stands now and cannot be reopened."*
4. `closeStocktake` scores over all 317 in-scope assets the walk never listed and freezes them as **missing**
   (up to `MISSING_SNAPSHOT_CAP` = 500, `src/domain/stocktake.ts:93`).
5. Each missing asset that has a holder gets `asset.stocktakeMissing` stamped on it and its holder is
   **notified to go and look** (`src/services/stocktakes.ts:176`, `:209-210`) - the confirm even promises this,
   with a count of `0`.
6. The frozen list then feeds `missingPaths(lastClosed(counts))` on the next walk, so every one of those assets
   carries a "missing last time too" chip (`Stocktake.tsx:114`), and `reconcileMissing` treats it as the honest
   record of what could not be found.

A count is the one artefact in the app that is explicitly not reopenable, and it is produced from a window with
nothing on screen admitting there is one - `components/assets/Stocktake.tsx` renders no `TruncationNotice`, and
`pages/Stocktakes.tsx`'s three `accessCollection="stocktakes"` markers describe the *counts* table, not the
assets the progress is measured against.

**The same window backs the inventory-confidence tiles** on `pages/Stocktakes.tsx:78-95`:

```ts
const confidence = useMemo(() => inventoryConfidence(assets, staleDays), [assets, staleDays]);
const banded = useMemo(() => (band ? assets.filter((a) => confidenceBand(a, staleDays) === band) : []), …);
const progressOf = (c: Stocktake) => { const scope = assets.filter((a) => inScopeWire(c.scope, a)); … };
```

`inventoryConfidence`'s own doc calls it *"how well the org actually knows where its things are"*
(`lib/stocktake.ts:69-74`) - computed over a quarter of the things.

**Fix.**

1. `{ all: true }` on both `assets` reads - which is what the Assets page itself already does
   (`pages/Assets.tsx:91`: `useCollection<Asset>("assets", { all: true })`). The same collection is walked for
   the list and not walked for the count that freezes an irreversible report. `ALL_CAP` is 1000, which covers
   an ordinary register, and the collection is already a catalog-shaped read.
2. Because a register can exceed even that, the walk must refuse to close a count it could not fully list:
   surface `collectionHasMore("assets")` and block **Close count** behind it, rather than freezing a missing
   list from a partial scope. The confirm already promises to notify holders - it must not be able to promise
   that about `0` items and then send hundreds.
3. Better still, give the walk the scope from the server: `closeStocktake` already queries the scoped set, so a
   `GET /v1/stocktakes/<id>/scope` (or a `status`/`category` filter on `listAssets`) would let the walk and the
   close read the same rows by construction, which is what `Stocktake.tsx:107-109` says they must do.

---

## 52. Every number on Recruiting analytics is a rate or a mean over the newest 100 rows, and one hint calls that "in this window"

`web/src/pages/RecruitingAnalytics.tsx:23-26`, `:30-65`, `:79-95`

```ts
const { rows: apps, state, error, reload } = useCollection<Application>("applications");
const { rows: reqs }       = useCollection<JobRequisition>("job-requisitions");
const { rows: offers }     = useCollection<Offer>("offers");
const { rows: candidates } = useCollection<Candidate>("candidates");
```

Four single-page reads, no `all: true`, and the page renders no `TruncationNotice` (the `accessCollection` on
`PageHeader` is the manage-access key, not a truncation affordance - `components/common/PageHeader.tsx:76-79`).
Everything below is folded straight over them:

| metric | line | what it folds |
|---|---|---|
| funnel by stage | `:38` | `apps.filter(...)` per stage |
| source effectiveness (total + hired per source) | `:41-49` | every `apps` row |
| offer acceptance rate | `:52-55` | `offers.filter(...)`, as a **percentage** |
| **average time to hire** | `:58-62` | mean over `hired` applications |
| stalled over 14d | `:65` | `active.filter(...)` |
| Open jobs / Candidates / Active / Hired | `:83-88` | `.length` of each window |

Pages are keyset-ordered **newest first**, so this is not a sample - it is a recency-biased slice, which is the
worst possible shape for exactly these statistics. The newest hundred applications are disproportionately the
ones still in flight, so `hired` is small, `timeToHire` is a mean over the handful of recent hires, and
`acceptRate` is computed over the newest hundred offers rather than the year's. An ATS passes a hundred
applications in a quarter; the page is called *"Recruiting analytics"* and its description promises *"Pipeline
funnel, source effectiveness, and offer outcomes across your open jobs."*

The page half-knows. The Hired metric's hint reads (`:88`):

> `hint: "in this window"`

which is the only acknowledgement anywhere that the numbers are bounded - and it is misleading in its own
right, because there is no window control on the page and no date range anywhere in it, so "this window" reads
as a period the reader chose rather than as "the first page of the collection". The other seven metrics carry
no such hint, and the drill-throughs beside them (`navigate("pipeline?focus=hired")`) open pages that are
windowed the same way (see finding 20), so following a number cannot reveal the gap either.

**Fix.** An analytics page cannot be built by folding a list page's rows. In order of preference:

1. Compute these server-side. The shapes are all counts and means over indexed columns
   (`status`, `stage`, `source`, `applied_time`, `stage_changed_time`), which is one query rather than four
   collection reads - and it is what `pages/TeamAnalytics.tsx` already does (its measure catalogue is
   server-side).
2. Failing that, `{ all: true }` on all four reads plus a `TruncationNotice` naming them, and - because
   `ALL_CAP` is 1000 and an ATS will pass it - suppress the **rates and the mean** when
   `collectionHasMore` is true for their source. A count that is short reads as a count that is short; a
   percentage or an average that is short reads as a fact about the business.
3. Either way, replace `"in this window"` with something true, or drop it: it is the one label on the page that
   claims a bound, and it names the wrong one.

---

## 53. `esign_uri` reaches `window.open` unvalidated, and it is a third party's JSON field all the way down

`web/src/pages/Documents.tsx:569`, `:608-609`; `web/src/components/common/SignDocumentDialog.tsx:119-121`;
`src/services/esign/cashfree.ts:259`; `src/services/documentService.ts:419`

Three client sinks open the value with no check on what it is:

```tsx
// Documents.tsx:569 - the row's "Open to sign" action
if (d.esign_uri) items.push({ label: "Open to sign", …, onClick: () => window.open(d.esign_uri, "_blank", "noopener") });
// Documents.tsx:608-609 - the same, as the row's primary click
: d.esign_uri ? () => window.open(d.esign_uri, "_blank", "noopener")
// SignDocumentDialog.tsx:119-121 - straight off the :requestEsign response
if (res.esign_uri) { … window.open(res.esign_uri, "_blank", "noopener"); }
```

`noopener` is set, which handles the reverse-tabnabbing half. It does nothing about the scheme. A window opened
with a `javascript:` URL from a same-origin document runs that script **in this origin**, so the value is an
XSS sink, not merely a navigation.

The value is never validated anywhere on the way there. It is the vendor's own JSON field, stored verbatim:

```ts
// src/services/esign/cashfree.ts:259
return { providerRef: String(j.reference_id), signUrl: j.signing_link, status: mapStatus(j.status) };
// src/services/documentService.ts:419
.set({ esignRequestId: res.providerRef, esignStatus: res.status, esignUri: res.signUrl ?? null, esignSentAt: new Date() })
// src/http/serialize.ts:1774, :1797
esign_uri: r.esignUri ?? undefined,
```

`providerRef` is coerced with `String(...)` on the same line; `signing_link` is taken as-is. Nothing between
that assignment and `window.open` inspects it - no scheme allowlist at the adapter, at the write, at the
serializer, or at the call site.

The trust boundary is a configured third-party API rather than an anonymous attacker, so this is
defence-in-depth rather than a live remote vulnerability. It is worth closing anyway because **this codebase
validates exactly this class of input everywhere else**:

```ts
// web/src/lib/richText.tsx:179 - for a link an EMPLOYEE typed into a post
const safeHref = (url: string) => (/^(https?:\/\/[^/\s]|mailto:[^\s@]+@)/i.test(url) ? url : undefined);
```

with the reasoning stated at `:140-141`: *"A URL is only ever linked when it is http(s) or mailto - the one
place a document could otherwise smuggle a scheme."* And `src/lib/urlGuard.ts` does the same job for outbound
webhook targets. A colleague's post is held to a standard the e-sign vendor's response is not.

**Fix.** Validate once, at the boundary where the value enters the system, and again at the sink:

```ts
// src/services/esign/cashfree.ts - reject anything that is not an https URL
const signUrl = typeof j.signing_link === "string" && /^https:\/\//i.test(j.signing_link) ? j.signing_link : undefined;
```

```tsx
// web/src - one shared helper, mirroring lib/richText.tsx#safeHref
const openExternal = (url?: string) => { if (url && /^https:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer"); };
```

`https` only rather than `https?`: an e-sign link carries a signing session and has no business on plain HTTP.
Add `noreferrer` alongside `noopener` while there - the current calls send this app's document URL to the vendor
as a `Referer`.

---

## 54. The comment that tells the next author which routes replay already masks names a route that is not on the list

`web/src/App.tsx:718-724`; `web/src/instrument.ts:53-71`, `:88-91`

The `data-page` attribute on `<main>` is what route-level replay masking hangs off, and the comment beside it
tells the next reader which routes it covers:

```tsx
// The route key, for session replay's per-page masking (SENSITIVE_PAGES in instrument.ts). Replay
// records text by default, and a selector on this attribute is what hides a whole sensitive route -
// payslips, the profile, documents - subtree and all. Kept here rather than on each page because
// the point is that a panel added to one of those routes is covered without anyone opting it in.
data-page={route.page}
```

`SENSITIVE_PAGES` does not contain the profile (`instrument.ts:53-71`):

```
payslips · payroll-runs · documents · reviews · suggestions · check-ins · tax-declarations · background-checks
```

Neither `profile` nor `employees` is on it. So the sentence *"a panel added to one of those routes is covered
without anyone opting it in"* is exactly false for the route it names by example - and that route is the one
that carries, unmasked:

| on `#/profile` | rendered by |
|---|---|
| the caller's CTC, its component build-up and the whole salary-revision history | `Profile.tsx:198` → `MyCompensation` |
| their handwritten signature as a data-URL `<img>` | `Profile.tsx:202` → `SignatureField` (finding 44) |
| date of birth, gender, marital status, address, personal contact | `Profile.tsx:182` → `EmployeeProfilePersonal` |
| their document shelf | `Profile.tsx:220` → `EmployeeDocuments` (which carries its own `sentry-mask`, `:34-40`) |

`#/employees/<id>` is the same story for somebody else's record: the four editing **dialogs** are masked by
name (`EmployeeBankDetails`, `EmployeeTaxDetails`, `EmployeeIdentityDetails`, `EmployeeCompensation` -
`EmployeeProfile.tsx:474-489`), but the page they sit on is not, so every value those dialogs show read-only in
the page behind them is recorded.

This is the root cause of findings 43 and 44 rather than a separate defect: both are panels added to a route
this comment says is already covered. `EmployeeDocuments` is the one panel on the profile that carries its own
mask, and its comment (`:34-40`) says why - it had to notice for itself that *"#/profile and #/employees/<id>,
neither of which is on that list"*. One component's author checked; the shell's comment says checking is
unnecessary.

**Fix.** One of the two has to move, and the first is better:

1. Add `profile` and `employees` to `SENSITIVE_PAGES`, which makes the comment true and closes findings 43 and
   44 by construction along with anything added to those routes later. The `unmask` list (`instrument.ts:135+`)
   already puts headings, column names, tabs and buttons back, so a masked profile is still a legible replay.
2. If they are deliberately left off - the profile is where most bug reports come from, and a fully masked one
   is a poor recording - then the comment must say so, and say that a panel added there needs
   `data-sentry-mask` of its own. As written it tells the next author the opposite.

---

## 55. The snoozed-notification read is the last `max_page_size=200` in the codebase, and it silently caps the wake timer at the newest 100

`web/src/lib/notifications.tsx:161-166`, `:172-193`, `:445`

```ts
const loadSnoozed = useCallback(() => {
  setSnoozedLoaded(true);
  void get<ListResponse<Notification>>("notifications?snoozed=true&max_page_size=200")
    .then((r) => setSnoozed(r.results ?? []))
    .catch(() => setSnoozedLoaded(false));
}, []);
```

The server clamps any page size to 100 and says nothing about it (`src/http/pagination.ts:41`,
`clampPageSize = Math.min(Math.max(n ?? 50, 1), 100)`). `api.ts:396` warns about this - but only for `list()`,
and this is a raw `get`, so nothing fires.

**Four other files carry a comment recording this exact mistake being fixed**, which is what makes the
remaining one worth naming:

```
pages/Timesheets.tsx:116   "`max_page_size=500` was clamped to 100 by the server without…"
pages/Schedule.tsx:97      "`max_page_size=500`; the server caps a page at 100 and says so only through `next_page_token`…"
pages/Interviews.tsx:440   "This asked for `max_page_size=200`, got the…"
lib/prefs.ts:20            "`max: 200` was clamped to 100 silently … a preference that fell past the page read as ABSENT"
lib/settingsStore.ts:105   "This used to ask for `max: 200` and read the answer as the whole table"
```

Two consequences here, and the second is functional rather than cosmetic:

**The count changes meaning when the tab is opened.** `snoozedCount` (`:445`) is the server's true count until
the list loads, and the loaded array's length afterwards:

```ts
const snoozedCount = snoozedLoaded ? snoozed.length : (metaSnoozedCount ?? 0);
```

so the "Snoozed" badge in the bell (`NotificationBell.tsx:99`) reads correctly, then drops to 100 the moment
the reader clicks the tab - and the list beneath it has no "load more".

**A reminder can fail to wake.** The proactive wake timer aims at the soonest pending snooze
(`:189-193`):

```ts
const next = snoozed.map((n) => +new Date(n.snooze_until_time ?? 0)).filter((t) => t > now).sort((a, b) => a - b)[0];
if (next) scheduleWake(next);
```

`snoozed` is the first page of a collection ordered by `(create_time, uid)` **descending** - not by wake time -
so the soonest wake is not preferentially in it. Snooze more than a hundred notifications (a busy approver over
a few weeks; `SNOOZE_PRESETS` make it a one-click habit) and the next one due can sit outside the window, in
which case the timer arms on a later wake or not at all, and the reminder only surfaces on the next
focus-refetch. The comment above `scheduleWake` says what it is for:

> *"a single-shot timer to the SOONEST pending snooze so an idle open tab actually surfaces a reminder at its
> due moment (the focus-refetch only fires when the user returns)"*

**Fix.** Either walk the cursor the way the four fixed sites do, or - better for this read, since only the
soonest matters - ask the server for it in wake order:

```ts
void get<ListResponse<Notification>>("notifications?snoozed=true&max_page_size=100")
```

and keep `snoozedCount` on the server's `metaSnoozedCount` rather than swapping it for `snoozed.length` once a
partial list has loaded - a count that gets *less* accurate when you look at it is worse than one that stays
approximate. If the list itself needs to be complete, give it the same `seen`-guarded cursor walk
`lib/clock.tsx#listAllSessions` uses.

---

## 56. The directory's headcount says "Employees: 100 · everyone you can see", and its org charts are drawn from the same hundred

`web/src/pages/Directory.tsx:192`, `:257-258`, `:339-352`, `:353-380`, `:561-592`

The page keeps two reads and says why (`:257-258`):

> *"Two reads, deliberately: the unfiltered one above backs the **stats (which must count the whole org, not the
> current search)** and is the entry every other page shares; this one is the search result set."*

and the unfiltered one does not walk the cursor (`:192`):

```ts
const { rows, state, error, reload, loadMore, hasMore } = useCollection<Employee>("employees", { deletedOnly });
```

Everything the comment promises is then folded over that single page:

```ts
const stats = useMemo(() => {
  const live = rows.filter((e) => !e.delete_time);
  return {
    total: live.length,
    clockedIn: live.filter((e) => clockedIn.has(idOf(e.path))).length,
    joined: live.filter((e) => (e.start_date ?? "").slice(0, 7) === month).length,
    joining: live.filter(isJoiningSoon).length,
    probation: live.filter(isProbationDue).length,
    noManager: live.filter((e) => !e.manager).length,
  };
}, [rows, clockedIn]);
```

So on any org past a hundred people the summary strip reads (`:563`):

> **Employees** · **100** · *everyone you can see*

and the two charts beside it (`:536-556`) are drawn from the same rows under titles that claim otherwise -
*"Headcount by department — Everyone you can see, by the team they sit in"* and *"Joiners by month — Who
started when, over the last twelve months"*. Employees are keyset-ordered newest first, so the joiners chart is
really "the newest hundred hires bucketed by month", which renders every month before them as zero growth: a
company that has been hiring steadily for three years shows a cliff.

`noManager` - offered as one of *"the three gaps HR otherwise finds by scrolling the table"* (`:346-347`) - is
a count of unmanaged people among the newest hundred, which is the opposite of where an orphaned reporting line
usually is.

**The list half of the page is handled correctly**, which is what makes the stats stand out: the grid and table
get `hasMore` / `onLoadMore` (`:671-672`, `:702`) and `accessCollection="employees"` (`:674`), and the search
box was deliberately moved server-side for exactly this reason (`:250-253`):

> *"It runs on the SERVER (`?q=`, FTS-backed), because a list page caps at 100 rows: filtering here would only
> ever search the slice already loaded, so anyone past the first page was unfindable."*

The same sentence applies to the numbers above it, and they were not moved.

**Fix.** `{ all: true }` on the employees read. Every other page in the app that needs the whole directory
already passes it (`OrgChart.tsx:50`, `Tickets.tsx:164`, `Documents.tsx:141`, `Reimbursements.tsx:56`, and a
dozen more), the collection is in `CATALOG_COLLECTIONS` with a 5-minute TTL and a disk copy
(`lib/resourceStore.ts:28-32`), and `hasMore` stays true at `ALL_CAP` so the grid's "Load more" keeps working.
Because `ALL_CAP` is 1000, a very large org still truncates - so the headline should also drop the words
*"everyone you can see"* in favour of the `+` the pager already uses when `collectionHasMore("employees")` is
true, rather than asserting completeness it cannot check.

---

## 57. `PayslipDesignTab` debounces its PDF preview but never cancels the superseded render, so an out-of-order reply shows a stale design and revokes the live one

**Where.** `web/src/pages/PayslipDesignTab.tsx:69-89`, plus the manual refresh at `:172`.

```ts
const renderPreview = useCallback(async (t: PayslipTemplate) => {
  setPreviewing(true);
  try {
    const url = await blobUrl("payslips", { verb: "previewTemplate", body: { template: t } });
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = url;
    setPreviewUrl(url);
    setPreviewError(null);
  } catch (e) { setPreviewError((e as Error).message); }
  finally { setPreviewing(false); }
}, []);
useEffect(() => {
  if (!template) return;
  const id = setTimeout(() => renderPreview(template), 600);
  return () => clearTimeout(id);
}, [template, renderPreview]);
```

The cleanup clears the *timer*. It does not touch a render that has already left. Nothing in `renderPreview`
asks whether it is still the current one.

**What goes wrong.** Every keystroke in a block label re-runs the effect. A quiet 600 ms fires render A; typing
resumes; 600 ms later render B fires. Each one is a full server-side PDF render, so overlap is the normal case,
not a narrow race. If B lands first and A lands second:

- A calls `URL.revokeObjectURL(urlRef.current)` - and `urlRef.current` is **B's URL, the one the iframe at
  `:321` is currently streaming**. The live preview is pulled out from under the element showing it.
- A then sets `urlRef.current = urlA` and `setPreviewUrl(urlA)`, so the designer settles on a render of an
  **older draft** and stays there until the next edit. The blocks on screen and the blocks in the PDF disagree,
  with no indication which is which.
- `setPreviewError(null)` from a late success also erases a genuine error B reported, and a late *failure* from
  A paints an error banner over a preview that rendered fine.
- `finally { setPreviewing(false) }` from whichever finishes first clears the "Rendering…" hint at `:313` and
  un-loads the button at `:172` while the other render is still in flight.

The manual **Refresh preview** button at `:172` calls `renderPreview(template)` directly, with no debounce at
all, so a click followed by one more edit produces the two-in-flight state deterministically.

**Nothing revokes on unmount either, once a render is in flight.** The unmount cleanup at `:89` revokes
`urlRef.current` as it stands at that moment; the pending promise then resolves *after* unmount, assigns
`urlRef.current = url` on a dead component and leaks that blob for the lifetime of the document. Navigating
away from Settings mid-render is enough.

**The sibling designer already does all of this, and says why.** `web/src/components/settings/LetterheadDesigner.tsx:234-262`
is the same debounced-PDF-preview shape, written with the guards:

```ts
let dropped = false;
// ABORTED on cleanup, not merely ignored - ... each call is a full PDF render, and those are the
// requests the dedicated `render` budget (40/min, middleware/rateLimit.ts) exists to bound. Without this a
// designer session - drag an element, type a heading, nudge a margin - fired one render per 600 ms quiet
// window and let every superseded one run to completion against that budget.
const controller = new AbortController();
...
void blobUrl(path, { verb: "preview", body: { design, variant: shownVariant }, signal: controller.signal })
  .then((u) => {
    if (dropped) { URL.revokeObjectURL(u); return; }
    const old = previewUrl.current;
    previewUrl.current = u;
    setPreview(u);
    if (old) URL.revokeObjectURL(old); // the iframe has the new one now
```

Two things there that `PayslipDesignTab` inverts:

1. **Revoke order.** LetterheadDesigner revokes the old URL *after* the new one is handed to the iframe, and
   its comment at `:234-239` records that revoking earlier caused "*the preview going blank between
   keystrokes*". `PayslipDesignTab:74-76` revokes first, then assigns - the exact ordering that comment exists
   to warn against.
2. **The rate-limit budget.** The same `render` bucket (40/min) is what the payslip preview spends, and
   `PayslipDesignTab` lets every superseded render run to completion against it. A minute of editing block
   labels can exhaust it, at which point the designer starts failing with the limiter's own error - the
   regression LetterheadDesigner's comment says was already fixed once, on the other page.

**Fix.** Give `renderPreview` the same treatment: take an `AbortController`, pass `signal` through to
`blobUrl` (`api.ts:692` forwards `BinaryOpts` to `postBinary`, which already carries a signal), abort it in the
effect cleanup, guard the resolution with a `dropped` flag that revokes the arriving URL instead of installing
it, and move the `URL.revokeObjectURL(old)` to *after* `setPreviewUrl(url)`. The manual refresh button should
share the same controller ref so a click supersedes the debounced render rather than racing it.

---

## 58. `GoalCockpit`'s filter-chip counts ignore the cycle picker, so they contradict the list directly beneath them

**Where.** `web/src/pages/GoalCockpit.tsx:57-69` (`scoped`) against `:87-95` (`counts`).

`scoped` - the rows actually rendered - applies three filters:

```ts
if (!isOpen(g) || g.delete_time) return false;
if (g.employee && idOf(g.employee) === me.employee_id) return false;
if (cycle !== "all" && idOf(g.cycle ?? "") !== idOf(cycle)) return false;   // <- the cycle picker
if (only === "trouble") return troubled(g);
if (only === "unagreed") return g.stage !== "AGREED";
```

`counts` - the numbers printed on the three chips at `:127` - applies only the first two:

```ts
const mine = goals.filter((g) => isOpen(g) && !g.delete_time && g.employee && idOf(g.employee) !== me.employee_id);
return {
  trouble: mine.filter(troubled).length,
  unagreed: mine.filter((g) => g.stage !== "AGREED").length,
  all: mine.length,
};
```

and its dependency array is `[goals, me.employee_id]` - `cycle` is not listed, so the memo would not recompute
even if the body did read it.

**What goes wrong.** Pick a cycle from the select at `:137`. The list collapses to that cycle's goals; the
chips keep showing the org-wide-across-all-cycles totals. A manager looking at Q3 sees **"Needs attention 14"**
above a page listing three goals, with no explanation for the other eleven, and the page's whole purpose - per
the doc comment at `:32-41`, *"who is sliding, and who has gone quiet"*, *"sorted by trouble"* - is answered
with a number from a different question. The empty state is worse: filter to a cycle where everyone is on
pace and the page prints *"Nothing needs chasing - every goal you can see is on pace"* (`:157-160`) while the
chip beside it still reads a non-zero **Needs attention** count.

It also runs the other way. `counts.all` stays constant as the cycle changes, so the chip that is supposed to
say "here is how much you are hiding" says nothing at all.

**Note the contrast within the same file.** The three predicates were deliberately hoisted to module scope at
`:22-28` precisely because of a dependency-array defect, and the comment says so:

> *"inside the component they were rebuilt every render, so the three memos that call them either listed a
> dependency that changed on every pass or - as here - quietly left them out and kept whichever closure they
> were first given."*

`counts` is the third of those memos and is the one that still leaves a dependency out.

**Fix.** Factor the shared predicate out and let both use it - a `base` array filtered by open / not-deleted /
not-me / cycle, with `counts` derived from `base` and `scoped` being `base` narrowed by `only`. Then `cycle`
appears in exactly one dependency list and the two can no longer drift.

---

## 59. `Payslips` buckets year-to-date pay by the UTC year of `create_time` while labelling it with the ORG's year, and `lib/orgDay.ts#orgDayOf` - the helper written for exactly this - has no callers at all

**Where.** `web/src/pages/Payslips.tsx:36-56` and `:68-71`.

```ts
const ytd = useMemo(() => {
  // The ORG's year (lib/orgDay), not the viewer's calendar: these two numbers are the YTD net pay and YTD tax
  // somebody reads off their own payslips, and around New Year the browser's year and the org's disagree.
  const year = thisYearStr();
  const slips = rows.filter((s) => (s.create_time ?? "").startsWith(year));
```

```ts
const years = useMemo(
  () => [...new Set(rows.map((s) => (s.create_time ?? "").slice(0, 4)).filter(Boolean))].sort().reverse(), ...
const visible = useMemo(
  () => (year === "all" ? rows : rows.filter((s) => (s.create_time ?? "").startsWith(year))), ...
```

The comment is right about the *source of the year* and wrong about the *thing it is compared against*.
`thisYearStr()` is `todayStr().slice(0, 4)` (`lib/orgDay.ts:67`), i.e. the org-local year. `create_time` is a
UTC instant - `create_time: { type: string, format: date-time, readOnly: true }` on the `payslip` schema
(`openapi.yaml:3627`). Taking the first four characters of a UTC timestamp gives the **UTC** year. The
comparison mixes the two clocks it was written to stop mixing.

**What goes wrong (IST, the app's own worked example).** A payslip published at 02:00 on 1 January in an
IST org has `create_time = 2025-12-31T20:30:00Z`.

- `thisYearStr()` is `"2026"`; `"2025-12-31T20:30:00Z".startsWith("2026")` is false. The slip is excluded from
  the year it was issued in and counted into the one before it.
- `years` derives its chips from the same UTC prefix, so in the first 5.5 hours of 1 January there is **no
  "2026" chip at all** while the strip above it reads *"Net paid in 2026"* with a value of zero and a hint of
  *"0 payslips"*.
- That strip item is clickable: `onClick: () => setYear(thisYear)` (`:185`). Pressing it sets `year = "2026"`,
  `visible` filters to nothing, and the table renders its `emptyTitle="No payslips match"` - an employee
  pressing their own year-to-date figure is shown an empty payslip list.
- West of UTC the error runs the other way and lasts longer: for the whole evening of 31 December a slip
  issued that day already carries a `2026-01-01T..Z` timestamp, so December's pay lands in next year's total.

`ytd.tax` is the same number described as *"tax withheld so far"* (`:189`) - a figure people copy into a tax
return - and `ytd.avgNet` divides by the same miscounted `slips.length`.

**A third clock in the same component.** `payChart` at `:59-66` labels each point with
`new Date(s.create_time).toLocaleDateString(undefined, { month: "short", year: "2-digit" })` - the **viewer's**
local month. The same slip that the YTD filter files under 2025 is drawn on the chart as "Jan 26". Three
clocks, one card.

**The helper already exists and is dead.** `lib/orgDay.ts:56-58` defines exactly the missing conversion:

```ts
/** The org-local calendar day of an instant, as "YYYY-MM-DD". */
export const orgDayOf = (at: Date | number | string): string =>
  localDay(typeof at === "string" ? at : new Date(at).toISOString(), orgTz);
```

`rg -n "orgDayOf" -g '!lib/orgDay.ts' web/src` returns **nothing**. It was written for the instant-to-org-day
direction and never wired up, which is why every instant-shaped date in the SPA is still read in UTC or in the
viewer's zone. Payslips is the case where that shows on a money figure.

**Fix.** Compute the bucket once and reuse it: `const yearOf = (s: Payslip) => orgDayOf(s.create_time ?? "").slice(0, 4)`,
then `slips = rows.filter((s) => yearOf(s) === thisYearStr())`, `years` from `yearOf`, `visible` from `yearOf`,
and give the chart its label from `orgDayOf` too so all three agree. The same sweep is worth running over every
other `create_time`-prefix comparison in the SPA, now that the helper has a first caller.

**Separately worth deciding.** Even corrected, this buckets by *issue* time, not by the period paid: a December
run published on 2 January counts into the new year's YTD. The row carries `payroll_run`
(`openapi.yaml:3630`) and the run knows its period, but the `payslip` wire schema exposes no period field of
its own - so a payslip's own "which month is this" is not answerable client-side today.

---

## 60. `NoticePeriods` treats the server's floor-clamped `days_remaining` as a real countdown, so anyone months past their last working day is shown as "Last day" and counted in "Last week of notice"

**Where.** `web/src/pages/NoticePeriods.tsx:46-61` (`RemainingBadge`), `:91` (`isLeavingSoon`), `:96-105`
(`stats` / `kf`), `:203` (the strip item), against `src/http/serialize.ts:1347-1348`.

The server never returns a negative remaining:

```ts
const todayMid = todayMsOf(r);
const remaining = r.status === "serving" ? Math.max(0, Math.round((lwd - todayMid) / 86400000)) : 0;
```

`Math.max(0, ...)` is a **floor**, not a value. A record whose last working day was three days ago and one
whose last working day was three months ago both arrive as `days_remaining: 0`, indistinguishable from a record
whose last working day is genuinely today.

**The page then reads that zero as a date.**

```tsx
const d = n.days_remaining ?? 0;
const total = n.total_days ?? 0;
const pct = total > 0 ? Math.min(100, Math.max(0, Math.round(((total - Math.max(0, d)) / total) * 100))) : 0;
const variant = d <= 0 ? "destructive" : d <= 7 ? "warning" : "secondary";
...
<Badge variant={variant} className="tabular-nums">{d <= 0 ? "Last day" : `${d}d left`}</Badge>
```

So every overdue-but-still-"serving" record renders a **full progress bar** (`pct` computes to 100) and a
destructive badge reading **"Last day"**. An HR admin scanning the table is told that somebody who left in
March is leaving today.

```ts
const isLeavingSoon = (n: NoticePeriod) => isServing(n) && (n.days_remaining ?? 0) >= 0 && (n.days_remaining ?? 0) <= 7;
```

`>= 0` was clearly written to exclude the overdue ones. It cannot: the clamp guarantees `>= 0` for all of them.
Every overdue record therefore lands in the **"Last week of notice"** KPI (`:203`), whose hint reads
*"hand-over window"*, and in the `soon` focus filter whose label is *"exits in the next week"* (`:100`).

**It is also a double count against the KPI directly beside it.** The same rows are counted again by

```ts
const isPastExit = (n: NoticePeriod) => isServing(n) && n.last_working_day < todayStr();
```

surfaced as **"Past last working day" / "mark them exited"** (`:208-210`). Two adjacent tiles report the same
people under contradictory headings, and `isPastExit` is proof the page already has the correct test - a
date-to-date comparison against `todayStr()` - two lines below the one that uses the clamped integer.

**Why this one matters more than a mislabelled tile.** The file states the stake itself at `:88`:

> *"Still marked serving after their own last working day: the record nobody closed, which leaves a login
> alive."*

The overdue bucket is the page's security-relevant queue. Diluting it into "hand-over window" - and painting
its rows as if their exit were today - is the failure mode the tile exists to catch.

**Fix.** Derive the countdown from the dates the row already carries rather than from the clamped scalar.
`const over = n.last_working_day < todayStr()` gives the three fixes at once:

- `RemainingBadge`: when `over`, render "Overdue" (or `daysBetweenYmd(n.last_working_day, todayStr())` days
  past) rather than "Last day", and leave the bar at 100 with a distinct tone.
- `isLeavingSoon`: `isServing(n) && !over && (n.days_remaining ?? 0) <= 7`.
- Nothing else changes: `isPastExit` is already correct and stays the sole owner of that bucket.

Alternatively drop the `Math.max(0, ...)` clamp in `toNoticePeriodResource` and let `days_remaining` go
negative, which is what every reader here already assumes it does - but that is a wire change, and the
client-side fix needs no coordination.

---

## 61. `ShiftsAdmin` is the one settings card-list editor still reading a single page with no truncation notice - the roster that consumes the same catalog reads all of it

**Where.** `web/src/pages/ShiftsAdmin.tsx:41`.

```ts
const { rows, state, error, reload } = useCollection<Shift>("shifts");
useDeepOpen(openId, rows, openEdit);
```

No `{ all: true }`, no `TruncationNotice`, and the page renders a **card list** (`:120-140`), not a
`DataTable` - so it gets none of `DataTable`'s automatic disclosure either. `DataTable.tsx:564` derives
`const truncated = hasMore ?? autoHasMore` from the store and prints *"Showing 1-100 of 100+ — first page
only"*; a bare `<Card>` list has no such row. The first hundred shifts silently present themselves as the
whole catalog.

**The same file's two siblings were fixed for exactly this, and their comments state the rule.**

`ProjectsAdmin.tsx:34-40`:

> *"`all`: this is the whole catalog rendered as a CARD GRID, not a list page. A DataTable admits a window - it
> draws "Showing 1-100 of ..." and a Load more - but a grid of cards has nowhere to say so and nothing for a
> reader to press, so the first page silently presented itself as the entire catalog: past a hundred projects
> an admin could not see, edit or archive the rest of them, and `useDeepOpen` below could not open a link to
> one either."*

`BenefitPlansAdmin.tsx:40-46`:

> *"first hundred plans silently read as the whole catalog, and a deep link to any plan past them opened
> nothing. ... And the TruncationNotice below for the same reason ProjectsAdmin carries one: the walk stops at
> the hook's `ALL_CAP`, so `all` moves the window rather than removing it, and the grid still needs somewhere
> to admit that it is showing part of the catalog."*

A survey of every settings catalog editor puts `ShiftsAdmin` alone on the wrong side of that line: the
DataTable-backed ones (`PayGradesAdmin`, `SalaryStructuresAdmin`, `GoalTemplates`, `AssetCategories`,
`ExpenseCategories`, `ReimbursementCategories`, `Vendors`, `PayComponents`, `LeaveTypes`) at least surface
`autoHasMore`; the two card-list ones (`ProjectsAdmin`, `BenefitPlansAdmin`) pass `{ all: true }` **and** carry
a notice. `ShiftsAdmin` does neither.

**The consumer of the catalog already reads all of it.** `web/src/pages/Schedule.tsx:42`:

```ts
const { rows: shifts, state: shiftsState, reload: reloadShifts } = useCollection<Shift>("shifts", { all: true });
```

So the roster can place, colour and legend a shift that its own editor will not list - the admin sees the
shift on the grid, opens Settings to change its times, and it is not there.

**What else the window breaks in this file, all of it named by the siblings' comments:**

- `useDeepOpen(openId, rows, openEdit)` (`:42`) - a deep link to `shifts/<id>` past the first page opens
  nothing at all, silently.
- `duplicateName` (`:60`) - *"Two shifts with the same name are indistinguishable everywhere they matter
  (roster cell, legend, filter), so the clash is caught here rather than discovered on the grid"* - the clash
  is only caught against the loaded window, so past a hundred shifts the guard passes and the duplicate is
  discovered on the grid after all, which is the outcome the comment says it exists to prevent.
- `openCreate` / `nextBlank` (`:74`, `:89`) pick the next colour as `COLORS[rows.length % COLORS.length]`, so
  with `rows.length` pinned at the page cap the rotation stops rotating and every new shift past the hundredth
  is assigned the same colour - on a surface whose whole point is telling shifts apart by colour.

**Fix.** `useCollection<Shift>("shifts", { all: true })` and a `<TruncationNotice collection="shifts"
what="shifts" />` above the list, matching `ProjectsAdmin.tsx:40` / `:107` and `BenefitPlansAdmin.tsx:46`
exactly. That also lines the editor up with `Schedule.tsx:42`, which is the read it has to agree with.

---

## 62. `BankFormats` replaces the live bank template in R2 the moment a file is picked, while the column mapping it belongs to only lands on Save - so an abandoned upload leaves the payroll export writing old mappings into a new workbook

**Where.** `web/src/pages/BankFormats.tsx:136-176` (`onTemplate`) and `:181-224` (`save`), against
`src/services/bankFormats.ts:184-196` and `src/services/bankFile.ts:77-80`.

The page presents this as a two-step flow, and says so in its own toast:

```ts
const out = await upload<{ r2_key: string; file_name: string }>(`bank-formats/${encodeURIComponent(sel)}`, file, { verb: "uploadTemplate" });
setDraft({ columns, header_row: 1, data_start_row: looksLikeInstructions ? 3 : 2, sheet, template_name: out.file_name ?? file.name, r2_key: out.r2_key });
toast({ title: "Template imported", description: `${columns.length} columns from "${sheet}". Map each below, then Save.` });
```

*"Map each below, then Save"* is only true of the **mapping**. The **bytes** are already committed, and they
are committed to a key that is a pure function of the bank name:

```ts
export function templateKey(bank: string): string {
  const slug = bank.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "bank";
  return `bank-formats/${slug}/template.xlsx`;
}

export async function storeBankTemplate(deps, actor, bank, bytes, fileName) {
  ...
  const r2Key = templateKey(bank);
  await deps.docs.put(r2Key, bytes, XLSX_CONTENT_TYPE);
```

One key per bank, `put` overwrites, no draft key and no versioning. And the exporter reads that key directly -
**not** the `r2_key` stored on the format row:

```ts
export async function getBankTemplate(deps: Deps, bank: string): Promise<ArrayBuffer | null> {
  return deps.docs.get(templateKey(bank));
}
```

`src/services/bankFile.ts:77-80` then pairs the two independently:

```ts
const fmt = (await getBankFormats(deps))[bank];       // <- written only by Save
if (!fmt?.columns?.length) throw invalidArgument(`no format configured for ${bank}`);
const tpl = await getBankTemplate(deps, bank);        // <- written by the file picker
```

**So the mapping and the workbook it maps into are updated by two different user actions, only one of which
the UI treats as a commit.**

**What goes wrong.**

1. An admin opens the HDFC format to check something and picks the wrong `.xlsx` (or the bank's *new* template,
   intending to review the detected columns first). The old template is gone from R2 the instant the parse
   succeeds. Nothing on screen says the stored template has changed - the card at `:253` just shows the new
   `draft.template_name`, which reads like an unsaved draft field because every other field on the panel is one.
2. They look at the detected columns, decide it is not right, and navigate away without pressing Save (or hit
   the unsaved-changes guard and choose to discard - `useUnsavedTracker` at `:133` offers exactly that). The
   mapping is untouched. The workbook is not.
3. The next payroll publish calls `buildBankFile`, gets **the old column mapping** and **the new workbook**,
   and writes each payment row's fields into whatever columns the old mapping names. If the new template moved
   a column - and a bank issuing a new template is the usual reason anyone uploads one - beneficiary names,
   IFSC codes and net amounts land under the wrong headers in a file that goes to a bank for bulk disbursement.

Even with no abandonment there is a live window: between the upload and the Save, any approved run's bank file
is generated from the mismatched pair.

**The panel already knows how to do this correctly for the thing beside it.** The column mapping is written
with `If-Match` and a named conflict path (`:190-203`), with a comment saying why a whole-document write needs
one. The template - the other half of the same artefact - has no commit step at all.

**Fix.** Make the upload part of the Save, not part of the picker. Parse the headers locally for the preview
(the parse at `:154-164` needs no server round trip), hold the `File` in state, and `upload(...)` inside
`save()` immediately before the `patch` - so a discarded draft uploads nothing, and a saved one writes both
halves in one action. If the upload must stay eager, it has to be staged: write to a draft key
(`bank-formats/<slug>/template.<uploadId>.xlsx`), store that key in the format row on Save, and have
`getBankTemplate` read `fmt.r2_key` rather than recomputing `templateKey(bank)` - at which point the stored
row is once again the single source of truth for which workbook a bank's export uses.

---

## 63. `BankFormats` reads the whole picked file into memory before applying the size cap the comment says exists to stop exactly that

**Where.** `web/src/pages/BankFormats.tsx:139-150`.

```ts
const buf = await file.arrayBuffer();
const bytes = new Uint8Array(buf);
// Reject anything that is not really a workbook BEFORE handing bytes to the parser. This is the app's
// only parse of a caller-supplied spreadsheet, and it runs on the main thread, so it is kept on a short
// leash regardless of which SheetJS build is installed: an .xlsx is a ZIP, so it must open with the
// local-file-header magic "PK\x03\x04", and the size cap mirrors the server's MAX_TEMPLATE_BYTES so a
// pathological file cannot burn the main thread. ...
if (bytes.length < 4 || bytes[0] !== 0x50 || ...) throw new Error("not an .xlsx file");
if (bytes.byteLength > MAX_TEMPLATE_BYTES) throw new Error(`file exceeds the ${MAX_TEMPLATE_BYTES / 1048576} MB limit`);
```

Both guards run **after** `await file.arrayBuffer()`, which materialises the entire file in the tab's heap.
The 5 MB cap can only reject a buffer that has already been allocated, so the case it names - *"a pathological
file cannot burn the main thread"* - is precisely the case it does not prevent. Picking a multi-gigabyte file
allocates it (or throws `RangeError: Array buffer allocation failed` / kills the tab) before line 150 is ever
reached.

`File.size` is a synchronous property on the `File` the picker hands over at `:290`
(`onChange={(e) => e.target.files?.[0] && onTemplate(e.target.files[0])}`), so the ordering costs nothing to
fix. The magic-byte check has the same shape but a much smaller fix: `await file.slice(0, 4).arrayBuffer()`
reads four bytes rather than the whole file.

Note the server gets the order right for its own copy of these checks -
`src/services/bankFormats.ts:184-187` tests `bytes.byteLength` before `isXlsx(bytes)`, and both before the R2
`put` - but the server is handed bytes it did not choose to read; the client is the only side that can decline
to read them.

**Fix.**

```ts
if (file.size > MAX_TEMPLATE_BYTES) throw new Error(`file exceeds the ${MAX_TEMPLATE_BYTES / 1048576} MB limit`);
const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
if (head.length < 4 || head[0] !== 0x50 || head[1] !== 0x4b || head[2] !== 0x03 || head[3] !== 0x04) throw new Error("not an .xlsx file");
const buf = await file.arrayBuffer();
```

---

## 64. Four hand-rolled dialogs guard Enter-to-submit with a weaker condition than the Save button beside them, so pressing Enter commits what the button refuses - including a salary structure the server has no validation for

`DialogContent`'s `onEnterSubmit` fires on Enter from **any** `<input>` in the dialog, and the contract puts
validity on the caller (`web/src/components/ui/dialog.tsx:104-107`, `:161-170`):

```ts
// and buttons keep Enter for their own use - except with Cmd/Ctrl held, which submits from anywhere in the
// dialog ... Callers should guard validity inside the handler.
onEnterSubmit?: () => void;
...
const fromInput = el.tagName === "INPUT" && (el as HTMLInputElement).type !== "file";
if (fromInput || e.metaKey || e.ctrlKey) { e.preventDefault(); onEnterSubmit(); }
```

The shared `WriteDialog` does this correctly - `run()` re-checks the same flag the button uses
(`components/common/WriteDialog.tsx:146-150`, `:229`), so the two cannot diverge:

```ts
async function run(after: "close" | "again") {
  if (busy) return;
  if (!canSubmit) { setArmed((n) => n + 1); return; }
```

Four dialogs that build their own footer instead pass a **subset** of the button's condition. Enter then does
what the disabled button will not.

### 64a. `SalaryStructuresAdmin` - the worst of the four, because the client is the only guard

`web/src/pages/SalaryStructuresAdmin.tsx:196` against its own footer at `:269`:

```tsx
<DialogContent scrollBody onEnterSubmit={() => { if (!busy && form.name.trim()) void submit(); }}>
...
{/* Refused, not just flagged: at 100% or more the percentage lines claim the whole of basic, so
    there is no CTC this structure can split and nothing it could be applied to. Saving it puts a
    dead structure in the catalog that only fails later, on somebody's compensation revision, far
    from the form that made it - which is what the line above already says out loud. */}
<Button onClick={submit} loading={busy} disabled={!form.name.trim() || percentOfBasic >= 100}>
```

`percentOfBasic >= 100` is missing from the Enter path, and every rate field in the dialog is
`<Input type="number">` (`:216`) - exactly the element `fromInput` matches. Type a rate, press Enter, the
structure saves.

**The server does not catch it.** `src/services/salaryStructures.ts:29-45` `normalizeLines` validates that
each component exists, is live, is an `earning`, and is not duplicated - and nothing else. There is no
percentage-sum check anywhere in `salaryStructureSpec`. So the refusal the comment describes exists only in
that `disabled` expression, and Enter walks around it. The result is precisely the outcome the comment names:
a structure in the catalog that cannot split any CTC, failing later on somebody's compensation revision.

### 64b. `ExpenseBudgets`

`pages/ExpenseBudgets.tsx:894` vs `:993`:

```tsx
<DialogContent scrollBody onEnterSubmit={() => { if (!busy) void submit(); }}>
...
<Button onClick={submit} loading={busy} disabled={!valid}>{editing ? "Save changes" : "Create"}</Button>
```

`valid` is dropped entirely from the Enter path.

### 64c. `Schedule`

`pages/Schedule.tsx:457` vs `:591`:

```tsx
<DialogContent scrollBody onEnterSubmit={() => { if (!busy && shift) void save(); }}>
...
<Button onClick={save} loading={saving} disabled={!shift || removing || dates.length === 0}>
```

`dates.length === 0` is reachable - `toggleDay` (`:539`) can deselect the anchor day, and `dates` starts as
`[date]` (`:417`). With no days selected, `save` runs `onSave(shift, note, [])`, whose `runSequential` over an
empty list writes nothing, and the success path still closes the dialog and toasts *"Shift assigned"*
(`:364`). A scheduler is told the shift was rostered when no assignment was created.

### 64d. `Attendance` - validity is fine, concurrency is not

`pages/Attendance.tsx:1854` passes the handler bare:

```tsx
<DialogContent onEnterSubmit={submit}>
```

Validity survives, because `submit` opens with `if (!canSubmit) return;` (`:1842-1843`). What is missing is the
`busy` half. `submit` awaits `onSubmit` -> `submitCorrection` (`:453-470`), which dedupes only on
**resolved** writes:

```ts
if (filedThisDialog.current.has(day)) continue;
try {
  const sessions = ...;
  await create("attendance-regularizations", { date: day, sessions, reason: reason || undefined });
  filedThisDialog.current.add(day);
```

The `add` happens after the `await`, so two Enters in flight both pass the `has(day)` test and both `create`.
The ledger that exists to stop a retry re-filing a day does not stop a concurrent one, and holding Enter files
duplicate correction requests for the same day - which then need approving or rejecting individually.

**Fix.** The general one: have each `onEnterSubmit` call the same guarded entry point the button does, rather
than restating a condition that can drift from it - i.e. push the check inside `submit`/`save` (as
`Attendance`'s `submit` already does for validity, and as `WriteDialog.run` does for both), so there is one
expression, not two. Concretely:

- `SalaryStructuresAdmin.submit`: `if (busy || !form.name.trim() || percentOfBasic >= 100) return;` at the top,
  and consider adding the same sum check server-side in `normalizeLines` - a rule enforced only by a
  `disabled` attribute is not enforced.
- `ExpenseBudgets.submit`: `if (busy || !valid) return;`
- `Schedule.save`: `if (saving || removing || !shift || dates.length === 0) return;`
- `Attendance.submit`: add the busy check - `if (!canSubmit || correctionBusy) return;` - or move
  `filedThisDialog.current.add(day)` to before the `await` and remove it on failure.

---

## 65. `Overtime` reads every date in the VIEWER's timezone while the punch lookup beside it reads the ORG's, so the two never agree across a midnight boundary - and monthly overtime totals differ per viewer

**Where.** `web/src/pages/Overtime.tsx:39-46` (the helpers), `:74-98` (the totals), `:106-110` (the seed),
`:137-165` (the punch effect).

Every date helper in the file is built on the browser's clock:

```ts
// ISO instant -> "YYYY-MM-DDTHH:mm" in the viewer's local time, for <input type="datetime-local"> (mirrors Events).
const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const localYmd = (iso?: string) => (iso ? toLocalInput(iso).slice(0, 10) : "");
const localHhmm = (iso?: string) => (iso ? toLocalInput(iso).slice(11, 16) : "");
const thisMonth = () => toLocalInput(new Date().toISOString()).slice(0, 7);
```

The page also holds the org's timezone the whole time - `const sched = useClock().sched; // org shift end +
timezone` (`:53`) - and the punch effect uses it correctly, with a comment stating the rule:

```ts
// The window is in UTC instants and the day is org-local, so it is widened by a day on each side and
// the exact day is settled by localDay below - otherwise a zone behind UTC loses its own evening.
...
const tz = sched.timezone;
const ends = sessions
  .filter((s) => s.employee && idOf(s.employee) === idOf(form.employee) && s.clock_out && localDay(s.clock_out, tz) === formDay)
```

**`formDay` is not org-local.** It is `const formDay = localYmd(form.start_time);` (`:136`) - the *viewer's*
day. The filter therefore compares an **org-local** day string on the left to a **viewer-local** day string on
the right, inside the one effect that documents the distinction.

**Where they diverge is exactly this page's subject matter.** Overtime is by definition worked late, so its
instants sit near a midnight. Take an IST org and an admin (or a travelling employee) on UK time: a session
clocked out at 01:30 IST on 11 March is the instant `2026-03-10T20:00Z`. `localYmd` renders it `2026-03-10`;
`localDay(..., "Asia/Kolkata")` renders it `2026-03-11`. The filter matches nothing, and the
*"range read off the day's punches, offered as a chip"* (`:61-63`) - the whole point of which is that
*"the hours are already recorded, so retyping them from the punch log is work the form can do"* - silently
never appears. There is no error; the chip simply is not there, for precisely the late shifts it was built for.

**The same mismatch moves money-adjacent totals.** All of these bucket by the viewer's calendar:

```ts
.filter((r) => ... && localYmd(r.start_time).slice(0, 7) === cur)   // myMonthMinutes, :74-80
if (upper(r.state) !== "APPROVED" || localYmd(r.start_time).slice(0, 7) !== month) continue;   // monthlyTotals, :88-97
```

so two HR admins in different timezones open the same page, pick the same month, and read **different approved
overtime totals per employee** - the numbers that sit next to `unpaidMinutes` (`:81-84`, approved-but-not-paid)
and feed the overtime payout conversation. The month picker's own label is viewer-local too
(`new Date(\`${month}-01T00:00:00\`)`, `:99`, no `Z`), so the header agrees with the wrong bucketing rather
than exposing it.

**And the form's default is 6pm in the wrong zone.** `openCreate` (`:106-110`):

```ts
const s = new Date(); s.setHours(18, 0, 0, 0);
const e = new Date(s.getTime() + 3600000);
```

`setHours` is viewer-local, so a remote employee's overtime form pre-fills 18:00-19:00 *their* time, not the
org's - while `sched.shift_end`, the org's actual shift end, is right there and is what the punch effect uses
as the overtime boundary (`:161`).

**Fix.** Replace the three helpers with the org-local pair the app already ships:
`orgDayOf(iso)` from `lib/orgDay.ts:56-58` for the day, and `localDay`/`localMinutes` from `lib/attendance`
(already imported here) for the day and the time-of-day, all passed `sched.timezone`. Then `formDay`,
`myMonthMinutes`, `monthlyTotals`, `thisMonth` and the table's date/worked columns all read in the same zone as
the punch filter and as the server. Seed `openCreate` from `zonedInstant(orgDayOf(Date.now()), sched.shift_end,
sched.timezone)` rather than a hard-coded viewer-local 18:00.

Note the helper block's own comment says it *"mirrors Events"* - so `pages/Events.tsx` carries the same
viewer-local `toLocalInput` shape and is worth checking under the same rule.

---

## 66. `Events`' month grid draws org-local day cells but files timed events into them by UTC day, so an evening event west of UTC shows on tomorrow and an early-morning one in IST shows on yesterday

**Where.** `web/src/pages/Events.tsx:622-635` (`byDay`) against `:617-620`, `:641-643` and `:662-665`.

The grid is deliberately org-local, and says so twice:

```ts
// The month cursor starts on the ORG's month. Built from local `getFullYear()`/`getMonth()` anchored at UTC,
// "Today" could land on the wrong month either side of a boundary - and the grid it opens is compared against
// `todayStr()` below, which is the org's day.
const [cursor, setCursor] = useState(() => orgMonthStart());
```

```ts
// The ORG's date for the "today" ring. Local parts were right to avoid UTC and wrong about whose day it
// is - the ring should mark the day the rest of the app, and the server, call today.
const today = todayStr();
```

with `const orgMonthStart = () => new Date(\`${todayStr().slice(0, 7)}-01T00:00:00Z\`);` (`:90`). Each cell's
key is that UTC-anchored ladder read back as a day string, and it is compared to the org day:

```tsx
const ymd = d.toISOString().slice(0, 10);
const items = byDay.get(ymd) ?? [];
...
<span className={cn(..., ymd === today && "bg-primary font-semibold text-primary-foreground", ...)}>
```

**But the events are bucketed by UTC day, not by org day:**

```ts
for (const e of live) {
  const from = new Date(startMs(e));
  const to = new Date(endMs(e));
  for (let d = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()); d <= +to; d += DAY_MS) {
    const k = new Date(d).toISOString().slice(0, 10);
```

and for a **timed** event `startMs` is a real instant - `const startMs = (e: Event) => (e.all_day ?
Date.parse(e.start_time.slice(0, 10)) : +new Date(e.start_time));` (`:92`). `getUTCFullYear/Month/Date` on that
instant gives the **UTC** calendar date. The cell labels mean "the org's day"; the keys mean "the UTC day".

**What goes wrong.** Wherever the org's offset pushes its local date across UTC midnight, the event lands one
cell away from the day it happens on:

- `America/New_York` (UTC-5): an all-hands at **19:00 on 11 March** is `2026-03-12T00:00Z`, so it is filed
  under `2026-03-12` and drawn on **12 March**. Evening events are the ordinary case for a company events
  calendar, so in a US org most timed events on the grid are a day late.
- `Asia/Kolkata` (UTC+5:30): a 08:00 standup on **11 March** is `2026-03-11T02:30Z` - correct - but anything
  before 05:30 IST falls into the previous UTC day and is drawn on **10 March**.

The knock-ons follow the same key:

- `dayEvents = byDay.get(dayOpen)` (`:645`) - opening a day shows the wrong day's events.
- `onAdd(ymd)` (`:669`) seeds a new event on the cell's UTC day, so clicking the day an event appears on and
  adding a second one puts them on different real days.
- The today ring (`ymd === today`) is drawn on the org's day, so on any date where the two disagree the ring
  and the events are on different cells - the grid contradicts itself on screen.

**All-day events are unaffected**, which is why this is easy to miss in a quick look: for them `startMs` is
`Date.parse(e.start_time.slice(0, 10))`, already a date-only UTC midnight, so the round trip through
`toISOString().slice(0, 10)` is lossless. Only timed events carry an offset to lose.

**Fix.** Bucket by the org day, not the UTC day. `lib/orgDay.ts:56-58` has the exact conversion
(`orgDayOf(instant)`), and `lib/attendance#localDay(iso, tz)` underneath it:

```ts
const from = e.all_day ? e.start_time.slice(0, 10) : orgDayOf(e.start_time);
const to   = e.all_day ? e.end_time.slice(0, 10)   : orgDayOf(e.end_time);
for (let k = from; k <= to; k = addDaysYmd(k, 1)) { ... }
```

- stepping day strings with `addDaysYmd` rather than adding `DAY_MS` to an instant, which is the shape
  `lib/orgDay.ts:77-84` already prescribes for day arithmetic. The cell ladder can stay UTC-anchored, because
once the keys are org day strings the two sides finally mean the same thing.

See also finding 65: `Overtime.tsx` carries the same viewer/UTC-vs-org confusion, and its helper block cites
this file (*"mirrors Events"*) as the source of the pattern.

---

## 67. `PayrollRuns` gates Approve on a hard-coded `me.role === "super_admin"` instead of the row's `can` hint, so a granted approver never sees the button and NOBODY can manage its access gate in access mode

**Where.** `web/src/pages/PayrollRuns.tsx:99` and `:468`, against `:470-474` and
`components/common/RowActions.tsx:25-30`.

```ts
const isSuperAdmin = me.role === "super_admin";
...
// Approval is restricted to super admins (also enforced server-side).
const steps = (NEXT[run.state?.toUpperCase()] ?? []).filter((s) => s.verb !== "approve" || isSuperAdmin);
```

The three lines immediately below it do the same job the way the rest of the app does - off the server's own
per-row hint:

```ts
const canBankFile = run.access?.can?.includes("bankFile") && [...];
const canStatutory = run.access?.can?.includes("statutoryReport") && [...];
const canDelete = run.access?.can?.includes("delete") && ...;
```

**The hint already answers this question.** `src/http/accessHint.ts:57` lists `approve` among the candidate
verbs computed for the collection:

```ts
"payroll-runs": ["delete", "submit", "approve", "publish", "build", "bankFile", "statutoryReport", "previewPayslip"],
```

so `run.access.can` contains `"approve"` exactly when the caller may invoke it - grants, ACL rules and all.

**And `RowActions` already enforces it.** `RowActions.tsx:27-30`:

```ts
// Central belt-and-braces: when the row's server-computed `can` is provided, a verb-carrying action the
// caller may not invoke is dropped here even if the page forgot to filter. Access mode shows everything -
// an admin manages the gates of actions they cannot use themselves.
const shown = am.enabled ? actions : actions.filter((a) => !a.verb || !can || can.includes(a.verb));
```

Every step is passed through with its `verb` (`:479`) and the row's `can` (`:486`), so deleting the
`isSuperAdmin` filter would change nothing for an ordinary non-super caller - `can` would drop Approve anyway.
What the extra filter adds is two failures:

**1. A caller the server would allow is shown nothing.** `payroll-runs.*.approve` is withheld from the payroll
role deliberately (`src/domain/grants.ts:503-509`, separation of duties), but "withheld by default" is not
"impossible": the whole access-rule system exists to grant a verb to a named subject, and the server's
`approve` verb (`src/routes/payrollRuns.ts:48`) is guarded by the same authz middleware as every other. Grant
it to a finance director and the server accepts their `:approve`; the SPA still hides the button, because it is
asking a question about their **role**, not about their **permission**. The only remedy is editing
`grants.ts`, which is exactly the thing access rules exist to avoid.

**2. Access mode cannot manage the gate.** The filter runs on the page, *before* `RowActions` gets the list -
and `RowActions` deliberately bypasses its own filter when access mode is on, so an admin can open the ACL
modal for actions they personally cannot press. Because the page has already removed the Approve step, that
escape hatch never sees it: for any admin who is not super_admin, **the Approve action has no manage-access
affordance anywhere in the app**. Its per-verb ACL is unreachable from the UI, alone among the eight verbs the
hint lists for this collection.

**Fix.** Drop the `isSuperAdmin` filter and let the shared mechanism answer:

```ts
const steps = NEXT[run.state?.toUpperCase()] ?? [];
```

`RowActions` hides what `can` does not contain, and access mode then exposes Approve's gate like every other
verb's. Separation of duties stays enforced where it is actually enforced - in `grants.ts` and in the authz
middleware - rather than being restated in the SPA in terms the authz system does not use. `isSuperAdmin` is
then unused on this page and can go with it.

---

## 68. `MoneyInput`'s `min`/`max` are inert - the component says it enforces them, and only annotates them, in a readback that is hidden below 1000

**Where.** `web/src/components/common/MoneyInput.tsx:77-80` and `:95-105`.

```ts
// `min`/`max` still mean what they mean on a number field; they just have to be enforced here now that the
// control is text. Kept out of the DOM so a browser doesn't apply them to a string.
const { min, max, ...inputProps } = rest;
```

They are pulled out of the DOM, and then nothing enforces them. The only thing that ever reads `min`/`max`
again is the readback line:

```tsx
{min != null && Number(value) < Number(min) ? ` · below the ${formatMoney(...)} minimum` : ""}
{max != null && Number(value) > Number(max) ? ` · over the ${formatMoney(...)} maximum` : ""}
```

and that line only renders when

```ts
const show = readback && value.trim() !== "" && Number.isFinite(n) && Math.abs(n) >= 1000;
```

So for any amount whose magnitude is under 1000 the out-of-range note is not merely unenforced, it is not
even **shown**. `sanitize` (`:37-48`) deliberately accepts a leading `-`, so `-250` is typable in a field
declared `min={0}`, and the control gives no feedback of any kind.

Every current call site passes `min={0}` (twenty-odd fields across `Reimbursements`, `Expenses`, `Loans`,
`PayComponents`, `PayGradesAdmin`, `ExpenseBudgets`, `TaxDeclarations`, `PayrollBonuses`), and `Loans.tsx:359`
also passes `max={loan.outstanding}` for a repayment. **Nothing is currently broken by this**, because each of
those forms re-checks the amount itself (`Loans.tsx:338` `const valid = n > 0 && n <= loan.outstanding + 0.001`,
`Expenses.tsx:450-455`, `Reimbursements.tsx:382`, and so on) and the server validates independently
(`src/services/expenses.ts:102-103`, `src/services/payComponents.ts:45-52`). The defect is that the component
**advertises** a guarantee it does not provide: a future field that passes `min`/`max` and trusts them - the
natural reading of both the prop names and the comment - will silently accept out-of-range money, and the
first sign of it will be a server error or, where a server check is missing, a stored negative amount.

The two ways out are both small; either is fine, but the comment must match whichever is chosen:

- **Make it true.** Surface the violation as a real invalid state - render the out-of-range note whenever
  `min`/`max` are breached regardless of magnitude (drop the `>= 1000` gate for that branch), set
  `aria-invalid`, and clamp or reject in `sanitize`/`onChange`. Callers can then stop restating the bound.
- **Make it honest.** Rename the props to something that reads as advisory (or drop them and let callers pass
  the note), and delete the "have to be enforced here" sentence.

Related: `sanitize` also turns a leading bare `"."` into a digit-only string (`".5"` -> `"5"`, because the
`"."` branch requires `out !== ""`), which silently multiplies a pasted `.75` by ten. Worth handling in the
same pass by seeding `"0."`.

---

## 69. `EmployeeDocuments` is the one profile panel that reads the whole shared collection and filters in the browser, so on an HR-scoped account a person's documents tab can render "No documents on file" while their documents exist

**Where.** `web/src/components/common/EmployeeDocuments.tsx:19-25`.

```ts
// Personal (employee-owned) documents; the server scopes the list to what the caller may see, and we
// narrow to this employee. Org-wide documents live on the Documents page, not the profile.
const { rows } = useCollection<DocumentResource>("personal-documents");
...
const docs = useMemo(
  () => rows.filter((d) => d.employee && idOf(d.employee) === employeeId),
  [rows, employeeId]
);
```

One page, no `{ all: true }`, no `?employee=` narrowing, and no truncation affordance anywhere in the card.
`rows` is the first 100 `personal-documents` **the caller can read, ordered newest-first across the whole
org**, and this panel keeps whichever of them happen to belong to the employee being viewed.

**What goes wrong.** The comment's *"the server scopes the list to what the caller may see"* is true and is
exactly the problem: for an employee that scope is their own documents, so the panel is usually right; for HR,
payroll or super_admin it is the org's entire document shelf, and a hundred rows of that is a few days of
uploads in any company of size. Open `employees/<id>` for someone whose last document was filed a month ago
and the card renders its empty state - **"No documents on file."** - over a shelf that is not empty. There is
no "showing part of" line, no `TruncationNotice`, nothing that distinguishes "this person has no documents"
from "this person's documents are not in the window".

The same window silently breaks the panel's other derivation. `officialFys` (`:29-32`) decides which
HRMS-generated Form 16 is superseded by an official TRACES copy:

```ts
const officialFys = useMemo(
  () => new Set(docs.filter((d) => d.document_type === "FORM16" && d.official && d.financial_year).map((d) => d.financial_year)),
  [docs]
);
```

If the official copy is outside the window and the generated one is inside it, the generated copy is presented
as current rather than **Superseded** - and the badge's whole purpose (`:27-28`: *"the official one is the one
to file"*) is to stop somebody filing the wrong Form 16 with the tax authority.

**The server already offers the exact narrowing this needs, and every sibling panel uses it.**
`src/routes/documentRoutes.ts:69-71`:

```ts
// `?employee=employees/<id>` narrows personal-documents to one person (org-documents have no owner and
list: (c, page) => svc.list(..., c.req.query("employee") || undefined),
```

and in `web/src/components/common` the pattern is otherwise universal:

| panel | read |
|---|---|
| `EmployeeSettlement.tsx:38` | `settlements?employee=employees/<id>` |
| `EmployeeBonuses.tsx:44` | `bonuses?employee=employees/<id>` |
| `EmployeeCompensation.tsx:134` | `compensation?employee=employees/<id>` |
| `MyCompensation.tsx:35` | `compensation?employee=employees/<id>` |
| `EmployeeRoleHistory.tsx:39` | `positions?employee=employees/<id>` |
| `EmployeeAssets.tsx:64`, `:69` | `assets?employee=...`, `asset-requests?employee=...` |
| **`EmployeeDocuments.tsx:19`** | **`personal-documents` (whole collection), filtered client-side** |

It is used on both `#/profile` (`pages/Profile.tsx:236`) and `#/employees/<id>`, so the HR-facing case is the
common one.

**Fix.** Read it the way its six siblings do:

```ts
const empRef = `employees/${employeeId}`;
const r = await get<{ results: DocumentResource[] }>(`personal-documents?employee=${encodeURIComponent(empRef)}`);
```

That also drops the panel's cost from "a page of the org's documents" to "this person's documents", which is
the `d1-read-minimization` shape the rest of the profile already follows. If the shared-store caching of
`useCollection` is wanted, pass the filter through it and keep a `TruncationNotice` for the residual cap -
but a client-side `filter` over an unfiltered page cannot be made correct by either.

---

## 70. The employee's handwritten signature image is recorded by session replay in full, in both places it renders - it is an `<img>`, and the block list only covers `canvas` and `iframe`

**Where.** `web/src/components/common/SignatureField.tsx:37-41`, `:124-126`;
`web/src/components/common/SignDocumentDialog.tsx:154`, `:229`; against `web/src/instrument.ts:93-96`,
`:169`.

The replay posture is stated as unmask-by-default:

```ts
const REPLAY_PRIVACY = {
  // Recorded, so a replay shows the page as the person saw it.
  maskAllText: false,
  maskAllInputs: false,
  blockAllMedia: false,
```

and the only media excluded is:

```ts
// Replaced entirely rather than masked: these are not text, so masking would not touch them. An iframe here
// is always a rendered PDF (payslip, letter, Form 16) and a canvas is a chart, a barcode or a signature pad.
block: [".sentry-block", "[data-sentry-block]", "iframe", "canvas"],
```

The comment reaches for a **signature pad** as the reason `canvas` is on the list - so the concern was
identified. But the stored signature is not drawn on a canvas. It is fetched as a **data URL** and rendered as
a plain `<img>`:

```tsx
// SignatureField.tsx:37-41 (SignatureImage)
const src = useSignatureUrl(employeeId, signature);
if (!signature || !src) return null;
return <img src={src} alt="Signature" className={className ?? "h-12 object-contain"} />;
```

```tsx
// SignatureField.tsx:124-126 (the profile panel)
{src ? <img src={src} alt="Your signature" className="max-h-24 max-w-full object-contain" /> : ...}
```

`img` is not in `block`, `blockAllMedia` is `false`, and `dataUrl` (`api.ts:680-688`) inlines the bytes into
the `src` attribute, so the image travels inside the DOM snapshot rrweb serialises. Anyone with replay access
gets a pixel-accurate, extractable copy of the person's signature.

**Neither render site is covered by anything else.**

1. `pages/Profile.tsx:202` mounts `SignatureField` on `#/profile`. `SENSITIVE_PAGES` (`instrument.ts:53-71`)
   does not include `profile` or `employees` - the comment at `:35-39` says the employee profile was
   deliberately taken off that list - and `SignatureField` carries no `sentry-mask` of its own. It is not one
   of the seven panels `test/replayMaskCoverage.test.ts` pins (`SENSITIVE_DIALOGS`, lines 25-33:
   `EmployeeBankDetails`, `EmployeeCompensation`, `EmployeeTaxDetails`, `EmployeeSettlement`,
   `EmployeeBonuses`, `EmployeeIdentityDetails`, `EmployeePersonalDetails`), so nothing fails if it is
   forgotten - and it was.

2. `SignDocumentDialog.tsx:229` renders `SignatureImage` inside a dialog whose `DialogContent` (`:154`) has no
   `sentry-mask` either. That dialog is opened from `#/documents`, which **is** a masked route - and the mask
   still cannot reach it, for the reason the test file states in its own header:

   > *"A dialog renders through a PORTAL, as a child of `<body>`, so it is outside `<main data-page="…">` and
   > the route-level masking in web/src/instrument.ts cannot reach it: the page behind 'edit bank details' is
   > masked and the account number in the open form is not."*

   The signature is the exact shape of that hazard, and it is the one credential on screen at the moment the
   person presses **Sign**.

**Why a signature outranks the things that are masked.** `SignatureField.tsx:115` states its purpose: *"Used
as your e-signature when you acknowledge policies and on generated letters."* A masked salary tells a reader
what someone earns; a leaked signature bitmap can be pasted onto a document. It is also unchangeable in the
sense the mask list already uses for PAN and Aadhaar - *"that a person cannot change if they leak"*
(`instrument.ts:117-118`).

**Fix, in the file's own idiom.**

- `data-sentry-block` on both `<img>` elements in `SignatureField.tsx` - **block**, not mask: masking is a
  text operation and, as the `block` comment says, "these are not text, so masking would not touch them". A
  blocked image leaves a placeholder box, which is all a replay needs from it.
- Alternatively add `img[alt*="signature" i]` to `block`, so a future render site is covered without anybody
  remembering - the stated preference at `:85-87` ("the list below leans on things that do not depend on
  anybody remembering").
- Add `SignatureField` to `SENSITIVE_DIALOGS` in `test/replayMaskCoverage.test.ts` (or a sibling assertion for
  blocked media) so the tag cannot be dropped silently, and put `sentry-mask` on
  `SignDocumentDialog`'s `DialogContent` - it also shows the document body and the signer's legal name in a
  portal that no route mask reaches.

Related: findings 43, 44 and 54 cover the rest of this gap - `App.tsx:718-724` claims replay masking covers
"the profile", while `instrument.ts:53-71` does not list it.

---

## 71. `EmergencyQuickView` records blood group, allergies and free-text medical notes into session replay - the only genuinely medical fields in the app, and the one profile dialog with no mask

**Where.** `web/src/components/common/EmergencyQuickView.tsx:154`, `:137-139`, `:196-206`.

The dialog's own header describes what it holds (`:23-24`):

> *"Heart-pulse button that opens the emergency modal - the single place to both view and edit emergency info
> (contacts, blood group, allergies, medical notes)."*

Both the read view and the edit form render those fields:

```ts
["Blood group", d.blood_group, "blood_group"],
["Allergies", d.allergies, "allergies"],
["Medical notes", d.medical_notes, "medical_notes"],
```

```tsx
<Field label="Allergies" field="personal-info.allergies" hint="Anything a paramedic should know before treating them."><Textarea ... /></Field>
<Field label="Medical notes" field="personal-info.medical_notes"><Textarea ... /></Field>
```

and the dialog opens with **no mask**:

```tsx
<DialogContent scrollBody onEnterSubmit={() => { if (edit && !saving) void save(); }}>
```

**Nothing else covers it.** It is mounted from `pages/Profile.tsx:167` and from the employee page, and:

- `#/profile` and `#/employees/<id>` are **not** in `SENSITIVE_PAGES` (`web/src/instrument.ts:53-71`) - the
  comment at `:35-39` says the employee profile was deliberately taken off that list;
- it renders through a **portal**, so even if the route were masked the mask would not reach it - the exact
  hazard `test/replayMaskCoverage.test.ts:5-10` was written for;
- it is not in that test's `SENSITIVE_DIALOGS` (`:25-33`), which lists bank, compensation, tax, settlement,
  bonuses, identity and personal details - every category **except** the medical one;
- the field-name rules in `instrument.ts:114-120` match `account`, `ifsc`, `pan`, `aadhaar`, `uan`; nothing
  matches `blood_group`, `allergies` or `medical_notes`, and the last two are `<Textarea>`, which none of
  those `input[...]` selectors can match in any case.

So with `maskAllText: false` and `maskAllInputs: false` (`:94-96`), a replay of anyone opening the emergency
panel carries the person's blood group, their allergy list and whatever their HR team wrote in "medical notes"
as plain recorded text, plus the keystrokes as they type them.

**This is the category the masking policy says it protects.** `instrument.ts:44-52` sets the bar as *"values
[that are] something the app itself PROMISED would not be read by a bystander"*, and the coverage test's own
framing of the confidential set is *"the promises the rest of the product makes ... plus the two fields that
are routinely medical"* - by which it means a **leave reason**, masked in three separate places
(`Leaves.tsx` column and detail, `RequestLeaveDialog`'s textarea with `data-sentry-ignore` as well, and
`components/calendar/shared.tsx`) because *"Leave is the ordinary-looking request whose free text is a
diagnosis or a bereavement."* A field that may be a diagnosis is masked three times over; the field that **is**
a diagnosis is not masked at all.

**Fix.**

- `<DialogContent scrollBody className="sentry-mask" ...>` on `:154`, matching the seven sibling panels.
- `data-sentry-ignore` alongside on the two `<Textarea>`s (`:205-206`), because keystroke recording is a
  separate channel from element masking - the same pairing `RequestLeaveDialog` uses and that
  `test/replayMaskCoverage.test.ts:113-120` asserts.
- Add `EmergencyQuickView` to `SENSITIVE_DIALOGS` in that test so it cannot be dropped in a refactor, which is
  the stated reason the list exists: *"Per-dialog means someone has to remember, which is exactly the kind of
  thing that gets forgotten in a refactor and fails SILENTLY."*

See also finding 70 (the signature image on the same page) and findings 43/44/54.

---

## 72. `pages/Stocktakes` scores the whole inventory, reconciles every missing row and prints the numbers on an irreversible close confirm - all from one page of `assets`

**Where.** `web/src/pages/Stocktakes.tsx:48`.

```ts
const { rows: counts, setRows: setCounts, state, error, reload } = useCollection<Stocktake>("stocktakes");
const { rows: assets } = useCollection<Asset>("assets");                       // <- one page
const { rows: employees } = useCollection<Employee>("employees", { all: true });
const { rows: categories } = useCollection<AssetCategory>("asset-categories", { all: true });
```

Two of the four reads on that line walk their cursor. `assets` - the one whose size the page is *about* - does
not. Everything below is computed over the newest 100 assets the caller can see.

**1. The headline confidence score is an org-wide claim.** The file's own opening comment (`:30-34`):

> *"INVENTORY CONFIDENCE. A count says what happened in one walk. What an org actually wants to know is how
> much of its inventory can currently be PROVED, so the top of the page scores **every asset** against the
> org's own staleness window ... That is the number that tells you whether it is time to walk again."*

```ts
const confidence = useMemo(() => inventoryConfidence(assets, staleDays), [assets, staleDays]);
```

`inventoryConfidence` (`lib/stocktake.ts:76-97`) divides by `live.length` - the rows it was handed. With 400
assets and 100 loaded, *"Sighted in 180d: 92%"* is the freshness of the newest quarter of the inventory, and
the hint beside it reads **"`${confidence.fresh}` of `${confidence.total}`"** - a denominator that is the page
size, presented as the inventory. "Gone stale" and "Never sighted" are absolute counts of the same window, so
they under-report by construction, and the oldest assets - the ones most likely to be stale or never sighted -
are exactly the ones keyset ordering leaves out.

**2. "Still missing" reports found kit as lost.** `:193-194`:

```ts
{ id: "still", header: "Still missing", align: "right", accessor: (r) => reconcileMissing(r, assets).stillMissing, ... }
```

`reconcileMissing` (`lib/stocktake.ts:143-149`) builds `new Map(assets.map((a) => [a.path, a]))` and treats a
lookup miss as unresolved:

```ts
const seen = row.asset ? byPath.get(row.asset)?.last_verified_time : undefined;
const after = seen && !Number.isNaN(closedAt) && Date.parse(seen) > closedAt;
return { row, sightedAt: after ? seen : undefined, stillMissing: !after };
```

An asset outside the window has no entry, so `seen` is `undefined`, so `stillMissing` is `true`. The failure is
**directional**: every asset that turned up after the count but is not in the loaded page is re-reported as
still missing, and `(N turned up)` under-counts by the same amount. The header comment at `:35-38` says this
reconciliation exists so that *"a frozen missing list ... [does not] age into a list of things that were
probably found the next morning"* - and off-window, that is precisely what it produces. It signs off with
*"Free - the assets are loaded"*, which is the assumption that does not hold.

**3. The irreversible close is confirmed with the wrong numbers.** `:88-92` and `:95-104`:

```ts
const progressOf = (c: Stocktake) => {
  const scope = assets.filter((a) => inScopeWire(c.scope, a));
  const seen = scope.filter((a) => sightedIn(c, a));
  return { total: scope.length, seen: seen.length, missing: scope.length - seen.length, scope };
};
...
const ok = await confirm({
  title: `Close "${c.label}"?`,
  description:
    `${p.seen} of ${p.total} sighted, ${p.missing} missing. The result is frozen as it stands now and cannot be reopened` +
    (held ? `, and the ${held} missing item${held === 1 ? "" : "s"} that someone is holding will be notified to go and look.` : "."),
```

The dialog that asks an operator to freeze a result *"[that] cannot be reopened"* quotes a scope size, a
sighted count and a missing count taken from a partial inventory, plus a held-item count that decides how many
people get chased. `abandon` (`:116-124`) leans on the same `p.seen` to decide whether to say "nothing is
lost".

**4. The drill-down inherits it.** `banded` (`:82-84`) lists the assets behind each tile, so pressing
*"Never sighted: 3"* opens three rows out of however many there really are.

**The sibling page states the rule and follows it.** `pages/Assets.tsx:86-91`:

> *"`all: true`, because two things on this page are WRONG rather than merely short on one page: the
> duplicate-serial guard below searches these rows ... and **an inventory is the collection most certain to
> exceed a page** - so past 100 assets the warning simply stopped appearing, and an absent warning reads as
> "no clash", not as "not checked"."*

Every consumer on `Stocktakes` is in the "wrong rather than short" category, and there is no
`TruncationNotice` on the page either.

**Fix.** `useCollection<Asset>("assets", { all: true })`, matching `Assets.tsx:91` and the two `{ all: true }`
reads on the same line of this file. `ALL_CAP` is 1000, so add a `<TruncationNotice collection="assets"
what="assets" />` above the confidence strip for the residual case, and have `closeCount`'s description say
"of the assets loaded" if `collectionHasMore("assets")` is still true at that moment - a confirm for an
unreopenable action should not assert a total it cannot stand behind.

This is the same defect class as finding 51 (`components/assets/Stocktake.tsx`, the scanning modal) in the
page that owns the record half - the two together mean neither the walk nor its report sees the whole
inventory.

---

## 73. Seven date-only fields are still compared against `Date.now()` on the browser's or UTC's clock, so probation, joiner, compliance-due and sprint counters are a day out for part of every day - including one file that does it correctly five lines above

`lib/orgDay.ts:4-11` states the rule and the failure mode this whole module exists to remove:

> *"Twenty-odd files each defined `const todayStr = () => new Date().toISOString().slice(0, 10)`, which is the
> day in UTC - not the viewer's day and not the org's. In IST the two disagree between midnight and 05:30
> local ... West of UTC it goes the other way and is worse ... The server was moved off UTC deliberately; this
> is the half that was left behind."*

and ships `daysBetweenYmd(from, to)` (`:99-101`) for day-to-day arithmetic, used correctly in eight files
(`Goals.tsx:90`, `Boards.tsx:817`, `ReviewCycles.tsx:68`, `Offers.tsx:303`, `Leaves.tsx:55`, `Holidays.tsx:66`,
`lib/leaveCalendar.ts:19`, `TimeRangeField.tsx:31`).

The sweep missed the shape where a **date-only** value is turned into an instant and differenced against
`Date.now()`. An "age in hours" against a real timestamp (`update_time`, `last_verified_time`) is fine and
several pages do that correctly; these are calendar days, and each one is wrong for part of every day.

### The clearest one: `Directory` does it both ways, five lines apart

```ts
// pages/Directory.tsx:52-56
function joinBadge(e: Employee): "New" | "Joining" | null {
  if (!e.start_date || e.delete_time) return null;
  const days = (Date.now() - new Date(e.start_date + "T00:00:00").getTime()) / 86400000;   // viewer's midnight
  if (days < 0) return "Joining";
  return days <= 30 ? "New" : null;
}
// pages/Directory.tsx:64-67
function isJoiningSoon(e: Employee) {
  return !e.delete_time && !!e.start_date && e.start_date > todayStr();                     // ORG's day - correct
}
// pages/Directory.tsx:69-73
function isProbationDue(e: Employee) {
  if (e.delete_time || !e.probation_end_date) return false;
  const days = (new Date(`${e.probation_end_date}T00:00:00`).getTime() - Date.now()) / 86400000;
  return days <= PROBATION_SOON_DAYS;                                                        // viewer's midnight
}
```

`isProbationDue` drives the **"Probation due"** KPI (`:590`, hint *"ends in 30d"*) and its focus filter - a
list described in the code as *"a review somebody owes"*. `joinBadge` is duplicated verbatim in
`pages/OrgChart.tsx:37-42`, so both surfaces carry the same skew while `isJoiningSoon` next to it does not.

### `probationLabel` - the badge text says "ends today" a day late

`lib/utils.ts:117-121`:

```ts
export function probationLabel(endDate: string): string {
  const days = Math.ceil((Date.parse(endDate) - Date.now()) / 86400000);
  if (isNaN(days) || days < 0) return "";
  return days === 0 ? "On probation · ends today" : `On probation · ${days}d left`;
}
```

`Date.parse("2026-03-18")` on a date-only string is **UTC** midnight. Worked through for an IST org with an
end date of 18 March:

| org-local moment | UTC instant | `days` | rendered |
|---|---|---|---|
| 18 Mar 03:00 (the last day) | 17 Mar 21:30Z | `ceil(0.10)` = 1 | **"1d left"** - wrong, it ends today |
| 18 Mar 20:00 | 18 Mar 14:30Z | `ceil(-0.60)` = -0 | "ends today" - correct |
| 19 Mar 02:00 (probation over) | 18 Mar 20:30Z | `ceil(-0.85)` = -0 | **"ends today"** - wrong, it ended yesterday |

So the label is a day out for the first 5.5 hours of the last day, and again for the first 5.5 hours of the day
after. `pages/Profile.tsx:144` gates the badge on the same clock
(`Date.parse(emp.probation_end_date) >= Date.now()`).

### `Compliance` - the statutory "due this week" tile

`pages/Compliance.tsx:115-119`:

```ts
const isDueSoon = (c: ComplianceEvent) => {
  if (c.status !== "pending" || c.overdue) return false;
  const days = (Date.parse(`${c.due_date.slice(0, 10)}T00:00:00`) - Date.now()) / 86400000;
  return days <= 7;
};
```

Viewer-local midnight against `Date.now()`, in a file whose own header (`:40-43`) says:

> *"Local calendar date - toISOString() would report yesterday until UTC rolls over, mis-bucketing due/overdue.
> `todayStr` comes from lib/orgDay: the ORG's day. This file used to define its own from the browser's local
> parts, which is a different day for part of every day and a different day again from the one the server
> validates against."*

`advance()` twelve lines below it anchors at `T00:00:00Z` and is correct; `isDueSoon` is the one that was
missed. It feeds `stats.dueSoon` and the `dueSoon` focus filter over statutory filing deadlines, and it also
disagrees with `c.overdue`, which the server computes on the org's day.

### The rest

- `pages/BackgroundChecks.tsx:58-59` and `:231`: `new Date(c.initiated_date)` on a date-only string is **UTC**
  midnight, differenced against `Date.now()` for `isStaleCheck` (`> 14` days, *"the one to chase"*) and for the
  age printed in the table. A third clock again - neither the viewer's nor the org's.
- `pages/Boards.tsx:2388-2389`: `new Date(sprint.end_date + "T23:59:59").getTime() - Date.now()`, viewer-local,
  for the sprint's *"Days remaining, counting the end date itself as a working day"* - shown beside burndown.
  Note `Boards.tsx:817` in the same file uses `daysBetweenYmd(todayStr(), dueYmd)` for a card's due date.
- `lib/utils.ts:103-114` `tenureLabel` mixes `T00:00:00Z` for the start with `new Date()`'s UTC month for now;
  months only, so it slips by a day at a month boundary rather than by a day every day - the mildest of the set,
  but the same substitution fixes it.

**Fix, uniformly.** Every one of these is a calendar-day question and has the same one-line answer:

```ts
const days = daysBetweenYmd(todayStr(), ymd);   // from lib/orgDay - positive = in the future
```

- `joinBadge` (both copies): `const days = daysBetweenYmd(e.start_date, todayStr())`, `days < 0` -> "Joining",
  `days <= 30` -> "New" - or simply reuse `isJoiningSoon`'s string comparison for the first branch.
- `isProbationDue`: `daysBetweenYmd(todayStr(), e.probation_end_date) <= PROBATION_SOON_DAYS`.
- `probationLabel` / `Profile.tsx:144`: `daysBetweenYmd(todayStr(), endDate)`, with `< 0` meaning past.
- `isDueSoon`: `daysBetweenYmd(todayStr(), c.due_date.slice(0, 10)) <= 7`.
- `isStaleCheck` / the age column: `daysBetweenYmd(c.initiated_date, todayStr()) > STALE_DAYS`.
- sprint `daysLeft`: `daysBetweenYmd(todayStr(), sprint.end_date)`.

Each then has no offset to lose, agrees with the server, and agrees with the other predicate in the same file.

---

## 74. `Announcements` builds a monthly kudos podium and two multi-month charts out of the twenty posts the feed happens to have loaded - so they redraw as the reader scrolls

**Where.** `web/src/pages/Announcements.tsx:52`, `:175`, `:605-622`, `:790-833`.

The board is a paginated feed by design:

```ts
// How many posts the board reads at a time. The feed grows by another page each time the reader reaches its
// foot (see useInfiniteScroll), so this is the cost of opening the page, not a cap on what can be read. ...
const FEED_PAGE_SIZE = 20;
...
const { rows, setRows, state, error, reload, hasMore, loadMore } = useCollection<Announcement>("announcements", { enabled: !solo, max: FEED_PAGE_SIZE });
```

Twenty rows on a cold open, plus twenty per scroll. Three aggregates are then folded over `rows`:

```ts
// Most-recognized people this month (top 3 by points; a kudos with no level still counts as 1). Deliberately
// off `rows`, not `source`: it is a month rollup, not a result set, and it should not shrink while you type.
const leaderboard = useMemo(() => {
  const m = thisMonth();
  const by = new Map<string, number>();
  for (const a of rows) if (a.kind === "kudos" && a.recipient && (a.create_time ?? "").slice(0, 7) === m) by.set(a.recipient, (by.get(a.recipient) ?? 0) + (a.points || 1));
  return [...by.entries()].map(([e, n]) => ({ employee: e, count: n })).sort((a, b) => b.count - a.count).slice(0, 3);
}, [rows]);

// The two shapes behind the podium: who is being recognized (six months, so a good month does not read as
// a reputation) and how often recognition happens at all. Off `rows`, like the leaderboard.
const kudosCharts = useMemo(() => {
  const kudos = rows.filter((a) => a.kind === "kudos" && (a.create_time ?? ""));
  const sixMonthsAgo = new Date(Date.now() - 182 * 86_400_000).toISOString().slice(0, 10);
  const recent = kudos.filter((a) => (a.create_time ?? "") >= sixMonthsAgo && a.recipient);
  return {
    total: kudos.length,
    people: topSlices(recent, (a) => empName(a.recipient), (a) => a.points || 1, 8),
    months: monthlyTotals(kudos.map((a) => ({ date: (a.create_time ?? "").slice(0, 10), value: 1 })), 12, todayStr()),
  };
}, [rows, empName]);
```

The comment shows the instability question was asked and answered against the wrong variable: choosing `rows`
over `source` stops the podium shrinking **while you type in the search box**, but `rows` is the feed window,
so the podium changes every time the reader reaches the foot of the page.

**What each one claims, and what it actually shows.**

- **"Most recognized in `<Month>`"** (`:793`), rendered as a gold/silver/bronze podium with point counts
  (`:799-805`). Twenty mixed posts on a busy board might contain three kudos, so the podium is "the top three
  among the last handful of kudos", ranked and medalled. Scroll once and the ranking can reorder; scroll again
  and a fourth person can displace the leader. Nothing on the card says it is a partial count.
- **"Most recognized - Kudos points received over the last six months"** (`:815-822`). A six-month window read
  out of twenty rows. Its `ariaLabel` repeats the claim verbatim to a screen reader.
- **"Recognition over time - Kudos given each month - a culture, or a campaign."** (`:824-832`), a twelve-month
  line chart. On a cold open every month but the current one is zero, so the chart answers its own question
  with "a campaign" for any org whose feed is busier than twenty posts a month. `monthlyTotals(..., 12, ...)`
  pads the missing months, so the zeros look like data rather than like absence.
- The gate on the charts is `kudosCharts.total > 2` (`:813`) - a count of kudos in the window, not in the
  collection - so whether the charts appear at all depends on how far the reader has scrolled.

**A leaderboard is the one aggregate a window is least suited to.** It is ordinal and it is about people: an
employee who was recognised four times early in the month is displaced by someone recognised once yesterday,
purely because the feed reads newest-first. `useCollection` orders `(create_time, uid)` descending, so the
window is always biased towards the most recent posts, which is exactly the bias a month rollup must not have.

**Fix.** These are three aggregate questions and the feed is not the place to answer them.

- Cheapest correct fix: a second, narrow read for the rollups - `useCollection<Announcement>("announcements",
  { params: { kind: "kudos" }, all: true })` if the collection supports a kind filter, or a dedicated
  `kudos`-scoped read - kept separate from the feed's own pagination. The comment already reaches for exactly
  this idea ("a month rollup, not a result set"); it just has to be a different read, not a different variable
  derived from the same one.
- If a second read is not wanted, gate the three cards on `!hasMore` so they appear only once the feed is
  exhausted, and otherwise print what they are: "top three of the posts loaded so far".
- What must not stay is the current state - a medalled ranking of named colleagues whose order depends on the
  scroll position of whoever is looking at it.

---

## 75. `Suggestions`' duplicate guard and status chips are computed over the twenty posts the board has loaded, so the "somebody already asked for this" nudge almost never fires and the chip counts are a page size

**Where.** `web/src/pages/Suggestions.tsx:35`, `:56`, `:131-150`, `:218`, `:375-382`.

Like the announcements board, this is a feed that grows by a page at a time:

```ts
const BOARD_PAGE_SIZE = 20;
...
const { rows, setRows, state, error, reload, hasMore, loadMore } = useCollection<Suggestion>("suggestions", { enabled: !solo, max: BOARD_PAGE_SIZE });
```

### The duplicate guard

```ts
// Duplicate guard: the closest existing suggestion by shared words in the title. Deliberately loose - the
// point is to surface "somebody already asked for this", not to be a search engine.
const similar = useMemo(() => {
  const words = form.title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  if (!words.length) return null;
  let best: { s: Suggestion; score: number } | null = null;
  for (const s of rows) { ... }
  return best?.s ?? null;
}, [rows, form.title]);
```

`rows` is the newest twenty suggestions. The duplicate somebody is about to re-file is, by definition, one
that was filed **before** - usually weeks or months ago, and therefore outside the window. The guard fires
reliably only for an idea posted in the last twenty posts, which is the case where the submitter would have
seen it on screen anyway. Everywhere else it stays silent, and the composer prints nothing.

That silence is the failure mode `pages/Assets.tsx:86-91` spells out for the same shape of guard:

> *"the duplicate-serial guard below searches these rows ... so past 100 assets the warning simply stopped
> appearing, and **an absent warning reads as "no clash", not as "not checked"**."*

Assets answered it with `{ all: true }`. Here the window is five times smaller.

### The status chips

```ts
const statusCounts = useMemo(() => {
  const m = new Map<string, number>();
  for (const s of rows) m.set(s.status, (m.get(s.status) ?? 0) + 1);
  return m;
}, [rows]);
...
const count = st ? statusCounts.get(st) ?? 0 : rows.length;
```

Every chip - **All**, and one per status - shows a count of the loaded window (`:218`, `:230`). On a cold open
"All 20" is the page size rendered as a board total, and the per-status chips are worse: because the feed is
ordered newest-first, the terminal statuses (implemented, declined) are the ones that age out of the window,
so "Implemented" reads near zero on a board where most suggestions have been implemented. The numbers then
climb as the reader scrolls, which is not a behaviour a count chip has any way to explain.

### Why the fix is cheap here

The server already answers the search half: the sibling board passes `q` straight through
(`Announcements.tsx:183`, `useCollection<Announcement>("announcements", { q: debouncedQ, ... })`), and the
suggestions collection is listed the same way.

- **Duplicate guard:** make it a debounced server read - the composer's title is the query, `?q=` is the
  index - rather than a scan of the loaded page. That also makes it better at its stated job than a
  shared-word scan, since the FTS index covers the body too.
- **Chips:** either drop the numbers (a chip does not need one), or take them from a server-side count. A
  count that changes when you scroll is worse than no count.
- If neither is wanted, the minimum is to stop asserting: render the chips without counts while `hasMore` is
  true, and say "no similar suggestion **in the posts loaded**" rather than showing nothing at all.

Same defect family as finding 74 (`Announcements`' kudos podium and charts over the same 20-row feed window).

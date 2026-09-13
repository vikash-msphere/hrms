# Frontend pre-production review

Source-level pass over `web/src` (388 files, ~105k lines). No gates run, no docs read - every finding below
was read out of the source and, where a claim is empirically checkable, verified with a runnable snippet.

Ordered by severity. Each entry: what is wrong, where, how it shows up, and the fix.

---

## High

### 1. `formatDate()` renders date-only values in the *viewer's* timezone, so every calendar date is a day early west of UTC

`web/src/lib/utils.ts:62-67`

```ts
export function formatDate(value?: string | null): string {
  if (!value) return "-";
  const d = new Date(value);                       // "2026-12-25" -> UTC midnight (spec)
  if (isNaN(d.getTime())) return value;
  return dateFormat(DATE_LOCALE, DATE_OPTS).format(d);  // no `timeZone` -> the runtime's zone
}
```

A date-only ISO string is parsed as **UTC midnight**, then formatted by an `Intl.DateTimeFormat` carrying no
`timeZone`, which resolves to the browser's zone. The two disagree for the whole of the UTC offset.

Verified:

```
$ TZ=America/Los_Angeles node -e 'console.log(new Intl.DateTimeFormat("en-GB",
    {year:"numeric",month:"short",day:"numeric"}).format(new Date("2026-12-25")))'
24 Dec 2026
```

This is not a corner case: `formatDate` has **185 call sites**, and the great majority are date-only columns -
leave `start_date`/`end_date`, holiday `date`, timesheet `date`, `due_date`, `probation_end_date`,
`start_date` in the Directory, the dates inside every approve/reject confirmation dialog.

The clearest demonstration is `web/src/pages/Holidays.tsx:397`, which renders the weekday and the date side by
side out of two different helpers:

```tsx
cell: (h) => `${weekdayShortOf(h.date)}, ${formatDate(h.date)}`,
```

`weekdayShortOf` (Holidays.tsx:60) deliberately pins `timeZone: "UTC"` - its own comment says "parsed as UTC so
the label never shifts with the viewer's offset". `formatDate` does not. In `America/Los_Angeles` that cell
reads **"Fri, 24 Dec 2026"** for a holiday stored as `2026-12-25`: a weekday and a date that cannot both be
true, in the same string.

Note this is `formatDate` alone being the odd one out. The page-local helpers (`Leaves.tsx:59`,
`Timesheets.tsx:41`, `Schedule.tsx:35`, `Attendance.tsx:53`) all use `new Date(ymd + "T00:00:00")` - local
parse *and* local format, which round-trips the calendar day correctly.

**Fix.** Split the two cases in `formatDate`: when `value` is date-only (`/^\d{4}-\d{2}-\d{2}$/`), parse it at
`T00:00:00Z` and format with `timeZone: "UTC"`; keep the current behaviour for a full timestamp, where the
viewer's zone is the right one. `dateFormat` already caches per option-set, so the second formatter costs one
entry.

---

### 2. A single failed photo batch writes "this person has no photo" to disk for seven days

`web/src/lib/photoCache.ts:104-128`

```ts
try {
  const resp = await api(...);
  batch.forEach(([key, id]) => settle(key, got.get(id) ?? null));
} catch {
  batch.forEach(([key]) => settle(key, null));   // <-- every failure
}
```

and `settle` persists:

```ts
function settle(key: string, dataUri: string | null) {
  ...
  writeDisk(key, dataUri);     // -> put("faces", key, "")   ("" = stored known-no-photo)
}
```

So one transient failure of `employees:batchGetPhotos` - a 502 from a rolling isolate, a dropped connection, a
rate-limit refusal past the retry cap - does not merely blank that wave of avatars for the session. It records
a **known-no-photo verdict in IndexedDB**, which `readDisk` then hands back on every subsequent page load:

```ts
const stored = readDisk(key);
if (stored !== undefined) { e.dataUri = stored; e.settled = true; }   // needs no request at all
```

`settled` means no request is ever made again. The avatars stay blank across reloads for `MAX_AGE_MS.faces` -
**seven days** - or until that employee's `photo` version marker changes, whichever comes first. Nothing in the
app can correct it, because nothing knows anything went wrong.

**Fix.** Distinguish "the server said no photo" from "we could not ask". In the `catch`, settle in memory only
(so the wave stops spinning) and do not `writeDisk`; better still, drop the keys back into `pending` for the
next flush. A `null` may be persisted only when it came from a successful response body.

---

### 3. The dashboard's "Awaiting your approval" card counts ten queues and lists eight

`web/src/pages/Dashboard.tsx:1260-1320`, `web/src/App.tsx:84-92`, `web/src/lib/approvals.tsx:507-521`

The card's visibility and badge come from the **server count across every queue the caller may decide in**:

```tsx
{showSection("approvals") && approvals.total > 0 && (
  ... <span className="...">{approvals.total}</span>
```

The rows come from `approvalItems`, which is assembled from eight buckets (leaves, reimbursements, overtime,
remote work, regularizations, encashments, loans, time entries). `QUEUES_BY_ROUTE.dashboard` in App.tsx
deliberately omits `expenses` and `asset-requests` ("decided on their own pages, so the dashboard doesn't read
them"), and `tax-verifications` is not in the list either - but `approvals-summary` counts all of them.

So a manager whose only pending items are company expenses or asset requests gets a card headed **"Awaiting
your approval · 3"** with **no rows under it**. The "And N more in the approvals inbox" line only appears past
five, so below that there is nothing to explain the emptiness.

The same mismatch poisons the KPI hint at `Dashboard.tsx:840`:

```tsx
hint: approvals.total === 0 ? "All clear" : `Oldest waiting ${oldestPendingDays}d`
```

`oldestPendingDays` reads `approvalItems[0]?.when`, so with `total > 0` and no loaded rows it renders
**"Oldest waiting 0d"**.

**Fix.** Either render the card off the loaded buckets (`approvalItems.length`) and show `approvals.total` only
as a "N more in the inbox" line, or add `expenses` + `asset-requests` to `QUEUES_BY_ROUTE.dashboard`. The first
is cheaper and keeps the read budget as designed.

---

## Medium

### 4. The dashboard's "next 7 days" event window is 6 days in IST and 8 days in California

`web/src/pages/Dashboard.tsx:435-438`

```ts
const in7 = new Date(`${today}T00:00:00`);   // no Z -> parsed as LOCAL midnight
in7.setDate(in7.getDate() + 7);              // local arithmetic
const in7Str = in7.toISOString().slice(0, 10);   // serialized as UTC
```

Local parse, local step, UTC serialize. Verified:

```
$ TZ=Asia/Kolkata          node -e '...' -> 2026-09-19   (today = 2026-09-13, i.e. 6 days)
$ TZ=America/Los_Angeles   node -e '...' -> 2026-09-20   (7 days)
```

`upcomingEvents` therefore silently drops the seventh day for every viewer east of UTC, and `eventsToday` /
"this week" counts follow it.

**Fix.** `addDaysYmd(today, 7)` from `lib/orgDay.ts`, which is exactly this arithmetic done on the day label.

---

### 5. `in7` / `in30` / the joiner and probation cutoffs are computed on a UTC clock while `today` is the org day - and are frozen for the tab's life

`web/src/pages/Dashboard.tsx:368`, `580`, `585`, `693`

```ts
const cutoff = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);   // recentJoiner
const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);   // newJoiners
const in30   = useMemo(() => new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10), []);
const in7    = useMemo(() => new Date(Date.now() +  7 * 86_400_000).toISOString().slice(0, 10), []);
```

Each is compared against `today = todayStr()` (Dashboard.tsx:424), which is the **org's** day. In IST between
00:00 and 05:30 local the two clocks name different days, so `today <= x <= in7` is a six-day window; west of
UTC after ~17:00 it is an eight-day one. This file already documents the exact failure at lines 677-680 ("the
two halves of this window used to come from different clocks... In IST that put Monday one day early") and then
reintroduces it four lines later.

Separately, `in7` and `in30` are `useMemo(..., [])`: a dashboard left open overnight keeps yesterday's bounds
while `today` moves, so the windows quietly shift by a day.

**Fix.** `orgDayFromToday(-60)`, `orgDayFromToday(30)`, `orgDayFromToday(7)`, and key the memos on `today` so
they follow the org day across midnight.

---

### 6. Attendance history paging has no cancellation, so a fast reader can paint the wrong window

`web/src/pages/Attendance.tsx:368-382`

```ts
const loadPage = useCallback(async () => {
  try {
    setPageSessions(await listAllSessions(`attendance?from=...${fromYmd}...&to=...${toYmd}...`));
  } catch (e) { setPageSessions([]); ... }
}, [fromYmd, toYmd, toast]);

useEffect(() => {
  setPageLoading(true);
  void loadPage().finally(() => setPageLoading(false));
}, [loadPage]);
```

No `live` flag. `listAllSessions` (lib/clock.tsx:17) walks the server cursor with **up to ten sequential
requests**, so two windows in flight at once is not a tight race - it is the normal shape of clicking "previous"
twice. The slower walk wins whenever it lands last, and `setPageSessions` then holds one window's sessions while
`fromYmd`/`toYmd` (and everything derived from them - `rows`, `statsOf`, the month grid) describe another. The
stale walk's `.finally` also clears `pageLoading`, so the skeleton comes down over data that is still wrong.

The sibling effect fifteen lines below (`prevStats`, line 395-409) does guard with `let live = true`, so the
pattern is known here - it just is not applied to the two loaders that actually paint the page.

**Fix.** The same `live` latch in `loadPage` and `loadRecent`, checked before both `setPageSessions` and the
`setPageLoading(false)`.

---

### 7. A settings save can be undone by a read that was already in flight

`web/src/lib/settingsStore.ts:173-180` and `203-210`

```ts
const refetched = fetchAll();
void refetched.then((all) => {
  if (all.size) {
    writeDisk(all);
    loaded = Promise.resolve(all);     // no generation check
  }
});
```

`invalidateSettings()` (line 260) bumps `generation` and nulls `loaded` - and the `generation === gen` guard at
line 165 exists precisely to catch a snapshot dropped mid-wait. But these two background completions carry no
such guard. So the sequence

1. `fetchAll()` starts (page load, or the post-reconciliation refetch),
2. an admin saves a setting -> `patch` -> `invalidateCollections(["settings"])` -> `invalidateSettings()`,
3. the pre-write `fetchAll()` lands and assigns `loaded = Promise.resolve(all)` **and** `writeDisk(all)`

leaves the snapshot - in memory *and* on disk - holding the values the save just replaced, re-stamped as
current. The next `getSetting` is answered from it, and because `writeDisk` ran, so is the next page load.

This is the exact failure the file's own header spends three paragraphs on ("an admin who saves a setting and
reloads has to see what they saved").

**Fix.** Capture `const gen = generation` before each `fetchAll()` and make both background writers no-op when
`generation !== gen`.

---

### 8. Opening a dialog persists the *empty* form, so the next opening claims there is an unsaved draft

`web/src/components/common/dialogGuard.ts:97-121`

Two effects, in declaration order. The restore effect returns early when there is nothing stored:

```ts
const raw = sessionStorage.getItem(storageKey);
if (!raw) return;
```

The write effect then runs unconditionally in the same commit:

```ts
React.useEffect(() => {
  if (!open || !enabled) return;
  sessionStorage.setItem(storageKey, JSON.stringify(value));
}, [open, enabled, storageKey, value]);
```

So merely **opening** the dialog writes the pristine form to `sessionStorage`. `clear()` is only called on a
successful submit (`Reimbursements.tsx:147`, `Expenses.tsx:230`/`473`, `WriteDialog.tsx:163`/`167`), never on a
plain close. Reopen it and `raw` is now truthy, so `applyRef.current(...)` runs and `setRestored(true)` fires -
and `restored` is what gates the notice:

```tsx
{draft.restored && <DraftNotice onStartOver={() => { draft.clear(); ... }} />}
```

Result: open the "New claim" dialog, change nothing, close it, open it again - and the form announces
"picked up where you left off" with a "Start over" button, over an empty form. Reproducible on Reimbursements,
both Expenses dialogs, and every `WriteDialog` with a `draftKey`.

**Fix.** Only persist once the value has actually diverged from the value at open (the `useDialogGuard`
baseline is the same comparison), or set `restored` only when the parsed draft differs from the current value.

---

### 9. Outside the inbox, the approvals provider reports `loading: false` while its own count request is in flight

`web/src/lib/approvals.tsx:166-171`, `274-287`

On any route other than `approvals`, `withHistory` is false, so a queue is enabled only once the summary says
it is non-empty:

```ts
const wanted = useCallback(
  (collection: string) => wants.has(collection) && (withHistory || (counts?.[collection] ?? 0) > 0),
  [wants, withHistory, counts]);
```

Before `approvals-summary` resolves, `counts` is `undefined`, so nothing is enabled, `active` is empty, and

```ts
const loading = active.some((q) => q.state === "loading" && q.rows.length === 0);   // false
```

with `total: summary.total ?? 0` - also 0. The provider's own doc comment says the flag exists because
"'You're all caught up' is a claim a manager acts on - it was being made before a single queue had been read",
and that is still true for the *count* request, which is the one that gates everything on those routes.

Visible on a cold dashboard (no stored summary): the approvals KPI paints "All clear", the "Awaiting your
approval" card is absent, and both flip a few hundred milliseconds later.

**Fix.** Fold the summary's own in-flight state into `loading` (`summaryLoading || active.some(...)`).

---

### 10. Two write paths send `null` for fields the contract declares non-nullable

`web/src/api.ts:320-331` states the rule plainly: *"A request body carries VALUES, never `null`... a `null`
fails contract validation at the Prism proxy the dev server goes through with a 422 the worker never sees -
which is exactly how creating a document, an expense and a card broke there."*

Two sites break it against fields that really are non-nullable in `openapi.yaml`:

| Site | Sends | `openapi.yaml` |
|---|---|---|
| `web/src/pages/Offers.tsx:391` | `base_comp: form.comp ? Number(form.comp) : null` | `:3206` `base_comp: { type: number }` |
| `web/src/pages/Interviews.tsx:819` | `overall_rating: form.overall ? Number(form.overall) : null` | `:3182` `overall_rating: { type: number }` |

Both are reachable, not theoretical:

- `Offers.tsx:345` - `canSubmit = (editing || !!form.application) && !compError && ...`, and
  `compError` only fires when `form.comp !== ""`. Drafting an offer with the compensation left blank is
  allowed, and sends `base_comp: null`.
- `Interviews.tsx:815` - `canSubmit = !!form.rec && !overallError && ...`. An overall rating is optional, so
  submitting feedback with a recommendation and no score sends `overall_rating: null`.

Both POST and PATCH for offers use `$ref: '#/components/schemas/offer'` as the request body (`openapi.yaml:12720`,
`:12747`), so Prism validates the write against that schema.

**Fix.** Omit the key instead: `...(form.comp ? { base_comp: Number(form.comp) } : {})`. (Note the merge-patch
caveat in api.ts - for a field an edit needs to *clear*, mark it `nullable: true` in the spec rather than
sending `null` against a non-nullable one.)

---

## Low

### 11. A table with both column totals and a leading gutter column puts "Total · N rows" in the 1px gutter

`web/src/components/common/DataTable.tsx:1552-1564`

```tsx
{renderCols.map((col, i) => (
  <TableCell key={col.id} style={widthStyle(col.id)} className={cn("truncate text-xs", ...)}>
    {col.aggregate === "sum" ? fmtTotal(col, sumOf(filtered, col))
      : i === 0 ? <span className="uppercase ...">Total · {total} row{...}</span>
      : null}
```

`i === 0` assumes the first rendered column is a data column. `renderCols` (line 354-402) prepends up to three
gutter columns - `__select__` (when `bulkActions` is passed), `__access__` (in access mode), `__expand__` (when
`getSubRows` is passed) - each declared `className: "w-px pr-0"`. The footer cell does **not** apply
`col.className`, so the label lands in the checkbox column, un-narrowed, with `truncate` (`white-space: nowrap`)
forcing its min-content width onto the whole column.

Two tables ship both today (`aggregate: "sum"` + `bulkActions`): `web/src/pages/Expenses.tsx` and
`web/src/pages/ExpenseBudgets.tsx`. In access mode it applies to every table with a total.

**Fix.** Put the label in the first cell whose `col.header !== ""`, or skip gutter ids explicitly.

---

### 12. `key={i}` on editable rows that can be reordered and removed

Controlled inputs keep the right *value* under an index key, but React reuses the same DOM node for a position,
so focus, caret position and IME composition stay behind when a row is deleted or moved.

The ones that can actually move or be removed:

- `web/src/pages/Settings.tsx:987` - ATS pipeline stages, with `moveStage(i, ±1)` and `removeStage(i)` on the
  same row. Press ↑ while a stage name is focused and the caret stays on the row that slid into that slot.
- `web/src/pages/Settings.tsx:1204` - attendance grace exceptions (date + reason + minutes, with a delete).
- `web/src/pages/Settings.tsx:758`, `884`, `1494`, `3168`, `3493`; `web/src/pages/Tickets.tsx:676`, `717`;
  `web/src/pages/Boards.tsx:1732` - checklist / list-editor rows in the same shape.

Skeleton and static-list uses of `key={i}` (`Timesheets.tsx:365`, `LeaveCalendar.tsx:527`, `Schedule.tsx:227`,
`PayrollRuns.tsx:886`) are fine and need no change.

**Fix.** Give each row a stable identity when it is created (a counter or `crypto.randomUUID()`) and key on it.

---

### 13. `useEmployee` never clears a previous error

`web/src/hooks/useEmployee.ts:12-34` sets `setState("loading")` on a new `id`/`tick` but never
`setError(null)`. Its sibling `useResource` (`hooks/useResource.ts:31`) does. Today the stale message is masked
because both consumers render it through `<DataState state={state} error={error}>`, which only shows the error
in the `error` state - but it is a trap for the next consumer that reads `error` on its own.

Also: `reload` is a fresh closure each render (not `useCallback`), unlike `useResource`'s. Any effect that
lists it as a dependency will re-run every render.

---

### 14. The tab that follows a cursor persists page 1; the tab that hears about it persists everything

`web/src/lib/resourceStore.ts:580-604` vs `:727-735`

`loadMoreRows` appends the next page, updates the snapshot, and broadcasts - but never calls `writeDisk(e)`.
The `TOPIC_ROWS` subscriber that receives that broadcast *does*:

```ts
setSnap(e, { rows, state: "ready", error: null, meta });
writeDisk(e); // a sibling's fetch is as good as our own - store it so a reload can reuse it
```

So on a feed where the reader scrolls through several pages, a reload in the tab that did the scrolling starts
from one page, while a sibling tab that only watched has the whole thing on disk. Harmless but backwards.

**Fix.** Call `writeDisk(e)` in `loadMoreRows` alongside the `publish`.

---

### 15. The Excel export bypasses the single download path

`web/src/lib/exportTable.ts:74` uses `saveBlob` for CSV; line 81 calls `XLSX.writeFile(wb, ...)`, which builds
its own anchor and object URL. `web/src/lib/download.ts`'s header is explicit that this is the one place a file
reaches the disk, and names the two details ("revoking in the same tick as the click", "not attaching the
anchor") that four earlier copies each got wrong.

**Fix.** `XLSX.write(wb, { bookType: "xlsx", type: "array" })` then `saveBytes(bytes, `${filename}.xlsx`, ...)`.

---

### 16. The published offers contract does not describe what the offers route accepts

`openapi.yaml:3207-3209` declares `offer_time` / `join_time` / `expiry_time` on the `offer` schema, which is
also the request body for POST and PATCH. `src/routes/offers.ts:13-25` is a `.strict()` zod object accepting
only `offer_date` / `join_date` / `expiry_date`, and `src/http/serialize.ts:1657-1659` emits the `_time` names
on responses. The SPA (`Offers.tsx:393-395`) sends the `_date` names, so it works - but any client written from
the published spec gets a 400, and the read/write asymmetry is documented nowhere.

**Fix.** Add the three `_date` write fields to the schema (or make the route accept the `_time` names), and say
in the description that writes and reads use different names.

---

### 17. `tenureLabel` opts out of the pinned date locale

`web/src/lib/utils.ts:93` uses `start.toLocaleDateString(undefined, { month: "short", year: "numeric" })`.
`formatDate` twelve lines above pins `en-GB` with an explicit rationale ("One organization reads one date
format"), and `lib/intl.ts` exists to stop per-call formatter construction. This call does neither, so a
US-configured reader sees `Mar 2023` on the profile header beside `4 Aug 2026` everywhere else.

---

### 18. `Number(form.accrual)` with no fallback can put `NaN` on the wire

`web/src/pages/LeaveTypes.tsx:76` - `accrual_days_per_year: Number(form.accrual)`. `JSON.stringify(NaN)` is
`null`, which is the same contract violation as finding 10. Line 105 in the same file already writes
`Number(form.accrual) || 0`; line 76 should match it.

---

## Checked and clean

Worth recording, so a later pass does not redo it:

- **XSS.** `web/src/lib/richText.tsx` renders to React elements, never an HTML string; there is no
  `dangerouslySetInnerHTML` anywhere in `web/src`. `safeHref` (`:179`) allows only `https?://x` and
  `mailto:a@b`, the mention target is pinned to a 26-char Crockford id, and `Anchor` carries
  `rel="noopener noreferrer nofollow ugc"`. The two `target="_blank"` sites both carry `rel`; all five
  `window.open` calls pass `noopener` or write into `about:blank` with attached listeners rather than inline
  handlers.
- **CSV injection.** `lib/exportTable.ts:43-45` prefixes formula leads with an apostrophe and exempts plain
  numbers. Correct, and the xlsx path genuinely does not need it.
- **`api.ts` retry loop.** Attempt accounting, `discard()` of replaced bodies, the `Retry-After` cap and the
  read-only restriction all check out; writes are never repeated.
- **`getCoalescer.ts`.** Dedup keyed on path *and* validator, `fresh` keys minted per call, the chunk deadline
  cleared in `finally`. No leak found.
- **`lib/utils.ts#round2`.** Matches the documented server twin, including the symmetric tie rule and both
  exponential-notation guards.
- **`Stocktakes`.** `App.tsx:628` passes no `openId`, but the page reads `useRoute().id` itself
  (`Stocktakes.tsx:46`, `:77`), so `#/stocktakes/<id>` works as the comment claims.
- **Non-null assertions on array heads.** All 20 sites (`Boards.tsx:392`, `Documents.tsx:743`,
  `Goals.tsx:2179`, `ReviewCycles.tsx:498`, ...) are guarded by a length check on the same or preceding line.

---
---

# Round two

A second pass, covering the files the first did not reach: the layout shell, the notification/preference/
access-mode stores, the keyboard layer, the nav tables, session-replay privacy, and the write paths that
combine a create with an upload.

---

## High

### 19. Preferences leak between people sharing a browser, through an un-namespaced localStorage key

`web/src/lib/prefs.ts:98`

```ts
const UNCONFIRMED_LS = "prefs.unconfirmed";
```

One global key, for every identity. Everything else in the app that holds per-user state namespaces it:
`draft:${storedIdentity()}:…` (dialogGuard), `tab_seen:${id}` (tabActivity), `nav:collapsed:${email}`
(Sidebar), `palette:frecent:${email}` (CommandPalette), `dt:${currentUser}:${id}` (tablePrefs), and the whole
of clientStore. This one does not.

What lands in it is not incidental. `writePrefDeferred` records the whole blob as unconfirmed
(`markUnconfirmed(key, value)`, line 81), and its three callers are:

| Caller | Key | Payload |
|---|---|---|
| `lib/tablePrefs.ts:63` | `table_<tableId>` | column order, widths, page size, density, **and every `SavedView`** - name, filters, sort, search text |
| `lib/dashboardPrefs.ts:44` | `dashboard` | pinned/hidden KPIs, hidden sections, section order |
| `lib/tabActivity.ts:87`, `:188` | `tab_seen` | per-tab last-viewed timestamps |

And `adoptUnconfirmed` (line 131-140), which runs on the first `readPref` of every page life, does not merely
read it - it **writes it to the server as whoever is signed in now**:

```ts
for (const [key, value] of Object.entries(readUnconfirmed())) {
  all.set(key, value);
  void patch(`preferences/${key}`, { value }).then(() => clearUnconfirmed(key), () => {});
}
```

Repro:

1. User A saves a table view (`DataTable`'s persist effect -> `savePrefs` -> `writePrefDeferred(…, 5_000)`).
   The unconfirmed record is written immediately; the PATCH is 5 s away.
2. A's session ends before it confirms - inside the window, or because the `pagehide` keepalive send failed.
   Crucially the **ordinary** exit is a lapsed session, not the sign-out menu: `purgeCachedData` (clientStore.ts:515)
   deliberately leaves localStorage alone, and only `purgeAll` (the menu item) calls `localStorage.clear()`.
3. User B signs in on the same browser. First `readPref` -> `load()` -> `adoptUnconfirmed()`.
4. A's saved views, column layout and dashboard layout are now in B's snapshot **and PATCHed onto B's
   `preferences/*` rows on the server**, where they follow B to their other devices.

`tablePrefs.ts:27-29` states the invariant this defeats, in as many words: *"namespace it by user so layouts
never bleed across accounts sharing a browser."* It namespaces its own cache and then routes the identical
payload through a shared key one layer down.

**Fix.** Namespace the key (`prefs.unconfirmed:${storedIdentity()}`), and drop records belonging to another
identity at load rather than adopting them - the same rule `clientStore.hydrate` already applies to its own
records.

---

### 20. Session replay records employees' personal documents on the profile, which is the data the Documents route is masked for

`web/src/components/common/EmployeeDocuments.tsx`, `web/src/instrument.ts:53-71`

`SENSITIVE_PAGES` masks `[data-page="documents"]`, and says why: *"scanned identity documents, contracts,
insurance cards."*

`EmployeeDocuments` reads the **same collection** (`personal-documents`) and renders on two routes that are not
in that list:

- `web/src/pages/Profile.tsx:220` - `#/profile`, `data-page="profile"`
- `web/src/pages/EmployeeProfile.tsx:505` - `#/employees/<id>`, `data-page="employees"`

The component carries no `sentry-mask` and no `data-sentry-mask` anywhere in it. With the file's
unmask-by-default posture (`maskAllText: false`), that means document names, types (`FORM16`, insurance,
identity), financial years and expiry dates are recorded in full.

`instrument.ts` states the rule this misses: *"When adding UI that shows money, an identity number, a bank
account, a medical or a document, put `data-sentry-mask` on it … if it can appear outside these routes."* The
seven panels the comment names as covered - Bank, Compensation, Tax, Settlement, Bonuses, Identity, Personal -
are all tagged and all pinned by `test/replayMaskCoverage.test.ts`. Documents is the eighth panel on the same
page and is in neither.

**Fix.** `<Card className="sentry-mask">` on `EmployeeDocuments`, and add it to `SENSITIVE_DIALOGS`/the
coverage test so the next panel cannot repeat it.

(Checked and clean while here: the `unmask` escape hatches - `h1`-`h4`, `th`, `label`, `button`, `nav` - are
not carrying values on any of the eight `SENSITIVE_PAGES`; `DataTable`'s phone cards put the label in `dt` and
the value in `dd`; `ActivityFeed` masks its value diffs, IP and user-agent.)

---

### 21. Opening the mobile drawer and then widening the window leaves the entire page inert

`web/src/App.tsx:689`, `web/src/components/layout/Sidebar.tsx:262-273`

```tsx
<div className="flex min-w-0 flex-1 flex-col" {...(mobileOpen ? ({ inert: "" } as React.HTMLAttributes<HTMLDivElement>) : {})}>
```

`inert` removes the whole main column from hit-testing, focus and the accessibility tree - correct while the
drawer is a modal overlay. But the guard is `mobileOpen` alone, with no breakpoint test, and nothing resets
`mobileOpen` when the viewport crosses `md`.

Sidebar, meanwhile, drops every way out at `md` and up:

- the scrim is `md:hidden` (Sidebar.tsx:245),
- the drawer's own close X is `md:hidden` (Sidebar.tsx:282),
- `BottomNav` - the only thing that ever sets `mobileOpen = true` - is `md:hidden` (BottomNav.tsx:138),
- `drawerOpen` becomes false, so Escape stops closing it (Sidebar.tsx:194-210).

So: open the menu at phone width, then rotate a tablet to landscape or drag a desktop window past 768px. The
sidebar docks and looks entirely normal, and **the whole page is dead** - no clicks, no focus, no keyboard,
nothing on screen to say why. The only recovery is clicking a sidebar nav link (which happens to call
`onNavigate`) or reloading.

**Fix.** Either gate the `inert` on the breakpoint too, or `useEffect(() => { if (docked) setMobileOpen(false) }, [docked])`
in App - the drawer has no meaning once the sidebar is docked.

---

### 22. Leaving a page issues one PATCH per unread notification, each of which force-refetches the whole feed

`web/src/lib/notifications.tsx:413-426`

```tsx
for (const n of notifications) {
  if (n.read || !n.link) continue;
  if (n.link.split("/")[0] === left) void markRead(n);
}
```

`markRead` (line 305) does `setRows(...)` then `patch('notifications/<id>', { read: true })`. Trace one of
those through `api.ts`:

`patch` -> `withInvalidation(path, undefined, …)` -> `affectedCollections("notifications/<id>")` ->
`["notifications"]` -> `invalidateCollections(["notifications"])` -> for every cached key with a live
subscriber, `ensureFetch(collection, opts, true)` - a **forced** read.

The `NotificationsProvider` wraps the whole app, so `notifications` always has a live subscriber. So leaving a
page with N unread notifications for it costs N PATCHes plus N forced list reads, plus N `dropDisk` passes and
N bus broadcasts. Two further amplifiers:

- `markRead`'s `setRows` is `patchRows`, which stamps `e.patchedAt = Date.now()` (resourceStore.ts:623). Each
  forced read that is already in flight when the next patch lands then fails `hadRows && e.patchedAt >= startedAt`
  and **schedules yet another read** (resourceStore.ts:543-547) rather than adopting its answer.
- the only bulk verb the server offers is `notifications:markAllRead` (src/routes/notifications.ts:55), which
  is all-or-nothing across every page, so there is nothing for this to batch into today.

On an app whose stated primary constraint is Cloudflare request count (see the headers of
`lib/getCoalescer.ts` and `lib/resourceStore.ts`), a request storm on every single navigation is the wrong
shape.

**Fix.** A collection-level `notifications:markRead` taking a list of paths, invalidated once. Failing that,
apply the reads locally and send one batched write.

---

## Medium

### 23. The personal dashboard layout is cached under an un-namespaced localStorage key

`web/src/lib/dashboardPrefs.ts:22`

```ts
const LS_KEY = "dash.personal";
```

`loadLocal()` is the `useState` initializer (line 50), so the dashboard paints from it before the server row
arrives. On a shared browser that is user A's pinned KPIs, hidden KPIs, hidden sections and section order
shown to user B. If B has no server row yet, the `readPref` guard (`v && typeof v === "object"`) does not
fire, **A's layout stands**, and B's next pin or hide writes it to B's server row.

`lib/tabActivity.ts:17-21` documents this exact failure for its own key and fixes it by namespacing;
`clientStore.gc()` even sweeps the pre-prefs `dash.hideAllClear` key while leaving `dash.personal` in place.

**Fix.** `dash.personal:${storedIdentity()}`, like `tab_seen`.

---

### 24. `stagePref` promises staged changes ride along with a pending deferred write. They do not.

`web/src/lib/prefs.ts:68-85`, `:142-156`

The contract, from `stagePref`'s own doc comment:

> *"Whatever was staged in between rides along, since the flush sends the value as it stands then."*

The implementation:

```ts
export function writePrefDeferred(key, value, delayMs) {
  stagePref(key, value);
  markUnconfirmed(key, value);
  ...
  pending.set(key, { value, timer: setTimeout(() => flushPref(key), delayMs) });   // value CAPTURED here
}

export function stagePref(key, value) {
  apply(key, value);          // updates the snapshot
  publish(TOPIC_SET, ...);    // updates sibling tabs
}                             // ...and never touches `pending`

function flushPref(key, unloading = false) {
  const p = pending.get(key);
  void patch(`preferences/${key}`, { value: p.value }, ...);   // sends the CAPTURED value
}
```

`flushPref` sends the value as it was when the timer was armed, not as it stands. A `stagePref` in between is
applied locally and to sibling tabs and then dropped on the floor.

`tab_seen` hits this on an ordinary pair of navigations:

1. Visit a badged tab -> `markTabSeen` -> `seen = {…}` (a **new object**, line 96) -> `persist(true)` ->
   `writePrefDeferred(seen_v2, 30_000)`.
2. Within the 30 s window, visit an unbadged tab -> `markTabSeen` -> `seen = seen_v3` -> `persist(false)` ->
   `stagePref(seen_v3)` only.
3. The timer fires and sends **v2**. The second tab's stamp never reaches the server, `clearUnconfirmed`
   removes the local record, and the only copy left is this device's `tab_seen:<id>` cache.

On another device that tab badges again for activity the reader has already looked at - the failure
`tabActivity.ts`'s header says the module exists to prevent.

The same file also mutates `seen` **in place** at one site (`tabActivity.ts:159-162`, `seen[t.key] = Date.now()`)
while replacing it everywhere else, so whether a staged change is visible to the pending write depends on
which code path produced it.

**Fix.** In `stagePref`, update an existing `pending` entry's `value` (and re-mark it unconfirmed) instead of
leaving it stale. Then pick one convention in `tabActivity` - replace, not mutate.

---

### 25. Seven create-then-upload paths have no compensation, and one duplicates its work on every retry

None of these wrap the create and the upload in anything that can undo or resume:

| Site | Sequence |
|---|---|
| `Documents.tsx:322-325` | `for (f of files) { create; await upload }` |
| `Documents.tsx:328-329` | create -> upload |
| `Expenses.tsx:221-228` | create -> upload -> `invoke(:submit)` |
| `Expenses.tsx:468-470` | create -> upload -> `invoke(:submit)` |
| `Expenses.tsx:464-465` | patch -> upload |
| `Reimbursements.tsx:139-144` | create -> upload |
| `Referrals.tsx:~431-433` | create/patch -> upload |

The batch loop is the worst. A failure on file 3 of 5 leaves two complete documents, **one document row with
no file**, and two never created - and `submit()` throws, which `WriteDialog` turns into an in-form message
that *keeps every one of the five files staged*. Press Submit again and the loop restarts at file 1:
documents 1 and 2 are created a second time. Every retry multiplies them. The collection route already accepts
`?id=` (`openapi.yaml:12719`), so an idempotent retry is available and unused.

`Expenses` is the most misleading. If the upload or the `:submit` throws, the row exists in `DRAFT` - filed as
far as the server is concerned, never submitted, and invisible in the reviewer's queue - while the person sees
only an error and a form that still has everything they typed. Pressing the button again creates a second row;
unlike `Reimbursements` (which has a `duplicate` detector, lines 120-132) the quick-expense sheet has no
such guard.

**Fix.** Treat the attachment as a follow-up, not part of the create: on an upload failure keep the record,
close the dialog, and say "filed - the receipt didn't attach, add it from the list" (every one of these pages
already has an attach-to-existing path). For the batch loop, track how far it got and resume rather than
restart.

---

### 26. Typing to find an option in a Select or a dropdown menu can navigate the app away

`web/src/components/layout/ShortcutLayer.tsx:47-85`

The global keydown layer skips typing targets and open dialogs:

```ts
if (isTypingTarget(e.target)) return;                                   // INPUT/TEXTAREA/SELECT/contenteditable
if (document.querySelector('[role="dialog"][data-state="open"]')) return;
```

Neither covers a Radix `Select` (content is a listbox, `web/src/components/ui/select.tsx` wraps
`@radix-ui/react-select`) or a Radix `DropdownMenu` (`role="menu"`). Both implement **typeahead**: typing
letters jumps to a matching option. Those keydowns bubble to `window`, the target is a div rather than an
input, and the dialog selector does not match.

So with a department picker open, typing `g` then `e` to reach "General" arms the chord and then fires
`navigate("employees")` - the picker closes, the form is abandoned, and the app is on the directory. Every
`GO` letter is reachable this way: `d`, `a`, `l`, `c`, `e`, `b`, `f`, `t`, `p`, `x`, `m`, `n`, `o`, `s`.
`?` opens the shortcut dialog over the same picker, and `[` / `]` walk the workspace tabs.

`Combobox` is safe by accident - it is built on `Popover` (`role="dialog"`) and its filter box is an `<input>`.

**Fix.** Widen the guard to any open Radix layer: `[data-radix-popper-content-wrapper]`, or
`[role="listbox"], [role="menu"], [role="dialog"]` with `[data-state="open"]`.

---

### 27. Four server-built notification links never badge a page and are never cleared

`src/services/accessRules.ts:199`, `:417`, `:430`, `:493` all store `link: "#/settings/permissions"`.

The SPA reads that field three ways, and only one of them tolerates the `#/` form:

- `router.navigate` (`web/src/router.ts:151`) strips it deliberately - *"which is how a couple of server-built
  notification links are stored"* - so clicking the notification works.
- `unreadByPage` (`notifications.tsx:185`) does `n.link.split("/")[0]` -> **`"#"`**. `Sidebar.itemBadge`
  sums `unreadByPage[k]` over `itemPageKeys(item)`, and no nav item has the key `"#"`, so these never badge
  anything.
- `NotificationClearOnLeave` (`notifications.tsx:422`) compares `n.link.split("/")[0] === left` -> `"#" === "settings"`
  is false, so they are **never auto-marked-read**. They sit unread in the bell indefinitely.

`openapi.yaml:1648` documents the field as *"Web route to open (page key, optional /id)"*, which `#/settings/permissions`
is not.

**Fix.** Store `settings/permissions` server-side (`navigate` already tolerates both), or normalise with
`n.link.replace(/^#\//, "")` at all three readers.

---

### 28. A fired intent never expires, so it opens a dialog on a later, unrelated navigation

`web/src/lib/intent.ts:10-25`

```ts
let pending: { name: string; arg?: unknown } | null = null;

export function fireIntent(name: string, arg?: unknown) {
  pending = { name, arg };
  dispatch();                       // no-op when nothing is registered for `name`
}
```

Nothing ever clears `pending` except a handler consuming it. `runQuickAction` (`lib/quickActions.ts:153-158`)
fires the intent synchronously right after `navigate(route)` - before the target route has re-rendered and
long before its lazily-loaded chunk has resolved - so the pending intent routinely outlives the action that
created it.

Repro: ⌘K -> "Set a goal" -> the hash changes to `#/goals` and the chunk starts downloading; press Back before
it mounts. `pending = { name: "new-goal" }` stays set for the rest of the session. Ten minutes later, open
Goals from the sidebar: `useIntent("new-goal")` runs on mount, finds the stale intent, and **the New goal
dialog opens** with nothing having asked for it.

**Fix.** Stamp `pending` with a timestamp and ignore anything older than a few seconds, or clear it on the
next `hashchange` that is not the intent's own route.

---

### 29. Enrolling a device for push can silently deregister another one

`web/src/lib/webPush.ts:52-56`, `:64-67`

```ts
const others = (await readServerSubs()).filter((s) => s.endpoint !== json.endpoint);
await writePref(PREF_KEY, { subs: [...others, json].slice(-MAX_DEVICES) });
```

`readServerSubs` -> `readPref` -> the preferences snapshot, which `lib/prefs.ts` memoizes for the whole page
life (`loaded ??= …`). `writePref` then PATCHes the **entire `subs` array** with no `If-Match` and no merge.

So a tab that has been open since before another device enrolled holds a stale list, and the moment this
browser enables (or disables) push it writes that stale list back - dropping the other device's subscription.
That device stops receiving pushes with nothing anywhere saying so. `disablePush` has the same shape.

This is the multi-writer blob problem `lib/settingsStore.ts#saveSetting` was given `If-Match` for; the
preferences path has no equivalent.

**Fix.** Re-read the row immediately before the write (bypassing the snapshot), or move the add/remove to a
server-side custom method that merges by endpoint.

---

## Low

### 30. Nine routes set no document title and announce nothing on navigation

`web/src/App.tsx:282-296` builds both the tab title and the screen-reader announcement from `navBreadcrumb`:

```ts
document.title = label ? `${label} · ${APP_NAME}` : APP_NAME;
...
setAnnounced(label ?? "");
```

`navBreadcrumb` (`nav.ts:294-312`) only matches keys present in `NAV`. Nine of App's 59 route cases are not:

```
notifications, tickets, kudos, departments, leave-types, pay-components, pay-periods, users, operations
```

For those, the tab reads bare "HRMS" and the live region is set to `""` - which announces nothing at all. Both
are the exact failures the function's own comment says it exists to fix: *"the tab/window/task-switcher title
has to say which page this is (it said the app name and nothing else…)"* and *"a silent content swap is the
classic SPA failure, where the pointer user sees a new page and the screen-reader user is told nothing at all."*

Seven are Settings deep-link aliases, so the same screen is titled at `#/settings/departments` and untitled at
`#/departments`. Two are first-class pages reached from the chrome rather than the sidebar: **Tickets**
(1,262 lines, opened from the top-bar Support menu) and **Notifications** (the bell).

**Fix.** Fall back to `ALIAS_GATE`/`PAGE_TAB_LABELS` or a small label map for keys outside `NAV`.

---

### 31. `notifications` is missing from `ALIAS_GATE`, though the comment names the bell

`web/src/nav.ts:242-251`. The map's own header says it covers *"the pages reached from chrome rather than the
sidebar (the top bar's Support entry, the bell)"* - and lists `tickets` but not `notifications`, which appears
nowhere in `nav.ts`. Two consequences:

- `pageGate("notifications")` is `undefined`, so `pageVisible` returns true and `#/notifications` renders for a
  caller with no `notifications.read`. The feed is empty (useCollection gates the read) rather than walled -
  a "hide, never disable" miss, not a data leak.
- `Sidebar.itemBadge`'s `if (item.key === "notifications") return unreadTotal;` (`Sidebar.tsx:164`) is dead
  code: no nav item carries that key.

---

### 32. `APPROVAL_CAPS` lists `expenses.approve` twice

`web/src/nav.ts:76-77`. Harmless (it feeds `.some()` and a provider gate), but it is the list that decides
whether the Approvals hub renders at all, and a duplicated line is how the *asset-requests* asymmetry in
finding 3 went unnoticed.

---

### 33. Side effects inside `setState` updaters, at three sites

`AccessModeProvider.tsx:100-109` documents the rule and the reason:

> *"A React updater must be pure: React re-runs it whenever it likes, and StrictMode (web/src/main.tsx)
> deliberately invokes it twice, so every side effect in it happens more than once per click."*

StrictMode is on (`main.tsx:36`). Three updaters still do work inside:

- `lib/dashboardPrefs.ts:70-74` - `persist(next)` inside `setPrefs`: a localStorage write, a
  `markUnconfirmed` read-modify-write, and a `setTimeout` re-arm, twice per pin/hide/reorder.
- `pages/Boards.tsx:494-496` - `writeLocalJson` inside `setCollapsed`.
- `components/layout/Sidebar.tsx:175-178` - `saveCollapsed` inside `setCollapsed`.

All three are idempotent, so this is drift from an established in-repo rule rather than a live defect.

---

### 34. The ⌘/Ctrl hint reads a deprecated API

`web/src/components/layout/TopBar.tsx:20` - `navigator.platform`, deprecated and frozen (Chrome reports
`"MacIntel"` regardless of the actual chip). Works today; `navigator.userAgentData?.platform` with this as the
fallback is the durable form.

---

### 35. `listAllSessions` has no stuck-cursor guard

`web/src/lib/clock.tsx:17-29` walks up to 10 pages but, unlike `api.ts#listAll` and `#getAllPages`, keeps no
`seen` set of tokens. The page ceiling bounds it, so this is a consistency gap rather than a hang - but the two
guards catch different failures, and the notes on `listAll` say so.

---
---

# Round three

Covering the shared UI primitives (dialog, confirm, field, toast), the dialog/history machinery, the camera
scanner, the payroll review dialog, and the remaining date/recurrence helpers.

---

## Medium

### 36. Pressing Enter with Cancel focused runs the destructive action

`web/src/components/common/confirm.tsx:53-58`, `:77`

```tsx
onKeyDown={(e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    close(true);        // <-- always confirms, whatever has focus
  }
}}
```

and the primary button:

```tsx
<Button variant={opts?.destructive ? "destructive" : "default"} autoFocus={!opts?.destructive} onClick={() => close(true)}>
```

The two combine badly on exactly the dialogs that matter. On a **destructive** confirm `autoFocus` is
deliberately withheld (so nobody deletes by reflex), which means focus stays on the dialog and the first Tab
lands on **Cancel** - the first button in the markup. A keyboard user then presses Enter expecting to cancel,
`preventDefault()` suppresses Cancel's own activation, and `close(true)` runs the deletion.

This is every `confirm({ destructive: true })` in the app: `confirmDecision`'s reject/cancel/revoke/rescind
copy, `useDialogGuard`'s "Discard your changes?", DataTable's destructive bulk actions, the purge prompts.

**Fix.** Only treat Enter as confirm when it did not originate on a button - `if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "BUTTON")` - and let a focused button activate itself.

---

### 37. A second `confirm()` while one is open leaves the first caller awaiting forever

`web/src/components/common/confirm.tsx:26-40`

```tsx
const resolver = React.useRef<((v: boolean) => void) | null>(null);

const confirm = React.useCallback<ConfirmFn>((o) => {
  setOpts(o);
  return new Promise<boolean>((resolve) => { resolver.current = resolve; });   // overwrites
}, []);
```

There is one resolver slot. A second `confirm()` overwrites it, and the first promise is never settled - so the
`await confirm(...)` in the first caller **never returns**. Everything after it is dead: the `setBusy(false)`
in its `finally`, its toast, its state reset.

Every decision handler in the app is shaped `if (!(await confirmDecision(...))) return; setBusy(true); try { … } finally { setBusy(false) }`,
so the visible symptom is a button that spins forever and a row that can never be acted on again without a
reload. Reachable by double-pressing a destructive row action before the dialog paints (the trigger buttons are
not disabled during the await), and by any two overlapping prompts - a bulk-action confirm raised while a
guard's discard prompt is up.

**Fix.** Reject or resolve-false the outgoing resolver before replacing it, or queue.

---

### 38. Two URL writers wipe the dialog's history marker, leaving dead back-entries

`web/src/components/common/DataTable.tsx:328`, `web/src/lib/urlQuery.ts:20`

`pushDialogEntry` marks the entry it pushes (`dialogHistory.ts:71`):

```ts
window.history.pushState({ ...(window.history.state ?? {}), hrmsDialog: true }, "");
```

and `dropDialogEntry` refuses to pop unless the marker is still there (`dialogHistory.ts:90-91`):

```ts
const ours = (window.history.state as { hrmsDialog?: boolean } | null)?.hrmsDialog === true;
if (!ours) return;
```

Three places rewrite the current entry. One preserves the state object; two replace it with `null`:

```ts
router.ts:213        window.history.replaceState(window.history.state, "", …)   // correct
urlQuery.ts:20       history.replaceState(null, "", …)                          // wipes hrmsDialog
DataTable.tsx:328    history.replaceState(null, "", …)                          // wipes hrmsDialog
```

So any query-state write while a dialog is open erases the marker, `dropDialogEntry` bails, and closing the
dialog from the UI leaves its history entry buried. The reader then owes one extra back press per dialog they
already dismissed by hand - on a phone, where back is the primary gesture, that reads as the app ignoring them.

`LeaveCalendar` makes this easy to hit: it has **eight** `writeHashQuery` effects (lines 93-100), one per
filter, each firing on its own dependency. Open a leave detail dialog, change the month or toggle "pending",
close the dialog - one dead entry. Do it three times and leaving the page takes four back presses.

**Fix.** Pass `window.history.state` in both, exactly as `router.ts:213` does.

---

### 39. The scanner opens two camera streams and orphans one, leaving the camera on after the dialog closes

`web/src/lib/scanner.ts:403-417`

```ts
const startCamera = useCallback(async () => {
  ...
  streamRef.current?.getTracks().forEach((t) => t.stop());   // stops what was there AT CALL TIME
  streamRef.current = null;
  try {
    const { stream, opened } = await openCamera(wantedCameraRef.current);
    streamRef.current = stream;                              // ...and unconditionally claims the ref
    ...
```

No generation guard. Two overlapping `startCamera()` calls both reach `getUserMedia`, both resolve, and
whichever assigns last owns `streamRef` - the other stream is **left with its tracks live**. The unmount
cleanup (`scanner.ts:551-554`) only stops `streamRef.current`, so the orphan survives the dialog closing: the
recording indicator stays lit, and the sensor stays held, which is precisely what makes the next scan fail (the
file's own note at line 452-454: *"a phone refuses a second camera while the first still holds the sensor"*).

Three call sites mount it with no cleanup:

```tsx
// SerialScanPanel.tsx:73, AssetCustody.tsx:92, BulkAddAssets.tsx:264
useEffect(() => { void startCamera(); }, []);
```

StrictMode is on (`main.tsx:36`), so in development this is the default path - mount, cleanup (none), mount
again, two `getUserMedia` in flight. In production the reachable routes are a double-press of "Start camera"
(`SerialScanPanel.tsx:111` has no `loading`/`disabled` guard, unlike line 138) and `selectCamera` racing
`startCamera`.

Related, same file: `selectCamera`'s catch (line 476-478) stops the old stream, fails to open the new one,
sets `cameraState = "unavailable"` and **leaves `wantedCameraRef` pointing at the lens that just failed** - so
the next "Start camera" retries the broken one.

**Fix.** `const gen = ++startGen.current` before the await; afterwards, if `startGen.current !== gen`, stop the
stream you were handed instead of assigning it. Give the three effects a cleanup that calls `stopCamera()`.

---

### 40. Payroll: a failed re-apply does not stop the rebuild, so the run is re-priced off the uncorrected splits

`web/src/pages/PayrollRuns.tsx:198-205`, `web/src/hooks/useSplitStaleness.ts:46-61`

```ts
// Split drift needs BOTH steps and in this order: re-apply re-solves each employee's basic / Special Allowance
// from their (unchanged) annual CTC, then the rebuild re-prices the run off the corrected rows. Re-applying
// alone would leave the run's stored items on the old numbers.
async function reapplyAndRebuild() {
  await doReapply();
  await rebuildReview();
}
```

`doReapply` is `useSplitStaleness#reapply`, which **swallows its own failure**:

```ts
const reapply = useCallback(async () => {
  setReapplying(true);
  try { ... } catch (e) {
    toast({ title: "Couldn't re-apply", ..., variant: "destructive" });   // <-- resolves normally
  } finally { setReapplying(false); }
}, [refresh, toast]);
```

So when the re-apply fails, `reapplyAndRebuild` proceeds to rebuild anyway - re-pricing the run off exactly the
drifted rows the button exists to correct. The operator sees a red "Couldn't re-apply" toast followed by a
green "Run rebuilt", and `rebuildReview`'s `openReview` refreshes `reviewStale` from the rebuilt run, so the
drift banner may clear over figures that were never fixed.

The comment states the invariant ("needs BOTH steps and in this order") and the code enforces neither half of
it.

**Fix.** Have `reapply` return whether it succeeded (or rethrow), and bail out of `reapplyAndRebuild` when it
did not.

---

## Low

### 41. `Field` never tells assistive tech which control an error or hint belongs to

`web/src/components/common/Field.tsx:147-172`

The component goes to real trouble to bind `<label for>` correctly - `useLabelledControl` mints an id, clones
it onto the first labelable child, and `LABELABLE` is matched on `displayName` so a minified build still works
(all five components do assign one; checked). None of that extends to the error or the hint:

```tsx
<Label htmlFor={controlId} …>{label}</Label>
...
<div className={cn(..., shown && "[&_input]:border-destructive …")}>{control}</div>
{shown ? <p role="alert" …>{shown}</p> : hint ? <p …>{hint}</p> : null}
```

The control gets no `aria-describedby` pointing at either paragraph, and no `aria-invalid` when `shown` is set.
A sighted user sees a red border and a message; a screen-reader user tabbing back into the field is told the
label and nothing else. `role="alert"` announces the message once when it first appears and never again.

The ids already exist (`React.useId()` is called on every Field, and `reasonId` shows the pattern in
WriteDialog), so this is `aria-describedby` + `aria-invalid` on the same `cloneElement` that already sets `id`.

---

### 42. The compliance rule editor previews due dates against the viewer's calendar, not the org's

`web/src/lib/complianceRecurrence.ts:22-23`

```ts
export function nextDueDates(rule: RecurrenceRule, count = 3, from = new Date()): string[] {
  const fromMs = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
```

Local calendar parts, anchored at UTC. `web/src/lib/fy.ts` documents this exact mistake and its fix:

> *"This read `d.getMonth()`/`d.getFullYear()`, which is the VIEWER's local calendar … lib/orgDay.ts exists
> precisely to end that class of bug and every other date default in the SPA goes through it; this is the one
> that did not."*

It was not the only one. The single caller (`pages/Compliance.tsx:279`) uses the default `from`, so around a
month boundary the preview shows a different first due date than the server will generate.

**Fix.** `from = todayStr()` and parse it at `T00:00:00Z`, like every other day helper in `lib/orgDay.ts`.

---

### 43. Dismissed and evicted toasts leave their removal timers running

`web/src/components/ui/use-toast.ts:34-57`

`scheduleRemove` arms a timer per toast and nothing ever clears it. A toast dismissed early - swiped away, or
`ToastClose` - is filtered out of state by `onOpenChange`, but its timer still fires later and dispatches a
full store update (a new `toasts` array), re-rendering every `useToast()` consumer for a toast that is already
gone. Toasts evicted by `TOAST_LIMIT` (line 55) are dropped from state with their timers left running too.

Harmless today; it is the kind of thing that becomes a visible stutter once a page holds a lot of subscribers.

**Fix.** Clear the timer in `onOpenChange(false)` and when slicing past the limit.

---

### 44. `isFyLabel` has no callers, and its regex also matches a month key

`web/src/lib/fy.ts:31` - `/^\d{4}-\d{2}$/` accepts `"2026-09"`, which is the `YYYY-MM` shape used as a month
key throughout the app (`monthOf`, `thisMonthStr`, `periodKeyOf`). Nothing calls it today, so this is a trap
set rather than sprung - but an FY label is `"2025-26"` and a month is `"2026-09"`, and one regex cannot tell
them apart. Either delete it or check that the second pair is the first pair's year plus one.

---

### 45. `getPushState` asks for a registration by script URL, not by scope

`web/src/lib/webPush.ts:22` - `navigator.serviceWorker.getRegistration("/push-sw.js")`. The argument is a
*client URL* whose controlling registration is returned, so this resolves to whatever is registered at scope
`/` - which happens to be the push worker today, and would silently be a different worker the moment another
one is registered at the root.

---

## Checked and clean (round three)

- **Session-replay unmask escapes.** `unmask: ["h1"-"h4", "th", "label", "button", "nav", "dt"]` punches through
  the route mask by nearest-ancestor. Grepped all eight `SENSITIVE_PAGES` for a value rendered inside one of
  those: none. `DataTable`'s phone cards put the header in `dt` and the value in `dd`; totals live in `td`;
  `ActivityFeed` tags its before/after diffs, IP and user-agent `data-sentry-mask`. The one gap is finding 20.
- **`<label for>` binding.** All five `LABELABLE` components (`Input`, `Textarea`, `Select`, `Combobox`,
  `MoneyInput`) assign an explicit `displayName`, so the minified build still matches.
- **Percentage math.** Every `(a / b) * 100` in the app is zero-guarded except `Expenses.tsx:1538`
  (`peakValue`, a bar width - renders no bar rather than a wrong one). `chartTheme.shareOf` and
  `ProfileCompleteness` both guard correctly.
- **`richText` inline scanner.** `MAX_INLINE_SCAN` / `MAX_INLINE_DEPTH` bound the quadratic case; the overflow
  is emitted as plain text rather than dropped.
- **`useMe` memoization.** The `mePromise` memo is dropped on a non-401 failure and kept on a 401, which is
  what makes `retry()` re-fire and the sign-in screen stable.
- **`boardOrder.PIN_OFFSET`.** `1e15 + epoch_ms` stays well inside the exact-integer range of a double.

---
---

# Round four

Covering the API-key panel, the leave and remote-work request dialogs, the team timeline, the chart wrapper,
and the remaining "what day is it" helpers.

---

## Medium

### 46. The "Today" quick pick writes a date the form's own `min` forbids

`web/src/components/common/RequestLeaveDialog.tsx:31`, `:101`, `:258-266`
`web/src/pages/RemoteWork.tsx:39-41`, `:57`, `:289`

Both request dialogs hold two different answers to "what day is it".

The form's bounds and defaults use the **org's** day:

```ts
const minDate = allowBackdated ? undefined : todayStr();   // RequestLeaveDialog.tsx:101
...
<Input type="date" min={minDate} … />                      // :448
```

The quick-pick chips use the **viewer's**:

```ts
const ymdIn = (days: number) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toLocaleDateString("en-CA"); };
...
{ label: "Tomorrow", from: ymdIn(1), to: ymdIn(1), … }
```

For an employee west of the org - London staff, IST org - the org has already rolled to the next day from about
18:30 local. `minDate` is then `D+1` while `ymdIn(0)` is `D`. Pressing **Today** writes `start_date = D`, which
is below the input's own `min`. `<input type="date">` does not clear an out-of-range value set
programmatically, and the form validates on `form.start_date` rather than on `validity`, so Submit stays
enabled and the server refuses the request as backdated.

`lib/orgDay.ts` describes this exact shape in its header, and `RemoteWork.tsx:36` carries a comment saying the
browser-day helpers were removed from that file - immediately above two of them that were not:

```ts
// `todayStr` comes from lib/orgDay: the ORG's day. This file used to define its own from the browser's
const ymdIn = (days: number) => { … d.toLocaleDateString("en-CA"); };
const endOfWeek = () => { const d = new Date(); const add = Math.max(0, 5 - (d.getDay() || 7)); … };
```

Same file, line 57 seeds the form with `todayStr()` and line 289 offers `{ label: "Today", from: ymdIn(0) }`.

**Fix.** `orgDayFromToday(n)` for both, and `weekStartYmd(todayStr())` for `endOfWeek`.

Two more of the same class, lower stakes because they only pick a default view:

- `web/src/pages/PayrollRuns.tsx:78` - `defaultMonth()` reads `now.getUTCDate()` / `getUTCMonth()`, so for an
  IST org between 00:00 and 05:30 on the 11th it still sees the 10th and defaults the payroll month to the
  previous one.
- `web/src/pages/Events.tsx:615`, `:647` - the month cursor is built from local `getFullYear()`/`getMonth()`
  anchored at UTC, so "Today" can land on the wrong month either side of a boundary.

---

### 47. The one secret the app shows once has the only copy button with no failure path

`web/src/components/common/ApiKeysPanel.tsx:730-736`, `:748-754`

```tsx
onClick={async () => {
  await navigator.clipboard.writeText(minted ?? "");   // no catch
  setCopied(true);
  toast({ title: "Key copied", variant: "success" });
}}
```

`clipboard.writeText` rejects on a non-secure context, an unfocused document, or a denied permission. Here the
rejection is unhandled: `setCopied` never runs, no toast appears, and the button silently does nothing - on the
dialog whose own copy says *"This is the only time this key is shown. It is stored one-way, so it cannot be
recovered."*

It fails safe (`copied` stays false, so `closeMinted` still asks before closing), but the operator is told
nothing about why Copy appears dead, and the rejection surfaces as an unhandled promise rejection in Sentry.

The app has eighteen `clipboard.writeText` sites and three conventions:

| Convention | Sites |
|---|---|
| `.then(ok, err)` with both toasts | 13 (Announcements, Offers, BackgroundChecks, Referrals, Pipeline, Tickets, Boards, Goals, Suggestions, Compliance, …) |
| caught and silent | 3 (`LettersTab.tsx:304`, `Documents.tsx:1138`, `Profile.tsx:88` / `EmployeeProfile.tsx:156`) |
| **unhandled** | `ApiKeysPanel.tsx:732`, `:750` |
| **claims success unconditionally** | `Workflows.tsx:540` |

`Workflows.tsx:540` is the inverse failure - `void navigator.clipboard.writeText(...)` followed immediately by
`toast({ title: "Link copied", variant: "success" })`, so a failed copy reports success and the reader pastes
whatever was on the clipboard before.

---

### 48. A failed revoke during rotation leaves two live keys and says the rotation failed

`web/src/components/common/ApiKeysPanel.tsx:354-365`

```ts
const created = await create<ApiKey>("api-keys", body);
setCopied(false);
setMinted(created.secret ?? null);          // the "Copy your key now" dialog opens here
// Only now is the old one taken out: a failed mint must never leave the caller with nothing working.
await invoke(k.path, "revoke");
toast({ title: "Rotated - the old key is revoked", variant: "success" });
reload();
} catch (e) {
  toast({ title: "Couldn't rotate", description: (e as Error).message, variant: "destructive" });
}
```

The ordering is right for a failed *mint*. It is wrong for a failed *revoke*: by then the new key exists and
its secret dialog is already open, so the operator sees a red **"Couldn't rotate"** toast over a
**"Copy your key now"** dialog. The message says nothing happened; in fact a second fully-functional credential
now exists and the old one is still live. `reload()` is skipped too, so the key list does not show the new row
and the operator has no way to find it again once the dialog closes.

**Fix.** Catch the revoke separately: keep the secret dialog, and say what actually happened - "the new key is
ready, but the old one could not be revoked; revoke it from the list."

---

## Low

### 49. Drag-to-request on the team timeline is mouse-only

`web/src/components/common/TeamTimeline.tsx:916-917`, `:624-641`

```tsx
onMouseDown={canSelect ? (ev) => { … setSel({ a: p, b: p }); } : undefined}
onMouseEnter={onMove}
...
window.addEventListener("mouseup", finish);
```

No `pointerdown`/`pointermove`/`pointerup` and no touch equivalents. A tap still works (browsers synthesise a
mousedown/mouseup pair), so a single half-day selects - but dragging a range across days does not, because no
`mouseenter` fires during a touch drag; the timeline scrolls instead.

The timeline is a mobile surface by design: `dashboardPrefs.ts:13` carries `timelineOpen` described as
*"mobile-only: whether the team timeline section is expanded"*. So its primary interaction is unavailable on
the one screen size that has a dedicated preference for it, with no alternative affordance offered there.

Everything else in this codebase converted to pointer events and `coarse:` sizing during the responsive pass;
this is the surface that kept mouse handlers.

---

### 50. The team timeline runs on the UTC week while the rest of the app runs on the org's day

`web/src/components/common/TeamTimeline.tsx:221`, `:643-646`, `:630`

```ts
const startMs = useMemo(() => weekStartUtc(Date.now()) + page * DAYS * DAY_MS, [page]);
...
if (!workDays.includes(d.getUTCDay())) …      // weekend shading
...
const ymdOf = (dt: Date) => dt.toISOString().slice(0, 10);   // what the drag hands the leave dialog
```

Internally consistent, and wrong at the seam. For an IST org the UTC week rolls over 5½ hours late, so between
00:00 and 05:30 the timeline's "this week" is still last week's window while `todayStr()` - which every other
surface uses, including the `min` on the dialog this timeline opens - has already moved on. The dates the drag
hands to the request dialog are UTC days measured against an org-day bound.

**Fix.** `weekStartYmd(todayStr())` from `lib/orgDay.ts` as the anchor, and step in day strings.

---

## Checked and clean (round four)

- **`components/common/Chart.tsx`.** The frappe teardown is unusually careful: it shadows `update`/`render`/
  `updateNav` with no-ops before `destroy()` so the library's own uncancellable timers find nothing to do, and
  it rebuilds rather than updates whenever the series shape changes. Nothing to add.
- **`lib/goalMeasure.ts`.** `measuredPct` guards a zero span; `weightedProgress` weights only when every goal
  carries one (the documented divergence from `weight || 1`). Both pinned by drift tests.
- **Leave overlap detection.** `RequestLeaveDialog`'s `overlaps` compares `start_date`/`end_date` as bare
  strings while `myConflicts` slices to 10 characters first - the asymmetry is harmless because
  `serialize.ts:1035` emits both as `iso(...).slice(0, 10)`, so they are always plain `YYYY-MM-DD`.
- **`lib/leaveDays.ts`, `lib/eventRepeat.ts`.** Both now import the server's rule rather than mirroring it,
  which is what the two previously-drifted mirrors (`advanceRecurrence`, the CTC solver) argue for.

---

# Round five

Covering the asset-tag scan flow, PDF signature verification, and the signed-document viewer.

---

## High

### 51. The asset tag secret is left in the address bar for the rest of the session

`web/src/lib/assetTags.ts:304-312`, `web/src/pages/Assets.tsx:115-132`, `:674`

A printed tag's QR encodes a deep link carrying the asset's secret:

```ts
return `${origin}/#/assets/${a.id}${a.secret ? `?s=${a.secret}` : ""}`;
```

and the Assets page consumes it on mount:

```ts
const secret = route.query.s;
if (!secret || !route.id || custody) return;
...
if (mode) setCustody({ asset, mode, scan: `${window.location.origin}/#/assets/${route.id}?s=${secret}` });
```

The effect reconstructs the scan string into component state - and **never clears `?s=` from the URL**. The
line that does exactly this for a sibling param is 540 lines further down the same file:

```ts
if (route.query.stocktake) setQueryParam("stocktake", null); // leave a clean, shareable URL behind
```

Why it matters is stated on both sides of the wire. `lib/assetTags.ts:306`:

> *"the secret … lives on the physical label and **nowhere a normal reader of the app can see**"*

and `src/domain/assetCustody.ts:65-68`:

> *`"secret"` - the tag secret printed inside the QR. **Real evidence**: it is served only to callers who hold
> `printTag`, so possessing it means possessing the sticker.*

`requireProof` (`src/services/assets.ts:182-191`) accepts a secret-tier scan as sufficient on its own - no
override, no note - to record a **scanned** sighting, which is the one claim the whole custody feature exists
to make. So the secret is sighting-grade proof, and the scan flow parks it somewhere a normal reader sees:

- the address bar, for the rest of the visit - and every `replaceState` the page makes (`DataTable.tsx:328`,
  `urlQuery.ts:20`) rebuilds the hash with it still attached;
- browser history, so it outlives the session on a shared machine;
- **session replay**. Replay records navigation URLs, and the last-resort scrub
  (`instrument.ts:188-193`) matches PAN, IFSC, Aadhaar and bare 9-18-digit runs. A tag secret is ten characters
  of base32 (`src/domain/assetCustody.ts`), so it matches none of them and goes to Sentry intact - and
  "Report a problem" attaches that recording to a ticket.

**Fix.** `setQueryParam("s", null)` once the effect has taken the secret into `custody`, exactly as the
stocktake param is handled. The value is already held in state, so nothing downstream needs the URL copy.

---

## Medium

### 52. The green "Signature valid" stamp does no revocation check and trusts a self-asserted signing time

`web/src/lib/pdfSignature.ts:251-278`, `web/src/components/common/SignedPdfViewer.tsx:16`

```ts
const engine = new pkijs.CertificateChainValidationEngine({
  trustedCerts: roots,
  certs: (sd.certificates ?? []) as pkijs.Certificate[],
  verificationTime: signingTime ? new Date(signingTime) : new Date(),
});
const r: any = await engine.verify();
trusted = r?.result === true;
...
const validity = !integrity ? "invalid" : !coversDocument ? "invalid" : trusted ? "valid" : "unknown";
```

which drives:

```tsx
valid: { label: "Signature valid", icon: CheckCircle2, … }
```

Two gaps, neither of them in the module's stated "Two known limits" (which name multi-signer correlation and
exotic ECDSA curves):

1. **No revocation checking.** The engine is given no `crls` and no `ocsps`, and nothing anywhere in
   `pdfSignature.ts` or `ccaRoots.ts` mentions OCSP or CRL. A certificate that has been revoked still chains
   to a bundled root and renders a plain green **"Signature valid"** with no `note` (the note is only set on
   the not-trusted and coverage paths).

2. **`verificationTime` comes from the signer.** `signingTime` is read from signed attribute
   `1.2.840.113549.1.9.5`, which is covered by the signature but **asserted by the signer**, not by a
   timestamp authority. Nothing looks for an RFC 3161 timestamp token (`1.2.840.113549.1.9.16.2.14`). So the
   chain is validated as of whatever moment the signer claimed - which is the moment a holder of a
   since-revoked or since-expired certificate would choose.

The comment gives the right reason for not validating at `new Date()` (*"eSign certs are short-lived, so
validating 'now' would wrongly reject a signature that was valid when made"*); the standard answer to that is
the timestamp token, and it is not consulted.

Both are inherent to verifying with no network, which the header states as a design choice
(*"the server is never asked"*). The defect is the **label**: a stamp that says "Signature valid" without
qualification is read as more than "the maths checks out and the issuer is one we ship".

**Fix.** Either qualify the green state ("Signature valid · revocation not checked"), or set `note` on the
valid path when no timestamp token was found, so the stamp says what it actually verified. The component
already renders `note` under the label for exactly this purpose.

---
---

# Round six

Smaller items from the remaining components (letterhead designer, workflow builder, activity feed, toast
store, soft-delete hook), plus a note on what the sweep found clean.

---

## Low

### 53. The letterhead preview re-renders a PDF per keystroke burst and cancels none of them

`web/src/components/settings/LetterheadDesigner.tsx:242-264`

```ts
const t = setTimeout(() => {
  setRendering(true);
  void blobUrl(path, { verb: "preview", body: { design, variant: shownVariant } })
    .then((u) => { if (dropped) { URL.revokeObjectURL(u); return; } … })
    …
}, 600);
return () => { dropped = true; clearTimeout(t); };
```

`dropped` stops a superseded answer being applied and revokes its object URL, but the **request keeps
running**. `postBinary` takes an `AbortSignal` (`api.ts:588`, `:611`) and the sibling effect thirty lines below
uses one, with a comment saying exactly why:

> *"Cancelled, not just ignored, on cleanup: … otherwise lets the request run to completion AFTER the server
> has deleted the bytes … Aborting stops the request before that response ever lands."*

The preview is the more expensive of the two: each call is a full PDF render, and `api.ts:622-625` notes that
those are the requests the dedicated `render` budget (40/min in `middleware/rateLimit.ts`) exists to bound. So
a designer session - drag an element, type a heading, nudge a margin - fires one render per 600 ms quiet
window and lets every superseded one run to completion against that budget.

**Fix.** Thread an `AbortController` through, as the thumbnail effect already does.

---

### 54. The workflow builder's event picker groups with a raw `<div>` instead of `SelectGroup`

`web/src/components/workflows/WorkflowBuilder.tsx:53-59`

```tsx
<SelectContent>
  {groups.map((g) => (
    <div key={g}>
      <div className="px-2 py-1 text-xs font-semibold uppercase text-muted-foreground">{g}</div>
      {…map((e) => <SelectItem key={e.type} value={e.type}>{e.label}</SelectItem>)}
    </div>
  ))}
```

`ui/select.tsx` exports `SelectGroup` and `SelectLabel`, which Radix wires together with `aria-labelledby` -
and `components/common/GenerateLetterDialog.tsx:271-274` uses them correctly for the same shape. Here the
module headers are visual only, so a screen-reader user gets one flat list of every event with no sense of
which module each belongs to. This is the app's longest Select.

---

### 55. `ActivityFeed`'s "Load older" has no stuck-cursor guard

`web/src/components/common/ActivityFeed.tsx:370-379`

```ts
const p = await get<ActivityPage>(params({ page_token: nextToken, … }));
setRows((r) => [...(r ?? []), ...p.results]);
setNextToken(p.next_page_token);
```

`api.ts#listAll` and `#getAllPages` both keep a `Set` of tokens already followed, after the failure their
comments describe ("a keyset key that ties across more rows than a page holds, a filter change mid-walk, a bug
in a route's own `list` hook"). This walk keeps none: a cursor that fails to advance appends the same page
again on each press, with duplicate `path` keys in the list. It is user-driven rather than a loop, so the
worst case is a growing pile of duplicated rows rather than a hang - the same shape as
`lib/clock.tsx#listAllSessions` (finding 35).

---

## Checked and clean (round six)

- **Keyboard-accessible click targets.** Every `onClick` on a `div`/`span`/`li`/`td` in the app turned out to
  be a `stopPropagation` wrapper around a real control - 18 candidates, 18 false positives. Every icon-only
  `<button>` carries an `aria-label` or `title`.
- **`<img>` alt text.** No `<img>` in `web/src` is missing `alt`.
- **Kanban drag-and-drop** (`Boards.tsx:594-627`). Optimistic patch, `reload()` on failure, and `cards:move`
  is deliberately left off `VERB_SIDE_EFFECTS` so it falls through to `always("cards")`, which carries the
  `goals` roll-up the move triggers server-side. The rank comparator breaks ties on `path` so two viewers
  cannot disagree about a tied pair.
- **`components/common/Chart.tsx` teardown**, **`lib/goalMeasure.ts`**, **`lib/leaveDays.ts`**,
  **`lib/eventRepeat.ts`** - see round four.
- **`lib/screenRecording.ts` + `RecordingChip`.** The window is bounded from the persisted deadline rather
  than a counter, the chip is mounted for every signed-in caller so a reload cannot strand a running recorder,
  and an already-expired restored session is stopped on the first tick.
- **`hooks/useSoftDelete.ts`.** Soft delete skips the confirm deliberately (it is reversible, and the toast
  carries the Undo); the hard delete still confirms with `destructive: true`.
- **`lib/richText.tsx` security.** No `dangerouslySetInnerHTML` anywhere in `web/src`; `safeHref` allows only
  `https?://x` and `mailto:a@b`; mention targets are pinned to a 26-character Crockford id; `Anchor` carries
  `rel="noopener noreferrer nofollow ugc"`.

---

# Coverage

Read in full: `api.ts`, `router.ts`, `useMe.ts`, `nav.ts`, `App.tsx`, `main.tsx`, every file in `hooks/`,
`lib/` (resourceStore, clientStore, getCoalescer, crossTabBus, settingsStore, photoCache, prefs, tabActivity,
dashboardPrefs, tablePrefs, theme, webPush, notifications, approvals, clock, perm, orgDay, attendance, utils,
intl, richText, download, exportTable, draftStore, dialogHistory, intent, localPref, viewAsStore, scrollLock,
urlQuery, formError, quickActions, goalMeasure, fy, leaveDays, eventRepeat, complianceRecurrence,
screenRecording, pdfSignature, assetTags, lazyPage, boardOrder, chartTheme), the layout shell
(`TopBar`/`Sidebar`/`BottomNav`/`Workspace`/`OfflineBar`/`PullToRefresh`/`ShortcutLayer`/`CommandPalette`),
the access components, `instrument.ts`, and the shared primitives (`DataTable`, `dialog`, `confirm`,
`WriteDialog`, `Field`, `use-toast`, `select`, `combobox`, `ErrorBoundary`, `PhotoAvatar`, `Chart`,
`ApiKeysPanel`, `SignedPdfViewer`, `TeamTimeline`, `RequestLeaveDialog`, `EmployeeDocuments`,
`LetterheadDesigner`, `WorkflowBuilder`, `ActivityFeed`, `RecordingChip`, `ProfileCompleteness`).

Sampled rather than read end to end: the largest pages (`Settings` 3,537 lines, `Boards` 2,683, `Goals` 2,393,
`Announcements` 1,628, `Expenses` 1,708, `Reviews` 1,494, `Documents` 1,317, `Tickets` 1,262, `PayrollRuns`
1,011, `ExpenseBudgets` 1,498) and `PostComposer`, `CardSticker`, `AclModal`, `PermissionsPanel`,
`EmployeeCompensation` - targeted at their write paths, date arithmetic, money math and effect lifecycles
rather than line by line.

---
---

# Round seven

Closing the coverage gap on the large pages that round one only sampled: Announcements, Suggestions, Settings,
Tickets, Expenses, EmployeeCompensation.

---

## Medium

### 56. A reaction or vote made while searching (or on a post's own page) is folded into one row source of three

`web/src/pages/Announcements.tsx:180-209`, `:274`, `:305-328`

The board holds three different row sources for the same collection:

```ts
const { rows, setRows, … } = useCollection<Announcement>("announcements", { max: FEED_PAGE_SIZE });
const srch       = useCollection<Announcement>("announcements", { q: debouncedQ, enabled: searching, max: FEED_PAGE_SIZE });
const [soloRows, setSoloRows] = useState<Announcement[]>([]);          // fetched by id, outside the store
...
const source    = solo ? soloRows : searching ? srch.rows : rows;
const setSource = solo ? setSoloRows : searching ? srch.setRows : setRows;
const fold = (updated) => setSource((prev) => prev.map((r) => (r.path === updated.path ? updated : r)));
```

`fold` writes to whichever source is *currently active*. The other two keep the pre-action row - and nothing
corrects them, because these verbs are deliberately mapped to no invalidation at all
(`lib/resourceStore.ts:842-851`):

```ts
"announcements:markRead": [],
"announcements:react": [],
"announcements:vote": [],
"announcements:pin": [],
"announcements:unpin": [],
```

The reasoning there is sound in isolation - *"the board's own verbs hand back the fully reserialized post, and
the feed folds that row straight into the store"* - but it assumes one feed. Repro:

1. Search for a post, react to it. `fold` updates the `q`-keyed store entry.
2. Clear the search. `resourceStore.subscribe`'s unsubscribe drops the `q` entry outright
   (`ephemeral(e) = !!e.opts.q || !!e.opts.deletedOnly`, line 136/613), revealing the unfiltered entry.
3. Within that entry's 20 s `TTL_DEFAULT_MS` no refetch happens, so **the reaction is gone from the card**. It
   reappears on the next revalidation.

The solo page is the same shape and worse: `soloRows` is plain component state, entirely outside the store, so
a reaction taken there reaches no cached entry at all. `web/src/pages/Suggestions.tsx:56`, `:72`, `:88` repeats
it with `suggestions:upvote` / `:downvote`, also mapped to `[]`.

The page that gets this right is `Expenses.tsx:499-505`, which holds five entries on one collection and has a
`reloadAll()` covering every one, with a comment saying exactly why: *"a decision made on one tab can't leave
another showing the row it just moved."* `Tickets.tsx` (two entries) is covered for free, because its verbs are
unmapped and therefore fall through to the invalidate-everything default.

**Fix.** Fold into every source the page holds, not just the active one - the store already exposes `setRows`
per key, so it is one helper that calls all three.

---

### 57. Settings panels are the only place that sends an If-Match, and the only place that ignores the 409

`web/src/pages/Settings.tsx` (every `save()`), `web/src/lib/settingsStore.ts:244-257`

`saveSetting` exists to stop two admins overwriting each other, and its doc is explicit about the stake:

> *"a write that carries no version is not 'last write wins' over one field - it is one admin's entire
> ticket-category list, or kudos ladder, or dashboard layout, replacing another's with no sign anything was
> lost. … the caller gets a 409 to re-read and re-apply."*

Nothing re-reads or re-applies. Every panel's handler is the same shape:

```ts
async function save() {
  setSaving(true);
  try {
    await saveSetting("attendance", { value: cfg });
    markSaved();
    toast({ title: "Attendance schedule saved" });
  } catch (e) {
    toast({ variant: "destructive", title: "Couldn't save", description: String((e as Error).message) });
  } finally { setSaving(false); }
}
```

On a conflict `saveSetting` calls `invalidateSettings()` (dropping the snapshot and its etags) and rethrows.
The panel toasts *"Someone else changed this while you had it open. Reload the page, then reapply your
change."* - correct advice - and then leaves the Save button live over `cfg`, which is still the losing
version. **Press Save again without reloading and it succeeds**: `saveSetting` re-`load()`s, picks up the
winner's fresh etag, and writes the stale blob over their whole section.

Eleven record-editing pages handle this properly and show what the panels are missing
(`Interviews.tsx:500-512`, and the same shape in Offers, Referrals, Candidates, Tickets, Boards, Events,
Requisitions, Workflows, Goals):

```ts
if (isConflict(e)) {
  const fresh = await get<Interview>(…).catch(() => null);
  if (fresh) setEtag(fresh.etag);
  throw new Error("Somebody else changed this interview while you had it open. Press Save again to keep your version.");
}
```

They make the overwrite deliberate and say so. `rg isConflict web/src/pages/Settings.tsx` returns nothing - the
one surface where a losing write costs a whole config section rather than one row.

**Fix.** Catch `isConflict` in the panels: re-read the key, and either merge or state plainly that pressing
Save again replaces the other admin's version.

---

## Checked and clean (round seven)

- **`components/common/EmployeeCompensation.tsx`.** Both classes of bug this file is on the index's watch-list
  for are already fixed, with the rationale recorded: the CTC solver now imports `splitCtc` from
  `src/domain/payroll` rather than re-implementing the step function (the old copy ran a single bisection and
  disagreed wherever an employee's plug range crossed an ESI/PF ceiling), and `variableFy` takes the financial
  year from `lib/fy.ts#currentFy` rather than the viewer's UTC getters.
- **`pages/Announcements.tsx` verb handlers.** `react` snapshots `before`, applies optimistically and
  `fold(before)` on failure; `markRead` restores the dot on any failure rather than lying about the receipt;
  `publishDraft` and `castVote` fold the reserialized row. The only gap is which source they fold into
  (finding 56).
- **`pages/Settings.tsx` writes.** Every panel goes through `saveSetting` - none reaches for `patch` directly -
  so the version guard is applied uniformly. The gap is the 409 handling, not the guard.
- **`pages/Expenses.tsx` multi-entry refresh.** `reloadAll()` covers the ledger plus all four server-filtered
  queues.

---
---

# Round eight

A systematic sweep for multi-write sequences: every place the app issues two or more writes in one handler
without a way to undo the first if the second fails.

The reference implementation is `components/access/AclModal.tsx:392-416`, and it is worth reading before the
findings below. It removes the rules it is replacing one at a time into a `removed` array, creates the
replacement, and on any failure restores what it took out and **reports how many it could not put back**:

```ts
const outstanding = removed.length - (await restoreAccessRules(removed));
toast({ variant: "destructive", title: "Could not update role",
  description: outstanding
    ? `${message} - and ${outstanding} rule${…} that had to be removed first could not be put back. Check ${roleLabel(name)} before relying on it.`
    : message });
```

That is the bar. Nothing else in the app does it.

---

## Medium

### 58. "Publish now" on a draft: the save commits, the publish fails, and the retry conflicts with itself

`web/src/components/common/PostComposer.tsx:609-616`

```ts
saved = await patch<Announcement>("announcements/" + idOf(editing.path), payload, editing.etag);
// Going live is its own verb (it owns the notification), so "Publish now" on a draft is a save then a
// publish - and the etag has moved on by then, hence the fresh one off the response.
if (showPublishing && form.publishing === "now") {
  saved = await invoke<Announcement>("announcements/" + idOf(editing.path), "publish", saved?.etag);
  toast({ title: "Published", variant: "success" });
}
```

The etag threading between the two steps is right. What is missing is what happens when step two fails: the
content edit is already committed, the post is still a draft, and the catch leaves the dialog open showing the
publish error.

The natural response - press "Publish now" again - **cannot work**. The retry re-runs the `patch` with
`editing.etag`, which is a prop the parent never refreshed (the throw happened before `onSaved(saved)`), so the
server answers 409 and the reader is shown:

> *"Someone else changed this while you had it open. Reload the page, then reapply your change."*

Nobody else changed it. They did, a second ago, with the press that half-failed.

**Fix.** Hold the etag from the successful `patch` in state (as `Interviews.tsx:502` does with `setEtag`) so a
retry skips straight to the publish, and say that the edit was saved.

---

### 59. The background-check "standard set" creates four rows in a loop with no resume point

`web/src/pages/BackgroundChecks.tsx:161-164`

```ts
} else if (standardSet) {
  // One vendor, one initiation date, four checks: what actually gets ordered for a new joiner.
  for (const t of STANDARD_SET) await create("background-checks", bodyFromForm(t, t === form.check_type ? document : ""));
  toast({ title: `${STANDARD_SET.length} checks added`, … });
}
```

Same shape as the document batch loop (finding 25), bounded at four. A failure on the third leaves two checks
created against that employee; the throw reaches `WriteDialog`, which keeps the form exactly as typed; and
pressing Save again runs the loop from the start, creating duplicates of the first two.

Background checks are records about a named person that HR then chases vendors on, so duplicates are not
cosmetic - they are two open orders for the same verification.

**Fix.** Track which types succeeded and skip them on a retry, or send the set in one request.

---

## Low

### 60. The payroll bank format and debit account save as two unguarded whole-blob writes

`web/src/pages/BankFormats.tsx:178-195`

```ts
const saved = await patch<BankFormat>(`bank-formats/${encodeURIComponent(sel)}`, body);
setFormats((m) => ({ ...m, [sel]: { ...saved, bank: sel } }));
if (isSuper) {
  const d = await patch<PayrollDebitAccount>(`payroll-debit-accounts/${encodeURIComponent(sel)}`, body);
  setDebit((m) => ({ ...m, [sel]: { ...d, bank: sel } }));
}
toast({ title: `Saved ${sel} format` });
} catch (e) {
  toast({ variant: "destructive", title: "Could not save", … });
}
```

Two problems, both mild individually:

1. **The failure message is wrong half the time.** If the second patch fails, the first has committed and
   `setFormats` has already applied it - so the format *was* saved, the screen shows it saved, and the toast
   says "Could not save".

2. **No version guard, and none available.** Both writes replace a whole blob: the column mapping that decides
   how the payroll bank file is laid out, and the debit account number money is drawn from. `src/routes/bankFormats.ts`
   is a bespoke route rather than a `collectionRoutes` factory - `toResource` emits no `etag` and the PATCH
   ignores `If-Match` - so two admins editing the same bank silently overwrite each other. That is the exact
   failure `lib/settingsStore.ts:244-257` was given `If-Match` for (*"one admin's entire ticket-category list …
   replacing another's with no sign anything was lost"*), on arguably the most consequential config in the app.

   This half is a server gap; noted here because the frontend is where it shows, and because the fix is the
   same shape as the one `saveSetting` already applies.

---

## Checked and clean (round eight)

The multi-write sweep turned up 27 candidate sites. All but the four reported (findings 25, 48, 58, 59) were
either `if (editing) … else …` branches - one write, two spellings - or genuinely independent single-field
patches:

- `EmployeeCompensation.tsx:356`, `Assets.tsx:254`, `BenefitPlansAdmin.tsx:69`, `Benefits.tsx:98`/`:112`,
  `AssetCategories.tsx:74`, `RolesManagePanel.tsx:115`, `Boards.tsx:1281` - edit-or-create branches.
- `CheckIns.tsx:186`-`:213` - five independent one-field patches, each with its own try/catch and reload.
- `components/access/AclModal.tsx:392-440` - the reference implementation above, on both the role and the
  subject paths.

`patch` calls that send no `If-Match` were also enumerated (27). Nearly all are correct by the rule
`lib/notifications.tsx:291-304` states - a single flag on a row with one reader and one writer, where
last-write-wins *is* the intent - or the `employees/<id>/<section>` sub-resources, which are not versioned that
way. `BankFormats` above is the one whole-blob case on a collection where a guard would matter.

---
---

# Round nine

Reading (not sampling) the large pages: `Settings.tsx` (3,537 lines), `ExpenseBudgets`, `Goals`, `Attendance`,
`Boards`, `Holidays`, plus the bulk-action machinery and a full inventory of browser-storage keys.

---

## Medium

### 61. The Professional Tax editor rewrites the slab table by POSITION, so re-saving can silently change everyone's deduction

`web/src/pages/Settings.tsx:669-673`, `:753-767`, `:775`

The panel renders the **last row of the array** as the open-ended top band, and on save forces that row's bound
to null and coerces every other row's:

```ts
const slabs = pt.slabs.map((s, i) => ({
  up_to: i === pt.slabs.length - 1 ? null : Number(s.up_to) || 0,
  amount: Number(s.amount) || 0,
}));
```

Nothing anywhere requires the open-ended slab to be last. The server's resolver explicitly refuses to assume it
(`src/domain/statutory.ts:52-53`):

> *"Slabs are matched in ASCENDING order; the table is HR-editable settings data, so **sort rather than trust
> the stored order** - a top (`up_to: null`) slab listed first would otherwise charge its amount to every wage."*

and the settings validator (`src/routes/settings.ts:353-364`) checks only that each `amount` is non-negative
and each `up_to` is a non-negative number or null - not the ordering, not that there is exactly one null.

So for any stored table whose `null` band is not last - written through `PATCH /v1/settings/professional-tax`
by an API key, an import, a seed, or an older build - opening this tab and pressing Save (to change the annual
cap, say) rewrites the tax table:

- the real top band's `null` becomes `Number(null) || 0` → **`up_to: 0`**, a bracket that matches nothing,
- whatever happened to be last becomes the new catch-all.

Every payslip's PT line changes, with no diff, no warning, and no way to see it in the UI (the panel offers no
reordering, so the admin cannot tell the rows are in an order the editor does not expect).

`ReferralsTab` forty lines below does the right thing for the identical shape - it sorts before saving,
"matching the resolver's expectation" (`Settings.tsx:855-856`).

**Fix.** Sort by `up_to` (nulls last) on load, and pick the top band by value rather than by index.

---

### 62. Two "Hired" pipeline stages pass every check, and the hire anchors on whichever is first

`web/src/pages/Settings.tsx:984`, `:948`; `src/domain/ats.ts:122`; `src/services/ats.ts:864`, `:951`

The panel states the rule:

> *"Mark **exactly one** stage as Hired (reaching it marks the candidate hired)."*

Both validators check only that one exists:

```ts
// Settings.tsx:948
if (!stages.some((s) => s.kind === "hired")) { toast({ … }); return; }
// src/domain/ats.ts:122
if (!cfg.stages.some((s) => (s as AtsStage | null)?.kind === "hired")) { errors.push(…); }
```

and the conversion resolves the first:

```ts
// src/services/ats.ts:864 and :951
const hiredStage = cfg.stages.find((s) => s.kind === "hired")?.key ?? app.stage;
```

So an org can save two Hired stages. The board then renders two terminal columns (`Pipeline.tsx:355` treats
`col.kind === "hired"` as truthy for both), a recruiter can drag a candidate into the second, the client marks
it a hire (`Pipeline.tsx:214`), and the server's `:hire` / `offers:accept` put them in the **first**. The
pipeline has two ends and the record lands at the one nobody chose.

This is the same failure the `addStage` helper guards against for duplicate *keys*, at length
(`Settings.tsx:913-921`): *"two stages sharing one are the same stage to everything downstream."* A second
Hired stage is the terminal-shaped version of it, and neither validator was taught about it.

**Fix.** Count instead of testing existence, in both validators.

---

### 63. A failed payout-mode save leaves the switch showing the setting the server rejected

`web/src/pages/Settings.tsx:1308-1319`

```ts
async function save(next: "payroll" | "separate") {
  setMode(next);                                   // optimistic
  setSaving(true);
  try { await saveSetting("reimbursements", { value: { payout_mode: next } }); toast(success); }
  catch (e) { toast({ title: "Couldn't save", … }); }   // <-- mode is never put back
  finally { setSaving(false); }
}
```

The toggle stays on the value that failed, and so does the explanatory paragraph beneath it - so the panel
reads *"Approved claims are paid out-of-band; mark them paid from the Reimbursements page"* while the server
still has `payroll` and is quietly adding claims to the next run. A reload silently flips it back.

Every other panel in this file uses `useUnsaved` + an explicit Save, so a failure leaves the form visibly
dirty. This one auto-saves on click and has neither a revert nor an unsaved marker.

---

### 64. A third file keeps the browser's calendar alongside the org's

`web/src/pages/Holidays.tsx:107`, `:156`, `:626`, `:692`, `:839`

```ts
const [year, setYear] = useState(readHashQuery("year") ?? String(new Date().getFullYear()));
```

five times, in a file that imports `todayStr` from `lib/orgDay` and carries the by-now-familiar comment at
line 54:

> *"`todayStr` is imported from lib/orgDay, which answers the ORG's day. This file used to define its own…"*

`thisYearStr()` exists in `lib/orgDay.ts:66` for exactly this. Around New Year the page opens on the viewer's
year rather than the org's - and line 839 seeds the **create** form (`defaultFrom`), so a holiday added on 1
January by someone whose browser is still on 31 December is created against the wrong year.

That makes three files with the same shape, each carrying a comment saying the browser-day helper was removed:
`RequestLeaveDialog.tsx:31`, `RemoteWork.tsx:39-41` (finding 46) and this one.

---

### 65. A partially-failed bulk action keeps every row selected - and then disables the retry

`web/src/lib/bulk.ts:9-35`, `web/src/components/common/DataTable.tsx:513-536`,
`web/src/pages/Expenses.tsx:821-826`, `Tickets.tsx:425`/`:440`, `Boards.tsx:2088`-`:2148`

`bulkInvoke` computes exactly what a retry needs and returns it:

```ts
export type BulkResult<R extends BulkRow = BulkRow> = { ok, failed, firstError, okRows: R[], failedRows: R[] };
```

`Approvals.tsx:288-296` is the only caller that uses it - it removes `okRows` from the selection, leaving just
the failures. Every other caller discards it and leans on `DataTable`'s catch instead:

```ts
const r = await bulkInvoke("expenses", verb, sel, body);
toast(bulkSummary(past, r));
reloadAll();
if (r.failed > 0) throw new Error("partial"); // keep the failed rows selected for a retry
```

but the catch it is relying on keeps **all** of them:

```ts
} catch {
  // the caller's run() surfaces its own error toast; keep the selection so the user can retry
}
```

`BulkAction.run` is typed `(rows: T[]) => void | Promise<void>`, so there is no channel for the failed subset
even if a caller wanted one.

On the finance queue that is a dead end, not just noise. Approve 10 expenses, 2 fail:

1. all 10 stay selected;
2. `reloadAll()` lands, and the 8 that succeeded are now `APPROVED`;
3. the Approve action's own guard is `sel.every((r) => up(r.state) === "SUBMITTED" && canDo(r, "approve"))`, so
   with 8 approved rows in the selection it evaluates false and **the button is disabled**;
4. nothing on screen says which 2 failed or that the way forward is to deselect the other 8 by hand.

Same shape for `tickets:resolve` / `close`. The board's `cards:move` escapes it only because moving a card
twice is idempotent.

**Fix.** Let `run` return the rows to keep selected (or have `DataTable` accept a `BulkResult`), and use
`failedRows` - the value is already there.

---

## Low

### 66. Eight browser-storage keys hold per-user state without a per-user namespace

A full inventory of every `localStorage` key in `web/src`. The convention is clearly established - most keys
carry the identity, and three separate modules document *why* (`lib/ticketsSeen.ts:12-15`,
`lib/tabActivity.ts:17-21`, `lib/tablePrefs.ts:27-29`, each describing the shared-machine failure they fixed).
These did not get it:

| Key | Holds | Where | Effect on a shared browser |
|---|---|---|---|
| `prefs.unconfirmed` | table layouts, saved views, dashboard layout, tab-seen map | `lib/prefs.ts:98` | **writes A's data onto B's server rows** (finding 19) |
| `dash.personal` | pinned/hidden KPIs, section order | `lib/dashboardPrefs.ts:22` | B's dashboard opens as A's (finding 23) |
| `hrms.board.filter` | `{ kind, author }` - **author is an employee ref** | `pages/Announcements.tsx:124` | B's board opens filtered to a colleague A picked |
| `goals:filter` | status filter | `pages/Goals.tsx:79` | B's Goals page opens on A's filter |
| `boards:last` | last-viewed board id | `pages/Boards.tsx:365` | B lands on A's board (guarded by `valid()`, so it degrades to the first board) |
| `hrms.letters.rail` | rail state | `pages/LettersTab.tsx:24` | cosmetic |
| `letterTemplate:last` | last letter template | `components/common/GenerateLetterDialog.tsx:23` | B's generate dialog defaults to A's template |
| `push-enroll-dismissed` | the enrolment banner dismissal | `components/notifications/PushEnrollBanner.tsx:21` | A's dismissal hides the prompt from B, who has no subscription |
| `hrms.assetTagSheet.v3` | sheet layout + **queued asset ids** | `components/assets/AssetTagPrinter.tsx:37` | acknowledged at line 351 ("left over in localStorage from another org"), handled by freeing the slot |

Correctly namespaced, for contrast: `am:`, `dt:`, `nav:collapsed:`, `nav:rail:`, `palette:frecent:`,
`board:composer:`, `hrms.attendance.view:`, `review:`, `tickets-last-seen:`, `tab_seen:`, `draft:`,
`hrms.sync:`, and everything in `clientStore`. Deliberately global and correct: `theme`, `hrms:viewAs`,
`hrms.scanCamera` (a camera belongs to the device, not the person).

`push-enroll-dismissed`'s comment argues for per-*device* rather than per-user - but the argument it makes
("someone who enables it on their laptop is still un-enrolled on their phone and should still be asked there")
is an argument for per-device-**per-person**, which is what the namespaced keys do.

---

## Checked and clean (round nine)

The batch-write compensation problem (findings 25, 59) is worth restating, because the codebase contains three
correct implementations of it and the gap is consistency, not knowledge:

- **`pages/Attendance.tsx:426-461`** - `submitCorrection` keeps a `filedThisDialog` set, skips days already
  filed on a retry, stops at the first failure and returns `"Filed 3 of 5. <reason>"`.
- **`pages/ExpenseBudgets.tsx:419-450`** - `commitRoll` counts what it made, and on failure keeps the sheet
  open with `"${made} of ${lines.length} created, then it stopped: …"` rather than discarding the edits.
- **`components/access/AclModal.tsx:392-416`** - restores the rules it removed and reports how many it could
  not put back.

Against `Documents.tsx:322-325` and `BackgroundChecks.tsx:161-164`, which loop `await create(...)` with no
record of how far they got and a form that re-runs from the start.

Also verified clean this round:

- **`pages/Goals.tsx:408-410`** sends `baseline_value` / `target_value` / `current_value` as `null`, which
  looked like findings 10/18 - but all three are `nullable: true` in `openapi.yaml:1775-1777` and
  `.nullable()` in `src/routes/goals.ts:31-33`. Correct as written.
- **`pages/ExpenseBudgets.tsx:53-118`** - every period boundary is UTC-anchored (`Date.UTC`, `getUTC*`,
  `timeZone: "UTC"` on the formatter) and compared against a UTC `now`, so the arithmetic is internally
  consistent.
- **Optimistic updates.** A scan of every `setX(prev => …)` followed by an `await` and a `catch` across the 22
  largest pages found no case that fails to roll back or reload.
- **Loose equality.** All 58 `==` occurrences are the deliberate `== null` idiom; the single `parseInt` passes
  a radix.


---

## 67. The shadowed-rule lint ignores the `everyone` pseudo-role, while the denied-rule lint beside it does not

`web/src/components/access/ruleLogic.ts:87-90`, `:107`, `:115-121`

The file defines a subject test that accounts for the pseudo-role the engine unions into every caller:

```ts
function appliesToSameSubject(r: AccessRule, other: AccessRule): boolean {
  if (other.subject_kind !== r.subject_kind) return false;
  if (other.subject === r.subject) return true;
  return r.subject_kind === "role" && other.subject === EVERYONE_ROLE;
}
```

with a comment saying why:

> *"A ROLE rule is also affected by the `everyone` pseudo-role, which the engine unions into every role - so an
> `everyone` deny kills a role's allow, and that is exactly the kind of silent dead rule this lint exists to
> surface."*

The **deny** check uses it:

```ts
const deny = all.find((o) => … appliesToSameSubject(r, o) && sameTarget(r, o) && covers(o, r) …);
```

The **shadowed** check, eight lines below, compares subjects directly instead:

```ts
const broader = all.find((o) =>
  o.subject_kind === r.subject_kind &&
  o.subject === r.subject &&        // <-- not appliesToSameSubject
  …);
```

So an `everyone` allow that already grants, say, read on the whole collection does genuinely make every
per-role read allow redundant - the engine unions them exactly as it does for a deny - and the lint stays
silent. Admins keep and maintain rules that change nothing, which is the condition this column exists to
report.

The file's header says the lint "would rather miss a dead rule than call a live one dead", so this fails safe.
But `everyone` is unioned in by construction, so using `appliesToSameSubject` on the allow side is not a
loosening - it is the same rule the deny side already applies.

**Fix.** Use `appliesToSameSubject(r, o)` in the `broader` predicate, as the `deny` predicate does.

---

## 68. Three collections support a record deep link that nothing ever generates

`web/src/lib/resourceRoute.ts:5-18`, `web/src/App.tsx:599-621`

`resourceRoute()` is the one place the activity feed, the approvals inbox and search turn a record ref into a
hash route. Its `DEEP_OPEN` table lists the collections whose page opens a specific record. Three routes accept
an `openId` in `App.tsx` and are absent from it:

| Route | App.tsx | `resourceRoute("<collection>", ref)` yields |
|---|---|---|
| `pipeline` | `:603` `<Pipeline me={gme} openId={route.id ?? undefined} />` | `applications` → `PAGE_OF` → `"pipeline"` - the board, not the application |
| `tables` | `:620` `<TableBuilder me={gme} openId={route.id ?? undefined} />` | `table-views` → absent from all three tables → **`null`**, i.e. no link at all |
| `expense-budgets` | `:599` `<ExpenseBudgets me={gme} openId={route.id ?? undefined} />` | `"expense-budgets"` → `PAGE_OF` → the list page |

`tables` is the sharpest: `App.tsx:619` carries the comment *"`tables/<id>` opens that grid in place: a saved
table is a record people link to, not a dialog"* - and `resourceRoute` returns null for it, so the activity
feed renders no destination.

Nothing breaks; the reader lands one level too shallow (or gets no link). But the three tables have to agree to
be useful, and there is no check holding them together.

**Fix.** Add `applications: "pipeline"`, `"table-views": "tables"` and `"expense-budgets": "expense-budgets"`
to `DEEP_OPEN`, and pin the agreement with a test that every `openId`-taking route in `App.tsx` has a
`DEEP_OPEN` entry.

---

## 69. The leave reason is masked on the Leaves page, unmasked in the calendar's hover card, and exported into .ics files

`web/src/components/calendar/shared.tsx:68`, `web/src/pages/LeaveCalendar.tsx:231`, `:345`

A leave request's free-text `reason` is what people put "hospital appointment", "bereavement" or "IVF
treatment" into. The app treats it as sensitive in three places and not in two.

**Masked**, and pinned by a test:

```tsx
// pages/Leaves.tsx:516  - "The reason is masked in session replay (data-sentry-mask, see web/src/instrument.ts)"
{ id: "reason", …, cell: (lr) => <span data-sentry-mask>{lr.reason || "-"}</span> },
// pages/Leaves.tsx:1058
<dd data-sentry-mask>{detailRow.reason?.trim() || …}</dd>
// components/common/RequestLeaveDialog.tsx:570
<Textarea rows={3} data-sentry-mask data-sentry-ignore value={form.reason} … />
```

`test/replayMaskCoverage.test.ts:109-110` asserts the first two by regex against `Leaves.tsx` specifically.

**Not masked**, on a route that is not in `SENSITIVE_PAGES`:

```tsx
// components/calendar/shared.tsx:68 - inside EntryCard, the hover card on every leave bar
{en.reason && <p className="line-clamp-3 italic">"{en.reason}"</p>}
```

`LeaveCalendar.tsx:231` populates `reason` into the `CalEntry`, and `TeamGrid.tsx:180` renders the bar
`interactive`, which is what attaches `EntryCard`. The page is `#/leave-calendar`, `data-page="leave-calendar"`
- absent from `SENSITIVE_PAGES` (`instrument.ts:53-71`) - and the posture is unmask-by-default. So hovering any
colleague's leave bar puts their reason into the session recording, which "Report a problem" then attaches to a
ticket.

**Exported**, into a file that leaves the app entirely:

```ts
// pages/LeaveCalendar.tsx:345 - the .ics download
description: [en.deptId ? deptName(en.deptId) : "", en.pending ? "Pending approval" : "Approved", en.reason ?? ""]
  .filter(Boolean).join(" · "),
```

Every colleague's reason is written into the DESCRIPTION of a downloadable calendar file. The exporter could
already read those reasons on screen, so this is not an access-control hole - but it moves them from a hover
card into a file that is typically imported into Outlook or Google Calendar, where they become entries on a
calendar the org does not control.

The two halves disagree about what the field is. If it is sensitive enough to mask on the Leaves page, the
calendar's hover card needs `data-sentry-mask` too; and the ICS description should carry the type and the
dates, not the reason.

**Fix.** `data-sentry-mask` on the `EntryCard` reason paragraph, and drop `en.reason` from the ICS
`description`. Widen the coverage test from "these two lines in Leaves.tsx" to "every render of `.reason`".

---

## 70. Two settings panels write several policy blobs under one Save and report "Couldn't save" when half of them landed

`web/src/pages/Settings.tsx:3306-3327` (Leave policy) and `:2866-2885` (Policies)

The leave panel writes **four** independent settings keys in sequence, under one try/catch:

```ts
async function save() {
  setSaving(true);
  try {
    await saveSetting("leave_caps", { value: { carry_forward_excess: excess, carry_forward_mode: cfMode, … } });
    await saveSetting("leave_encashment", { value: { rate_basis: encRateBasis, per_day_divisor: … } });
    await saveSetting("leave_accrual", { value: { rounding } });
    await saveSetting("leave-requests", { value: { allow_backdated: allowBackdated } });
    markSaved();
    toast({ title: "Leave policy saved", variant: "success" });
  } catch (e) {
    toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
  } finally { setSaving(false); }
}
```

and the Policies panel does the same with two (`probation`, then `holidays`).

A failure on the third call leaves the first two **committed** while the toast says the save did not happen.
On this panel that is a live policy split down the middle: carry-forward caps and the encashment rate basis are
in force, accrual rounding and leave back-dating are not, and the admin has been told nothing changed. All four
feed payroll and the leave engine.

It is recoverable - `markSaved()` is skipped so the panel stays dirty, and pressing Save again rewrites the
first two idempotently - but only if the admin distrusts the message they were just given. Nothing on screen
distinguishes this from a save that did nothing.

`saveSetting` also carries an `If-Match` per key, so a retry after somebody else edited one of the four is the
409 path from finding 57, which the panels do not handle either.

**Fix.** Report which keys landed, as `ExpenseBudgets.tsx:441-447` does for its own partial batch
(`"${made} of ${lines.length} created, then it stopped: …"`), and skip the ones already written on a retry.
The same shape as findings 25, 59 and 60.

---

## 71. The "no nulls on the wire" audit, completed

`web/src/api.ts:320-331` states the rule; this is the full result of checking every place the SPA puts an
explicit `null` in a request body against `openapi.yaml` and the route's zod schema.

Thirty sites send a field as `null`. Twenty-eight are correct - the field really is `nullable: true`, and in
several cases the null is the documented way to clear it:

| Field | Verdict |
|---|---|
| `card.size` | ✔ `openapi.yaml:1964` nullable - *"Null clears the estimate - there is no empty-string form for an integer"* |
| `card.cadence` | ✔ `src/routes/cards.ts:35` `cadenceEnum.nullable().optional()` |
| `letterhead.design`, `letterhead.print_design` | ✔ both `nullable: true` |
| `leave-type.color` | ✔ `openapi.yaml:1124` *"null = auto-assigned"* |
| `goal.baseline_value` / `target_value` / `current_value` | ✔ `openapi.yaml:1775-1777`, *"Null clears it"* |
| `goal-template.unit`, `group_name` | ✔ nullable |
| `pay-component.rate`, `cap` | ✔ nullable |
| `asset.assigned_to` | ✔ nullable - *"how a PATCH returns an asset to the company"* |
| `referral.bonus_amount` | ✔ nullable |
| `notification.snooze_until_time` | ✔ nullable |
| `expense.recurrence_rule` | ✔ nullable, with the comment explaining an empty string is rejected |
| `table-view.description` | ✔ `openapi.yaml` nullable |
| `settings/holidays.pick_by`, `settings/leave_caps.*` | ✔ settings blobs, not typed resource fields |
| `Workflows` `condition` / `schedule`, `PostComposer` `layout`, `EmployeeCompensation` `rate`/`cap` | ✔ local draft state, never a request body |

Two are violations, already filed as **finding 10**: `Offers.tsx:391` `base_comp` against
`openapi.yaml:3206 { type: number }`, and `Interviews.tsx:819` `overall_rating` against
`openapi.yaml:3182 { type: number }`. One near-miss is **finding 18**: `LeaveTypes.tsx:76`
`accrual_days_per_year: Number(form.accrual)` can be `NaN`, which serialises to `null`.

Recording the negative result so this is not re-audited: the rule is followed almost everywhere, and the two
exceptions are the whole list.

---

## 72. Walking the ticket queue races its own fetches, and the drawer then acts on the wrong ticket

`web/src/pages/Tickets.tsx:784-798`, `:860`, `:1029`

The drawer fetches the full ticket whenever the opened row changes, with no cancellation:

```ts
const ticketPath = ticket?.path;
useEffect(() => {
  if (!ticketPath) { setFull(null); return; }
  setReply(""); setNewTodo(""); setError(null);
  get<Ticket>(`tickets/${idOf(ticketPath)}`).then(setFull).catch(() => setFull(latestTicket.current ?? null));
}, [ticketPath]);
```

The drawer is rendered with `siblings` and `onOpen` (`:568-571`) so the reader can walk the queue, and it
carries **no `key`** - so "next" changes `ticketPath` in place rather than remounting. Press next three times on
a slow connection and three requests are in flight with nothing saying which belongs to the ticket now on
screen; the last to resolve wins `setFull`.

That is not just a display swap, because line 860 is:

```ts
const t = full ?? ticket;
```

`t` is what the entire drawer renders **and acts on**. Every action below it takes `t.path` / `t.etag`:

```ts
<AccessAction collection="tickets" objectPath={t.path} verb={x.verb} can={can} … />   // :966
startRecording({ kind: "ticket", path: t.path, subject: t.subject });                  // :1029
```

So with a stale `full` in place, replying, changing state, reassigning, adding a to-do or attaching a screen
recording is applied to **a ticket the reader is not looking at**, under the header of the one they are.
`setReply("")` clears the compose box on every switch, so the reply itself is always freshly typed - into a
drawer that may be pointed at the wrong record.

`App.tsx:522-531` documents this exact failure for the employee profile and the fix it chose:

> *"…the nine profile tabs that load by `employeeId` through a bespoke endpoint have no cancellation flag, so
> two requests for two different people were in flight with nothing to say which answer belonged to the current
> one and the last to land won: person A's salary history beside person B's projected tax, under person B's
> name, on the surface where somebody decides a raise. … `key` makes a different person a different component
> instance."*

The ticket drawer has neither the key nor the flag.

**Fix.** A `live` latch in the effect (the pattern `Attendance.tsx:395-409` and `LeaveCalendar` already use),
or `key={ticketPath}` on the drawer - the same remedy applied to `EmployeeProfile`.

Checked and clean while here: `EmergencyQuickView.tsx:61` looked like the same shape, but both its call sites
pass a fixed id (`Profile.tsx:152` uses `me.employee_id`; `EmployeeProfile.tsx:328` sits under
`<EmployeeProfile key={route.id}>`), so the subject cannot change in place. `Attendance.tsx:1086`'s
`if (!open || days || …) return` guard would strand a previous employee's year - but `YearHeatmap` is only
ever rendered with `me.employee_id` (`:715`), so it is unreachable.

---

## 73. The interview scorecard has the same unguarded fetch, on the surface where blind scoring is the promise

`web/src/pages/Interviews.tsx:757-774`, `:307-318`, `:814-823`

`ScorecardDialog` loads the panel's feedback for the open interview, with no cancellation:

```ts
useEffect(() => {
  get<ListResponse<InterviewFeedback>>(`interview-feedback?interview=interviews/${idOf(interview.path)}&max_page_size=200`)
    .then((r) => {
      const list = r.results ?? [];
      setAll(list);
      const own = list.find((f) => f.author && idOf(f.author) === me.employee_id) ?? null;
      setMine(own);
      setEtag(own?.etag);
      if (own) setForm({ ratings: own.ratings ?? {}, overall: …, rec: …, comment: own.comment ?? "" });
    })
    .catch(() => {});
}, [interview, me.employee_id]);
```

and it is queue-navigable in place - `onOpen={setScorecardFor}` at `:317`, with no `key` on the dialog at
`:308`. So walking from one interview's scorecard to the next changes `interview` without a remount and leaves
two requests racing.

When the stale one lands last it sets four things at once:

- `setAll(list)` - the **other panelists' scorecards** for the wrong interview, which is what the blind-scoring
  toggle (`blind_scorecards`, `Settings.tsx:1048-1058`) exists to control who sees and when;
- `setForm(...)` - the reader's own ratings, recommendation and written comment from the *previous* interview,
  pre-filled under this candidate's name;
- `setMine(own)` and `setEtag(own?.etag)` - which is what `submit()` writes to:

```ts
const saved = await patch<InterviewFeedback>(`interview-feedback/${idOf(mine.path)}`, body, etag ?? mine.etag);
```

so Save patches the **previous interview's feedback record** with a body whose `interview` field names the
current one.

Same class as finding 72, and on a page whose own product rule is that four panelists' reads stay four
independent reads.

**Fix.** The `live` latch, or `key={scorecardFor.path}` on the dialog.

Worth recording: the *other* half of this shape is already right here. `scorecardFor` holds a snapshot of the
row rather than re-reading it from `rows`, so a background list refetch cannot re-run the effect and wipe a
half-written comment - which is the failure `Tickets.tsx:785-788` describes and fixes by keying on the path.
The two pages each solved one half of the same problem.

---

## Note: the queue-navigable dialog class, completed

Five dialogs let the reader walk a queue by changing the open record **in place** (no `key`, so no remount).
Each one that also fetches by id is a potential last-writer-wins race. The complete result:

| Dialog | By-id fetch on open? | Guarded? |
|---|---|---|
| `Pipeline.tsx:845-864` `ApplicationDrawer` | yes - rounds, offers, then per-round scorecards | ✔ `let live = true`, keyed on `app.path` (not the row object), clears `rounds`/`offers`/`feedback` up front, guards both setState batches, returns a cleanup |
| `components/common/SignDocumentDialog.tsx:83-95` | yes - the PDF bytes | ✔ `let live = true` + `setBytes(null)` on cleanup |
| `Tickets.tsx:784-798` | yes - the full ticket + thread | ✘ **finding 72** |
| `Interviews.tsx:757-774` `ScorecardDialog` | yes - the panel's feedback | ✘ **finding 73** |
| `Goals.tsx:1130` `GoalDrawer`, `Suggestions.tsx:396` `RespondDialog` | no by-id fetch - both render from the row already in hand | n/a |

`ApplicationDrawer` is the shape the two broken ones should copy: it is the same drawer pattern, on the same
kind of queue, in the same codebase.

---

## 74. Every money column in a custom table is hardcoded to rupees

`web/src/pages/TableBuilder.tsx:422`, `:569`

```ts
// the footer total for a money column
...(col.kind === "money" ? { aggregate: "sum" as const, formatTotal: (n: number) => formatMoney(n) } : {}),
// and the cell itself
return <span className="tabular-nums">{typeof v === "number" ? formatMoney(v) : String(v)}</span>;
```

`formatMoney`'s signature is `(value, currency = "INR", decimals?)` (`lib/utils.ts:135`), so both calls render
**₹ regardless of the org's configured currency**, with the Intl default decimal count.

The rest of the app goes through `useMoney()` (`lib/org.tsx:148-150`):

```ts
return (n, code) => (n == null ? "" : formatMoney(n, code || org.default_currency, currencyDecimals(code, org)));
```

`TableBuilder.tsx` never imports `useOrg` or `useMoney` at all. Two consequences:

1. **Wrong symbol.** An org configured in USD, AED or GBP sees every money cell and every money total in a
   custom table prefixed `₹`. Table Builder is the one surface that puts money from several collections side by
   side, so it is the place a wrong unit is hardest to notice and most likely to be exported.
2. **Wrong precision, even in INR.** `currencyDecimals` is what makes INR render in whole rupees - the comment
   on `formatMoney` says so explicitly: *"e.g. INR at 0 renders ₹1,800, not ₹1,800.00."* Passing no `decimals`
   falls back to Intl's default of 2, so the same figure reads `₹1,800` on the Payroll page and `₹1,800.00` in
   a table built over it.

The exported CSV/XLSX takes the accessor rather than the cell, so the file is unaffected - it is the on-screen
grid and its footer totals that are wrong.

**Fix.** `const money = useMoney()` in `TableBuilder`, and use it for both the cell and `formatTotal`.
`Settings.tsx:2380` shows the correct call shape (`formatMoney(1234.5, c, dpFor(c))`).

---

## 75. The employee tax panel formats every figure as rupees with Indian digit grouping, hardcoded

`web/src/components/common/EmployeeTaxDetails.tsx:20`

```ts
const inr = (n?: number | null) => (n == null ? "-" : `₹${Math.round(n).toLocaleString("en-IN")}`);
```

Used for **every** number on the panel - fifteen call sites covering monthly TDS, tax collected vs total,
prior-employer income and TDS, projected annual gross, the standard deduction, each §80 deduction, taxable
income, every slab band and its amount, the §87A rebate, surcharge and cess (`:128`-`:179`).

Two things are frozen rather than read from the org:

- **the symbol** - `₹`, regardless of `org.default_currency`, which the file already has in scope (it uses
  `org.name` on line 149);
- **the locale** - `"en-IN"`, which is lakh/crore grouping. A figure of 120000 reads `₹1,20,000` on this panel
  and `120,000` wherever `useMoney()` renders it.

`lib/org.tsx:148-150` exists precisely to give one answer here:

```ts
export function useMoney(): (n: number | null | undefined, code?: string) => string {
  const { org } = useOrg();
  return (n, code) => (n == null ? "" : formatMoney(n, code || org.default_currency, currencyDecimals(code, org)));
}
```

Same class as finding 74, on a more consequential surface: this is one of the seven panels tagged
`sentry-mask` because of what it shows, and it is the screen an employee checks to understand their own
withholding.

**Fix.** `const money = useMoney()` and replace `inr`. Keep the `Math.round` if whole units are wanted - that
is what `currencyDecimals` already expresses for INR.

Checked while here: the other `"INR"` occurrences are correct fallbacks, not hardcodes -
`Offers.tsx:330` (`offer.currency_code || org.default_currency || "INR"`), `EmployeeBankDetails.tsx:62`,
`MoneyInput.tsx:78`, `Requisitions.tsx:45` and `ReviewCycles.tsx:695` all resolve the record's or the org's
currency first.

---

## 76. The loan EMI preview uses the float-rounding form the codebase banned, so it can disagree with the deduction by a paise

`web/src/pages/Loans.tsx:247`

```ts
const emi = valid ? Math.round((amount / months) * 100) / 100 : 0;
```

The server computes the same figure with `round2` - `src/domain/loans.ts:10` and `src/services/loans.ts:109`:

```ts
const monthly = round2(row.principal / Math.max(1, row.installments));
```

`lib/utils.ts:107-121` exists because those two are not the same function:

> *"`Math.round(n * 100) / 100` multiplies in float, so a decimal half-case rounds the WRONG way
> (`1.005 * 100` is `100.4999…` → 1.00 instead of 1.01) … KEEP THIS BODY IDENTICAL to
> src/domain/money.ts#round2 - test/moneyDrift.test.ts fails when they diverge."*

and `ExpenseBudgets.tsx:455-457` names the inline form specifically as the thing not to write:

> *"`round2` (lib/utils), never an inline `Math.round(n * 100) / 100`: the inline form multiplies in float, so a
> decimal half-case rounds down where the server rounds up."*

This one is display-only - `submit()` sends `principal` and `installments`, and payroll derives the EMI - so
nothing wrong is stored. But this dialog is the single screen that tells a borrower what will come out of their
salary each month, and for a half-case principal (₹100,050 over 100 months → 1000.5) the number shown here and
the number deducted can differ.

`lib/utils.ts` already exports `round2`; `Loans.tsx` does not import it.

**Fix.** `import { round2 } from "@/lib/utils"` and `const emi = valid ? round2(amount / months) : 0;`

Minor, same file: `lastMonth` (`:250-252`) builds "recovery ends in <Month Year>" from
`new Date().getFullYear()` / `getMonth()` - the viewer's calendar rather than the org's, the same cluster as
findings 46 and 64.

---

## 77. Two write paths round the money they SAVE with the float form, including the annual CTC

`web/src/components/common/EmployeeCompensation.tsx:351`, `web/src/components/common/EmployeeBonuses.tsx:62`,
`web/src/lib/chartTheme.ts:96`

Finding 76 is display-only. These are not - the rounded value is what goes on the wire:

```ts
// EmployeeCompensation.tsx:351 - the body of the compensation create/patch
const body = {
  annual_ctc: Math.round(Number(form.ctc) * 100) / 100,
  …
};
if (editing) await patch(editing.path, body, editing.etag);

// EmployeeBonuses.tsx:62 - the body of the bonus create
await create("bonuses", { employee: …, amount: Math.round(Number(form.amount) * 100) / 100, … });
```

`Math.round(n * 100) / 100` multiplies in float, so a decimal half-case rounds the opposite way from
`round2`: `Number("1234.565") * 100` is `123456.49999…`, which floors to `1234.56` where the server's `round2`
(via the decimal-string scaling in `lib/utils.ts:122-129`) gives `1234.57`.

`EmployeeCompensation.tsx` is the file that argues this point at length in its own header, and it already
imports the right helper:

```ts
import { formatMoney, cn, idOf, round2 as r2 } from "@/lib/utils";   // :5
```

`r2` is used throughout the file for the previews - and the one number the file actually **stores** is rounded
the other way. `annual_ctc` is the figure the whole salary split is solved from (basic, Special Allowance,
employer contributions, monthly gross), so a paise lost here propagates through every derived line and through
`staleSplit`'s comparison against the stored split.

A third instance, in the file that warns against it:

```ts
// lib/chartTheme.ts:96  - monthlyTotals
values: keys.map((k) => Math.round((totals.get(k) ?? 0) * 100) / 100),
```

sixteen lines above its own comment on `topSlices`:

> *"`round2` (lib/utils), never an inline `Math.round(v * 100) / 100`: these are money totals, and a chart
> sitting beside the table that lists the same rows must not round a half-case the other way from it."*

`topSlices` uses `round2`; `monthlyTotals` in the same module does not, so the two chart builders can round the
same total differently.

The remaining inline uses are not money and are fine to leave: `LeaveTypes.tsx:108` (a per-period accrual
label), `Timesheets.tsx:145` (hours), `Attendance.tsx:1175-1176` (hours on a chart),
`leaveForecast.ts:120` (leave days).

**Fix.** `round2` at all three. `test/moneyDrift.test.ts` already pins the helper against the server's copy;
nothing pins the call sites, which is how these three drifted.

---

## 78. "What day is it" - the complete inventory

`lib/orgDay.ts` exists to give one answer, and its header says why:

> *"Twenty-odd files each defined `const todayStr = () => new Date().toISOString().slice(0, 10)`, which is the
> day in UTC - not the viewer's day and not the org's. … West of UTC … after about 19:00 local the SPA offers
> TOMORROW as today, and the server - which decides in the org's timezone - refuses the request the client's own
> `min` had just permitted."*

Every remaining place in `web/src` that asks a clock other than `orgDay` for a calendar field. Twenty sites,
in three groups.

**Wrong, and mixed with `orgDay` in the same file** - these are the ones where two answers to "today" are on
screen at once:

| Site | What it decides |
|---|---|
| `components/common/RequestLeaveDialog.tsx:31` | the Today/Tomorrow quick picks, against `min={todayStr()}` - **finding 46** |
| `pages/RemoteWork.tsx:39`, `:41` | same, plus `endOfWeek()` - **finding 46** |
| `pages/Holidays.tsx:107`, `:156`, `:626`, `:692`, `:839` | the default year, and the create form's seed year - **finding 64** |
| `pages/LeaveCalendar.tsx:562` | a day badge |

**Wrong, and the file never imports `orgDay` at all** - so no on-screen contradiction, but the answer is still
the viewer's calendar rather than the org's:

| Site | What it decides |
|---|---|
| `pages/Payslips.tsx:37`, `:48` | which slips count toward **YTD net pay and YTD tax** |
| `pages/LeaveEncashments.tsx:81` | `yearStart` for the year-to-date encashment filter |
| `pages/Loans.tsx:251` | the "recovery ends in <Month Year>" label |
| `pages/Settings.tsx:2943`, `:3006`, `:3007` | the employee-ID **preview**. Harmless as data - the server's `formatEmployeeNumber(cfg, seq, year)` takes the year as a parameter and stamps the *joining* year - but the preview therefore describes a different rule from the one that runs |

**UTC rather than the org's day** - internally consistent within each file, so lower stakes:

`pages/ExpenseBudgets.tsx:178`, `:1159`, `:1473` (the year selector and two labels, against UTC-anchored period
boundaries), `pages/PayrollRuns.tsx:614` (a "this month / last month" label that matches `defaultMonth()`'s own
UTC basis), and `lib/leaveForecast.ts` throughout (`getUTCFullYear`/`getUTCMonth`, so on 1 January before the
org's UTC offset elapses the balance forecast projects to the previous 31 December).

`Dashboard.tsx`'s instances are findings 4 and 5; `lib/complianceRecurrence.ts:23` is finding 42.

**Fix.** `todayStr()`, `thisYearStr()`, `thisMonthStr()`, `orgDayFromToday(n)` and `addDaysYmd` already cover
every one of these. The reason they keep reappearing is that nothing fails when a new `new Date().getFullYear()`
is written - a lint rule banning `new Date()` date-part getters outside `lib/orgDay.ts` and `lib/attendance.ts`
would close the class rather than this list being worked through once.

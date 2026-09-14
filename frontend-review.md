# Frontend review

Source-level review of `web/src` (391 files, ~110k lines).

Read in full: `api.ts`, `App.tsx`, `router.ts`, `useMe.ts`, `lib/getCoalescer.ts`, `lib/resourceStore.ts`,
`lib/clientStore.ts`, `lib/prefs.ts`, `lib/settingsStore.ts`, `lib/theme.ts`, `lib/tabActivity.ts`,
`lib/tablePrefs.ts`, `lib/approvals.tsx`, `lib/utils.ts`, `lib/orgDay.ts`, `lib/leaveDays.ts`,
`lib/download.ts`, `lib/exportTable.ts`, `lib/richText.tsx`, `lib/openExternal.ts`, `lib/viewAsStore.ts`,
`lib/crossTabBus.ts`, `lib/resourceRoute.ts`, `lib/formError.ts`, `lib/lazyPage.tsx`, `hooks/*`,
`components/common/DataTable.tsx`, `components/common/RequestLeaveDialog.tsx`,
`components/common/ErrorBoundary.tsx`, `components/common/dialogGuard.ts`, `components/ui/combobox.tsx`,
`components/layout/Workspace.tsx`.

Searched across every page for: date handling, money formatting, array mutation, storage access,
`JSON.parse`, index keys, `Number(input)` coercion, timers, listeners, XSS sinks.

A second pass added `instrument.ts`, `lib/scanner.ts`, `lib/photoCache.ts`, `lib/notifications.tsx`,
`lib/perm.ts`, `components/common/confirm.tsx`, `components/ui/dialog.tsx`, and targeted reads into
`pages/Reviews.tsx`, `pages/CheckIns.tsx` and `pages/Boards.tsx`.

A third added `lib/clock.tsx`, `lib/attendance.ts`, `lib/dialogHistory.ts`, the settings-save and
compensation-solver paths, and a sweep of every page for regex construction from user text, unguarded
`decodeURIComponent`, and unguarded async effects keyed on a changing id.

Not covered in depth: `Settings.tsx` beyond its save paths, `Boards.tsx` beyond its write paths, `Goals.tsx`,
`Attendance.tsx` beyond its date windows and export, `pdfSignature.ts`, the sticker / letterhead renderers.

## Verified sound

- No XSS sink. `lib/richText.tsx` renders React elements, never an HTML string; `safeHref` and the bare-URL
  alternative are both scheme-limited to `http(s)`/`mailto`; `openExternal` is `https` only. No
  `dangerouslySetInnerHTML` in the tree.
- `lib/exportTable.ts` neutralises CSV formula injection and leaves plain numbers alone.
- Date-only values are parsed and formatted UTC-anchored throughout; `lib/orgDay.ts` is the one clock and
  the pages use it.
- No in-place sorting of store-owned row arrays.
- Every `JSON.parse` of a stored value is inside a `try`.
- `lib/perm.ts`: the wildcard-verb rule (`<collection>.**`) correctly excludes the read/write/admin ladder, so
  a level grant cannot be read as a custom-method grant.
- `components/ui/dialog.tsx`: `onEnterSubmit` fires only from an `<input>` or with Cmd/Ctrl held.
- `pages/Boards.tsx`: every optimistic write adopts the server's returned row (keeping the etag current for the
  next write) and rolls back through `reload()` on failure.
- No regex is built from user text and no `decodeURIComponent` is unguarded; `lib/richText.tsx`'s one
  `new RegExp` is a static literal.
- The CTC split preview imports the server's `splitCtc` rather than mirroring it, so the previewed figure and
  the one payroll writes come from one solver.
- `lib/clock.tsx`'s session walk guards both a stuck cursor and a long one, and every caller of it passes a
  path that already carries a query string.

## Outstanding

### Settings panels save a blob without the version they read it at

`lib/settingsStore.ts` `saveSetting` takes a `version`, and its own documentation says exactly when to pass
it: *"whenever the write rebuilds a blob from a snapshot taken earlier, because the fallback below is only
honest while that snapshot is still the current one"*. Without it the write falls back to `etags.get(key)` -
the version of whatever the snapshot holds **now** - so a sibling tab's save invalidates this tab's snapshot,
`load()` refetches, the If-Match matches the *other* tab's version, the server accepts, and a panel holding a
pre-write copy writes their fields back to the old values, with a green toast and no 409 anywhere.

Every settings panel is that shape: read the blob into local state at mount, edit, PATCH the whole thing back.
Of the 25 call sites, exactly one carries the version - the organization panel (`pages/Settings.tsx:1946-1965`,
which also re-reads the version after saving so a second save from the same open panel does not take a 409 it
has not earned). The other 24 do not: attendance, ctc, overtime, professional-tax, gratuity, loan-perquisite,
payroll-approval, esign, referrals, ats, reimbursements, expenses, ticket-categories, dashboard,
employee-number, asset-tags, employee_fields, notifications, kudos, performance, transition-templates,
access-approval.

Not fixed here. It is 31 load sites plus 25 save sites across a 3848-line file, each panel shaping its state
differently, and it is a concurrency guard - half-applied is worse than absent, and the test suite cannot be
run in this sandbox to check the result. The organization panel is the worked example to copy: a
`version = useRef<string>()` set from `getSetting(...).version` at load, passed to `saveSetting`, and re-read
from a fresh `getSetting` after each successful save.

### A bar chart encodes its value in an inline style

`pages/Reviews.tsx:851`. The attainment trend draws each cycle as a bar whose height IS the number
(`style={{ height: `${Math.max(4, p.attainment)}%` }}`). Session replay records inline styles, and no text
mask reaches an attribute, so the figure is recoverable from a replay of a route that is on `SENSITIVE_PAGES`
to keep exactly that hidden. The same holds for every proportional bar drawn this way on a masked route.

Blocking the element (`data-sentry-block`) would hide the chart in replays, which is a real cost on the
surface most likely to be the subject of a bug report. Left as a judgement call rather than taken unilaterally.

### Shared check-in action items are last-write-wins

`pages/CheckIns.tsx` `saveItems` replaces the whole `action_items` array with no `If-Match`, so a manager
ticking an item while the report adds one loses whichever landed first, with a success toast on both screens.
This is a deliberate trade (quick toggles would otherwise race the store's refresh) and the comment now states
what it costs; closing it properly needs a per-item verb rather than a blob write.

### A self-back can be mistaken for a real one after 500ms

`lib/dialogHistory.ts` `selfBack`. The `selfPops` flag is lowered by whichever comes first: the popstate, or a
500ms deadline that exists because `back()` with nothing behind it fires no popstate at all. On a main thread
busy enough for the popstate to arrive after that deadline, the flag is already down and every dialog
underneath reads it as the reader pressing back - so closing a confirm over a form closes the form too. The
deadline cannot be removed (it is what stops the flag latching) and lengthening it widens a different window;
closing it properly needs the pop to be identified rather than timed.

### Every caller reads the open-session list on every page

`lib/clock.tsx` `ClockProvider` mounts `ActiveProvider` unconditionally, and its `reload` fires
`attendance?open=true` regardless of capability - the comment argues presence is org data rather than
personal. A caller without `attendance.read` gets a 403 that the `catch` swallows, so it costs one refused
request per page life and shows nothing. `useCollection` gates exactly this case with `usePermission`; this
read predates that and bypasses it.

### An exported weekday follows the viewer's locale

`pages/Attendance.tsx:523` builds the CSV's weekday column with
`toLocaleDateString(undefined, { weekday: "long" })`. `lib/utils.ts` pins `en-GB` everywhere else on the
stated ground that "one organization reads one date format"; this column is the exception, so a
French-configured browser exports `mercredi` into a sheet the rest of which is English.

### `resourceRoute` sends one collection to two destinations

`lib/resourceRoute.ts:76-82`. `projects`, `shifts` and `benefit-plans` are in both `PAGE_OF` and
`SETTINGS_PANEL`. With a `ref` they route to the Settings panel; without one, to the feature page
(`timesheets` / `schedule` / `benefits`). A link from the activity feed and a link from search therefore
land in different places for the same row. Which one is right is a product call, so it is left as one.

### Index keys on editable rows

`components/common/KudosLevelsTab.tsx:87`, `settings/BoardConfigPanel.tsx:212,256,278`,
`pages/LettersTab.tsx:440,536`, `pages/PayslipDesignTab.tsx:223`, `components/leave/RestrictionsEditor.tsx:819`.
Each is a list of rows carrying live inputs plus a remove or reorder control, keyed by array index. Removing
row *n* re-labels every row after it under the cursor and carries focus and uncommitted input state to the
neighbour. Each needs a stable id on the row model, which is a shape change per editor rather than a patch.

### An emptied number box reads as zero

`Number("")` is `0`, and several editors write that straight into the model:
`KudosLevelsTab.tsx:90` (level points), `workflows/ActionList.tsx:174,175,502,503` (delay days/hours),
`PayslipDesignTab.tsx` (block geometry, several), `StickerField.tsx:89`.
`RestrictionsEditor.tsx:239` and `LetterheadDesigner.tsx:739` already use
`trim() === "" ? undefined : Number(...)`; that is the form the rest should take. Zero is a defensible value
for some of these (a level worth no points), so each needs its own answer rather than a sweep.

## Fixed

| Where | What |
|---|---|
| `lib/prefs.ts` | `apply()` claimed the snapshot memo when it ran before the first `readPref`, so `GET /v1/preferences` was never issued for that page life. Reachable on a cold load of any workspace route whose page mounts no prefs reader (`org-chart`, `leave-calendar`, `announcements`, `team-analytics`, `recruiting-analytics`, `team-goals`): `Workspace`'s effects run before App's. Early writes are staged and overlaid onto the fetched rows instead. |
| `lib/prefs.ts` | `writePref` left a deferred timer armed for the same key, so the older staged value could land on top of it. The timer is cleared. |
| `components/leave/RestrictionsEditor.tsx` | The advance-notice ladder committed and re-sorted per keystroke over positional rows, so the row under the caret became a different band mid-edit; and the rows were indexed into the unsorted stored array while `noticeBands` sorts its own copy. Edits now index the sorted list and the length commits on blur or Enter, with an emptied box leaving the band alone. |
| `components/common/DataTable.tsx` | `useRef(loadLocalPrefs(tableId))` re-read `localStorage` and re-parsed JSON on every render of every table. Read once. |
| `components/common/DataTable.tsx` | Applying a saved view with no captured `search` cleared the page's search box; it now only clears when the view says so. |
| `router.ts` | The unsaved-changes guard and the scroll handler are separate listeners on one `hashchange`, so cancelling the prompt still scrolled the dirty form to the top. The guard now marks the rejection and the scroll handler skips it. The restore uses `replaceState`, so cancelling a Back no longer leaves a stray forward entry. |
| `router.ts` | `setRouteRecord` on a tab-less `#/settings` wrote the id into the tab segment. It declines when there is nothing to anchor the record to. |
| `components/common/EmployeeCompensation.tsx` | The CTC change percentage divided by the current CTC unguarded, printing `Infinity%` when it is zero. The rupee delta stands; the percentage is dropped. |
| `lib/resourceStore.ts` | `loadMoreRows` returned an unrelated in-flight read instead of fetching, and `useCollection({ all: true })` only re-fires on `hasMore`/row-count changes - so a revalidation landing between pages stopped the walk. It now waits and then fetches. |
| `lib/clientStore.ts` | Boot hydration issued one IndexedDB `get` per stored record, sequentially inside one transaction. One `getAll`, filtered to this identity's keys. |
| `components/ui/combobox.tsx` | The highlight was not clamped when the option list shrank for a reason other than typing, so `aria-activedescendant` dropped and Enter did nothing. |
| `components/common/RequestLeaveDialog.tsx` | The merged-policy cache was keyed by leave-type path alone, so an edit to a type's restrictions left the dialog previewing the old policy. Keyed by the restrictions blob too. |
| `useMe.ts` | `useRealMe` reads once on mount and is correct only because starting or stopping a simulation reloads the page. Stated at the hook. |
| `components/common/confirm.tsx` | A destructive prompt withholds `autoFocus` "so nobody deletes by reflex", then accepted a bare Enter from anywhere outside a button as confirm. Destructive prompts are now answered by pressing a button, the standard `ui/dialog.tsx` already holds `onEnterSubmit` to. |
| `lib/photoCache.ts` | `cache.clear()` / `cache.delete()` discarded the `Entry` objects mounted avatars had subscribed to, so after a store purge the batch settled with nobody to notify and faces stayed on initials. Entries with subscribers are now reset in place and notified; unsubscribed ones are still dropped. |
| `instrument.ts` | `beforeSend` scrubbed only the message and exception values. It now also covers `event.request.url` / `query_string` (the hash carries DataTable's filter state and `?q=`) and every context string - which is where `reportProblemToSentry` puts the reporter's own free text. |
| `pages/Reviews.tsx` | Two `title` attributes carried values on a route that is masked to hide them (a rating, a goal share). A title is never masked (`maskAttributes: []`), so the values moved into text the route mask covers. |
| `lib/scanner.ts` | The read loop checked its teardown flag only before the decode await, so a code held in frame as the scanner closed still fired `onScan` - a stocktake sighting against a dismissed count. `decodeFiles` also leaked the `ImageBitmap` when a decode threw. |
| `pages/CheckIns.tsx` | `reschedule` and `setCadence` sent no `If-Match` while three neighbours in the same file do and say why. Both now guard. |
| `instrument.ts` | The `\d{9,18}` account rule redacted 13-digit epoch milliseconds, so `changes?since=…` and the analytics window reads came through as `[account]` in every breadcrumb. Excluded in the `since`/`from`/`to`/`at`/`until` parameter position only. |
| `lib/notifications.tsx` | The "already reminded" Set grew for the life of the tab. Bounded at 500, oldest first. |
| `lib/attendance.ts` | `leftEarly` was true while a session was still open: `departure` is the last CLOSED punch, so someone back from lunch had a mid-day "departure" judged against the shift end. Every on-screen consumer happens to check `open` first, but the CSV export's "early by" column did not. Guarded at the source. |
| `lib/dialogHistory.ts` | A dialog buried when it closed returned without dropping its `pushedOver` address, so the map kept one href per such opening for the life of the tab. |
| `lib/dialogHistory.ts` | The URL-correcting `popstate` listener was `{ once: true }` with no deadline, so when `back()` fired no popstate (nothing behind it) it stayed registered and rewrote the address on the reader's next real navigation. Detached on a timer as well, like `selfBack`'s own flag. |

## Verification

- `tsc --noEmit -p web/tsconfig.json` - clean.
- `eslint web/src --max-warnings 0` - clean.
- `vitest` cannot run in this sandbox: `@cloudflare/vitest-pool-workers` reads `.dev.vars`, which is denied
  (`EPERM`). The suites worth running are `resourceStoreCache`, `leaveRestrictions`, `webReadDiscipline`,
  `webFetchDiscipline`, `bankFormats`.
- By hand: hard-load `#/org-chart` and confirm a `GET /v1/preferences` goes out, then navigate to `#/employees`
  and confirm saved views are present. Type `12` into a notice band that has a larger band under it and
  confirm the caret stays on the band being edited. Dirty a Settings panel, navigate away, cancel - the page
  must not scroll and Back must not land on the route just declined.

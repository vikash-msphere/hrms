# Frontend review - live findings (part 3)

Continues `issues-new.md` (findings 1-32) and `issues-frontend-new.md` (findings 33-75). Numbering carries on
so cross-references stay valid.

---

## 76. `LeaveEncashments` reads the whole `leave-balances` collection one page at a time and treats a missing row as a zero balance, so HR cannot file an encashment for anyone outside that window

**Where.** `web/src/pages/LeaveEncashments.tsx:38-41`, `:73-79`, `:124`, `:138`.

```ts
const { rows, state, error, reload } = useCollection<LeaveEncashment>(COL);
const { rows: employees } = useCollection<Employee>("employees", { all: true });
const { rows: leaveTypes } = useCollection<LeaveType>("leave-types");
const { rows: balances } = useCollection<LeaveBalance>("leave-balances");     // <- one page, unfiltered
```

Only `employees` walks its cursor. `leave-balances` has one row **per employee per leave type**, so a
200-person org with five types is a thousand rows and the page holds the newest hundred of them.

**The lookup fails closed, on a money form.**

```ts
const balanceFor = (empRef: string, typeRef: string): number => {
  const b = balances.find((x) => x.employee && x.leave_type && idOf(x.employee) === idOf(empRef) && idOf(x.leave_type) === idOf(typeRef));
  return b?.balance_days ?? 0;
};
const selectedBalance = form.employee && form.leave_type ? balanceFor(form.employee, form.leave_type) : null;
```

`?? 0` cannot tell "this person has no days left" from "this person's balance row is not in the window". The
consequences chain straight into the submit gate:

```ts
const maxEncashable = selectedBalance == null ? null : Math.max(0, Math.min(selectedBalance - retained, capLeft ?? Infinity));
...
const canSubmit = !!form.employee && !!form.leave_type && !!form.days && daysNum > 0 && (maxEncashable == null || daysNum <= maxEncashable);
```

An off-window balance gives `selectedBalance = 0` (not `null`), so `maxEncashable` computes to `0` and
`canSubmit` is false for any positive number of days. HR picks an employee, the dialog states their balance as
**0 days**, and the Encash button will not enable - for an employee who has a full balance the server would
happily pay out. Nothing on screen distinguishes this from a genuinely exhausted balance.

Note the asymmetry the code already has for the *other* unknown, two blocks down (`:121-124`):

> *"Until the policy is known, say nothing about the cap rather than mis-state it ... and let the server's
> `failedPrecondition` be the authority, rather than blocking on a number known to be for the wrong policy."*

`capLeft` is `null` when the policy is unknown and correctly drops out of the `Math.min`. The balance takes the
opposite posture for the same class of unknown: it asserts zero and blocks.

**The year-to-date cap check is windowed too.** `encashedThisYear` (`:105-114`) folds over `rows` - one page of
`leave-encashments`, org-wide and newest-first:

```ts
return rows
  .filter((r) => r.employee && r.leave_type && idOf(r.employee) === idOf(form.employee)
    && (cumulative || idOf(r.leave_type) === idOf(form.leave_type)))
  .filter((r) => ["APPROVED", "PAID"].includes(upper(r.state)) && (r.create_time ?? "") >= yearStart)
  .reduce((n, r) => n + (r.days || 0), 0);
```

An employee's January payout drops out of the window as other people file through the year, so `capLeft` grows
back and the form invites a request the server refuses. The comment above it is careful about **which states**
to count - *"APPROVED and PAID only ... Counting PENDING too shrank the remaining cap by days the server has
not charged against it"* - and is exactly right about the states while counting the wrong set of rows.

The strip totals go the same way: `approvedUnpaid` (`:142`) and `paidThisYear` (`:143`) are sums over one page,
and `lastRate` (`:129-136`) picks "the most recent known day-rate" from whatever prior encashments happen to
be loaded.

**There is no truncation affordance anywhere on the page** - no `TruncationNotice`, and the balance figure is
shown as plain guidance text rather than through `DataTable`'s `autoHasMore` line.

**The server already offers the narrowing.** `src/routes/leaveBalances.ts:11-17` passes
`c.req.query("employee")` into `listLeaveBalances`, so one employee's balances are a single scoped read - the
same `?employee=` pattern every profile panel in `components/common` uses (`EmployeeBonuses.tsx:44`,
`EmployeeCompensation.tsx:134`, `EmployeeRoleHistory.tsx:39`, `EmployeeAssets.tsx:64`).

**And another page reads this exact collection correctly, with the reasoning written out.**
`web/src/pages/EmployeeProfile.tsx:108-110`:

```ts
// This person's balances, narrowed server-side. Filtering a page of the whole collection in the browser was
// both dearer and blind to anything past the cursor.
const { rows: balances } = useCollection<LeaveBalance>("leave-balances", { params: { employee: `employees/${id}` } });
```

with the same treatment applied to that page's leave requests two blocks below (`:129`). So the fix below is
not a new pattern - it is the one the sibling page already carries, verbatim.

**Fix.**

1. Read balances for the selected employee only, when one is selected:
   `get<{ results: LeaveBalance[] }>('leave-balances?employee=' + encodeURIComponent(form.employee))`, or
   `useCollection("leave-balances", { params: { employee: form.employee }, enabled: !!form.employee })`.
2. Make the miss honest: `balanceFor` should return `null` when no row is found, and `maxEncashable` should
   treat `null` the way it already treats an unknown cap - no client-side block, let the server decide.
3. Scope the year-to-date fold the same way (`leave-encashments?employee=...`), so the cap is measured against
   that employee's whole year rather than against a page of everybody's.

Same family as finding 50 (`RequestLeaveDialog`'s `?? 0` on a missing balance row blocking a valid leave
request); here the blocked request is a payout and the blocked user is HR.

---

## 77. `Referrals` prints two money totals and a "bonus owed" queue over one page of referrals, on a card list with no truncation affordance

**Where.** `web/src/pages/Referrals.tsx:85`, `:184-208`, `:233`.

```ts
const { rows, state, error, reload } = useCollection<Referral>("referrals");     // <- one page
const { rows: employees } = useCollection<Employee>("employees", { all: true });
const { rows: departments } = useCollection<Department>("departments", { all: true });
const { rows: candidates, reload: reloadCandidates } = useCollection<Candidate>("candidates", { enabled: rows.length > 0, all: true });
```

Three of the four reads walk their cursor; the collection the page is **about** does not. `items` is
`[...rows].sort(...)` (`:115`), so every number below is a fold over the newest hundred referrals the caller
can see, and the page renders cards (`shown.map`, `:233`) rather than a `DataTable` - so it does not get
`DataTable.tsx:564`'s automatic *"Showing 1-100 of 100+ — first page only"* line either. There is no
`TruncationNotice` on the page.

What the strip asserts (`:184-208`):

| tile | value | hint |
|---|---|---|
| Referrals | `items.length` | *"every referral"* |
| Yours | `items.filter(mine).length` | *"you referred these"* |
| In progress | count | *"in the funnel"* |
| Not in pipeline | `items.filter(notInPipeline).length` | *"nobody screened these"* |
| Hired or joined | count | *"referrals that stuck"* |
| **Bonus owed** | `items.filter(bonusDue).length` | **sum of `bonus_amount`, formatted as money** |
| **Bonuses paid** | count | **sum of `bonus_amount`, formatted as money** |

The first tile's hint is *"every referral"* over a page size. The last two are currency figures - the money
the company owes its own employees for referrals, and the money it has paid - each summed over whatever
happens to be in the window:

```ts
hint: (() => { const s = items.filter(bonusDue).reduce((t, r) => t + (r.bonus_amount ?? 0), 0); return s ? money(s) : "award it on the row"; })(),
```

Because the collection is ordered newest-first, the referrals that age out are the **older** ones - which is
exactly where an unpaid bonus that nobody has chased lives. `bonusDue` is defined as *"a hire whose bonus
nobody awarded"* (`:121-122`); the queue it builds is systematically missing the oldest members of the class it
exists to find, and "Bonus owed" under-reports both the count and the rupee figure with no indication that it
is a partial view.

`notInPipeline` has the same shape and one extra dependency: it is
`r.status === "submitted" && !inPipeline.has(idOf(r.path))`, where `inPipeline` comes from the `candidates`
read - which **is** `{ all: true }`. So the two halves of that predicate are measured over different row sets.

**Fix.** `useCollection<Referral>("referrals", { all: true })`, matching the three reads beside it, plus a
`<TruncationNotice collection="referrals" what="referrals" />` above the strip for the residual `ALL_CAP`
case - the treatment `ProjectsAdmin.tsx:40`/`:107` and `BenefitPlansAdmin.tsx:46` already apply to card-list
pages, and the same conclusion as findings 61, 72, 74 and 75.

---

## 78. "Interviews today" is bucketed with `toDateString()` in the viewer's timezone, in three places, so a cross-timezone panelist is shown the wrong day's slots

**Where.** `web/src/pages/Interviews.tsx:113-114` and `:269`, and `web/src/pages/Dashboard.tsx:629-632`.

```ts
// Interviews.tsx:113-114
const isToday = (i: Interview) =>
  i.status === "scheduled" && !!i.scheduled_start_time && new Date(i.scheduled_start_time).toDateString() === new Date().toDateString();
```

```tsx
{/* Interviews.tsx:269 - the same expression again, inlined on the row rather than calling isToday */}
{i.status === "scheduled" && i.scheduled_start_time && new Date(i.scheduled_start_time).toDateString() === new Date().toDateString() && (
  <Badge variant="warning">Today</Badge>
)}
```

```ts
// Dashboard.tsx:629-632
const interviewsToday = useMemo(() => {
  const t = new Date().toDateString();
  return upcomingInterviews.filter((i) => i.scheduled_start_time && new Date(i.scheduled_start_time).toDateString() === t).length;
}, [upcomingInterviews]);
```

`scheduled_start_time` is an instant; `Date.prototype.toDateString()` renders it in the **browser's** timezone.
Interviewing is the one workflow in the product that routinely crosses zones - remote panelists, offshore
candidates - and the org's day is what everything else in the app (and the server) means by "today".

**What goes wrong.** Org in IST, panelist in London. A slot at 01:00 IST on 18 March is the instant
`2026-03-17T19:30Z`. On the evening of 17 March in London, `new Date()` and the slot both render as
`Thu Mar 17`, so:

- `isToday` is **true** and the slot is counted in the **"interviews today"** KPI (`:117`, label
  *"interviews today"*) and given a warning **Today** badge, for a slot the org calls tomorrow.
- The Dashboard's *"how many fall on today (for the hint)"* count says the same thing on a different page.
- Running the other way, a panelist west of the org misses slots that are today for the org and reads them as
  tomorrow, so the day's queue appears empty.

**It also corrupts the neighbouring predicate.** `isPastDue` (`:115-116`) is otherwise correct - it compares
instant to instant - but ends with `&& !isToday(i)`:

```ts
const isPastDue = (i: Interview) =>
  i.status === "scheduled" && !!i.scheduled_start_time && i.scheduled_start_time < new Date().toISOString() && !isToday(i);
```

so the viewer's zone decides whether a slot that has already passed counts as *"interviews still open past
their slot"* (`:121`) - the queue whose whole point is finding the scorecard nobody filled in.

**And the row badge duplicates the predicate instead of calling it**, so `isToday` and the badge can already
drift; only `isToday` is used by the KPI and by `isPastDue`.

**Fix.** Bucket the instant on the org's clock, the way `lib/orgDay.ts:56-58` already provides:

```ts
const isToday = (i: Interview) =>
  i.status === "scheduled" && !!i.scheduled_start_time && orgDayOf(i.scheduled_start_time) === todayStr();
```

and have `:269` call `isToday(i)` rather than restating it. `Dashboard.tsx:630-631` takes the same
substitution. Note `orgDayOf` currently has no callers anywhere in the SPA - see finding 59, where the same
helper is the fix for the payslip year buckets, and finding 73 for the rest of this family.

---

## 79. Turning four-eyes approval ON asks for confirmation; turning it OFF does not - the direction that removes the control is the one-click one

**Where.** `web/src/components/common/PermissionsPanel.tsx:65-75`, against the checkbox at `:447-450`.

```ts
async function setFourEyesEnabled(enabled: boolean) {
  if (enabled && !(await confirm({ title: "Require a second approver for permission changes?", description: "...", confirmLabel: "Turn on" }))) return;
  try {
    await saveSetting("access-approval", { value: { enabled } });
    setFourEyes(enabled);
    toast({ title: enabled ? "Permission changes now need a second approver" : "Permission changes apply immediately again", variant: "success" });
```

```tsx
<Checkbox checked={fourEyes} onCheckedChange={(v) => void setFourEyesEnabled(v === true)} /> Require a second approver
```

The guard is `if (enabled && ...)`. Unticking the box writes `{ enabled: false }` on the click, with no prompt
- and that write disables, org-wide, the control described by `src/services/accessRules.ts:72-75`:

> *"Four-eyes on permission changes: opt-in per org via the `access-approval` settings blob. While it is on,
> every rule write becomes a PENDING row instead of an active one (see the `status` column), and a SECOND
> access admin has to approve it."*

So the click that **adds** a second pair of eyes is confirmed, and the click that **removes** them is not. The
off direction is the one an attacker with one compromised access-admin session would take first: untick, then
grant themselves whatever they like, with every subsequent rule write going live immediately
(`approvalRequired` at `:76-79` is consulted per write, so the change takes effect on the very next grant).

This is the case the repo's own convention covers - a consequential action reached in one click should ask
first (`lib/confirmDecision.ts`, used three functions above this one at `:76-82` for approving a single
pending rule). A rule-level approve gets a confirmation; switching the whole mechanism off does not.

**Scope of the claim, checked:** the pending queue does *not* disappear when the flag goes off - `pendingCard`
renders on `pending.length > 0 || fourEyes !== null` (`:437`) and lists rows by `status` rather than by the
flag (`:436`), so changes already waiting stay visible and decidable. The defect is the missing confirmation,
not a hidden queue.

**Fix.** Confirm both directions, with the off-prompt naming what stops:

```ts
async function setFourEyesEnabled(enabled: boolean) {
  const ok = enabled
    ? await confirm({ title: "Require a second approver for permission changes?", description: "...", confirmLabel: "Turn on" })
    : await confirm({
        title: "Stop requiring a second approver?",
        description: "Every access-rule change will take effect immediately, with no second admin reviewing it. Changes already waiting stay in the queue until someone decides them.",
        destructive: true,
        confirmLabel: "Turn off",
      });
  if (!ok) return;
  ...
```

---

## 80. A named candidate's offered salary is recorded by session replay on three ATS surfaces, while the scorecard next to it is masked

**Where.** `web/src/pages/Offers.tsx:246`, `web/src/pages/CandidateProfile.tsx:213`,
`web/src/pages/Pipeline.tsx:424` and `:1095`; against `web/src/instrument.ts:53-71`.

The Offers page is a table with one row per **named candidate** and the money offered to them:

```tsx
<td className="px-3 py-2">
  ...<button ... onClick={() => navigate(`candidates/${idOf(candFor(o.application)!.path)}`)}>{l.cand}</button>
  <div className="text-xs text-muted-foreground">{l.job}</div>
</td>
<td data-label="Comp" className="px-3 py-2 tabular-nums">{money(o.base_comp, o.currency_code)}</td>
```

The same figure appears beside the same name on the candidate profile (`CandidateProfile.tsx:213`) and on the
pipeline board - both in the card's `title` tooltip and in the drawer (`Pipeline.tsx:424`, `:1095`).

None of `offers`, `candidates` or `pipeline` is in `SENSITIVE_PAGES` (`instrument.ts:53-71`), none of these
three files contains `sentry-mask`, and the field-name rules at `:114-120` cover `account`/`ifsc`/`pan`/
`aadhaar`/`uan` and deliberately **not** money (`:125-129`). With `maskAllText: false` (`:94`) the figures and
the names are recorded verbatim.

**This is inside the bar the file sets for itself.** The test at `instrument.ts:44-52` is that the values be
*"something the app itself PROMISED would not be read by a bystander"*, and the list already masks
`payroll-runs` on exactly this shape:

> *"payroll-runs, // the same, per employee, for a whole company"* - i.e. a table of pay figures with names
> around them.

An offers table is that table, for people who are not employees yet. It is also the more negotiation-sensitive
version: two candidates' figures side by side is precisely the comparison an offer is confidential to prevent,
and `Offers.tsx:435` states what the number is - *"this is the number payroll will run"*.

**And the ATS is already treated as confidential everywhere else.** The interview scorecard carries the tag,
with the reasoning spelled out (`Interviews.tsx:868-874`):

> *"A scorecard is a panelist's private read on a candidate, held back from the rest of the panel until theirs
> is in - so it is masked in session replay ... test/replayMaskCoverage.test.ts holds this one to it too."*

So a panelist's opinion of a candidate is masked and the candidate's salary is not.

**Fix.** Either is consistent with the file's own posture; the second is cheaper to keep correct:

1. Add `offers` to `SENSITIVE_PAGES` - the `unmask` list (`:154-170`) keeps headings, `th`, tabs, buttons and
   errors readable, so the page stays legible in a replay while the figures go. `candidates` and `pipeline`
   are mostly names and stages rather than values, so they do not meet the bar as whole routes.
2. Or tag the figure where it is rendered: `data-sentry-mask` on the `<td>` at `Offers.tsx:246`, on the
   `<span>` at `CandidateProfile.tsx:213` and `Pipeline.tsx:1095`, and drop `o.base_comp` out of the
   `title=` at `Pipeline.tsx:424` (a `title` attribute is not masked - `maskAttributes: []` at `:150`).

Whichever is chosen, add an assertion to `test/replayMaskCoverage.test.ts` beside the interview-scorecard one,
for the reason that file already gives: per-surface tagging *"means someone has to remember, which is exactly
the kind of thing that gets forgotten in a refactor and fails SILENTLY"*.

Same family as findings 70 (the signature image) and 71 (blood group, allergies, medical notes), and findings
43/44/54.

---

## 81. Seven profile reads use the raw `get()` list form, which asks the server for 50 rows and throws the cursor away - the fix for exactly this is twenty lines below one of them

**The mechanism.** `web/src/api.ts` has two list shapes and they behave differently:

```ts
// api.ts:398 - list()
const params = new URLSearchParams({ max_page_size: String(Math.min(opts.max ?? 100, 100)) });
```

```ts
// api.ts:516 - get()
export function get<T>(path: string): Promise<T> {
  return coalescedGet<T>(path);
}
```

`get()` sends the path verbatim. With no `max_page_size`, the server applies its default:

```ts
// src/http/pagination.ts:41
export const clampPageSize = (n?: number) => Math.min(Math.max(n ?? 50, 1), 100);
```

**50 rows, not 100** - and the response's `next_page_token` is dropped on the floor, because the call site
destructures only `{ results }`. So a `get<{ results: T[] }>("collection?filter=…")` is a silent 50-row window,
half the size of the one a `useCollection` read of the same collection would get, and with none of
`useCollection`'s `hasMore` to report it.

**The call sites.** All of these hit paginated `collectionRoutes` (`src/routes/bonuses.ts:51`,
`positions.ts:20`, `assetRequests.ts:31`, and the compensation/settlements equivalents):

| file:line | read | what it feeds |
|---|---|---|
| `components/common/EmployeeCompensation.tsx:134` | `compensation?employee=` | the revision timeline, `deltaByPath` change chips, and `neighbours()` - the date bounds a correction is clamped to (`:296-301`) |
| `components/common/EmployeeCompensation.tsx:137` | `bonuses?employee=` | `variableFy.total` (`:265-278`) - a **summed money figure** rendered as "FY 2026-27" total compensation |
| `components/common/MyCompensation.tsx:35` | `compensation?employee=` | the employee's own salary history |
| `components/common/EmployeeBonuses.tsx:44` | `bonuses?employee=` | the bonus list and its totals |
| `components/common/EmployeeRoleHistory.tsx:39` | `positions?employee=` | the role/promotion timeline |
| `components/common/EmployeeSettlement.tsx:38` | `settlements?employee=` | prior settlements for a leaver |
| `components/common/EmployeeAssets.tsx:64`, `:69` | `assets?employee=`, `asset-requests?employee=` | the kit list and the request queue |

Because every collection is keyset-ordered newest-first, what falls off is always the **oldest** end - which on
a compensation or role-history timeline is the joining salary and the first promotion, i.e. the part a reader
opens a history for. Nothing on any of these panels says a row is missing.

**The same file already fixed this, and wrote down the exact number.** `EmployeeAssets.tsx:99-104`, twenty
lines below the two raw reads at `:64` and `:69`:

```ts
// ASKED OF THE SERVER, and walked to the end. Filtering `assets` in the browser answered "what is in
// stock?" with "whichever of the 50 newest assets are in stock" - and recently-added kit is the kit most
// likely to have been handed out, so a register holding plenty of spare hardware routinely told HR
// "Nothing in stock. Add stock on the Assets page", which sends them to buy what they already own.
const seq = ++reqSeq.current;
getAllPages<Asset>("assets?status=in_stock", 500)
  .then((r) => {
    ...
    setPoolCropped(r.truncated);
```

That is the whole fix, with the truncation surfaced (`poolCropped`) and a stale-response guard
(`reqSeq`). `api.ts:496-514` `getAllPages` exists for this and is already used by `Timesheets.tsx:118`
and `:255` for the analogous per-person read.

**Fix.** Replace each of the seven with `getAllPages<T>(path, cap)` and render the `truncated` flag the way
`EmployeeAssets` renders `poolCropped` - or, where the panel is genuinely small, at minimum append
`&max_page_size=100` so the request asks for what the server will actually give. The current form asks for
half the available page and then discards the server's own statement that there is more.

Note `PayrollRuns.tsx:147`/`:179` (`payroll-runs/<id>/items`) and `BankFormats.tsx:104`/`:107` also use the raw
`get<{ results }>` form but are **not** affected: `src/routes/payrollRuns.ts:94` -> `listRunItems`
(`src/services/payroll.ts:100-115`) returns every item with no pagination, and the bank-format and
payroll-debit routes return their whole map (`src/routes/payrollDebit.ts:16`). Those two are correct as
written.

---

## 82. `AssetCustodyDialog` binds the condition note and the "why you can't scan it" justification to the same state, so both boxes are on screen editing one value - and the no-scan gate is satisfied by the wrong one

**Where.** `web/src/components/assets/AssetCustody.tsx:62` (the single `note` state), `:119`, `:189`, and
`:193-197`.

Two different fields, one state:

```tsx
{/* :189 - rendered unconditionally, in the two-column grid */}
<Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. scratch on the lid" /></Field>
```

```tsx
{/* :193-197 - the escape hatch, rendered as well whenever override is on */}
{allowManual && !belongsHere && (
  override ? (
    <Field label="Why you can't scan it" hint="Recorded on the asset's history as a confirmation without a scan.">
      <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. sticker peeled off; serial checked by hand" />
    </Field>
  ) : ( ... )
)}
```

Nothing gates the first field on `!override`, so once the reader presses **"The sticker is missing or
unreadable"** both controls are visible at once, bound to the same `note`. Typing in either one rewrites the
other in place, and the two ask for different things - the physical condition of the item versus the reason it
could not be scanned. Whichever was typed last is the only one that survives; there is one value on the wire
(`:104-107`), so the other is simply lost.

**And the audit gate reads the shared value:**

```ts
const ready = belongsHere || (override && !!note.trim());
```

So the sequence *type "scratch on the lid" into Note (optional)* → *press "The sticker is missing or
unreadable"* leaves **Confirm already enabled**, with the justification textarea pre-filled with a sentence
about a scratch. No reason for skipping the scan has been given, and the reader has no prompt to give one -
the box already looks filled in.

**Why that matters more than an ordinary form bug.** Scanning is the whole point of this dialog
(`:17-21`):

> *"The scan is not a formality - the payload travels to the server, which matches it against the secret
> printed inside that asset's QR, so a confirmation cannot be produced by anyone who is not holding the
> thing."*

The override is the one documented way past that, and the server does insist on something being written -
`src/services/assets.ts:195`:

```ts
if (!input.note?.trim()) throw invalidArgument("a note is required when confirming without a scan");
```

- but it can only check that the field is non-empty. The client is what decides *what* lands in it, and the
client lets an unrelated condition note satisfy the check. The `verified_scanned` flag and every stocktake
"scanned" count are the claims the feature exists to make (`src/services/assets.ts:178-180`); the audit trail
that explains an unscanned confirmation is the compensating control, and it can be filled with a sentence
about a scratch that the person never intended as a justification.

`allowManual` defaults to `mode === "verify"` (`:46`), so this is the admin check-into-stock path; the
employee's own `:acknowledge` does not offer the hatch and is unaffected.

**Fix.** Give the justification its own state and stop rendering the two together:

```tsx
const [note, setNote] = useState("");        // condition note
const [reason, setReason] = useState("");    // why it could not be scanned
...
const ready = belongsHere || (override && !!reason.trim());
...
await invoke(asset.path, mode, undefined, {
  ...(scan.trim() ? { scan: scan.trim() } : { override: true }),
  condition,
  ...(note.trim() || reason.trim() ? { note: [reason.trim(), note.trim()].filter(Boolean).join(" · ") } : {}),
});
```

- one wire field still, but composed from two labelled inputs rather than from one box wearing two labels, and
the gate now measures the thing it claims to measure.

**Also worth fixing while there.** `manual` (`:60`, the "Or type the tag / scan into this box" input at
`:171-177`) is only applied on **Enter** (`onKeyDown`). A reader who types a tag and reaches for Confirm
instead of pressing Enter has typed into a box that is discarded - `scan` is still empty, so `belongsHere`
stays false and the button stays disabled with the tag visibly in the field. Apply it on blur as well, or
validate `manual` into `belongsHere` directly.

---

## 83. `BulkAddAssets` keeps the whole delivery in the form after a part of it has been created, and the toast tells the reader to press Add again - which creates the landed assets a second time

**Where.** `web/src/components/assets/BulkAddAssets.tsx:82-117`.

```ts
const calls: Record<string, unknown>[][] =
  mode === "quantity"
    ? batchSizes(form.quantity, PER_CALL).map((n) => [{ ...shared, quantity: n }])
    : chunkList(rows.map((r) => ({ ...shared, ...(r.name ? { name: r.name } : {}), serial_number: r.serial })), PER_CALL);

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

`PER_CALL` is 100, so any delivery over a hundred is several calls, and the loop stops at the first failure -
deliberately, per `:90-91`: *"Sequential on purpose - a failure stops the run rather than leaving an unknown
half of it created."*

**But nothing narrows the form to what is left.** The comment says *"with the rest of the list still in the
box"*; what is actually still in the box is the **whole** list. `form.text` is untouched and `form.quantity`
is untouched, so:

- **Serials mode:** 250 laptops, the third call fails. 200 assets exist, each tagged and stickered. The
  textarea still holds all 250 serials and the submit button still reads **"Add 250 assets"**. Pressing it -
  which the toast explicitly asks for (*"fix the message below and add them"*) - re-sends the first 200
  alongside the rest.
- **Quantity mode:** 120 adapters, the second call fails. 100 exist; `form.quantity` is still 120. The retry
  creates 120 more, for 220 rows and 220 stickers to print.

**The server does not stop it.** `batchCreateAssets` (`src/services/assets.ts:358-366`) dedupes only *within
one call*:

```ts
// The same serial twice in one paste is the same machine entered twice - the mistake this form makes easiest,
// and the one worth refusing rather than recording.
const seen = new Set<string>();
for (const d of drafts) {
  const key = d.serialNumber?.toLowerCase();
  if (!key) continue;
  if (seen.has(key)) throw invalidArgument(`serial number ${d.serialNumber} appears more than once`);
  seen.add(key);
}
```

There is no check against serials already stored - and correctly so, since the file notes elsewhere that *"two
vendors genuinely repeat labels"*. So the duplicates are accepted and each gets its own fresh asset tag from
the run allocator, which is exactly the state the inventory cannot recover from by itself: two identical rows,
two different tags, two stickers, and nothing on either row saying which is the phantom.

**The sibling bulk form does this correctly and explains why.**
`web/src/components/holidays/BulkAddDialog.tsx:73-79`:

```ts
// Leave the failures in the box so they can be fixed and re-submitted; drop what succeeded. The WHOLE
// draft is written back, in the comma form the parser reads flags from: a rewrite that carried only the
// date and the name turned every re-submitted row into `kind: "fixed"` ...
setText(failed.map((f) => toLine(f.draft)).join("\n"));
```

Same dialog shape, same partial-failure path, and it rewrites the box to the remainder.

**Fix.** On the catch path, replace the form's list with what has not been created yet, before rethrowing:

```ts
} catch (e) {
  if (created.length) {
    onCreated(created);
    if (mode === "serials") {
      const done = new Set(created.map((a) => (a.serial_number ?? "").trim().toLowerCase()));
      set("text", rows.filter((r) => !done.has(r.serial!.trim().toLowerCase())).map(toLine).join("\n"));
    } else {
      set("quantity", Math.max(0, form.quantity - created.length));
    }
    toast({ variant: "destructive", title: `${created.length} of ${total} added`, description: "The rest are still in the box - fix the message below and add them." });
  }
  throw e;
}
```

Then the toast's instruction is true, and pressing Add again adds only what is missing.

---

## 84. `Attendance` filters one org-wide page of correction requests down to "mine", so an approver's own history and the duplicate-correction guard both go quiet exactly for the people who use the page most

**Where.** `web/src/pages/Attendance.tsx:157`, `:164-173`, `:1041`, `:1808-1809`.

```ts
const { rows: regularizations, reload: reloadRegs } = useCollection<AttendanceRegularization>("attendance-regularizations");
const rosterTruncated = useCollectionHasMore(["employees", "leave-requests"]);
...
// My correction requests (attendance-regularizations), newest first, so pending + decided are visible in one place.
const myRegs = useMemo(
  () => regularizations.filter((r) => mine(r.employee)).sort(...),
  [regularizations, mine],
);
// Days already waiting on a decision, so the correction dialog can say so before a second request is filed.
const pendingCorrectionDays = useMemo(
  () => myRegs.filter((r) => upper(r.state) === "PENDING" && r.date).map((r) => r.date!),
  [myRegs],
);
```

One unfiltered page, then a client-side filter to the caller's own rows. **Whose rows come back depends on the
caller's grant**: an ordinary employee is scoped to their own by the server, so their hundred rows are a
hundred of theirs. An approver - HR, a manager, anyone holding
`attendance-regularizations.approve` (`:148`) - gets everybody's, newest-first, and their own corrections are
a handful of older rows competing with the whole org's for a hundred slots.

**What that breaks, for approvers only:**

1. **"My correction requests"** (`:164-168`) renders empty or partial. A manager who filed a correction three
   weeks ago sees no trace of it on the page that is supposed to show *"pending + decided ... in one place"*.
2. **The duplicate guard stops firing.** `pendingCorrectionDays` feeds `CorrectionDialog`'s `pendingDays`,
   documented at `:1808-1809` as *"Days that already carry a pending correction - filing a second one for the
   same day is almost never meant."* With their own pending rows outside the window the list is empty, the
   warning never shows, and the second request is filed - the outcome the prop exists to prevent. (See also
   finding 64d: `submitCorrection`'s `filedThisDialog` ledger does not stop a concurrent duplicate either.)
3. **`cancelReg` (`:174`) cannot reach** a request that is not in the window, so an approver cannot withdraw
   their own older correction from this page at all.

**And nothing says so.** `rosterTruncated` on the very next line (`:158`) surfaces truncation for `employees`
and `leave-requests` - so the page knows how to admit a window - but `attendance-regularizations` is not in
that list, and the "My requests" section has no `TruncationNotice` of its own.

**Fix.** The server's list hook takes a state filter but not an employee one
(`src/routes/attendanceRegularizations.ts:34-37` - *"Row visibility was decided in middleware ... `?state`
narrows it further"*), so there are two useful moves and they compose:

- **The guard** only needs pending rows: read them with `{ params: { state: "PENDING" } }`. Pending
  corrections org-wide are a small fraction of all of them, so the window stops hiding the caller's own.
- **The history list** wants the caller's own rows whatever their state. Either add `employee` to that list
  hook - the same `?employee=` narrowing `leave-balances`, `bonuses`, `compensation`, `positions` and
  `assets` already have (`src/routes/leaveBalances.ts:16`, and see finding 76) - or pass `{ all: true }` and
  add `"attendance-regularizations"` to the `useCollectionHasMore` call at `:158` so the section admits the
  cap.

Same shape as finding 69 (`EmployeeDocuments` filtering the shared `personal-documents` page down to one
employee) - a shared collection narrowed in the browser instead of on the server.

---

## 85. The `boards` collection is read one page deep everywhere, so past a hundred boards a deep link silently opens the wrong board and the per-board settings panel says the board "is no longer available"

**Where.** `web/src/pages/Boards.tsx:372`, `:387-399`, `:433-438`; `web/src/settings/BoardConfigPanel.tsx:26-32`.

```ts
// Boards.tsx:372
const { rows: boards, state, error, reload } = useCollection<Board>("boards");
```

No `{ all: true }`, no cursor walk, no `TruncationNotice` - while the **cards** on the same page get a
deliberate 500-row walk two lines below (`CARD_FETCH_CAP`, `:369`, `:383-385`). Three consumers read `boards`
as if it were complete.

### 1. A deep link to a board past the window opens a different board

```ts
const valid = (id: string | null | undefined) => (id && boards.some((b) => idOf(b.path) === id) ? id : null);
const fromUrl = valid(route.query.board);
if (fromUrl && fromUrl !== selectedId) { setSelectedId(fromUrl); return; }
if (valid(selectedId)) return;
...
setSelectedId(fromUrl ?? valid(lastKey ? readLocal(lastKey) : null) ?? idOf(boards[0]!.path));
```

`valid()` answers "is this board in the loaded page", but the comment above it says what it is meant to
answer - *"Falls back to the first board whenever the current choice stops being valid (**deleted, access
lost**)"*. A board that is merely off-window is neither, and it is treated as both: `?board=<id>` from a
shared link resolves to `null`, the remembered board resolves to `null` too, and the reader lands on
`boards[0]` - **somebody else's board, silently, with the URL still naming theirs**. There is no error and no
hint; the page simply shows a different board than the link asked for.

The board switcher at `:433-438` has the same ceiling - `boards.map(...)` lists only the loaded page, so the
board cannot be picked by hand either.

### 2. The per-board settings panel reports a live board as gone

`settings/BoardConfigPanel.tsx:21-32`:

```ts
// ... Reads the board from the shared boards cache (no extra fetch: the Boards page already loaded it) ...
export function BoardConfigPanel({ objectPath, onClose }: { objectPath: string; onClose?: () => void }) {
  const { rows, state } = useCollection<Board>("boards");
  const board = rows.find((b) => b.path === objectPath);
  if (!board) {
    return state === "loading" ? (
      <PanelSkeleton />
    ) : (
      <p className="py-10 text-center text-sm text-muted-foreground">This board is no longer available.</p>
    );
  }
```

The panel is opened from the gear **on that board's own page**, so `objectPath` names a board the reader is
looking at at that moment. Resolving it by scanning a windowed list turns "not in the first hundred" into
**"This board is no longer available."** - a flat, confident statement about a board that exists, is open
behind the sheet, and the caller can read. The same panel is reachable by deep link
(`#/boards?setting=board-config`), with the same outcome.

Its premise - *"no extra fetch: the Boards page already loaded it"* - is the assumption that fails: the Boards
page loaded **a page of** it.

**Fix.**

- `BoardConfigPanel`: resolve the object directly. It already has the path, so `get<Board>(objectPath)` is one
  indexed read and cannot be wrong - and it makes the panel work when it is opened from a deep link without
  the Boards page ever having mounted. Keep the cache for the save path, which already refreshes through it.
- `Boards.tsx:372`: `{ all: true }` (the collection is a catalogue that every consumer on the page treats as
  complete - the switcher, `valid()`, and `boards.find` at `:418`), plus a `TruncationNotice` for the residual
  `ALL_CAP`. If the walk is unwanted, `valid()` must at least stop conflating "off-window" with "deleted":
  when `hasMore` is true and the id is not found, keep the requested id and load rather than falling through
  to `boards[0]`.

---

## 86. `Candidates`' search box filters the loaded page in the browser, on the collection where "find the person from last quarter" is the whole job - and the shared server-side text filter it should use already exists

**Where.** `web/src/pages/Candidates.tsx:45`, `:89-99`.

```ts
const { rows, state, error, reload } = useCollection<Candidate>("candidates");   // one page
...
const items = useMemo(() => {
  const sorted = [...rows].sort((a, b) => (b.create_time ?? "").localeCompare(a.create_time ?? ""));
  const needle = q.trim().toLowerCase();
  const matched = !needle
    ? sorted
    : sorted.filter((c) =>
        [c.name, c.email, c.phone, c.tags, sourceLabel(c.source), c.source_detail].filter(Boolean).join(" ").toLowerCase().includes(needle),
      );
  return kf.apply(matched);
}, [rows, q, kf.focus]);
```

A `String.includes` over the hundred rows the store happens to hold. Candidate pools are the archetype of a
collection that outgrows a page and stays useful afterwards - a recruiter's normal question is about somebody
who applied months ago, which is precisely who is *not* in a newest-first window.

**The project already ruled on this, in a comment on the same problem.** `pages/Directory.tsx:250-253`:

> *"It runs on the SERVER (`?q=`, FTS-backed), because a list page caps at 100 rows: filtering here would only
> ever search the slice already loaded, so anyone past the first page was unfindable."*

and Directory passes `q: debouncedQ` into `useCollection` (`:261`). The server half is a shared helper with
the same note - `src/services/searchFilter.ts:8-10`:

> *"Why it exists: a list page caps at 100 rows and the client filters what it holds, so filtering a large
> collection client-side searches a window. Pushing the text match to the server searches the whole
> collection - and via FTS rather than a LIKE scan."*

Ten services already use it (`employees`, `tickets`, `expenses`, `leave-requests`, `remote-work-requests`,
`overtime-requests`, `reimbursements`, `announcements`, `asset-requests`, `api-keys`).

**And the candidate rows are already in the index.** `src/domain/searchIndex.ts:161` registers
`{ collection: "candidates", table: schema.candidates, scoping: scoped("code"), ... }`, so ⌘K global search
finds a candidate from two years ago that this page's own search box cannot. The two searches over the same
data disagree, and the weaker one is the one on the page built for it.

The page does carry `<TruncationNotice collection={["candidates", "applications"]} what="candidates" />`
(`:129`), but that sentence is about the *list*; a search box that returns nothing reads as "no such
candidate", not as "not in the loaded page".

**Fix.** `src/routes/candidates.ts` has no `list:` hook reading `q` - add one in the shape every sibling route
uses (`c.req.query("q")` threaded into the service and AND-ed via `searchFilter`), then the page becomes:

```ts
const debouncedQ = useDebounced(q, 250);
const { rows, state, error, reload } = useCollection<Candidate>("candidates", { q: debouncedQ });
```

`useCollection` already takes `q` and keys the store on it (`hooks/useCollection.ts:19-33`), so nothing else
on the page changes. Until the route accepts it, the box should say what it searches rather than implying the
pool.

The same check is worth running over the other on-page search boxes that filter `rows` locally on collections
with no `?q=` route support.

---

## 87. Two links inside the payroll-policy panel use a server path instead of a hash route, so they reload the whole SPA, land on the dashboard, and raise a browser "Leave site?" prompt over the unsaved form they sit in

**Where.** `web/src/pages/Settings.tsx:789` and `:807`.

```tsx
<p className="text-sm text-muted-foreground">How an entered CTC splits into pay. ... The employer contributions
themselves (gratuity, employer PF/ESI, or any you add) are <a href="/pay-components" className="underline">pay
components</a> of kind "employer contribution" - configured there, not here ...</p>
```

```tsx
<p className="text-xs text-muted-foreground">Which allowances count is per component: tick "Counts as PF wages"
on each one in <a href="/pay-components" className="underline">pay components</a>. ...</p>
```

**The app is a hash router.** `web/src/router.ts:6` reads the route out of `window.location.hash`
(`window.location.hash.replace(/^#\/?/, "")`), and every other in-app anchor in the SPA is written that way -
`components/layout/Sidebar.tsx:315`, `:376`, `components/layout/TopBar.tsx:89`, `pages/Boards.tsx:1695`,
`lib/richText.tsx:263` - with 68 further jumps going through `navigate()`. These two are the only
`href="/..."` links in the SPA.

**What the browser does with them.** `/pay-components` is not a worker-owned prefix and does not look like a
file, so `src/index.ts:387-402` serves the shell:

```ts
// A client-side route: serve the shell and let the SPA router take it from here.
const shell = await c.env.ASSETS.fetch(new URL("/index.html", c.req.url));
```

That is a **full document load**, and the URL it loads carries no hash - so the SPA boots, reads an empty
hash, and renders its default route. Three consequences, in order of how annoying they are:

1. **It does not go where it says.** The reader presses a link labelled "pay components" and arrives at the
   dashboard. The route exists (`pay-components` is a real route key, `App.tsx:210`), so the correct link is
   one character different.
2. **It is a cold start.** The whole bundle is re-parsed, the bootstrap prefetch re-runs and the settings
   snapshot is re-read - for what every other link in the app does as an in-page hash change.
3. **It can lose unsaved work, behind a browser dialog.** Both links sit *inside* the payroll-policy panel,
   which is a draft form: `useUnsaved(ctc, ready, saveCtc)` (`Settings.tsx:767`) registers with
   `reportUnsaved`, and `router.ts:69-71` turns that into a `beforeunload` guard:

   ```ts
   window.addEventListener("beforeunload", (e) => {
     if (dirtyForms.size > 0) e.preventDefault();
   });
   ```

   So an admin who has edited "Basic % of CTC" or the PF-wages selector and then clicks the explanatory link in
   the paragraph above it gets a native **"Leave site? Changes you made may not be saved"** dialog - and
   confirming discards the edits and drops them on the dashboard. The in-app guard at `router.ts:15-19`
   (*"Any hash navigation that would unmount a panel ... asks for confirmation first"*) is the one designed for
   this, with a proper Discard/Keep editing dialog, and a document navigation never reaches it.

**Fix.** `href="#/pay-components"` in both places - or, to keep the settings context, `#/settings/pay-components`
(the panel key is registered at `settings/registry.ts:68`), which opens it as a settings panel rather than as a
full page. Either way the router's own unsaved-changes guard handles the dirty form instead of the browser's.

---

## 88. Saving a new org timezone (or shift, or working days) leaves the whole SPA running on the old one until a full page reload - the two readers that hydrate it are both one-shot

**Where.** `web/src/pages/Settings.tsx:1235-1259` (`AttendanceTab`), against `web/src/lib/orgDay.ts:24-50` and
`web/src/lib/clock.tsx:88-98`.

`AttendanceTab` is where the org's timezone, shift start/end, grace, full/half-day minutes and working days are
edited. Its save is a plain settings write:

```ts
async function save() {
  setSaving(true);
  try {
    await saveSetting("attendance", { value: cfg });
    markSaved();
    toast({ title: "Attendance schedule saved" });
  } catch (e) {
    toast(saveSettingError(e));
  } finally { setSaving(false); }
}
```

**Nothing in the running SPA re-reads it.** There are exactly two places that push this setting into the
module state everything else consults, and both run once per page load:

```ts
// lib/orgDay.ts:24-25, 41-50 - memoised forever, and never cleared
let orgTz: string = DEFAULT_SCHEDULE.timezone;
let hydrating: Promise<void> | null = null;
export function hydrateOrgTimezone(): Promise<void> {
  hydrating ??= readSetting<{ timezone?: string }>("attendance")
    .then((cfg) => setOrgTimezone(cfg?.timezone))
    .catch(() => { /* not configured ... the default stands */ });
  return hydrating;
}
```

called once at bootstrap (`App.tsx:385`, `void hydrateOrgTimezone()`), and:

```ts
// lib/clock.tsx:88-98 - a mount-only effect, deps []
useEffect(() => {
  getSetting<Partial<AttendanceSchedule>>("attendance")
    .then((cfg) => {
      if (!cfg.value) return;
      setSched({ ...DEFAULT_SCHEDULE, ...cfg.value });
      // The same read answers "what day is it for this org" for the whole SPA (lib/orgDay.ts). Handing it
      // over here means the two can never disagree about the timezone, and costs nothing.
      setOrgTimezone(cfg.value.timezone);
    })
    .catch(() => { /* not configured -> defaults */ });
}, []);
```

`saveSetting` does invalidate the settings snapshot (`lib/settingsStore.ts:274-277`), so the *next* read would
see the new value - but `hydrating ??=` is already settled and the clock effect's dependency array is empty, so
no next read happens. `orgTz` and `sched` keep the pre-save values for the rest of the session.

**What that costs.** `orgTz` is the input to every org-day decision in the SPA - `todayStr`, `thisMonthStr`,
`thisYearStr`, `orgDayFromToday`, `orgDayOf` (`lib/orgDay.ts:52-67`) - which is the module whose own header
says why that must not drift from the server:

> *"In IST the two disagree between midnight and 05:30 local, so a date input defaulted to yesterday and
> 'starts today' read as 'upcoming' for the first five and a half hours of every day. West of UTC it goes the
> other way and is worse: after about 19:00 local the SPA offers TOMORROW as today, and the server - which
> decides in the org's timezone (services/orgDay.ts) - refuses the request the client's own `min` had just
> permitted."*

After the save the server is on the new zone immediately (it reads the setting per request) and the client is
not, so that is precisely the state the org is left in - for the admin who just changed it and for every other
open tab, with a green **"Attendance schedule saved"** and nothing on screen suggesting a reload is needed.

`sched` is the same story for the rest of the blob: the TopBar clock chip, the Attendance page's late/early
flags, `workingDaysInRange`, and `Overtime.tsx`'s punch-derived suggestion (`:157-165`, which reads
`sched.shift_end` and `sched.timezone`) all keep scoring against the old shift and the old working days.

**Fix.** Make the two readers refreshable and call them from the save:

- Export a `rehydrateOrgTimezone()` that clears `hydrating` before re-reading (or simply
  `setOrgTimezone(cfg.timezone)` from `AttendanceTab.save()` - the value is right there in `cfg`).
- Give `useClock` a way to adopt a new schedule - either subscribe its effect to settings invalidations
  (`subscribeInvalidations` already fires for `settings`, `lib/settingsStore.ts:276`) or expose a
  `setSched` the settings panel calls on success.

The cheapest correct version is one line in `save()` before the toast - `setOrgTimezone(cfg.timezone)` - plus
wiring the clock's effect to re-run on a settings invalidation, so a second admin's change reaches this tab too.

---

## 89. `useOrgBlob` merges into a snapshot taken at mount, and `saveSetting`'s own `await load()` refreshes the etag underneath it - so a sibling tab's change to the org blob is reverted without a conflict

**Where.** `web/src/pages/Settings.tsx:1935-1962`, against `web/src/lib/settingsStore.ts:237-265`.

Four panels edit slices of the one `settings/organization` blob through this hook - `QuickActionsTab`
(`:1969`), `OrgIdentityPanel` (`:2176`), `OrgBanksPanel` (`:2438`) and `OrgLetterDefaultsPanel` (`:2518`):

```ts
function useOrgBlob(toast: Toast) {
  const { reload } = useOrg();
  const [blob, setBlob] = useState<Partial<OrgSettings> | null>(null);
  ...
  useEffect(() => {
    getSetting<Partial<OrgSettings>>("organization")
      .then((s) => setBlob(s.value ?? {}))
      .catch(() => setBlob({}));
  }, []);                                   // <- read once, at mount, never refreshed
  async function save(slice: Record<string, unknown>, savedTitle: string): Promise<boolean> {
    ...
    const value = { ...(blob ?? {}), ...slice };     // <- the whole blob, rebuilt from that snapshot
    await saveSetting("organization", { value });
```

A whole-blob read-modify-write is fine **as long as the version guard catches a snapshot that has gone stale**,
and `settingsStore.ts:239-245` says that is exactly what it is for:

> *"Every panel edits a config blob and PATCHes the whole blob back, so a write that carries no version is not
> 'last write wins' over one field - it is one admin's entire ticket-category list, or kudos ladder, or
> dashboard layout, replacing another's with no sign anything was lost. Sending the snapshot's `If-Match` puts
> the version in the server's UPDATE ... WHERE, so the DB refuses the second write and the caller gets a 409."*

**But the etag is re-read at save time, not held from the read the panel's `blob` came from:**

```ts
export async function saveSetting(key: string, body: { value: unknown }): Promise<void> {
  await load(); // ensures the snapshot - and so the etag - is the one this session read
  try {
    await patch(`settings/${key}`, body, etags.get(key));
```

The comment is true only while the snapshot is intact. Any settings write invalidates it -
`invalidateSettings()` sets `loaded = null` and `dropDisk()` "clears the etags too" (`:268-272`) - and that
invalidation crosses tabs: `api.ts` calls `broadcastInvalidation` after every write
(`resourceStore.ts:747-749`), which publishes over the shared `BroadcastChannel` (`lib/crossTabBus.ts`), and
the receiving tab runs `invalidateCollections` (`resourceStore.ts:742-744`) -> `invalidateSettings`
(`settingsStore.ts:274-277`).

So in a second tab of the same browser:

1. Tab A opens **Banks & currency**; `useOrgBlob` snapshots `organization` as it is now.
2. Tab B saves **Name & branding** - a different slice of the same blob. The write invalidates A's settings
   snapshot over the bus.
3. Tab A presses Save. `saveSetting` calls `await load()`, which refetches because the snapshot was dropped,
   so `etags.get("organization")` is now **B's new version**. The `If-Match` matches, the server accepts, and
   `{ ...blob, ...slice }` - built from step 1 - writes B's branding fields back to their old values.

A gets a green *"Banks saved"*. B's change is gone, with no 409 and nothing on either screen. The guard fires
correctly for a writer on a **different machine** (no bus, no invalidation, stale etag, 409 and the
"Somebody else changed this" toast) - which is why this reads as working; it is the same-browser case the
broadcast quietly defeats.

The same hazard exists for two org-blob panels mounted at once, since each `useOrgBlob()` call is its own hook
instance with its own frozen `blob`.

**Fix.** Either keep the version the value came from, or stop rebuilding the whole blob from a frozen copy:

- **Hold the etag with the snapshot.** Have `getSetting`/`readSetting` hand back the version the value was read
  at, and let `saveSetting` take it as an argument instead of looking one up at write time. Then a refreshed
  snapshot no longer launders a stale value into a valid-looking write, and step 3 becomes the 409 the design
  intends.
- **Or re-read on invalidation.** Subscribe `useOrgBlob`'s effect to settings invalidations
  (`subscribeInvalidations` is already imported by `settingsStore`) so `blob` follows the store, and warn the
  panel's `useUnsaved` baseline that it moved.

The first is the real fix: it restores the property the comment claims, for every panel and every key, rather
than for one hook.

---

## 90. Removing an employee identity field is an unconfirmed row deletion that hides - but does not delete - every employee's stored PAN/Aadhaar, orphans their uploaded proof documents, and re-adopts the values if a field with the same slug is ever added back

**Where.** `web/src/pages/Settings.tsx:3573-3612` (`FieldsTab`), against
`src/services/identityDetails.ts:27-34`, `:105-123`.

```ts
const remove = (i: number) => setFields((fs) => fs.filter((_, idx) => idx !== i));
```

```tsx
<Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => remove(i)} aria-label="Remove field">
  <Trash2 className="h-4 w-4" />
</Button>
```

No confirmation, no count of how many employees hold a value for the field, and no statement of what happens to
the data - on the panel whose own description says these fields are *"the identity details collected for each
employee (e.g. PAN, Aadhaar, UAN)"* and which marks them **sensitive**. The row vanishes; `Save format`
commits it.

**What actually happens to the data.** The field list is the only thing that makes a stored value visible:

```ts
// identityDetails.ts:73-88 - the wire view is driven entirely by the current config
function toView(defs: FieldDef[], values: Record<string, string>, attachedSlots: Set<string>) {
  return { fields: defs.map((f) => { const raw = values[f.key]; ... }) };
}
```

so the moment the field leaves the config every employee's value stops being shown, edited or cleared through
the UI. It is **not** removed. The only pruning is lazy, and it happens per employee, on the next write to
*that* employee's identity details:

```ts
// identityDetails.ts:121-123
// Drop values for fields that no longer exist in the config.
const known = new Set(defs.map((f) => f.key));
for (const k of Object.keys(next)) if (!known.has(k)) delete next[k];
```

Removing the field is precisely the change that stops anyone opening that form, so for almost every employee
that write never comes. The value stays in the encrypted blob and stays readable server-side -
`readIdentityValues` (`:66-69`) is documented as being for *"trusted back-office use (e.g. statutory report
files)"* and reads the raw map, not the configured fields. "We stopped collecting Aadhaar" and "we no longer
hold anyone's Aadhaar" are not the same thing, and the panel implies the first means the second.

**The uploaded proofs are not pruned at all.** Each field can carry a supporting document in the slot
`identity:<key>` (`identityDetails.ts:71-72`, `:91-95`). The pruning loop above touches only the values map;
nothing deletes or re-homes the attachments, so a removed field leaves every employee's scanned identity
document on the shelf, attached to a slot no surface renders.

**And the key is re-derived from the label, so the values come back.** `save()` computes
`key: f.key || slug(f.label)` (`:3596`). Delete the "Aadhaar" row, save; later add a field labelled "Aadhaar"
- the slug is `aadhaar` again, `toView` finds the old values still in the blob for every employee who has not
had their identity details re-saved in between, and they reappear, masked but present, with `has_value: true`.
A field removed for a retention reason is one relabel away from being restored.

**The sibling panel in the same file shows what the guard looks like.** Removing an ATS stage is refused
server-side, with the blocking rows named (`src/routes/settings.ts:439-455`):

> *"these stages still hold active applications and cannot be removed: ... Move those candidates to another
> stage first."*

There is no equivalent for `employee_fields`; `validateSettingValue` has no case for it, and nothing counts
stored values before the write.

**Fix.**

- **Ask, with the number.** Before removing a row, confirm through `useConfirm` and say how many employees
  hold a value - the count is one server-side query, the same shape `stagesInUse` already does for stages.
  Make it `destructive` and say plainly whether the values are being kept or deleted.
- **Decide what removal means, and do it.** Either purge on config write (sweep the removed key out of every
  employee's blob and delete the `identity:<key>` attachments, in the same request), or keep the values and say
  so in the confirm - but do not leave "hidden, retained, and resurrectable on a matching slug" as the
  undocumented behaviour of a Trash icon.
- **Guard the server side** the way the ATS key does, so an API key or an import cannot drop a field with live
  values silently either.

---

## 91. A candidate who applied more than once loses their interviews and offers from the profile entirely - the multi-application fallback reads two whole collections one page deep and the sections simply vanish

**Where.** `web/src/pages/CandidateProfile.tsx:71-79`, `:97-101`, `:180`, `:204`.

The page is otherwise a model of the right shape - `useResource` for the candidate, a server-narrowed
`applications` read, and `useResource` for the referral, each with a comment saying why. The interviews and
offers reads are the one place it falls back:

```ts
const soleApp = myApps.length === 1 ? myApps[0]!.path : undefined; // already a `applications/<token>` ref
const { rows: interviews } = useCollection<Interview>("interviews", {
  enabled: myApps.length > 0,
  params: soleApp ? { application: soleApp } : {},
});
const { rows: offers } = useCollection<Offer>("offers", {
  enabled: myApps.length > 0,
  params: soleApp ? { application: soleApp } : {},
});
```

with the trade stated at `:67-70`:

> *"Interviews and offers hang off an APPLICATION, and the overwhelmingly common case is a candidate with one -
> so narrow to it server-side. With several applications there is no one-shot filter for "any of these", so the
> page reads the collections and matches."*

The strategy is acknowledged; what is not is that "reads the collections" means **one page** of each, org-wide
and newest-first. For a candidate with two or more applications:

```ts
const myInterviews = useMemo(() => interviews.filter((i) => i.application && appIds.has(idOf(i.application)))...);
const myOffers = useMemo(() => offers.filter((o) => o.application && appIds.has(idOf(o.application))), [offers, appIds]);
```

their rounds only appear if they happen to be among the newest hundred interviews **the whole org** has
scheduled. A re-applicant's earlier round almost never is.

**And the sections do not degrade - they disappear.** Both are gated on a non-empty result (`:180`, `:204`):

```tsx
{myInterviews.length > 0 && ( ... )}
{myOffers.length > 0 && ( ... )}
```

so there is no empty state, no "nothing loaded" hint, and no `TruncationNotice` anywhere on the page. A
recruiter opening the profile of somebody who applied last year and again this month sees a candidate with no
interview history and no offer history - which is the same thing the page shows for a candidate who has never
been interviewed. The page's own opening comment names this exact failure for the collection it *did* fix:

> *"That was both expensive and quietly wrong: a candidate whose application sat past the first page of
> `applications` rendered as having none."*

The knock-on at `:231-233` follows: the "open the employee this offer created" button keys off
`myOffers.some((o) => o.created_employee)`, so for a multi-application candidate who was hired on the earlier
application, the link to their employee record is gone too.

**Fix.** The fallback only needs to stop being a window. Three options, cheapest first:

1. `{ all: true }` on both reads when `soleApp` is undefined - the walk is bounded by `ALL_CAP` and only runs
   for the uncommon multi-application case:
   ```ts
   const { rows: interviews } = useCollection<Interview>("interviews", {
     enabled: myApps.length > 0,
     ...(soleApp ? { params: { application: soleApp } } : { all: true }),
   });
   ```
2. Read once per application and merge - `myApps.length` is small by construction, and each read is
   server-narrowed exactly like the single-application path.
3. Let the `application` filter take a list server-side, which removes the special case altogether.

Whichever is chosen, render the sections with an empty state rather than hiding them, so "no interviews" is a
statement the page makes rather than an absence the reader has to interpret.

---

## 92. On the leave calendar, the remote-work layer and the day panel's events are read one page deep - on the same grid where the leave read was given `{ all: true }` for exactly that reason

**Where.** `web/src/pages/LeaveCalendar.tsx:131-146`.

Three grid-window reads sit on consecutive lines, and only one of them walks its cursor:

```ts
// `all: true`, not `max: 500`: the server caps a page at 100 whatever is asked for, so a busy month's
// calendar silently drew only part of itself. The read is already narrowed to the grid's own window.
const { rows: leaves, state: leavesState, reload: reloadLeaves } = useCollection<LeaveRequest>("leave-requests", {
  all: true,
  params: { from: range.from, to: range.to },
});
const { rows: leaveTypes } = useCollection<LeaveType>("leave-types");
const { rows: holidays } = useCollection<Holiday>("holidays", { all: true });
// Org events show in the SELECTED day's panel and nowhere else on the calendar, so a month nobody has
// clicked into reads none of them.
const { rows: events } = useCollection<Event>("events", { enabled: !!selected });
const { rows: remoteRows } = useCollection<RemoteWorkRequest>("remote-work-requests", {
  enabled: showRemote,
  params: { from: range.from, to: range.to },
});
```

### The remote-work layer

`remoteRows` carries the **same** `params: { from, to }` window as `leaves` and none of the `all: true` that
the comment three lines above says the window alone is not enough for. It feeds the grid the same way
(`:236`):

```ts
if (showRemote && typeFilter === "all") for (const r of remoteRows) push(r, "remote");
```

So in a month with more than a hundred remote-work requests - a plausible month for any org that works hybrid,
which is the only kind of org that turns this layer on - the calendar draws part of the remote layer and all of
the leave layer, with no visible difference between "nobody was remote" and "not loaded". That is verbatim the
failure the line above was fixed for: *"a busy month's calendar silently drew only part of itself"*.

### The day panel's events

`events` is read with **no window at all** - no `params`, no `all` - and then filtered per day (`:270-272`):

```ts
events.filter((ev) => ev.start_time.slice(0, 10) <= ymd && ev.end_time.slice(0, 10) >= ymd && (ev.attendees ?? []).some((a) => inDept(idOf(a))))
```

One page of the whole `events` collection, newest-first, filtered down to one day. Clicking into any day older
than the newest hundred events shows no events for it. `eventsOn(selected)` feeds the day panel at `:665`,
which renders nothing when the list is empty - so the panel says the day is clear.

The lazy gating (`enabled: !!selected`) is right and should stay; what is missing is the window. The `events`
collection is date-ranged like the other two, so the fix is the same shape as its neighbours rather than a
cursor walk over the whole collection.

**Fix.**

```ts
const { rows: events } = useCollection<Event>("events", {
  enabled: !!selected,
  all: true,
  params: { from: range.from, to: range.to },   // if the route takes them; otherwise all: true alone
});
const { rows: remoteRows } = useCollection<RemoteWorkRequest>("remote-work-requests", {
  enabled: showRemote,
  all: true,
  params: { from: range.from, to: range.to },
});
```

Everything else on this page is already careful about exactly this - `employees`/`departments`/`holidays` all
pass `{ all: true }`, `employeesTruncated` surfaces the residual cap (`:146`), and the headcount denominator is
taken from a server aggregate rather than counted from loaded rows (*"An aggregate, because counting loaded
employee rows counts one page, not the org"*, `:163-171`). These two reads are the pair that was missed.

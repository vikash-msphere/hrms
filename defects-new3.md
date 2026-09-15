# Pre-production review - new findings (eighth pass)

Continues [defects.md](defects.md) (1-24), [defects-new.md](defects-new.md) (25-28) and
[defects-new2.md](defects-new2.md) (29-31). Same rules: no gates run, no docs read, every claim traced to the
file and line that proves it, and each consequence reproduced rather than asserted.

- [32](#32-settings-keys-that-feed-money-and-date-arithmetic-have-no-write-validator) 21 settings keys are read by the server with no write validator; a cleared numeric field silently zeroes overtime pay and collapses probation to zero days
- [33](#33-the-liveness-rule-is-enforced-on-the-audience-arm-and-nowhere-else-notify-notifymanager-and-resolveassignee-all-still-target-people-who-cannot-sign-in) `notify`, `notifyManager` and `resolveAssignee` never apply `liveEmployee()`, so approval nudges and offboarding tasks land on people whose login is switched off
- [34](#34-two-byte-streaming-verbs-are-in-neither-audit-registry-the-sick-note-behind-a-leave-request-and-a-ticket-attachment) `leave-requests:download` (the sick note) and `tickets:attachment` are in neither audit registry: no sensitive-read row, and the read is filed as a write
- [35](#35-onpurge-has-no-callers-so-a-hard-purge-orphans-every-attachment-the-r2-object-and-its-metadata-row-both-survive-the-record) `onPurge` has no callers: a hard purge leaves every attachment's R2 object and its filename-bearing metadata row behind, with no sweeper
- [36](#36-a-view-as-simulation-reads-pii-the-real-callers-own-grant-forbids-and-the-audit-row-is-suppressed-because-the-simulation-makes-it-look-like-self-access) **A view-as simulation reads PII the real caller's grant forbids, and suppresses the sensitive-read audit row** - the audit half is live today
- [Retraction](#retraction-finding-21-was-wrong) **finding 21 was wrong** and is struck, plus a spot-checked status of the earlier findings against the current working tree (the retraction sits between #35 and #36 in the body)

---

## 32. Settings keys that feed money and date arithmetic have no write validator

**Files:** `src/routes/settings.ts:400-432` (`SETTING_VALIDATORS`), `src/services/settings.ts:38-47`
(`getSettingValue`), `src/domain/payroll.ts:63-71` (`overtimePay`),
`src/services/employees.ts:62-64,144-147`

`routes/settings.ts` records that this exact gap was already found once, and closed it for two keys:

> **THE STATUTORY KEYS BELONG HERE, and their absence was the gap:** `tax-config` and `professional-tax` are
> the two keys that decide what the state takes out of somebody's pay, and neither was validated while six keys
> with far less at stake were. `upsertSetting` **writes any JSON to any key**, and `getSettingValue` merges it
> over the default shallowly - so the only place a partial statutory blob can be caught is here, before it is
> stored.

Eleven keys now have a validator. Cross-checking every key the server actually reads
(`getSettingValue(deps, "<key>", ...)`) against that map leaves **21 with none**:

```
access-approval  access-review  attachments  employee-number  employee_fields  expenses
holidays  kudos  leave-requests  leave_accrual  leave_encashment  loan-perquisite
notifications  overtime  payroll-approval  performance  probation  referrals
reimbursements  ticket-categories  transition-templates
```

The mechanism the comment names is literally one line:

```ts
// services/settings.ts:42
return { ...fallback, ...(JSON.parse(row.value) as object) };
```

A **shallow** spread, so a stored `null` or a stored string does not fall back to the typed default - it
**replaces** it. Several of the 21 keys feed arithmetic. I ran the real helpers against mistyped values rather
than assuming, and most of the config turns out accidentally robust: `encashmentRatePerDay`'s
`divisor > 0 ? divisor : 30` rejects a string and falls back, and `competencyScore`'s `Math.max(0, c.weight || 0)`
degrades to an unweighted mean. **Two do not**, and both fail silently.

### Verified 1: `overtime`, where the failing value is "the admin cleared the field"

```ts
// domain/payroll.ts:65-71
const hourly = cfg.rate_per_hour && cfg.rate_per_hour > 0
  ? cfg.rate_per_hour
  : (cfg.hours_per_month > 0 ? basePay / cfg.hours_per_month : 0) * (cfg.multiplier || 1);
return round2((minutes / 60) * hourly);
```

Run against the shipped default (`multiplier: 2`, `hours_per_month: 200`), 10 hours of overtime on a 50,000
base:

```
good                      -> 5000
hours_per_month: null     -> 0        <-- the cleared-field case
multiplier: "two"         -> 0
hours_per_month: "200"    -> 5000     (string coerces; harmless)
rate_per_hour: "abc"      -> 5000     (falsy-ish path; harmless)
```

`null > 0` is false, so the hourly rate becomes `0 * multiplier` = 0 and **every overtime line in the run pays
nothing**: no error, no warning, on a settings screen that reported success. The mistyped multiplier reaches
`round2(NaN)`, which returns 0 - the failure mode `domain/money.ts` says it exists to prevent, and the one
[#25](defects-new.md) reaches by a different input path.

### Verified 2: `probation`, where a cleared field ends probation on day one

```ts
// services/employees.ts:144-147
const { default_months } = await getSettingValue(deps, "probation", { default_months: 3 });
probationEndDate = addMonths(+startDate, default_months);
// :62-64
const addMonths = (ms, months) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()));
```

Run against a 2026-01-15 start date:

```
default_months: 3        -> 2026-04-15   (correct)
default_months: null     -> 2026-01-15   <-- probation ends the day it starts
default_months: "3"      -> 2026-04-15   (string coerces; harmless)
default_months: "three"  -> Invalid Date (NaN written to a timestamp_ms column)
```

`month + null` is `month + 0`, so a stored `{"default_months": null}` gives every employee created afterwards
a `probation_end_date` equal to their start date. That is not cosmetic: it silently flips who
`availableDuringProbation` and the probation leave cap apply to (`services/leaveRequests.ts` reads
`probationEndDate`), i.e. a settings typo quietly grants full leave entitlement to new joiners. The
non-numeric case is worse - `Date.UTC(y, NaN, d)` is `NaN`, an Invalid Date persisted to a `timestamp_ms`
column, which every later comparison against it reads as false.

### Why this is one finding and not two coincidences

`upsertSetting` writes any JSON to any key, and the shallow merge above means an explicit `null` or a string
beats the typed default rather than falling back to it. That is precisely the mechanism the `professional-tax`
comment describes; it applies to all 21 unvalidated keys equally. These two are simply the ones where I could
demonstrate a wrong stored answer rather than a throw.

**Fix:** the registry already exists and takes a one-line entry per key. Add validators for the keys that feed
arithmetic first - `overtime`, `probation`, `leave_accrual`, `leave_encashment`, `loan-perquisite`,
`performance` - each asserting that the numeric leaves are finite numbers, the same shape
`validateProfessionalTax` and `validateGratuity` already have. Then derive the requirement instead of
remembering it: a test that enumerates the keys read via `getSettingValue` and demands either a validator or a
named exemption would keep the list from drifting again, the same way the other registry cross-checks in this
review would ([#3](defects.md), [#18](defects.md), [#20](defects.md)).

---

## 33. The liveness rule is enforced on the audience arm and nowhere else: `notify`, `notifyManager` and `resolveAssignee` all still target people who cannot sign in

**Files:** `src/services/liveEmployee.ts` (the predicate), `src/services/notifications.ts:69-121`
(`notify`), `:140-200` (`notifyMany`), `:272-304` (`audienceEmployeeIds`), `:311-330` (`notifyManager`),
`:335-339` (`managerIdOf`), `src/services/approvalDelegations.ts:37-44` (`activeDelegatesFor`),
`src/services/transitions.ts:66-71` (`resolveAssignee`), `src/services/employees.ts:230-239`
(`removeEmployee`), `src/middleware/auth.ts:88-91` (`assertLive`)

`services/liveEmployee.ts` exists precisely because this rule kept being half-applied:

> **THREE COLUMNS, and `status` is the one that keeps getting missed.** `status` and the soft-delete mark are
> independent: offboarding stamps `status: "terminated"` ... and never touches `delete_time`, while the generic
> soft delete stamps `delete_time` and never touches `status` ... **A LEAF ON PURPOSE.** This lived privately
> inside services/notifications.ts, so the surfaces that needed the same rule either imported that whole module
> ... or - what actually happened - spelled the rule again and got it wrong.

And `audienceEmployeeIds` records what the omission costs, in the arm where it was fixed:

> NAMED PEOPLE ARE STILL FILTERED FOR LIVENESS ... a rule naming a terminated or soft-deleted employee minted
> `notifications` rows nobody can ever read (middleware/auth.ts#assertLive refuses them a session), each one
> spending a `code_sequences` allocation.

`audienceEmployeeIds` is the only caller that binds it. The three predicates are exported, one import away, and
none of the paths below use them.

### The pointer is never cleared, so it outlives the person

Neither exit clears the reports' manager pointer:

- `removeEmployee` (`employees.ts:230`) soft-deletes the row and disables the login. It touches no other
  employee's `manager_id`, and there is no "this person has reports" guard anywhere in `employees.ts` or
  `softDelete.ts`.
- `terminateForOffboarding` stamps `status: "terminated"` and disables the login, and likewise reparents
  nobody.

So `employees.manager_id` can point at a departed person indefinitely, and `assertLive` guarantees that person
can never open a session to see anything sent to them.

### Three paths that follow it

**1. `notify()` does not check the recipient.** Lines 76-80 read the recipient row for prefs and the actor row
for a display name, with no `LIVE_EMPLOYEE` predicate, then insert. The row lands, an owned code is allocated
against a departed employee, and nobody can ever read it.

**2. `notifyManager()` is the app's standard approval nudge and takes the pointer verbatim.**

```ts
// notifications.ts:311-317
const emp = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
const managerId = emp?.managerId;
if (!managerId || managerId === employeeId) return;
```

The only rejections are "no manager" and "own manager". Fourteen modules route their approval nudge through
this helper or `managerIdOf` beside it: leave requests, reimbursements, expenses, loans, overtime, remote work,
attendance regularizations, asset requests, leave encashments, time entries, goals, reviews, notice periods and
the automation engine. Each one, for a report whose manager has left, writes a notification into a mailbox that
is switched off, and the report is told nothing about it.

The blast radius stops short of "requests stall", and that is worth stating: the approve grants are
`leave-requests.my-dept.approve` and `*.approve` for hr_admin (`domain/grants.ts:306,465`), i.e. scoped by
DEPARTMENT and not by the reporting line, so another manager in the department or HR can still decide. What is
lost is the notification, silently.

`activeDelegatesFor` (`approvalDelegations.ts:37-44`) is the cover path for exactly this situation and matches
on the date window alone, with no liveness filter of its own, so a delegation to somebody who has since left
copies the nudge to a second dead mailbox.

**3. `resolveAssignee` hands transition tasks to the departed manager.**

```ts
// transitions.ts:66-71
case "manager": return managerId ?? actorId ?? subjectId;
case "specific": return idFromPath(a.employee) ?? actorId ?? subjectId;
```

The fallback chain fires only when the pointer is **null**, never when it resolves to somebody terminated,
disabled or deleted. The comment above it says "so every task always has an owner", and that is the claim the
missing check breaks: the owner exists as a row and not as a person.

This is the instance that bites in a real sequence rather than a contrived one. Winding down a team offboards
the manager first, then their reports; every offboarding checklist afterwards resolves its `manager` tasks
("collect the laptop", "revoke system access", "exit interview") onto the manager who has already gone.
`insertTask` then allocates an owned code against them (`allocOwnedCode(..., assigneeId)`) and notifies them.
HR is not locked out - `transition-tasks.**` complete is an hr_admin verb (`grants.ts:483`) - but the task
shows as owned and nobody who can see it has been told, which is how an offboarding checklist sits open with
"revoke system access" unticked.

### Fix

Bind the predicate the app already exports, at the three points that choose a person rather than at the twenty
that call them:

1. `notify()` and `notifyMany()`: add `...liveEmployee()` to the recipient read they already perform, and drop
   the recipients it excludes. This is free - the read exists, and it is one `and(...)` - and it makes the
   guarantee structural instead of per-caller, which is the argument `liveEmployee.ts` makes for itself.
2. `notifyManager` / `managerIdOf` / `activeDelegatesFor`: return null / drop the id when the pointer does not
   resolve to a live employee, so the caller can escalate (the skip-level manager is the obvious next hop) or
   at least not pretend somebody was told.
3. `resolveAssignee`: make the fallback chain test liveness rather than nullness, so a "manager" task on a
   departed manager lands on the actor the way the chain already intends.

And the drift guard that would have caught all three: a test that walks every read of `schema.employees` whose
result is used as a NOTIFICATION RECIPIENT or a TASK ASSIGNEE and requires `liveEmployee()` in its `where`.
That is the same registry-cross-check shape as [#3](defects.md) and [#32](#32-settings-keys-that-feed-money-and-date-arithmetic-have-no-write-validator), and the module comment shows the rule has already
been re-derived wrongly at least three times.

---

## 34. Two byte-streaming verbs are in neither audit registry: the sick note behind a leave request, and a ticket attachment

**Files:** `src/domain/manifests.ts:363-376` (`AUDIT.sensitive_verbs`), `src/domain/auditAccess.ts:75-96`
(`READ_VERBS`), `:50-63` (`accessAudit`), `:126-158` (`mutationAudit`), `src/routes/leaveRequests.ts:68-73`,
`src/routes/tickets.ts:83-89`, `src/services/attachments.ts:94-100` (`downloadAttachment`),
`src/middleware/authz.ts:600-615` (the write backstop)

Two independent registries decide what a custom method's audit trail looks like, and they ask different
questions about the same verb:

- `AUDIT.sensitive_verbs` (policy data): does an ALLOWED read of this deserve a `<col>.read.sensitive` row?
- `READ_VERBS` (a structural fact): does this handler change state? Absent means the write backstop in
  `authz.ts:603` fires and files the call as a mutation.

Every custom method is delivered as a POST (`http/collectionRoute.ts:267` mounts them all on
`app.post("/:id")`), so a read-shaped verb missing from `READ_VERBS` is recorded as a write. The file already
knows this is the failure mode, and documents it at length for `payroll-runs:bankFile`:

> The trail was not missing ... but that is the wrong TYPE: somebody asking "who locked this run, and when"
> found a read event, and any filter or alert keyed on writes missed it entirely.

Enumerating every byte-streaming / read-shaped verb the routes declare and holding it against both registries
leaves exactly three gaps, and one of them is the documented deliberate one:

| verb | in `READ_VERBS` | in `sensitive_verbs` | |
|---|---|---|---|
| `payroll-runs:bankFile` | no | yes | **deliberate**, with eleven lines explaining why |
| `leave-requests:download` | **no** | **no** | undocumented |
| `tickets:attachment` | **no** | **no** | undocumented |
| `reimbursements:download` | yes | **no** | undocumented |

### Why these two are not the safe ones to leave out

Both registries elsewhere in this codebase say the underlying content is sensitive.

`leave-requests:download` streams the **supporting document behind a leave request**. The seeded grants say
what that is in as many words:

```
"leave-requests.my-dept.download", // read the sick note behind a team member's request before deciding
"leave-requests.*.download",       // any request's supporting document        (hr_admin)
```

and `REDACTED_FIELDS` already classifies the request's own `reason` text as *"routinely medical"*. So the app
redacts the one-line reason at field level, and streams the doctor's letter it summarises with no sensitive-read
row at all - while `candidates:download` (a resume), `referrals:download` (a resume) and
`tax-declarations:download` (rent receipts) each get one.

`tickets:attachment` is the same shape. `REDACTED_FIELDS` marks `tickets.description` because *"a ticket raised
about a person can carry anything"* (see [#31](defects-new2.md)), and the route's own comment beside the
handler says *"an attachment on a ticket is whatever a stranger uploaded"*. Its bytes are handed over with no
read audit.

### What is recorded instead

Neither handler audits inline - `downloadAttachment` (`attachments.ts:94-100`) reads the row, fetches from R2
and returns, calling nothing - so `wuser.audited` is unset and the write backstop runs. `mutationAudit` builds
`action: "leave-requests.download"`, enriched with `responseResource`, i.e. an entry anchored on the leave
request that is structurally a change to it.

The SPA then renders it from the wrong half of its own vocabulary: `web/src/lib/activity.ts` maps
`sensitive -> "viewed"` with tone `read` and icon `Eye`, but `download` is in neither `VERB` nor `TONE`, so
`actionLabel` falls through to the raw verb and `actionTone` to `"other"`. A reviewer filtering the feed by
**Viewed** to answer "who has opened this person's medical document" gets nothing back, and the rows that do
exist sit under **Other**.

### Fix

Two list entries, one in each registry, per verb:

1. `AUDIT.sensitive_verbs`: add `"leave-requests:download"` and `"tickets:attachment"`. Decide
   `reimbursements:download` explicitly either way - it is next to `tax-declarations:download` in every other
   respect, and today the only thing separating them is that nobody typed it.
2. `READ_VERBS`: add both, so the call stops being filed as a mutation. This is the structural question, and
   both handlers demonstrably change nothing.

And the check that makes it stop drifting: `READ_VERBS` and `sensitive_verbs` are both keyed `collection:verb`,
and the factory already knows every custom method each collection declares
(`http/collectionRoute.ts` registers them at mount). A test that walks that set and requires each verb to be
classified - a read or a write, and if a read then sensitive or explicitly exempt - turns both of these into a
failure at build time. That is the same shape as the cross-checks behind [#18](defects.md), [#20](defects.md),
[#32](#32-settings-keys-that-feed-money-and-date-arithmetic-have-no-write-validator) and
[#33](#33-the-liveness-rule-is-enforced-on-the-audience-arm-and-nowhere-else-notify-notifymanager-and-resolveassignee-all-still-target-people-who-cannot-sign-in),
and it is the recurring structural theme of this whole review: where a drift test exists the registries agree,
and where none does they have come apart.

---

## 35. `onPurge` has no callers, so a hard purge orphans every attachment: the R2 object and its metadata row both survive the record

**Files:** `src/services/softDelete.ts:149-161` (`purgeRow`'s `onPurge` parameter), `:225-238` (the hook),
`src/services/crud.ts:280` (the only construction of `purge`), `src/db/schema.ts:2374-2386` (`attachments`),
`src/services/attachments.ts:65-92` (`putAttachment`), `src/http/collectionRoute.ts:109-164`
(`forcePurgeable`), `src/services/employeePhoto.ts:52,118`, `src/services/identityDetails.ts:140-146`

`purgeRow` takes a teardown hook and documents exactly what it is for:

> `onPurge` **runs side effects like deleting an R2 object** before the DB row is removed.

and the body reasons carefully about the ORDER to run it in:

> In this order the same failure leaves an object in R2 that nothing points at, which costs storage and **can
> be swept**.

**The hook has no callers.** `services/crud.ts:280` is the only place a factory collection's `purge` is built,
and it passes `undefined`:

```ts
purge: (deps, actor, id, ifMatch) => purgeRow(deps, actor, table, auditName, collection, id, ifMatch, undefined, spec.purgeCascade),
```

Nothing else in `src/` mentions `onPurge`. There is also no sweeper: the nightly cron reclaims orphaned JOBS
(`cron.ts:448`) and nothing else, so the "can be swept" the comment leans on is not a thing the app does.

### Why the cascade cannot cover it either

`attachments.object_id` is a bare `text(...).notNull()` with **no `.references()`** (`schema.ts:2377`). Two
consequences, and the second is the one that hides the gap:

1. SQLite never refuses the purge over an attachment, so the `DELETE` succeeds and nothing signals a problem.
2. `test/purgeCascadeDrift.test.ts` holds each `purgeCascade` against *"the schema's own foreign keys"*
   (`services/boards.ts:186`, `transitions.ts:220`, `reviewCycles.ts:268` each say so), and an FK-less pointer
   is invisible to that check.

`purgeRow` already contains the precedent, for the other FK-less pointer at the same table:

> The per-object access rules that named THIS row, which no `PurgeCascade` entry can express: `access_rules`
> points at an object by its `code`, not by a foreign key, so SQLite never refuses the purge over one and
> nothing was ever removing them.

`attachments` is the identical shape - a `(collection, object_id)` pointer, no FK - and it did not get the
same treatment.

### Reach

`collectionRoute.ts:164` is `if (softDeletable) forcePurgeable.add(collection)`, so **every soft-deletable
factory collection** accepts `?force`. Seven of them write into the shared `attachments` table:

| collection | slot | what the bytes are |
|---|---|---|
| `candidates` | `resume` | an external person's CV |
| `referrals` | `resume` | the same |
| `leave-requests` | `document` | the sick note (see [#34](#34-two-byte-streaming-verbs-are-in-neither-audit-registry-the-sick-note-behind-a-leave-request-and-a-ticket-attachment)) |
| `reimbursements` | `receipt` | a claim receipt |
| `expenses` | invoice | a vendor invoice |
| `tax-declarations` | proof | rent receipts, PAN, investment proofs |
| `employees` | `identity:<field>` | PAN / Aadhaar / UAN scans |

None declares a `purge` override (`routes/employees.ts:104` overrides `remove` only; no other route overrides
either). `employees` additionally carries `photoKey` and `signatureKey` - `employeePhoto.ts:52,118` delete
those objects when the field is CLEARED, and nothing deletes them when the row is purged.

### What actually survives, stated precisely

`DELETE /v1/candidates/<id>?force` removes the candidate row and leaves behind:

- the R2 object at `attachments/candidates/<objectId>/<uuid>`, forever;
- the `attachments` row, which carries `file_name` - and a resume's filename is routinely the person's name.

The bytes themselves are not newly exposed: `lib/docStore.ts` encrypts every object with AES-256-GCM before it
reaches R2, the bucket is reachable only through the Worker binding, and the only reader
(`downloadAttachment`) starts from an `attachments` lookup keyed on a parent row that no longer exists. So this
is not a read path. It is a **retention** failure and a slow leak: the hard purge is the operation you reach
for to honour an erasure request or to remove a record for good, and it is precisely the operation that leaves
the person's document and their filename behind, with no sweeper and no audit note saying so.

### Fix

The hook exists; give it callers.

1. Add an `onPurge` to the collection spec and thread it through `crud.ts:280`, then declare one on the seven
   attachment-bearing collections: delete the `attachments` rows for `(collection, objectId)` and their R2
   keys. For `employees`, take `photoKey`, `signatureKey` and the `identity:*` slots with it - the walk already
   exists in `identityDetails.ts:140-146`.
2. Better, because it removes the per-collection decision entirely: do it generically inside `purgeRow`, the
   way the `access_rules` cleanup already is. `attachments` is keyed `(collection, object_id)` and `purgeRow`
   holds both, so one statement in the batch clears the metadata rows, and the R2 keys they name are deleted
   after the batch commits (the order the existing comment argues for).
3. Whichever shape: extend `purgeCascadeDrift` past foreign keys to the FK-less pointers, which today number
   two - `access_rules.match_code` and `attachments.object_id` - so the next one added to the schema is caught
   by a test rather than by a storage bill.

---

## Retraction: finding 21 was wrong

**[#21](defects.md) ("Any employee can create a company expense owned by a colleague") does not exist.** I
re-derived the `OWNER_REFS` membership list this pass with a comment-stripping parser and got 30 entries,
including the one the finding said was missing:

```ts
// src/domain/manifests.ts:182
expenses: { employee: { collection: "employees" } },
```

It sits under an eight-line comment that describes the attack I reported, as already closed, and
`services/expenses.ts:98-115` carries the independent second half:

```ts
// May this caller file an expense owned by SOMEBODY ELSE? ...
// Defence in depth beside the `expenses` entry in OWNER_REFS (domain/manifests.ts), which makes the
// middleware demand write on `expenses.<ownerCode>` before the body ever reaches here.
function reachesBeyondOwnExpenses(actor: AppUser): boolean { ... }
```

**Cause:** my original extraction regex walked `OWNER_REFS` entry by entry and stopped at the first long
comment block inside it, so `expenses` and everything after it was never in the set the cross-check compared
against. The lesson applies to this whole review, which leans on exactly this technique: strip comments before
parsing a registry, and re-derive a NEGATIVE result a second way before writing it up. Finding 21 is struck in
[defects.md](defects.md) and needs no work.

I re-derived the other registry memberships the earlier findings rest on with the same comment-stripping
parser. **#21 is the only one that was wrong.** The rest held: `MANAGED_KEYS` is still two keys,
`REDACTED_FIELDS` is still four, `PROTECTED_FIELDS` is still three, `access-rules` still has no seeded grant.

### Status of the earlier findings, spot-checked against the working tree

While this pass ran, most of the earlier findings were fixed in the working tree. Re-checked at the source
line each finding named:

| fixed | evidence |
|---|---|
| [#1](defects.md), [#2](defects.md) | `grants.ts:134,278,361` seed `employees.*.presence.**`; `:92-104,298` seed boards / cards / sprints / table-views / approval-delegations |
| [#10](defects.md) | `urlGuard.ts:146` now ends `.replace(/\.$/, "")` |
| [#11](defects.md) | no source file in `src/` or `web/src/` contains a NUL byte; `test/nulByteDrift.test.ts` is new |
| [#13](defects.md) | `listTickets` takes `showDeleted`/`deletedOnly` and binds `deleteStateFilter` (`tickets.ts:47,67`) |
| [#6](defects.md) | `positions.ts:93` keeps the current location when the patch omits it |
| [#15](defects.md) | `routes/settings.ts:520-527` runs one bounded `purgeIdentityFieldsSlice` and queues the rest as a job, after the settings row is written |
| [#16](defects.md) | `EmergencyQuickView.tsx:74-91` now carries the `let live = true` guard, keyed on `[open, employeeId]` |
| [#14](defects.md), [#17](defects.md) | the fence is documented CLOCK-IN ONLY (`attendance.ts:121`); an open session credits to `min(now, end of its local day)` (`domain/attendance.ts:157`) |
| [#24](defects.md) | `letters.ts:235` now filters the HR spread to the keys the template declares |
| [#27](defects-new.md) | `variablePay.ts` gained `mayReadCompensation` + `withoutComp` |
| [#28](defects-new.md) | `celebrations.ts` selects seven columns with `liveEmployee()` bound in SQL |
| [#29](defects-new2.md) | `accessRules.ts:103,106,108` now guard the user subject and `everyone` as well as the role |
| [#30](defects-new2.md) | new `src/http/settingRedact.ts` strips `signatory_signature` / `company_stamp` unless the caller may PATCH the key |
| [#31](defects-new2.md) | `Tickets.tsx:701,1033` now carry `data-sentry-mask`; `test/replayMaskDrift.test.ts` is new |

Nineteen new test files are untracked in `test/` (`nulByteDrift`, `moneyFieldDrift`, `ownerOnCreateDrift`,
`replayMaskDrift`, `redactedFields`, `searchIndex`, `settingRedact`, `settingsMirrorDrift`, `grantReach`,
`aclCreateScopeLint` and others), which is the derived-rather-than-remembered half these reports kept asking
for. [#19](defects.md) (the duplicated `round2`) is still as reported - `web/src/lib/utils` exports its own,
imported by Leaves, Loans and PayrollRuns - though the comments beside each call site now say why the helper
rather than an inline `Math.round(n * 100) / 100`, which was the substance of it.

I did NOT re-verify findings 3, 5, 7, 8, 9, 12, 18, 20, 22, 23, 25 or 26 line by line this pass; treat their
status as unknown rather than open. Findings 32-35 above were derived against the working tree as it stands
now.

### Two undeclared references that are real but minor, recorded rather than written up

The same pass compared every `idFromPath(input.<field>)` in a collection's service against that collection's
`REFERENCES` entry. Two genuine ref fields are ungated by the middleware:

- `time-entries.card` (`REFERENCES["time-entries"]` declares `project` and not `card`)
- `personal-documents.letterhead`

Both let a caller point a row at a target they may not read. Neither is written up as a finding because the
exposure is bounded to nothing: a wire id is an HMAC-authenticated token (`lib/idCodec.ts`), so naming a target
requires already holding its token, and neither target carries anything (a kanban card, an org letterhead).
Worth one line each in `REFERENCES` when somebody is next in the file, not worth a fix on its own.

---

## 36. A view-as simulation reads PII the real caller's own grant forbids, and the audit row is suppressed because the simulation makes it look like self-access

**Files:** `src/lib/viewAs.ts:8-14` (the three rails), `:119-125` (rail 2), `:120-121` (the grant that is
installed), `src/middleware/authz.ts:534-540` (`isSelf`), `src/domain/auditAccess.ts:48-51`,
`src/domain/manifests.ts:369` (`sensitive_subresources`), `src/domain/grants.ts:352-355,545-549`,
`src/lib/audit.ts:463-469` (`viewing_as`)

`lib/viewAs.ts` installs the SUBJECT's fully-assembled grant as the request principal:

```ts
const [roleGrant, userGrant] = await Promise.all([loadRoleGrant(deps, roleName), userUuid ? loadUserGrant(deps, userUuid) : ...]);
const grant: Grant = mergeGrants(roleGrant, userGrant);
```

It is not intersected with the real caller's. The file knows that is the thing to prevent and says so:

> **Rail 2: the simulation must never hand the caller MORE authority than they already hold.** Full
> containment isn't computable over pattern grants, but the one case that matters - borrowing the break-glass
> identity - is, so a non-super caller may not step into a super subject.

The implementation is that one case: `if (isSuperGrant(grant) && !isSuperGrant(real.grant)) throw ...`. Every
other widening is allowed, and the interesting widening is not upward into super - it is sideways, into an
ordinary employee's `me` scope.

### Part 1: it crosses a boundary the seeded policy draws on purpose

The `employee` role holds its own PII outright (`grants.ts:47-50`):

```
"employees.me.bank-account.**": "write",
"employees.me.identity.**":     "write",
"employees.me.tax.**":          "write",
```

and the two admin roles are deliberately kept out of everyone else's:

```
// hr_admin  (grants.ts:352-354)
...OWN_PII, // HR sees only their OWN PII (self-service); others' PII stays super-only by default
//          Deliberately omits bank-account/identity/personal-info, so HR no longer reaches anyone else's PII

// payroll_admin (grants.ts:547)
...OWN_PII, // own PII only; payroll no longer reaches others' bank/identity via a broad employees read
```

Both comments are written as the record of a fix. `GET /v1/employees/<X>/bank-account` with
`X-View-As: employees/<X>` walks around it: the resolved item code is X's own code, the installed grant is X's
own `employees.me.bank-account.**`, the decision is a self-match, and the response is X's decrypted account
number. Nothing in the three rails asks whether the REAL caller could have made that read.

**Reachability today is latent, and stops being latent the same way [#29](defects-new2.md) does.** Rail 1 gates
on `access-rules.preview`, and `access-rules` has no seeded grant at all (the premise of [#2](defects.md),
re-checked this pass and still true), so only `super_admin` reaches it - and super already holds `**`. But
delegating access administration is the feature, and note what this means next to the fix that just landed for
#29: `accessRules.ts:103-108` now refuses an author who writes a rule for their own user, their own role, or
`everyone`, so an access admin can no longer GRANT themselves `employees.*.bank-account`. They can still read
it, one header at a time, through the simulation. The grant lane was closed and the read lane beside it was
not.

### Part 2: and the read leaves no audit row - including for super, today

This half does not wait for a delegation. `middleware/authz.ts:534-540`:

```ts
const ec = auser?.employeeCode;      // auser is c.get("user") - the SIMULATED principal
const ic = c.get("itemCode");
const isSelf = !!ec && !!ic && (ic === ec || ic.startsWith(`${ec}-`));
const ev = accessAudit(c.req.method, pathname, dec, ..., isSelf);
```

and `auditAccess.ts:48-51`:

```ts
// Reading your OWN sensitive data is expected, not an abuse signal - never audited.
if (isSelf) return null;
```

`bank-account`, `identity` and `tax` are exactly `AUDIT.sensitive_subresources` (`manifests.ts:369`), the
three the policy calls *"an accountability event"*. Under a simulation both sides of the `isSelf` comparison
come from the SUBJECT, so it is always true, and the row is never written. The same request made honestly is
audited: a super admin reading X's bank account as themselves has `ec` = their own code and `ic` = X's, so
`isSelf` is false and `employees.read.sensitive` lands.

So for the three most sensitive reads in the app, **view-as is quieter than acting as yourself**. That
inverts the module's own promise:

> The audit trail keeps naming the real human (lib/audit.ts stamps `viewing_as` on the row), so a simulated
> read is attributable to the admin who ran it, never to the person they were watching the app as.

`lib/audit.ts:463-469` does stamp `viewing_as` faithfully - on rows that get written. For a simulated
sensitive read there is no row to stamp. An access admin who wants every employee's bank details and does not
want it in the trail opens a simulation and pages through the directory.

### Fix

Both halves are small, and both are a line in code that already has everything it needs.

1. **Containment, per request rather than per grant.** The file is right that grant subsumption is not
   computable, and it does not need to be: the middleware has already resolved THIS request, so ask the real
   caller's grant the same question before answering.
   `decide(real.grant, resolveRequest(method, pathname), { employeeCode: real.employeeCode })` - refuse the
   simulated answer when the real caller would have been denied. That is the exact shape
   [#29's](defects-new2.md) third fix suggests for authored rules, and `services/accessPreview.ts:159-166`
   already uses it as a caller bound for the preview surface next door. It keeps the honest use of the feature
   (an access admin checking that a person can see their own dashboard) and removes the sideways read.
2. **Never let a simulation suppress an audit row.** `isSelf` exists to stop logging *your* reads of *your*
   data; under a simulation neither pronoun refers to the person driving. Compute it against
   `real.employeeCode` (available as `user.simulatedBy`), or simply pass `isSelf: false` whenever
   `simulatedBy` is set - which is the more honest reading, since no read made through a simulation is a
   self-read.

Either half alone leaves the other open, and #2 is worth doing first: it costs nothing, it applies to the
configuration shipping today, and it is the difference between a feature that can be reviewed after the fact
and one that cannot.

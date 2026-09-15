# Pre-production review — source findings

Source-level review, no gates run. Each finding names the file and the exact line of reasoning that proves it,
so it can be checked without re-deriving the whole path. Five passes; findings are numbered in the order they
were found, not by severity.

## Index

**Access control**
- [1](#1) `employees/{id}/presence` is denied to every role but super — the pill is dead for everyone
- [2](#2) Boards/Cards/Sprints, Table builder, Delegation, Goal templates ship with no seeded grant
- [21](#21) ~~**Any employee can create a company expense owned by a colleague** — `expenses` is missing from `OWNER_REFS`~~ **RETRACTED: the entry exists; the finding was wrong**
- [18](#18) Global search's `announcements` entry disagrees with its list scope; the guard named for it does not exist
- [20](#20) `payroll-debit-accounts` is permanently ungrantable; the second named drift gate does not exist either
- [3](#3) Nothing ties routes/verbs/sub-resources to seeded grants — the root cause of #1 and #2

**Security / privacy**
- [10](#10) SSRF guard bypassed by a trailing dot — `assertPublicHttpsUrl` accepts `metadata.google.internal.`
- [22](#22) Private 1:1 notes, review assessments and suggestions are masked from session replay but still written to disk in plaintext

**Data integrity / money**
- [15](#15) Removing an identity field runs an unbounded per-employee purge inside the request, destroying data before it fails
- [17](#17) An open attendance session counts as zero minutes, so a clocked-in day is docked as a full absence
- [14](#14) The attendance fence also fences clock-OUT, which locks the session open
- [24](#24) Letter generation lets the caller overwrite any derived placeholder, including the CTC figure the code withholds
- [6](#6) `changeRole` can blank `employees.location`
- [5](#5) Employee sub-resource ETags collide — spurious 409 on unrelated PII edits

**Correctness**
- [12](#12) Leave dialog previews clean for a rule declared on the other type, then 412s
- [13](#13) `listTickets` ignores `?show_deleted`; `deleted_only` honoured by one list in sixteen
- [7](#7) Table-view `empty` / `not_empty` mean different things either side of the SQL split
- [16](#16) `EmergencyQuickView` refetches on `employeeId` with no staleness guard

**Hygiene**
- [4](#4) Sticky profile bar leaves focusable controls in the tab order while `aria-hidden`
- [11](#11) Two source files carry a literal NUL byte and read as binary to every search tool
- [19](#19) `round2` and the currency table are duplicated in the browser instead of imported
- [23](#23) `payroll-runs:bankFile` is audited as a read, but it irreversibly locks the run against deletion
- [8](#8) `professional-tax` guard is right; its stated reason is not
- [9](#9) Duplicate React keys on the profile role line

Also: [areas reviewed and found sound](#areas-reviewed-and-found-sound) (pass 1) and
[round 2](#round-2-areas-reviewed-and-found-sound).

---

## 1. `GET /v1/employees/{id}/presence` is denied to every role but `super_admin`

**Files:** `src/routes/employees.ts:246`, `src/services/presence.ts`, `src/domain/grants.ts`, `web/src/hooks/usePresence.ts`

The presence endpoint was added in `846a79e`. `src/domain/grants.ts` was last touched three feature commits
earlier (`d831cf1`), and no grant was added for the new sub-resource.

The authz middleware resolves the request to the standard key `employees.<code>.presence` + level `read` —
three resource tokens (`src/domain/permissions.ts` `resolveRequest`, `src/lib/authzResolve.ts`
`buildCodedPath`, which keeps every path segment). The seeded patterns are:

| role | pattern | tokens | matches a 3-token resource? |
|---|---|---|---|
| employee | `employees.me` | 2 | no |
| employee | `employees` | 1 | no |
| manager | `employees.my-dept` | 2 | no |
| hr_admin | `employees.*` | 2 | no |
| any | `employees.me.bank-account.**`, `.identity.**`, `.personal-info.**`, `.tax.**`, `.notification-prefs.**`, `.bio.**` | — | wrong sub-resource |

`matchFrom` returns `ki >= key.length` once the pattern runs out, so a 2-token pattern can never match a
3-token key. Every other employee sub-resource has a matching `employees.me.<sub>.**` grant; `presence` is the
only one that does not. Verified against both `src/domain/grants.ts` and the materialised
`bootstrap/bootstrap.sql` (`grep` for a `presence` namespace or pattern returns nothing).

**Effect:** every non-super caller gets 403, including a person reading their OWN profile.
`usePresence` swallows the error (`.catch(() => undefined)`), so the status pill, the "on leave until …"
callout, the covering-person note and the sticky bar's pill silently never render. The feature looks
implemented and is dead for the whole workforce.

There is also **no test at all** for this endpoint (`rg -l presence e2e test` returns only unrelated prose
matches), which is why it shipped.

**Fix:** add `employees.me.presence.**: read` to the self-service tier (`OWN_PII` sits next to it), plus the
dept/all equivalents for manager/hr_admin, and regenerate the seed (`scripts/genAccessRulesSeed.ts` —
`test/seedDrift.test.ts` pins the two together).

---

## 2. Whole modules ship with no seeded grant: Boards/Cards/Sprints, Table builder, Delegation, Goal templates

**Files:** `src/domain/grants.ts`, `bootstrap/bootstrap.sql`, `web/src/nav.ts`, `web/src/settings/registry.ts`

The seed carries `access_rules` rows for exactly **79** namespaces. Cross-checking the nav's own `perm:`
declarations against that set:

```
nav / settings entries whose collection has NO seeded grant for ANY role:
  api-keys            (plausibly deliberate — machine credentials)
  audit               (plausibly deliberate)
  cron-runs           (plausibly deliberate)
  referrals           (deliberate — private + ACL by design)
  boards              <-- Progress → Boards tab, perm "boards.read"
  approval-delegations<-- Time → Delegation tab, perm "approval-delegations.read"
  goal-templates      <-- Settings entry, perm "goal-templates.write"
  table-views         <-- "Tables" nav entry, perm "table-views.read"
```

`cards`, `sprints` and `table-fields` are ungranted too — they carry no nav entry of their own but every board
and grid interaction goes through them. Cross-checking custom verbs against the compiled patterns, the
following are reachable only by `super_admin`:

```
boards:configure  boards:metrics
cards:addTodos cards:assign cards:block cards:comment cards:move cards:prioritize
cards:promoteTodo cards:removeTodo cards:toggleTodo cards:unblock cards:watch cards:unwatch
sprints:activate sprints:complete
```

This is not theoretical: `bootstrap/bootstrap.sql` **seeds board rows, sprints and automations** — including
`'Sprint started: rally the board'`, which notifies `{"kind":"everyone"}` about a board none of them can open.

Under the app's own "hide, never disable" rule the tabs simply do not render, so a fresh install presents a
Kanban module (2,768-line page + `services/boards.ts` + `services/cards.ts`), a table builder and the approval
delegation screen as if they did not exist.

**Fix:** decide per module whether it is intentionally admin-only; for the ones that are not, add role grants
and regenerate the seed.

---

## 3. Nothing ties routes/verbs to seeded grants — the root cause of #1 and #2

**Files:** `test/seedDrift.test.ts`, `test/*Drift.test.ts`

There are 28 drift guards in `test/`, including `openapiRoutesDrift`, `customMethodsDrift`, `mountOrderDrift`
and `purgeCascadeDrift`. `seedDrift` only asserts `scripts/seed.sql` matches what `grants.ts` compiles to —
i.e. that the seed is not stale relative to the grants. **No test asserts that a mounted collection, custom
verb or sub-resource is reachable by at least one seeded role.**

Both findings above are the same shape: a route was added, the grant was not, and every gate passed. A drift
test that enumerates route mounts + `verbs:` keys + sub-resource paths and asserts each resolves to an allow
under some seeded role (with an explicit allow-list for the deliberately super-only ones) would have caught
both at the point they were introduced.

---

## 4. Sticky profile bar leaves focusable controls in the tab order while `aria-hidden`

**File:** `web/src/components/common/ProfileStickyBar.tsx:62-79`

```
aria-hidden={!stuck}
className={cn(..., stuck ? "pointer-events-auto translate-y-0 opacity-100"
                        : "pointer-events-none -translate-y-2 opacity-0")}
```

`opacity-0` + `pointer-events-none` hides the bar from sight and from the mouse, but **not from the keyboard**:
the "Org chart" button (and anything else a page passes as `actions`) stays in the tab order on every profile
page whose header is still on screen. Tabbing lands focus on an invisible control.

It is also an ARIA violation in its own right — `aria-hidden="true"` on a subtree containing focusable
elements is what axe flags as `aria-hidden-focus`; screen readers are told the region does not exist while the
focus ring can still enter it.

**Fix:** add `inert` alongside `aria-hidden` when `!stuck` (or gate the subtree on `stuck` with `hidden`
/ `visibility:hidden`, which does remove descendants from the tab order — `opacity` does not).

---

## 5. Employee sub-resource ETags collide — spurious 409 on unrelated PII edits

**File:** `src/http/serialize.ts:21-32` (the comment block above `etagOf`)

This one is documented in the source as a known, unfixed defect, and it is shipping:

> `bank-account`, `personal-info`, `identity` and `tax` are separate encrypted blobs on the employee row, but
> each one's etag is this function over the SAME `employees.updated_at`.

So HR filling in an emergency contact invalidates the `If-Match` the employee is holding on the bank form, and
the PATCH is refused with a conflict that did not happen. The only recovery the SPA offers is "reload and
reapply". It is called out as surfacing intermittently in `employeeRecord.spec.ts`.

Flagging it because a pre-production list should carry it explicitly rather than leave it as a comment: a 409
on a payroll-relevant form, for a collision that does not exist, is a support ticket waiting to happen.
The stated fix (a version per sub-resource) is a schema change; a cheaper interim is to derive each
sub-resource's validator from a hash of that blob's own ciphertext rather than from the row timestamp.

---

## 6. `changeRole` can blank `employees.location` — the one field whose carry-forward skips the employee row

**File:** `src/services/positions.ts:89-98`

```ts
// "so a promotion that only changes the title keeps the existing department/location"
const departmentId   = input.department       !== undefined ? … : current?.departmentId   ?? emp.departmentId   ?? null;
const jobTitle       = input.job_title        !== undefined ? … : current?.jobTitle       ?? emp.jobTitle       ?? null;
const location       = input.location         !== undefined ? … : current?.location                            ?? null;  // <-- no `emp.location`
const employmentType = input.employment_type  !== undefined ? … : current?.employmentType ?? emp.employmentType ?? null;
const workMode       = input.work_mode        !== undefined ? … : current?.workMode       ?? emp.workMode       ?? null;
```

Four of the five fall back to the employee row; `location` does not. Commit `846a79e` added `location` to the
`employees` update at the end of the same batch, so the resolved value is now **written back over
`employees.location`**, where before it only landed on the new `positions` row.

Reachable whenever `emp.location` is set and `current.location` is not — a role change that omits `location`
silently clears the employee's location instead of carrying it. Today `employees.location` is only ever
written by this same function so the two stay in step by accident, but the asymmetry is one new writer away
from being live, and the comment directly above the line already promises the behaviour the code does not
have.

**Fix:** `current?.location ?? emp.location ?? null`, matching its four siblings.

---

## 7. Table-view filters: `empty` / `not_empty` mean different things either side of the SQL split

**File:** `src/services/tableRun.ts:517-534` vs `597-600`

SQL half:

```ts
case "empty":     return isNull(col);
case "not_empty": return isNotNull(col);
```

In-memory half:

```ts
if (f.op === "empty")     return cell === null || cell === undefined || cell === "";
if (f.op === "not_empty") return !(cell === null || cell === undefined || cell === "");
```

An empty-string cell is *empty* to the in-memory evaluator and *not empty* to SQL. So the same saved filter
answers differently depending on whether the column happens to sit on the base table or behind a link — which
is precisely the class of bug this file has already been patched for three times (`likeEscape` for `contains`,
`lowerEq` for text equality, `equalsValue` for typed `eq`/`ne`). Low blast radius today because the write
paths normalise `""` to `null` ("Empty string clears, like an omitted field"), but the two halves should state
the same rule.

**Fix:** `or(isNull(col), eq(col, ""))` on the SQL side for `empty`, and its negation for `not_empty`.

---

## 8. `professional-tax` guard is right; its stated reason is not

**File:** `src/domain/statutory.ts:56-63`

> `getSettingValue` merges the settings row over the default SHALLOWLY, so `{"annual_cap": 2500}` leaves
> `slabs` undefined and `[...undefined]` is a TypeError

`getSettingValue` is `{ ...fallback, ...JSON.parse(row.value) }` (`src/services/settings.ts:42`), and both call
sites pass `DEFAULT_PT_CONFIG` as the fallback. A stored `{"annual_cap": 2500}` therefore **keeps** the
default `slabs`. The example named cannot produce the failure described.

The guard itself is correct and worth keeping — a stored `"slabs": null` or a non-array does reach it, and the
shallow-merge hazard is genuine one level down (`incomeTax.ts`, where a stored `regimes` block replaces the
whole map — that comment IS accurate). Only the worked example is wrong, and by this repo's own rule a comment
that describes behaviour the code does not have is a defect: a reader who trusts it will reason incorrectly
about every other `getSettingValue` call.

---

## 9. Duplicate React keys on the profile role line

**File:** `web/src/components/common/ProfileView.tsx:147-152`

```tsx
{roleParts.map((part, i) => (
  <React.Fragment key={part}>
```

`roleParts` is `[jobTitle, department, employmentType, workMode · location]`. Two of those being the same
string is ordinary in an HR system — job title "Operations" in department "Operations", or a one-person
function named after its team. Duplicate keys among siblings make React's reconciliation ambiguous and log a
warning. The index is the honest key here; the list is positional and never reordered.

---

## Areas reviewed and found sound

Recorded so the next pass does not re-walk them: the auth middleware and its three lanes
(`middleware/auth.ts`), the CSRF/API-key interlock (`middleware/csrf.ts` + `lib/apiKeyToken.ts`), the stateless
session (`lib/session.ts`), the OIDC flow (`routes/authRoutes.ts`), the decision engine and its pattern index
(`domain/permissions.ts`, `domain/compileGrants.ts`), the wire-id codec (`lib/idCodec.ts`), the collection
factory and the `?force` purge interlock (`http/collectionRoute.ts` + `http/query.ts`), all four unauthenticated
lanes (`/diag`, `/found`, `/esign`, `/calendar`), the money helpers (`domain/money.ts`, `domain/currency.ts`),
income tax and statutory (`domain/incomeTax.ts`, `domain/statutory.ts`), the job queue and its claim/reclaim
pair (`cron.ts`), leave counting and the leave-policy evaluator (`domain/leave.ts`,
`domain/leaveRestrictions.ts`), the SPA API client's retry/401 handling (`web/src/api.ts`), browser storage
(`lib/clientStore.ts`, `lib/localPref.ts`), and the CSP/header posture (`middleware/securityHeaders.ts`,
`web/public/_headers`). No committed secrets: `.dev.vars` and `.vapid.json` are ignored and untracked.

---

# Second pass

## 10. SSRF guard bypassed by a trailing dot — `assertPublicHttpsUrl` accepts `metadata.google.internal.`

**File:** `src/lib/urlGuard.ts:141,217-219`
**Reachable by:** any signed-in employee (`PATCH /v1/preferences/push_subscriptions`), plus automation authors
and the e-sign redirect re-check.

The host is normalised for case and for IPv6 brackets, but not for the trailing dot that makes a DNS name
fully qualified:

```ts
const host = u.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
...
if (BLOCKED_NAMES.test(host)) reject();                       // /^(localhost|metadata|metadata\.google\.internal)$/i
if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) reject(); // ".internal" ".local" ".localhost" ".home.arpa"
if (!host.includes(".")) reject();                            // bare single label
```

`new URL()` strips a trailing dot only when the host parses as an IPv4 literal. For a NAME it is preserved, so
every name-based rule above misses:

| url | `u.hostname` | verdict |
|---|---|---|
| `https://localhost./` | `localhost.` | **allowed** — anchored regex does not match |
| `https://metadata.google.internal./` | `metadata.google.internal.` | **allowed** — ends with `internal.`, not `.internal` |
| `https://db.prod.internal./` | `db.prod.internal.` | **allowed** |
| `https://printer.local./` | `printer.local.` | **allowed** |
| `https://metadata./` | `metadata.` | **allowed** — and the bare-label check passes, because it contains a `.` |

A trailing dot is the FQDN form and resolves identically, so each of these reaches the host the guard names in
its own block list. The IP-literal half of the guard is unaffected (`https://127.0.0.1./` normalises to
`127.0.0.1` before it is judged) — this is purely the name half, which is the half the comment calls out as
the one that has to catch `metadata.google.internal`.

The push path makes it client-reachable rather than author-only: `services/webPush.ts` runs caller-supplied
subscription endpoints through this guard and then `fetch`es them on every notification the subscriber can
provoke about themselves — up to `MAX_PUSH_DEVICES` (5) URLs per account. Blind SSRF (the response body never
returns to the caller), but it is exactly the primitive the guard exists to remove.

**Fix:** strip one trailing dot as part of normalising the host, alongside case and brackets:

```ts
const host = u.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
```

Then re-check the bare-label rule still fires for `metadata.` (it will: the dot is gone before `includes(".")`).

---

## 11. Two source files carry a literal NUL byte, which makes them binary to every search tool

**Files:** `web/src/components/common/RequestLeaveDialog.tsx:234` (byte offset 14895),
`src/domain/stateMachines.ts:52`

```ts
// RequestLeaveDialog.tsx:234
const key = `${t.path}<U+0000>${JSON.stringify(t.restrictions ?? null)}`;
// stateMachines.ts:52
const key = `${t.verb}<U+0000>${f}`;
```

A repo-wide byte scan over `src/`, `web/src/`, `test/`, `e2e/`, `scripts/` and `bootstrap/` finds exactly these
two — one NUL each, written as a raw control character rather than as the escape
`\\u0000` (shown escaped here so this report stays greppable). Both work at runtime, and the intent (an
unambiguous composite-key separator) is sound — but the raw byte classifies the file as binary:

- `rg` refuses it outright: "binary file matches (found \0 byte around offset 14895)" — no line numbers, no
  context. Hit live during this review while checking the client/server parity of the leave evaluator.
- `grep -n` silently prints nothing at all; `grep -an` is required to see any match.
- `git diff` renders the whole file as "Binary files differ" under most default configurations.

The codebase already made the opposite call, in as many words, for the same problem —
`web/src/lib/clientStore.ts` on its composite key: *"Deliberately a printable one: a control character here
made the whole file read as binary to grep."* And `web/src/lib/getCoalescer.ts:65` composes the same kind of
key with the ESCAPE and stays perfectly greppable. These two files are the counterexamples that rule was
written against.

**Fix:** use the six-character escape sequence backslash-u-0-0-0-0 (identical runtime value, file stays text),
or a printable separator as `clientStore` does. A repo-wide guard is cheap: fail lint on any NUL byte under
`src/` or `web/src/` — the scan above is two lines of Node.

---

## 12. Leave dialog skips the whole policy check for a type whose only rule is declared on the OTHER side

**Files:** `web/src/components/common/RequestLeaveDialog.tsx:429` vs `src/services/leaveRequests.ts:358-360`

Server:

```ts
const inboundGap = await inboundCombinationGap(deps, leaveTypeId);
const policyOn = hasAnyRestriction(rules) || inboundGap !== null;
```

`inboundCombinationGap` exists precisely because *"a combination rule binds both types … but the request being
filed only consults ITS OWN policy to decide whether there is any policy to evaluate at all, so a rule written
solely on the other type would never be reached."*

Client:

```ts
if (!hasAnyRestriction(selectedRules)) return [];
```

The browser mirror never got the second half of that condition. So for a leave type that configures nothing of
its own but is named in another type's `no_combination_with`:

- the dialog computes zero violations, shows a clean checklist and enables Submit;
- the server evaluates it (`inboundGap !== null` so `policyOn` is true), the evaluator's
  `theirs.has(f.leaveTypeId)` branch fires, and the create is refused with `failedPrecondition`.

The dialog's whole purpose is to answer "before the round trip". This is the one configuration where it
answers the opposite of what the server will.

**Fix:** carry the inbound rule client-side — the dialog already merges every type's rules through `rulesFor`,
so `types.some(t => rulesFor(t).combinations.no_combination_with?.some(ref => idOf(ref) === typeId))` is a pure
in-memory test over data already loaded, and the early return becomes
`if (!hasAnyRestriction(selectedRules) && !inboundRule) return []`.

### 12a. `exitDaysUsed: 0` is passed unconditionally (same file, ~line 477)

The client hands the evaluator a hard-coded `0` for days of this type already booked inside the notice window,
so an `exit.during_notice: "capped"` policy is previewed as `0 + days` against the cap and always looks
satisfiable. `lifetime: null` on the line above carries a comment explaining that the preview deliberately
defers that rule to the server; `exitDaysUsed` silently does the same thing without saying so. Either give it
the same note, or compute it from `myRequests` (which the dialog already holds) the way `neighbours` is.

---

## 13. `listTickets` ignores `?show_deleted` — the only soft-deletable list in the app that does

**Files:** `src/services/tickets.ts:63`, `src/routes/tickets.ts:58`

```ts
conds.push(isNull(schema.tickets.deleteTime));   // unconditional — no `showDeleted` parameter at all
```

The route's list hook never forwards `page.showDeleted` / `page.deletedOnly`, and the service has no parameter
to receive them. Of the 16 collections that (a) have a bespoke route-level `list` hook and (b) sit on a table
with `delete_time`, tickets is the only one that drops the flag:

```
applications boards compensation interview-feedback interviews job-requisitions loans
notice-periods offers review-cycles sprints suggestions ticket-checklists time-entries transitions   -> honour showDeleted
tickets                                                                                              -> ignores it
```

`tickets` IS soft-deletable, so the factory mounts `DELETE` and `:restore` for it. With the list unable to
return a deleted row, a soft-deleted ticket is unreachable: nothing can surface it, so nothing can restore it
except a caller who already has the id. `show_deleted` is documented on every collection list in
`openapi.yaml`, so this is an API-contract break as well as a dead recovery path.

Latent today only because the Tickets page ships no trash view. It will not stay latent — every other
collection's page got one.

**Fix:** give `listTickets` the `showDeleted` / `deletedOnly` pair the other fifteen take, and forward
`page.showDeleted` / `page.deletedOnly` from the route.

### 13a. `deleted_only` is honoured by exactly one bespoke list

`PageRequest.deletedOnly` is a SEPARATE flag from `showDeleted`, and `collectionRoute.ts` says why in as many
words: *"a 'Deleted' view is its own fetch rather than a client-side filter over a page of mostly-live rows -
which on any list longer than one page would show an empty trash while deleted rows sat past the cursor."*

Of the 16 bespoke lists above, only `compensation` passes it. The other fifteen take `showDeleted` and drop
`deletedOnly` on the floor, so `?deleted_only=true` returns live rows mixed with deleted ones — precisely the
page the flag was invented to avoid. Not currently reachable from the SPA (only Directory, Expense budgets and
the generic-crud collections request it), so this is latent; but it is fifteen copies of the same omission, and
the generic lane (`services/crud.ts:181`) already does it correctly, so the shape to copy exists.

---

## 14. The attendance network fence also fences CLOCK-OUT, which locks the session open

**Files:** `src/routes/attendance.ts:38-39`, `src/services/attendance.ts:112-118,149-162`

`assertPunchOrigin` runs on both punches. The fence's stated question is *"are you at work?"* — which is
exactly the question whose answer is NO at the moment somebody leaves the office. With
`ATTENDANCE_ALLOWED_IPS` configured and no approved remote-work request covering that half-day:

1. employee clocks in from the office — allowed;
2. leaves, tries to clock out from their phone or from home — refused with `clockNetworkFence`;
3. the session stays open. `att_open_emp_idx` is a partial unique index on (employee, open), so
4. every subsequent `clockIn` answers `already clocked in` — the person can never punch again;
5. loss of pay is derived from punches, so every later working day reads as a full absence
   (`services/payroll.ts` `assembleLop`), with nothing on screen explaining why.

Recoverable only through an approved attendance-regularization (which supersedes the open row and releases the
partial index), i.e. it needs an approver before the employee can clock in again. That is a large consequence
for walking out of the building.

**Fix:** fence `clockIn` only. Closing a session you already opened asserts nothing about where you are, and
the in-office punch that opened it is the one the fence exists to check. If an off-network clock-out should
still be visible, stamp the punch's origin on the row rather than refusing it.

### 14a. `remoteWorkCovers` reads the employee's entire remote-work history per punch

`src/services/attendance.ts:92-97` selects every `APPROVED` remote-work request for the employee with no date
bound and filters in JS. It only runs when the IP check misses — so it is free for an in-office punch and paid
by every punch in a remote-first org with a fence configured, on a table that only grows. The same file's
sibling reads push their windows into SQL, and the repo's D1 discipline is explicit about it. A
`gte(endDate, dayStart) AND lte(startDate, dayEnd)` pair makes it one indexed row.

---

## 15. Removing an identity field runs an unbounded per-employee purge inside the request, and destroys data before it fails

**Files:** `src/routes/settings.ts:474-500`, `src/services/identityDetails.ts:101-121`,
`src/services/attachments.ts:121-127`

`PATCH /v1/settings/employee_fields` with `delete_removed_values: true` calls `purgeIdentityFields`
**synchronously, inside the request**:

```ts
const rows = await deps.db.select().from(schema.employees);   // the whole table, unbounded, no delete_time filter
for (const row of rows) {
  for (const slot of keys.map(identityDocSlot)) await deleteAttachment(deps, actor, "employees", row.uuid, slot);
  if (!row.identityDetailsEnc) continue;
  ... await deps.db.update(...);  await audit(...);
}
```

and `deleteAttachment` is itself four round trips (`getAttachment` select, an R2 delete, a row delete, an audit
insert) — run for **every employee × every removed key**, whether or not that employee has an attachment,
because the existence check is the read inside it.

Cost per invocation is roughly `N × (4K + 2)` subrequests for N employees and K removed fields. A D1 query and
an R2 call are each a subrequest, and the Workers budget is 1000 per invocation on Standard (50 on Free —
`wrangler.toml` says so in as many words). So:

- ~200 employees, one removed field: ~1,200 subrequests — over the ceiling.
- The loop has no chunking, no cursor and no job; it cannot resume.

What makes it worse than a slow endpoint: **nothing is transactional and the order is wrong.** The purge runs
BEFORE `upsertSetting` writes the new field list. When the invocation is killed partway:

- the first M employees have had their identity values wiped and their uploaded proof documents deleted from
  R2 — irreversibly;
- the remaining employees are untouched;
- the settings row still lists the field, so the UI shows it as present;
- the caller sees a 500 for an operation they were asked to confirm in a dialog that promised a clean delete.

Retrying repeats the partial destruction from the top.

**Fix:** this is the exact shape of the app's existing long-running jobs (`payslip.generateRun`,
`REMINDER_EMAIL_JOB`, `SCHEDULED_FAN_OUT_JOB` — bounded slice per tick, requeue with a cursor). Write the
settings row first, enqueue the purge, and let the drain carry it. Failing that, at minimum: read only
employees whose `identity_details_enc` is non-null, fetch the attachment rows for the whole slice in one
`IN` query instead of one `getAttachment` per employee per key, and batch the updates.

---

## 16. `EmergencyQuickView` refetches on `employeeId` with no staleness guard

**File:** `web/src/components/common/EmergencyQuickView.tsx:68-81`

```ts
useEffect(() => {
  if (!open) return;
  setEdit(false); setLoading(true);
  void loadInsurance();                                   // no guard
  get<PersonalDetails>(`employees/${employeeId}/personal-info`)
    .then((r) => setData(r))                              // no guard
    ...
}, [open, employeeId]);
```

Two concurrent reads (personal-info and the insurance document list), neither with the `live`/`cancel` flag
every other refetching effect in this codebase carries (`hooks/useResource.ts`, `pages/TeamAnalytics.tsx`,
`hooks/usePresence.ts` all do it correctly). `employeeId` is a prop that genuinely changes under a mounted
instance — `pages/EmployeeProfile.tsx:487` passes `employeeId={id}`, and `id` moves with the prev/next employee
stepper while `emergencyOpen` is never reset on that change.

So a response for employee A can land after one for employee B and render A's emergency contacts, blood group
and insurance e-card under B's name. This is the most sensitive panel in the app to get wrong in that
direction. It is the only refetching effect left in `web/src` without the guard (scanned all of them), so the
fix is to copy the idiom already used two files over.

Reachability is narrowed by the dialog being modal (the stepper is behind it), but the deep-link route
(`?view=emergency`, handled at `EmployeeProfile.tsx:191`) and any future non-modal use reopen it, and the
correct version costs three lines.

---

## Cross-references

**#10 (trailing-dot SSRF bypass) weakens #10's own second consumer.**
`src/services/esign/cashfree.ts#downloadSigned` follows vendor redirects BY HAND specifically so every hop is
re-judged by `assertPublicHttpsUrl` — the comment names `169.254.169.254` as the case it exists to refuse. With
the trailing-dot hole open, a `302 Location: https://metadata.google.internal./computeMetadata/v1/...` passes
the re-check on every hop. The redirect target is fetched with credentials stripped (correct), so this is a
blind internal GET rather than a credential leak — but it is the one guard that path relies on, so the fix in
#10 is what restores it.

**#2 (ungranted modules) and #1 (ungranted sub-resource) share one missing test — #3.**
Both are "a route shipped, a grant did not". A single drift guard closes the class; fixing the two instances
without it leaves the next one to be found the same way.

---

## Round 2: areas reviewed and found sound

Recorded so a third pass does not re-walk them.

- **Wire edge, both directions.** `middleware/encodeWireIds.ts` / `decodeWireIds.ts` — the ENCODABLE set covers
  every mounted collection whose item path is a uuid (checked; the 16 that are absent are key-addressed —
  `bank-formats` and `payroll-debit-accounts` are keyed by bank name, the rest are settings/virtual/aggregate).
  Depth and breadth bounds, canonical base32 only, capped chunked-body read before auth.
- **Decision engine.** `domain/permissions.ts` matcher and its per-grant index, `domain/compileGrants.ts`
  (deny unions, max-level merge, the 2-token collection-verb rewrite), `lib/policyLoad.ts` (`everyone` union,
  super exemption, liveness cut taken after the cache).
- **List scoping.** `services/listScope.ts` — GLOB subtree binding, deny fails closed on a missing code column.
  Every one of the 41 route-level `list` hooks binds `applyScope` (checked mechanically); the two that do not
  (`notifications`, `holiday-selections`) hard-pin to the caller, which is tighter.
- **Owner-column registry.** `LIST_OWNER_COLUMNS` is held against the services by `test/listOwnerColumns.test.ts`.
- **Generic CRUD lane.** `services/crud.ts` — compare-and-swap update (version in the WHERE, not a read-then-
  compare), `?id` restricted to a 13-char base32 PK, identity spread last so a mapper cannot shadow `code`.
- **Purge.** `services/softDelete.ts` — one atomic batch, children before parent, exact-match ACL rows swept,
  R2 delete only after the row is gone.
- **Batch transport.** `routes/batch.ts` — GET-only, URL normalised before the `/v1/` prefix test, per-sub user
  copy, client metadata forwarded, sub-requests re-enter the full chain.
- **Search.** `services/globalSearch.ts` / `searchFilter.ts` — FTS match expression stripped to letters and
  digits; the two `sql.raw` interpolations take registry collection names and `/^[0-9a-hjkmnp-tv-z]+$/`-
  filtered ids, never caller text.
- **E-sign.** `services/esign/cashfree.ts` — HMAC over `timestamp + rawBody` before anything is trusted,
  constant-time compare, replay window, manual redirect walk with credentials stripped and each hop re-guarded,
  capped download. `documentService.ts` acknowledge/sign — claim-then-unwind compensation on both lanes.
- **PDF.** `lib/winAnsi.ts` restricts text to WinAnsi-encodable characters before it reaches pdf-lib, so no
  content-stream injection surface.
- **Money.** `domain/settlement.ts` — final-month salary clamped to the month before LOP, gratuity qualifying
  service counted in calendar anniversaries (not `/365.25`), recoveries deliberately uncapped.
- **Rate limits.** `middleware/rateLimit.ts` — per-caller budgets, batch charged in sub-reads, first-match
  ordering documented as load-bearing.
- **N+1 sweep.** 18 loops issue a DB call per iteration; all but one are cron sweeps with bounded slices or
  chunked `IN` helpers. The exception is #15.
- **Stale-fetch sweep.** Every refetching `useEffect` in `web/src` carries a `live`/`cancel` guard except #16.
- **No committed secrets.** `.dev.vars`, `.vapid.json` and `cf.txt` are ignored and untracked; `CCAIndia2022.cer`
  is a public CA certificate.
- **No default administrator.** `bootstrap/bootstrap.sql` seeds no `users` row, so a fresh production database
  has no login at all — checked because a seeded admin would be a finding. It is deliberate (the bootstrap
  states the first admin is provisioned out of band), and it is the safe direction.

---

## 17. An OPEN attendance session counts as zero minutes worked, so a clocked-in day is docked as a full absence

**Files:** `src/services/payroll.ts:216-221` (`assembleLop`), `src/domain/attendance.ts:251-258`
(`lopDayUnits`), `src/services/settlements.ts:119` (same shape on the FnF path)

`assembleLop` turns each session into worked minutes:

```ts
const minutes = s.clockOut ? Math.max(0, Math.round((+new Date(s.clockOut) - ms) / 60000)) : 0;
```

An open session (clocked in, not yet out) contributes **0**. `lopDayUnits` then reads that day as
`worked === 0`, which is `< halfDayMinutes`, and charges a **full day** of loss of pay:

```ts
if (worked === undefined || worked < halfDayMinutes) units += 1; // no punch, or too short to earn a half day
```

The comment distinguishes `undefined` ("never punched") from `0` deliberately — but `assembleLop` collapses an
open session into exactly the `0` that comment says means "punched and too short". A clock-in is positive
evidence of attendance; it is being treated as evidence of absence.

Two reachable paths, both only when `settings/attendance.lop_enabled` is on (it is off by default):

1. **A forgotten clock-out on any past day.** The punch is on record, the day reads as 0 minutes, and the
   employee is docked a full day's regular gross for a day they demonstrably attended. This also inflates
   `ncpDays` on the PF ECR (`services/statutoryReport.ts` sums the LOP line's `units`), so a statutory return
   overstates non-contributing days. Finding #14 makes this reachable **by policy** rather than by forgetfulness:
   an employee fenced out of clocking out cannot close the session at all.

2. **Building or rebuilding a run inside the period.** `assembleLop` sets
   `endYmd = periodEnd < today ? periodEnd : today`, so today is judged. Nothing in `createRun` /
   `buildRunItems` requires the period to have ended, and `runStaleness` actively invites rebuilds. A rebuild at
   15:00 on a working day therefore docks a full day for **every employee currently clocked in** — their session
   is open, so it is worth zero.

The FnF path has the same collapse (`services/settlements.ts#finalMonthLopDays`), and there the money cannot be
corrected by a later run — it is the leaver's terminal payout.

**Fix:** an open session is not zero, it is *unknown*. Either

- treat a day with an open session as unjudgeable and skip it (leave `worked` undefined only for days with no
  punch at all, and add a third state for "open"), or
- credit an open session up to `fullDayMinutes` from clock-in to `min(now, end of that day)`, which is what the
  live attendance page already shows the employee.

Whichever is chosen, `assembleLop` and `finalMonthLopDays` must choose the same thing — they are two copies of
this walk already.

---

# Third pass

## 18. The guard `searchIndex.ts` names for its one leak vector does not exist, and one entry already disagrees with its list

**Files:** `src/domain/searchIndex.ts:11-12,121-122`, `src/services/announcements.ts:91`,
`src/lib/authzResolve.ts` (`LIST_OWNER_COLUMNS`), `test/globalSearch.test.ts:225-237`

The file states its own threat model and names the test that closes it:

> `scoping` MIRRORS the collection's real list service, so a search hit is exactly a row the caller's list of
> that collection would have returned … **Getting `scoping` wrong is the one way this file can leak, so it is
> checked against the services by `test/searchIndex.test.ts`.**

**`test/searchIndex.test.ts` does not exist.** The three tests that import `SEARCH_INDEX`
(`globalSearch.test.ts`, `searchDdlDrift.test.ts`, `activityCounts.test.ts`) check something weaker: that every
declared column name resolves on the table, that a `scoped` entry's table has a `code` column, and that every
searchable collection has an entry. Nothing compares `scoping.kind` / `scoping.owner` against what the
collection's list service actually binds. The one property the header calls load-bearing is unguarded.

Cross-checking the 68 entries against `LIST_OWNER_COLUMNS` mechanically finds exactly one disagreement:

```
announcements   SEARCH_INDEX: flat          list service: applyScope(scope, code, authorEmployeeId)
```

`services/announcements.ts#visibleWhere` binds the author column, so an `own`-breadth caller's board shows
only posts they wrote. `scoping: flat` means global search applies **no row filter at all** for that same
caller — and the entry matches `title`, `bodyText`, `category` and `kind`, so ⌘K would return the title and
subtitle of every post in the org to someone whose board shows none of them.

**Not reachable on the seeded policy**, and that is why it has sat there: every role is seeded
`announcements.** (all)`, so `actorScope` answers `all` for everybody and `applyScope` binds no filter either.
It becomes live the moment an admin narrows announcements through the ACL — which is the entire purpose of the
ACL, and the one action this file's header says must never disagree with search.

The other 22 `flat` entries are genuine org-wide catalogues (holidays, leave types, shifts, projects, boards,
sprints, review cycles …) with no owner column in `LIST_OWNER_COLUMNS`; announcements is the only one with one.

**Fix:** two things, and the second is the one that matters.
1. `announcements` becomes `scoped("authorEmployeeId")`, matching `visibleWhere`.
2. Write the test the header promises: for every `SEARCH_INDEX` entry, assert `scoping` against
   `LIST_OWNER_COLUMNS` (`flat` ⇔ absent or `code`; `scoped(owner)` ⇔ the same owner; `self` ⇔ the service
   hard-pins). That is ~15 lines over two registries that already exist, and it is the same shape as
   `test/listOwnerColumns.test.ts`.

---

## 19. Two money rules are duplicated in the browser instead of imported from the domain

**Files:** `web/src/lib/utils.ts:160-167` vs `src/domain/money.ts:34-44`;
`web/src/lib/org.tsx:94-108` vs `src/domain/currency.ts:15-32`

`web/src/lib/utils.ts` carries a body-identical re-implementation of `round2`, exported as the app-wide `r2`.
The canonical one is **already in the browser bundle**: `EmployeeCompensation.tsx:59` imports
`../../../../src/domain/payroll`, which imports `./money`. So the page that does the CTC arithmetic holds both
copies at once.

`web/src/lib/org.tsx` declares its duplication out loud — *"App default minor-unit digits by ISO code (mirror
of the server's domain/currency.ts)"* — restating the 26-entry `BASE_DECIMALS` table and the `decimalsFor`
clamp as `currencyDecimals`. The two already differ in one place: with no code given, the server falls back to
`"INR"` and the browser falls back to `org.default_currency`. Not currently reachable (every server call site
passes an explicit code), but it is a divergence in a table nobody will diff again.

Both domain modules are dependency-free (`money.ts` imports nothing; `currency.ts` imports nothing), and the
SPA already imports `src/domain/leave.ts`, `src/domain/leaveRestrictions.ts`, `src/domain/attendance.ts` and
`src/domain/payroll.ts` directly. The codebase states this rule three times in three places —
`web/src/lib/leaveDays.ts` (*"not a second copy of it … two mirrors in this app have drifted from the server
while promising they matched"*), `src/domain/money.ts` (*"rounding behaviour is defined in exactly one
place"*), `src/lib/winAnsi.ts` (*"A copy per side is how one of them ends up missing the fix, so both import
this"*). These are the two that were left.

Adding a zero-decimal currency to the server table is the concrete drift: figures render at 2dp in the UI and
0dp on the payslip, with nothing failing.

A third instance of the same shape, listed for completeness rather than as a separate finding:
`web/src/lib/perm.ts:6-17` and `src/domain/access.ts:14-23` are byte-equivalent implementations of
`hasCapability`, each declaring itself a mirror of the other (*"Mirrors the backend's capabilitiesOf model"* /
*"Same matching as the frontend hasCapability (web/src/lib/perm.ts)"*). The function is pure and takes
`string[]`, so the server's is importable as-is. This one at least fails safe on drift — the client copy is
UX-only and the server re-decides every request — which is why it is a footnote and the money helpers are not.

---

## 20. `collections.ts` names a second drift gate that also does not exist

**Files:** `src/domain/collections.ts:4,76-78,127`, `src/index.ts:335`

Same shape as #18, found by the same check. A scan of every `test/…` and `e2e/…` path named in a source
comment against the files that exist returns exactly two misses, and this is the other one:

> The grant validator rejects any pattern naming a collection not in here, so a typo or a stale collection can
> never compile into authority. **Kept in lockstep with the routes + the seed grants by
> `test/collections.test.ts` (drift gate).**

`test/collections.test.ts` does not exist. Ten tests import `COLLECTIONS`; none of them holds it against the
route mounts.

What that gate would catch is not cosmetic. `COLLECTIONS` is the allow-list `isGrantCollection` enforces, so a
mounted collection missing from it cannot be named by **any** access rule — not by the seed, and not by an
admin through the ACL. It is permanently `super_admin`-only, and the ACL surface gives no hint why: the rule
is simply rejected as naming an unknown collection.

Diffing the two registries by hand: every mounted collection is present except the six aggregate transports
(`search`, `changes`, `dashboard-summary`, `approvals-summary`, `activity-counts`, `people-analytics`, which
`AGGREGATE_ROUTES` exempts from the collection decision and so correctly need no entry) — and one real one:

```
payroll-debit-accounts   mounted at src/index.ts:335, gated as an ordinary collection, absent from COLLECTIONS
```

The omission is deliberate and commented, but the comment states the weaker fact:

> the sensitive debit accounts live behind the `payroll-debit-accounts` namespace, which is **private-by-default
> (no grant names it)**, so it is NOT listed.

"No grant names it" describes the seed. Leaving it out of `COLLECTIONS` enforces something else: no grant *can*
name it, ever. Every other private-by-default collection in the app (`referrals`, `boards`, `api-keys`,
`timeline`, `export`, `audit`) is in the list and grantable through the ACL; this one is not, so
`BankFormats.tsx`'s debit-account editor is reachable only by a super admin and a `payroll_admin` cannot be
given it even deliberately. Either is a defensible product choice — but the code and the comment currently
state different ones.

**Fix:** write the gate (mounted collections minus the `AGGREGATE_ROUTES` set must be a subset of
`COLLECTIONS`, with an explicit, named exception list), and decide `payroll-debit-accounts` on purpose — either
add it and leave it ungranted, or keep it out and say in the comment that it is deliberately unnameable.

### Note on #2

Checked while here: `boards`, `cards`, `sprints`, `table-views`, `table-fields`, `approval-delegations` and
`goal-templates` ARE all in `COLLECTIONS`. So #2 is "shipped with no seeded grant", not "ungrantable" — an
admin can reach every one of them through the ACL. It still means a fresh install presents those modules as
non-existent until someone does.

---

## 21. ~~Any employee can create a company expense OWNED BY a colleague — the owner-on-create gate does not cover `expenses`~~ RETRACTED

> **RETRACTED (eighth pass).** This finding is wrong. `OWNER_REFS` DOES contain
> `expenses: { employee: { collection: "employees" } }` (`src/domain/manifests.ts:182`), and
> `services/expenses.ts:98-115` carries a second, independent check (`reachesBeyondOwnExpenses`). Both carry
> comments describing this exact attack as already closed. The claim came from a regex extraction of
> `OWNER_REFS` that stopped at the long comment block preceding the `expenses` entry, so the entry was never
> in the set I compared against. Nothing below needs fixing. See the retraction note in
> [defects-new3.md](defects-new3.md).



**Files:** `src/domain/manifests.ts` (`OWNER_REFS`), `src/services/expenses.ts:100`,
`src/routes/expenses.ts:20`, `src/middleware/authz.ts` (`bodyDecision`)

`middleware/authz.ts` states the rule and why it exists:

> **Owner-on-create (closes BOLA gap A):** a body owner field assigns who the NEW resource belongs to. The
> caller must be allowed to create under that owner — write on `<collection>.<ownerCode>` … Absent field =>
> owned by the caller (the service default), which the resource-level write grant already covers.

That gate runs only for collections listed in the policy manifest's `OWNER_REFS`. `expenses` is in **neither**
`OWNER_REFS` nor `REFERENCES`, so `bodyDecision` takes its early return (`fields.length === 0 && no refs &&
no ownerRefs && subBodyKey === null`) and **no body gating runs on an expense create at all**.

Meanwhile the route accepts the owner field and the service trusts it outright:

```ts
// routes/expenses.ts:20   (createSchema)
employee: z.string().nullable().optional(),

// services/expenses.ts:100
const employeeId = idFromPath(input.employee) ?? actor.employeeId;   // no authority check
if (!employeeId) throw invalidArgument("employee is required");
...
code: await allocOwnedCode(deps, schema.expenses, schema.expenses.employeeId, employeeId),
employeeId,
```

And the seeded grant makes the collection-level create available to everyone:

```
'employee','role','expenses','expenses','all','',NULL,'write'      <- what makes self-service create work
'employee','role','expenses','expenses.me.**','self','',NULL,'write'
```

The 1-token pattern `expenses` matches `POST /v1/expenses` → `expenses.write`, which is the whole point. So an
ordinary employee can send:

```
POST /v1/expenses  { "employee": "employees/<colleague>", "amount": 50000, "description": "..." }
```

and the row is created **owned by the colleague** — code-allocated under their code, so it lands in their own
expense list and in their manager's department view. Following it with `:submit`:

- `notifyManager(deps, row.employeeId, …)` notifies **the colleague's** manager, not the creator's;
- `emitEvent("expense.submitted", { employeeId: row.employeeId, … })` drives automations against them;
- the creator's own list is `own`-scoped, so the row is invisible to them afterwards — plant and forget.

**This is precisely the trap `leave-requests` documents and defends against**, in the same file family:

> IT IS A QUESTION ABOUT AUTHORITY, NOT ABOUT THE BODY. Naming another employee in the payload is something
> any caller can do — the create gate on this collection is collection-level (`leave-requests: write` is how
> self-service works), so it decides nothing about WHOSE leave is being filed. Reading the exemption off the
> payload alone therefore handed every employee a way to file leave that skips the org's notice policy, by
> addressing it to a colleague.

`leave-requests` has BOTH defences (an `OWNER_REFS` entry *and* `reachesBeyondOwnRows(actor)` in the service).
`reimbursements` — the personal-money sibling with the identical grant shape — has the `OWNER_REFS` entry.
`expenses` has neither.

Cross-checking `LIST_OWNER_COLUMNS` against `OWNER_REFS` finds twelve owner-scoped collections with no entry;
eleven are fine and most say why (`loans` is the model: *"SELF-SERVICE ONLY … the service forces self, so
`loans` carries no owner_ref to gate"*, and it throws on a mismatched `employee`). `attendance`, `payslips`,
`leave-balances`, `reviews`, `review-feedback`, `users`, `document-acknowledgements`, `transition-tasks` have
no caller-facing create at all; `table-views` forces `ownerId: actor.employeeId`; `assets` takes `assigned_to`
but only `assets.**` holders can create one. `expenses` is the only live gap.

**Fix (either, preferably both):**
1. Add `expenses: { employee: { collection: "employees" } }` to `OWNER_REFS` — one line, and the middleware
   then requires write on `expenses.<ownerCode>`, which `expenses.me.**` satisfies for self and nothing else
   satisfies for a colleague.
2. Give `createExpense` the `leave-requests` guard: take `input.employee` only when
   `scopeFor(actor, "expenses").breadth !== "own"`, else force `actor.employeeId`.

And a test: for every collection whose create schema accepts an owner-shaped ref, assert either an `OWNER_REFS`
entry or a service that forces self. That is the same registry cross-check as #3, #18 and #20.

---

# Fourth pass

## 22. Three collections the app masks from session replay as too sensitive are still written to disk in plaintext

**Files:** `web/src/lib/resourceStore.ts:40-86` (`MEMORY_ONLY`), `web/src/instrument.ts:53-76`
(`SENSITIVE_PAGES`), `test/replayMaskDrift.test.ts`, `web/src/lib/clientStore.ts:63-68`

The app maintains two sensitivity lists and states, in the drift test's own header, that they should agree:

> MEMORY_ONLY … is the set of collections whose rows may never be written to disk, because they are "a copy of
> the most sensitive data the system holds, in plaintext, on a machine the org may not own". Session replay
> ships the same data one hop further — to a third party, with retention — **so the two sets should agree.
> Where they disagree, somebody decided a collection was too sensitive to store and nobody decided it was too
> sensitive to record.**

`test/replayMaskDrift.test.ts` enforces that in **one direction only**: every `MEMORY_ONLY` collection must be
masked. The converse — every collection judged too sensitive to *record* must also be too sensitive to
*store* — is not asserted, and that is where the two lists have come apart:

```
SENSITIVE_PAGES  minus  MEMORY_ONLY   =   reviews, check-ins, suggestions   (+ "documents", a page name
                                                                              whose collections ARE listed)
```

Each was put on `SENSITIVE_PAGES` with an explicit reason, and each is read through `useCollection` — i.e.
through the store, so `persistable()` writes it to IndexedDB for up to `MAX_AGE_MS.rows` = **7 days**:

| collection | why it is masked from replay (instrument.ts) | on disk |
|---|---|---|
| `check-ins` | *"Private 1:1s. The notes are written on the understanding that the two people in the room are the readers."* | yes |
| `reviews` (+ `review-feedback`) | *"Ratings and written assessments, plus 360 feedback, whose whole design is that the subject cannot attribute it"* | yes |
| `suggestions` | *"Anonymity is a PRODUCT PROMISE … the one place that promise can be broken"* | yes |

`check-ins` is the sharpest. `toCheckInResource` (`src/http/serialize.ts:899-921`) goes to real trouble over
`private_note` — *"served to the ONE person who wrote it and to nobody else — not to the other party, not to an
HR admin who can read the row, not to a manager reading down the chain. Redacting here rather than in the query
is deliberate, so there is no path that forgets."* That field is then written to the browser profile in
plaintext, where it outlives the session, survives sign-out (`purgeCachedData` runs on 401/sign-out, but not
on a tab simply closing), and is readable by anything with access to that profile. A manager's laptop holds
their private notes on every report for a week.

`reviews` is the same shape one step over: `manager_comment`, `overall_rating`, `ratings` and `goal_ratings`
are served only when `_managerVisible`, i.e. deliberately withheld from the employee until the review is
shared — and then stored on whatever machine the manager or HR opened the page on.

`resourceStore.ts` already records that this exact omission happened once before, for this exact reason, on
`offers`:

> It was persistable only because the rule above was applied by remembering, and the test that pins this set
> asserts a hand-written allowlist, so nothing caught it.

**Fix:** add `check-ins`, `reviews`, `review-feedback` and `suggestions` to `MEMORY_ONLY` (they are read on one
page each — plus the Dashboard for two of them — so the cache buys little), and extend
`replayMaskDrift.test.ts` to run in both directions: every `SENSITIVE_PAGES` route's collections must be in
`MEMORY_ONLY`, with named exceptions carrying their reason, exactly as `EXEMPT` already does for the other
direction. That is the property the one-way test cannot have.

---

## 23. `payroll-runs:bankFile` is classified as a read, but it irreversibly locks the run

**Files:** `src/domain/auditAccess.ts:66-88` (`READ_VERBS`), `src/services/bankFile.ts:167-169`,
`src/services/payroll.ts:1255`

`READ_VERBS` is the set the write-audit backstop skips, and it defines itself precisely:

> Custom methods that READ — they produce output (bytes, a report, a metric) and **change no state** … This set
> is a **STRUCTURAL fact about each handler (does it change state?)**, not policy.

…and it names this verb as the worked example of why the set exists: *"the write backstop below must exclude
them or it would log a read as a write ('HR bank-filed a payroll run')"*.

`buildBankFile` changes state:

```ts
// services/bankFile.ts:167 — "Stamp the first generation. Handing the file to the bank is where the money
// actually leaves, and deleting a run RELEASES every payable it paid back into the queue."
if (!run.bankFileAt) {
  await deps.db.update(schema.payrollRuns).set({ bankFileAt: new Date() })...
}
```

and that stamp is load-bearing and irreversible: `services/payroll.ts:1255` refuses to delete a stamped run
(*"a bank payout file was already generated for this run, so it may already have been paid; it cannot be
deleted"*), and `PayrollRuns.tsx:483` hides the delete control on it.

I walked every entry in `READ_VERBS` for a DB write; this is the only one. The other twenty are genuine reads
(`downloadAttachment` is `getAttachment` + an R2 get; `boardMetrics` is a select; the photo/celebration/preview
handlers write nothing).

**Not a missing trail.** `payroll-runs:bankFile` is in `AUDIT.sensitive_verbs`, so `accessAudit` does write a
row, anchored on the run, with `meta.field = ":bankFile"`. The gap is its TYPE: the action is
`payroll-runs.read.sensitive`. Someone reading the trail to answer *"who locked this run, and when"* — which is
the question `bankFileAt` exists to make answerable — finds a read event, and any filter or alert keyed on
writes misses it entirely.

**Fix:** either move the stamp out of the download path into an explicit verb (`:markBankFiled`, which then
audits as a write), or drop `payroll-runs:bankFile` from `READ_VERBS` so the backstop logs
`payroll-runs.bankFile` as the mutation it is — the `.read.sensitive` row is already separate, so both would be
recorded, which is the honest answer for a call that both streams every employee's account number and locks
the run.

---

# Fifth pass

## 24. Letter generation lets the caller overwrite any derived placeholder, including the CTC figure the code deliberately withholds

**Files:** `src/domain/letters.ts:233-234`, `src/routes/letterGenerate.ts:34,50-52,96-104`

`resolveLetter` builds the placeholder map from the database — name, employee number, dates, role change,
CTC, increment, bonus, settlement — and then, as its **last** assignment, spreads the caller's request body
over it, unfiltered:

```ts
if (ctx.comp)       { v.ctc_annual = inr(...); v.ctc_monthly = ...; v.ctc_in_words = ...; }
if (ctx.increment)  { v.inc_old_annual = ...; v.inc_new_annual = ...; ... }
if (ctx.settlement) { v.settlement_net = ...; v.settlement_net_words = ...; }
// HR-provided inputs (for custom letters) become placeholders too; single-line values are usable as {{key}}.
for (const [k, val] of Object.entries(input)) if (typeof val === "string") v[k] = val;   // ← last write wins
```

The route accepts **arbitrary keys** — `input: z.record(z.string(), z.string().max(20_000))`, up to 200 of
them — and never filters them against the template's own declared `inputs` (`LetterTemplate.inputs`,
`domain/letters.ts:114`, which exists precisely to name the fields HR fills in).

So `{{ctc_annual}}`, `{{settlement_net}}`, `{{inc_new_annual}}`, `{{employee_name}}`, `{{employee_number}}`
and `{{signatory_name}}` are all caller-settable on a letter that is then rendered, filed as the employee's
`personal-documents` row, frozen for re-render (`freezeLetterContent`), and optionally sent for **Aadhaar
e-signature**. Whatever was supplied becomes the authoritative, signed record.

**It defeats a control the file next to it states explicitly.** `routes/letterGenerate.ts:50-51`:

> The caller rides along so the CTC blocks are dropped for anyone without a compensation grant — **the letter
> still generates, it just cannot state a figure its author may not read** (see services/letterData.ts).

`assembleLetterContext` leaves `ctx.comp` undefined for such an author, so `v.ctc_annual` is never set and a
`requires: ctc` block is dropped. But an inline `{{ctc_annual}}` in ordinary body text resolves from `v` — and
`v.ctc_annual` is whatever `input.ctc_annual` said. The author supplies the figure they were not allowed to
read, and the letter states it.

**The boundary it crosses is a seeded one, not a hypothetical.** `services/letterData.ts:23-29` spells it out:

> THE ACTOR IS NOT OPTIONAL DECORATION … The seeded `hr_admin` grant deliberately holds NO compensation entry
> (domain/grants.ts says so in the grant itself: *"comp catalogs are payroll-authored; HR reads for
> letters/requisitions"*) … anyone who could generate a letter could read anyone's CTC through one, with no
> compensation grant anywhere.

Checked against the seed: `compensation` is granted to **`payroll_admin` only** — no `hr_admin` row exists.
`hr_admin` holds `personal-documents.**`, which is what matches `personal-documents.generateLetter`. So the
separation the app ships with is: HR issues letters, payroll owns salary figures.

This is **not** a read bypass — `mayReadComp` is false, so the author still cannot learn the real CTC. It is an
**integrity** bypass in the other direction: that same `hr_admin` can author an official CTC, increment or
settlement letter stating any figure they choose, filed as the employee's record, frozen for re-render, and
sent for Aadhaar e-signature. The control's stated purpose is that a letter *"cannot state a figure its author
may not read"*; the author can state one. The audit trail records a letter generation, not that a derived
placeholder was overridden.

(Ordinary employees cannot reach it: the verb needs `personal-documents.**` or `**`, plus a per-template
`canReadObjectId` gate. `routes/letterPreview.ts:55` passes `input` through the same `resolveLetter`, so it
shares the shape — but it renders without persisting, and the fix below is in the shared function.)

**Fix (any one closes it; the first is one line):**
1. Assign `input` **first**, before the derived values, so a derived placeholder always wins.
2. Filter `input` to the keys the template declares: `const declared = new Set((template.inputs ?? []).map(i => i.key))`.
3. Namespace them — `{{input.foo}}` — so the two spaces cannot collide at all.

Option 2 is the one that matches the model already in the file, and it also turns a typo'd input key into a
visible no-op rather than a silent override of something else.

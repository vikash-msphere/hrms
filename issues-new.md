# Pre-production review - round 4

Findings are appended here as they are found. Numbering continues from `issues.md` (which ended at 43,
all applied). Same format: severity, location, the evidence, then the fix.

44-65 are applied.

---

44. MEDIUM — acknowledging a policy twice files two signed copies: the idempotency is a read-then-write with nothing claiming it

src/services/documentService.ts:269-296, :318-330 · src/db/schema.ts:608

288:    const existing = (await deps.db.select().from(schema.documentAcknowledgements).where(eq(...documentId, id)))
289:      .find((a) => a.employeeId === employeeId && a.version === version && !a.deleteTime);
290:    if (existing) { ... return ... }

That read is the whole of the idempotency ("Idempotency per (doc, employee, version)"), and nothing backs it:
`document_acknowledgements` carries three plain indexes and no UNIQUE on (document_id, employee_id, version)
(schema.ts:608), and the four writes that follow - the stamped PDF into R2, the `personal_documents` copy, the
ack row, and on the vendor path the e-sign request - are unguarded. Two calls that both miss `existing` both
proceed.

The dialog itself does guard a double-click (`busy`, SignDocumentDialog.tsx:113) and `invoke` is a POST so
api.ts never retries it - so the reachable triggers are the ones a single button cannot see: the same person in
two tabs or on two devices, and the Aadhaar path's own resume (a pending ack is re-entered from the queue).
When it happens, two stamped copies of the same policy land in the employee's document file, each
`locked: true` (so neither can be tidied away by an ordinary edit), with two ack rows for one version. On the
Aadhaar path it is worse than untidy - each call fires `provider.createRequest`, which is a paid vendor
transaction and a second signing link to a signer who only ever agreed to sign once.

Every other flip in this codebase that must happen once says so in SQL: the expense/loan/leave transitions
guard on the from-state (`where(and(eq(uuid), eq(state, <from>)))` - services/expenses.ts calls the section
"Workflow transitions (all guarded exactly-once flips)"), `comp_off_credits` carries a unique (employee, date)
under a comment explaining that the read is only a probe and the index is what makes it true, and the
attendance clock leans on `att_open_emp_idx`. This is the same shape with neither half.

Fix: a UNIQUE index on (document_id, employee_id, version) - the schema's own pattern for "this may exist once"
- and insert the ack FIRST, treating a constraint violation as "already acknowledged" (services/compOff.ts and
services/attendance.ts both show the shape, and lib/errors.ts already has the collision predicates). The copy
and the vendor call then happen only for the caller who won the insert.

---

45. LOW-MEDIUM — that same read scans every acknowledgement the document has ever collected, to find one row

src/services/documentService.ts:288

`where(eq(documentAcknowledgements.documentId, id))` returns one row per employee per version - for an
org-wide policy that is the whole company, and every version of it - and the caller's own row is then found in
JS. `:acknowledge` is called by every employee for every policy that requires signing, so the read grows with
headcount x versions on the one path everybody walks.

`decorateAck` twenty lines above narrows by `employeeId` in SQL for exactly this reason, and the index that
would serve it (`dack_emp_idx` on (employee_id, created_at, uuid)) already exists.

Fix: `and(eq(documentId, id), eq(employeeId, employeeId))`, and keep the version/delete filter in JS (one or
two rows).

---

46. LOW — the leave dialog carries a second copy of the chargeable-days rule, the same duplication just removed twice elsewhere

web/src/lib/leaveDays.ts:5-28 · src/domain/leave.ts#leaveDays · web/src/components/common/RequestLeaveDialog.tsx:175, :181, :297

leaveDays.ts:1: // Chargeable leave days for a date range + sessions (mirrors the server's domain/leave.ts).

The two implementations agree today - same working-day set, same 0 / 0.5 / 1 day value, same `Math.min(0.5,
valueOf(boundary))` session shave, same half-day rounding - so this is not a live defect. It is the shape that
has produced two of them already: `advanceRecurrence` in Expenses.tsx ("the copy rolled end-of-month overflow
forward where the server clamps it, so the schedule disagreed with itself before it had run once"), and the
CTC solver in EmployeeCompensation.tsx, whose copy silently diverged at the ESI and PF ceilings while its
comment promised it matched.

What makes this one worth closing rather than watching: the number it produces is what the employee is shown
before they commit, and it is compared against their balance (`availableFor`, :200) to tell them whether they
can afford the request. A drift here is "the app said 2 days, payroll charged 2.5" on a balance that is
encashable for cash at exit. The server function is pure (`domain/leave.ts` imports only `round2`), takes the
same arguments, and is already imported into the web bundle from a sibling module (`leaveCover`, in
web/src/lib/attendance.ts, was moved this way for exactly this reason).

Fix: export `leaveDays` from the domain (it already is), call it from `chargeableDays` with the ms bounds the
dialog already computes, and keep only the null-guard wrapper.

---

47. MEDIUM — switching from one employee's profile to another can leave the first employee's salary, bank or tax data on screen under the second one's name

web/src/App.tsx:522 · web/src/pages/EmployeeProfile.tsx:489, :106 · nine loaders, e.g.
web/src/components/common/EmployeeBankDetails.tsx:43, EmployeeCompensation.tsx:132, EmployeeTaxDetails.tsx:38

EmployeeCompensation.tsx:132:  const load = useCallback(async () => {
133:      const r = await get<{ results: Compensation[] }>(`compensation?employee=...${employeeId}`);
134:      setRows(r.results ?? []);
136:      try { const b = await get<...>(`bonuses?employee=...${employeeId}`); setBonuses(b.results ?? []); } ...
137:      try { const t = await get<...>(`employees/${employeeId}/tax`); setMonthlyTds(...); } ...
144:  useEffect(() => { void load(); }, [load]);

Nothing cancels a load that has been superseded, and the profile does not remount between employees.
App.tsx:522 renders `<EmployeeProfile id={route.id} …>` with no `key`, so navigating `#/employees/A` ->
`#/employees/B` re-renders the SAME mounted tree with a new prop; the page resolves its employee out of the
cached directory (`useCollection("employees")`), so it paints immediately rather than unmounting its children
while it fetches. Each tab component therefore just sees `employeeId` change, re-runs its effect, and now has
two requests in flight for two different people with no way to tell which answer belongs to the current one.
The last response to land wins.

The components this affects are exactly the sensitive ones - every one of them loads by `employeeId` through a
`useCallback` with no cancellation flag:

  EmployeeBankDetails:43, EmployeeCompensation:132, EmployeeTaxDetails:38, EmployeeIdentityDetails:30,
  EmployeePersonalDetails:29, EmployeeBonuses:42, EmployeeSettlement:36, EmployeeRoleHistory:37,
  EmployeeProfilePersonal:51

The compensation one is the worst of them because it awaits three times in sequence and writes state after
each: a switch mid-flight can leave a MIXED card - person A's salary history beside person B's variable pay
and projected tax - which reads as a coherent record of one person and is a record of neither. Nothing here
is a disclosure to an unauthorised viewer (the caller holds the grant for both profiles, or the request 403s),
and that is the whole reason it would go unnoticed: the page shows plausible numbers under the wrong name, on
the surface where somebody decides a raise.

The app already knows the shape. web/src/components/common/SignedPdfViewer.tsx runs `let cancelled = false`
with a cleanup that flips it, and every store-backed read goes through `useCollection`, whose entry is keyed
by collection+params so an answer can only ever land on the key it was asked for. These nine bypass the store
because they read bespoke endpoints.

Fix, per component: the standard guard - `useEffect(() => { let live = true; void load(v => { if (live) set(v)
}); return () => { live = false; }; }, [load])` - or give `EmployeeProfile` a `key={id}` at the App.tsx mount
so a different person is a different component instance, which fixes all nine at once and costs a remount per
navigation. The key is the smaller change; the guards are the more precise one.

---

48. LOW-MEDIUM — rejecting or cancelling leave flips the state and refunds the balance as two separate writes, and the exactly-once guard makes the failure unrecoverable

src/services/leaveRequests.ts:328-361

353:  const [updated] = await deps.db
354:    .update(schema.leaveRequests)
355:    .set({ state: to, decidedBy: actor.uuid, updatedAt: new Date() })
356:    .where(and(eq(schema.leaveRequests.uuid, id), eq(schema.leaveRequests.state, from)))
357:    .returning();
358:  if (!updated) throw failedPrecondition("request was already decided");
360:  if (to === "REJECTED" || to === "CANCELLED") await adjustLeaveBalance(deps, row.employeeId, row.leaveTypeId, row.days);

The flip is a proper exactly-once guard and says so ("leave days are encashable = money, so a double refund is
a real payout"). The refund is the statement after it, outside any batch. If that second statement does not
run - a D1 error, the invocation running out of subrequests, the isolate going away - the request is CANCELLED
and the days are simply gone.

And the guard is what makes it permanent. A retry re-reads the row, finds it is no longer `from`, and throws
"request was already decided", so the refund can never be attempted again; there is no reconciliation pass over
leave balances anywhere (the accrual job only ever adds). The only repair is somebody editing the balance by
hand, which is the thing this app's money paths are written to avoid.

The direction matters: this loses the EMPLOYEE's days, quietly, on the action they take when they decide not to
go away after all. The create path two functions up is careful about exactly this class - it inserts, then
checks, then reserves, and unwinds the row it just made if the reserve matches nothing - so the reasoning is
present in the file; it just stops at the decision path.

Every comparable pair in the codebase is one batch: services/settlements.ts commits the settlement row and
every payable marker together ("a failure part-way left payables both consumed and unpayable"), the payroll
build releases and rebuilds in one `runBatch`, and services/compOff.ts writes the claim and the credit
together.

Fix: `runBatch` the state flip and the balance refund, with the flip as a CheckedStmt (`expect: 1`) so a lost
race still aborts the group rather than refunding a request somebody else decided - the shape
`runBatchChecked` already provides and settlements already uses.

---

49. LOW-MEDIUM — nothing bounds the size of a settings value, and every request reads the whole settings table

src/services/settings.ts:95-119 · src/lib/refData.ts:49 · src/routes/settings.ts:225 (validateOrganization)
· web/src/pages/Settings.tsx:540-541

refData.ts:49: export const refSettings = (deps: Deps) => once(deps, "settings", () => deps.db.select().from(schema.settings));

`upsertSetting` writes whatever JSON it is handed - no length check anywhere in the write path, and no per-key
validator checks one either. The only ceiling is the global body limit, `MAX_DOCUMENT_BYTES` = 10 MB
(middleware/bodyLimit.ts), which is sized for uploading a PDF, not for a config row.

That would be a curiosity except for how settings are read: `refSettings` selects the WHOLE table - every key,
every value - and it is the read behind `getSettingValue`, so essentially every request in the app pulls it
(the org's calendar day comes from `settings/attendance`, the serializers read `organization`, payroll reads
five keys). D1 bills rows read by their bytes. One oversized `settings/organization` therefore taxes every
request in the system, permanently, until somebody edits it back.

And `organization` is exactly where the bulk would go: the org logos and the favicon are stored INSIDE that
blob as data URLs. The SPA caps them - `MAX_LOGO_BYTES` 256 KB, `MAX_FAVICON_BYTES` 64 KB
(web/src/pages/Settings.tsx:540) - and the server does not check either, so the limit holds only for people
using the form. It is also the cap the client's own disk cache believes in: lib/clientStore.ts refuses to
store a `snapshot` record over 256 KB, so an org blob past that is silently never cached and costs a read on
every page load as well.

Nothing here is an escalation - it needs `config.write`. It is the same class the body limit exists for, said
in that file: "Cloudflare admits bodies far larger than anything this app wants against a 128 MiB isolate, so
'reject once the buffer exists' is not a cap, it is a report."

Fix: a size ceiling in `upsertSetting` (the serialized JSON is already in hand as `json`), generous enough for
a letterhead-bearing `organization` blob and far under the body limit, plus the logo/favicon byte checks
mirrored into `validateOrganization` so the form's limits are the app's limits.

---

50. LOW — the workflow template exposes internal primary keys as `{{subject}}` / `{{employeeId}}` / `{{actorId}}`, and email is outside the edge that would have hidden them

src/domain/automations.ts:38-59 (resolveField roots) · src/services/automationEngine.ts:155-190 (template /
templateHtml) · src/services/automationEngine.ts:350-372 (the `email` and `emailAudience` actions)

automations.ts:39: const roots = { type, subject: ctx.subject, actorId: ctx.actorId, employeeId: ctx.employeeId, payload, results, now, today };

Those three roots hold INTERNAL ids. Events are emitted with them - `emitEvent(..., { subject:
`leave-requests/${id}`, employeeId: row.employeeId })` - because everything server-side works in internal ids
and the outbound JSON edge tokenizes them on the way out (middleware/encodeWireIds.ts).

An email never reaches that edge. `deps.email.send` is an outbound fetch, so a rule whose body contains
`{{subject}}` mails `leave-requests/<13-char internal id>` to whoever it is addressed to - and the `email`
action's recipient may be a literal `{of: "address"}`, i.e. anybody. The in-app lane leaks a narrower version:
`{{employeeId}}` resolves to a BARE uuid, and the response encoder only rewrites strings shaped
`<collection>/<id>`, so a bare one is published as-is in the notification body.

This is the rule src/lib/ics.ts states at length after the same thing happened there: "A UID travels further
than almost anything else this app emits ... so the internal primary key the wire codec exists to keep off the
wire was being published to people outside the org and stored in their calendar clients. Authz decides by
CODE, so this was disclosure rather than a way in." Identical here, with a mail client instead of a calendar
client.

It needs a rule author to write the placeholder (authoring email actions is super-only), so it is a foot-gun
rather than a default - which is why it is LOW and not higher.

Fix: resolve `subject` through the codec for template use (the engine has `deps.idCodec`), or drop the raw
roots from the template vocabulary and expose a `{{subjectLink}}` that is already tokenized - the same
treatment `pushLink` (services/notifications.ts:30) gives the one other lane that leaves without passing the
edge.

---

51. LOW-MEDIUM — the team attendance grid marks people ABSENT when their approved leave fell past the first page, and sorts them to the top

web/src/pages/Attendance.tsx:146, :149, :481-491, :543, :1495 · web/src/hooks/useCollection.ts (`all`)

149:  const { rows: leaves } = useCollection<LeaveRequest>("leave-requests");
481:  const approvedLeaveByEmp = useMemo(() => { ... for (const l of leaves) ... }, [leaves]);
543:  const empRows = buildRows(byEmp.get(id) ?? [], { from, to, leaves: approvedLeaveByEmp.get(id) ?? [], joined: e.start_date });

Both feeds are one server page. `employees` (146) is the grid's roster, so an org past 100 people simply has
rows missing - which the page does warn about (:1495). `leave-requests` (149) is the part the warning does not
really cover: it is the 100 most recently created requests in the WHOLE org, and it is what tells the grid
which days are excused. Anybody whose approved leave is older than that window arrives at `buildRows` with an
empty range list, and `buildAttendanceRows` then classifies each of their leave days as `absent`.

So the failure is not "a row is missing", it is "a row that IS shown says something false about somebody who
is on holiday". It then compounds twice: `statsOf` counts those days into the person's absence total, and the
grid is deliberately sorted worst-first ("the rows a manager has to act on lead"), so the people wrongly marked
absent are placed at the top of the list a manager is being asked to act on. The one line of warning text -
"some people or leave days may be missing" - is true and does not describe that.

`useCollection`'s `all: true` exists for precisely this shape, and says so: "a picker that cannot offer the
hundred-and-first employee, a `new Map(employees.map(...))` name lookup that renders 'Employee' for everyone
past the page, a grid with one row per person. Those are not list pages - there is no 'load more' for a reader
to press and nothing on screen that reads as incomplete - so the fetch has to be the one that completes
itself."

Fix: `{ all: true }` on the roster and, for the leave feed, either `all: true` or a server-side narrowing to
the window the grid is showing (`leave-requests` already takes filters, and the grid knows `fromYmd`/`toYmd`).
The window is the better shape: it is bounded by the period on screen rather than by the org's whole history.

---

52. LOW — seven call sites ask for more than a page and are silently given one; the settings snapshot is the one where that becomes a correctness cliff

web/src/api.ts:375 · web/src/lib/resourceStore.ts:195 · callers: web/src/lib/settingsStore.ts:106,
web/src/pages/OrgChart.tsx:93, web/src/pages/LeaveCalendar.tsx:133, web/src/pages/Operations.tsx:65-66,
web/src/lib/tabActivity.ts:33, web/src/lib/prefs.ts:20

api.ts:375:  const params = new URLSearchParams({ max_page_size: String(Math.min(opts.max ?? 100, 100)) });
resourceStore.ts:195: ... &m=${Math.min(opts.max ?? 100, 100)}& ...

The clamp is right (the server caps at 100 anyway - `clampPageSize`) and the store even explains why it mirrors
it: "two callers that differ only in an over-100 `max` share one cache entry instead of each minting a key for
a page neither can get." What is missing is that the clamp is SILENT, so seven callers were written in the
belief that they had raised the window:

  settingsStore.ts:106   list("settings", { max: 200 })
  OrgChart.tsx:93        useCollection("leave-requests", { max: 500 })   // the "who is off" overlay
  LeaveCalendar.tsx:133  max: 500
  Operations.tsx:65-66   cron-runs / operations, max: 200               // the ops history page
  tabActivity.ts:33      max: 200
  prefs.ts:20            list("preferences", { max: 200 })

api.ts:466 already documents this exact trap for a different lane, in these words: "`max_page_size=500`, which
the server clamps to 100 (http/pagination.ts) without saying so". The same sentence is true of these seven and
nothing says so at any of them.

Most are cosmetic today (an ops page that shows 100 rows where it says 200). `settingsStore` is not: it takes
one page and follows no cursor, so once an org holds more than 100 settings rows, whichever keys fall past the
page simply read as unset and every consumer silently falls back to its default - an org policy that is
configured and not applied, which is the failure mode `getSettingValue`'s own header calls out. The app reads
about two dozen keys today, so this is a cliff rather than a present defect, and it is invisible right up to
the edge of it.

Fix: make the ceiling loud rather than silent - `useCollection`/`list` should either follow the cursor when
asked for more than a page (the `all: true` machinery already does exactly this) or refuse an over-100 `max` in
development so the belief cannot form. `settingsStore.fetchAll` should walk the cursor unconditionally: it is
the config snapshot, and a partial one is worse than a slow one.

---

53. LOW-MEDIUM — reassigning or re-routing a ticket deletes any per-object access rule an admin wrote for that ticket, at whatever level it granted, and records nothing

src/services/ticketShares.ts:24-59 · src/services/tickets.ts:245, :251, :272, :276 ·
src/services/accessRules.ts (createAccessRule / buildPattern)

ticketShares.ts:48: export async function revokeTicketRead(deps, ticketCode, userUuid) {
50:   await deps.db.delete(schema.accessRules).where(and(
51:     eq(subject, userUuid), eq(subjectKind, "user"), eq(pattern, `tickets.${code}.**`), eq(effect, "allow")));

The category-viewer machinery writes and deletes rows in `access_rules` directly, and the row it writes is - in
its own words - "byte-identical to what `createAccessRule` produces for a `scope:exact, level:read` user rule".
That is the problem on the way back out: the delete matches on (subject, kind, pattern, effect) and has no way
to tell a share it created from a grant a person authored in the ACL modal, because there is no difference
between them in the table.

So an admin who grants somebody access to one ticket through the ACL has that grant deleted by the next
routine `:assign` or `:route` that drops the same person from the category/department viewer set
(tickets.ts:251, :276).

LEVEL IS NOT IN THE PREDICATE either. `createAccessRule` dedupes at (subject, subjectKind, pattern, effect) -
"Editing a level = delete the old rule then create the new one" - so one row carries whatever level was
granted, and this delete removes it whatever that level is. A hand-granted `write` on a ticket is taken away by
a reassignment just as readily as a read.

And none of it is recorded. Every ACL-authored rule write and delete audits (`access-rule.create` /
`access-rule.delete`, with `ruleMeta`); these four call sites write and delete the same table with no audit
entry at all, so "why can this person no longer see the ticket" has no answer in the trail. The purge path
takes the opposite care over the same question - softDelete.ts removes only rules whose `match_code` names the
purged object and explains at length why a SUBTREE rule is left alone, "because it is a scope an admin
declared ... so removing it would be destroying a grant, not tidying a dangling one". That is exactly what is
happening here.

Fix: mark the rows this machinery owns so it can recognise them - a dedicated `subject_kind`/namespace, or a
`source` column defaulting to "acl" and set to "ticket-share" here - and scope both the dedupe and the delete
to that mark. Audit the two writes at minimum, since they change who can read a record.

---

54. MEDIUM — the audit deny-list closed the generic walk and left the hand-written half open: eight services still copy user-written text straight into `audit_log.meta`, including the one case the earlier ledger named

src/lib/audit.ts:91-110, :278, :340 (AUDIT_DENY, and where it applies) · the call sites:

  src/services/reviewFeedback.ts:199   a 360 nominee's DECLINE REASON
  src/services/reviews.ts:464          the employee's acknowledgement comment on their own review
  src/services/tickets.ts:297          a ticket comment (140 chars)
  src/services/goals.ts:1013, :1112    a goal comment, and the "request changes" reason
  src/services/cards.ts:413            a card comment
  src/services/announcements.ts:557    a board reply
  src/services/events.ts:159           an RSVP note - the one that is not even truncated

`AUDIT_DENY` is consulted in exactly two places, `rowValues` (:278) and `fieldDiff` (:340) - the GENERIC walk
over a row or a patch. Every site above passes `meta` explicitly (`{ note: text }`, or `stateMeta(..., { note
})`), which never goes near that list. So the fix for finding 14 covered the columns a generic update would
have picked up and did not cover the values a service hands over by name.

The earlier ledger already named one of these while describing a different problem. Finding 25, on the
activity search, says the meta blob carries "the private 1:1 notes (employeeNote / counterpartNote), a 360
nominee's decline reason (reviewFeedback.ts:199), and whatever else fieldDiff lets through" - and then
`like(auditLog.meta, '%q%')` makes all of it substring-searchable by anyone holding `activity`. The check-in
notes were closed; the decline reason is still there, and it is the one with an anonymity promise attached
(services/reviewFeedback.ts and the serializer go to some length to keep a peer's identity off the reviewee's
copy; the trail then records who declined and why, in their own words).

`reviews.ts:464` is the other one worth naming: the acknowledgement comment is what an employee writes back
about their own performance review, which the review serializer treats as narrow all the way through.

The rule this breaks is the one stated over `AUDIT_DENY` itself: "material whose own access control lives
somewhere else must not be copied here", and beside it, "What a person did still lands in the trail - the
action, the row, the actor - it is only the VALUES that stay on the record."

AND THE CODEBASE HAS ALREADY AGREED THAT THIS PARTICULAR VALUE IS SENSITIVE. The activity search was changed to
stop grepping `meta`, and the comment explaining why names the same field: "`meta` carries the from/to VALUES
of whatever columns the global audit filters do not exclude - a nominee's decline reason, a comment, whatever a
new table's `fieldDiff` lets through. `audit_log` is already readable by a wider set than the records it
describes ... a substring search ACROSS that column turns 'stored somewhere wider' into 'greppable by anyone
holding `activity` on a collection'" (services/activity.ts:18-26). That fix removed the haystack and, in its
own words, left the needle: "Whatever is in meta is still shown on the entry it belongs to." So the decision
that this material is too narrow for a wide table has been taken; only half of it has been carried out.

Fix: the same treatment `fieldsMeta` already gives a patch - record that a note was written and how long it
was, not what it said. Where a snippet genuinely helps the feed read (a board reply), gate it per collection
the way `DIFFABLE_BLOBS` opts in, rather than leaving it to each call site to remember.

---

55. MEDIUM — the date printed on a self-signed letter is the UTC day, not the org's, and the row is locked immediately afterwards

src/services/letterSign.ts:42, :52-58 · src/lib/pdfPrimitives.ts:92 · cf. src/services/documentService.ts:315

letterSign.ts:42:  const date = formatLongDate(new Date());
pdfPrimitives.ts:92: return `${d.getUTCDate()} ${LONG_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

`formatLongDate` reads its parts with `getUTC*`, so the date drawn into the signature block is the UTC calendar
day of the instant the request arrived. East of UTC that is yesterday for the first hours of the working day -
in IST, anything signed before 05:30. The document is then rendered, written to R2 and the row is stamped
`locked: true` in the same function, so the wrong date is permanent on the face of a signed letter: an offer
acceptance, a contract, a policy undertaking.

The twin of this was fixed in the acknowledgement path and the fix says it was the last one:

  documentService.ts:315  `date: await orgToday(deps)`
  "The date printed ON the signature is the ORG's calendar day, not UTC. This is the last place in the app that
   derived a 'today' from the UTC clock (services/orgDay.ts explains why the rest moved off it), and it is the
   worst one to leave: the stamp is baked into a PDF that is then LOCKED, so an acknowledgement signed before
   05:30 in IST carried yesterday's date on the face of the document, for good, on the one record whose whole
   purpose is to say when somebody signed."

Every word of that applies here; this is the same act on the other collection, and it was missed.

Secondary, in the same function: the guard is a read (`if (row.signedTime) throw`) and the write that follows
has no `signedTime is null` in its WHERE (:55), so two concurrent signs both render and both `docs.put` the
same key. Harmless in content (same signer, same bytes) and worth closing with the rest of the exactly-once
family rather than on its own.

AND IT IS NOT ONLY THIS DOCUMENT. `formatLongDate(new Date())` - "today, read in UTC" - is drawn onto three
generated documents:

  src/services/letterSign.ts:42   the signature date on a signed letter (locked immediately after)
  src/services/form16.ts:113      the date on a FORM 16 Part B, the statutory tax certificate issued to an
                                  employee and filed with their return
  src/services/reviews.ts:606     the date on a review PDF

(letterheads.ts:305 does the same for a PREVIEW sample, which is cosmetic. Where the same function formats a
STORED date-only column - reviews.ts:512, :599 - reading it with `getUTC*` is correct and must stay.)

Fix: `date: await orgToday(deps)` formatted the same way the ack path formats it, at all three sites, and add
`isNull(schema.personalDocuments.signedTime)` to the sign update's WHERE.

---

56. MEDIUM — the prior-employer verification has the maker-checker rule and not the version guard: HR verifies whatever the blob says at the instant of the click

src/services/taxDetails.ts:141-190 · src/routes/employees.ts:231-235

taxDetails.ts:144:  const raw = await readRawTaxDetails(deps, emp.taxDetailsEnc);
161:      verifiedIncome: num(input.verified_income) ?? raw.priorEmployerIncome ?? 0,
162:      verifiedTds: num(input.verified_tds) ?? raw.priorEmployerTds ?? 0,
181:  await deps.db.update(schema.employees).set({ taxDetailsEnc: enc, taxVerificationStatus: ..., updatedAt: new Date() })
182:    .where(eq(schema.employees.uuid, emp.uuid));

This is the twin of finding 35 (`tax-declarations:verify`), on the other declaration surface, and it is the
weaker of the two. The function is careful about WHO decides - "Maker-checker is structural: verify/reject
require the actor NOT be the subject employee (so an HR user can't rubber-stamp their OWN prior-employer
figures)" - and says nothing about WHAT is being decided.

The subject controls the input. Re-declaring is the employee's own action, takes no state precondition, and
explicitly resets the record ("a changed declaration must be re-verified before it affects withholding
again"). So: HR opens the queue (`listPendingTaxVerifications`, which returns the declared figures), reads
₹50,000, clicks Verify with no override; the employee has re-declared ₹5,00,000 in between; `raw` is re-read
inside this function, `?? raw.priorEmployerIncome` takes the new figure, and it is stamped VERIFIED. Only
VERIFIED figures feed withholding (`readDeclarations` → the projection → payroll's TDS), so the amount nobody
reviewed is the amount that reduces the tax deducted.

There is no `If-Match` anywhere on this path - not in the service signature, not in the route (:231) - and the
write is `where(uuid = ...)` with no version condition. That second part costs more than finding 35 did: the
whole declaration is one ENCRYPTED BLOB rewritten from a read, so a declare landing between this read and this
write is not just decided unseen, it is overwritten and gone.

Fix: the same one applied to finding 35 - take `If-Match` on the PATCH, `checkEtag` against the employee row,
and write through `updateAtVersion` (services/versionGuard.ts), whose guard holds whether or not a header was
sent. The blob rewrite makes the guard load-bearing here rather than merely correct.

---

57. LOW-MEDIUM — all four encrypted PII blobs are read-merge-write with no version guard, so two concurrent edits silently discard one of them

src/services/bankDetails.ts:126-150 · src/services/identityDetails.ts:126 · src/services/personalDetails.ts:91
· src/services/taxDetails.ts:181 (see finding 56) · cf. src/services/versionGuard.ts

bankDetails.ts:126:  const current = await readStored(deps, emp.bankDetailsEnc);
127:  const stored: StoredBank = { ...current };          // merge the patch over what was read
150:  await deps.db.update(schema.employees).set({ bankDetailsEnc: enc, ... }).where(eq(schema.employees.uuid, emp.uuid));

Each of the four sub-resources is one encrypted column holding a whole object, so every write is: decrypt what
is there, merge the caller's fields over it, re-encrypt, write the lot back. None of them takes an `If-Match`,
none of the routes passes one, and the write is keyed on the uuid alone - so two edits that overlap do not
conflict, they overwrite: the second caller's blob was built from a read taken before the first caller's write,
and everything the first one changed is gone with a 200 on both requests.

`versionGuard.ts` was written for exactly this and its header names the population it was meant to cover:
"every hand-written `overrides.update` did this instead ... which is a read-then-write race wearing the clothes
of optimistic concurrency. Two callers holding the same ETag both pass the comparison, both write, both get
200, and the first one's change is gone with nothing anywhere saying so ... and they include `users` (role and
status) and `employees`, which are the two most privilege-bearing rows there are." These four write `employees`
and were not converted.

Bank details is the one to state the cost on, because the file already states it for a different cause: the
comment directly above this merge describes an earlier bug that dropped those fields and says "the fields it
destroys are the ones the bulk-payment file is built from (services/bankFile.ts), so the first sign of it is a
payroll disbursement that cannot be paid". A lost update here does the same thing by a different route - HR
corrects the account number while the employee updates their IFSC, and whichever lands second restores the
other's old value. The trail cannot help either: these paths deliberately audit field NAMES only, so the
reverted value is not recorded anywhere.

Fix: `checkEtag` + `updateAtVersion` in all four, with the routes passing `If-Match` (the guard applies with or
without the header, which is what makes it worth doing even before the SPA sends one).

---

58. MEDIUM — every dashboard KPI is computed against the UTC day, on a justification that stopped being true when the SPA moved to the org's day

src/services/dashboardSummary.ts:20-21 (the claim), :197-210 (the clock), and ~14 tiles keyed on `c.today`
· cf. src/services/orgDay.ts, web/src/lib/orgDay.ts

dashboardSummary.ts:20: // here always equals what the SPA would have counted from the list response. Dates are UTC midnights
21: // (timestamp_ms columns), matching the SPA's toISOString().slice(0, 10) comparisons.
197:  const now = new Date();
198:  const today = utcMidnight(now.getTime());

The reason given for UTC is that it matches the client. It no longer does. web/src/lib/orgDay.ts was added to
remove precisely that comparison from the SPA, and says so: "Twenty-odd files each defined `const todayStr =
() => new Date().toISOString().slice(0, 10)`, which is the day in UTC - not the viewer's day and not the org's
... In IST the two disagree between midnight and 05:30 local, so a date input defaulted to yesterday and
'starts today' read as 'upcoming' for the first five and a half hours of every day." Every page now asks
`todayStr()`, and the server's own day-sensitive paths ask `orgToday(deps)` - payroll, leave, attendance,
comp-off, the cron. This summary is the one that stayed on UTC while its stated reason moved.

So for the first 5.5 hours of every working day in IST, the dashboard is counting YESTERDAY. Roughly fourteen
tiles key off `c.today` or a window derived from it:

  :76   people on approved leave TODAY            (start <= today <= end)
  :70   joiners in the last 30 days
  :73   probations ending in 30 days
  :91   compliance due in 7 days, :94 overdue     (`< today`)
  :138  cards overdue, :141 cards due in 7 days
  :105  goals overdue

- and the window boundaries (`weekStart`, `in7`, `in30`, `ago30`) are all derived from the same `today`, so
they shift with it. The dashboard is the first screen of the morning, which is exactly the window in which it
is wrong.

Two smaller things in the same two lines. `new Date()` rather than `deps.clock.now()` puts this outside the
injected clock every other time-sensitive service uses, so no test can drive it across a day boundary - the
complaint services/leaveAccrual.ts makes about its own former self in as many words. And the claim on line 20
("here always equals what the SPA would have counted") is now false in the other direction too: a client
filtering the same rows by `todayStr()` gets a different set than this counts.

Fix: `const today = new Date(dayStartMs(await orgToday(deps)))` and take `now` from `deps.clock`. The tiles
need no change - they compare against date-only columns anchored at UTC midnight, which is exactly what
`dayStartMs` returns for the org's calendar day.

---

59. LOW — three business dates are stamped as the request INSTANT into columns that are read back as a day, so an early-morning action records yesterday

src/services/assets.ts:474 (and :272) · src/services/ats.ts:102 · src/services/backgroundChecks.ts:93 ·
serialized at src/http/serialize.ts:1168, :252

assets.ts:474:  set.assignedOn = to ? (dayMs(patch.assigned_on) ?? (row.assignedTo === to ? row.assignedOn : new Date())) : null;
serialize.ts:1168: assigned_on: r.assignedOn ? iso(r.assignedOn).slice(0, 10) : undefined,

The column is a day: it is written from `dayMs(...)` (UTC midnight) when the caller supplies one, and read back
with `.slice(0, 10)`, i.e. the UTC day of whatever instant is stored. The fallback writes `new Date()` - the
moment the request arrived - so the same column holds two different kinds of value, and the instant kind
reports the UTC day rather than the org's.

East of UTC that is yesterday for the first hours of the working day. In IST, an asset handed over at 00:30
local is recorded and displayed as assigned the previous day; the same applies to a requisition opened
(ats.ts:102, `status === "open" ? new Date()`) and a background check completed (backgroundChecks.ts:93,
stamped when the status reaches a final value).

None of these three feeds money - the money-dated writes were all moved onto the org's day already
(`reviseCompensation`'s `effective_from`, `recordBonus`'s `awardDate`, the settlement's `settlementDate`), which
is what makes this the leftover rather than the rule. What it costs is a record that disagrees with the person
who made it, on fields people reconcile against (when custody changed hands, when a vacancy opened).

It also breaks the invariant the readers assume: domain/attendance.ts#utcDay exists because "DATE-ONLY columns
are anchored at UTC midnight", and a raw instant in one of them is not.

Fix: `dayStartMs(await orgToday(deps))` for each of the three fallbacks, which is what every other day-stamping
write in the app now uses.

---

60. LOW-MEDIUM — a board's WIP limit is a read-then-write, and the ETag the client sends with a move is dropped on the floor

src/services/cards.ts:677-690 (the check), :723 (the write) · src/routes/cards.ts:93-105 (the verb) ·
web/src/pages/Boards.tsx:620 (the client sends `card.etag`)

cards.ts:679:  if (changingColumn && dest.wipLimit != null) {
680:    const inCol = await columnCards(deps, row.boardId, toColumn);
683:    if (count >= dest.wipLimit) { throw failedPrecondition(`"${dest.label}" is at its WIP limit (${dest.wipLimit})`); }
723:  const updated = (await deps.db.update(schema.cards).set(set).where(eq(schema.cards.uuid, id)).returning())[0]!;

The limit is counted by reading the column and then writing without claiming anything, so two moves into a
column sitting one below its limit both count `limit - 1`, both pass, and both land. A WIP limit that can be
exceeded by two people dragging at the same time is the one thing the feature exists to prevent - and a board
is a surface several people work at once by definition.

The write is `where(uuid = ?)` with nothing else, so the same window also lets the move be decided against a
column the card has already left: `row.columnKey` is read at the top and the movement row written at :724
records `fromColumn: row.columnKey`, so a losing race writes a transition that never happened into
`card_movements` - which is what `boardMetrics` builds the flow/CFD analytics from.

And the version is available: the SPA sends it (`invoke(..., "move", card.etag, move)`, Boards.tsx:620), the
factory hands `c` to every verb, and the sibling verbs on this very collection take one (`update`, `remove`,
`purge` at routes/cards.ts:83-86). `move` alone neither accepts nor uses it, so the client is being careful
about a version the server discards.

Fix: guard the write on what was read - `where(and(eq(uuid, id), eq(columnKey, row.columnKey)))`, zero rows
meaning "somebody moved it first, re-read and try again" - and take `If-Match` like the neighbouring verbs. The
WIP count is then correct for the same reason every other exactly-once flip in the app is: the database, not
the gap between two statements, decides who won.

---

61. LOW-MEDIUM — the ACL modal edits a permission as delete-then-create with no compensating action, so a failed create silently removes the access it was changing - the fix for this exists two files over

web/src/components/access/AclModal.tsx:387-402, :405-421 · cf. SubjectPermissionsDialog.tsx:170-190 and
PermissionsPanel.tsx:159-180, both of which do it correctly · web/src/components/access/cloneRules.ts:39

AclModal.tsx:389:      const before = roleAll(name).filter((x) => !x.verb);
390:      for (const r of before) await remove(r.path, r.etag); // edit = delete + create
393:      if (value !== "none") await create("access-rules", { subject_kind: "role", subject: name, ... });
...
399:    } catch (e) {
400:      toast({ variant: "destructive", title: "Could not update role", description: ... });
401:      setBusy(false);
402:    }

The destructive leg runs first and is committed by the time the create is attempted. If the create fails - a
409 from a concurrent edit, a validation refusal, a dropped connection - the old rules are gone, the new one
was never written, and the message says "Could not update role", which reads as "nothing happened". The undo
registration (:394) is AFTER the create, so a failure leaves no undo either. Two sites do this: the level
editor (:390) and the per-verb editor (:413).

The failure path also does not `reload()`, so the modal goes on displaying the value the admin selected while
the server now holds nothing - which is the second half of the same bug, and the sibling dialog names it:

  SubjectPermissionsDialog.tsx:170  "deletes are committed even when the create fails, so the rules are put
  back rather than silently lost, and the reload happens on EVERY path so this dialog can never keep showing a
  level the server no longer holds."

That sibling tracks what it removed and restores it (`restoreAccessRules`, cloneRules.ts:39), reporting how
many could not be put back; PermissionsPanel.tsx does the same. AclModal - the surface an admin actually opens
from a record to change who can see it - was not given the treatment.

Under four-eyes approval the delete is a `pending_delete` mark and keeps enforcing, so the damage is bounded
there; with the default (approval off) `deleteAccessRule` removes the row immediately and the access is really
gone.

Fix: the pattern already written in `SubjectPermissionsDialog` - collect `removed`, `restoreAccessRules` in the
catch, report the outstanding count, and `reload()` on every path.

---

62. LOW — the letterhead image writer is an unguarded read-modify-write of one JSON column, in an app that has the guarded version of this twice over

src/services/letterheads.ts:136-143 · cf. src/services/tickets.ts:326-350 (writeAttachments) and
src/services/stocktakes.ts:146-160 (recordFound), both of which do it correctly

letterheads.ts:136:  const all = assetsOf(row);
137:  const assets = { ...all, [variant]: { ...(all[variant] ?? {}), [slot]: { key, content_type: type, size_bytes } } };
139:  await deps.db.update(schema.letterheads).set({ assetsJson: JSON.stringify(assets), ... }).where(eq(uuid, row.uuid));

`assets_json` holds every image of both versions of the letterhead, and this rewrites the whole object from a
read. Two uploads in flight at once - the screen mark and the print mark, which is the ordinary way somebody
sets a letterhead up - and the second write is built from a snapshot taken before the first: the first image
vanishes from the record while its bytes stay in R2, so the generated document quietly prints without it and
nothing says why.

The same shape is guarded twice elsewhere, with the reasoning written out. services/tickets.ts:329: "Both
writers below change ONE JSON column by reading it, editing it in memory and writing it back, so both guard the
write with a compare-and-set on the exact value that was read. Two people attaching at the same moment ... used
to leave the loser's entry out of the row while its bytes stayed in R2 - an invisible attachment and an
orphaned object." That is this, on a different column.

`deleteAsset` just below (:150) has the same shape and the same gap.

Fix: the `writeAttachments` pattern - compare-and-set on the `assetsJson` value that was read, bounded retry,
re-reading the row each attempt.

---

63. LOW-MEDIUM — the "have you already done this?" guards are computed over one page, so they go quiet exactly when the org is big enough to need them

web/src/pages/BackgroundChecks.tsx:70, :174-181 · web/src/pages/Assets.tsx:195-204, :591 ·
web/src/hooks/useCollection.ts (`all: true`)

BackgroundChecks.tsx:172:  // The same check ordered twice on one person is two vendor invoices for one answer. Warn, never block: a
173:  // re-run after a discrepancy is legitimate.
175:    return rows.find((c) => !c.delete_time && ... idOf(c.employee) === idOf(form.employee) && c.check_type === form.check_type && (c.status === "pending" || c.status === "in_progress")) ?? null;

`rows` is `useCollection("background-checks", { showDeleted: true })` - one server page, newest first, and the
list service takes no employee filter (services/backgroundChecks.ts:48 binds the scope and nothing else). So
the clash check searches the 100 most recent checks in the whole org. Past that, ordering a second check on
somebody whose first one is older than the window shows no warning at all - and the comment states the cost in
money: "two vendor invoices for one answer".

The same shape guards the asset inventory (Assets.tsx:197, `serialOwner`, "there to catch the same machine
being added twice") over `useCollection("assets")` - and an inventory is the collection most certain to exceed
a page.

Both are deliberately advisory ("Warn, never block", "Not a validation"), which is the right call - and it is
what makes the silence the whole defect. A warning that is absent reads as "no clash", not as "not checked",
and there is nothing on either form to say which it is.

Fix: `{ all: true }` on these two reads (the flag exists for exactly this - "a picker that cannot offer the
hundred-and-first employee ... those are not list pages"), or narrow the read to the person being checked. For
background-checks the narrowing needs an `employee` filter on the list service first, which the wire schema
already has a field for.

---

64. LOW-MEDIUM — about thirty pages resolve people's names from a single page of the directory, so past 100 employees a money approval screen labels rows "Employee" or prints a token where the name goes

web/src/hooks/useCollection.ts (the `all` docstring) · the money surfaces, each with a one-page
`useCollection<Employee>("employees")` and a Map built off it:

  web/src/pages/Reimbursements.tsx:89    (p) => m.get(idOf(p)) ?? idOf(p)      // renders the wire token
  web/src/pages/LeaveEncashments.tsx:65  (p) => m.get(idOf(p)) ?? idOf(p)
  web/src/pages/Expenses.tsx:245         (p) => m.get(idOf(p)) ?? idOf(p)
  web/src/pages/Loans.tsx:54             (ref) => m.get(idOf(ref)) ?? "Employee"
  web/src/pages/TaxDeclarations.tsx:59   (ref) => m.get(idOf(ref)) ?? "Employee"

and the same shape on ~27 other pages (Tickets, Goals, CheckIns, Stocktakes, Compliance, Onboarding,
NoticePeriods, Delegations, Suggestions, RemoteWork, Requisitions, Referrals, Timesheets, Departments,
Announcements, Assets, Pipeline, Workflows, Attendance, Settings…).

`useCollection`'s `all: true` exists for this and names the symptom in its own docstring: "a `new
Map(employees.map(...))` name lookup that renders 'Employee' for everyone past the page ... Those are not list
pages - there is no 'load more' for a reader to press and nothing on screen that reads as incomplete - so the
fetch has to be the one that completes itself." Documents.tsx:140 uses it; these do not.

The rows themselves are correct - it is only the label that fails, and it fails silently. On the five pages
above that label is on a decision: an approver looking at a reimbursement or a loan sees "Employee", or a
26-character token, in the column that says who the money is for. The token spelling is the worse of the two,
because it reads as data rather than as a gap.

AND IT REACHES THE CONFIRMATION. Reimbursements.tsx:158 builds the prompt from the same map:

  if (!(await confirmDecision(confirm, verb, `${empName(r.employee)}'s ${money(r.amount ?? 0)} claim`))) return;

so past a hundred people the dialog that exists to make somebody read what they are about to approve says
"Approve 7k3m…'s ₹12,000 claim?". The safeguard is `confirmDecision` (lib/confirmDecision.ts, added so "one-click
decisions must ask first"); asking with the wrong name in the sentence is most of the way back to not asking.

This is a sweep that was started and not finished, which is the reason to treat it as one change rather than
thirty. Every page that feeds the shared `EmployeePicker` already passes the flag - Reviews.tsx:86,
ReviewCycles.tsx:86, GoalTemplates.tsx:62, Documents.tsx:140, Events.tsx:97 - because there the truncation is
visible the moment somebody cannot be found in a list they are looking at. Where it only shows up as a label,
it was missed.

Fix: `{ all: true }` on the directory read for any page that resolves names from it. It is one option per call
site and the walk is shared by the store, so the pages that already mount the directory pay it once.

---

65. LOW-MEDIUM — you can only @-mention the first hundred people in the directory, on all three surfaces that offer mentions

web/src/pages/Announcements.tsx:220 · web/src/pages/Tickets.tsx:161 · web/src/pages/Boards.tsx:507, :2043 ·
web/src/components/common/MentionPicker.tsx:103 · web/src/components/common/PostComposer.tsx:486

Announcements.tsx:220:  const { rows: employees } = useCollection<Employee>("employees");
PostComposer.tsx:486:   const mentions = useMentions({ value: form.body, ..., employees });

The `@` picker is fed the page of the directory the host page happens to hold, so in an org past 100 people the
menu simply cannot offer everyone else - and the failure is indistinguishable from "no such person": you type
`@Prad`, the menu shows nothing, and there is no way to tell that from a colleague who does not exist. All
three mention surfaces do it: the board composer, ticket replies, and card comments.

This is the functional half of finding 64 - same one-page directory read, but here it does not merely mislabel
a row, it removes a capability. A mention is how somebody is pulled into a thread (services/mentions.ts:
"pulling a third person into a thread is most of what @ is for on a support ticket"), so on a support ticket
the person who needs to see it is the one who cannot be named.

The server side is fine and bounded independently: `MAX_MENTIONS` caps a body at ten, and each token is decoded
and checked before anyone is notified.

Fix: `{ all: true }` on the directory read behind a mention picker - the same one-line change finding 64 asks
for, and the reason to do 64 as a sweep rather than page by page.

---

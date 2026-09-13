---

1. HIGH — scheduled automation claims the day, then fans out unbounded

src/services/automationEngine.ts:670-724

670:  const claimed = await deps.db.update(schema.automations)
672:      .set({ lastScheduledOn: todayStr, ... })     // day claimed HERE
...
698:    for (const emp of roster) {                    // ...fan-out AFTER
699:      await run({ type: SCHEDULE_TRIGGER, subject: `employees/${emp.uuid}`, ... });

run() per matching employee costs recordRun (allocFlatCode + insert = 2 subrequests) plus the action's own — a notify is ~3 more (notifications.ts:76 employee read, :98 allocOwnedCode, :94 insert), more with web push. ~5-6 subrequests per employee, inside the one nightly invocation shared with 21 other subtasks.

Past the budget (50 free / 1000 paid) every later D1 call throws. lastScheduledOn is already stamped, so:
- rest of the roster gets nothing that day,
- next night's tick skips the rule (claim satisfied) — no retry, ever,
- every cron subtask after runScheduledAutomations dies with it.

This is the one headcount-scaled nightly subtask with no bound. Every sibling has one, with the reason written down: cron.ts:634 ("Running out of subrequests part-way through the roster is the worst failure this app can have"), CARRY_FORWARD_EMPLOYEE_BATCH, REMINDER_EMAIL_BATCH (cron.ts:1437), emitScheduledEvents → notifyMany batching (cron.ts:799).

Fix: slice the roster + requeue (carry-forward pattern), route the notifies through notifyMany, and move the claim so a partial pass is resumable (cursor, or claim-on-completion).

Also: runScheduledAutomations is documented "Never throws" (:640) but has no try/catch around computeEmployeeMetrics (:697) or run(). runActions/recordRun swallow their own, so it holds today — by accident of two callees, not by the function.


---

2. MEDIUM — accrueLeave reads whole tables and builds one unbounded batch, on a request path

src/services/leaveAccrual.ts:91, :208

 91:  const balances = await deps.db.select({...}).from(schema.leaveBalances);   // no WHERE
208:  const lost = await runBatchChecked(deps.db, [...updates, ...insertBatches(...)]);

updates is up to headcount × accruingTypes guarded UPDATE statements in a single db.batch(). 500 people × 5 types = 2500 statements per D1 round-trip. Roster read at :68 is column-narrowed with a comment about the memory floor; the balances read beside it is not narrowed at all.

Worse, it runs in an HTTP request: src/services/leaveTypes.ts:68-71

afterUpdate: async (deps, _actor, row, _before, patch) => {
  if (has(patch, "accrual_days_per_year") || ...) await accrueLeave(deps, row.uuid);
}

A PATCH on one leave type reads the entire roster + entire leave_balances table and writes an org-sized batch, synchronously.

Fix: when onlyLeaveTypeId is set, bind eq(leaveBalances.leaveTypeId, onlyLeaveTypeId) on the :91 read; chunk updates into several batches (or move the request-path call to a job).

---

3. MEDIUM — resumeWaiting reads every waiting workflow on every event

src/services/automationEngine.ts:477

const waiting = await deps.db.select().from(schema.workflowInstances).where(eq(status, "waiting"));
for (const inst of waiting) {
  if (inst.awaitedTypes && !inst.awaitedTypes.split(",").includes(event.type)) continue;  // JS prefilter

Full unfiltered scan per dispatched event — i.e. per write in the app. awaited_types is already a column; the filter is done in JS. Any workflow with a long wait arm fanned per employee makes the table headcount-sized, and then every write pays to read all of it. Same shape at :567.

Fix: narrow in SQL on awaited_types (LIKE on the comma list, or a join table), keep the exact armMatches check in JS.

---

4. LOW — cursor fallback skips rows; comment claims the opposite

src/http/pagination.ts:104-108

104: const curUid = cur && wire ? await wire.codec.decode(...) : cur?.uid ?? null;
105: const past = (e: T) =>
       (dir === "asc" ? when(e) > cur!.createTimeMs : when(e) < cur!.createTimeMs) ||
       (curUid !== null && when(e) === cur!.createTimeMs && uid(e) > curUid);

When the token does not decode, curUid is null, the second clause is dead, and past is a strict timestamp test. findIndex(past) therefore lands past all rows tied at the cursor instant — those rows are skipped, never returned.

The comment above it states: "That bound can only re-show rows at the boundary instant, never skip them, so the fallback is the safe direction of wrong." That is the opposite of what the code does. And it's reachable in exactly the case the comment names — a token "minted before this collection was wired" (rows written in one seed/batch share createdAt, so ties are the normal case there, cf. the byUid note right above).

src/services/keysetPage.ts:53 has the same fallback (cmp(key, at) = strict), same effect.

Fix: when curUid === null, use >= / <= on the timestamp so the boundary instant is re-shown rather than dropped.

---

5. HIGH — 360 peer feedback is de-anonymized by the id the API hands the reviewee

src/http/serialize.ts:801-816, src/routes/reviews.ts:82-96

801: function reviewFeedbackEntry(f: any, named: boolean) {
803:     id: f.uuid,                                    // raw pk, both states
812:     ...(named || f.state === "SUGGESTED" ? { author: ref("employees", f.authorId) } : {}),

The row is promoted in place through its whole life — SUGGESTED → REQUESTED (reviewFeedback.ts:71), REQUESTED → SUBMITTED (:181) — so uuid never changes. And the reviewee sees the same row at both ends:

1. Employee suggests peers → rows land SUGGESTED. routes/reviews.ts:93 returns them to the employee, and line 812 names the author on a SUGGESTED entry even when named is false (deliberate: "Anonymity protects an ANSWER; there isn't one"). The employee now holds id → author.
2. Manager nominates → same row goes REQUESTED; peer submits → SUBMITTED.
3. Review is shared → routes/reviews.ts:94 returns that row to the employee anonymized (no author) — with the same id.

Join on id. Every peer the employee suggested is named against their supposedly anonymous comment and rating. Manager-nominated reviewers are never SUGGESTED, so those stay anonymous — the leak is exactly the set the employee proposed, which is most of them.

The id buys nothing: web/src/pages/Reviews.tsx:1047 uses it only as key={f.id ?? i}. Every other identity of that row is already tokenized (review-feedback is in ENCODABLE), so this is also the one place a first-class wire collection publishes its raw 13-char pk — the comment calls it "a sub-resource handle, like a reply id", but announcement replies / card todos / ticket todos are side tables with no wire identity, and this one is not.

Fix: drop id when !named, or emit a per-response handle. Nothing on the owner's view acts on it.

---

6. MEDIUM — notifyMany ignores the daily-digest preference

src/services/notifications.ts:139-230

notify() parks low-signal items for the digest:
 85:  if (isDigestible(prefs, priority, input.action)) { await queueForDigest(...); return; }
notifyMany() reads the same prefs blob — it already parses it — and applies only mute:
188:  const mutedFor = new Set(emps.filter((e) => isMutedByUser(parseNotificationPrefs(e.prefs), input.type))...)
198:  const targets = uniq.filter((rid) => !mutedFor.has(rid));
No isDigestible partition. Every fan-out goes straight to the bell: mentions, announcements, ticket fan-outs, and — since the nightly reminders were moved onto this function (:147-161) — the cron reminders too, which are precisely the low-priority no-CTA items digest exists for. A user who turns on "daily digest" sees essentially no change.

The function's doc lists its deliberate trades (no browser push, per-recipient text, chunking); digest is not among them, so this reads as an omission. prefs is already in hand — one partition, queue one side.

---

7. MEDIUM — client attendance grid ignores half-day leave; shows "On leave" for a day payroll docks

web/src/lib/attendance.ts:214,220 vs src/domain/attendance.ts leaveCover

214:  leaveRanges: { start: string; end: string }[];          // no sessions
220:  const onLeave = (day) => leaveRanges.some((r) => r.start <= day && day <= r.end);
Callers drop the sessions too — web/src/pages/Attendance.tsx:233 and TeamTimeline.tsx:338 both map to {start, end} only.

Server leaveCover reads startSession/endSession and excuses half a day at a boundary session; lopDayUnits then charges 0.5 unless the employee punched ≥ half_day_minutes. So a PM half-day leave with no punch is status: "on_leave" on the Attendance page and the timeline, and 0.5 days of loss of pay in the payroll build.

That is the exact failure eventCreditByDay's own comment forbids ("keep the two in step, or the timeline shows a day as present that payroll then docks") — and web/src/lib/attendance.ts is the only client mirror in the repo with no drift test (test/ has 28 *Drift.test.ts; none covers attendance).

Worth noting alongside: the "web bundle can't import from src/" premise in web/src/lib/payslipTemplate.ts is false — leaveForecast.ts:1, eventRepeat.ts:12, assetTagsPdf.ts:8 and five pages already import ../../../src/domain/*. The attendance mirror could be a re-export instead of a copy.

---

8. MEDIUM — workflow action editor keeps per-row state at the index, not with the action

web/src/components/workflows/ActionList.tsx:66

57: const set  = (i, a) => onChange(actions.map((x, j) => (j === i ? a : x)));
58: const del  = (i)    => onChange(actions.filter((_, j) => j !== i));
59: const move = (i, d) => { ...swap... }
66:   <Card key={i} className="p-3">

Index keys over a list that deletes and reorders. Two children hold local state derived from the action:

- :253 const [mode, setMode] = useState(inferred) — "create" / "record" / "raw", seeded once and deliberately never re-seeded.
- :348 const [resourceName, setResourceName] = useState("") in RecordCall.

rows at :259 is re-seeded when a different body arrives (:261-265), so the author clearly knew a different action can land in a slot — but mode and resourceName were not given the same treatment, and with index keys "the same slot" is not "the same action". Delete action #1, or press Move up: action #2 renders in the surviving component and inherits #1's mode, so an apiCall authored as "Act on a record" opens in the Raw editor (or vice versa) and is then edited through the wrong form.

Fix: key by a stable per-action id, or re-seed mode/resourceName from the incoming action the way rows is.

---

9. LOW — currentFy() uses the browser's calendar, not the org's

web/src/lib/fy.ts:6

export function currentFy(d = new Date()): string {
  const start = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;

web/src/lib/orgDay.ts exists precisely to end this ("Twenty-odd files each defined const todayStr = () => new Date().toISOString()...... this is the half that was left behind"), and every other date default in the SPA went through it. fy.ts did not. For a viewer whose local date differs from the org's around 31 Mar / 1 Apr, the Form 16 / tax-declaration FY default and the "this year is still running" hint (Form16BatchButton.tsx:92) name the wrong year. One-line fix: derive from todayStr().

---

10. LOW (design hazard) — granting activity on suggestions silently un-anonymizes the box

src/services/suggestions.ts:94

The feature strips the submitter everywhere a person can see it — toSuggestionResource (serialize.ts:1356) hides submitter when anonymous, and the reviewer nudge drops the actor face (suggestions.ts:104, actorId: input.anonymous ? undefined : submitterId). The audit trail does not:

94: await audit(deps, actor, "suggestion.create", "suggestions", row.uuid, ...)

actor_id is the submitter, and GET /v1/activity?resource=suggestions/<id> reads it back to anyone holding activity on that collection plus read on the row. activity is private-by-default (only super via **, grants.ts:35-39) so nothing is exposed out of the box — but supported_scopes offers activity per collection in the ACL, and an admin granting activity.*.suggestions to HR for "triage visibility" breaks the feature's only promise with nothing anywhere saying so. emitEvent at :95 carries employeeId: submitterId into event_log for the same reason, where an HR-authored automation on suggestion.submitted can read {{employeeId}}.

Worth either suppressing the actor on an anonymous create (write it as system with the row id), or refusing activity on suggestions in the ACL.

---

11. HIGH — the table builder projects the manager's unshared assessment

src/domain/tableFields.ts:78

reviews: { label: "Reviews" },     // no `deny`

BASES.deny is documented as: "Every entry names a column whose WIRE form is conditional (the serializer hides it for some rows or some callers), so projecting the raw column would be a way round that rule."

toReviewResource (serialize.ts:768) withholds manager_comment, overall_rating, ratings, goal_ratings behind _managerVisible = shared || !isOwner. The *Json columns are caught by the global DENY_PATTERN = /(Enc|Json|Hash|Secret|Key)$/. managerComment and overallRating are plain columns and are not.

Every employee holds the grant — grants.ts:145-146:
"reviews": "read",        // own reviews (stage verbs below; manager assessment redacted until shared)
"reviews.me.**": "read",
so an employee builds a grid on Reviews, adds "Manager comment" and "Overall rating", and reads their own review in SELF/MANAGER state. tableRun applies list scope and the employees-PII sub-resource gate only — nothing collection-specific.

Two other surfaces get this right, which is what makes it a gap rather than a design choice:
- domain/searchIndex.ts:81 — "managerComment IS DELIBERATELY NOT INDEXED, and neither may the rest of the manager's assessment be."
- services/peopleAnalytics.ts:421 — inArray(t.reviews.state, ["SHARED", "ACKNOWLEDGED"]), "a manager's rating is hidden until SHARED, and a report that surfaced it earlier would leak the draft verdict".

Fix: reviews: { label: "Reviews", deny: ["managerComment", "overallRating"] }. The grid has no per-row state filter, so denying the columns is the only correct answer.

---

12. HIGH — tax-config is unvalidated, merged shallowly, and fails to zero withholding

Four things compose into "nobody's TDS is deducted, silently, and nothing logs it".

a. The merge is shallow. services/settings.ts:42
return { ...fallback, ...(JSON.parse(row.value) as object) };
So a stored {"regimes": {"new": {...}}} replaces DEFAULT_TAX_CONFIG.regimes wholeomitted — standardDeduction, rebate87A, cessRate, surcharge — is gone, notdefaulted.                                                                                                                                                                        
b. No validator. routes/settings.ts:197 registers ctc, esign, payslip, asset-tags, organization, attendance. tax-config — the one key that decides the charge — is not there, and taxProjection.ts:57 reads it straight through getSettingValue.

c. The math turns the gap into NaN and the NaN into zero. domain/incomeTax.ts:229
const taxableIncome = Math.max(0, gross - cfg.standardDeduction - deductions);   // undefined → NaN
Math.max(0, NaN) is NaN, not 0. slabTax(NaN) adds nothing (NaN > prev false) and alse) → tax 0. rebate87A returns Math.max(0, 0 - (NaN - limit)) → NaN. cess → NaN.totalTax → NaN. And :254
return Math.max(0, r0((totalTax - alreadyDeducted) / remainingMonths));
— the comment says "Clamps at 0", but Math.max(0, NaN) does not clamp.

d. The payroll build drops the line without a word. services/payroll.ts:774
if (tax > 0) lines.push({ code: "TDS", ... });    // NaN > 0 === false

Net result: an admin editing the Budget's slabs and omitting one sibling field prlips with no income tax withheld, no error, no audit signal — the org discovers itat Form 16. round2's own header states the rule this breaks: "a money helper whose failure mode is 'returns zero without saying so' is the exact shape this function exists to prevent."

Same file, one line up, an adjacent hazard: taxProjection.ts:371
const regimeCfg: RegimeConfig = args.cfg.regimes[args.regime] ?? args.cfg.regimes
A stored regimes with no new key makes that non-null assertion a lie — computeAnnualTax(x, undefined) throws on cfg.standardDeduction, i.e. a 500 on every payroll build and every Tax page.

Fix: add validateTaxConfig to SETTING_VALIDATORS (regime shape, ascending slabs, finite standardDeduction/cessRate, regimes.new present), and make computeAnnualTax throw on a non-finite config the way assertSupportedRegime throws on an unimplementable one, rather tha

---

13. MEDIUM — the configurable ticket workflow is configurable in name only

Three independent halves, all in the same feature:

Its validator is dead code. domain/stateMachines.ts:29 validateStateMachine — "Stconfigurable, validated by validateStateMachine". Its only caller in the repo istest/stateMachines.test.ts. ticket-workflow is not in SETTING_VALIDATORS, and upsertSetting writes any JSON to any key. A machine with a to outside states is accepted, cast as TicketState at tickets.ts:220, written to the row — and transitionFor then finds no transition we ticket is stranded with no column and no legal move.

The SPA ignores the configuration. services/tickets.ts:216 reads settings/ticket-ckets.tsx:115 renders the board columns from the hardcoded TICKET_WORKFLOW.statesand :955 the move menu from its transitions. The drift test pins the client copy to DEFAULT_TICKET_WORKFLOW, which is what makes this look covered — it pins the client to the default, not to the org's setting. Customize the workflow and the UI offers moves the server refuustom states at all.

First-match vs filter. stateMachines.ts:13
const t = sm.transitions.find((x) => x.verb === verb);
return t.from.includes(fromState) ? t : null;
verbsFrom (:23) and the client's ticketMovesFrom both .filter. So the natural multi-row authoring of one verb —
{ verb: "close", from: ["OPEN"], to: "CLOSED" }
{ verb: "close", from: ["RESOLVED"], to: "CLOSED" }
— is listed as available from RESOLVED and refused from RESOLVED, and validateStabjected either. Either make it .find(x => x.verb === verb &&x.from.includes(fromState)), or reject duplicate verbs in the validator.

---

14. HIGH — private 1:1 notes are copied verbatim into audit_log

src/lib/audit.ts:77, :232, :295; src/db/schema.ts:1296-1297; src/services/checkIns.ts:96

toCheckInResource (serialize.ts:866) is emphatic: "A private note is served to the ONE person who wrote it and to nobody else - not to the other party, not to an HR admin who can read the row."

The generic audit walk does not know that. employee_note / counterpart_note are plain text columns; the only filters are

77: const SECRETISH = /secret|token|hash|password|salt|nonce|otp|signature|enc$/i;
78: const STRUCTURAL = new Set(["uuid","code","id","createdAt","updatedAt","deleteTime"]);
     ... plus /(Json|Key)$/

Neither name matches. So:

- Update — checkIns.ts:96 writes set.employeeNote = text; the crud lane (crud.ts:273) calls diffMeta(row, updated, set, "check-ins") → fieldDiff (:295) emits { employeeNote: { from: "<old note>", to: "<new note>" } }, up to MAX_AUDIT_LEN (140) each.
- Delete — the soft-delete lane calls removedMeta (:267), which rowValues-walks the whole row and copies both parties' notes.

audit_log is exactly the table the same file warns about (:51): "readable by whoever holds the audit capability, which is a WIDER set than the people who may read the record itself… material whose own access control lives somewhere else must not be copied here." That is the argument that added enc$ to SECRETISH; the check-in notes are the same shape one table over, and they are plaintext rather than ciphertext.

Out of the box only super reads it (activity is private-by-default) — but super is precisely who the serializer says must not see these, and an admin granting activity.*.check-ins for ordinary "who changed what" visibility publishes every private 1:1 note in the org.

Fix: a per-collection deny alongside DIFFABLE_BLOBS (or name the two columns in the global exclusion), the same way fieldsMeta — names only, no values — is already used for bank/identity/personal.

Related, same file: DIFFABLE_BLOBS (:156) opts reviews: ["ratingsJson"] into audit diffs. That blob is the manager's competency ratings, withheld from the employee until SHARED (serialize.ts:768). It is unreachable today only because reviews mounts no generic update — an armed gun, not a live bug, and the second place after the table builder (finding 11) where that invariant isn't carried. The same map's "review-feedback": ["ratingsJson"] names a column that does not exist on review_feedback (schema.ts:1017-1036), so the list is not checked against the schema.

---

15. MEDIUM — the "Recognition received" metric is scoped by who gave the kudos

src/services/peopleAnalytics.ts:223, :451

223: announcements: [t.announcements.code, t.announcements.authorEmployeeId],
...
451: add("kudos", db.select({ employeeId: t.announcements.recipientEmployeeId, received: count(*) })
       .where(scoped("announcements", eq(kind,"kudos"), eq(published,true), isNull(deleteTime),
                     ..., inArray(t.announcements.recipientEmployeeId, ids)))
       .groupBy(t.announcements.recipientEmployeeId));

scoped() binds applyScope to authorEmployeeId — correct for a list of posts you authored, which is what visibleWhere (announcements.ts:91) uses it for. But this measure is about the recipient. So under own breadth the column counts kudos the viewer gave, filed under each recipient's name; under dept breadth it counts kudos authored inside the viewer's department. Only at all breadth is it the number the label claims.

Second, smaller gap in the same query: visibleWhere adds disabled = false for any caller without seeRestricted; the measure filters published/deleteTime but not disabled, so a moderated-out kudos still counts toward recognition for a caller who cannot see it.

Worth noting that announcements is in EXCLUDED_BASES for the table builder for exactly this reason — "the list narrows by publication state and audience… not by scope alone" — while the analytics fan-out re-derives that narrowing by hand and gets part of it.

---

16. LOW — professionalTax throws on a partial config blob

src/domain/statutory.ts (professionalTax), src/routes/settings.ts:197

for (const s of [...cfg.slabs].sort(...))

professional-tax is not in SETTING_VALIDATORS, and getSettingValue's merge is shallow (settings.ts:42). A stored {"annual_cap": 2500} leaves cfg.slabs undefined and [...undefined] is a TypeError — a 500 on every payroll build and every FnF, from a settings edit. {"slabs":[{"up_to":null}]} instead gives Math.max(0, undefined) → NaN on the PT line.

Same root cause as finding 12 (tax-config), lower blast radius because it fails loudly rather than silently. Both argue for the validator registry covering the statutory keys — tax-config, professional-tax, gratuity, overtime, loan-perquisite, leave_accrual, leave_encashment are all money-shaping and all currently unvalidated, against six keys that are.

---

17. HIGH — letter and Form 16 generation hand hr_admin the compensation data its grant deliberately withholds

src/services/letterData.ts:18, src/routes/letterPreview.ts:43, src/routes/letterGenerate.ts:50, src/routes/form16Generate.ts:30

The seeded hr_admin grant has no compensation entry at all — that is deliberate and stated in the grant itself (grants.ts:389):

"pay-grades.**": "read",          // comp catalogs are payroll-authored; HR reads for letters/requisitions
"salary-structures.**": "read",

Catalogs only. Actual CTC lives on compensation, which only payroll_admin (compensation.**: "write") and super hold.

But assembleLetterContext takes no actor and makes no access decision:

18: export async function assembleLetterContext(deps: Deps, employeeId: string): Promise<LetterContext> {
      ...select().from(schema.compensation).where(eq(employeeId, employeeId))...
      comp = { lines, ctcMonthly, ctcAnnual: annualOf(current, ctcMonthly) };
      increment = { oldAnnual, newAnnual, effectiveDate }

and domain/letters.ts:195 exposes it as {{ctc_annual}}, {{ctc_monthly}}, {{ctc_in_words}} plus a full CTC annexure table. hr_admin holds personal-documents.** in its allow list, which matches the two-token verb keys personal-documents.generateLetter / .previewLetter.

previewLetter is the worse of the two. generateLetter at least gates the template (letterGenerate.ts:48, canReadObjectId(user, "letter-templates", …)). The preview route has no such call — it takes the template inline in the request body (letterPreview.ts:27, blocks: z.array(z.any()).max(500)), renders it against any employee ref, and returns the PDF. So the caller supplies an ad-hoc template containing {{ctc_annual}} for any employee and reads it back. No compensation grant, no stored template, no per-template ACL, no object-level scope (a collection-level verb key carries no id to scope on). And hr_admin also holds letter-templates.**: "write" (grants.ts:314), so even the generate path is self-serve.

form16Generate.ts:30 is the same shape one module over: assembleForm16(deps, employeeId, fy) takes no actor and renders annual gross salary and TDS, while hr_admin holds no payslips grant.

The manifest already lists personal-documents:previewLetter among sensitive_verbs, so the sensitivity is recognised for the audit trail and not for authorization — the act is recorded, and permitted.

Fix: assembleLetterContext / assembleForm16 take the actor and drop the comp / increment / payroll blocks when decide(grant, "compensation.<employeeCode>", read) (resp. payslips) fails — the same narrowing deniedSubresourceKeys already does for PII in the grid. And previewLetter needs the template gate generateLetter has, or an explicit note that an ad-hoc template body is by design.

---

18. MEDIUM — identity-document upload and clear are gated on the READ decision

src/routes/employees.ts:145-166

145: async function identityDoc(c, id, action: "upload" | "download" | "clear") {
151:   if (deniedFieldKeys(c.get("objectGrant"), "employees", code, "identity", [field], …).has(field))
152:     throw forbidden(...);

deniedFieldKeys (http/fieldAccess.ts:15) always asks level: "read". All three actions share that one check, so a caller who may read a field but is denied write on it can still replace or delete the supporting document behind it (:uploadIdentityDoc, :clearIdentityDoc).

Per-field write is a real, separately-decidable thing here — bodyDecision (middleware/authz.ts:218-224) gates the sub-resource body per key at level: "write", and the ACL accepts a rule written against identity.<key>. The principle is spelled out twenty lines below this very function:

▎ "a caller's write grant and their read grant are decided separately, so somebody who may WRITE a field … need not be able to READ it back."

This is the converse, and it fails in the destructive direction. Not reachable with the seeded grants (every employee holds employees.me.identity.**: write, so read and write coincide on their own record); reachable the moment an admin writes a read-only per-field rule.

Fix: ask write for upload/clear and read for download — deniedFieldKeys needs a level parameter, or two call sites.

---

19. MEDIUM-HIGH — soft-deleting an employee does not end their access

src/middleware/auth.ts:61 vs :262; src/services/transitions.ts:200-201

Two exits from the company, two different answers.

Offboarding does it right (transitions.ts:200-201), and says so — "disable their login":
update(employees).set({ status: "terminated", disabled: true, endDate, … })
update(users).set({ status: "disabled", … }).where(eq(users.employeeId, employeeId))

DELETE /v1/employees/<id> does not. employees declares no remove override (routes/employees.ts:96-100 overrides only get/create/update), so the generic softDeleteRow runs: it stamps employees.delete_time and touches nothing else. The linked users row stays active.

The auth lane then lets them straight back in, because its employee join carries no soft-delete filter:

 61:  .leftJoin(schema.employees, eq(schema.users.employeeId, schema.employees.uuid))
...
107:  if (user.status !== "active") throw forbidden("user disabled");   // users.status — still active

employeeCode and employeeId resolve off the deleted row, so every me-scoped grant still matches and every own-breadth list still binds. The person is gone from the directory (listEmployees filters delete_time) and still signs in with full self-service: clock in/out, file leave, raise tickets, upload documents, post to the board. None of those services re-checks liveness — and they shouldn't have to, since the invariant belongs at the door:

leaveRequests / overtimeRequests / remoteWorkRequests / reimbursements
assetRequests / attendance / attendance-regularizations   → no employee deleteTime check

The same file already knows the column matters — the auto-provision lookup twenty lines down filters it (auth.ts:262, isNull(schema.employees.deleteTime)). One lookup applies it, the other does not.

The PII sub-resources happen to be safe (bankDetails.ts:43, identityDetails.ts:50, personalDetails.ts:39 each throw on row.deleteTime), which is the same guard the auth join is missing.

Fix: either filter the join (and(eq(...), isNull(employees.deleteTime)) — then a deleted-employee account resolves with no employeeCode, i.e. inert me grants), or give employees a remove override that disables the linked user the way transitions.ts:201 does. The second matches the stated intent better — "gone" should mean the account is off, not that the grants quietly stop matching.

---

20. LOW — previewAccess returns a directory it is not scoped to

src/services/accessPreview.ts:18, src/routes/accessPreview.ts:12

export const accessPreviewRoute = new Hono<AppEnv>().post("/", async (c) => {
  const body = await jsonBody<PreviewBody>(c);
  return c.json({ results: await previewAccess(c.get("deps"), body) });   // no actor
});

previewAccess takes deps and a body, no caller. For up to MAX_SUBJECTS = 100 arbitrary users/<id> or employees/<id> refs it returns email, name, role, disabled, the read/write/admin verdicts and — with include_capabilities — the full scope-stripped capability set.

listUsers is explicit that this is not public (services/users.ts:20-22): "an admin holds users.** (org-wide), while everyone else holds only users.me.** … so their page is their own account and not, as it used to be, every email and role in the company." The preview verb has no such narrowing: it is gated only by the two-token custom key access-rules.preview, which carries no object to scope on.

Nothing is exposed out of the box — bootstrap.sql seeds no access-rules rules at all, so the verb is super-only until granted. But the ACL offers it, and granting "let the access admins use the preview panel" without also granting users read hands over an org-wide email/role directory. Worth either taking the actor and filtering subjects by the caller's users scope, or documenting that access-rules.preview implies users.** read.

---

21. MEDIUM — a purged document leaves its frozen content behind in R2

src/services/documentService.ts:224 vs src/services/letterPrint.ts:30

Every generated letter and every generated Form 16 writes a second object beside the PDF — the fully resolved LetterContent, so :print and the in-place e-sign can re-render it:

letterPrint.ts:30   await deps.docs.put(`${r2Key}.content`, …)          // written on generate
letterGenerate.ts:101  await freezeLetterContent(deps, row.r2Key, content)
form16Generate.ts:36   await freezeLetterContent(deps, row.r2Key, content)
letterSign.ts:35    const contentBuf = await deps.docs.get(`${row.r2Key}.content`)   // read back

The purge takes only the first:

224: purgeRow(…, async (row) => { await deps.docs.delete(row.r2Key as string); });

So DELETE /v1/personal-documents/<id>?force=true — the irreversible, admin-gated hard purge — deletes the row and the PDF and leaves <key>.content in the bucket permanently. It is now unreferenced by any row, so no later purge, cascade or retention sweep can ever find it.

What it holds is not metadata: for a salary or increment letter that is the resolved CTC annexure (domain/letters.ts:195 folds ctc_annual / ctc_monthly / the line table into the content), and for Form 16 the annual gross and tax figures. Encrypted at rest by docstore (lib/docstore.ts), which bounds the exposure but not the retention — and "purge" is the operation the app documents as the one that actually erases.

The same file already handles an orphaned object correctly elsewhere (documentService.ts:350 deletes copyKey when the acknowledgement copy fails), so this is a missed sibling rather than a policy.

Fix: one line in the purge callback — await deps.docs.delete(${row.r2Key}.content).catch(() => {}), tolerant because most documents have no sidecar.

---

22. LOW-MEDIUM — compensation and operations still return unpaged lists

src/routes/compensation.ts:61, src/services/compensation.ts:265; src/routes/operations.ts:27

// compensation
list: (c, page) => listCompensation(…).then((items) => ({ items, nextPageToken: undefined })),

// services/compensation.ts:265 — no maxPageSize, no limit, no cursor
const rows = await deps.db.select().from(schema.compensation).where(…);
rows.sort(…);
return withGrades(deps, rows);

GET /v1/compensation with no ?employee filter reads every compensation row the ca payroll_admin (compensation.**) that is the whole timeline table: one row perperson per increment, correction and CTC re-split, each then widened by withGrades and the decorateCompensation CTC build-up. And next_page_token is always absent, so the client is told it holds everything.

operations.ts:27 is the other half: .limit(page.maxPageSize) with nextPageToken:  is append-only (every payslip publish, email fan-out, workflow timer) and theOperations page can only ever show the newest 100, silently.

The three sibling collections were each converted for exactly this and say so:

- services/positions.ts:30-36 — "the UNFILTERED list is org-wide and grows with headcount × every promotion … and it was returning all of it with nextPageToken: undefined, so there was no
  cursor to follow even when the answer was truncated by nothing but the Worker's
- services/settlements.ts:52, services/bonuses.ts:62 — same narration.

positions is compensation's twin (same page, same effective_from key, same employee-history shape) and got keysetPage; compensation — the bigger and wider of the two — did not.
http/pagination.ts names the five collections that may legitimately page in memorng them.

---

23. LOW — the per-IP rate floor resets everyone's budget under a wide flood

src/lib/isolateRate.ts:83-86

if (!w && windows.size >= maxKeys) {
  for (const [k, v] of windows) if (nowMs - v.startedAt >= windowMs) windows.delete(k);                                                                                                         if (windows.size >= maxKeys) windows.clear();       // ← drops every live windo
}                                                                                                                                                                                             
maxKeys defaults to 5000. On the authenticated budgets the key is u:<uuid> / k:<uuid>, bounded by headcount, so this never fires. On the public lanes it is cf-connecting-ip — /auth (perIp,  30/min), /found (300), /diag (600) — where an attacker controls the key space dire addresses inside one window wipe the map, and every subsequent sweep does itagain, so the per-IP floor stops counting for as long as the flood lasts.                                                                                                                     
The shared total counter still bounds /auth and the WAF rule remains the real control, so this is a degradation of a floor rather than a hole. But it degrades under precisely the traffic it exists to bound, and the choice is not stated — every other fail-open path in thinded LRU eviction (drop the oldest N, keep the rest) costs the same and keeps thecounters that matter.

---


24. MEDIUM — the activity "case" view blows D1's parameter cap on any real payroll run

src/services/activityCase.ts:26, src/services/activity.ts:105-107, src/routes/activity.ts:72

The case walk is bounded, and the reason is stated (activityCase.ts:20-21):

▎ "returns at most MAX_CASE_RECORDS members, because the audit query it feeds turns each member into an OR term."

26: const MAX_CASE_RECORDS = 60;

The bound counts terms. The query spends two bound parameters per term:

106: or(...opts.entityIds.map((e) => and(eq(auditLog.entity, e.entity), eq(auditLog.entityId, e.id))))

60 members → 120 bound parameters in one statement, against the ceiling this repo states in its own words (lib/dbBatch.ts:49): "D1 binds at most this many parameters per statement. Not a tunable - exceeding it is D1_ERROR: too many SQL variables." Nothing chunks it — listAllActivity pushes the whole OR list into one runPaged call.

So the practical ceiling is ~49 members, and the cap is set at 60. Worse, hitting the cap is the failure: a case that stays small works, and the moment it fills — which activityCase.ts:96 says is routine ("a payroll run settling two hundred payables is a case the cap cuts short") — the query throws and the route answers 500.

caseMembersForRun fills fast: settled() appends one member per bonus, encashment, overtime request and reimbursement the run paid, plus one per arrears row, one per repaid loan, and one per bridged expense. A 60-person run clears 49 without trying.

And the other filters share the same budget: q adds seven parameters (see finding 25), tone adds one per mapped verb, before one more — so a case search fails well below 49.

Fix: either lower MAX_CASE_RECORDS to ~40 with margin, or chunk the OR list and merge — lib/dbBatch.ts already exports chunk / byIdChunks for precisely this, and ID_CHUNK = 90 exists because "the predicates that ride alongside an id list are exactly the ones that bind."

---

25. MEDIUM — the activity search is a full-table LIKE scan, and it greps the audit meta blob

src/services/activity.ts:17-32

17: function textAndToneConds(opts: { q?: string; tone?: string }): SQL[] {
21:   conds.push(or(
23:     like(schema.auditLog.action,     `%${q}%`),
24:     like(schema.auditLog.actorEmail, `%${q}%`),
25:     like(schema.auditLog.actorName,  `%${q}%`),
26:     like(schema.auditLog.entityName, `%${q}%`),
27:     like(schema.auditLog.entity,     `%${q}%`),
28:     like(schema.auditLog.entityId,   `%${q}%`),
29:     like(schema.auditLog.meta,       `%${q}%`),
30:   ));

Two problems, one cost and one disclosure.

Cost. Seven leading-wildcard LIKEs ORed together cannot use any index, so this scans audit_log — the fastest-growing table in the app, never pruned (changeDdl.ts:132 lists it as deliberately unstamped because it is "paged by its own timestamp"). Every other text search in this codebase was deliberately moved off exactly this shape: globalSearch.ts:10-13 — "a LIKE '%q%' fan-out would scan every searchable table on every keystroke and get more expensive as the database grows, whereas an FTS hit reads the matching rows and a miss reads none" — and searchFilter.ts exists so a list's text box is "an index lookup instead of a table scan". The activity feed is the one search left on the old shape, and it is the one over the biggest table. The neighbouring filters each carry a note saying they are indexed seeks (audit_corr_idx, audit_subject_idx, audit_session_idx); this one carries none.

Disclosure. like(auditLog.meta, …) searches the meta blob, which — per finding 14 — carries raw from/to values for any column the global filters miss: the private 1:1 notes (employeeNote / counterpartNote), a 360 nominee's decline reason (reviewFeedback.ts:199), and whatever else fieldDiff lets through. So the values are not merely stored where a wider readership can reach them; the feed ships a substring search over them. Anyone holding activity on a collection — or the org-wide audit capability — can grep for a phrase and find which check-in it came from.

The actor filter (activity.ts:108, like(actorEmail, '%…%')) is the same scan one line down.

Fix for the cost half is the mechanism already in the repo (index the searchable audit columns into search_docs / FTS5, or drop to prefix matching on the indexed columns). Fix for the disclosure half is finding 14's: keep the values out of meta in the first place.

---

26. HIGH — the e-sign vendor base URL is caller-supplied and never goes through the SSRF guard, so a settings write sends the Cashfree client secret wherever it points

src/services/esign/cashfree.ts:28, :190, :216, :259 · src/routes/settings.ts:27-30

28: const apiBase = (cfg: EsignProviderCfg): string => String(cfg.api_base || DEFAULT_BASE).replace(/\/+$/, "");
190:   const up = await vendorFetch(`${base}/esignature/document`, { method: "POST", headers: await authHeaders(i.secrets), body: form }, "upload");

`api_base` is a free-text field on `settings/esign` (`configFields` at :173, rendered as "API base URL" by the Settings panel — web/src/pages/Settings.tsx:613). `validateEsign` checks exactly one thing, `enabled` being a boolean, and nothing else in the request path looks at the value again: `apiBase` interpolates it into three vendor calls, each carrying `authHeaders` — `x-client-id` and `x-client-secret`, i.e. ESIGN_CASHFREE_CLIENT_ID / _CLIENT_SECRET straight out of env.

So anyone who may write `settings/esign` can set the base to a host they control (or to an internal address) and the next `:sign` hands that host the org's vendor credentials, plus the PDF being signed. That is a privilege escalation out of a settings capability into a secret the settings capability was never meant to reach, and an SSRF primitive besides.

This file already knows the rule. `downloadSigned` runs `assertPublicHttpsUrl(target)` on every hop of the vendor's `signed_doc_url` and strips the credentials before following a redirect, under a comment explaining that a vendor URL must not become an internal fetch and that a custom header rides across an origin change where `Authorization` would not. The same guard is applied to the workflow webhook action (automationEngine.ts:341) and to a push subscription endpoint (webPush.ts:36). The one URL that is CONFIGURED rather than vendor-supplied — and the only one that travels WITH the secret — is the one that is not checked.

`redirect_url` (:175) is unvalidated on the same key; it is handed to the vendor as where the signer lands after signing, i.e. an open redirect for a person who has just completed an Aadhaar journey. Smaller, same cause.

Fix: run `assertPublicHttpsUrl` over `api_base` in `validateEsign` (so it cannot be stored) and again in `apiBase()` (so a row written before the validator existed cannot be used) — the two-line pattern `domain/incomeTax.ts#assertComputableRegime` just established for `tax-config`. Validate `redirect_url` the same way.

---

27. MEDIUM-HIGH — the signature stamp verifies the bytes the document says were signed, never that they are the whole document

web/src/lib/pdfSignature.ts:63-79, :137-150 · web/src/components/common/SignedPdfViewer.tsx:126-131

67:   const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
141:   const signed = new Uint8Array(b + d);
143:   for (let i = 0; i < b; i++) signed[i] = pdfBin.charCodeAt(a + i) & 0xff;
144:   for (let i = 0; i < d; i++) signed[b + i] = pdfBin.charCodeAt(c + i) & 0xff;

`/ByteRange [a b c d]` is the signer's claim about which bytes the PKCS#7 covers. The verifier rebuilds exactly those bytes and asks PKI.js whether the digest and signature check out — and they do, because they always will: the range is self-describing, so a document that says "only these bytes are signed" gets graded on only those bytes. Nothing asserts the property that makes the answer mean anything: `a === 0`, the gap `[a+b, c)` being precisely the `/Contents` hex, and `c + d === bytes.length`. Adobe reports that separately ("the signature covers only part of the document"); here it is not computed at all.

A PDF is appendable. Take a genuinely e-signed letter the app produced — an offer, a salary revision, a policy copy — append an incremental update that supersedes the page content, leave the original trailer, `/ByteRange` and `/Contents` untouched, and upload it as a personal document. `integrity` is true, the chain still walks to a bundled CCA root at the original signing time, so `validity` is "valid": SignedPdfViewer draws the green tick, "Signature valid", and "Digitally signed by <the real signer>" over a document whose visible text is whatever was appended. Documents.tsx:1004 opens this viewer on stored documents, including ones an employee uploaded, which is exactly the population that has a motive.

A second, smaller one in the same function: `const signer = sd.certificates?.[0]` assumes the first certificate in the PKCS#7 is the signer's. `sd.verify({ signer: 0 })` resolves it properly from `signerInfos[0]`, but the NAME, serial and trust anchor shown to the reader come from `certificates[0]`, which in a chain-carrying SignedData is often an intermediate CA. The stamp can therefore attribute a signature to the wrong subject.

Fix: compute coverage before trusting anything — reject (or drop to "unknown" with "signature does not cover the whole document") unless the two ranges plus the `/Contents` gap tile the file exactly, and unless this is the newest revision. Resolve the signer certificate from `signerInfos[0].sid` rather than taking the first one in the bag.

---

28. MEDIUM — accrual credits the month in progress in full, so the leaver-month proration is only in force when the exit was known before that month began

src/domain/leave.ts:85-96, :128-141 · src/services/leaveAccrual.ts:138-167

85:  function monthFraction(monthIdx: number, startMs: number, endMs: number | null): number {
140:      add += rate * monthFraction(idx, i.startMs!, i.endMs);
150:        const newBalance = roundToIncrement(existing.balanceDays + add, inc);

`computeMonthly` walks up to `lastIdx = min(currentIdx, endIdx)`, so the CURRENT month is always credited, and with `endMs` null `monthFraction` returns 1 for it. The nightly tick therefore hands out the whole month's entitlement on the 1st. `lastAccrualYm` then marks that month as done, and `add` is only ever added (`existing.balanceDays + add`) — there is no path that recomputes or reduces a credited month.

So the both-ends clamp `monthFraction` was written for only bites when `employees.end_date` is already set at the moment that month is first accrued. Someone who is active on the 1st and leaves on the 3rd has already been credited the full month; the next tick reads them (the 62-day leaver window at leaveAccrual.ts:59 is there for this), computes `fromIdx = credited + 1 > lastIdx`, adds nothing, and the over-credit stands. The header at leaveAccrual.ts:48-54 says including leavers is what makes the exit month deterministic — it makes the *decision* deterministic, but the decision was already taken at the top of the month.

This is money, not tidiness, and the file says so twice: accrued days are encashable, and services/settlements.ts prices `encashableBalances` into the FnF payout. It is the same asymmetry finding the `monthFraction` comment describes, one layer up.

Fix: either accrue a month only once it has ended (walk to `lastIdx` exclusive of the current month), or make the exit path reconcile — when an end date is set, recompute the final month's entitlement from `monthFraction` and debit the difference, the way `releaseSettlementStmts` reverses what a settlement consumed.

---

29. MEDIUM — ATS pipeline stage keys collide, and settings/ats is the one workflow key with no validator

web/src/pages/Settings.tsx:913, :924 · src/routes/settings.ts:303-312 · web/src/pages/Pipeline.tsx:123-131

913:  const addStage = () => setCfg((c) => ({ ...c, stages: [...c.stages, { key: `stage_${c.stages.length + 1}`, ... }] }));
924:    const stages = cfg.stages.map((s) => ({ ...s, key: s.key || stageSlug(s.label), label: s.label.trim() || s.key }));

The key is minted from the array LENGTH. Add a stage to the five defaults (`stage_6`), delete any earlier one, add another: length is 5 again, so the new stage is `stage_6` too. Save freezes existing keys (`s.key || …`), so both go to the server, and nothing rejects them — `SETTING_VALIDATORS` has entries for ctc, esign, payslip, asset-tags, organization, attendance, tax-config, professional-tax and ticket-workflow, and none for `ats`.

Downstream, two stages share one identity. `byColumn` seeds `m.set(col.key, [])` per column, so the second wins and both columns render the same array — every application in that stage appears twice on the board. `nextStage` (domain/ats.ts:95) resolves by `indexOf`, so `:advance` from either duplicate moves to the successor of the FIRST, silently skipping a stage of the pipeline. Dropping a card into either column PATCHes the same value.

Boards had the identical shape and rejects it: `normalizeColumns` / `normalizeSwimlanes` / `normalizeLabels` (domain/boards.ts:59-112) each throw `duplicate <thing> key`, and `configureBoard` runs them on every write. The recruiting pipeline — same kind of config, same consequence — has no equivalent.

Related, same key: REMOVING a stage that live applications sit in is accepted without comment, and Pipeline.tsx:128 files those applications under `m.get(CLOSED)!`. An active candidate is then displayed in the Closed column while `status` is still `active` — the ticket-workflow stranding (finding 13) wearing a different hat, and the reason `validateTicketWorkflow` was added.

Fix: register a `validateAts` that rejects duplicate/empty stage keys, an empty stage list, and a config with no `hired` stage (the SPA already checks the last of those client-side and it is the weakest of the three); and mint the key from a slug of the label with a uniqueness pass, as BoardConfigPanel's save does for columns. Warn — or refuse — when a removed stage still has applications in it.

---

30. LOW — the board settings panel dedupes column keys and not swimlane or label keys, so those saves fail at the server with the panel's own error

web/src/settings/BoardConfigPanel.tsx:56, :103-116, :215, :229

103:    const seen = new Set<string>();
104:    const columns = cols.map((c) => { let k = slug(c.key || c.label); while (seen.has(k)) k = `${k}_`; ... });
112:      swimlanes: mode === "custom" ? lanes.map((l) => ({ ...l, key: slug(l.key || l.label) })) : board.swimlanes,
113:      labels: labelCat.map((l) => ({ ...l, key: slug(l.key || l.label) })),

Lanes and labels are minted the same length-based way as ATS stages (`lane_${ls.length + 1}`, `label_${ls.length + 1}`), so add-then-remove-then-add produces a duplicate; two lanes given the same label do too, since the key is slugged from it. Columns get the `while (seen.has(k))` pass; the two lines under them do not.

The server catches it — `normalizeSwimlanes` throws `duplicate swimlane key` — so this is not corruption. It is a save that cannot be made to succeed from the panel that produced it: the message names a key the user never typed and the UI offers no way to see or change it. Same fix as the columns two lines up.

---

31. LOW — the Cashfree webhook secret documented as an override is actually a fallback

src/services/esign/cashfree.ts:230-233

230:    // Cashfree signs with the client secret (apiSecret); webhookSecret is accepted as an override if an operator configures one.
232:    const secret = i.secrets.apiSecret || i.secrets.webhookSecret;

`apiSecret` is always set (it is in `requiredSecrets`), so `webhookSecret` is only ever reached when the client secret is absent — which is a configuration that cannot create a request in the first place. An operator who configures a distinct webhook secret gets every delivery rejected by `timingSafeEqual`, silently: `parseWebhook` returns null, the route still acks, and completion arrives only when the poll fallback happens to run.

Fix: `i.secrets.webhookSecret || i.secrets.apiSecret` to match the comment, or delete the override and say so.

---

32. LOW — the approvals provider's `loading` counts queues it deliberately never fetches

web/src/lib/approvals.tsx:265-266

263:  // Only the ENABLED queues count: a disabled collection sits at its initial state forever ...
265:  const reads = [leave, reimb, overtime, remote, regular, encash, loan, time, expense, assetReq];
266:  const loading = reads.some((q) => q.state === "loading" && q.rows.length === 0);

The comment states the rule; the expression does not implement it. `useCollection` with `enabled: false` still calls `getSnapshot`, which mints an entry in state `"loading"` with no rows (resourceStore.ts:617) and never fetches it, so a disabled queue satisfies the predicate forever.

Today only the inbox reads `loading`, and its route asks for ALL_QUEUES with `history`, so every queue is enabled and the expression happens to be right. Every other route (`dashboard` lists eight, `attendance` one, `leave-requests` one) leaves the rest disabled and, with `withHistory` false, disables even a listed queue whose server count is zero — so the first page that renders a spinner or an empty-state off `loading` will render it permanently, and the failure will read as a data problem rather than a predicate one. `error` on the next line has the same shape but fails safe (a disabled entry has no error).

Fix: carry the enabled flag beside each read and filter on it, e.g. `reads.filter(([on]) => on)`, so the code says what the comment says.

---

33. LOW — settings/gratuity is unvalidated, and every way it can be wrong is silent

src/domain/settlement.ts:175-179 · web/src/pages/Settings.tsx:788-791 · src/routes/settings.ts:303-312

175: export function gratuityAmount(lastDrawnWage: number, years: number, cfg: GratuityConfig, servedYears = years): number {
176:   if (!cfg.enabled || servedYears < cfg.min_years || !(lastDrawnWage > 0)) return 0;
178:   return round2((lastDrawnWage / div) * cfg.days_per_year * years);

The four numeric fields are written straight from `Number(e.target.value)` with no floor and no validator behind them. `divisor` is guarded (`cfg.divisor > 0 ? cfg.divisor : 26`); the other three are not. `days_per_year: 0` pays every leaver zero gratuity, and `min_years: 0` pays statutory gratuity to someone who left in their first week — both from an emptied field, both silent, and both landing on the one payout a leaver has no later run to correct.

This is the class of hazard the round that added `validateTaxConfig` and `validateProfessionalTax` was about: "a money helper whose failure mode is 'returns zero without saying so' is the exact shape these functions exist to prevent" (domain/incomeTax.ts). Gratuity is the remaining money-shaping key with no entry in `SETTING_VALIDATORS`; `overtime`, `expenses` and `referrals` are in the same position one notch down.

Fix: a `validateGratuity` requiring `min_years >= 1`, `days_per_year > 0`, `divisor > 0` and a non-negative cap when `enabled` is true.

---

34. LOW — the email provider call is the one outbound fetch with no timeout, on the path the nightly tick spends its budget through

src/lib/email.ts:163

163:        res = await fetch(req.url, { method: "POST", headers: req.headers, body });

Every other vendor call in the app is bounded: `vendorFetch` wraps Cashfree in `AbortSignal.timeout(VENDOR_TIMEOUT_MS)`, the OAuth code exchange sends `AbortSignal.timeout(10_000)`, and the /diag relay catches and answers 502. A mail provider that accepts the connection and never answers holds this invocation until the platform kills it — and the callers are `fanOutEmail` and the cron's reminder subtasks, which send in sequence, so one hung send takes the rest of the night's subtasks with it (the same failure mode services/emailFanOut.ts was bounded for).

Fix: give it the same `AbortSignal.timeout` and let the existing `upstreamFailed` branch report it.

---

## 26-34: applied

All nine are fixed in the tree. What each one became:

26. `assertPublicHttpsUrl` over every driver URL in `validateEsign` (so it cannot be stored) and again in
    `apiBase()` / `redirectUrl()` (so a row written before that cannot be used). A bad `redirect_url` is dropped
    with a warning rather than failing the signing; a bad `api_base` throws, because continuing would mean
    sending the credentials somewhere unjudged.
27. `extractRawSignatures` now measures `tilesFile` (ranges start at 0 and omit only the container) and
    `reachesEnd` (nothing but whitespace follows), `verifyOne` takes `isLast` so a countersigned document is
    judged correctly, and coverage decides `validity` - an appended revision reads "Signature invalid" with
    "the document was changed after it was signed" under it. The signer certificate is resolved from the
    SignerInfo instead of `certificates[0]`.
28. `domain/leave.ts` marks a period priced against a known last working day (`FINAL_MARK`), and reconciles the
    difference once when an exit appears for months already credited in advance. The accrual job floors the
    resulting balance at zero.
29. `validateAtsConfig` (unique slug keys, a hired terminal, well-formed criteria) registered as the `ats`
    validator, plus an `orphanedStages` check on the write so a stage cannot be removed while live applications
    sit in it. The Settings panel mints a free key and uniques on save.
30. One `unique()` pass over columns, swimlanes and labels in BoardConfigPanel.
31. `webhookSecret || apiSecret`, so the documented override is one.
32. The enabled flag travels with each read; `loading` and `error` are computed over the queues actually fetched.
33. `validateGratuity` registered: qualifying service, days per year, divisor and ceiling, checked when the
    policy is on.
34. `AbortSignal.timeout(VENDOR_TIMEOUT_MS)` on the provider call.

New tests: `test/settingsValidators.test.ts` (esign URLs, gratuity, ats + orphaned stages),
`test/pdfSignatureCoverage.test.ts` (the coverage arithmetic, including the appended-revision case), and four
reconciliation cases in `test/leave.test.ts`. Whole suite green: 250 files, 3058 tests; both tsconfigs and
eslint clean.

---

35. MEDIUM — a tax declaration is verified against whatever it says at the instant of the click, not what the verifier read

src/services/taxDeclarations.ts:94-106 · src/routes/taxDeclarations.ts:50

 94: export async function verifyTaxDeclaration(deps: Deps, actor: AppUser, id: string, verifiedAmount?: number | null) {
 95:   const row = (await deps.db.select().from(schema.taxDeclarations).where(eq(schema.taxDeclarations.uuid, id)).limit(1))[0];
 98:   const updated = (await deps.db.update(schema.taxDeclarations)
 99:     .set({ status: "VERIFIED", verifiedAmount: verifiedAmount ?? row.declaredAmount, ... })
100:     .where(eq(schema.taxDeclarations.uuid, id)).returning())[0]!;

The verb takes no `If-Match` (the route does not pass one, the service has no parameter for one) and guards on no prior status. It re-reads the row and stamps VERIFIED on that read - so the decision applies to the row as it stands when the request lands, which is not necessarily the row the verifier looked at.

The subject of the decision is the one person who can move it. An employee edits their own declaration while it is DECLARED (`updateTaxDeclaration` resets `status` to DECLARED on every patch, which is correct), and the proof document behind it is a slot that `putAttachment` overwrites. So: HR opens the queue, reads a ₹50,000 80C claim and its proof, clicks Verify; the row now says ₹5,00,000 with a different proof; `verified_amount` is absent (the dialog's "accept as declared" path), `?? row.declaredAmount` takes the new figure, and the verified amount is one nobody reviewed. Only a VERIFIED amount cuts withholding (services/taxProjection.ts `verifiedDeductions`), so this is money, and it is the one decision in the app whose beneficiary controls the thing being decided.

Every other consequential write in the app is pinned one way or the other: the workflow flips are exactly-once guards (`.where(and(eq(uuid), eq(state, <from>)))` - see services/expenses.ts, which says so in a header), and the patches take `If-Match` (`updateTaxDeclaration` two functions above takes one). Access rules make the same problem impossible by being immutable between request and approval (services/accessRules.ts: create/delete only, so `decideAccessRule` cannot decide a row that has changed). This verb is the exception on both counts.

Fix: accept `If-Match` on `:verify` (the factory's verbs already receive the header - services/payroll.ts uses it, and web/src/api.ts `invoke` already has the parameter) and guard the flip on the `updated_at` the verifier read; a stale etag then means "this declaration changed - look again" rather than a silent verification of new figures.

---

36. MEDIUM — the "everyone" audience includes people who have left, so a departed employee keeps getting company announcements by notification, email and push

src/services/notifications.ts:320-323 · src/services/lifecycle.ts:110 · src/services/webPush.ts:58-72

319: // All active (non-deleted) employee uuids - the broadcast audience for org-wide notifications (announcements).
320: export async function activeEmployeeIds(deps: Deps): Promise<string[]> {
321:   const rows = await deps.db.select({ uuid: ..., deleteTime: ... }).from(schema.employees);
322:   return rows.filter((r) => !r.deleteTime).map((r) => r.uuid);

"Active" here means only "not soft-deleted". `status` is a separate column and offboarding is what sets it: `terminateForOffboarding` stamps `status: "terminated"` and disables the login (services/transitions.ts:200), and it does NOT stamp `delete_time`. So every leaver the org has ever offboarded stays in the org-wide audience.

Three surfaces carry it, and none of them needs a session:
 - the in-app notification rows, written per recipient on every publish (lifecycle.ts:110),
 - the email copy of the post, sent to the SAME audience when the author asked for it (the `emailed_at` block just below that line) - to their work address,
 - web push: `pushToEmployee` joins `preferences` to `users` on `employee_id` with no status filter (webPush.ts:64-71), so a device a leaver registered while employed keeps buzzing with company announcements after they have gone.

`audienceEmployeeIds`'s `department` branch filters the same one column, so a departmental post has it too, and the automation engine's `emailAudience` action resolves through the same function - a workflow rule with an org-wide audience mails leavers as well.

The codebase has already decided this question everywhere else. cron.ts's `activeRoster` filters BOTH columns, under a comment that names this exact failure ("two of them filtered on status alone and went on emailing and notifying people who had been deleted"); routes/holidayFeed.ts refuses a terminated employee because "the URL lives on in whatever calendar client they pasted it into"; payroll's roster excludes them. This function is the one that kept the looser reading - and it is the broadcast one.

Fix: filter `status <> 'terminated'` AND `delete_time is null`, in SQL (the JS filter also reads every deleted row to discard it), in `activeEmployeeIds` and in the department branch beside it. Worth deciding separately whether `pushToEmployee` should refuse a disabled user outright - it is the surface that reaches a device rather than an inbox.

---

37. MEDIUM — the compensation tab solves the CTC split with its own solver, and uses the answer to tell HR a stored row is stale

web/src/components/common/EmployeeCompensation.tsx:195-221, :226-235 · src/domain/payroll.ts:276-331

198:   const splitPreview = useCallback((annualCtc: number, structurePath?: string) => {
216:     let lo = 0, hi = monthlyCtc;
217:     for (let i = 0; i < 48; i++) { const mid = (lo + hi) / 2; if (ctcOf(mid) < monthlyCtc) lo = mid; else hi = mid; }
218:     return { basic, special: r2((lo + hi) / 2), monthlyCtc: r2(monthlyCtc) };

The comment says "mirror the server `splitCtc` exactly". It does not, and the difference is the part the server was deliberately built around.

`ctcOf` is a STEP function: ESI stops at its eligibility ceiling, PF caps at its wage ceiling, so lifting the Special Allowance does not lift CTC monotonically. The server's solver (domain/payroll.ts:276) scans 64 samples, collects EVERY crossing bracket, bisects each one, scores the candidates on the ROUNDED plug (`consider` - because `round2` is what is persisted), prefers the smaller plug on a tie, and returns `null` when the best residual is still outside `CTC_TOL`. The client runs one bisection over `[0, monthlyCtc]` on the monotonicity assumption, never scores the rounded value, and always returns an answer. On any employee whose plug range crosses one of those steps the two produce different figures.

That would be a cosmetic preview problem if the number were only previewed. It is not: `staleSplit` (:226) compares this client answer against the STORED `base_pay` / `special_allowance` and, when they differ by more than ₹1, tells HR the row is stale and offers a re-apply - under a comment asserting "Same solver the server re-applies with, so a warning here means a re-apply really would change this row." Where the solvers disagree, that sentence is false in both directions: a warning on a row the server would not change, and silence on one it would.

This is the rule the repo keeps arriving at from the other side - web/src/pages/Expenses.tsx imports `advanceRecurrence` from the server domain rather than restating it ("The copy rolled end-of-month overflow forward where the server clamps it, so the schedule disagreed with itself before it had run once"), and web/src/lib/attendance.ts now imports `leaveCover` for the same reason, noting that "the web bundle can't import from src/" does not hold.

Fix: import `splitCtc` and `ctcLines` from `src/domain/payroll.ts` and delete the local solver and build-up. They are pure, take the component list and the config as arguments, and the page already holds both.

---

38. LOW-MEDIUM — the compensation tab decides the financial year from the browser's UTC clock

web/src/components/common/EmployeeCompensation.tsx:237-242

239:     const fyStartYear = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1; // FY starts in April
240:     const start = `${fyStartYear}-04-01`, end = `${fyStartYear + 1}-03-31`;

The window that decides which bonuses count as this year's variable pay is read off `new Date()` through UTC getters, and the label is spelled out by hand beside it. Both already exist, correctly: `currentFy()` / `fyLabel()` in web/src/lib/fy.ts, which were just moved onto `lib/orgDay.ts` for precisely this reason ("this read `d.getMonth()`/`d.getFullYear()`, which is the VIEWER's local calendar - right about UTC being wrong, wrong about whose local calendar settles it").

Around the 31 March / 1 April boundary this is a different year from the one the rest of the app - and the server - is using: in IST the org is in the new FY from 00:00 local, while UTC says the old one until 05:30. The whole variable-pay total moves for those hours.

Fix: `currentFy()` for the label and its start year for the window.

---

39. LOW-MEDIUM — `finalizedTotals` reads the whole `payroll_runs` table, on the path it calls the hottest read in the app

src/services/taxProjection.ts:252

252:   const runs = await deps.db.select().from(schema.payrollRuns);

Every column of every run the org has ever built, to find the finalized ones inside one financial year. The state filter and the FY window are both applied in JS on the next three lines, and the items read below them carries a comment explaining why a filter like that belongs in SQL: "Only this FY's finalized runs ... the items table is the largest in the app and this is its hottest read path, so the filter belongs in SQL, not in a JS scan."

The narrowing is already written elsewhere in the codebase, for this same table and this same question: `esiContributingAtExit` (services/settlements.ts) bounds the runs by `inArray(state, ["APPROVED", "PUBLISHED"])` and derives the period ids from the CACHED `refPayPeriods` list, under a comment saying the unfiltered version "read the whole `payroll_runs` table and threw away the drafts in JS, which is every run the org has ever built to answer a question about one contribution period".

`finalizedTotals` is called from the payroll build (once per build), from every settlement, from Form 16 generation and from the tax projection the Tax page renders, so it is the most-called of the three.

Fix: the same shape - `where(inArray(state, [...]))` plus `inArray(payPeriodId, idsInFy)` from `refPayPeriods`, and select the three columns it reads rather than `select()`.

---

40. LOW-MEDIUM — the comp-off tick reads every position row the org has ever written to find out where twenty people sit

src/services/compOff.ts:71-76

71:   const positions = await deps.db
72:     .select({ employeeId: ..., location: ..., effectiveTo: ... })
73:     .from(schema.positions);
75:   for (const p of positions) if (!p.effectiveTo) locationOf.set(p.employeeId, p.location ?? null);

`positions` is effective-dated history - a row per revision per employee, never pruned - and this reads all of it to build a map for the handful of people who actually punched on a holiday (`minutesByEmployee`, computed twenty lines above). D1 bills rows read, so the cost of crediting comp-off grows with the org's promotion history rather than with the number of people who worked the holiday.

It sits in the file that was rewritten to stop exactly this: the long comment above `planned` describes the previous version's per-employee round trips as "two hundred sequential round trips against a per-invocation ceiling ... in the nightly tick, as its LAST subtask, after twenty-one others had already spent from the same budget", and everything else here is now planned in memory and written once. This read was left whole.

Fix: bound it to the employees in hand and to the open row - `inArray(employeeId, [...minutesByEmployee.keys()])` (chunked, `byIdChunks` is already imported) with `isNull(effectiveTo)`.

---

41. LOW — a board card due TODAY shows as overdue for the whole working day

web/src/pages/Boards.tsx:793-795 · web/src/pages/Goals.tsx:72, :235

793:   const due = card.due_date && !card.deliver_time ? new Date(card.due_date) : null;
794:   const overdue = !!due && due < new Date();

`due_date` is a DATE-ONLY value, so `new Date(card.due_date)` is that day at UTC midnight; comparing it against the current instant asks "is it later than the start of the due day", which is true for all but the first moments of the day itself. In IST a card due today is red from 05:30 local, with a tooltip reading "Overdue — was due <today>" - and `dueSoon` never fires for it either, because the delta is already negative.

The same question is asked correctly two pages over: Goals compares `g.due_date < todayStr()` (web/src/lib/orgDay.ts - the org's calendar day, as a string, against a date-only string), so a goal due today is not overdue. One concept, two answers, on the two surfaces a person uses to track their own work.

Fix: compare days, not instants - `card.due_date.slice(0, 10) < todayStr()`, with `dueSoon` off `daysBetweenYmd`. Both helpers are in lib/orgDay.ts.

---

42. MEDIUM — the change feed compares two different clocks with a strict `>`, and the losing case is a stored copy that is never corrected

src/services/changes.ts:59, :67-76 · src/db/changeDdl.ts:24 · src/routes/changes.ts:18

changes.ts:59:  export async function changedSince(deps: Deps, sinceMs: number, now = Date.now()): Promise<ChangesAnswer> {
changes.ts:71:    const rows = (await deps.db.select(...).from(schema.collectionVersions).where(gt(schema.collectionVersions.at, new Date(sinceMs))));
changeDdl.ts:24: const NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

The client stores the `now` this endpoint returns and sends it back as `since`; the stamps it is compared against are written by SQLite triggers from the DATABASE's clock. Two clocks, one strict comparison, and no margin between them.

If the D1 node's clock sits even slightly behind the Worker's, a write that happens just before the feed answers is stamped BELOW the `now` the client is told to use, `at > since` is false on the next call, and the collection is never named. And nothing comes back for it: the client adopts its stored copy as fresh (lib/resourceStore.ts `trustDisk`), the freshness tiers restart from the moment of adoption, and the only thing that would ever correct it is a LATER write to the same collection. A collection that was edited once and then left alone is served from disk, wrong, for as long as the stored copy lives - `MAX_AGE_MS` is seven days for rows.

Even on one clock the boundary is wrong by a millisecond: `gt` drops a stamp equal to `since`, and `now` is captured at function entry (a default parameter, before the await), so a write committing in the same millisecond as that capture is exactly the case that is dropped.

This is the one failure the design says it exists to prevent - "a missed write means a page serves yesterday's rows and never finds out" (src/db/changeDdl.ts), and it is why the stamps come from triggers rather than from the audit log in the first place. The asymmetry is the same one http/pagination.ts already reasons about in its cursor fallback: re-reporting a collection costs one list read, missing one is silent staleness.

Fix: hand the client `now - SKEW_MS` (a couple of seconds) as its next `since`, and/or compare with `gte`. Both err toward re-reading a collection that did not change, which is the affordable direction. Better still, answer with the largest `at` the stamps table actually holds, so the value the client echoes is on the same clock as the values it will be compared against.

---

43. MEDIUM — two collections take their OWNER from the request body and are not declared in `OWNER_REFS`, so nothing gates creating one under somebody else

src/domain/manifests.ts:92-131 · src/services/approvalDelegations.ts:86-93 · src/services/backgroundChecks.ts:57-62, :78-81 · src/middleware/authz.ts:172-183

authz.ts:176:  for (const [field, spec] of Object.entries(ownerRefs)) {
authz.ts:181:      const d = decide(grant, { kind: "standard", resource: `${collection}.${ownerCode}`, level: "write" }, self);

That loop is the whole of the create-on-behalf-of gate, and it iterates the collection's `OWNER_REFS` entry. A collection absent from that map has `ownerRefs = {}`, so the loop runs zero times and an owner field in the body is accepted as given. `LIST_OWNER_COLUMNS` (lib/authzResolve.ts) names the owner column for both of these, so the ROWS are scoped by it correctly - it is only the write that is ungated.

`approval-delegations` (owner column `delegatorId`):

 86:  insert: async (input, deps, actor) => {
 87:    const delegatorId = idFromPath(input.delegator) ?? actor.employeeId;

`delegator` is accepted from the body and there is no check that it is the caller. A holder of `approval-delegations.write` - including at `me` scope, which is the shape this self-service feature invites, since it exists so somebody can arrange cover before going on leave - can POST `{delegator: "employees/<a manager>", delegate: "employees/<themselves>", from_date: today, to_date: today}`. From then on `activeDelegatesFor` returns them for that manager, and services/notifications.ts:302 copies every approval nudge addressed to that manager to them: "<name> submitted a leave request. You're covering approvals for their manager." - by in-app notification, and by push. It is not an authority escalation (the delegate still needs their own grant to decide anything), it is an unconsented subscription to another manager's queue, and the delegator is never told: nothing in this service notifies them, and under a self scope the row is not even in their own list.

`background-checks` (owner column `employeeId`): `employee` is taken from the body on create (:58) AND is patchable (:78-81), so a narrowly-granted holder can file a check under another employee or re-point an existing one at a different person - moving a vendor report into somebody else's file.

The map's own comment states the rule these two miss, for the collections that do declare it: "Admin-created comp records. Default holders have `**` write so the owner check is a no-op for them; the point is defense-in-depth: if any of these is ever granted at a narrow (self/dept) scope via the ACL, create-on-behalf-of-another is blocked ... closing a BOLA-write gap." `compensation`, `positions`, `bonuses`, `settlements` and `leave-encashments` are all listed on exactly that reasoning. These two are the same shape and are not.

Neither appears in `REFERENCES` either, so `delegate` / `employee` are not gated as references on the way in, and a delegation can name an employee uuid that does not resolve at all.

Fix: add `"approval-delegations": { delegator: { collection: "employees" } }` and `"background-checks": { employee: { collection: "employees" } }` to `OWNER_REFS`. Both are one line, and `test/bola.test.ts` is where the case belongs.

---

Note on 36. The leaver gap has a third instance, and it is the one that states the intent outright. services/emailFanOut.ts:64-72 reads `delete_time` when it resolves each batch's addresses, under a comment saying "the soft delete is exactly the write that is supposed to stop company mail reaching a leaver" - while offboarding (services/transitions.ts:200) stamps `status` and never `delete_time`. So the check that exists to keep company mail away from someone who has left does not fire for anyone who left through the front door. Meanwhile services/documentAck.ts:41-46 (`ackRoster`) and src/cron.ts (`activeRoster`) both filter status AND delete_time AND disabled - the strict reading is the majority one; the three places that matter for outbound mail are the exceptions.

---

## 35-43: applied

All nine are fixed in the tree.

35. `:verify` and `:reject` take `If-Match` and write through `updateAtVersion`, so the decision applies only to
    the version that was read; the SPA sends the row's etag. A declaration edited between reading the queue and
    deciding now answers 409 instead of verifying a figure nobody reviewed.
36. One roster rule - `status = active`, `delete_time is null`, `disabled = false` - now used by
    `activeEmployeeIds`, by the department audience beside it, and by `emailFanOut`'s per-batch address read.
    `pushToEmployee` joins on the account being active too, since a subscription is the one channel that
    outlives a session.
37. The compensation tab imports `splitCtc`, `componentMonthly` and `pfWagesOf` from `src/domain/payroll` and
    its local copies are gone, so `staleSplit` compares against the solver the server actually re-applies with.
    `componentMonthly` is exported for it.
38. The same page reads its financial year from `currentFy()` (lib/fy → lib/orgDay) instead of the browser's
    UTC calendar, and labels it with the value rather than re-spelling it.
39. `finalizedTotals` bounds the runs read by state and by the FY's pay periods (from the cached period list),
    selecting three columns instead of the row.
40. The comp-off tick reads positions for the employees who actually punched, open row only.
41. The board's due chip compares days (`due_date < todayStr()`), and renders the date-only value in UTC so the
    label names the day the value is.
42. `GET /v1/changes` hands back a reference point rewound by 5s and compares with `gte`, so neither clock skew
    between the Worker and D1 nor a same-millisecond write can hide a change.
43. `approval-delegations.delegator` and `background-checks.employee` are declared in `OWNER_REFS`, so the
    create-on-behalf-of gate runs for them. `scripts/seed.sql` and `bootstrap/bootstrap.sql` regenerated (the
    manifest blob is embedded in both).

New tests: `test/taxDeclarationVerify.test.ts` (4 - including the edit-then-verify race), `test/leaverReach.test.ts`
(4 - offboarded, soft-deleted, disabled, and the department audience), two cases in `test/changes.test.ts`
(rewound reference point, stamp equal to it), and an owner-ref declaration case in `test/bola.test.ts`. Whole
suite green: 252 files, 3071 tests; both tsconfigs and eslint clean.

---

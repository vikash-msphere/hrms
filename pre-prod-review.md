# Pre-production code review - HRMS (Workers + D1 + React SPA)

## Context

Requested: a pre-production review of the app's source, read directly (no gates run, no .md docs read), looking
for any defect that should block or accompany launch. Method: line-by-line reading of the request path end to
end (edge codecs, middleware, authz engine, collection factory, serializers), then the money and lifecycle
services (payroll, leave, expenses, reimbursements, loans, overtime, settlements), privilege surfaces (users,
grants, ACL, API keys, automations, settings), public unauthenticated routes, uploads/exports, the cron job
drain, the AI moderation gate, and the SPA's injection sinks, CSP and API client. Each finding below was
confirmed in code; severities assume the seeded role grants.

Overall: the codebase is unusually defensive (fail-closed authz, guarded state flips, capped body reads,
upload type allow-list, CSV formula neutralising, strict shell CSP). The issues found are concentrated in a
few cross-cutting seams rather than spread thin.

## Findings (ranked)

### HIGH

**F1. Outbound wire-id encoder can crash any response carrying a crafted id-shaped string.**
`src/middleware/encodeWireIds.ts:47,85-98`, `src/lib/idCodec.ts:139-141`. Every response string matching
`<collection>/<13 base32 chars>` is re-encoded; `encode()` throws when the 13-char value is not canonical
base32 (last char's spare bit set), `Promise.all` rejects, and the whole response becomes a 500. Serializers
emit user text verbatim (`src/http/serialize.ts` titles, `bio` at :186, announcement/goal/card titles), so any
user who can set such a string in a shared record breaks every list/item response that includes it, for all
readers (stored denial of service).
Fix: in `encodeWireIds`, skip refs whose id does not decode (`base32ToBytes(id, 8) === null`) and leave the
string untouched; never throw from the outbound edge.

**F2. Caller-chosen `?id=` becomes the primary key without validation on most create paths.**
`src/http/collectionRoute.ts:255-258` passes `queryParam(c,"id")` to `svc.create`. Only the generic create
checks it (`src/services/crud.ts:20,234`, regex only, not canonical form). All `overrides.create` skip even
that: 21 services spread `...(id ? { uuid: id } : {})` unchecked (announcements.ts:253, cards.ts:562,
goals.ts:690, timeEntries.ts:86, taxDeclarations.ts:63, loans.ts:60, employees.ts:163, apiKeys.ts:127,
ats.ts x6, referrals, sprints, boards, ticketChecklists, transitions, automations, reviewCycles). Impact:
feeds F1 on shared collections (board, cards, goals); arbitrary-length/charset PKs; such an id is published
un-tokenized, and `src/services/keysetPage.ts:73` throws when that row ends a page.
Fix: validate once in `collectionRoute` before `svc.create` (canonical 8-byte base32 via `base32ToBytes`),
drop the per-service spreads' trust; add a drift test over every factory collection.

**F3. Approved unpaid leave never reduces pay; with automatic LOP on it is actively excused.**
`src/services/payroll.ts:664-673` (assembleLop reads ALL approved leave), `src/domain/attendance.ts:252-338`
(`leaveCover`/`lopDayUnits` excuse any leave range). `leave_types.paid` is only used for balance checks
(`src/services/leaveRequests.ts:427,536`). The seed ships "Loss of Pay" with `paid:false`
(`bootstrap/collections/leaveTypes.ts:30`). With `attendance.lop_enabled` on, an absent day is docked but the
same day under an approved unpaid-leave request is paid; with it off (the default) unpaid leave affects pay
only if HR remembers to key a manual LOP.
Fix: carry `paid` on each leave range and treat unpaid ranges as owed-but-unworked in `lopDayUnits`; when auto
LOP is off, price approved unpaid-leave days as LOP anyway (or block approval until HR decides). Keep
`web/src/lib/attendance.ts` (imports `leaveCover`) and `services/lopAdjustments.ts` restatement in step.

**F4. No maker-checker guard on approvals; seeded grants let people approve their own money requests.**
Deciders check state only: `overtimeRequests.ts:67`, `leaveRequests.ts:617`, `reimbursements.ts:105`,
`expenses.ts:555`, `loans.ts:106/127/140` (approve/disburse/recordRepayment), `leaveEncashments.ts:271`,
`attendanceRegularizations.ts:84`, `remoteWorkRequests.ts:72`, `assetRequests.ts:82`, time-entry approve.
Manager `*.my-dept.approve` matches the manager's own rows (own code sits under own dept), so a manager can
approve their own overtime (paid by the next run), expense (spawns an approved reimbursement) or
regularization (removes LOP). payroll_admin can approve/disburse their own loan and record repayments against
it; hr_admin can approve their own claims/encashments. Only day-marks (`attendanceDayMarks.ts:54`), ACL rules
and tax verification refuse the subject.
Fix: shared `assertNotSubject(actor, row.employeeId)` in every decide/pay/disburse/recordRepayment path
(optionally a setting for one-person teams, default on).

**F5. Editing an employee's work email re-points the linked sign-in identity, across privilege levels.**
`src/services/employees.ts:318,354,196-234` rewrites `users.email` from `work_email`; auth resolves callers by
that column (`src/middleware/auth.ts:330`). Whoever may edit employee base records (seeded hr_admin) thereby
controls the login address of every linked account, including more privileged ones (super_admin), although
`users.*` is super-only and self role edits are refused (`services/users.ts:134`). Practical impact depends on
the editor controlling a mailbox/IdP identity at the new address, which is common in small orgs.
Fix: only move `users.email` when the actor may write that `users` row (or its role is not above theirs);
otherwise keep the login address and surface the mismatch to an account admin.

### MEDIUM

**F6. Full-and-final and payroll can both pay the leaver's last month.**
`src/services/settlements.ts:445-448` prices the exit month by days worked; the run roster is everyone not
`terminated` (`src/services/payroll.ts:769-772`). Only queued payables carry paid-markers; base salary does
not. The code itself notes an FnF "is routinely computed before the exit transition flips that status"
(`settlements.ts:604`). Conversely a leaver terminated before an earlier month's run is built gets that month
from neither path. Fix: FnF nets out any committed run item for its period (or the run excludes employees with
a settlement covering it) and flags unpaid prior periods.

**F7. Approvals are not bound to the version the approver reviewed.**
Verbs take no If-Match and guard on state only (e.g. `src/services/loans.ts:110`), while a PENDING loan stays
editable by the borrower (`loans.ts:75-90`). A principal change after the approver opened the request is
approved as-is, with `monthlyAmount` computed from whichever row approve read. Fix: require/compare the row
etag on approve (atVersion), or freeze edits once pending review.

**F8. ACL authoring is guarded against self-widening but not bounded by the author's own authority.**
`src/services/accessRules.ts:127-140,330-389` and clone at `:418-483`. An access admin can author (or clone
from super) rules for others that exceed anything they hold; four-eyes (`access-approval`) is opt-in and off.
Latent while only super holds `access-rules`, but delegation is presented as the intended use.
Fix: refuse rules the author's own grant does not already cover at that level (unless super); default
four-eyes on once access admin is delegated.

**F9. Manager-chain scopes produce capabilities the SPA and `actorCan` never match.**
`src/domain/permissions.ts:410-421` `stripScope` omits `my-reports`/`my-org`, which the ACL offers
(`accessRules.ts:39-40`). `leave-requests.my-reports.approve` becomes capability
`leave-requests.my-reports.approve`, so `hasCapability(caps,"leave-requests.approve")`
(`src/domain/capabilityMatch.ts:25`) is false: approval UI/pages are hidden and coarse server checks refuse,
while the API allows. Fix: add both tokens to `isScope`.

**F10. Automation templating bypasses the event-log redaction.**
`src/services/automationEngine.ts:157-176,336-354`: non-super authors may write `notify`/`notifyAudience`
rules whose text is templated over the raw event payload (`payslip.published.netPay`, loan amounts, offer
CTC), while `toEventLogResource` deliberately redacts payload values below super (`src/http/serialize.ts:
2086-2126`). Seeded hr_admin already reads `annual_gross` via the tax sub-resource, so the incremental leak is
modest for that role; it is real for any custom role given rule authoring without pay access.
Fix: for non-super-authored rules, template only non-sensitive per-event fields (or apply the same redaction).

### LOW

- **L1** `web/src/components/common/Chart.tsx:340-347`: labels/series names go raw to frappe-charts, which
  writes them with innerHTML (tooltip `frappe-charts.esm.js:238-254`); TableBuilder feeds user text as labels.
  Shell CSP blocks script, so this is markup injection/mangled labels. Escape in the wrapper.
- **L2** `src/services/bankFile.ts:112-189`: a file is not bound to one bank per run; every generated file
  contains every payable employee, so producing files for two banks on one run duplicates payouts if both are
  submitted. Record the bank on first generation and refuse (or warn on) a second bank.
- **L3** `src/middleware/authz.ts:491-497,714-734,851`: view-as containment is skipped for aggregate routes by
  design; `payroll-forecast` then answers with the subject's compensation-derived cost. Only matters if
  `access-rules.preview` is delegated beyond super.
- **L4** `web/public/push-sw.js:25` treats any link starting with `/` as in-app; `src/services/notifications.ts:37`
  strips leading slashes but not backslashes, so a rule-authored link could open another origin. Normalise with
  `new URL(link, origin)` and require same origin.
- **L5** `src/routes/employees.ts:207,225,231` and `src/services/employeePhoto.ts:76` decide field redaction /
  photo scope with a reduced matcher context (no manager chain), so chain-scoped readers lose fields/photos
  they may see (fails closed). Use `c.get("self")` / `selfContextFor`.
- **L6** `src/routes/settings.ts:25` + `src/services/settings.ts:94`: a PATCH without `value` stores `{}` and
  silently resets the key to defaults; validators that early-return on non-objects (esign :61, asset-tags :147,
  attendance :210, organization :249, ctc :36) accept non-object values. Require `value` and an object.
- **L7** `src/services/esign/cashfree.ts:286-290`: replay-window check is skipped when the signed timestamp is
  not numeric (HMAC still required). Reject non-numeric timestamps.
- **L8** `src/http/customMethod.ts:11-12`: `decodeURIComponent` on a malformed id throws URIError -> 500. Catch
  and 400.
- **L9** `src/middleware/requestId.ts:8`: client `x-request-id` is echoed and logged verbatim. Accept only a
  bounded token shape or always mint one.

## Status

All 19 items have code. `tsc` clean (server, web, e2e) and eslint clean on every touched file.

Verified:
- **Full vitest suite: 356 files, 4532 tests, all pass.** One existing suite needed a fixture change for F8:
  `test/accessLifecycle.test.ts` gave its delegated access admins an EMPTY grant, which under the new bound can
  grant nothing; they now hold admin over the collections the suite writes rules for (still not super), and two
  cases were added (a rule past the author's grant is refused; so is approving one).
- **Related e2e specs, on a fresh lane (`E2E_LANE=1`): 8/8 pass** - expenses, expenseCategoryNameClash,
  expenseSpendBreakdown, vendors, loans, payrollBankFile, reimbursements, overtime. Run validity: 267 WebServer
  lines (fresh reset and seed of the new migration), zero ECONNREFUSED, zero hmr reloads.

- **F1** fixed. `isInternalId` (`src/lib/idCodec.ts`) gates every outbound re-encode (encodeWireIds,
  automation `outboundCtx`, `pushLink`); a non-canonical ref passes through as text. Test: `test/encodeWireIds.test.ts`.
- **F2** fixed. `collectionRoute` POST refuses a `?id` that is not a canonical internal id before any
  `create` runs; `crud.ts` uses the same predicate. Test: `test/collectionFactory.test.ts` (generic + override).
- **F3** fixed. `LeaveRange.paid`; `leaveCover` counts paid leave only; `unpaidLeaveDayUnits` prices approved
  unpaid leave when automatic LOP is off (run build and FnF final month); the attendance grid, history and team
  timeline carry the flag via `leaveRangeOf`. Test: `test/attendanceLop.test.ts`. Not changed: a retro-approved
  unpaid leave in an already-published period restates only when automatic LOP is on (the restatement path is
  LOP's).
- **F4** fixed. `src/services/decisionGuard.ts` `assertNotSubject` on every favourable decision (approve, pay,
  disburse, record repayment, issue) across overtime, leave, reimbursements, expenses, loans, encashments,
  regularizations, remote work, asset requests, time entries. The expense auto-approve lane is exempt (org
  policy, not the submitter). Org opt-out: `settings/approvals.allow_self_approval` (validated). The badge count,
  the approvals inbox and the Expenses page's approve/pay queues leave out the viewer's own rows. Four e2e specs
  where one role filed and decided an expense now have payroll decide (expenses, expenseCategoryNameClash,
  expenseSpendBreakdown, vendors). Test: `test/decisionGuard.test.ts`; nine flow tests
  that used one actor for both roles now opt into the setting or use a second approver.
- **F5** fixed. A work-email edit moves the login only when the editor may administer that account
  (`mayAdministerAccount`) or the account is plain (provisioned role only, no second role, no personal rule);
  otherwise the sign-in address stays, `employee.loginEmailMismatch` is audited and account admins are notified.
  Test: `test/employeeAccount.test.ts`.
- **F6** fixed. The run build skips employees whose settlement is dated on/before the period end (named as
  `settled_out` on the build audit); the FnF pays no final-month salary when a committed run already covers that
  period and lists earlier periods with no committed item as `unpaid_periods` on its audit record.
- **F7** fixed. Every decider takes the row's If-Match (routes pass it); loan approve additionally guards its flip
  on the version read, so the instalment is priced off the principal approved. The SPA's Loans and Timesheets
  now send the etag like the other request pages. Test: `test/decisionGuard.test.ts`.
- **F8** fixed. `ruleWithinAuthority` (`src/domain/access.ts`, pattern-against-pattern coverage) bounds every
  non-super allow rule at create (so clone) and at four-eyes approve. Test: `test/ruleAuthority.test.ts`.
  Four-eyes stays opt-in (policy data, `settings/access-approval`).
- **F9** fixed. `stripScope` treats `my-reports`/`my-org` as scope tokens. Test: `test/callerScopes.test.ts`.
- **F10** fixed. Money fields are sensitive by name (`SENSITIVE_PAYLOAD_FIELDS`); a rule no super admin authored
  templates notify/notifyAudience/emitEvent over a masked payload, and may not condition on those fields.
  Test: `test/automationRedaction.test.ts`.
- **L1** fixed (labels, series names, marker labels escaped in `Chart.tsx`).
- **L2** fixed. `payroll_runs.bank_file_bank`: the first file that passes its checks claims the run for its bank
  (guarded update, so two concurrent banks cannot both win); another bank is refused, the same bank regenerates.
  Migration squashed back to one `0000`. Test: `test/payoutOutputs.test.ts`.
- **L3** fixed (under view-as, fan-outs and the payroll forecast drop what the real caller cannot list).
- **L4** fixed (`push-sw.js` opens same-origin links only; server `pushLink` strips backslashes).
- **L5** fixed (`c.get("self")` in the employee sub-resource redactions; `selfContextFor` in batch photos).
- **L6** fixed (settings PATCH requires `value` as a JSON object).
- **L7** fixed (non-numeric webhook timestamp refused). **L8** fixed (URIError -> 400). **L9** fixed (upstream
  request id honoured only as `[A-Za-z0-9._-]{1,64}`). Test: `test/edgeHardening.test.ts` (L8, L9).

## Fix plan (order)

1. F1 + F2 together (edge encoder tolerance, central `?id` validation, drift test across all creates).
2. F4 (shared subject guard) and F7 (etag-bound approvals) in the same pass over the decider services.
3. F3 (paid flag through LOP; decision for LOP-disabled orgs) with matching grid/restatement changes.
4. F5 (login-identity move gated on account-admin authority).
5. F6 (FnF vs run overlap), F9 (`stripScope`), F10 (template redaction), F8 (ACL bound + four-eyes default).
6. Lows as a cleanup batch.

Reuse: `base32ToBytes` (`src/lib/idCodec.ts`), `atVersion`/`updateAtVersion` (`src/services/versionGuard.ts`),
`redactValues` pattern (`src/http/serialize.ts`), `selfContextFor` (`src/lib/selfContext.ts`),
`decide`/`resolveRequest` for authority bounds (`src/domain/permissions.ts`).

## Verification (after fixes)

- Unit (vitest, needs the sandbox bypass): encoder leaves undecodable refs untouched and never throws;
  bad/non-canonical `?id` -> 400 on every factory collection; unpaid-leave day docks LOP (auto on) and is
  priced when auto LOP is off; each decider refuses `actor.employeeId === row.employeeId`; loan approve with
  stale etag -> 409; `capabilitiesOf` maps `my-reports`/`my-org` patterns to base capabilities; work-email edit
  by a non-account-admin leaves `users.email` unchanged; settlement nets a committed run item for its period;
  non-super rule template cannot read redacted payload fields.
- Then the full `npm run verify` gate, and only the related e2e specs (leaves, payroll, expenses, approvals,
  employees, ACL) via `npm run test:e2e -- <specs>`.

## Not covered (for honesty)

Read only in part or not at all: most SPA page components (UI logic and state bugs), ATS/boards/goals/reviews
service internals, letters/PDF rendering, compensation arrears and encashment arithmetic, statutory/tax slab
math beyond structure, the custom-grid runner beyond its raw-SQL use, semantic search and AI draft features,
and the nightly cron subtasks other than the job drain.

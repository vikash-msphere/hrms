# Making /payroll-runs, /payslips, /expenses and /reimbursements smarter

Candidate features for the money surfaces, written against what the AI layer already is (`ai-plan.md`,
`ai-rollout-plan.md`, `ai-boards-goals-reviews-plan.md`) rather than against what an AI feature list usually
looks like.

**Built so far (41 of 46): items 1, 2, 3, 4, 5, 7, 8, 9 (part), 10, 14, 15, 16, 17, 18, 20, 21 (additive half), 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35 (part), 36, 37, 38, 39, 40, 41, 42, 43, 44, 45 and 46 (part).** Kept in NUMERIC ORDER and with the count stated, because three sessions append to this line independently and every one of us has since miscounted it by tracking our own increments instead of re-reading the list.

**What the evidence actually is, item by item, because "the suite is green" is not the same claim.** Behind a
test AND RUN: 1, 2, 3, 4, 5, 7, 10, 14, 15, 16, 17, 18, 20, 22, 24, 25, 26, 27, 28, 29, 31, 36, 37, 38, 39,
40, 41, 42, 43, 45 and 46 - 31 of the 41. Typecheck, lint and reasoning only: 8, 9, 21, 23, 30, 32, 33, 34,
44, and the part of 35 that shipped.

Items 10 and 45 were built and tested but went uncounted on this line for a while, which is the same drift
the paragraph above warns about: a session adds the work, writes the item note, and does not re-read the
header. The count is the thing that gets quoted, so it is the thing to re-derive from the notes rather than
increment.

Nothing is in a "written but not run" state any more: `payrollVariance.test.ts` (28), `payoutCheck.test.ts`
(8) and `payrollJournal.test.ts` (11, including a 200-round property check that the journal balances) were
all written by a session that is not permitted to run the suite, and all three pass. Which session ran them
is not a property of the code - the file-to-item mapping is the author's claim and the pass is the runner's.

The TYPECHECK-ONLY list is the standard of evidence that had just been given for item 40 when eleven lines of
test found it double-crediting an employee advance under a concurrent approve - so it is worth reading as
"not yet known to work" rather than as done. See
`docs/architecture-decisions.md` §"A checked batch is not an atomic one" for what that defect turned out to
be, and for the rule it generalises to.
Who wrote which line is a question for `git log`, and naming sessions here only gave two of them something to
disagree about in a file neither owns.

- **15** - budget burn forecast. `projectBudget` (`domain/expenses.ts`), carried on every budget read as
  `projection`, emitting `expense.budgetProjectedBreach` once per period from the daily sweep.
- **16** - recurring series drift. `seriesDrift` + `seriesDriftFor`, carried on a generated occurrence as
  `series_drift`.
- **22** - the run's timeline, on the run detail as `timeline`. Assembled from the AUDIT TRAIL, not from the
  run row: the run records who did each step (`createdBy`, `submittedBy`, `approvedBy`) and never when, so
  `runTimeline` reads the transition rows one index covers rather than adding a pair of timestamp columns per
  step. Earliest wins for a step that happened twice (a returned run reached review when it first reached it);
  `built` is the exception and reports the latest, because a rebuild is where the current figures came from.
- **24** - four eyes on the payout. `assertMayGenerateBankFile`, refused before `buildBankFile` decrypts a
  single account. It extends the EXISTING `payroll-approval` blob with a second flag (`separate_bank_file`)
  rather than inventing a parallel mechanism: `separateApproverRequired` already guards submit/approve there,
  off by default, with the reasoning this rule inherits - a finance team of one has nobody to hand the file to,
  and the escape is a setting rather than an override a caller can pass. An automation attaching the file has
  no actor, so the rule does not apply to it; that gap is named in the code rather than left to be found.
- **7** - the budget narration. The `analyticsNarrate` shape applied to four org-level totals (budgeted,
  spent, caps over, caps forecast over): arithmetic finds the movements, the model only phrases them,
  `groundedIn` discards any answer carrying a figure nobody computed, and `plainSummary` is a real answer
  rather than a placeholder. Needed NO consented path and no policy argument, which is the whole reason the
  plan says build this before spending a `CONSENTED_PATHS` entry on item 6 - if nobody reads the sentence
  here, the payroll one is not worth the argument. Added a `money` unit to `MetricUnit`, which item 46 needs
  too; the web formatter takes the org's own money helper, because a currency-free number beside a count of
  people reads as a count of people.
- **46** - PART. Money measures in `peopleAnalytics`: `expense_claimed` and `expense_claims`, gated on
  `expenses` like any other measure, with a `money` unit added to `MetricUnit`. SUBMITTED claims are excluded -
  a claim awaiting a decision is a queue, not spend, the same line `computeBudgetSpendMany` draws.
  PAY-DERIVED MEASURES DELIBERATELY NOT BUILT, and that is a finding rather than a shortfall. This document
  called them "team aggregates", but `peopleAnalytics` is not a team-only surface: it answers `employeeId`,
  `employeeIds` and a per-person series. A cost-per-head or payroll-cost measure would therefore put an
  individual's pay on a report that writes NO audit row, where reading the same figure at
  `GET /v1/payslips/<id>` writes a `payslips.read.sensitive` one - `AUDIT.sensitive_collections` names
  payslips for exactly that reason. The SCOPING would be correct; the accountability trail would not. Closing
  it needs either a team-only flag on `MetricDef` or an audit row when a sensitive measure is served for a
  named person, and both are audit-policy decisions - so this is a fifth entry for the human list beside the
  INDEXABLE question, the vision model and the `CONSENTED_PATHS` argument. Of the two closures, the TEAM-ONLY
  FLAG is the one that fails safe: a new measure would default to team-only and somebody would have to argue a
  per-person one into existence, where the audit-row approach defaults the other way and leaves a measure
  added later individually readable until somebody remembers to classify it. Same argument as
  `NEVER_TO_MODEL` being default-deny.
- **14** - category policy checked at SUBMIT, not at reject. `expense_categories.amount_cap` +
  `max_age_days`, and `categoryBreaches` in `domain/expenses.ts`. The same pure function runs on the server at
  `submitExpense` and in the form as a warning, so the two cannot drift into a form that accepts what the
  server refuses. Every breach is reported at once - fixing the amount only to be told about the date would be
  the same round trip in a new place. A rated category is exempt from the receipt rule, because there is no
  invoice for a car journey and a category that was both rated and receipt-required would be unsatisfiable.
- **17** - the straight-through lane. Auto-approval already existed but fired on AMOUNT ALONE, so a duplicate
  under the threshold approved itself and so did a claim that put its budget over. `auto_approve_requires` is
  the org's own list of what routine means (in budget / not a duplicate / known vendor / receipt attached),
  every one arithmetic over rows. A held claim is not rejected - it stays SUBMITTED and goes to a person, with
  the reason audited, which is what would have happened with no lane at all. `in_budget` has three answers, not
  two: no cap covering the claim counts as satisfied, or a guard would refuse claims for want of a budget
  nobody created. Item 42 is the counterweight: straight-through below a line is only defensible while there is
  a firmer hand above one.
- **18** - the approver's queue, triaged. Not "you have 14 claims" but which three are not routine:
  `expenseTriageFor` assembles the duplicate match (17), the budget check (15) and the receipt rule (14) into
  per-claim signals, plus a summary line above the queue. SERVER-SIDE AND BATCHED, which is the whole point -
  every signal is a statement about the collection (a duplicate filed by somebody else, a budget the client
  never loaded) and a page-local check can only answer from its page. Four reads for any number of rows, and
  none at all on a page with nothing awaiting a decision. A duplicate pair inside one queue is reported once,
  on the later filing, because telling an approver each row is a copy of the other says it twice and names
  neither as the original.
- **20** - the month-end close checklist. `GET /v1/expense-close`, a virtual collection in the shape
  `/v1/approvals-summary` already established: it owns no rows and grants nothing, the middleware resolves a
  list verdict per collection, and the service only binds those to counts - so a department manager sees their
  cost centre and finance the org, and a caller who may list neither gets an empty checklist rather than a 403.
  Counted SERVER-SIDE over the whole scoped set, because a list caps at 100 rows and a checklist assembled from
  a page would be a statement about page one. Checks: approved-unpaid, awaiting approval, past the vendor's
  terms (item 43's due dates), missing a required receipt, recurring schedules that have not filed, budgets over
  and budgets forecast over (item 15's projection). A budget already over is not counted again as forecast over.
- **21** - `pay_periods.input_cutoff_on`, nullable, validated to sit between period start and pay date.
  ADDITIVE HALF ONLY: nothing yet refuses or warns on a late income-affecting write, which is the other half
  the item describes.
- **37** - mileage and per diem as rated categories. `expense_categories.rate_kind` + `rate`,
  `expenses.quantity`, and `ratedAmount` in `domain/expenses.ts`. The SERVER multiplies - a client sending both
  a quantity and an amount is sending a preview, not an instruction - and a rated claim needs no receipt,
  because there is nothing to attach to a car journey. NOT effective-dated: changing a rate applies from that
  moment on, filed claims keep their stored amount, and a claim filed today for last year's trip is priced at
  today's rate. An org that backdates across a rate change needs a per-period rate table; that is the follow-up
  rather than something a single column should pretend at.
- **41** - allocation lines: one invoice split across cost centres. `expense_allocations` is a CHILD row
  reached only through its parent, like `attachments`, so it needs no code, no authz entry and no routes of its
  own. `computeBudgetSpendMany` expands a split into the same `ChargeRow` shape it already buckets, so the
  month attribution, the period edges and the per-cap filters cannot tell the difference - the split is
  understood in exactly one place. A split is replaced whole rather than merged, because it is one statement
  about how an invoice divides and a partial edit could only leave it summing wrong; and changing the amount
  without re-stating the split DROPS it, rather than leaving cost centres charged a total nobody paid.
- **42** - a second approval above a threshold (`settings/expenses.second_approval_threshold`, off by
  default). Enforced on WHICH PERSON, not how many presses: the same approver cannot be both approvals, or the
  control would be decorative. Built as `first_approved_by` / `first_approved_at` COLUMNS rather than the new
  state this document proposed - a claim holding one approval is still awaiting an approval, so leaving it
  SUBMITTED keeps `approvalsSummary` and every queue filter correct for free, where a new enum member would
  have had to be added to each and missing one would silently drop these claims out of somebody's queue.
  Auto-approval is refused above the line, or an org whose two thresholds overlap would have the SUBMITTER
  recorded as the first of their own two approvals. The first approval is claimed under a guard, so two
  approvers pressing at once cannot both be recorded as the first.
- **43** - `vendors.payment_terms` (free text) -> `payment_terms_days` (integer). `paymentDueOn` derives an
  expense's `due_on` from the INVOICE date plus the agreed terms, not from approval - counting from approval
  would let a slow approval quietly extend the term the vendor agreed to. Computed on read, so renegotiated
  terms correct old invoices. Null terms mean no due date rather than a guessed one.
- **26** - a floor under net pay. `payroll-recovery.min_net_fraction`, validated rather than exempted because a
  fraction stored as a percentage would clamp at the read and quietly collect almost nothing for ever. Loan and
  advance recovery already capped net at zero; this protects a share of the period's WAGES on top, and the two
  exclusions compose (reimbursement first, then the floor on what is left) so wage take-home lands on the floor
  rather than through it. Default 0, which is the arithmetic that existed before it, so no run's figures move
  until somebody sets a policy. The carry needed nothing new - an uncollected shortfall already stays
  outstanding for the next run.
- **32** - the revision preview. `compensation:preview` prices a PROPOSED revision through the same
  `priceRevision` the save runs, so the split and the arrears figure shown cannot differ from the ones that
  land, and writes nothing. It answers the REGULAR month at the new rate: `crossings` names the statutory
  boundaries in sentences, because crossing the ESI ceiling can LOWER take-home while CTC rises and somebody
  has to say that out loud in the conversation. DELIBERATELY OMITTED: TDS (declarations- and
  year-to-date-dependent, so any figure here would differ from the payslip) and every period effect - loss of
  pay, one-offs, loan recovery, the annual PT cap - which are facts about a month, not about a salary. The
  professional tax shown is the monthly slab before any cap. Item 33, the increment batch, is this with a list
  around it and is NOT built. The PANEL shows only what the client cannot work out for itself - arrears and the
  crossings - because `EmployeeCompensation.tsx` already previews the split locally through the same
  `splitCtc`; duplicating that would have been a second answer to a question already answered. Debounced, and
  a failed fetch drops the panel rather than blocking the save.
- **38 + 39** - the card statement, imported and reconciled. `card_transactions` holds what the issuer
  reported; `domain/cardStatement.ts` matches it against the claims that could account for it. THE AMOUNT IS
  NON-NEGOTIABLE (two records of one purchase agree on what it cost) and matching is ONE TO ONE, so two
  identical charges need two claims to clear them - without that, one filed lunch silently clears both of the
  week's lunches and the unfiled one drops off the list this exists to produce. Re-importing is safe: each row
  carries a content-derived key behind a unique index. `:import` and `:reconcile` are separate because
  importing is a fact and matching is a judgement. Item 39 is the leftover half, surfaced on the close
  checklist as `unclaimed_card_charges` after a fortnight's grace.
  NOT BUILT: the per-issuer file parser. The import takes rows already parsed; a real parser belongs beside
  `services/bankFormats.ts`, which already holds that kind of column mapping for the outbound direction, and
  writing one with no real statement to test against would be inventing a format rather than supporting one.
- **40** - advances, built on `loans` exactly as the item said to. `loans.kind = "advance"` and the whole
  recovery path already existed; what did NOT was the link between an advance and the claims that spend it, and
  its absence paid people twice - take a 50,000 float, file 45,000 of claims, and the claims paid out in full
  while payroll separately recovered the 50,000 from salary. `reimbursements.advance_id` names the advance and
  `advance_settled` records how much of the claim discharged it; the payout (and the FnF settlement) pays
  `amount - advance_settled`, so a claim inside the float pays nothing and one that overspends it pays only the
  excess. The approval and the credit commit in ONE CHECKED BATCH: approving first and crediting after would
  leave, on any failure in the gap, a claim that is approved and payable beside an advance that still owes the
  lot - the exact double payment the feature exists to stop. An advance closed since the claim was filed settles
  nothing and the claim is simply paid, which is honest: the money was spent either way.

  THE FIRST VERSION OF THIS WAS WRONG, and a test caught it after review and reasoning had both passed it. The
  approval and the credit were in one `runBatchChecked`, on the belief that a checked batch is atomic. It is
  not: D1 runs a batch as one transaction, but a ZERO-ROW UPDATE IS NOT AN ERROR, so the batch still commits.
  Two concurrent approvals each ran to completion - the loser's guarded claim-flip matched nothing and its
  credit landed anyway, discharging the advance twice for one claim. `runBatchChecked` reported the mismatch
  afterwards, which is too late, because the money had already moved. It detects; it does not prevent.
  The fix is a partial unique index on `loan_repayments.reimbursement_id`, written FIRST in the batch: a second
  credit for the same claim is a unique violation, a violation IS an error, and an error is the one thing that
  rolls a D1 batch back. The loser now writes nothing, and a retry after a timeout is safe for the same reason.
- **23** - the payroll calendar as numbers a scheduled rule can reason about, so reminders are planned
  BACKWARDS from the pay date instead of announcing a state after the fact. `payrollScheduleMetrics` rides the
  ORG-LEVEL (`scope: "once"`) firing and only that one: these are facts about the company's month, and a
  perEmployee rule would tell four hundred people the run is unbuilt. `daysToPayDate` / `daysToCutoff` go
  negative once the date is behind, so "two days before" and "three days late" are the same comparison, and
  9999 means there is no such date rather than 0, which would read as "today". Computed once per tick and
  best-effort - a reminder that cannot work out its numbers must not take down the automation tick that runs
  everything else. The RULES themselves are data an org writes; this is the vocabulary that makes them
  writable.
- **27/28/29** - the accounting handoff, built as ONE piece because the plan argues a journal shipped in
  thirds is one nobody trusts. `pay_components.gl_code` maps the chart of accounts, `payroll_run_items
  .department_id` is STAMPED at build (a transfer in March must not rewrite February's accounts), and
  `domain/payrollJournal.ts` posts a run as `GET /v1/payroll-runs/<id>/journal`. Which SIDE each line takes is
  derived from `kind` and never stored, so the two cannot disagree: an earning debits an expense, an employee
  deduction credits a liability, an employer contribution does BOTH, net pay credits the payable the bank file
  discharges, and a perquisite posts nothing because it moves the tax base rather than money. Summed one line
  per account per cost centre, not per employee.
  THE BALANCE IS THE FEATURE. Debits equal credits is a complete arithmetic check over the whole pricing
  engine in one comparison, which is why this is worth having even for an org that never imports the journal.
  And it REFUSES rather than balancing by omission: an unmapped component dropped silently would still produce
  an entry whose debits equal its credits - just for less money than the run actually paid - so `unmapped`
  makes `balanced` false on its own.
  Reachable as "Accounting journal (.csv)" on the run's row actions, built onward. THE REFUSAL IS REAL IN THE
  UI TOO: an unbalanced or unmapped journal produces a toast naming the reason and NO file, because a CSV that
  balances by omitting a component is the one artefact that can be posted by mistake. Cost centres export as
  NAMES, resolved server-side - an internal id in the cost-centre column is unusable in the spreadsheet or the
  accounting system this is imported into.
- **33** - the increment round. `compensation:increment` with `dry_run`, one verb rather than two because
  pricing a round and committing it are the same question either side of a decision. The DEFAULT IS THE SAFE
  ONE - a body that omits the flag prices and writes nothing, unlike `reapplySplit`, whose verb name already
  says what it does; a batch of salary revisions is not something to apply because a field was left out.
  Every row goes through the same `previewRevision` a single raise uses, so a round cannot disagree with one
  person's preview, and a row that will not price reports its reason and leaves the other twenty-four alone.
  Bounded at 25: each person costs several reads, and an unbounded batch would work for a team and fail for a
  department - the worst shape a limit can have, since it passes every test and breaks the day it is used for
  real.
  APPLYING IS DELIBERATELY NOT ATOMIC ACROSS PEOPLE, and the signature says so. Each revision is its own
  guarded write and there is no D1 transaction spanning twenty-five of them, so claiming otherwise would be a
  lie told in a return type. It reports per person what applied and what did not; every applied row is an
  ordinary revision, visible in that employee's timeline and correctable the ordinary way, and the caller
  re-runs the failures.
- **1 + 2 + 3 + 5** - the run review, as one piece because a flag without a reason sends somebody to four
  other pages. `domain/payrollVariance.ts` + `GET /v1/payroll-runs/<id>/variance`. Each row is compared with
  the MEDIAN of that employee's own trailing three finalized runs (a median for the usual reason: one bonus
  month would otherwise drag a mean far enough to hide the next real move or invent one), while the REASONS
  compare against last run - "is this unusual" and "what changed since last month" are different questions
  and want different baselines. `net_moved_gross_flat` is ranked first deliberately: the same wage with a
  different take-home means a deduction changed, which is where a wrongly-started EMI hides and is exactly
  what an org-total comparison can never show. A flag with NO reasons is the row to open first, not a gap.
  Item 5 falls out: an employee with no history is `first_run`, a row to confirm once, rather than a movement
  of their whole salary against nothing.
  ITEM 3 IS THE ONE REFUSAL I LANDED WITHOUT A TEST RUN, and the reasoning is narrower than it looks.
  `negative_net` and `net_above_gross` are not policy questions - net is gross minus deductions, so neither
  can occur on a correct run, only on a broken one. There is therefore nothing legitimate for the block to
  refuse, which is also why it has no setting: a control an org may reasonably decline gets a switch, and "do
  not pay a negative amount" is not one of those. Every other pre-flight check (no bank account, tax that
  stopped, an unpriced component) is a judgement somebody may overrule, so those are reported on the run and
  never refuse it. That distinction is the whole argument for why this differs from item 25, which would
  refuse LEGITIMATE writes on a policy rule and stays unbuilt.
  THE ARGUMENT HAD A HOLE, found in review by the other session and fixed rather than argued away. "Net is
  gross minus deductions" held only while every line amount is non-negative, and `buildRunItems` pushed
  whatever a caller sent: `one_offs` was `z.record(z.any())`, so a NEGATIVE deduction - refunding an
  over-deducted TDS, the ordinary way to correct last month - would have made net exceed gross and the block
  would have refused a legitimate approval on a pay date with no override. The fix makes the property real
  instead of assumed: one-off lines are typed at the route and re-checked in the service (which is the
  boundary the invariant belongs to, since tests and internal callers do not go through the route), amounts
  are non-negative because the BUILD decides the sign, and only earnings and deductions are accepted -
  employer contributions and perquisites are derived, never passed in. `test/payrollVariance.test.ts` pins the
  dependency beside the check, so whoever relaxes that validation is told what it was holding up.
  It also closed a money input the drift test could not see: `moneyFieldDrift` greps for a bare `z.number()`,
  and a `z.any()` is not that - so the one payroll input with no bound at all was the one invisible to the
  test that exists to find exactly this.
- **4** - payout-fraud checks, on FINGERPRINTS. Two things are worth catching where the money leaves: one
  account paying two people (a copy-paste typo, in which case somebody is unpaid and somebody paid twice, or a
  diversion), and an account that changed since the run that last paid that person. `payroll_run_items
  .bank_account_hash` is a SHA-256 of the normalised account, written when a payout file is produced, so the
  next run compares against a hash rather than a number - it answers "same or different" and nothing else,
  never renders, and the message names PEOPLE.
  Computed in `bankFile.ts` rather than at build, deliberately: that is already the one place an account is
  decrypted, and hashing at build would add a second decryption point to reach the same answer. The plan said
  this surfaces on item 3's pre-flight; it cannot, because the pre-flight runs before any account has been
  read, and moving the read earlier would cost more than the placement is worth.
  BOTH REFUSE BY DEFAULT and are confirmed together with `?acknowledge=1`, which is audited with what the
  confirmer was shown. Refusing outright would be a control people route around - people do change bank - and
  passing silently would waste the only moment anybody looks. Fingerprints are stored AFTER the file is built,
  because a run that failed to produce one paid nobody and would otherwise leave the next run comparing
  against a destination the money never reached.
- **8** - the payslip explainer. `GET /v1/payslips/<id>/explain`, deterministic, reusing the same cause
  vocabulary the run review uses so an employee and a payroll officer read the same words about the same
  event. Compared against the employee's own PREVIOUS SLIP by issue order rather than the previous pay
  period, because "last month" means the last one they received and a joiner or leaver may have no slip for
  the period before. Ordered by effect on TAKE-HOME, not raw delta: a deduction that grew by 9,000 hurts more
  than an earning that grew by 8,000 helps, and the reason their pay fell belongs at the top. Employer
  contributions and perquisites are excluded - neither is paid to the employee nor withheld from them, so
  neither explains what arrived in their account, and listing them invites a question they cannot answer.
  A first payslip answers with an empty explanation rather than a 404: "there is no previous slip" is a real
  answer to the question, not a missing resource.
- **9** - declaration headroom, PART. `DeductionRow` now carries the regime's `cap`, so a figure somebody has
  to trust becomes one they can check ("60,000 of the 150,000 allowed"), and `deduction_headroom` reports
  capped sections with room left, biggest first. Reported SEPARATELY from `deductions` rather than as zero
  rows in it, so no existing reader's list changes shape - and it is the case worth surfacing, because
  somebody who has declared nothing against a section is exactly who does not know they could. Uncapped and
  disallowed sections are excluded: "unlimited minus what you used" is not actionable, and a section the
  regime refuses is not an opportunity.
  Stated as arithmetic and NEVER as advice. The line between "you have declared 60,000 of a 150,000 limit"
  and "you should invest more" is the line between a calculation this app may make and financial advice it
  may not, and the copy stays on the near side of it.
  NOT DONE: "and proof is due in N days". There is no proof deadline anywhere in the model, and inventing one
  as a constant would put a date on the page that no org agreed to. It wants a setting, which is its own
  small piece of work rather than something to fake here.
- **30** - what the bank did with the money. `payroll-runs:paymentResult` records a per-person outcome
  (paid / failed / returned, with the bank's reference and reason) against the run that produced the file.
  `bank_file_time` recorded the moment money LEFT and nothing recorded whether it arrived, so a closed
  account was discovered when the employee said they had not been paid.
  THREE ANSWERS, NOT TWO. A row naming somebody the run did not pay is `unmatched` rather than dropped - a
  response that does not line up is the loudest sign the wrong file was uploaded, and ignoring the rows that
  did not fit turns that into "nothing happened". Somebody the response never mentions is `unreported`:
  sent, nothing heard, which is deliberately neither a success nor a failure. A re-sent correction takes the
  LAST word, because a later line is the newer fact.
  MATCHING, NOT PARSING: the body is already-parsed rows, so a new bank is a parser beside `bankFormats.ts`
  rather than a change to how a payment is reconciled. Super-only, FOLLOWING THE FILE rather than the run -
  granting it to the run operator while withholding `bankFile` would let them assert money arrived for a
  payment they were never able to send.
  NOT DONE, and deliberately: it does not release the payables a failed transfer was meant to settle. That
  would reopen a PUBLISHED run's queue, and the ordinary remedy for a bounced transfer is to re-send it out
  of band. What the app owes here is an honest record and somebody told; requeueing is a larger decision
  about what a published run means.
- **44** - committed salary cost, twelve months ahead. `GET /v1/payroll-forecast`, a virtual collection in
  the `expense-close` shape: owns no rows, gated on the caller's own COMPENSATION list verdict, so a manager
  sees their reports' committed cost and finance the organisation's.
  THE WORD DOING THE WORK IS COMMITTED. Current pay, future-dated revisions somebody has already entered,
  joiners with a start date, leavers with a notice end - and nothing about hiring or raises nobody has
  approved. A month here is a FLOOR, and anything above it is a decision still to be made; a forecast that
  mixed the two would be a plan wearing the clothes of a commitment, and the reader could not tell which
  parts they had signed up to.
  Deliberately coarse: a month counts somebody employed on its FIRST day, so a mid-month joiner appears the
  following month. Prorating here would imply the rest of the figure is precise to the day when it is not,
  and the rule as written understates by part of one month and never overstates - the safe direction for a
  floor. Whole currency units for the same reason. Full company cost (`ctcMonthly`), not gross, so it means
  the same thing as the number on the offer letter.
- **25** - DONE, including the run pickup that the coverage note below used to except.
  The ENFORCEMENT half is now built too - the LOP carry. `domain/lopAdjust.ts` (pure), a `lop_adjustments`
  table, `services/lopAdjustments.ts`, the run pickup and settle marker in `buildRunItems`, and five hooks:
  leave approved, leave cancelled, regularization approved, and a day-mark created, re-valued or withdrawn.
  A correction RESTATES a closed period rather than incrementing, nets off what has already been paid, and
  is priced at the rate that period's own run docked at - so an org that changed `lop_basis` afterwards
  cannot refund at a rate the period never used. Best-effort: it never throws into the write that triggered
  it, because refusing a leave approval to protect a payroll number is the trade this whole item rejected.
  COVERAGE. The arithmetic has 12 pure cases and the service has 8 database ones, including the double-pay
  (a correction paid, then attendance moves again) and the two-period range. The run PICKUP now has 6 more in
  `test/lopAdjustPickup.test.ts`, and that file exists because the gap was specific rather than general: the
  service's double-pay test settled its first correction with a direct write commented "exactly as a run
  pickup would", which is an assumption wearing a comment. `settled` is summed from rows where
  `paid_run_id is not null`, so a build that wrote the payslip line and skipped the marker would refund the
  same days every month and the whole suite would stay green. The new file asserts `paid_run_id` off the row
  after a real `buildRunItems`, then runs the second correction against a marker the RUN wrote rather than one
  the test wrote - plus the negative direction (a recovery, which had no run-level test at all) and the
  cancelled-before-payment case, where a zero row must GO rather than sit in the queue to be priced at nothing.
- **25 (first half)** - the DETECTION half, and the split was deliberate.
  What was actually wrong turned out to be narrower than this document assumed, and finding that out changed
  the work. Three of the four "income-affecting writes dated into a closed period" are not silently applied
  at all: bonuses, encashments, overtime and reimbursements are a QUEUE keyed on `paid_run_id`, so one filed
  late is picked up by the next run - already the route-forward behaviour the item asked for. A back-dated
  compensation revision already prices arrears through `publishedRegularMonthsPaid`. So the refusal this item
  described would mostly have refused writes that were already handled correctly.
  THE REAL GAP was that `runStaleness` returned `stale: false` for any non-editable run, unconditionally. A
  published run therefore reported nothing however much moved under it - which is exactly the state the item
  names, "the published payslip and the live data disagree and nothing says which is true", reached by a
  different route than the one predicted.
  Fixed by extracting the input scan (`changedInputsSince`) so the two questions share one source list, and
  reporting it on a committed run as `diverged` rather than `stale`. Separate fields because the answers mean
  OPPOSITE things: stale is work to do, diverged is a statement of fact with no remedy of that kind. Folding
  them together would have put a "Rebuild now" button on a published run, which is the single action nobody
  should take there - so the banner has no button and names where a correction belongs instead.
  NOT DONE, and it is a real decision rather than a shortfall: the enforcement half for the one input that is
  genuinely neither queued nor routed - LOSS OF PAY. With `lop_enabled`, approved leave or an attendance
  change dated into a published period changes what that period should have paid, with no queue and no
  arrears path. The fork is whether to REFUSE the leave approval (which corrupts the leave ledger to protect
  payroll - the leave is a true fact about attendance) or to CARRY the pay consequence into the next run as an
  adjustment (which needs machinery that does not exist). Both are defensible and they are not the same
  feature, so it is a human's call, not a default to pick quietly.
- **45** - payroll budget against actual. A `payroll_budgets` collection in the `expense_budgets` shape - a
  scope, a period, a cap, a recurrence, and a spend that is DERIVED and never stored - with the item 15
  forecast applying unchanged, exactly as this document predicted, because it is a function of spend and
  elapsed time and does not care which module produced the spend.
  ITS OWN TABLE, not a `source` column on `expense_budgets`. The two differ in what they count and in who may
  see them, and sharing a table means every read of either has to remember a filter; one forgotten filter
  counts salary as expense spend, and the number that comes out is wrong in the direction nobody checks.
  SPEND IS APPROVED AND PUBLISHED RUNS ONLY. A draft is somebody mid-build whose figures change on every
  rebuild, so counting it would make a department's budget move while a colleague works. An approved run is
  committed even before the money leaves, which is the same point `expense_budgets` charges an approved
  expense at.
  ATTRIBUTION IS ITEM 29'S STAMP, and this is the load-bearing choice. The run item's own `department_id`,
  written at build time - never the employee's department today. Resolving through `employees` at read time
  reads perfectly well and is wrong only for people who have transferred, which would let a move in March
  silently rewrite what February's budget consumed. Pinned by a test whose fixture is a person who has since
  changed team.
  Private-by-default: no seeded grant, an entry in `WITHHELD_COLLECTIONS` instead. The stated reason is not
  only that it is finance data - a cap read beside its spend states a department's whole pay bill, and that
  approaches individual salaries as the team gets smaller, so the privacy argument survives somebody later
  deciding finance should see it by default.
  The period helpers and the period picker moved out of `ExpenseBudgets.tsx` into `lib/budgetPeriod.ts` and
  `components/common/PeriodPicker.tsx` rather than being copied, since a second copy is how two budget pages
  start disagreeing about which quarter a date falls in - a disagreement invisible until somebody compares
  the pages.
- **31** - run-to-run reconciliation. `domain/payrollReconcile.ts` + `GET /v1/payroll-runs/<id>/reconciliation`.
- **34** - arrears itemised, on the payslip as well as the run view, because the payslip is where the employee
  actually reads them. `compensation.arrears_periods_json` freezes the per-period breakdown the pricing already
  computed and threw away, and it is STORED rather than derived for the same reason the amount is: both depend
  on which periods had published at the moment of the revision, so recomputing later would explain an
  already-paid arrear with months it never covered. Reaches the payslip as `parts` on the `ARREARS` line, which
  `computeRunItem` never reads - a breakdown that failed to sum could only ever be wrong on screen, never wrong
  in pay - and is omitted entirely unless the parts account for the whole lump, since a partial list beside a
  full total reads as though the rest were unexplained.
- **35** - PART ONLY. The Payslips page already carried year-to-date net, TDS and an average month, summed
  client-side from the viewer's own slips; it now also carries gross and total deductions, which were on every
  row and thrown away. NOT done: the tiles are still a CALENDAR year while `taxProjection.ts` works in the
  FINANCIAL year, so year-to-date TDS and the projection beside it are counting different windows. Changing the
  basis silently would move a number people already read, so it is left as its own decision.
- **36** - payslip delivery. NOT built the way this document described it: the plan claimed the audit trail
  already records an employee opening their own payslip, and it does not. `domain/auditAccess.ts` deliberately
  writes no row for a self-read ("reading your OWN sensitive data is expected, not an abuse signal"). So this
  is a `payslips.first_opened_at` stamp instead - written once, by the owner's own first view, never moved -
  which answers delivery without becoming the reading history that rule exists to prevent. Surfaced as
  `payslips_unopened` on a published run.

Everything else in this document is still a candidate.

Two parts. **Part one, items 1 to 20**, is what the AI layer can and cannot do for money, and it concludes
that most of the answer is arithmetic. **Part two, items 21 to 46**, drops the model entirely and asks what
these surfaces are structurally missing. Part two is the larger half and it is where the load-bearing gaps
are: a payroll cutoff, an accounting handoff, a payment that confirms it arrived.

---

# Part one: what the AI layer can do here

## What decides every item below

Four facts, and they rule out most of the obvious ideas before they are written down.

**Every pay collection is on `NEVER_TO_MODEL`.** `domain/aiPolicy.ts` denies `payroll-runs`,
`salary-structures`, `pay-components`, `pay-grades`, `positions`, `loans`, `bonuses`, `tax-declarations`,
`bank-formats`, `payroll-debit-accounts`, and through `AUDIT.sensitive_collections` also `payslips`,
`compensation` and `settlements`. The `compensation` sub-resource of an employee is denied separately.
`assertMayReachModel` throws rather than degrading, because a prompt builder reaching one of these is a bug
and not a runtime condition. So the correct reading of "AI for payroll" in this codebase is not "send payroll
to a model". It is "make the payroll surface intelligent with arithmetic, and use a model only where the
prompt carries no pay row at all".

**Expenses are not denied.** `expenses`, `reimbursements` and `expense-budgets` are absent from
`NEVER_TO_MODEL`, and `vendors`, `expense-categories` and `reimbursement-categories` are already in
`INDEXABLE`. This is the one money surface where a model is legal today, and it is where most of the real
typing happens: `createExpense` has roughly eight fields a human copies off a PDF.

**The allocation is 10,000 neurons a day, the org ceiling defaults to 7,000, and a generation is about 120 of
them** (`ESTIMATED_NEURONS`). An embed is 1. At 120 a generation, the whole org gets about 58 generations a
day. A generation per submitted expense is therefore not a design, it is an outage. Everything in the expenses
section below is embed-first, and generation is a button somebody presses.

**Decision 3 in `ai-rollout-plan.md` bars scoring, ranking or flagging a person.** Applied here it means the
fraud-shaped ideas get written as document checks and not as people checks. "This claim looks like one filed
three days ago" is a statement about two rows. "This claimant looks fraudulent" is a judgement about an
employee feeding a decision about their job, and it is not built.

A fifth, softer one, and it is the same observation the boards plan made: most of what would read as
intelligence here is arithmetic the app already has the inputs for and does not do. `payroll.ts` already loads
the prior run's totals to build the staleness comparison. `expenseBudgets.ts` already computes spend against a
cap. Neither turns those into the sentence that changes what somebody does next.

## Three legal shapes, and every item below is one of them

1. **Arithmetic.** No model, no policy argument, no feature flag, no fallback path to write. Most of this
   document.
2. **Narrate over findings.** The shape `services/analyticsNarrate.ts` already ships: a deterministic
   comparison finds the movements, the model is handed only the findings, `groundedIn` discards any answer
   containing a figure nobody computed, and `plainSummary` is the fallback. The model cannot invent an anomaly
   because it never sees the data, and it cannot invent a number because the check rejects one.
3. **A named consented path.** `CONSENTED_PATHS` keyed by code path and collection, with the lawful basis
   written out in prose. `test/resumeExtract.test.ts:118` pins the exact key list, so a third entry fails the
   build until somebody deliberately edits the assertion. That is the intended friction, not an obstacle.

---

## /payroll-runs

Built already: run staleness (`runStaleness`), the org-total comparison against the prior run
(`buildRunItems` collects prior gross / net / tax and emits `from`/`to` pairs), and the unpriced-component
list.

### 1. The variance sentinel, per employee

The run comparison that exists is org-level: headcount, gross, tax, net. Payroll mistakes are not org-level.
A proration bug, a missed component, an EMI that started a month early or a grade change applied to the wrong
person all land as one person's net moving while the org total moves by an amount nobody would look twice at.

So: for each run item, compare against that employee's own trailing three runs. Flag a net or gross move
beyond a threshold of their own median, a component that appeared, a component that vanished, and gross flat
while net moved. Render as a band above the review table, "12 of 240 items need a look", collapsed by default
and sorted by size of move.

The threshold is a settings value and not a constant, for the same reason `cardDuplicateSensitivity` is: the
trade-off is symmetric and an org knows its own payroll better than this file does. Too loose and the band
cries wolf every month and people stop opening it. Too strict and the one wrong row goes out.

Primitive: arithmetic over `payroll_run_items` for the three prior runs of the same employee. Cost: zero
neurons. One extra query per run build, over rows the build is already fetching for the prior-run totals at
`services/payroll.ts:355`. Fallback: not needed. Wires into `buildRunItems`, stored on the run alongside the
existing comparison blob, and rendered in `web/src/pages/PayrollRuns.tsx`.

This is the highest value item in the document, and the price is zero.

### 2. Why it moved, joined rather than guessed

A flag without a cause makes somebody open four other pages. The app already knows the causes.
`runStaleness` at `services/payroll.ts:993` exists to answer "which inputs changed since this run was built",
and the same inputs explain the move: unpaid leave days in the period, an arrear line, a loan EMI whose first
instalment falls here, a verified tax declaration cutting withholding, a mid-period compensation change, a
joiner or leaver proration.

So each flag from item 1 carries its reason codes, produced by a join and not by a model: "net down 12 per
cent: 2 unpaid leave days, loan EMI started". Where the join finds nothing, the flag says so, and that is the
interesting case rather than the embarrassing one: a move with no identified cause is exactly the row a
payroll officer should open.

Primitive: arithmetic. Cost: zero neurons, and the queries are the ones `runStaleness` already writes.
Fallback: not needed. Wires into `services/payroll.ts` beside the sentinel.

### 3. The pre-flight gate at approve

`transition()` moves a run towards published. The checks that would catch a run nobody should approve are
cheap and are not there: a zero or negative net, a net greater than gross, zero tax on an employee who had tax
last period, an employee with no bank account on file, an employee missing a statutory identifier the
statutory report will need, an unpriced component.

These belong at the transition and not at bank-file generation, because discovering a missing account number
while producing the file means the run is already approved and the fix is a rebuild.

Structure them as the run's own checklist with a count, each item linking to the row and the field, and each
one either blocking or acknowledgeable. Blocking versus acknowledgeable is per check and is a decision worth
writing down when the checks are written: "net greater than gross" is arguably a bug in this app, "no bank
account" is arguably a person paid by cheque.

Primitive: arithmetic, run at `services/payroll.ts:1174`. Cost: zero neurons. Fallback: not needed. Wires into
`transition` and the run header.

### 4. Payout-fraud checks on the bank file, on hashes

Two checks catch the classic payroll frauds and neither needs plaintext. The same account number appearing
against two employees is either a typo or a diversion. An account changed since the last run in which that
employee was paid is the single highest-signal event in payroll fraud, and it is currently silent.

Both compare **hashes**, never decrypted values. That is not a convenience, it is what keeps the feature on
the right side of `NEVER_TO_MODEL_SUBRESOURCES`, which denies `bank-account` precisely because decrypting one
into any new surface defeats the encryption. A hash comparison decrypts nothing and surfaces nothing: the
message is "this employee's payout account changed since June", with the number itself still behind the
audited read.

Primitive: arithmetic over hashes. Cost: zero neurons. Fallback: not needed. Wires into `services/bankFile.ts`
and surfaces on the run's pre-flight checklist from item 3.

### 5. Lifecycle rows highlighted by lifecycle, not by amount

Joiners, leavers, mid-period grade changes and returns from unpaid leave are where proration bugs live, and
they are not reliably the largest movements. Mark them from the employment record rather than from the
numbers, so a correctly prorated joiner is still shown as a row whose arithmetic somebody should confirm once.

This also gives the sentinel in item 1 somewhere to send its false positives: a new joiner has no trailing
three runs, so their "move" is meaningless and should be presented as a first-run check instead of as a
variance.

Primitive: arithmetic over employment dates. Cost: zero neurons. Fallback: not needed.

### 6. What changed this month, in a sentence

The narration shape from `services/analyticsNarrate.ts`, applied to a run: `findMovements` over run-level
aggregates only, `groundedIn` rejecting any fabricated figure, `plainSummary` as the fallback, a new
`AiFeature` of `payroll.narrate`, and a `PROMPT_VERSION` because `aiGenerate` caches on it.

**This one needs a `CONSENTED_PATHS` entry and it should not be added quietly.** `payroll-runs` is denied,
`assertMayReachModel` will throw, and `test/resumeExtract.test.ts:118` will fail. The basis to argue, if
somebody wants to argue it, is narrow and testable: the prompt carries org-level aggregates and measure labels
and nothing else, exactly as the analytics narration does today. No employee, no name, no row, no component,
no per-person figure. If that basis cannot be enforced by the prompt builder's own shape, the item is not
worth the entry and should be dropped rather than softened.

The honest alternative, and the one to prefer unless somebody actively wants the prose: `plainSummary` alone.
The deterministic sentence over four aggregates is close to as good as a written one, which
`analyticsNarrate` already concedes for the quiet-week case.

Primitive: generation over findings, one per run, user-initiated. Cost: about 120 neurons per run, which is
negligible at one run a month. Fallback: the plain summary, which is the whole feature minus the prose.

### 7. The same thing for expense budgets, with no argument needed

Budgets are not denied. The narration in item 6 over `computeBudgetSpend` output needs no consented path, no
policy edit and no new argument, and it lands on a page finance actually opens weekly. If the narration shape
is going to be built for money at all, build it here first and see whether anybody reads it before spending a
`CONSENTED_PATHS` entry on the payroll one.

---

## /payslips

### 8. Why my pay is different this month

The most common HR ticket in any organisation, answered by a diff the app can already compute: the employee's
own current payslip against their own previous one, component by component, with the causes joined the same
way item 2 joins them. Unpaid leave days, an arrear, an EMI instalment, a verified declaration cutting
withholding, a grade change.

Keep this deterministic and do not reach for a model. `payslips` is an `AUDIT.sensitive_collection` and
`payslips:download` is a sensitive verb, so the prose would need its own consented path, and the prose is not
where the value is. The value is in the join. A model would write a nicer sentence about a diff the employee
can already read once it is laid out.

Primitive: arithmetic over the employee's own two payslips. Cost: zero neurons. Fallback: not needed. Wires
into `web/src/pages/Payslips.tsx` as a panel on the current payslip.

### 9. Declaration headroom, while it can still be acted on

The tax declarations module holds what somebody declared and the regime holds the caps. "You have declared
X of a Y cap, and proof is due in 11 days" is arithmetic over data already on the page, and it is only useful
before the window shuts, which is the part a static form does not do.

Stated as arithmetic and never as advice. The line between "you have declared 60 per cent of the cap" and "you
should invest more" is the line between a calculation and financial advice, and the first is the one this app
is entitled to draw.

Primitive: arithmetic. Cost: zero neurons. Fallback: not needed. Wires into `web/src/pages/TaxDeclarations.tsx`.

---

## /expenses and /reimbursements

The one money surface where a model is legal today. Built already: recurring generation, budget thresholds,
the approve / reject / pay state machine.

### 10. Receipt extraction, as a consented path

A submitter uploads an invoice and gets the form filled: amount, tax amount, date incurred, vendor, invoice
number. They accept or reject each field, exactly as the recruiter does in `ats.resumeExtraction`, and nothing
is written that was not accepted. The basis is the same shape as the resume one, which is why it is arguable:
the document was produced for this purpose, a person triggers it on a document they are already looking at,
the model transcribes rather than judging, and no field reaches the database without a human accepting it.

`scrubStatutoryIds` rather than `scrubIdentifiers` applies here, for the reason the resume path already
documents: the general scrub deletes long digit runs, and an invoice number is a long digit run.

**Gap that has to be closed first: there is no vision model in `MODELS`.** The four entries are an embedder, a
reranker, a text generation model and Llama Guard. Receipt extraction needs either a `@cf/*` vision model added
to the allowlist, which is a deliberate diff in `domain/aiPolicy.ts` and exactly the kind the allowlist exists
to make visible, or an OCR pass ahead of the text model. The second is worse: it is two failure modes instead
of one, and the layout is half the information on a receipt.

Primitive: generation, per receipt, user-initiated. Cost: about 120 neurons a receipt, so tens per day. This
is affordable precisely because it is a button. An extraction that ran automatically on upload would put the
org's whole allocation behind a bulk import.

### 11. This looks like one you already filed

Add `expenses` to `INDEXABLE` and the duplicate machinery already exists: the cards triage path embeds a row
and compares it against neighbours at a sensitivity the org sets (`cardDuplicateScore`). Applied to expenses
it answers the honest double-submit, which is the common case, and it does it at submit time when the fix is
free rather than at approval when it is a conversation.

Pair it with a deterministic near-match on the fields that make duplicates in practice: the same amount, the
same vendor, a date within a couple of days. The arithmetic catches the exact duplicate more reliably than
the vector does, and the vector catches the one retyped with a different description. Neither is worth much
without the other.

Written as a statement about two documents, never about the submitter. See the fourth constraint above.

Primitive: one embed on write plus a vector query. Cost: 1 neuron per expense. Fallback: the deterministic
near-match alone, which is most of the value and needs no AI layer at all.

### 12. The category, suggested rather than picked

Embed the description, compare against the category list, which is already in `INDEXABLE`, and preselect.
Default `departmentId` from the submitter's own department at the same time, which needs no model whatsoever
and is probably the larger share of the saved clicks.

Primitive: one embed, or zero if the vendor already implies the category from that vendor's own history, which
is a lookup. Cost: 1 neuron, and frequently zero. Fallback: the picker, unchanged.

### 13. Vendor deduplication at creation

"Amazon Web Services", "AWS", "Amazon Web Services India Private Limited". The vendor master grows a long
tail of the same company because creation is a free-text field beside a picker nobody scrolls. `vendors` is
already `INDEXABLE`, so an embed of the typed name against the existing list, optionally reranked, answers
"did you mean one of these three" before the row is created.

Cheaper and more effective than deduplicating afterwards, because afterwards means repointing expenses.

Primitive: one embed plus an optional rerank. Cost: 1 to 4 neurons, on create only. Fallback: the picker.

### 14. Policy checked at submit, not at reject

`expenseCategories` carries `requiresReceipt` and nothing else. The checks a finance team actually applies are
a per-claim cap, an age limit on how late a claim may be filed, and whether a receipt is attached at all. The
first two are a schema addition; the third is checkable today and is not checked.

The point is where the check happens. Rejecting a claim three days later for a rule that could have been
stated at submit is the interaction that makes people resent the expenses module. `decisionNote` exists so a
submitter is told the reason rather than the verdict, and the same reason is worth more before the claim is
filed than after.

Primitive: arithmetic, at `submitExpense` in `services/expenses.ts:231`. Cost: zero neurons. Needs: `amountCap`
and `maxAgeDays` on `expense_categories`, plus the Settings editor rows.

### 15. The budget breach, forecast instead of announced

`checkBudgetThresholds` at `services/expenseBudgets.ts:409` fires when spend crosses a percentage of the cap,
and `alertLevel` records the highest threshold already fired so it fires once. That is a report of something
that has already happened.

The same data forecasts it. Spend so far against elapsed fraction of the period, projected to period end, and
`budgetPhase` already knows whether a period is current. "At this rate this budget lands 18 per cent over by
the end of the quarter" arrives in week three rather than week ten, which is the difference between a decision
and a note.

Ration it the same way the threshold alert is rationed, with its own level column or a projection band, or the
projection re-fires every day the run rate wobbles.

Primitive: arithmetic. Cost: zero neurons. Fallback: not needed. Wires into `checkBudgetThresholds` and the
budget card in `web/src/pages/ExpenseBudgets.tsx`.

### 16. Recurring series drift

`generateRecurringExpenses` at `services/expenses.ts:341` clones a template into a concrete expense each
period. When the real invoice arrives at a different amount, nothing says so. A silent SaaS price rise, a
double-billed month and a lapsed discount all look identical to this app today.

Compare each generated occurrence against the series' own trailing amounts and flag the deviation on the
expense. The series is the right comparison set and it is already linked by `templateId`.

Primitive: arithmetic over the series. Cost: zero neurons. Fallback: not needed.

### 17. The straight-through lane

Under a threshold, a known vendor, in budget, not a duplicate, receipt attached, category policy satisfied:
approve without a human. Everything in that list is a check from items 11, 14 and 15, and `automationEngine`
is already the event-driven place to assemble them.

The value is not the approval. It is that an approver queue of 200 claims a month becomes a queue of 10, and
the 10 get read. A queue nobody reads approves everything anyway, slower.

Decision 5 in `ai-rollout-plan.md` says suggestions are never applied automatically, and this does not breach
it: the lane is a deterministic rule an org configures, not a model suggestion being auto-accepted. Worth
saying explicitly in the code, because it will look like a breach to the next reader.

Primitive: arithmetic, wired as automation rules. Cost: zero neurons. Fallback: the existing manual queue.

### 18. The approver's queue, triaged

The `services/attention.ts` shape applied to the approvals queue: not "you have 14 claims" but "3 need you:
one puts its budget over, one looks like a claim from Tuesday, one has no receipt and its category requires
one". Every signal comes from an item above and is deterministic. A generated sentence over the top is
optional and is the last thing to build, not the first.

Primitive: arithmetic. Cost: zero neurons. Fallback: not needed.

### 19. Expenses in the command palette

Falls out of item 11 for free. Once `expenses` is `INDEXABLE` it is in the semantic search that
`services/searchEmbed.ts` drains, so "aws invoices march" works in the palette alongside everything else. No
additional work beyond the indexable entry and the `searchIndex.ts` title and subtitle definition the drain
requires.

### 20. The month-end close checklist

Approved but unpaid, claims missing a required receipt, budgets over or projected over, recurring series that
should have generated and did not, expenses in a closed period. One page, entirely arithmetic, assembled from
queries that all exist.

Not intelligent in any sense a model would recognise, and probably the page finance opens most.

---

## Cross-cutting

**Embed first, generate on a press.** At 7,000 neurons and 120 a generation, the org has about 58 generations
a day. Items 11, 12 and 13 are all 1 to 4 neurons and can run on every write. Items 10 and 6 are generations
and must stay behind an explicit action. Anything that would generate per row on a list page is not buildable
on this allocation and should not be designed as though a larger allocation is coming.

**Pass `subject` on every call.** `AiCallContext` takes `subject` as `"<collection>/<uuid>"` and it is what
makes an `ai_usage` row answer "what was sent to a model about whom" a year later. The expenses items all have
a natural subject and there is no excuse for omitting it.

**The `reimbursements` indexing question, which is a decision and not a detail.** `expenses` is company spend
against a cost centre, and indexing it is uncontroversial. `reimbursements` is a person's own claim, its
`description` is free text, and free text on a personal claim is medical often enough to matter: a physio
session, a therapy appointment, a hospital car park. `reimbursements:download` is already in
`AUDIT.sensitive_verbs` for exactly that reason, with the note that a claim receipt is the same kind of
document as a rent receipt in a tax declaration.

Three options, and the middle one is the recommendation: index `expenses` only and leave reimbursements out;
index `reimbursements` with the embed text built from category and amount and never from `description`; or
index it whole. The second keeps duplicate detection, which is where the value is, and never sends the
sentence that might be a diagnosis. Whichever is chosen belongs in `domain/aiPolicy.ts` with the reasoning
written beside the `INDEXABLE` entry, in the style the rest of that file is written in.

**What is deliberately not here.** Nothing in this document scores a person, predicts who will file a
fraudulent claim, ranks employees by expense behaviour, or recommends a pay figure. Those are the ideas an AI
feature list for payroll usually opens with, and they are the ones Decision 3 and the out-of-scope line in
`ai-plan.md` already refuse. The document also does not propose sending a salary, a component, a payslip or a
bank account to a model by any route, including a route that would technically pass the gate.

## Build order for part one

Cheapest first, and the order is not arbitrary: everything before the first model call is arithmetic that
needs no flag, no fallback path and no policy argument, so it ships without touching the AI layer at all.

1. **Zero neurons, no policy work.** Items 15 and 16 (budget forecast, series drift), then 3 (the approve
   gate), then 1 and 2 (the variance sentinel and its reason codes), then 5, 8, 9, 14, 18, 20.
2. **Hashes, zero neurons.** Item 4, the bank-file checks.
3. **Embed-only.** Items 12, 13, 11 and 19, which all fall out of adding `expenses` to `INDEXABLE` and which
   share one decision (the reimbursements question above).
4. **Needs the allowlist extended.** Item 10, receipt extraction: a vision model in `MODELS` plus a third
   `CONSENTED_PATHS` entry plus the assertion in `test/resumeExtract.test.ts:118`.
5. **Needs a policy argument, and may not survive it.** Item 7 first because it needs none, then 6 only if
   somebody reads 7 and wants the same thing for runs.
6. **Last, because it depends on most of the rest.** Item 17, the straight-through lane.

---

# Part two: without a model at all

Part one concluded that most of what would make these surfaces intelligent is arithmetic. This part takes
that seriously and stops mentioning the AI layer. Nothing below calls a model, spends a neuron, needs a
feature flag, needs a fallback path or needs a line of `domain/aiPolicy.ts` edited. That is not a limitation
of the ideas, it is a property of the problem: payroll is a domain where the right answer is a calculation
somebody can check, and an approximation would be worse than nothing even if it were free.

Several of these need a schema change. That is cheap here and should not be treated as a reason to prefer a
worse design: the app is deployed nowhere, and the convention is one squashed migration rather than a
compatibility step (`one-migration-squash`). Where an item needs columns, they are named.

The items are ordered by area, not by value. The build order at the end is by value.

## Process and control

### 21. The cutoff date, which does not exist

`pay_periods` carries `periodStart`, `periodEnd`, `payDate` and nothing else. There is no point in the month
after which the period's inputs stop moving. So a reimbursement approved the evening before pay date is a
legitimate write that silently invalidates a run somebody already reviewed, and the app's only response is
`runStaleness` reporting it afterwards.

Add `inputCutoffOn` to the period. Past it, an income-affecting write dated into that period says so at the
point of the write: "this period closed on the 25th, this will be paid in the next run", with an override for
whoever is allowed to reopen. The write is not blocked by default, because a genuine late correction is a
real thing and blocking it sends people to a spreadsheet. It is made visible, which is the whole ask.

This is the most common process control in payroll anywhere, and it is the input to items 22 and 23. Needs:
`input_cutoff_on` on `pay_periods`, and the cutoff check at every income-affecting write path
`runStaleness` already enumerates.

### 22. The payroll calendar, assembled from stamps that already exist

Every milestone of a run is already recorded: `createdBy`, `itemsBuiltAt`, `submittedBy`, `approvedBy`,
`bankFileAt`, and `payDate` on the period. Nothing shows them on a timeline.

One view per period: cutoff, build, review, approve, bank file, pay date, each with its actual timestamp
against its planned one. It answers "where is this month" at a glance and "where did last month slip" without
anybody reconstructing it. Zero new data, one query, and it is the surface item 23's reminders point at.

Wires into `web/src/pages/PayrollRuns.tsx` as a period header, or its own page if periods are worth listing.

### 23. Reminders planned backwards from the pay date

Payroll is the one workflow in this application where lateness is not a matter of taste, and it is currently
the one that waits to be asked. The dates that matter are all known in advance, so the reminders can be
planned backwards from `payDate`: cutoff in two days with seven claims still pending, pay date on Friday and
the run not built, run approved and no bank file generated, run published and nobody downloaded the statutory
report.

`automationEngine` already does scheduled and recurring triggers, so this is rules and not code. The
discipline worth keeping is that each reminder names the thing to do and links to it, in the style the
"Needs you" work already established, rather than announcing a state.

Wires into the automation rule seeds plus the notification path.

### 24. Four eyes on the bank file

`submittedBy` and `approvedBy` are recorded separately, so the app already knows the two people who handled a
run. Downloading the bank file is the moment the money leaves, and it is the one action in the module with no
separation-of-duties rule on it at all.

Gate it: the person who generates the payout file may not be the person who approved the run. This is a
deterministic check over two columns that exist, and it is the control an auditor asks for first.

Worth writing the exception path deliberately rather than leaving it implicit, because a two-person finance
team will hit it: either an org setting that turns the rule off with the fact recorded, or an override that
is itself audited. A control people cannot satisfy is a control people route around.

### 25. The period locks when the run publishes

`payPeriods.locked` exists and is a generic catalogue lock, not this. After a run publishes, an
income-affecting write dated into that period is a correction to money already paid, and it has exactly one
correct destination: arrears, which `markCompArrearsPaidByRun` already knows how to pay in a later run.

So: post-publish, such a write is either refused or routed to arrears, never silently applied to a closed
period. Without this the app has a state where the published payslip and the live data disagree and nothing
says which is true.

### 26. A floor under net pay

Deductions can exceed what a person earns. A loan EMI, an advance recovery and a month of unpaid leave stack,
and the arithmetic will produce a negative net without complaint. That is the worst failure this module can
have: it is visible to the employee before it is visible to anybody else.

The rule is policy data, not code: recovery may not take net below some percentage of gross, and the
unrecovered remainder carries to the next period. `loans.ts` already tracks outstanding balances, so carrying
a shortfall is a write it is shaped for. Item 3's pre-flight gate is where the violation surfaces if the rule
is ever bypassed.

Needs: the floor and the carry rule as settings, and a carry column or ledger row on the loan.

## The accounting handoff

### 27. GL codes on pay components

`expense_categories` has `gl_code`. `pay_components` has none. The consequence is that payroll's entire
output stops at a bank file, and somebody re-keys the month into the accounting system from a payslip
summary. That is the single largest piece of manual work this module creates and nothing in the app knows it
is happening.

Add `glCode` to `pay_components`, plus which side of the entry the component lands on. A published run then
emits a journal entry: salary and employer contributions as expense, statutory deductions and employer
liabilities as liabilities, net pay as the payable the bank file discharges.

Needs: `gl_code` and a side enum on `pay_components`, a settings block for the two or three accounts that are
not component-derived (net payable, bank), and an export.

### 28. The journal must balance, and the app should refuse to export one that does not

Debits equal credits. That is not an accounting nicety here, it is a complete arithmetic check over the whole
pricing engine: if gross minus deductions does not equal net, or an employer contribution is costed without a
matching liability, the entry will not balance and the run will say so before anybody posts it.

So the export asserts the balance and refuses on failure, with the residual shown. A rounding residual is the
common case and belongs in its own account rather than being absorbed silently. This item is worth building
even if nobody ever imports the journal, because the assertion is a correctness proof the app does not
currently have.

### 29. Payroll cost, posted by department

`expenses.departmentId` exists precisely so company spend is attributable to a cost centre. Payroll has no
equivalent, so salary cost is only attributable through a join to the employee's department, and nothing in
the app does that join.

Post the journal by department, which is also the input to item 45. The employee's department at period end
is the right attribution key, and it needs recording on the run item rather than resolved later, or a
transfer in March rewrites February's accounts.

Needs: `department_id` stamped on `payroll_run_items` at build time.

## Money that left, and money that arrived

### 30. The payment confirmation that closes the loop

`bankFileAt` records when the payout file was produced, and the schema comment is explicit that this is the
point where the money leaves. Nothing records whether it arrived. A wrong account number, a closed account or
a bank-side rejection is discovered when the employee says they were not paid.

Banks return a response file. Accept it: match on the reference the payout file wrote, mark each line paid,
failed or returned, and requeue the failures as payable rather than leaving them looking settled. The run
then has a payment state distinct from its publication state, which is the distinction the module currently
lacks.

This pairs with item 4 in part one. Item 4 catches the account that changed before the money goes; this
catches the account that was wrong anyway.

Needs: a per-item payment status and a reference column, plus a response-file parser per bank format, which is
the same shape `bankFormats.ts` already holds for the outbound direction.

### 31. Run-to-run reconciliation, as an identity rather than a threshold

Item 1 in part one flags per-employee movements against a tunable threshold. This is stronger and needs no
threshold, because it is a closed identity that must hold:

```
opening headcount + joiners - leavers                                    = closing headcount
opening gross + raises + joiners - leavers + variable + arrears - LOP    = closing gross
```

Each term is computable from data the run already has. Where the identity holds, the month is explained and
nobody needs to look at anything. Where it does not, the residual is the unexplained amount and it is
precisely the thing to investigate, with no judgement about how big is too big.

Presented as a statement, not an alert: one table, six rows, a residual line that should read zero. It is the
single most useful artefact a payroll officer can be handed before approving, and everything in it is
subtraction.

## Compensation changes

### 32. What a revision does, priced before it is written

`reviseCompensation` applies a change. There is no way to see what a change would do first, so the
conversation that precedes every raise happens in a spreadsheet and arrives in the app as a fait accompli.

Price the proposed structure through the same pricer the run uses and show the result: new gross, new net,
what PF, ESI, professional tax and TDS become, the CTC delta with employer contributions on the correct side
of it per `in_ctc`, and whether any statutory threshold is crossed (the PF wage ceiling, an ESI eligibility
boundary) because those produce the counter-intuitive outcomes where a raise moves net the wrong way.

All of the pricing code exists. The work is a preview endpoint that does not write, and a panel.

### 33. The increment cycle as one operation

Item 32 for a department at once: proposed percentages or amounts per person, the total cost impact, a check
against whatever budget covers it, and one commit. Today it is one revision at a time through a form, which
is why it happens in a spreadsheet and is transcribed.

The preview from item 32 is the per-row content; this is the batch around it, plus the approval before the
batch applies.

### 34. Arrears, itemised

`markCompArrearsPaidByRun` exists because a backdated raise owes money for periods already published. The
employee sees one arrear line. The question they ask is which months it covers and at what rate, and the
answer is computable from the revision's effective date and the periods between it and now.

Show the months. It is the difference between a number the employee has to trust and a number they can check.

## What the employee sees

### 35. Year to date, which is computed and never shown

`taxProjection.ts` already assembles finalized totals, projected gross, verified deductions and the resulting
tax position for the financial year. None of it appears as a running total on a payslip or anywhere else, so
the employee's own view of their year is a pile of monthly PDFs.

One page: earnings, deductions and tax paid to date, against the projection for the rest of the year. No new
calculation, and it removes the second most common payroll question after "why is this month different",
which item 8 answers.

### 36. Whether the payslip was actually opened

Publishing generates payslips. Nothing records whether anybody opened theirs. `payslips:download` is already
an audited read, so the data to answer "12 people have not opened this month's payslip" is being written and
never queried.

Surface it on the run, and it becomes both a delivery check and the evidence that the distribution obligation
was met.

## Expense mechanics

### 37. Mileage and per diem, computed rather than typed

A car journey and a day of subsistence have no receipt and a published rate. Today both are typed as an
amount and a description, which means the rate lives in somebody's memory and is applied inconsistently.

Give a category a rate kind (per kilometre, per day) and a rate. The submitter enters distance or days, the
amount computes, the receipt requirement does not apply, and the claim is right by construction. Rates change
by year, so they are effective-dated the way every other rate in this app is.

Needs: `rate_kind` and `rate` on `expense_categories`, effective-dated, plus a distance or days field on the
expense.

### 38. The corporate card statement, imported and matched

Upload the card statement, match its rows against submitted expenses on amount, date and merchant, and show
what is left over. The unmatched rows are the expenses nobody has filed yet, and the unmatched expenses are
the claims with no transaction behind them.

This inverts the whole module. Today filing an expense is something a person has to remember to do; after
this, the statement is the list and filing is completing rows on it. The matching is arithmetic and string
comparison, and the vendor aliasing that would make it fuzzy is item 13 in part one, which is optional here
rather than required.

Needs: a statement import with a per-card parser, a transactions table, and a match state on the expense.

### 39. The receipt that was never attached

Falls out of item 38. `requires_receipt` is enforced when a claim is submitted, which does nothing about a
card transaction that has no claim at all. Once the statement is imported, an unmatched transaction older
than some number of days is a chase, and it names the person the card belongs to.

### 40. Advances and floats

Money paid before the spend, settled against claims afterwards, with the balance returned or recovered. The
travel case that has no representation in the app today, so it is handled as a reimbursement filed in
advance, which leaves nothing tracking whether it was ever settled.

`loans.ts` already has the machinery: a balance, a recovery through payroll, an outstanding query. An advance
is a zero-interest short-term loan whose repayment can also be discharged by attaching expenses to it. Build
it on that rather than as a new money primitive.

### 41. One invoice, several cost centres

An expense has a single `departmentId`, so an invoice that is sixty per cent one department and forty per
cent another is filed twice with the invoice attached to one of them. The attachment is the evidence, so the
second row is evidence-free by construction.

Allow allocation lines on an expense: department, category, amount, summing to the total. The budget
calculation in `computeBudgetSpend` then consumes the lines rather than the row, which is a change to one
query and is the only place the split has to be understood.

### 42. Approval thresholds

There is no multi-level approval anywhere in this repository. Every workflow resource has one decision by one
approver. For expenses that is wrong above some amount, and every finance function has that number.

A claim over the threshold needs a second approval before it reaches APPROVED. Written as policy data in the
spirit of the authz work rather than as a hardcoded ladder: the threshold and who the second approver is are
configuration, and the state machine grows one state.

This also gives item 17 in part one its counterweight. Straight-through processing below a line is only
defensible if there is a firmer hand above one.

### 43. Payment terms as data

`vendors.payment_terms` is free text holding things like "Net 30". Nothing can compute with it, so an
approved expense has no due date and the app cannot say what is payable this week.

Make it a number of days. An approved expense then carries a due date, which gives aged payables, a "due this
week" list and a late-payment count for nothing. It also makes the payment run a queue rather than a search.

Needs: `payment_terms_days` replacing the text column, with the existing values parsed once in the migration.

## Planning and measurement

### 44. Committed salary cost for the next twelve months

Current compensation, plus known joiners with their start dates and agreed packages, minus known leavers with
their notice end dates, plus scheduled increments where they are recorded. Projected forward twelve months and
priced with the same pricer as everything else.

It is arithmetic over data the app holds, and it is the number somebody asks for every time headcount is
discussed. The app currently answers it by exporting to a spreadsheet.

### 45. Payroll budget against actual, by department

`expense_budgets` is already the right table shape: a scope, a period, a cap, a recurrence, and a spend
computed against it. Payroll has no equivalent, so salary is the largest line in the company and the only one
with no budget surface.

Reuse the shape with payroll as the source, and item 29's department stamping as the attribution. The
forecast from item 15 in part one applies unchanged, because it is a function of spend and elapsed time and
does not care which module produced the spend.

### 46. Money measures in the analytics module

`peopleAnalytics` has no money measure at all. Cost per head, overtime as a percentage of payroll, expense per
head by department, payroll cost by department over time.

These are team aggregates, which means they are the exact shape `analyticsNarrate` already accepts, so
building them also gets the narration for free and with no policy argument, since nothing per-person is in the
prompt. That makes this the cheapest route to item 6's outcome, and it bypasses the `CONSENTED_PATHS` entry
item 6 would need. If the narrated-payroll sentence is wanted, this is how to get it honestly.

## Build order for part two

By value, and the first group is deliberately long because all of it is small.

1. **Data that already exists, shown.** 22 (the calendar), 35 (year to date), 34 (arrears itemised), 36
   (payslip opened), 31 (the reconciliation identity). No schema, no new writes, and 31 is the one a payroll
   officer would notice first.
2. **Rules over existing columns.** 24 (four eyes), 25 (the period lock), 26 (the net floor), 23 (the
   reminders, which depend on 21's date but are worth building against `payDate` alone in the meantime).
3. **Small schema, large effect.** 21 (the cutoff), 43 (payment terms as days), 37 (mileage and per diem),
   29 (department on the run item).
4. **The accounting handoff, as one piece.** 27, 28 and 29 together. Splitting them ships a journal nobody
   trusts.
5. **Compensation.** 32 (the priced preview), then 33 (the batch) which is the same code with a list around
   it.
6. **New surfaces, each worth its own decision.** 30 (payment confirmation), 42 (approval thresholds), 41
   (allocation lines), 40 (advances), then 38 and 39 (the card statement), which is the largest item here and
   the one that changes how the module is used.
7. **Planning, once 29 exists to attribute it.** 45, 44, 46.

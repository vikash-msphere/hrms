# Tasks, reviews and goals: what they become next

The three surfaces are individually mature - boards carry WIP limits, swimlanes, sprints, CFD analytics and
lead/cycle time; reviews carry a four-state cycle, self ratings, 360 feedback, calibration and a PDF; goals
carry pace, drift, staleness, confidence, OKR children, templates, attainment, variable pay and contribution
credit. What is thin is the space BETWEEN them and the moments nobody is watching.

This plan is written from what the code actually does today, and each item says which of those two gaps it
closes.

## The pattern this plan follows

Deadline chasing in this app is **data, not code**: the daily scanner synthesizes `schedule.recurring` per
employee with derived metrics in the payload (`src/services/scheduledMetrics.ts`), and seeded rules in
`bootstrap/collections/automations.ts` decide who gets told what. Goals already carry four such metrics
(`goalsDueSoon`, `goalsOverdue`, `goalsAtRisk`, `goalsStale`) and three seeded rules that act on them.

So a nudge this app is missing is a missing METRIC plus a seeded RULE - never a new bespoke cron sweep.

## Phase 1 - the deadlines nobody chases - BUILT

Tasks and reviews had no scheduled pressure at all: a card's `due_date` and a cycle's `self_due_date` /
`manager_due_date` / `goal_setting_due_date` were stored, rendered, and read by nothing that tells anyone.
A task went overdue in silence, and review season ran on whoever remembered to nag.

Shipped, extending the goal pattern rather than duplicating it:

| Metric | What it counts |
|---|---|
| `tasksDueSoon` | Open cards assigned to them, due within 7 days |
| `tasksOverdue` | Open cards assigned to them, past due |
| `tasksBlocked` | Open cards assigned to them, flagged blocked |
| `selfReviewsDue` | Their own reviews awaiting their self-assessment in an ACTIVE cycle |
| `teamReviewsDue` | Reviews of their reports awaiting THEIR write-up |
| `goalSettingMissing` | 1 when an ACTIVE cycle wants goals by a date and they have none in it |
| `teamGoalSettingMissing` | How many of their reports are in that position |

Plus seeded rules over them: tasks due this week, overdue tasks (owner + manager), a blocked task nobody has
unblocked, self-review due, team reviews to write, and goal-setting season with nothing filed.

## Phase 2 - a rating carries its own guidance - BUILT

The framework in `settings/performance` was a bare `{key, label}` list, so every competency counted equally
towards nothing in particular and a rater got a 1-5 radio with no idea what a 4 means. Two additions, both
pure framework data:

- **`description`** per competency: the behavioural anchor, rendered as help text under the label in the
  rating form and in the review PDF, so "Ownership" means the same thing to two managers.
- **`weight`** per competency: a weighted competency score alongside the manager's overall rating, computed
  exactly like goal attainment (Σ weight x rating / Σ weight), absent when the framework carries no weights.
  The overall rating stays the manager's own call - this says what the competency ratings add up to, which is
  the number a calibration meeting argues with.

## Phase 3 - a checklist item that turns out to be real work - BUILT

`card_todos` is a text checklist, which is right until one line grows an estimate, a due date and a different
assignee. Turning it into a card meant retyping it and remembering to tick the original - and a checklist and
a board that both claim the same outstanding work is exactly the bookkeeping nobody keeps straight.

`cards/<id>:promoteTodo` does the whole swap in one call: the new card lands on the SAME board in its first
column, inheriting the parent's department, sprint and (unless the caller says otherwise) its assignee; the
item is ticked and its text gains the new card's key, so the checklist points at where the work went. Two
things it deliberately does not do - copy the parent's linked `goal` (the parent is still linked, and copying
it would count one piece of work twice in the goal's delivered share) and write a dependency (handing work
off does not block the parent, and `blocked_by` holds a single card that a real dependency needs).

## Phase 4 - following work you do not own - BUILT

Notifications reached exactly one person (the assignee, the owner) on exactly two events. Everyone else -
whoever raised a card, whoever commented on it, the owner of a goal BLOCKED BY this one, a contributor
credited with a share of it - had "remember to look", which on a weekly rhythm means finding out late.

`card_watchers` and `goal_watchers` are sub-resources reached through `:watch` / `:unwatch` on the parent, so
access is inherited and nobody can watch what they cannot read. Both are idempotent (a unique index) and
unaudited: who reads along is not a change to the work. Cards notify on a column move, a comment and a block
in BOTH directions - the unblock being the half nobody was ever told about, and the one that means somebody's
own work can start. Goals notify on a real progress move (not a re-save, not a roll-up), a comment, and a
confidence call turning at-risk. Everything is low priority so it digests, and anyone the event already told
directly is skipped rather than told twice. Commenting on a card watches it: the step everybody forgets, and
then wonders why they missed the reply to their own question.

## Phase 4b - who asked for this - BUILT

`cards.reporter_id`: the third person on a card. `employee_id` is the accountable owner (and the authz code
the row is scoped by, so it moves deliberately) and `assignee_id` is whoever is doing the work - when a
manager files a task FOR somebody, both become that person and nothing on the row said who asked. The answer
lived only in an audit entry, which a board cannot show and a filter cannot reach.

Stamped from the CALLER at create, never from the request body (a reporter a client can set is a reporter
anybody can put somebody else's name on), and never editable: it is a fact about the past. Filing a task also
makes the reporter a watcher of it, which is the case the watcher work was written for. Surfaced as a
"Reported by" line in the task dialog (only where it differs from the assignee), a hidden-by-default Reporter
column on the list, and an "I reported" board filter - "what did I ask for, and where has it got to".

## Phase 5 - the chore that comes back - BUILT

`cards.cadence` (weekly / biweekly / monthly / quarterly) plus the nightly `rollRecurringCards`. Rolls on
DELIVERY, not on a date - a chore running a week late does not want a second copy filed on top of it - and
the cadence MOVES to the new card, so exactly one card per series carries it and two ticks racing can only
produce one (a conditional update claims the series). Carried over: title, description, assignee, department,
priority, size, labels and the checklist, unticked. Not carried: the linked goal (a series would inflate its
task count forever) and the sprint (a time box the next one is not in).

## Phase 6 - what a task actually cost - BUILT

`time_entries.card_id`: an hour still books to a PROJECT (that is what a timesheet approves and what a client
is billed for) and now says which task inside it. Deliberately not validated against the project - a board is
not tied to one, so requiring them to agree would invent a relationship the data cannot express; the task only
has to exist and be live. The card's Get carries `logged_hours` from APPROVED entries only, absent rather than
zero when none are. A purge cuts the link and keeps the entry: an approved hour is a fact in a payroll run.

## Phase 7 - reviews that fit the org - BUILT

- **Reviewer override** (`reviews.reviewer_id`, `:assignReviewer`). The write-up fell to `managerIdOf()` and
  nowhere else, so a transfer mid-cycle or a manager on long leave left one fix: re-parent the employee, which
  changes approvals, scopes and the org chart to solve a review. `reviewerIdOf()` is now the single answer to
  "who owes this", honoured by the self-stage hand-off, the nudge, the acknowledgement note and the scheduled
  `teamReviewsDue` metric. Refused once shared - by then the reviewer is part of the record.
- **Per-cycle competencies** (`review_cycles.competency_keys_json`). A subset of the org framework rather than
  a per-cycle catalogue: ratings are stored against the framework's own keys, so narrowing keeps two cycles
  comparable where inventing competencies would make the attainment history meaningless. Retired keys are
  inert, and a selection matching nothing falls back to the whole framework rather than rendering a review
  form with no questions on it.
- **Peer feedback the reviewee seeds** (`SUGGESTED` + `:suggestFeedback`). Nomination was the manager's alone,
  which has the 360 backwards - the people who saw the work are known to the person who did it. A suggestion
  is inert: it notifies nobody and cannot be written to until the manager nominates that person for real,
  which upgrades the same row rather than asking them twice. Declining now carries a reason.
- **A goal out of a review line.** The manager's verdict used to die in `goal_ratings`; one press now opens a
  new goal prefilled with the line and that verdict.

## Phase 8 - the two views that were missing - BUILT

- **Bulk board actions** on the list tab (move to either end of the workflow, assign to me, unassign, mark
  urgent, watch), each one an existing per-card verb applied across the selection, with WIP limits and
  per-row access still deciding. The board is a drag surface; re-assigning a departing person's twelve tasks
  there was twelve drags.
- **The alignment cascade** (`Alignment` view on Goals). Alignment existed per goal - a parent and its
  children in the drawer - which is the wrong end to read it from. The questions this answers cannot be
  answered one card at a time: is anything hanging off nothing, is a whole team's work parented under one
  person's objective. Rooted on visible goals whose parent is filtered out, and it says how many children a
  parent has that the filters hide rather than misreporting the shape of the quarter.

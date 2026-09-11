# Goals: what the module becomes

The goals module today records objectives and scores them in a review. It does not tell anyone that a goal is
sliding until the due date has passed. This plan takes it from a list to an instrument: it says where a goal
is against where it should be, what happened to it over time, who has gone quiet, what the owner thinks, how
goals get agreed in the first place, and what they are ultimately worth.

Written 2026-09-09. Phases are ordered by dependency, not ambition: everything in Phase 1 is derivation off
rows that already exist, and each later phase leans on the signals the earlier ones produce.

## What is already built (not restated below)

Weights + rebalance · measures (baseline/target/current, progress computed, reduction goals) · alignment tree
(parent link, client-derived rollup) · linked board tasks driving progress · comments + @mentions · carry-over
into the next quarter/cycle · `goals.cycle_id` and weighted attainment scored inside a review, frozen at
sharing · per-goal manager verdicts · due-soon / overdue nudges via scheduled metrics · 1:1 check-in prefill ·
`goals_active` / `goals_completed` / `goals_overdue` / `avg_goal_progress` / `goal_attainment` analytics
measures · goal quick-create, deep links, global search.

---

## Phase 1 — the early-warning system — BUILT

All four are derived from data already stored. No new collection, and (bar one column) no new writes.

Shipped: `domain/goals.ts` (pace + silence, pure), emitted by the goal serializer; `goals.confidence` +
`confidence_note` with the `:setConfidence` verb and the `goal.confidenceChanged` event; progress history on
the item Get and the cycle burn-up on `GET /v1/goals?cycle=…&burnup=true`; "At risk" and "Gone quiet" filters,
pace/silence chips, the health block with a sparkline and the confidence picker on the Goals page; the burn-up
chart in the calibration panel; `goalsAtRisk` / `goalsStale` scheduled metrics with two seeded weekly rules;
`goals_at_risk` / `goals_stale` analytics measures. Tests: `test/goalHealth.test.ts`, `e2e/goalHealth.spec.ts`.

### 1.1 Pace: expected progress, drift, and a pace state

**What.** Every dated, open goal reports `expected_progress` (how far a goal on a straight line from its
creation to its due date should be *today*), `drift` (`progress − expected`), and a `pace` state:
`ahead` / `on_track` / `behind` / `at_risk`.

**Why.** Progress alone is backward-looking. "30%" is excellent in week two and a fire in week eleven, and
nothing on the page distinguished the two. Drift is the first number that makes a goal list actionable, and it
needs nobody to fill anything in.

**Shape.** Pure function in `src/domain/goals.ts`, computed in the serializer so there is exactly ONE
implementation and the web renders what the server said (unlike `measuredProgress`, which is mirrored in the
browser and pinned by a drift test). Undated goals, completed and cancelled goals report no pace.

**Lands in.** Goal card ring + chip, the goals list filter ("At risk"), the review's goals panel, the manager
cockpit (3.4), automation conditions (`goalsAtRisk`).

### 1.2 Progress history: a sparkline per goal, a burn-up per cycle

**What.** The goal drawer draws progress over time; the cycle's calibration panel draws weighted attainment
over time against the pace line.

**Why.** `goal.updateProgress` has always written `{from, to}` into `audit_log`, and the linked-task rollup
moves progress too. That is a time series nobody has ever read. "Went from 20% to 90% in the last three days
of the quarter" and "climbed steadily" score identically today.

**Shape.** History is read from `audit_log` (no new table): the item Get embeds `history: [{at_time, progress}]`
beside the comment thread it already carries. The cycle burn-up rides the goals list as `extra`
(`GET /v1/goals?cycle=…&burnup=true`) rather than living at its own endpoint - that way it inherits
`goals.read` scope and needs no grant of its own.

### 1.3 Staleness: the goal nobody has touched

**What.** Every goal reports `stale_days` (days since the last thing that happened to it: a write, a progress
move, or a comment). Chip on the card, filter on the page, `goalsStale` scheduled metric so an automation can
chase it, and a line in the weekly digest.

**Why.** Overdue is the symptom; silence is the cause. A goal that nobody has spoken about in five weeks is
already lost, and it looks identical to a healthy one until the due date.

### 1.4 Confidence: the owner's own call

**What.** `confidence` (`on_track` / `at_risk` / `off_track`) plus a short `confidence_note`, set by the owner
from the card without opening the edit form. Emits `goal.confidenceChanged`, so a rule can tell a manager the
moment a goal turns.

**Why.** Drift is arithmetic and knows nothing about the world. The owner knows the vendor slipped a month.
The interesting cell is the disagreement: "says on track, 25 points behind" is a 1:1 agenda item, and only
exists once both halves are recorded.

---

## Phase 2 — goals get agreed, not just typed

### 2.1 A goal-setting lifecycle — BUILT

Shipped: `goals.stage` (DRAFT → PROPOSED → AGREED, default AGREED) with `agreed_at`/`agreed_by`; the
`:propose` / `:approve` / `:requestChanges` verbs, the last posting its reason as a comment on the goal;
`goal.proposed` and `goal.agreed` events; `settings/performance.goal_approval` (`off` | `required`) with a
switch in the framework editor; `review_cycles.goal_setting_due_date` driving a countdown on the cycle's
coverage warning; the handshake strip and stage badges on the Goals page, a "Not agreed" filter, and the
un-agreed marker in a review's goals panel and its frozen snapshot. `GET /v1/goals?stage=PROPOSED` is the
approval-queue filter for API consumers; the cockpit (2.4) filters the rows it already holds rather than
issuing a second narrowed read.

Deliberately no e2e: turning approval on writes an ORG-WIDE setting, and a parallel run would flip it under
every other goal spec. `test/goalHealth.test.ts` owns the machine.

#### The original sketch

**What.** A stage ahead of the existing status: `DRAFT → PROPOSED → AGREED`, with manager verbs `:approve` and
`:requestChanges`, and a `goal_setting_due_date` on the review cycle. The cycle's coverage warning becomes a
countdown against that date, and a review can say its goals were never agreed.

**Why.** We score goals in a review, but nobody ever signs them off. An attainment number computed from goals
one party never agreed to is not defensible, and goal-setting season is the moment HR most needs a deadline
and a completion count.

### 2.2 Key results as children (OKR proper) — BUILT

Shipped: `goals.kind` (objective | key_result), a KR must name a parent, an objective with key results has its
`progress` DERIVED server-side (weighted, cancelled KRs dropped) on every KR write, delete and restore;
`:updateProgress` on such an objective is refused and an edit-form `progress` is dropped; `rolled_up` on the
wire so no client offers a slider the roll-up would overwrite.

#### The original sketch

**What.** `kind: objective | key_result`. An objective's progress is DERIVED, server-side, from its key
results' measures (weighted); it stops being typeable. Alignment stays what it is - a KR is a child of one
objective, an objective may still align under another objective.

**Why.** One goal carries one measure today, so a real objective ("make onboarding excellent") is either
unmeasurable or fudged into a single number. The parent rollup that exists is client-side and only counts the
children the VIEWER can see, which means two people see two different progress figures for the same objective.

### 2.3 Goal templates + bulk assign — BUILT

Shipped: the `goal-templates` collection (title, description, weight, `due_in_days` as an INTERVAL, measure,
suggested department, free-text set name), `:apply` creating real goals through `createGoal` so an applied goal
is indistinguishable from a hand-written one, skipping anyone who already holds it in that cycle; a Settings
panel with per-template and whole-set apply through the standard people picker.

#### The original sketch

**What.** A catalogue of template goals (title, description, measure, weight, relative due date) per role,
department or level; assign a template set to a team, a department, or a new hire in one press. Hooks into
onboarding transitions and cycle launch.

**Why.** Every quarter, the same twelve goals get retyped by forty people, badly. Mirrors the letter-template
and transition-template patterns already in the app.

### 2.4 Manager cockpit — BUILT

Shipped: `Team goals` (Progress workspace, route `team-goals`), one row per goal grouped by person and sorted
by trouble, with "Needs attention" / "Not agreed" / "All open" filters, a cycle filter, and two presses per
row: agree a proposed goal, or ask for an update (which posts a comment, so the ask is on the record and the
goal stops being silent).

Named for the question it answers rather than for reviews, because it is not a step in a review cycle: it
reads `goals` under `goals.read` and presses goal verbs mid-cycle, where the Reviews tab beside it scores a
frozen goal set at the end of one under `reviews.read`. It works in an org that runs no cycles at all - the
cycle picker is only a filter.

#### The original sketch

**What.** One screen: every report × every goal, with weight, drift, confidence, silence and last note, and
bulk actions (nudge, comment, request an update). Sorted by trouble, not by name.

**Why.** The card grid answers an owner's question ("what am I working on"). A manager's question is "who is
quietly sliding", and answering it today means opening fourteen cards.

---

## Phase 3 — goals connect to the rest of the business — BUILT

### 3.1 Attainment → variable pay — BUILT

Shipped: `compensation.variable_pay_target` (outside CTC), `review-cycles:variablePay` computing a line per
reviewee (attainment x target, with `blocked` saying why a line cannot be paid), and `:award` writing bonuses
at the recomputed figure - never one supplied by the caller - skipping anything already awarded. Panel on the
cycle card.

#### The original sketch

**What.** Cycle attainment × the employee's target variable pay = a recommended payout, reviewed by HR, and on
approval it writes a `bonuses` row citing the attainment and the cycle in its audit meta.

**Why.** This is the reason enterprises run goals at all, and every part of the plumbing already exists:
attainment (built), pay structures, bonuses, payroll runs. Deliberately a RECOMMENDATION with a human gate -
money never moves off a computed number alone.

### 3.2 Contribution credit — BUILT

Shipped: `goal_contributors` (share of the goal's weight, capped at 100%, owner excluded, one row per person),
`:setContributors` replacing the whole split at once, and `cycleGoals` crediting a contributor's share into
THEIR review as a weight-scaled line marked with whose goal it was.

The shares are a decision, so they stay hand-set - but the goal's own board already records who delivered each
linked task and how big it was, so `suggested_contributors` on the goal resource derives the split those tasks
imply (percent of the DELIVERED work, story-point weighted exactly like the card roll-up, owner excluded so
their credit remains the remainder). The contributor editor opens on it for a goal nobody has split yet and
offers it as a one-press "use this split"; the goal drawer says it in a line when other people delivered the
work and nobody is credited, which is the case where credit silently lands entirely on the owner.

#### The original sketch

**What.** Contributors on a goal (many-to-many, weighted share), so one piece of cross-team work can score in
several people's reviews without being duplicated as three separate goals that all claim the same win.

**Why.** Goals are single-owner. Cross-team work therefore counts for nobody, or gets triple-counted.

### 3.3 Effort against outcome — BUILT

Shipped: `projects.goal_id`, a goal picker on a project, and `logged_hours` on the goal resource (approved time
only, one grouped join) shown on the card beside its progress.

#### The original sketch

**What.** Link a project to a goal, and show the hours booked against it beside its progress: "140h logged,
goal at 30%".

**Why.** `time-entries → projects` already exists and is currently a payroll/utilisation artefact only. The
pairing is the one view that catches effort being poured into something that is not moving.

### 3.4 The social loop — BUILT

Shipped: "Say well done" on a completed goal, opening the kudos composer with the owner already picked; two
seeded automation rules on `goal.completed` (nudge the manager to recognise it; post it to the board, disabled
by default). Deliberately NOT hard-coded auto-publishing: a goal title is the owner's own words, so putting it
on a company board is an opt-in decision, which is exactly what the automation engine is for.

#### The original sketch

**What.** Kudos on a goal completion; an opt-in "completed" post to the announcements board; completions in
the weekly digest.

**Why.** A completed goal currently produces one notification to one manager and then disappears into a status
change. The org never sees the thing it asked for being delivered.

---

## Phase 4 — the long tail — BUILT

- **Department-owned goals** — `goals.department_id`, a picker on the form and a chip on the card. The named
  employee stays the row's owner and its code, so *every* existing scope rule is untouched: this says the work
  is the team's, rather than opening a second authz path. That was the reason this item sat last, and not
  needing one is why it landed first.
- **Dependencies** — `goals.blocked_by_id` with the boards' vocabulary: what has to move before this can, as
  distinct from `parent` (what it rolls up into). Self-blocks and mutual deadlocks are refused, the chain is
  walked depth-capped exactly as alignment is, and the card says "waiting on X".
- **Goal retro** — `goals.retro`, offered on the drawer once a goal is closing or closed, carried into the
  review's frozen snapshot and printed in the review PDF above the manager's verdict on that goal.
- **Attainment trend** — `attainment_trend` on the review item read: the person's last six SHARED cycles, each
  read from the review that froze it rather than re-derived, drawn as a small bar row on the review.
- **A transparency wall** — no code: `goals.read` granted to the `everyone` pseudo-role in Settings → Access
  turns the Goals page into the org-wide wall, because the page already renders whatever the caller's scope
  returns. Deliberately not a feature switch - access lives in the ACL, never in a flag ([[no-access-control-via-code]]).

---

## Ground rules for every phase

- Derived numbers are computed server-side and emitted; the browser renders them. The one exception in the
  codebase (`measuredProgress`, mirrored in `web/src/lib/goalMeasure.ts`) is pinned by a drift test, and no
  new mirrors get added without one.
- Reads stay demand-led: history, burn-up and cockpit data load when something is opened, never on mount.
- Nothing new is visible by default. New surfaces are private-by-default and widened through the ACL.
- One drizzle migration, squashed, after every schema change.

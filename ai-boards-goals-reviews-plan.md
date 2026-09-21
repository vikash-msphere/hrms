# Making /boards, /goals, /team-goals and /reviews smarter

Twenty features across four surfaces, written against what the AI layer already is (`ai-plan.md`,
`ai-rollout-plan.md`) rather than against what an AI feature list usually looks like. **All twenty are
built**; this file stays as the reasoning behind them, and the "Order to build in" table at the end records
what each one cost and which three needed a decision that was taken rather than assumed.

Nine of the twenty call no model at all, which is the plan's central claim and held up: on this allocation
the smart version of these pages is mostly the data already held, read at the moment it changes what
somebody does.

## What decides every item below

Three facts, and they rule out most of the obvious ideas before they are written down.

**The allocation is 10,000 neurons a day, the org ceiling defaults to 7,000, and a generation is about 120 of
them** (`ESTIMATED_NEURONS`). An embed is 1. So anything that runs per person, per card or per page load has
to be arithmetic or a vector lookup. Generation is either a button somebody presses or one batched call for
the whole org, never a loop over people. The Monday roundup already made this choice and is the precedent:
a hundred written digests is 12,000 neurons against a 7,000 ceiling, so the digest that ships is the one
assembled from the details the items already carry.

**Reviews, check-ins, review feedback and interview feedback are on `NEVER_TO_MODEL`.** Goals, cards, boards,
sprints and projects are on `INDEXABLE`, so they have vectors and can be compared; review text has neither and
may not be sent anywhere. The single exception is `reviews.draft`, and its basis is narrow on purpose: an
author gets prose back for the field they are writing in, seeded only with their own goals. Every review idea
below either stays inside that basis, needs no model at all, or is named as needing a new `CONSENTED_PATHS`
entry with a written basis.

**Decision 3 in `ai-rollout-plan.md` bars scoring, ranking or flagging a person.** That is Annex III of the EU
AI Act, it is why candidate ranking is not built, and it applies with more force to performance management
than to hiring. So none of the review items produce an opinion about an employee. They assemble evidence a
human reads, or they check the writing rather than the person.

A fourth, softer one: the useful half of these surfaces is the work that came before. `cardMovements` holds
every column transition ever made, `goals` holds progress against a due date, and both already have the
functions that read them (`computeBoardMetrics`, `goalPace`, `staleDays`). A lot of what reads as intelligence
here is those numbers shown at the moment they mean something, with no model involved.

## /boards

Built already: card triage (department, priority and size voted from delivered neighbours, plus in-flight
duplicates), the task description draft, and the checklist draft.

### 1. When this card will be done, from this board's own history

The board knows its cycle time distribution (`computeBoardMetrics` gives p50, p85 and throughput) and every
card's `columnSince`. So a card can say "in Review 9 days; 85% of comparable cards left within 4", and an
in-flight card can carry a forecast date sampled from the board's delivered cycle times rather than from
somebody's estimate. Comparable means same size band and same class of service, which the board already
carries as data.

Primitive: arithmetic over `card_movements`. Cost: zero neurons, one query per board, cached with the metrics
roll-up. Fallback: not needed; there is no model to fail. Wires into `domain/boardMetrics.ts` plus the card
panel and the board header.

This is the highest value per neuron on the page because the price is zero.

### 2. The triage call already made, asked two more questions

`suggestCardTriage` fetches 40 neighbours and votes department, priority and size off the delivered ones. The
same neighbour set answers two more things for free: how long comparable work actually took, and how often it
got blocked and on what. "Work like this took 11 days and 3 of 5 were blocked waiting on vendor access" is the
sentence that changes what somebody does next, and it costs one extra pass over rows already in memory.

Primitive: extend the existing vote. Cost: nothing beyond the call being made. Wires into
`services/cardTriage.ts` and `CardTriageCard.tsx`.

### 3. Steps taken from comparable finished work, not invented

The checklist draft asks a model to imagine the steps. The board holds the steps that comparable delivered
cards actually had. Offer the items that recur across the nearest delivered neighbours first, with the model
draft as the fallback when there are too few neighbours to say anything.

Primitive: the neighbour set plus a frequency count over their checklist items. Cost: zero when neighbours
exist, which also makes the model call rarer. Fallback: the existing `task-checklist` draft kind.

### 4. Link the card to the goal it is really serving

`cards.goal_id` exists and `deliveryAdvancesGoal` rolls delivered work up into goal progress, but the link is
filled by hand and so it usually is not. Goals are indexed. Nearest-neighbour a card's text against the live
goals of its owner and its department, and offer the link with the match shown.

Primitive: one vector query per card panel open, scoped the same way triage is. Cost: 0 neurons (the card's
vector is fetched, not recomputed). Fallback: the field stays empty, as today. This is also the item that
makes /boards and /goals one product rather than two pages.

### 5. A duplicate sweep the board runs on itself

Triage only finds duplicates when somebody opens the panel, which is after the second card was already filed.
Run the same comparison nightly across each board's open cards, cluster the pairs above the strict threshold,
and leave the list on the board for whoever grooms the backlog.

Primitive: vector queries in the nightly tick. Cost: queries only, no embeds and no generation. Wires into
`cron.ts` as a subtask next to the embed drain.

### 6. What changed on this board, in a sentence

The detection is arithmetic: throughput down against the prior period, WIP above the limit, blocked cards
ageing, a column's band widening on the CFD. The model is handed the movements already found and writes one
line, exactly as the team report's narration does, with the same rule that a sentence containing a number
which was not in the findings is discarded.

Primitive: arithmetic detection, one batched generation per board per day, cached by findings hash. Cost:
about 120 neurons per board per day. Fallback: the findings render as chips, which is what the panel shows
with the feature off. Reuses `services/analyticsNarrate.ts` wholesale.

### 7. Ageing work offered a split

A card whose age passes the board's p85 while its size says it should be small is the card that needed
breaking up a week ago. Surface it with the existing checklist draft pre-seeded with the ageing fact, so the
suggestion arrives with its reason attached.

Primitive: arithmetic trigger, existing draft kind. Cost: only when pressed.

## /goals and /team-goals

Built already: the goal draft kind, pace and drift derived on every serialize, the trouble filter, team triage,
and the confidence-against-pace disagreement.

### 8. Two teams writing the same objective in different words

The classic OKR failure, and it is a pure vector question because goals are indexed. Compare a goal against
every other live goal in scope: high similarity with a different owner is either duplicated effort or a
missing alignment link, and both are worth saying. The same query answers "this looks like it rolls up under
X" and offers the `parent_id` the owner did not set.

Primitive: one vector query when a goal is opened or saved. Cost: 0 to 1 neuron. Fallback: no panel. Wires as
`services/goalSimilar.ts` next to `suggestionSimilar.ts`, which is the same shape already working.

### 9. A goal that cannot be measured says so before it is agreed

`unit`, `baseline_value`, `target_value` and `due_date` are the difference between "70%" as a feeling and "42
of 60 customers" as a fact. The check is deterministic: no measure, no due date, progress moved by hand. Only
the fix needs a model, and it returns a proposed measure as zod-validated JSON (unit, baseline, target) that
the owner accepts field by field, the pattern resume extraction already uses, rather than rewriting their
sentence behind them.

Primitive: arithmetic check, optional generation on press. Cost: 120 neurons per press. Fallback: the check
alone, which is most of the value. Fits the `stage` workflow: it belongs on the DRAFT to PROPOSED step.

### 10. Nearest template instead of a dropdown

`goal-templates` exist and are picked from a list. Typing the goal and matching it to the nearest template is
the same primitive again, and it is how somebody discovers the template library exists.

Primitive: one vector query. Cost: 1 neuron for the typed text.

### 11. The retro box seeded with what the record already holds

`goals.retro` is written when a goal closes and by then nobody remembers. Seed it in the browser, editable,
from what the owner can already read on that page: the progress path, their own check-in notes, the delivered
cards linked to the goal. The seeding pattern is the one the self-assessment already uses, so the server keeps
receiving only an instruction.

Primitive: no model for the seed. The existing `goal` draft kind turns it into prose when pressed. Note the
consent line: check-in text is on `NEVER_TO_MODEL`, so it may be shown to its own author as editable text but
must not be sent as prompt input unless the author leaves it in the box themselves, which is the distinction
`reviews.draft` already draws. The basis belongs in `CONSENTED_PATHS` if this goes ahead.

### 12. What is blocking the most, on /team-goals

`blocked_by_id` makes goals a graph. Walking it finds the one goal whose movement would unblock four others,
which no list sorted by drift will ever show. The walk is arithmetic; the model, if used at all, only names
what the walk found.

Primitive: graph walk over the team's goals. Cost: zero. This is the team page's equivalent of the board's
flow view and there is nothing like it in the app today.

### 13. Coverage gaps, naming goals rather than people

For a department: goals that align to nothing the department is trying to do (similarity below threshold
against the department's own goals), and people with no agreed goal at all. Stated as a count and a list of
goals, never as a ranking of employees, which is the line decision 3 draws.

Primitive: vector comparison plus a join. Cost: queries only.

### 14. A check-in nudge that says what it is about

Check-in reminders exist. A reminder carrying the drift since the last check-in, the confidence the owner last
stated, and what moved is a different message from "time for a check-in", and it is assembled from fields, not
written.

Primitive: arithmetic. Cost: zero. Reuses the roundup's assembly approach.

## /reviews

The constrained surface. Everything below is either evidence assembly with no inference, or a check on the
writing rather than on the person.

### 15. The evidence pack

The highest value item on this page and it uses no model at all. A manager writing a review hunts through
goals, boards, kudos and notes for what the person did, and mostly gives up and writes from memory. The cycle
window plus the employee is enough to assemble: goals in the cycle with attainment and retro, cards delivered
against those goals, kudos received, contributions credited on other people's goals, and the person's own
check-in notes where the reader is allowed them. Rendered next to the writing pane, every item a link.

Primitive: queries the caller could already make, under the ordinary scope. Cost: zero neurons. Policy: no
model, so `NEVER_TO_MODEL` is not in play at all. This is the one to build first.

### 16. Self-assessment seeded wider than goals

Seeding from the cycle's goals already ships. The same basis argument extends to the person's own kudos and
their own delivered cards: their record, shown to them, as editable text. It is a `CONSENTED_PATHS` basis
edit, not a code hole, and the existing wording already distinguishes what may be seeded (their own) from what
may not (ratings, manager comments, peer feedback).

### 17. A check on the manager's draft, before it is shared

Not a check on the employee. Before `MANAGER` to `SHARED`, look at what the manager wrote: is there a specific
piece of work named, a date, a number; does it lean on personality words rather than on what happened; does it
compare the person to a colleague; does it use "always" or "never". Deterministic lexicon first, which needs
no neurons and no policy change because nothing leaves the process. The model pass that rewrites a flagged
sentence is the existing `review-summary` draft kind, which the author presses, and which already forbids
forming a view.

The rule that keeps this safe is that it may not touch a rating, may not block sharing, and may not be stored
as a judgement about the manager. It flags and it is dismissible.

### 18. 360 nominees proposed from who actually worked with them

`review_feedback` already has a `SUGGESTED` state for the reviewee's own nomination and nothing populates it.
The collaboration graph does: contributors on the same goals, co-owned or reviewed cards on the same board,
kudos exchanged, shared projects within the cycle window. Each suggestion shows why that person is on the list.

Primitive: joins. Cost: zero neurons. Policy: no review text is read, only who worked with whom.

### 19. Calibration narration over the distribution, never over a person

Calibration already computes the distribution. A sentence saying "engineering's ratings sit a band above the
rest of the org, driven by 4 of 22 reviews" is narration of arithmetic, the Phase 6 pattern. It names cohorts
and counts, and it never suggests moving anybody's rating.

Decision needed before building: the findings are derived from `reviews`, which is on the denylist, so even a
model that sees only numbers needs a `CONSENTED_PATHS` entry with a basis, or the sentence is assembled from a
template with no model at all. The template version is cheap and probably enough.

### 20. Cycle chase, ordered by what is nearest the deadline

Which reviews are stalled in which state, whose feedback requests are unanswered, which managers have not
started, sorted by time to the cycle's close. Arithmetic, feeds the existing attention list and the roundup
rather than being a new screen.

## Not to build

- **A summary of the peer feedback for the reviewee.** It reads as the obvious feature and it is the one that
  de-anonymises: three submissions paraphrased into themes are traceable to their authors by anyone who knows
  who was asked, and the text is on `NEVER_TO_MODEL` for exactly this reason.
- **Anything that scores, ranks, flags or compares employees**, including a flight-risk signal, a "top
  performer" surface or a rating recommendation. Decision 3, and it is not a close call.
- **Automatic writes from any of the above.** A suggested goal link, a voted department, a proposed measure:
  all of them land as a suggestion somebody accepts, through the normal service, with the normal audit.

## What each one turned into

| # | Item | Where it lives |
|---|---|---|
| 15 | Review evidence pack | `src/services/reviewEvidence.ts`, `reviews:evidence`, `ReviewEvidenceCard.tsx` |
| 1 | Card forecast from board history | `src/domain/cardFlow.ts`, `cards:flow`, plus `column_dwell` on `boards:metrics` |
| 2 | Two more questions off the triage call | `took` and `blocked` on `cards:triage` (the block history comes from the event log, because a card row clears its reason on unblock) |
| 18 | 360 nominees from the collaboration graph | `src/services/reviewCollaborators.ts`, `reviews:collaborators`, feeding both 360 pickers |
| 12 | Blocking chains on team goals | `blockingChains` in `web/src/lib/goalState.ts`, `GoalBlockers.tsx` |
| 8 | Goal overlap and alignment | `src/services/goalSimilar.ts`, `goals:similar`, flag `goals.similar` |
| 4 | Card to goal link suggestion | `suggestGoalForCard` in `cardTriage.ts`, `cards:suggestGoal` |
| 20 | Cycle chase into attention | cycle deadlines on `review_waiting`, plus the `feedback_requested` kind, on the dashboard and in the Monday roundup |
| 17 | Draft check before sharing | `web/src/lib/reviewDraftCheck.ts` - a lexicon, in the browser, so the draft never leaves the page |
| 5 | Nightly backlog duplicate sweep | `src/services/cardDuplicateSweep.ts`, a cron subtask, read back through `boards:duplicates` |
| 9 | Measure proposed for an unmeasurable goal | `goals:suggestMeasure`, flag `goals.measure`; the GAP CHECK is arithmetic and runs with AI off |
| 3 | Checklist from comparable delivered work | `suggestStepsForCard`, `cards:suggestSteps` |
| 6 | What changed on this board | `src/services/boardNarrate.ts`, `boards:narrate`, flag `boards.narrate` |
| 11 | Retro seeded from the record | `retroSeed` in `web/src/lib/goalState.ts` - progress, measure and delivered tasks only |
| 16 | Self-assessment seeded wider | the evidence panel's "add the delivered work to my draft", inside a widened `reviews.draft` basis |
| 19 | Calibration narration | `web/src/lib/calibrationNote.ts` - the template version, no model, no consent needed |
| 7 | Ageing work offered a split | a line on the card flow panel once the card passes its board's p85 |
| 10 | Nearest template | `matchingTemplates` in `web/src/lib/goalState.ts` - word overlap, because `goal-templates` is not in the semantic index and adding a collection to the index, the DDL and the migration to save a scroll is the wrong trade |
| 13 | Coverage gaps | `GoalCoverage.tsx` - goals that roll up to nothing, and who has no agreed goal |
| 14 | A check-in nudge that says what it is about | the 1:1 reminder carries the recipient's own goals in trouble, from the same predicate the dashboard uses |

### The three decisions, as taken

- **11, the retro seed: no new consent, so no check-in notes.** It seeds from the goal's own record - the
  measure, the shape of the progress, the linked delivered tasks. Check-in text is on `NEVER_TO_MODEL` and
  seeding it would need a `CONSENTED_PATHS` entry, which is a decision for whoever is accountable for the
  data rather than a line of code.
- **16, the wider self-assessment seed: delivered work yes, kudos no.** The `reviews.draft` basis was widened
  in place (no new path, so the test pinning the key set still holds) to cover the person's own delivered
  tasks and credited goal shares - their record, on collections that are not denylisted. Kudos stay out: a
  kudos is a colleague's sentence about this person, which is peer feedback however warmly it is written.
- **19, calibration: the template, not a generation.** The plan said the template version is cheap and
  probably enough. It is, and it needs no exception to the denylist at all.

## Order to build in

| # | Item | Model | Cost | Needs a decision |
|---|---|---|---|---|
| 15 | Review evidence pack | none | zero | no |
| 1 | Card forecast from board history | none | zero | no |
| 2 | Two more questions off the triage call | none | zero | no |
| 18 | 360 nominees from the collaboration graph | none | zero | no |
| 12 | Blocking chains on team goals | none | zero | no |
| 8 | Duplicate and alignment detection on goals | embed | ~1 neuron per goal opened | no |
| 4 | Card to goal link suggestion | embed | ~0 | no |
| 20 | Cycle chase into attention | none | zero | no |
| 17 | Draft check before sharing | lexicon, then existing draft kind | on press | no for the lexicon half |
| 5 | Nightly backlog duplicate sweep | embed | queries only | no |
| 9 | Measure proposed for an unmeasurable goal | generate | 120 per press | no |
| 3 | Checklist from comparable delivered work | none | zero | no |
| 6 | What changed on this board | generate | ~120 per board per day | no |
| 11 | Retro seeded from the record | none for the seed | zero | yes, a `CONSENTED_PATHS` basis |
| 16 | Self-assessment seeded wider | none for the seed | zero | yes, a basis edit |
| 19 | Calibration narration | template, or generate | zero or 120 | yes, template or consent |

Everything above the consent line is buildable without re-opening a policy decision, and nine of the sixteen
items call no model at all. That is the point rather than an accident: on this allocation the smart version of
these pages is mostly the data already held, read at the moment it changes what somebody does.

## New feature flags this would add

`AI_FEATURES` in `domain/aiPolicy.ts` is what puts a switch in the settings panel, so the model-calling items
need entries: `goals.similar` (8, 10), `boards.narrate` (6), `goals.measure` (9), and `reviews.check` (17) if
the model half of it is built. The items that call no model need no flag, because there is nothing to consent
to and nothing to fall back from.

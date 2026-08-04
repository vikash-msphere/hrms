# Agile Kanban board for HRMS — plugged into performance

## Context

HRMS has no work-tracking board. The closest surfaces are the ATS `Pipeline`
(read-derived columns, button moves, no rank) and the `tickets` support tracker
(list/table only). Neither has WIP limits, swimlanes, pull mechanics, explicit
policies, or flow analytics. The performance module (`goals`/`reviews`) exists
but is disconnected from any day-to-day work signal and emits no domain events.

Goal: a first-class agile Kanban that delivers the full method — visual signals,
columns, swimlanes, commitment/delivery points, WIP limits, pull system, explicit
policies, feedback loops, and flow analytics (lead time, cycle time, CFD) — and
wires it into the existing goals/reviews + event/automation engine so board work
rolls up to performance.

## Decisions (locked — greenfield, aim for best)

1. **Card = new standalone `cards` collection** that optionally links to a goal
   (`card.goalId`). Board stays a real flow tool; goals stay OKRs; the link feeds
   performance. (Not: cards-are-goals, not: retrofit support `tickets`.)
2. **Performance = first-class + events.** Card↔goal link with an opt-in board
   setting so **delivering a linked card auto-advances its goal's progress** out of
   the box (no hand-authored rule needed), PLUS new performance/board `EVENT_TYPES`
   so notifications and further automations layer on top. Read-only "work delivered
   this cycle" panel on Reviews.
3. **Boards are department/team-shared** — fits the existing own/dept/all code
   scope (card owner-coded, board dept-scoped).

## Architecture

Two new wire collections + one analytics log, following the goals/`add-collection`
checklist (schema → serialize → route+mount → authzResolve TABLES → encodeWireIds
ENCODABLE → collections COLLECTIONS → accessHint ACCESS_VERBS/KNOWN_VERBS →
openapi x-aep-resource+paths → web types/nav/App/customMethods/page).

### `boards` (flat-coded, team/HR-managed — like `review-cycles`)
- `name`, `description`, `departmentId` (scope/visibility).
- `columnsJson`: ordered `[{ key, label, wipLimit|null, policy(text),
  isCommitment(bool), isDelivery(bool) }]`. Column IS the workflow state (no
  separate enum), mirroring how `ats.stages`/`ticket-workflow` are data-defined.
- `swimlaneMode`: `none|assignee|goal|class|custom`; `swimlanesJson` (custom lanes);
  `classesJson` (classes of service: standard/expedite/fixed-date/intangible).
- `deliveryAdvancesGoal` (bool): when set, a linked card entering the delivery
  column advances its goal's progress (see Performance integration).
- Verbs: `configure` (edit columns/WIP/policies/lanes as one structured edit).

### `cards` (owner-coded, own/dept/all — like `goals`)
- `boardId`→boards, `columnKey`, `swimlaneKey|null`, `rank` (fractional real for
  in-column/lane ordering), `title`, `description`, `assigneeId`→employees,
  `priority`, `classOfService`, `size|null`, `dueDate|null`, `blocked`+`blockReason`,
  `goalId`→goals|null, `employeeId` (owner), soft-delete.
- Flow timestamps: `committedAt`, `startedAt`, `deliveredAt` — stamped when a card
  first enters the commitment column / first active column / delivery column.
- Verbs: `move {toColumn, toSwimlane?, rank?}` (the pull action: enforces WIP on
  destination server-side, stamps flow timestamps, appends a movement, emits
  `card.moved`/`card.committed`/`card.delivered`); `block`/`unblock`; `assign`;
  `prioritize`. Owner-ref `cards: { employee }` + `{ assignee }` so a manager
  creating for a report is BOLA-checked.

### `card-movements` (append-only analytics log; written only by `move`)
- `cardId`, `boardId`, `fromColumn`, `toColumn`, `at`, `actorId`. Powers CFD +
  lead/cycle time. Read-only collection (super/HR analytics scope).
- Analytics via `boards/{id}:metrics` verb → `{ cfd:[{date,columnCounts}],
  leadTime:{p50,p85,avg}, cycleTime:{...}, throughput }`, computed from cards +
  movements. Lead time = `deliveredAt−committedAt`; cycle time =
  `deliveredAt−startedAt`.

## The nine method pieces → where each lives

- **Cards** — `cards` rows; card component in the board UI.
- **Columns** — `boards.columnsJson`, ordered; column = state.
- **Swimlanes** — `boards.swimlaneMode` + card `swimlaneKey`; UI renders lane rows.
- **Commitment / Delivery points** — `isCommitment`/`isDelivery` column flags;
  entering stamps `committedAt`/`deliveredAt`.
- **WIP limits** — `columnsJson[].wipLimit`; `move` verb rejects over-limit
  destinations (override via a grantable capability); UI shows count/limit + breach.
- **Pull system** — work advances only via `move` into a column with capacity.
- **Explicit policies** — `columnsJson[].policy` text, surfaced on the column header.
- **Feedback loops** — new `EVENT_TYPES` (`card.created/committed/moved/blocked/
  delivered`, plus performance `goal.progressUpdated/goal.completed`) emitted at
  service tails; automation rules drive notifications, aging/WIP-breach escalation,
  and goal-progress updates. No new engine code — data only.
- **Lead/Cycle time + CFD** — `card-movements` + flow timestamps → `:metrics`.

## Performance integration

- `card.goalId` links work to an objective; optional `goalContribution` (percent
  points) on the card.
- **First-class rollup**: when `board.deliveryAdvancesGoal` is set, the `move` verb
  reaching the delivery column calls the existing `updateGoalProgress`
  (`goals.ts:96`) for the linked goal — advancing by `goalContribution`, or (default)
  recomputing progress as delivered/total linked cards on that goal. Reuses the
  existing verb + audit path; no new goal-mutation surface.
- **Events** (performance module currently emits none): add `goal.progressUpdated`,
  `goal.completed` at the `goals.ts` verb tails, and `card.created/committed/moved/
  blocked/delivered` at the `cards.ts` verb tails — registered in `EVENT_TYPES`
  (`src/domain/events.ts`). Notifications + any further behaviour (aging/WIP-breach
  escalation, cross-goal effects) then layer on as data-driven automation rules,
  no engine code.
- Reviews: read-only "Work delivered this cycle" panel on `Reviews.tsx` — the
  reviewee's delivered cards + cycle-time within `reviewCycle.periodStart/End`.
  No reviews schema change.

## Web UI

New reusable `web/src/components/common/Board.tsx` (columns, swimlane rows, cards,
WIP badges, policy popovers, class-of-service colour, blocked flag) using the
native HTML5 DnD pattern from `OrgChart.tsx:229-268` with fractional-rank persistence
and optimistic move (revert-and-toast on WIP rejection). New `web/src/pages/Boards.tsx`
(board picker + board view + Analytics tab: CFD area chart, lead/cycle percentiles,
throughput — via the dataviz skill). Wire `types.ts`, `nav.ts` (Performance section),
`App.tsx` lazy route, `components/access/customMethods.ts`.

## Phasing

- **P1 — Board core**: `boards`+`cards` collections; columns/WIP/policies/
  commitment-delivery config; `Board.tsx` DnD + pull + server WIP enforce; swimlanes;
  `Boards.tsx` page + board admin. (Core visual + operational mechanics.)
- **P2 — Flow analytics**: `card-movements` log + `:metrics` verb + Analytics tab
  (lead time, cycle time, CFD, throughput).
- **P3 — Performance plug**: card↔goal link; performance + board `EVENT_TYPES` +
  `emitEvent` calls; Reviews "work delivered" panel; documented automation recipes.

## Verification

- `npm run db:generate` (additive), `npm run api:types`, `tsc`, and the drift-gate
  tests (`policyValidate`, `wireRegistry`, `customMethodsDrift`, `openapiRoutesDrift`).
- End-to-end through Prism :4010 (per memory, never hit the worker directly):
  create board → configure columns/WIP → create cards → `move` across columns
  (assert WIP rejection at limit, commitment/delivery timestamps) → `:metrics`
  returns non-trivial CFD/lead/cycle → author an automation on `card.delivered`
  and confirm it fires → deliver a card linked to a goal and confirm the recipe
  advances goal progress.

## Status: IMPLEMENTED (all phases)

Backend: `boards`/`cards` wire collections + internal `card_movements` log; services
`src/services/boards.ts` (+`:configure`/`:metrics`) and `src/services/cards.ts`
(+`move`/`block`/`unblock`/`assign`/`prioritize`, server WIP enforcement, flow
timestamps, goal roll-up); pure cores `src/domain/boards.ts` + `src/domain/boardMetrics.ts`.
Events `card.created/moved/committed/blocked/delivered` + `goal.progressUpdated`/
`goal.completed` in `src/domain/events.ts` (module: Performance). Private-by-default
(no `grants.ts`/`seed.sql` grants; manifests carry owner-ref/scopes/references).
Web: `web/src/pages/Boards.tsx` (native-DnD board, WIP badges, policy tooltips,
swimlanes, config editor, CFD/lead/cycle/throughput analytics) + Reviews "work
delivered this cycle" panel. Verified by `test/cardsFlow.test.ts` (real D1).

### Automation recipes (feedback loops — author in the Workflows UI, no code)
- **Delivery nudge**: trigger `card.delivered` → `notifyManager` "Card delivered".
- **Blocked escalation**: trigger `card.blocked` → `notify` the assignee/manager with
  the block reason (payload `reason`).
- **Alternative goal roll-up** (if a board does NOT opt into `deliveryAdvancesGoal`):
  trigger `card.delivered`, condition `goal` present → `apiCall`
  `POST /v1/goals/{goal}:updateProgress` (super-authored, since apiCall is privileged).
- **Goal celebration**: trigger `goal.completed` → `notifyAudience` the team.

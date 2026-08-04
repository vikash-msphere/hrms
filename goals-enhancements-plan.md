# Goals page enhancements

Status: ALL 9 PHASES IMPLEMENTED (verify green: spectral + typecheck + 966 tests). This doc describes the shipped design. The earlier quick UI pass (search, overdue filter, clickable stat tiles, persisted filter, due-soon tint, owner avatars, due-date quick chips, section counts) is also live.

Ground rules that shape the design:

- Authz stays in the middleware; new server surface = policy data + registry entries, never engine edits.
- D1 read minimization: anything secondary (activity, history) loads lazily behind an explicit open.
- Schema changes squash back into the single 0000 migration.
- Any route/verb change updates `openapi.yaml`; the `openapiRoutesDrift` test gates it.
- Grants for new verbs are seeded in `bootstrap/` collections, not hardcoded.

---

## Phase 1 - Due-date reminders (workflow engine)

Goals are currently silent: nothing tells anyone a goal is slipping. The scheduled-automation scanner (`runScheduledAutomations`) with `perEmployee` scope + derived metrics is the natural home.

**Server**

- `src/services/scheduledMetrics.ts`: extend `EmployeeMetrics` with
  - `goalsDueSoon` - open goals (`not_started`/`in_progress`) with `due_date` within the next 7 days,
  - `goalsOverdue` - open goals with `due_date` in the past.
  One additional bounded select over `goals` (status + dueDate + employeeId), computed once per day-tick alongside the existing metrics.
- `src/services/automationEngine.ts`: add the two fields to the `perEmployee` firing payload (one line next to `pendingApprovals`).
- Condition evaluator needs no change (it already compares numeric payload fields).

**Seeds** (`bootstrap/collections/automations.ts`)

- "Goal due soon: nudge owner" - weekly Monday, perEmployee, condition `goalsDueSoon > 0`, action `notify` (in-app). Enabled.
- "Goal overdue: nudge owner and manager" - weekly Monday, perEmployee, condition `goalsOverdue > 0`, actions `notify` + `notifyManager`. Enabled.
- Notification digest already batches these if the org has digest on; no extra work.

**Docs/tests**: extend the scheduled-automation test with the new metrics; regenerate bootstrap.sql/demo.sql.

No UI work. Smallest phase, highest behavioural win.

---

## Phase 2 - Goal detail drawer + progress history + progress note

Today the edit dialog is the only "see everything" surface, and the activity feed hides inside it. Give each card a click-through detail Sheet (same right-Sheet pattern as inline settings).

**Server**

- `updateGoal`/`updateProgress` in `src/services/goals.ts`: `updateProgress` gains an optional `note` (short text). Audit call becomes `audit(deps, actor, "goal.updateProgress", "goals", id, { from: row.progress, to: progress, note })` - the meta param exists and is currently unused here. `from`/`to` recorded even without a note, which is what makes history renderable.
- `src/routes/goals.ts` + `openapi.yaml`: add `note` to the updateProgress request schema.

**Web**

- New `GoalDrawer` (inside `Goals.tsx` or `components/common/` if it grows): opens on card click (card body, not the action icons). Contents:
  - full title/description (no line-clamp), status/due/weight chips, owner,
  - progress slider (same commit-on-release control, moved here; card keeps its slider too),
  - optional note input shown when the slider value changed ("what changed?"), sent with updateProgress,
  - linked tasks list (the popover content, promoted),
  - `ActivityFeed` mounted on open (lazy, per the D1 rule),
  - progress history strip derived from the activity entries' `from`/`to` meta: a simple "12 Mar 20% -> 35% - note" list, newest first. No chart library; a mini bar per entry is enough.
- Edit stays a separate dialog (pencil), launched from card or drawer.
- `useDeepOpen` now opens the drawer instead of the edit dialog.
- `ActivityFeed`: teach it to render `goal.updateProgress` meta ("progress 20% -> 35%: note").

---

## Phase 3 - Manager rollup strip

Flat team-goal grid scales badly past ~10 reports.

**Web only** (all data already cached client-side):

- Above the team section, when the viewer has 2+ distinct owners visible: one row per owner - avatar, name, active count, weight-weighted avg progress (same formula as the scoreboard), overdue count (rose when > 0).
- Clicking a row filters the team grid to that owner (local state, chip-style "clear" affordance).
- Collapsible; collapsed state in localStorage next to `goals:filter`.

---

## Phase 4 - Link tasks from the goal side

Card-to-goal linkage exists only from the board card editor; progress rollup (`recomputeGoalProgress`) already handles link/unlink/deliver.

**Web only**

- In the drawer's linked-tasks section: "Link tasks" opens a searchable list of visible, undelivered, unlinked cards (from the cached `cards` collection). Selecting PATCHes the card's `goal` ref; unlink control per row PATCHes it to null.
- Respect card access: only offer cards whose `access.can` includes `update`; wrap the affordance in `AccessAction`.
- Server untouched - card PATCH already recomputes both goals' progress.

---

## Phase 5 - Weight rebalance panel

The dialog warns when open-goal weights exceed 100 but fixing means opening each goal one by one.

**Web only**

- "Rebalance" affordance next to the over-100 warning in the dialog and under the scoreboard when the viewer's own open weights exceed 100.
- Dialog lists that owner's open goals with inline weight inputs + live total; Save issues one PATCH per changed goal (`/v1/batch:run` is GET-only by design, and these writes are rare and user-initiated).

---

## Phase 6 - Quarter grouping

- View toggle (flat | by quarter) next to the filter chips, persisted in localStorage.
- Quarter of `due_date` (undated goals under "No due date", last). Section headers like "Q3 2026" with counts.
- Client-only regroup of the already-filtered lists.

---

## Phase 7 - Goal alignment (OKR-style parent links)

The one schema change. Decision to confirm before building: **keep goals employee-owned; alignment is a link, not a new org-goal type.** A "company goal" is simply a goal owned by a leader/HR that others align under. This avoids nullable ownership, new scopes, and grant surgery.

**Server**

- `src/db/schema.ts`: `parentId` self-reference on `goals` (nullable, `references(() => goals.uuid)`), index on `parentId`. Squash migration per the one-migration rule.
- `src/services/goals.ts`: accept `parent` ref on create/patch; validate the parent exists, is not soft-deleted, and reject cycles (walk up, cap depth ~10). Serializer emits `parent` as a wire ref.
- `openapi.yaml` + drift test.
- No rollup persistence: a parent's displayed "aligned progress" is computed client-side from visible children (weight-weighted). Server-side rollup across ACL boundaries would leak or lie; showing "of goals you can see" is honest.

**Web**

- Edit dialog: optional "Aligns to" combobox listing visible goals (excluding self and own descendants).
- Card: small "aligns to {title}" chip; drawer shows parent link + children list with their donuts and the computed aligned progress.
- Optional later: tree view tab; not in this phase.

---

## Phase 8 - Review-cycle tie-in

Surface the reviewee's goals inside the review form, read-only.

**Web only**

- Reviews page, within a review: "Goals in this period" fold-section - the reviewee's goals whose due date (or completion) falls inside the cycle's period window, with donut, status, weight. Data comes from the cached goals collection filtered client-side; visibility is whatever the reviewer's goal scope already allows (dept managers see reports' goals today).
- No schema link between reviews and goals; period-window matching keeps it zero-migration. If later we want a hard snapshot at review time, that becomes a separate decision.

---

## Phase 9 - Quarter rollover

Carry unfinished goals into the next quarter without retyping.

**Web only**

- "Carry to next quarter" in the drawer for any open, editable goal due before the current quarter; the overdue filter shows a banner with "Carry over to next quarter" for all such goals at once.
- Carry over = create a copy (same title/description/weight/parent/owner, progress kept, due date = end of next quarter) + PATCH the original to `cancelled`. Existing create/patch grants; no new verb, no server change.
- Undo toast deletes the copies and restores the originals' status.

---

## Order and effort

| Phase | Surface | Effort |
|---|---|---|
| 1 Reminders | server + seeds | S |
| 2 Drawer + history + note | server (small) + web | M |
| 3 Manager rollup | web | S |
| 4 Link tasks from goal | web | S |
| 5 Weight rebalance | web | S |
| 6 Quarter grouping | web | S |
| 7 Alignment | schema + server + web | L |
| 8 Review tie-in | web | S |
| 9 Rollover | web | S |

Suggested batches: 1+2 (makes goals proactive and trustworthy), then 3+4+5+6 (one web pass), then 7 alone (schema + decision above), then 8+9.

Open decisions before Phase 7: alignment stays employee-owned link-only (recommended above). Everything else has no open questions.

## Verification

- `npx tsc --noEmit` (web) and server tests per phase; new/extended vitest coverage: scheduled metrics (phase 1), updateProgress note + audit meta (phase 2), parent validation + cycle rejection (phase 7).
- `openapiRoutesDrift` covers the wire changes in phases 2 and 7.
- Bootstrap regeneration (`genBootstrap`/`genDemo`) after seed edits in phase 1.

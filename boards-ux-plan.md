# Boards UX plan

Improvements to the /boards page (kanban + scrum + analytics), beyond the polish already shipped
(inline quick-add, due chips, analytics days fix, sprint progress, filter counts). Fifteen items,
grouped into four rounds by dependency and effort.

STATUS: ALL 15 ITEMS IMPLEMENTED (see Status at the bottom for the per-item notes). The remaining
optional piece is the delivered-card archival cron under item 13 - deferred until a real board
approaches the fetch cap.

Ground rules that apply throughout:

- Access control stays in middleware/policy data. Every new affordance (menus, buttons) is wrapped
  in `AccessAction` / gated on `card.access.can` - never hidden by role checks in code.
- D1 read minimization: nothing new fetches eagerly. Refresh only on explicit user signal
  (focus return, open, click).
- Verify with `npm run typecheck` + reasoning; no screenshot booting. Server changes also update
  `openapi.yaml` (the `openapiRoutesDrift` test gates this) and `test/cardsFlow.test.ts`.
- Schema changes (rounds 3 to 4 only, if any): squash back to the single 0000 migration.

---

## Round 1 - quick wins (all S, client-only, no server changes)

### 1. Persist board selection + deep link
Problem: page always resets to the first board; tab resets too; no shareable link to a board.
- Store last-viewed board id in localStorage (`boards:last`), restore on mount, fall back to first.
- Support `?board=<id>` in the hash query for deep links; URL wins over localStorage.
- Keep `openId` (card deep link) behavior as is; a card link implies its board.
- Files: `web/src/pages/Boards.tsx` (Boards component board-select state). Check how
  `web/src/App.tsx` exposes hash query params; add parsing there if missing.

### 2. Refetch on window focus
Problem: board goes stale while others move cards; user sees nothing until manual reload.
- `visibilitychange`/`focus` listener in BoardView + ScrumView calls `reload()`, throttled to at
  most once per 60s. No polling (D1 budget).
- Files: `Boards.tsx`; consider a tiny shared `useRefetchOnFocus(reload)` hook in `web/src/lib/`
  since other pages (Approvals, Notifications) could reuse it.

### 3. Card aging indicator
Problem: stalled work is invisible; kanban's core signal is "how long has this sat here".
- Client-only: `update_time` older than 7 days -> small corner dot on the tile + tooltip
  "No activity for N days". Skip cards in delivery-point columns and delivered cards.
- Threshold hardcoded 7d first; if it earns its keep, make it a board setting later (configure verb
  already exists).
- Files: `Boards.tsx` (CardTile).

### 4. "Blocks" reverse-link in the card dialog
Problem: dialog shows what a card is blocked by, not what it blocks.
- Compute from `boardCards` already passed to CardDialog: cards whose `blocked_by` includes this
  card. Render as clickable key chips via the existing `onOpenCard`.
- Files: `Boards.tsx` (CardDialog). Pure client, zero requests.

### 5. Filter persistence per board
Problem: carefully built filter (assignee + labels + priority) evaporates on every visit.
- Persist `useCardFilter` state to localStorage keyed `boards:filter:<boardId>`; restore on board
  switch; Clear also clears storage. Cross-device sync via the preferences KV (dashboardPrefs
  pattern) is a possible follow-up, not in scope now.
- Files: `Boards.tsx` (useCardFilter gains an optional storage key).

### 6. Lane header counts
Problem: swimlane headers are bare labels; no sense of lane load.
- Append count (and points sum when cards carry points) to each lane header row.
- Files: `Boards.tsx` (BoardView lane header).

## Round 2 - mobile + flow (S to M, client-only)

### 7. Card actions menu: move without drag (the mobile fix)
Problem: HTML5 drag-drop is dead on touch; the board is view-only on phones. Also slow on desktop
for one-off moves.
- "..." button on each tile (hover-reveal desktop, always visible on coarse pointers via
  `@media (pointer: coarse)` or a `matchMedia` check). DropdownMenu:
  - Move to -> submenu of columns (reuses BoardView's existing move handler; rank = append to end
    of target column via `rankAt`).
  - Assign to me (patch `assignee`), Priority submenu (patch), Open.
  - Scrum boards additionally: Move to sprint / Send to backlog (PATCH `sprint`, the existing
    lane).
- Every entry gated on `card.access.can` (`move`, `update`); menu hidden entirely when the caller
  can do none of them.
- Files: `Boards.tsx` (CardTile + handlers lifted from BoardView/ScrumView so both views share
  them).

### 8. Per-assignee WIP violation highlight
Problem: `limit_scope: assignee` limits exist but violations only surface in a tooltip.
- Compute per-assignee counts per column; when over limit, ring the offending avatar in
  destructive color + tooltip "N of M (limit per person)".
- Files: `Boards.tsx` (BoardView column render).

### 9. Assignee avatar strip filter
Problem: filtering by person goes through a popover; slowest path for the most common filter.
- Toolbar strip of the top ~8 assignees by open-card count (+overflow count); click toggles that
  assignee in the existing filter state. Works alongside the popover (which stays for the full
  list).
- Files: `Boards.tsx` (BoardToolbar).

## Round 3 - structure (M, one server touch)

### 10. Collapsible columns
Problem: 6+ column boards overflow; done-style columns waste width.
- Chevron in column header folds it to a thin vertical strip (rotated label + count). Collapsed
  state per board in localStorage (`boards:collapsed:<boardId>`). Collapsed strip stays a drop
  target (drop = append to end).
- Files: `Boards.tsx` (BoardView).

### 11. Backlog reorder (scrum)
Problem: backlog is the one place order IS the plan, and it has no reorder; dropping onto backlog
ignores position entirely.
- Client: give the backlog column the same insertion-line + `rankAt` treatment as kanban columns.
- Server: today "to backlog" = `PATCH sprint: null` and rank changes = `:move`; two calls. Extend
  the `:move` verb with an optional `sprint` field (`null` = backlog) so drop is one atomic op and
  one event. Update `openapi.yaml`, `src/services/cards.ts`, `test/cardsFlow.test.ts`.
- Files: `Boards.tsx` (ScrumView dropOnBacklog), `src/services/cards.ts`, `src/routes/boards.ts`
  untouched (cards route), `openapi.yaml`.

### 12. List view toggle
Problem: no flat view for scanning, sorting, exporting a board's tasks.
- Third view (Board | List | Analytics): DataTable over the board's cards - key, title, column,
  assignee, priority, points, due date, labels, updated. Row click opens CardDialog. DataTable
  brings export, saved views, URL state, mobile cards for free. Bulk actions deferred until asked
  for.
- Files: `Boards.tsx` (new ListTab component), reuses `web/src/components/DataTable`.

## Round 4 - scale + depth (server work, design-first)

### 13. Break the 100-card ceiling
Problem: list pages cap at 100 rows; a board past that silently renders partial (TruncationNotice
only). Boards are the likeliest collection to hit it.
- Approach: client cursor loop on board open - follow `next_page_token` up to 500 cards, then show
  TruncationNotice. Reads stay proportional to board size and happen only on open (D1-acceptable).
- Pair with the real pressure valve: delivered cards older than N days auto-archived by cron
  (cards already soft-delete; surface an "Archived" toggle in the list view from item 12 to reach
  them). Cron piece is optional scope - decide when a real board approaches the cap.
- Files: `Boards.tsx` (loadAll helper), maybe `src/cron.ts` + `src/services/cards.ts` for
  archival.

### 14. Rich text card descriptions
Problem: descriptions were plain text; no lists/links/formatting for real specs.
- Shipped by reusing the board-post markdown-lite contract wholesale: the description stays ONE
  string column (no schema change), authored in a plain textarea with `RichTextToolbar` editing
  the source, rendered with `<RichText>` for readers who can't edit. FTS is unaffected - the
  unicode61 tokenizer strips the `**`/`#` markers as punctuation.

### 15. Card attachments
Problem: no way to hang a file (spec, screenshot) on a card.
- Shipped as option (a), link-only: `cards.documents_json` holds org-document ids; wire field
  `documents` (array of `org-documents/{id}` paths, whole-set replace). CardDialog gets a
  "Linked documents" section (chips linking into the Documents page + a Combobox to add, lazy
  org-documents read only while a dialog is open); tiles show a paperclip-style count chip.
  Option (b) (card-owned R2 uploads) stays out of scope unless links prove insufficient.

---

## Status

- [x] 1 board persistence + deep link (`?board=` in the hash query > localStorage `boards:last` > first)
- [x] 2 refetch on focus (shared `useRefetchOnFocus` hook, 60s throttle; scrum also refreshes sprints)
- [x] 3 card aging (7-day warning dot on undelivered tiles)
- [x] 4 blocks reverse-link (dialog lists cards waiting on this one, clickable)
- [x] 5 filter persistence (chip filters per board in localStorage; search text deliberately not saved)
- [x] 6 lane counts (per-cell count next to the swimlane label)
- [x] 7 card actions menu (tile "..." menu: move/assign-me/priority + scrum sprint/backlog; gated on
      `access.can`; always visible on coarse pointers - the touch move path)
- [x] 8 per-assignee WIP highlight (over-limit assignees ringed in the column header, both views)
- [x] 9 avatar strip filter (top-8 open-task assignees in the toolbar, click toggles)
- [x] 10 collapsible columns (fold to a strip, per board in localStorage; still a drop target)
- [x] 11 backlog reorder (`:move` gained `to_sprint`; backlog has insertion lines + rank; sprint
      drops are now one atomic move; covered in test/cardsFlow.test.ts)
- [x] 12 list view (Board | List | Analytics; DataTable with export/saved views/load-more)
- [x] 13 100-card ceiling (auto cursor-follow to 500 cards while the page is open; archival cron
      still deferred - revisit when a real board approaches the cap)
- [x] 14 rich text descriptions (markdown-lite reuse, no schema change)
- [x] 15 attachments (link-only `documents` field + dialog section + tile chip)

# Dashboard UX plan

Dashboard reorganization, UX and performance work. All 23 items are implemented. This file describes the
shipped state; per-item notes say where each behavior lives.

Page order now: hero (greeting + clock) -> shortcut tiles -> "My day" personal widgets -> KPI wall (For you /
Needs attention / Coming up as cards, At a glance as a compact strip) -> "Awaiting your approval" with inline
decisions -> team timeline (collapsed behind a button on phones) -> holidays + celebrations -> one merged
board card.

## A. Structure / organization

### 1. [x] "For you" vs "For org" split
`personal` is a fourth KPI category ("For you", first band): `docs_to_ack`, `letters_to_sign`,
`timesheets_draft`, `my_open_cards`, `timesheet_week` (now "My hours (week)", own hours only). The band order
and defaults live in `web/src/lib/dashboardConfig.ts`; the Settings editor picks the new band up generically.

### 2. [x] Shortcuts near the hero
The shortcut tile row renders directly under the hero, before everything else (`Dashboard.tsx`).

### 3. [x] Snapshot band as a compact strip
Snapshot KPIs render as one compact stat strip (icon + number + label per entry) instead of full cards.
Pinning a snapshot KPI promotes it to a full card in the pinned group.

### 4. [x] One merged board card
"Latest from the board": unread items lead (dot-marked, any kind), then the latest announcements, capped at
5; the header badge shows the unread count. The separate unread card is gone.

### 5. [x] Inline approve/reject on the approvals card
Each row carries approve/reject buttons following the row's own `access.can`, with a confirm dialog on reject
(optional note where the collection supports it - overtime, remote work). Decisions invalidate just the
decided collection; rows still deep-link to the Approvals inbox.

## B. Personalization

All personal state persists per user in the `preferences/dashboard` row (cross-device) with a localStorage
cache: `web/src/lib/dashboardPrefs.ts`. The old `dash.hideAllClear` localStorage flag migrates on first load.

### 6. [x] Band focus (legend pill) persists (`catFilter`).
### 7. [x] "Hide all-clear" persists cross-device (`hideClear`).
### 8. [x] Per-user pin/hide
Hover affordances on every KPI card (and strip entry): pin floats the card to the front of the wall keeping
its band accent; hide removes it for this viewer only, with a "Show N hidden" restore pill in the legend row.

## C. "My day" widgets (`Dashboard.tsx`, shown only for logins with a linked employee)

### 9. [x] Leave balance - own top-3 balances from `leave-balances`, named via leave types.
### 10. [x] Next payday - soonest `pay-periods.pay_date >= today`; links to Payslips.
### 11. [x] Time off ahead - own next approved leave, else the next holiday.
### 12. [x] Your onboarding - recent joiners (started within 60 days) see their ACTIVE onboarding transition:
done/total and the next open task. The transitions fetch is enabled for recent joiners regardless of KPI config.
### 13. [x] Recent decisions - approved/rejected outcomes on own requests, read from the already-loaded
notifications feed (no extra request); links to Notifications.

## D. Correctness / signal quality

### 14. [x] `not_clocked_in` subtracts people on approved leave and approved remote work, and reads 0 with a
"Holiday today" hint on org holidays.
### 15. [x] The celebrations KPI scrolls to the Celebrations card (`#dash-celebrations`).
### 16. [x] `timesheet_week` is the caller's OWN hours (personal band); org-wide hours moved to a new
`team_hours_week` snapshot KPI ("across everyone you can see").
### 17. [x] Filtered drill-throughs
`navigateFiltered()` deep-links using DataTable's URL-state format (`t.<key>={"f":{col:value}}`):
`expenses_pending` -> Expenses filtered to SUBMITTED, `notice_serving` -> Notice periods filtered to serving,
`compliance_overdue` -> Compliance filtered to Overdue. Other KPIs land on their page unfiltered because the
target either has no DataTable filter for that predicate (boards/kanban, tickets tabs) or the predicate is a
date window a single select filter can't express.

Also fixed while here: `expenses_pending` filtered on a nonexistent "pending" state (the awaiting state is
SUBMITTED), so the card was permanently 0.

## E. Performance (D1 read minimization)

### 18. [x] `GET /v1/dashboard-summary`
Aggregated KPI counts server-side: one request, one D1 batch of COUNT/SUM queries, numbers only.
- Authz mirrors `/v1/search`: the envelope is allowed, and the middleware builds a per-collection ListScope
  map (`scopesForCollections`, `summaryScopes`) from the exact list decision each backing collection would
  get. The service (`src/services/dashboardSummary.ts`) only binds scopes; a collection the caller may not
  list is absent from the response.
- Every aggregate's WHERE mirrors its collection's own list service (same `applyScope` columns, same
  soft-delete filter) plus the KPI predicate; `extra` carries the hint's companion number (money totals,
  of-N denominators, today/overdue sub-counts).
- The SPA requests only the keys visible to the viewer and skips the per-collection row fetches for any key
  the summary answered (`wantRows`); a missing key or a failed request falls back to the old row fetches, so
  the wall renders identically either way.
- Not summarized by design: `budget_over` (service-derived rollups) and the document ack/sign/expiry cards
  (per-caller join); their row fetches stay.
- Registry list in `src/domain/dashboardSummary.ts`; spec path in `openapi.yaml` (+ `.spectral.yaml` virtual-
  surface override); scoping tests in `test/dashboardSummary.test.ts`.

### 19. [x] One open-attendance read
`attendance?open=true` is fetched once by the page; the clocked-in KPI counts it and the clock widget receives
the caller's own session as a prop.

### 20. [x] Timeline collapsed on phones
On <768px viewports the team timeline mounts only after "Show team timeline" (choice persists via the same
prefs row), so its attendance fan-out never runs unasked on mobile.

## F. Polish

### 21. [x] Band focus, hide-all-clear, pins, hides and the mobile timeline state all persist per user (see B).
### 22. [x] Within each band, cards with live signal sort before all-clear zeros (stable otherwise).
### 23. [x] Shorter mobile wall - the personal band leads, snapshot collapsed to the strip, timeline behind a
button; verified by reasoning through the layout (no screenshot pass, per convention).

## G. Follow-up

### 24. [x] Per-user section layout
A "Customize layout" popover in the hero (sliders icon, next to the settings gear) lets each user reorder the
seven dashboard sections (shortcuts, my day, KPI cards, approvals, timeline, holidays & celebrations, board)
with up/down arrows and switch any of them off, plus a reset. Stored as `sectionOrder`/`hiddenSections` in the
same `preferences/dashboard` row (cross-device). Rendering uses CSS `order` on a flex column so reordering
never remounts a section; a hidden section renders nothing at all, so hiding the timeline also skips its
attendance fan-out. Unknown saved keys are dropped and newly-shipped sections append after the saved order,
so stale prefs can never hide new features.

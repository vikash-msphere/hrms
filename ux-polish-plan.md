# UI/UX polish pass - every surface, every screen size

The prior pass (`ux-responsive-plan.md`) made the app *fit* every screen: touch targets, bottom sheets,
card fallbacks, safe-area classes, a gate in `test/responsiveCoverage.test.ts`. Re-running its scans finds
almost nothing new, which is the point - geometry is done.

This pass is about what fitting does not buy: whether the phone experience *behaves* like an app, whether
a control can be named by a screen reader, whether the keyboard that opens is the right one, and whether a
1440px screen is used or merely filled.

## Pass 1 - platform behaviour the shell never had

- [x] **`viewport-fit=cover`.** The app wrote `env(safe-area-inset-*)` in 11 places and defined `pb-safe` /
      `pt-safe-t` spacing steps, and every one of them evaluated to `0`, because iOS only reports insets when
      the viewport meta opts in. The installed PWA was letterboxed instead of edge-to-edge and the standalone
      status-bar padding never applied. Opting in activates work that was already written, and pulls in the
      landscape side insets that nothing reserved: `safe-l` / `safe-r` spacing steps, `[data-app-shell]`
      padding for flow content, and explicit insets on the five fixed surfaces (bottom nav, drawer, toasts,
      sheet, dialog) that are positioned against the viewport rather than the shell.
- [x] **Scroll position on navigation.** A new destination starts at the top; Back returns to where you were.
      The two are told apart without history bookkeeping: a programmatic hash write fires `hashchange` only,
      while back/forward fires `popstate` first. The page being left is read from `HashChangeEvent.oldURL`,
      since several writers rewrite the path with `replaceState` and fire nothing. Restoration re-asserts per
      frame until the page is tall enough to hold the position (its rows are still arriving), and abandons at
      the first real scroll input.
- [x] **Route announcement.** Every navigation now sets the document title (it was the app name on all
      seventy pages), moves focus to `<main>`, and names the page in a polite live region.
- [x] **Pull to refresh.** Touch only, from the top of the page, never inside a modal or a scroller of its
      own, axis decided once on the first few pixels so it cannot fight a kanban swipe. Refresh means
      `resourceStore.refetchMounted()` - re-read what is on screen, not empty a cache.
- [x] **Offline.** There was no handling at all: losing signal failed every read with the browser's own
      "Failed to fetch" as the entire explanation, and nothing said the network was the reason or that it had
      come back. Now a bar under the app bar while it lasts, a re-read of everything mounted when it returns,
      and a named `ApiError` with `status: 0` from both fetch sites.

## Pass 2 - the keyboard that opens

- [x] **89 `type="number"` inputs, 5 `inputMode`s.** Decided once in `ui/input.tsx` instead of at 90 call
      sites, along with the wheel bug: a focused number field treats the scroll wheel as increment, so
      scrolling a form with the pointer over a salary silently edits it, and the edit looks like the user's.
- [x] **20 search boxes, none typed as one.** `type="search"` now, from which `ui/input.tsx` derives no
      autocapitalise, no autocorrect, no spellcheck and a Search key. The command palette and the combobox
      filter get the same treatment directly (they are raw inputs by design).
- [x] **Phone fields** are `type="tel" inputMode="tel"` (5 sites that were plain text).
- [x] **Autofill deliberately not applied.** Most forms here record someone *else's* details; filling the
      signed-in admin's own name into an employee record is worse than no autofill. Stated in the docs so the
      omission reads as a decision rather than an oversight.

## Pass 3 - names and semantics

- [x] **31 icon-only buttons with no accessible name**, across 19 files, announced as "button" and nothing
      else. (The first scan said 38; seven were multi-line and already labelled, which is why the gate that
      replaced it parses elements rather than lines.)
- [x] **The workspace tab bar is a landmark**, not an anonymous div of links.
- [x] **Two radio groups sat under the touch floor**: the leave half-day picker (`Segmented`, floored
      centrally now that `role="radio"` is in the index.css rule) and the interview rating, whose five 32px
      targets are filled on a phone during the interview and are now 44px square there.

## Pass 4 - layout

- [x] **`SummaryStrip`** (~35 pages, the highest-leverage component in the app) was a wrapping flex row with
      `divide-x`, which follows DOM order rather than visual rows: on a phone the first segment of every row
      after the first drew a rule against the page edge, while the rows themselves ran together with none
      between them. Now a grid, two across on a phone, with labels and values that truncate rather than wrap.
      Separators are per-segment borders pulled back a pixel, NOT a `gap-px` over a coloured ground: the gap
      trick is tidier to write and wrong here, because five segments in a two-column grid leave a sixth cell
      empty and an empty cell shows the ground as a solid block.
- [x] **`StatCard`** made readable at half width (tighter padding, smaller figure, truncation with the full
      value on tap) and the dashboard KPI band set to two across on a phone: one per row put eight full-width
      cards between the user and everything the dashboard is for. Pin/hide are `sm`-and-up - two 44px targets
      cannot share a 170px cell with a number, and preferences sync, so pins made on a laptop hold here.
- [x] **15 long dialogs pinned their footers.** A dialog whose panel scrolls takes its footer with it, so on a
      phone the Save button of a twelve-field form sat below the fold of its own dialog, including Request
      leave, the most-used employee form there is. Where a `<form>` wrapped the footer, the form now ends
      before it and the submit reaches it by `form="<id>"`.
- [x] Stat grids on Goals and Leave encashments made two-across on a phone.

## Pass 5 - the wide screen

- [x] Checked and left alone. The two-column grids at `sm` are form field pairs, where two is the right
      measure and widening hurts; Settings caps itself at `max-w-5xl`; tables want the width they get.

## Checked and deliberately unchanged

Worth recording, so the next pass does not re-derive it: overlay primitives (Popover, DropdownMenu, Select)
are already viewport-bounded with collision padding; every custom filter bar already wraps or scrolls; tab
bars already scroll with the active tab pulled into view; no raw table lacks a scroll box; both drag
interactions (kanban, org chart) already have a menu/picker path for touch; `Field` / `FieldRow` / DataTable's
phone card mode are sound.

## Pass 6 - gate and document

- [x] Four new checks in `test/responsiveCoverage.test.ts` (11 total): the viewport meta opting into the
      insets, icon-only buttons having a name, long dialogs pinning their footer, and search boxes typed as
      search. Each one names its fix in the assertion message.
- [x] `docs/06-responsive-ui.md`: five new rules (11-15) and a "Platform behaviour the shell owns" section
      covering the five things a page now gets without doing anything.

## Verification

`tsc` (web + worker), `npm run build`, and the full suite (1907 tests) pass. Per the repo convention this is
static verification only - nothing here was checked by opening the app.

Note: `npx vitest` inside the command sandbox silently reports 0 tests - it cannot read `.dev.vars` or write
wrangler's log. Run it with the sandbox disabled, and check the count, not just the exit code.

# Wide screens: show more, not bigger

Built on 2026-10-02 (uncommitted at the time of writing). Typecheck, lint and the web build are clean; the vitest
files and the e2e specs below still have to be run (both need the command sandbox lifted), and nothing has been
looked at in a browser yet. The rules themselves live in `docs/06-responsive-ui.md`, "Wide screens" (rules 29 to
36); this file records what was built where, and what is left.

## Context

On screens wider than a laptop the app only stretched: nothing in `web/src` changed layout above `xl` (1280px),
and the metric-row ladder stopped at a 1240px container. `<main>` is capped at 1920px (`max-w-[120rem]`,
`web/src/App.tsx`) and centred beside the sidebar; the top bar spans the full width.

Usable width is the viewport minus the 16rem sidebar and 2rem of page padding each side, up to the cap:

| Viewport | Usable | Empty each side of `<main>` |
|---|---|---|
| 1280 (`xl`) | 960 | 0 |
| 1440 | 1120 | 0 |
| 1536 (`2xl`) | 1216 | 0 |
| 1920 (`3xl`) | 1600 | 0 |
| 2560 | 1856 | 192 |
| 3440 | 1856 | 632 |

With the sidebar collapsed to its icon rail, every width below the cap gains 192px.

## Rules every change follows

1. **More, not bigger.** Width is a gain when it shows more: more columns, things side by side, or fewer lines per
   item so more items fit in view. Width that only adds empty space inside an item is not. A KPI card is an icon
   and a number, so a wide row gets more of them; a board card's text wraps, so a wide board gets wider cards.
2. **Nothing changes at or below a 1440px viewport, sidebar open or collapsed.** 1440 is the widest size
   `scripts/uiShots.mjs` measures and the size of the e2e `desktop` project, so both stay baselines and no existing
   spec changes. Every step keys off `2xl:` (1536px), the new `3xl:` (1920px), or a container width a 1440 screen
   cannot reach even on the rail (1312px usable).
3. **No new reads.** A wide layout rearranges what the page already holds.
4. **Phones and tablets are untouched.**

## What was built

0. **No compiled `.js` twins in the tree.** Vite resolves `.js` before `.ts` (`web/vite.config.ts` keeps the
   default `resolve.extensions`), so a `.js` that a `tsc` run without `--noEmit` leaves beside a `.ts` shadows it,
   and an edit to the `.ts` builds and tests from the stale copy without saying so. 965 such twins were deleted on
   2026-10-02. Before building, this must print nothing:
   `git ls-files --others --exclude-standard src test bootstrap scripts web/src | rg '\.js$'`

1. **One width on every page (`App.tsx`).** `<main>` is capped at 1920px on every route, canvases included. A
   workspace's tab strip and the page header sit inside it, so a page of another width would resize and re-centre
   them on every tab switch (on a 2560 screen, Boards to Goals would move both edges by 192px). Board and pipeline
   columns, the org tree and an open table grow into the cap and scroll within it past that; a five-column board
   still gets ~360px columns at 2560, enough for one-line cards (item 5). The top bar stays full width.

2. **Card galleries add columns (`web/tailwind.config.js`, the pages).** `3xl` is a new 1920px screen and
   `grid-cols-fill` a new template (`repeat(auto-fill, minmax(min(var(--cell, 16rem), 100%), 1fr))`). Each grid
   whose count is data keeps its ladder and adds `2xl:grid-cols-fill` with `--cell` at about its card width at `xl`:

   | Grid | File | `--cell` | Columns at 1216 / 1600 / 1856 usable |
   |---|---|---|---|
   | People | `pages/Directory.tsx` | 11rem | 6 / 8 / 9 |
   | Benefit plans | `pages/Benefits.tsx` | 20rem | 3 / 4 / 5 |
   | Loans | `pages/Loans.tsx` | 20rem | 3 / 4 / 5 |
   | Goal cards | `pages/Goals.tsx` | 20rem | 3 / 4 / 5 |
   | Leave balances | `pages/Leaves.tsx` | 14rem | 5 / 6 / 7 |
   | Profile leave balances | `pages/EmployeeProfile.tsx` (inside a card) | 12rem | 5 / 7 / 8 |
   | Overtime monthly totals | `pages/Overtime.tsx` (inside a card) | 19rem | 3 / 5 / 5 |

   Fixed sets step differently: the holiday year (`components/holidays/YearGrid.tsx`) goes to two rows of six
   from `3xl`; Operations' three scheduled tasks keep three across, which already fills the row. Benefits' "No
   plans" message now spans with `col-span-full`, whatever the column count.

3. **Metric rows: a 1600px rung (`lib/statRows.ts`, `index.css`).** `STAT_ROW_LADDER` ends `1240, 1600`; the caps
   at the new rung are strips 9, cards 6, tiles 6, actions 5, each no narrower than the preset is already read at.
   Rung 4 keeps its caps, because a 1440 screen on the rail reaches it. `test/statRows.test.ts` reads the ladder's
   length and covers the new rung.

4. **Card stacks two across (`.card-flow`, `index.css`).** A grid, one column until two 46rem columns fit, never
   more than two, an odd last card spanning the row; `--flow-gap` keeps the rhythm the `space-y-*` stack had. On
   the profile's Profile tab (the three personal cards; the completeness banner stays above), Identity tab and
   Activity tab (its two feeds, at the tab's 1.5rem gap).

5. **Board columns fill the row; cards reflow by their own width.**
   - Columns (`pages/Boards.tsx` kanban, backlog and sprint columns; `pages/Pipeline.tsx` stages) add
     `2xl:grow 2xl:basis-72`, no maximum. Too many to fit, each keeps 18rem and the strip scrolls.
   - `CardTile` is a size container (`.task-tile`) with a body wrapper (`.task-tile-body`). Below 19rem of content
     (a card at 1440 or below is ~262px kanban, ~278px sprint, border box; a phone's widest sprint card has
     exactly 18rem of content) the body is today's stack, pixel for pixel. From 19rem (five kanban columns on a
     2560px screen leave ~19.6rem; 20rem was never reached there) it is one wrapping row: title (grows), labels, details (pushed right). One line when they fit, the
     second line back when they do not, nothing truncated, and a 1.75rem right slot for the hover menu.
   - Pipeline cards (`.pipe-card`): from 19rem the name and job share a line (days in stage at its end) and the
     badges and actions share the next; four rows become two.

6. **Dashboard side column (`pages/Dashboard.tsx`).** From `3xl` the sections container is a grid,
   `minmax(0,1fr) 26rem`. Holidays & celebrations and Latest from the board sit in the side wrapper; everything
   else in the main one. Both wrappers are `contents` below `3xl`, so the single column and the saved `order` are
   exactly as before and nothing remounts at the breakpoint. Holidays and celebrations stack there
   (`3xl:grid-cols-1`).

7. **Board feed side column (`pages/Announcements.tsx`).** From 1920px (`WIDE_BOARD_QUERY`, board mode only) the
   page is one centred block, 960px feed plus a 22rem sticky side column (`<aside aria-label="Board tools">`, its
   own scroll). The search and filter chips (`filterBar`) and "Most recognized" (`leaderboardCard`) move there and
   mount in one place only (`useMedia`). Two decisions made while building:
   - The recognition charts stay above the posts, inside the 960px feed column (two across at ~468px). At 22rem
     a twelve-month line and an eight-name bar chart would be cramped.
   - "Give kudos" is on the leaderboard in the side column only. Below 1920px the leaderboard sits directly above
     the composer, which already offers Kudos, so a second button there would be clutter and would break rule 2.
   - Optional, waiting for a yes: "New this month", recent joiners from the employee rows the page already reads.

8. **Docked detail (`components/ui/sheet.tsx`, `App.tsx`, `pages/Leaves.tsx`).** `dock` sits on `<Sheet>` itself,
   because `modal` is a prop of the Radix root. From 1920px (`DOCK_QUERY`) a docked sheet is non-modal, sits under
   the top bar, ignores clicks outside it (another row swaps the detail), closes on its button and on Back, and on
   Escape only when the key is pressed inside it. It publishes its measured width as `--sheet-dock`; the column
   under the top bar takes that as
   right padding. The leave request detail uses it. Follow-ups: move the ticket and expense details from their
   dialogs to a docked sheet, and give Approvals rows a detail.

9. **Docs and tools.**
   - `docs/06-responsive-ui.md`: breakpoint rows for `2xl` and `3xl`, the "Wide screens" section (rules 29 to 36),
     rule 15's ladder, the shared-pieces list and the checking steps; `docs/02-hard-rules.md` gains the wide-screen
     line.
   - `scripts/uiAudit.mjs`: a `grid-stops-at-xl` finding for a data-mapped grid (a `.map(` right after the tag)
     whose ladder stops at `xl` or below with three or more columns. Form-field rows are fixed sets and are not
     reported. Four accepted with reasons (Settings, Operations, QuarterGrid, IllustrationPicker); none open.
   - `scripts/uiShots.mjs`: `desktop1920`, `desktop2560`, `ultrawide3440`.
   - `playwright.config.ts`: a `wide` project (2560x1440) running only `e2e/wide.spec.ts`; `desktop` ignores it.
     The spec checks that `<main>` has one width and position on Goals and Boards, the people grid's track count,
     a one-line short card and a still-wrapping long card on a board of the spec's own (five default columns), the
     dashboard side column (as
     the `it` login, since `dashboardLayout.spec.ts` changes `super`'s sections), the board's single search box
     inside its side column, and the docked leave detail (beside the list, swapped by another row, kept open by
     Escape from the list, closed by its button).

## Not changing

- `DataTable`: full width means fewer truncated cells, and rows keep `hover:bg-muted/50` for following a line
  across.
- Settings (`max-w-5xl` with its own section nav) and the candidate profile (`max-w-4xl`): forms want short lines.
- The top bar.
- The team timeline stays 14 days: more days means more attendance reads per person.
- Dialog widths.

## Still to run

- `test/statRows.test.ts` and `test/responsiveCoverage.test.ts` (vitest; needs the sandbox lifted).
- `npm run test:e2e -- --project=wide`, and in `desktop` the specs for the touched pages: `kanban`, `sprints`,
  `cardWork`, `cardBlocking`, `ats`, `leaveSelfService`, `dashboardLayout`, `kudos`, `boardMarkAllRead`,
  `directoryViews`, `profileTabs`. They run at 1440, where nothing changes, so a failure there is a broken
  guarantee rather than an expected difference.
- `scripts/uiShots.mjs` at the three new viewports for the touched routes (needs a yes before screenshots).

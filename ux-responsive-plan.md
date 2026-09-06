# Responsive / mobile UX pass

Goal: every page, action, menu, button, component, dialog, popover and prompt works well at
every screen size, with the phone experience held to a native-app bar. The web app already
carries a mature design language (see `web/src/index.css` palette, `components/ui/*`), phone
bottom-sheet dialogs, and a DataTable that degrades to cards below `sm`. This pass closes what
that work left open.

Breakpoints in play: phone `<640`, tablet `640-1023`, laptop `1024-1439`, desktop `>=1440`.
Sidebar is a drawer below `md`, an icon rail `md..lg`, full from `lg`.

## Pass 1 - touch and viewport foundations (`index.css`, ui primitives)

- [x] iOS focus-zoom: form controls under 16px make Safari zoom the page on focus. Phone-scoped
      `!important` floor on `input`/`textarea`/`select` (Tailwind's `.text-sm` outranks an element rule).
- [x] Touch-target floor on coarse pointers for Radix items (`[role=menuitem|option|...]`),
      icon buttons, and tab triggers.
- [x] Kill the iOS grey tap flash; `touch-action: manipulation` on controls to drop the
      300ms double-tap delay.
- [x] `overscroll-behavior: contain` on overlay scroll regions so a scrolled dialog/drawer
      does not chain into the page behind it.
- [x] Safe-area insets: standalone-PWA top bar, drawer, bottom nav, sheet footer, toasts.
- [x] CSS-only horizontal scroll shadows (`.scroll-shadow-x`) so a scrollable tab bar or table
      shows there is more to the side.

## Pass 2 - app shell

- [x] Mobile bottom navigation: 4 primary destinations + More, thumb-reachable, safe-area
      padded, hidden while the on-screen keyboard is open.
- [x] Sidebar drawer a11y/behaviour: `role=dialog`+`aria-modal`, focus trap, Escape, body
      scroll lock, not tabbable when closed, swipe-to-close.
- [x] TopBar density on a phone: eight chrome targets in a 56px bar is a cramped row - fold
      the secondary ones into an overflow menu below `sm`.
- [x] Workspace tab bar: scroll the active tab into view, edge fades, bigger touch targets.

## Pass 3 - overlays and menus

- [x] `Sheet`: bottom sheet on a phone (grabber, drag-to-dismiss, keyboard inset, safe area);
      right-docked panel unchanged from `sm` up.
- [x] Toast viewport: full width above the bottom nav on a phone, swipe-dismiss down.
- [x] `Select` / `DropdownMenu` / `Popover`: viewport-bounded height, no off-screen overflow at
      narrow widths, comfortable item heights on touch.
- [x] Confirm prompt: verify action order and reachability on a phone.

## Pass 4 - data surfaces

- [x] DataTable: toolbar (search + filters + views + density + export) collapses into a
      filter sheet on a phone; bulk-selection bar docks to the bottom.
- [x] Pages that render a raw `Table` with no card fallback.

## Pass 5 - page sweep

Every `.tsx` under `web/src` (70 pages + ~200 components) scanned for: unbreakpointed grids, fixed
grid templates, fixed widths, raw tables without a scroll box, side-by-side layouts that must
stack, dialogs overriding the phone sheet geometry, bottom-docked elements colliding with the nav,
and action clusters that overflow. The scans are now `test/responsiveCoverage.test.ts` rather than
one-off greps, so the coverage is repeatable and regressions fail the build.

Much of the app already handled this (calendars drop to single-letter weekday labels, `FieldRow`
stacks below `sm`, `PageHeader` wraps its actions, `DataTable` becomes cards). What the sweep
found and fixed:

- [x] **Hover-only controls, app-wide.** `opacity-0 group-hover:opacity-100` hides remove / pin /
      snooze / promote / row-actions behind a hover that does not exist on touch - the control is
      invisible but still occupies its box, so tapping it is a blind hit. 29 sites in 20 files;
      fixed with one class-attribute rule in `index.css` rather than 29 edits. Named group
      variants (`group-hover/col:`) are deliberately excluded - those reveal drag/resize handles
      for cursor-only gestures. The tiny (22-24px) targets among them were bumped individually.
- [x] **Approval rows.** The action cluster alone wants ~300px, so on a phone the request itself
      truncated to nothing. Decision moved to its own line, full-size Approve/Reject, waiting
      time relocated into the summary instead of being dropped.
- [x] **Kanban boards + ATS pipeline.** Columns snap one-per-swipe and near-fill a phone screen
      (86vw with a sliver of the next), instead of a fixed 288px column on a 390px screen. Board
      fill-height now stops above the bottom nav rather than running under it.
- [x] **Settings**: ticket-category rows and employee-field rows had 3-5 fixed columns that could
      not fit a phone at all; both stack, with the flags labelling themselves once their column
      headers are gone.
- [x] **Split panes**: asset tag printer and stocktake scanner stack below `lg` (the scanner
      especially - the phone is the device with the camera).
- [x] **Transition templates / TimeRangeField / expense-budget rollover**: fixed column templates
      (17rem, 18rem, five money columns) made fluid or folded below `sm`.
- [x] **Latent bug**: `grid-cols-[auto,1fr]` in Leaves compiled to an invalid
      `grid-template-columns: auto,1fr`, which browsers drop - that list had been rendering as a
      single column on every screen size.

- [x] **Bottom-docked page elements** that now collide with the phone nav: the announcements
      back-to-top button, the access-mode pill and its coach note, the ATS bulk bar. All lifted
      above it (and the pill has to stay tappable - it is how access mode gets turned off).
- [x] **Dialogs overriding their own height** (`max-h-[85vh]`, `h-[85vh]`, `max-h-[90dvh]`, the post
      composer's `96vw/90vh`) were overriding the shared phone geometry, putting their footers
      behind the keyboard and, in the composer's case, making the panel 16px wider than its slot.
      Each ceiling now starts at `sm`. 7 dialogs.
- [x] **Command palette**: docked to the top on a phone and keyboard-aware (its input is focused on
      open, so the keyboard is always up), with a close button and the keyboard-hint row dropped.
- [x] **Footer ordering**: `DialogFooter` is a reversed column on a phone, which put a third slot -
      `footerStart`, typically Delete - at the bottom edge, the most thumb-reachable spot in the
      dialog, below even Cancel. Sent to the far end instead (19 dialogs via WriteDialog, plus the
      photo dialog). The primary/Cancel order was left as it is (action-sheet convention) and the
      comment that described it backwards was corrected.
- [x] **Landscape phone** (`short:`, `max-height: 480px`): the bottom bar goes label-less and thin
      rather than away - it is the only route to the drawer on a phone, so hiding it would strand
      every destination that is not one of the five.

- [x] **Small icon-button targets**, 70 sites in 34 files at 24-28px. Floored to 36px on touch by one
      `index.css` rule selecting on the utility class the author wrote, scoped to actual controls so
      the many non-interactive `h-7` boxes (avatars, badges, swatches, spinners) are untouched.

### Second sweep - what the enumeration found that the sampling missed

- [x] **8 raw tables with no scroll container at all** - the worst mobile failure mode, since a bare
      `<table>` widens its ancestors until something scrolls, and with nothing above it that
      something is the page. Mostly employee-profile panels (compensation history, revision history,
      assets, bonuses, role history, settlement) plus recruiting analytics and the jobs list - i.e.
      the screens an employee actually opens on a phone. Each wrapped, with a min-width so columns
      stay legible, `whitespace-nowrap` on the date/money columns, and Category folding away on
      Assets with its value re-appearing under the name.
      (The three `overflow-y-auto` lists were checked and left: per spec that computes
      `overflow-x: auto`, so they already scroll.)
- [x] **AclModal** - role and per-user grant rows were `justify-between` with a 160px access
      dropdown, leaving the subject ~150px on a phone next to badges that cannot wrap away. Rows
      stack below `sm` with the control full width; the label rows wrap.
- [x] **Schedule roster** - the frozen name column was a fixed 240px, two thirds of a phone screen,
      leaving barely a day and a half of roster visible beside it. 7.5rem on a phone.
- [x] **Salary structures / Reviews** - fixed 3-track component rows, and prose-beside-buttons rows
      that squeezed the sentence into a column of single words.
- [x] **Boards** - removed the ad-hoc `[@media(pointer:coarse)]` patch now that the central rule
      covers it, so there is one mechanism rather than two.

### Gate

`test/responsiveCoverage.test.ts` - 7 checks over every `.tsx` in `web/src`. It caught two live
offenders the manual sweep had walked past (an unwrapped settlement table, an unprefixed 4-track
template), which is the argument for having it. Each check names the fix in its assertion message.

One rule could not be gated: index.css itself is unreadable in the workers pool (Vite resolves a
`?raw` CSS import to an empty string), so a content assertion would pass vacuously. The test says so
and gates the Tailwind variants the components depend on instead.

## Documentation

`docs/06-responsive-ui.md` states what changes at each breakpoint, the ten rules new UI follows, and
where the shared pieces live. `docs/02-hard-rules.md` gained the touch clause; the README doc tree
lists the new file.

## Verification

`tsc` (web + worker), `npm run build`, and the full suite (158 files / 1896 tests) pass.

Note for future work here: `npx tsc` output is filtered by a shell hook and reported "no errors"
over real failures. Run `./node_modules/.bin/tsc -p web/tsconfig.json --noEmit` and check `$?`.

## Pass 6 - nothing scrolls sideways but the things that should

The passes above stopped the PAGE scrolling sideways. They did it, in ~19 places, by giving a wide
table its own scroll box - which is the right answer for a matrix and the wrong one for a list: on a
phone the reader gets two of six columns, a gesture nobody performs, and column headings that scroll
away from the values they label. This pass finishes the job: a horizontal scrollbar now exists only
where the grid IS the content (kanban board, ATS pipeline, permission matrix, roster, year heat-map,
org chart, code block).

### How the offenders were found

A min-content width estimator over the JSX (TypeScript parser, one pass to register every component
in `web/src` and a second to fold each component's own floor into its use sites) modelling what CSS
actually does: a non-wrapping flex row's floor is the SUM of its children's, a column or wrapping row
is the MAX, `min-w-0` / `truncate` / `overflow-*` releases the floor, text is free because
`overflow-wrap: break-word` is global, and a `<td>` inside a declared scroller is exempt. Anything
whose floor exceeded the 328px of content column a 360px phone has was a real offender, and the
estimator named the children responsible. 21 sites at page width, plus 12 more inside dialogs, whose
content column is narrower still (280px, now 288px - see below).

### What changed

- **`.table-stack`** (`index.css`, rule 18 in the responsive doc): below `sm` a hand-written table
  becomes a list of labelled rows, and from `sm` up it is exactly the table it was. Each `<td>`
  carries `data-label`; the cells that legitimately have none are the ones with no heading either
  (row title, action cluster, `colSpan` note). Applied to 16 tables: my assets, bonuses, role
  history, compensation history (×2), settlement neighbours, referrals, tax declarations,
  candidates, offers, requisitions, recruiting analytics, background jobs, bank-format columns,
  payroll run review, team attendance, leave history, role comparison.
  The exceptions are stated in the gate's allowlist with a reason each.
- **Timesheets** turned its week grid inside out on a phone instead: one card per project with its
  seven days as a row of buttons underneath. A project × day grid cannot lose its name column, and
  eight columns will not fit however narrow the cells get.
- **Action clusters** wrap rather than holding one line - centrally, where it is one edit instead of
  thirty: `PageHeader`'s action slot (`[&>*]:flex-wrap`, which reaches the caller's own cluster) and
  `DataTable`'s phone card, whose trailing cell can carry three labelled buttons.
- **Rows that stated more width than a phone has**: the workflow action editor's two selects, the
  ticket/board checklist pickers, the brand-image field, the dashboard-audience rows, the stocktake
  scanner's lists and header, the punch list, the document row's badge cluster, the quick-menu editor.
- **Dialog geometry**: `p-5` on a phone instead of `p-6`. 24px of padding either side of a 328px
  panel spends 15% of the width on nothing.
- **`dvh` for anything phone-visible that was sized in `vh`** (10 sites): `vh` counts the space behind
  the mobile browser's own chrome, so a 92vh overlay puts its header under the address bar.
- **The phone card shows the STATUS column.** Column order is written for a table, where status is
  read across the row; a card that shows a leave request's type and dates but not whether it was
  approved has left out the reason the page was opened. `DataTable` now ranks a `state`/`status`
  column directly under the title unless the page states its own `mobilePriority`. One rule instead
  of thirty-three per-page rankings.
- Row-action buttons get a 36px floor **in the card** (not in the table, where inflating them would
  push the columns off screen).

### Gate

Two more checks in `test/responsiveCoverage.test.ts` (18 total): a hand-written table that neither
stacks nor is an allowlisted matrix, and a stacking table whose cells carry no `data-label`.

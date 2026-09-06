# UI/UX refinement pass - states, reachability, and the bars that hide

Three passes preceded this one and are done: `ux-responsive-plan.md` made every surface *fit* every screen
(touch targets, bottom sheets, card fallbacks, no sideways scrolling), and `ux-polish-plan.md` added the
platform layer (safe areas, scroll restoration, pull-to-refresh, offline, keyboards, accessible names).
Re-running their scanners finds nothing new. Geometry and platform are finished.

What they did not cover is what the app looks like when it has **nothing to show yet**, **nothing to show at
all**, or **something in flight** - and the affordances that a finger cannot reach even though they fit.

## Pass 1 - the wait

- [x] **27 bare `Loading…` paragraphs** replaced with placeholders shaped like what is arriving. A centred
      sentence collapses its container to two lines and then snaps to full height when the data lands: on a
      phone the reader loses the panel they just opened, and on a slow connection the app reads as empty
      rather than as busy.
- [x] **The skeleton vocabulary was dead code.** `FormSkeleton` / `DetailSkeleton` were written in an earlier
      pass and imported by *nothing*. They now live in `components/common/Skeletons.tsx` with the shapes that
      were missing - a table (mirroring `.table-stack`: labelled blocks below `sm`, columns above), a divided
      row list, a card feed, a tile grid, a metric band, a document page, a lazy settings panel - and every
      wait in the app renders one of them.
- [x] **`DataState`'s default** was five identical full-width slabs. It is now the shape of what it actually
      wraps in nearly every caller: a toolbar over a table. That is one edit for ~56 surfaces.
- [x] **The route-chunk fallback** (`PageLoading`) was a fixed header-plus-two-blocks matching no page; it now
      holds the title / metric band / list geometry every route in this app settles into.
- [x] Gate: a wait that renders the word "Loading" fails the suite. "Loading **more**" is exempt and stays a
      spinner - the content and its geometry are already on screen.

## Pass 2 - the zero state

- [x] **`DataTable` tells the two empties apart.** Nothing-created-yet and filtered-to-nothing are different
      states with different recoveries. The second now renders its own way out ("Clear search and filters"),
      and the first renders the page's create control via a new `emptyAction` - because describing the action
      in prose while the button is a header away is the worst of both, and on a phone that header is several
      screens up. Wired on the 11 pages that had no page-level `EmptyState` of their own.
- [x] **Delegations** was titling an empty table "Loading…" through `emptyTitle`, so an in-flight read read as
      "you have no delegations". It uses the shared `DataState` now, and gained a real zero state.

## Pass 3 - what a finger cannot reach

- [x] **46 tooltips, none of which opened on a tap.** A Radix tooltip is a hover surface, and Radix treats
      `pointerdown` as a *dismissal* - so on a phone tapping the trigger was the one gesture guaranteed not to
      show it. Right for a tooltip that repeats a button's label; wrong for the ones carrying the only copy of
      something. `<Tooltip tapToOpen>` renders those as a tap-driven popover on a coarse pointer. Applied to
      `InfoHint` (whose entire job is holding helper text out of the layout, and which did nothing at all on a
      phone), a board column's written policy and its commitment/delivery flags, the WIP-limit offender, the
      three budget explainers, the timeline legend, and - the most-missed of them - the exact timestamp behind
      every relative time on the board, the scheduled-publish time of a draft, and the read-receipt names.
      Deliberately *not* applied where the trigger sits inside something clickable (a kanban tile), where the
      tap belongs to the parent and the parent shows the same thing.
- [x] `InfoHint`'s target was a 14px glyph. The glyph stays; the box takes the same 36px floor index.css gives
      every other small icon control.
- [x] Gate: a tooltip on an inert trigger (`asChild` around a bare `<span>`) must be `tapToOpen`.

## Pass 4 - the bars that hide

- [x] **Two sticky bars were pinning behind the app bar** (`sticky top-0`, `h-14`, z-30) and therefore
      vanishing at the exact moment pinning existed for: the Approvals bulk-decision bar at `top-2`, with the
      selection count and the Approve/Reject buttons on it, and the Settings section nav at `top-4`. Both
      clear the bar now, and the offline bar moved into the app bar's z band so a page's pinned bar cannot
      cover "you are offline".
- [x] **A sticky header inside an unbounded scroller is inert** - `position: sticky` pins inside the nearest
      *scrolling* ancestor, and a scroll box with no height ceiling never scrolls, it grows. The payroll run
      review's column headings were written to stick and never did; the container is bounded from `sm` up now
      (left unbounded on a phone, where the rows are stacked blocks with no header to keep). `DataTable`,
      the timeline, the team attendance table and the copy-year list were checked and were already bounded.
- [x] Gate: a page-level `sticky top-{0..3}` fails unless allowlisted as pinning inside its own scroller.

## Pass 5 - phone composition

- [x] **The bottom bar's create button leads with the current page.** The page's own create control is in the
      header; on a phone that is several screens up as soon as the list is scrolled, and the alternative was a
      hunt through twenty unrelated quick actions. "On this page" is now the first group, promoted rather than
      duplicated.
- [x] **`PageHeader`'s description clamps to two lines below `sm`** with a More/Less toggle. At full width it
      costs one line and is worth it; on a phone the longest of them ran to four lines of a screen already
      carrying a title, a metric strip and a toolbar before any content. The toggle is a separate control, not
      the paragraph itself, so the text stays selectable.

## Pass 6 - controls only a pointer could reach

- [x] **Three primary interactions had no keyboard route at all**, because they were click handlers on plain
      `<div>`s and `<tr>`s: opening a kanban card (so a keyboard could not reach a single card on the board),
      expanding a day on the attendance sheet, expanding an employee's lines in the payroll run review. Plus
      the onboarding/offboarding transition expander, which is the only way to see a transition's task list.
      Each is now a real `<button>`, or keeps its element with `tabIndex`, an Enter/Space handler guarded on
      `e.target === e.currentTarget` (so nested controls keep their own keys) and `aria-expanded`.
- [x] Gate: a clickable non-interactive element must carry a keyboard route. Reading a JSX opening tag for
      this needs brace awareness, not a regex - an arrow function in an attribute contains the `>` a regex
      takes for the end of the tag, and an apostrophe inside a template literal ("You've used all your picks")
      opens a string that swallows the rest of the file. Both are handled and stated in the check.
- [x] **10 raw `<select>`s** (the settings and letter-template editors) bypassed `ui/select.tsx` and with it
      the `min-w-0` floor rule 16 puts in the primitive and the touch height. Given both, in place: a native
      select is the better control on a phone (it opens the OS picker) and is worth keeping.
- [x] The three unstyled native checkboxes in the letter editor now match the 16px box every other one uses.
      The eight raw checkboxes across the app are all inside a `<label>` that makes the whole row the target,
      which is why they stay native: a Radix `Checkbox` is a `<button>`, and wrapping one in a label does not
      associate it - the conversion would trade a row-sized tap target for a 16px one.

## Pass 7 - the sweep, and the third state

The passes above were driven by pattern scans, which find what they are told to look for. This one enumerated
**every one of the 247 `.tsx` surfaces** in `web/src` and asked the same questions of each: does it say
anything about a phone, and if not does it write any layout that would need to; does it say anything about a
wide screen; and does it carry all three answers a list has to give. `scripts/uiAudit.mjs` is that sweep, kept
runnable rather than thrown away - it opened at 44 findings and closes at **0 open, 13 accepted**, each
accepted one carrying its reason in the file (a declared matrix scroller, a three-column grid of text, a page
that delegates its load state to `RequestsHistoryTabs`, a record page with no set to be empty).

What the enumeration found that the pattern scans had not:

- [x] **Empty, unarrived and failed are three states that look identical from the data** - all three are zero
      rows - and four surfaces stated the most confident of the three as fact:
      - **Approvals** said *"You're all caught up"* before a single queue had been read, and again when a
        queue's read had **failed**. That is a manager's decision signal, and it was wrong in both directions.
        `useApprovals` now carries `loading` and `error` (over the enabled queues only, since a disabled one
        never reads and a 403 is isolated into an empty collection rather than a failure).
      - **Notifications** did the same, and rendered its snoozed-list wait as an `<EmptyState title="Loading…">`
        - a dashed box and a "nothing here" illustration, for something that was on its way. The feed's
        `state` is now on the context; the page shows the list's shape while it arrives and a retryable panel
        when it fails.
      - **Bank formats** answered *"No banks yet"* to a server it could not reach, and for the whole of its
        first read. It now has a `loaded` flag and a retryable error panel; the toast it relied on says it
        once, four seconds, and then the wrong sentence is all that is left.
      - **The leave calendar** drew an empty month for a failed read - which is the wrong answer to "is anyone
        off next week", and the one people plan around.
- [x] Gate: a page that renders an `EmptyState` must carry a load discriminator (or hand one down - passing
      `state={…}` to the component that renders the list counts). Components are exempt: a presentational one
      is handed its rows and its parent owns the states.
- [x] The loading-text gate now also catches a wait handed to a component as a `title` - which is how the
      notifications one had hidden from it.
- [x] **Wide screens, revisited.** Of the 55 grids that never exceed two columns, 53 are form-field pairs,
      where two is the right measure and widening hurts. The two that were not are charts and status cards;
      Operations' cron cards take a third column from `xl` rather than leaving half a 1440px screen empty.

## Pass 8 - opening the app

Every pass before this one was static: reasoning, the typechecker, and two source scanners. That can prove a
rule holds in the code and cannot tell you what a page looks like. So this pass drove the real app -
`scripts/start.sh`, the built SPA served by the worker - through **42 routes × 6 viewports = 252 renders** in
headless Chrome, screenshotting each and, more usefully, *measuring* each: `scripts/uiShots.mjs`.

The measurements are the things a source scan cannot answer - does the page actually scroll sideways, how
big is this control after the whole cascade resolved, is any text clipped, is any control off screen, did
the console throw. It opened at **1900 undersized targets, 51 elements past the right edge, 5 pages
scrolling sideways**; it closes at **0**, with the same harness re-run to prove each fix rather than assert it.

Calibrating the harness mattered as much as running it: `(pointer: coarse)` had to be confirmed active
(otherwise every touch measurement is of the desktop rendering), the touch floor had to be applied only on
coarse pointers (a cursor's dense design is not a defect), and the closed off-canvas drawer, `sr-only` spans,
declared scrollers and deliberate line-clamps all had to be excluded as off screen *on purpose*.

What running it found that four passes of source analysis had not:

- [x] **The org chart opened at 50% zoom for every first-time reader.** `Number(localStorage.getItem(…))` is
      `0` when nothing is stored, and `0` is a valid zoom index - the smallest one. The range check passed and
      the chart came up half-size. Only visible in a fresh browser profile, where "nothing stored" is normal.
- [x] **Every tab rendered through `AccessTab` was 28px tall** next to a plain sibling at 36px. A segmented
      `TabsTrigger` sizes with `h-full`, and the access wrapper it sits in shrank to its own text, so "full"
      meant the wrapper rather than the tab track. Visibly uneven, and under the touch floor.
- [x] **The goals grid was 494px wide inside a 360px screen.** A grid item's automatic minimum size is its
      min-content width - the rule the docs already state for flex (#16) holds for grid tracks too - and
      `AccessItem`'s positioning wrapper was the item. It carries `min-w-0` now, app-wide.
- [x] **The leave calendar took the page sideways** because `grid` with no explicit `grid-cols-1` leaves a
      single `auto` track, which sizes toward max-content. Tailwind's `grid-cols-1` is `minmax(0,1fr)`, and
      that `minmax(0,…)` is the cap.
- [x] **`PageHeader`'s action cluster could not wrap**: `shrink-0` and `flex-wrap` cancel out - wrapping needs
      the container to be offered less width, and `shrink-0` promises it never will be. A three-action header
      ran 25px off a 768px tablet. The header row now wraps as a unit, so the cluster drops to its own line
      instead of becoming a ragged stack beside a squeezed title.
- [x] **The feed's post actions were drawn on top of the author's name.** With no hover on a phone all five
      are visible at once - ~250px of buttons in a card corner that also holds the author. They take their
      own row below `sm` now.
- [x] **The team timeline's header broke mid-phrase** ("Team" over "timeline") with the month arrows sliding
      under it, and prev/Today/next split across two lines. Title and controls take separate lines on a phone,
      and the three-part control wraps as one.
- [x] **~90 controls sat under the app's own 36px floor** - filter chips at 26px, an author link at 16px, a
      `Button size="sm"` at 32px, the goal progress slider at **6px**. The floor is now stated once in
      `index.css` for anything that is a control (safe to apply broadly: `min-height` is a no-op on an inline
      box, so prose links keep their line height, and it is a floor, so nothing already larger moves).
      Controls inside a table cell keep their size - inflating them pushes columns off screen - and get a
      `::after` hit area instead, so what a fingertip lands on grows while the layout does not.
- [x] Goal cards give the title the full width on a phone rather than truncating it to two words beside a
      permanently-visible action cluster.

## Checked and deliberately unchanged

- **Wide screens.** The `sm:grid-cols-2` grids that stop at two are form-field pairs, where two is the right
  measure; the real card grids already step at `lg` / `xl`. Every chart is `viewBox` + `w-full`.
- **Dialogs.** The footer-pinning gate's "5 or more fields" heuristic misses dialogs whose length comes from a
  *list* rather than fields - and each of those (the permission matrix, the ACL modal, the illustration
  picker, the activity feed, the bulk-add list) carries its own bounded inner scroller already.
- **Busy states.** `Button` has `loading`, `WriteDialog` owns it for every write that goes through it, and
  `DataTable`'s bulk actions use it. Coverage is real, not nominal.
- **Field-level `aria-invalid`.** Used once in the app, which looks like a gap and is not: validation here is
  server-side and surfaces through `FormError` (form-level, focus-taking) plus `WriteDialog`'s `canSubmit` /
  `whyNot` blockers. Marking fields invalid would mean inventing client-side validation to have something to
  mark, which is a different piece of work with a different argument behind it.

## Verification

`./node_modules/.bin/tsc -p web/tsconfig.json --noEmit` and the worker's `tsconfig.json` (both exit 0),
`npm run build`, and the full suite (1920 tests) pass, with `test/responsiveCoverage.test.ts` at 24 checks and
`node scripts/uiAudit.mjs` reporting 0 open findings over all 247 surfaces.

And the app was opened: `node scripts/uiShots.mjs` against the local stack renders and measures all 42 routes
at 360, 390, 844×390 (landscape), 768, 1024 and 1440 - **252 renders, 0 findings**, screenshots under
`tmp/shots/<viewport>/<route>.png`. Six of the defects above were found only that way, and each fix was
re-measured rather than assumed.

Two things worth knowing before re-running it:

- Point it at **the worker (`:8787`)**, which serves the built SPA - not vite on `:5173`. Vite proxies `/v1`
  to Prism, and Prism's own upstream fetch hits the undici framing bug this repo already documents
  (`Premature close` → a 500 → the SPA renders "Can't reach the server"). Through the worker there is no proxy
  in the path, and it is the production asset lane anyway.
- A `npm run build` while `wrangler dev` is serving can take the worker down. If a run reports findings on
  *every* route, screenshot one and check it is not Chrome's error page before believing it - that happened
  here, and a "verified" fix turned out to be measured against `ERR_CONNECTION_REFUSED`.

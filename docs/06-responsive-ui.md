# 06 — Responsive & touch UI

How the web app behaves across screen sizes and input devices, and the conventions any new UI follows.
Palette and design language live in `web/src/index.css`; this document is about geometry and input.

## Breakpoints and what changes at each

| Width | Sidebar | Primary nav | Tables | Dialogs |
|---|---|---|---|---|
| `<640` (phone) | off-canvas drawer | bottom bar (`layout/BottomNav`) | cards | bottom sheet |
| `640-767` | off-canvas drawer | bottom bar | table | centred panel |
| `768-1023` (`md`) | docked icon rail | sidebar | table | centred panel |
| `>=1024` (`lg`) | docked, full | sidebar | table | centred panel |

Two non-width conditions matter as much as the widths, and are available as Tailwind variants
(`web/tailwind.config.js`):

- `coarse:` — `(pointer: coarse)`. A finger, not a cursor. This, not a width, is what decides whether a
  control needs a 44px target: a touch laptop at 1440px still needs one, and a 380px browser window on a
  desktop does not.
- `standalone:` — `(display-mode: standalone)`. Installed as a PWA there is no browser chrome, so the app
  paints under the status bar and reserves the inset itself.
- `short:` — `(max-height: 480px)`. A phone held sideways. Fixed chrome that costs 12% of a portrait screen
  costs a third of this one, so some of it goes label-less rather than away.

Plus `pb-safe` / `pt-safe-t` spacing steps for the device safe areas (zero on a device with no notch).

## Rules

1. **Never put a control under 44px on touch.** Use `coarse:` to grow the target, not the design: a 16px
   checkbox keeps its size and gains an invisible `::before` hit area; an icon button keeps its glyph and
   grows its box. `Button`'s `default`/`lg`/`icon` sizes already do this; `sm` is the deliberately dense
   variant and does not.
   Two floors are applied centrally in `index.css` rather than per call site, both selected by the utility
   class the author wrote: a small square icon control (`h-6 w-6` / `h-7 w-7` on a button, link or
   `role="button"`) grows its box to 36px on touch, and Radix menu/option rows get 44px. Writing those
   classes is still correct - the floor comes for free.
2. **No control may be hover-only.** `opacity-0 group-hover:opacity-100` is fine to write - `index.css`
   forces those visible on coarse pointers, since on touch the control would otherwise be invisible but
   still occupy its box. Named group variants (`group-hover/col:`) are excluded and are for cursor-only
   gestures (drag, resize) only.
3. **Form controls are 16px on a phone.** Below that, iOS Safari zooms the page on focus and leaves it
   zoomed. Enforced globally in `index.css`; state it locally only for an input that is focused on mount.
4. **Anything docked to the bottom of a phone screen must clear two things**: the bottom nav
   (`calc(4.75rem + env(safe-area-inset-bottom))`) and the on-screen keyboard (`useKeyboardInset`).
   Grep for `bottom-` before adding a fixed element.
5. **A row of more than ~3 fixed columns does not fit a phone.** Either fold the context columns away
   (`hidden sm:table-cell`, with their content re-appearing as a sub-line) or stack the row and let each
   control label itself - the header row is usually hidden at that width, so an unlabelled checkbox becomes
   a guess.
6. **A horizontally scrolling strip needs an affordance, and its items need `shrink-0`.** `scroll-shadow-x`
   (CSS-only, no scroll handler) shades whichever edge still has content past it. Pass
   `[--scroll-ground:hsl(var(--card))]` when the strip sits on a card rather than the page. Filter chips
   scroll as one row on a phone and wrap from `sm` up.
   The `shrink-0` half is what makes the strip scroll at all: a flex item's default is `flex-shrink: 1`, so
   without it the items are squeezed narrower than their content before the box ever overflows - and a
   `whitespace-nowrap` label in a squeezed box cannot reflow, so it paints outside its own border and over
   the item beside it. That is a tab bar reading "Org chOnboarding", not a tab bar that scrolls. State it on
   the item (and on any wrapper between the item and the strip); the strip itself cannot fix it. A child that
   is *meant* to shrink says `truncate`/`min-w-0` instead, and then the ellipsis is the intended outcome.
7. **Kanban-style columns snap one per swipe on a phone** (`snap-x snap-mandatory` + `snap-start`, off from
   `sm`) and are `86vw` wide, so a column nearly fills the screen with a sliver of the next one showing.
8. **Footer action order.** `DialogFooter` is a reversed column on a phone: the primary action sits at the
   top of the stack and Cancel at the bottom edge, which is the action-sheet convention - the spot a thumb
   rests on should hold the harmless action. A footer with a third slot (a delete on the left) must send it
   to the far end with `order-last sm:order-none`, or being first in the markup lands it at the bottom edge.
9. **A dialog that overrides its own height must scope that to `sm` and up** (`sm:max-h-[85vh]`), or it
   overrides the shared phone geometry and puts its own footer behind the keyboard.
10. **The mobile drawer is a modal surface**: focus moves into it, Escape closes it, the body does not
    scroll, the page behind it is `inert`, and it is `inert` itself when closed (otherwise Tab walks
    invisibly through forty off-canvas nav links).
11. **A dialog long enough to scroll scrolls its BODY, not its panel.** `<DialogContent scrollBody>` with the
    fields inside `<DialogBody>` keeps the title and the actions still while the fields move between them.
    Without it the footer scrolls away with everything else, and on a phone the Save button of a twelve-field
    form sits below the fold of its own dialog. If the form element has to wrap the fields, end it before the
    footer and reach the submit button with `form="<id>"` rather than by nesting.
12. **A search box is typed `type="search"`.** `ui/input.tsx` derives the rest from that: no autocapitalise, no
    autocorrect, no spellcheck, and a Search key instead of Return. A plain text input turns the surname you
    are looking for into a word the phone knows better.
13. **Which keyboard opens is decided in `ui/input.tsx`, not at the call site.** `type="number"` gets
    `inputMode="decimal"` (and stops the scroll wheel silently editing a focused field); a field that wants
    the integer pad passes `inputMode="numeric"` itself; a phone number is `type="tel" inputMode="tel"`.
    Autofill (`autoComplete`) is deliberately NOT applied by default: most forms here record someone else's
    details, and filling the signed-in admin's own name into an employee record is worse than no autofill.
14. **An icon-only control is named.** `aria-label`, `title`, `aria-labelledby` or an `sr-only` span - a
    button whose only content is an `aria-hidden` glyph is announced as "button" and nothing else.
15. **A metric row is split into balanced rows, and every row fills the width.** Any tile row whose length is
    data - `SummaryStrip`, the dashboard KPI wall, My-day - goes through `StatRow` /
    `web/src/lib/statRows.ts`: the count is split as evenly as the row cap allows (seven tiles are 4+3, nine
    are 3+3+3) and each row is stretched, so there is never a hole where a fourth tile should be. Two
    consequences worth knowing:

    - **The cap comes from the container, not the viewport.** `.stat-row` is a CSS container
      (`container-type: inline-size`) and the rungs are container widths (`STAT_ROW_LADDER`: 0, 480, 720,
      1000, 1240). A page sits beside a 16rem sidebar and the same row is also used inside sheets and
      half-width panels; a `sm:`/`lg:` rule sizes cells against room they do not have. This is the one place
      in the app where a container query is the right tool rather than a breakpoint.
    - **Two across on a phone, still.** The narrowest rung is 2 for strips and cards (1 for a tile with lines
      of content in it): one per row puts a screen of numbers between the reader and the list the page is
      about. A tile at that width truncates its label and value rather than wrapping them.

    A fixed count that already divides its columns (four stat cards in `grid-cols-2 sm:grid-cols-4`) can stay
    an ordinary grid. Card *galleries* - the directory's people, the illustration picker - must NOT use this:
    there the cell size is the point, and a short last row correctly reads as "the list ended".

16. **A flex item is only as narrow as its content lets it be.** This is the single most common source of a
    page that scrolls sideways, and it is not obvious from the class list, so it is worth stating exactly:
    a flex item's *automatic minimum size* is its **min-content width**, not zero - unless its computed
    `overflow` is something other than `visible`, in which case it is zero. Three consequences:

    - `truncate` on a **direct** flex child works on its own, because `truncate` sets `overflow: hidden`.
    - `flex-1` on a **wrapper** around a truncating child does **not**. The wrapper's overflow is visible, so
      its floor is the full unwrapped string; it is never offered less room than the label wants, the
      truncate inside it never fires, and the row grows instead. `min-w-0` on the wrapper is the fix.
    - An `<input>`/`<textarea>`/select trigger has an intrinsic width (~170px from `size`/`cols`, or the
      widest option label), which becomes that floor. `ui/input.tsx`, `ui/textarea.tsx`, `ui/select.tsx` and
      `ui/combobox.tsx` therefore carry `min-w-0` in the primitive - do not remove it, and do not re-state it
      at the call site.

17. **The editor row.** Settings and the workflow/board/template editors all build the same shape: a name
    field, one or two narrow fields, a couple of icon buttons. On a phone the *stated* widths alone exceed
    the 328px of content column a 360px screen has. Use `.editor-row` on the row and `.editor-row-main` on
    its flexible field (both in `index.css`): the row may wrap, and the main field takes a line of its own
    below `sm`. Wrapping alone is not enough - a `flex-1` field has `flex-basis: 0`, and flex line-breaking
    reads the basis, so a zero-basis field never triggers the break it needs.

18. **A table stacks on a phone; it does not scroll sideways.** A scroll box stops a wide table breaking the
    page, but it does not make the table readable: the reader gets two of six columns, a gesture nobody
    performs, and headings that scroll away from the values they label. A hand-written `<table>` therefore
    carries `.table-stack` (`index.css`): below `sm` the rows become labelled blocks, and from `sm` up the
    table is exactly as it was. Each `<td>` states its own heading with `data-label` - without it the stacked
    form is a column of bare values, since the `thead` that carried the headings is no longer on screen. The
    cells that legitimately have no label are the ones that have no heading either: the row title, an action
    cluster, a `colSpan` note. A caller keeping a `min-w-[…]` for the table form must scope it to `sm:`, or
    the min-width is still a floor once the table is `display: block`.

    The exceptions are the surfaces where the grid IS the content, and which scroll for the same reason a
    kanban board does: a role × collection permission matrix, a roster of people × days, a scope × months
    heat-map. `DataTable` needs none of this - it already renders cards below `sm`.

19. **Nothing may be wider than the viewport except a declared scroller.** `html { overflow-x: clip }` in
    `index.css` is a backstop, not a licence: it stops one bad box making the whole document scroll sideways
    (which detaches the top bar from the content and leaves a strip of bare background down every page), and
    `clip` rather than `hidden` because `hidden` would make `html` a scroll container and break every
    `position: sticky` descendant. Content past the edge is *unreachable* rather than merely off screen, so
    anything that genuinely wants to be wide still needs its own `overflow-x-auto` box and rule 6's
    affordance. `body { overflow-wrap: break-word }` covers the other half: a long unbroken string - an
    email, a wire id, a pasted URL - is one unbreakable box that sets the min-content width of every
    ancestor above it.

20. **A wait is a layout, not a sentence.** A centred "Loading…" collapses its container to two lines and then
    snaps to full height when the data lands: on a phone the reader loses the panel they just opened, and on a
    slow connection the screen reads as empty rather than as busy. `components/common/Skeletons.tsx` holds a
    shape for each thing this app waits for — `FormSkeleton` (a dialog's fields), `DetailSkeleton` (a
    label/value list), `TableSkeleton` (mirrors `.table-stack`: labelled blocks below `sm`, columns above),
    `RowsSkeleton` (a divided list of toggles), `CardsSkeleton` (a feed), `TilesSkeleton` (a picker grid),
    `StatsSkeleton` (a metric band), `PageSkeleton` (a document page), `PanelSkeleton` (a lazy settings panel).
    `DataState` picks the default one — a toolbar over a table — and is what a list page should wrap.
    "Loading **more**" is the exception and stays a spinner: the content and its geometry are already there,
    and what is being reported is progress appending to them.

21. **A tooltip whose text exists nowhere else needs `tapToOpen`.** A Radix tooltip is a hover surface, and a
    touch is not hover — Radix treats `pointerdown` as a dismissal, so on a phone tapping the trigger is the
    one gesture guaranteed *not* to show it. That is correct where the tooltip repeats a button's own label
    (the tap must run the action, not explain it). It is wrong where the trigger is inert and the tooltip is
    the only copy of something: an icon standing for a sentence, a relative time standing for a timestamp, a
    bar standing for its numbers, a legend, every `InfoHint`. `<Tooltip tapToOpen>` renders that case as a
    tap-driven popover on a coarse pointer (`components/ui/tooltip.tsx`), same content and placement, and does
    not move focus into it. The exception is an inert trigger inside something that *is* clickable — a chip on
    a kanban tile — where the tap belongs to the parent and the parent's own detail view says the same thing.

22. **A page's sticky element clears the app bar: `sticky top-16`.** The bar is `sticky top-0`, `h-14`, z-30,
    so anything pinned to the page at a smaller offset does not stay on screen — it parks behind the bar and
    disappears at exactly the moment pinning was for. A small offset (`top-0`) is right only inside a scroll
    box of its own: a `<thead>` in a bounded table container, a heading inside a `max-h` list, a sheet header
    above its own body. And note the corollary for those: **`position: sticky` pins inside the nearest
    *scrolling* ancestor, and a scroll box with no height ceiling never scrolls** — it just grows. A sticky
    header inside an unbounded `overflow-auto` div is inert, which is what the payroll run review's headings
    were until the container was given a `sm:max-h`.

23. **A zero state carries the action, and says which kind of empty it is.** Nothing-created-yet and
    filtered-to-nothing are different states with different recoveries: the first wants the page's create
    control (`DataTable`'s `emptyAction`), the second wants a way back out of the filter, which `DataTable`
    renders itself whenever a filter or a search is what emptied the table. Describing the action in prose
    while the button itself is a header away is the worst of both — on a phone that header is several screens
    up. `emptyAction` is suppressed automatically in the filtered case, so a page passes it unconditionally.

24. **A click handler on a `<div>` is a control only a pointer can reach.** Touch is fine with it; a keyboard
    is not — no tab stop, Enter and Space do nothing, and a screen reader announces a group of text. Prefer a
    real `<button>` (nothing inside it may be interactive). Where the element has to stay a `<div>` or a `<tr>`
    — a table row cannot become a button without losing its row semantics — it needs `tabIndex={0}`, an
    Enter/Space `onKeyDown` guarded with `e.target === e.currentTarget` so nested controls keep their own keys,
    and a `role` or `aria-expanded` saying what it is. The exceptions are coordinate surfaces (click-to-place
    on a rendered PDF, the sticker sheet's slot grid, both of which have their own non-pointer path) and the
    drawer scrim, which is deliberately not a tab stop.

25. **Empty, unarrived and failed are three different states that look identical from the data** — all three
    are zero rows. A surface that renders a zero state without being able to tell them apart therefore asserts
    the most confident of the three, and it is the one most likely to be wrong: the approvals inbox said
    "You're all caught up" before a single queue had been read *and* when a queue's read had failed. A page
    that shows an `EmptyState` must carry a load discriminator, or hand one down (`state={…}` into the
    component that renders the list). Where the rows come from a context rather than `useCollection`, the
    context has to expose the state — `useApprovals` carries `loading` and `error`, `useNotifications` carries
    `state`. A presentational component is exempt: it is handed its rows and its parent owns the states.

26. **The 36px floor is central; a table cell gets a hit area instead.** `index.css` states the floor once for
    anything that is a control (`button`, `[role="button"]`, `a[href]`, form controls) on a coarse pointer.
    Applying it that broadly is safe for three reasons worth knowing: `min-height` is a no-op on a non-replaced
    *inline* box, so a link inside a paragraph keeps its line height and only block-ish controls grow; it is a
    floor, so everything already larger is untouched; and it is `pointer: coarse` only, so the dense cursor
    design is exactly as it was. Two carve-outs: a control **inside a `<td>`/`<th>`** keeps its size — growing
    every control in a data grid pushes its columns off screen — and gets an invisible `::after` hit area
    instead, so the target grows while the layout does not; and `input[type="range"]`, whose *visible* size is
    meant to be a few pixels, grows its control box while its track is styled thin (a 6px slider is a 6px drag
    target). Writing `h-7 w-7` on a small icon button is still right — the floor arrives on its own.

27. **A box nobody can see still has a width.** `sr-only` hides a box by shrinking it to 1px and clipping it,
    and a `<table>` is the one element that refuses the first half: a table cannot be laid out narrower than
    its own min-content, whatever `width` says. `Chart`'s accessible data table — the chart's numbers for a
    reader who cannot see the SVG — was therefore a ~480px invisible box on every page that draws a chart, and
    it widened the document by up to 120px with nothing to look at in it. The class goes on a wrapping `<div>`,
    which does take the 1px and whose own `overflow: hidden` then contains the table.

    Two things this made clear, both worth carrying:

    - **`overflow-x: clip` on `html` does not make an over-wide box harmless, it makes it silent.** On a
      desktop browser the page stops scrolling sideways and `scrollWidth` quietly stays inflated; on a phone
      the *layout viewport* widens to the content anyway, and everything measured against it widens too. The
      bottom nav stretched to 480px on a 360px screen and pushed its own last tab off the edge, which is what
      "the page is wider than the screen" looks like from the outside — with nothing visible anywhere near the
      right edge to blame for it.
    - **A source scan cannot find this and a desktop browser barely can.** It took `scripts/uiShots.mjs`
      measuring `document.scrollingElement.scrollWidth` at a phone viewport. The gate that keeps it from coming
      back (`sr-only` is never on a `<table>`) was written after the measurement, not instead of it.

## Platform behaviour the shell owns

These are app-wide and already wired; a page neither implements nor opts into them.

- **Safe areas.** `viewport-fit=cover` (in `web/index.html`) is what makes `env(safe-area-inset-*)` report a
  real number - without it iOS letterboxes the app and every inset in the codebase reads 0. Because the app
  paints edge to edge, the shell reserves the insets: `[data-app-shell]` pads the two side insets (the
  landscape notch) for everything in the normal flow, and anything `fixed` carries its own `pl-safe-l` /
  `pr-safe-r` (bottom nav, drawer, toasts, sheets, dialogs).
- **Scroll position** (`router.ts`). A new destination starts at the top; Back returns to where you were. The
  two are told apart by the fact that a programmatic hash write fires `hashchange` only, while back/forward
  fires `popstate` first. Restoration re-asserts itself per frame until the page is tall enough to hold the
  position, and abandons at the first real scroll input.
- **Route announcement** (`App.tsx`). Each navigation sets the document title, moves focus to `<main>`, and
  names the page in a polite live region.
- **Pull to refresh** (`hooks/usePullToRefresh.ts`). Touch only, from the top of the page, not inside a modal
  or a scroller of its own. Refresh means `resourceStore.refetchMounted()` - re-read what is on screen.
- **Offline** (`components/layout/OfflineBar.tsx`). A bar under the app bar while the connection is down, and
  a re-read of everything mounted when it returns. A fetch that never reached a server throws a named
  `ApiError` with `status: 0` rather than surfacing "Failed to fetch" as the explanation.

## Where the shared pieces live

- `components/layout/BottomNav.tsx` — the phone's primary nav: Home, a role-adaptive second slot, a raised
  create button, Alerts, Menu. Hidden from `md` up. Hides itself while the keyboard is open. The create menu
  leads with "On this page" — the quick actions whose route is the current one — because the page's own create
  button lives in the header, which is several screens up as soon as the list is scrolled. Promoted, not
  duplicated: an action shown there is removed from the group it would otherwise repeat in.
- `hooks/useKeyboardInset.ts` — how much of the screen the on-screen keyboard covers. The single source for
  dialogs, sheets, the command palette and the bottom nav.
- `hooks/useScrollActiveIntoView.ts` — keeps the active item of a scrolling tab/chip bar in view.
- `components/ui/sheet.tsx` — bottom sheet with a grabber and drag-to-dismiss on a phone, right-docked panel
  from `sm` up.
- `components/common/DataTable.tsx` — table from `sm` up, cards below it, with a "Sort & filter" sheet
  standing in for the column headers that cards do not have.
- `components/ui/table.tsx` — the scroll container every `<Table>` renders inside. It carries
  `scroll-shadow-x` itself, so a wide table advertises its own overflow without the caller doing anything.
- `.editor-row` / `.editor-row-main` (`index.css`) — the wrapping control row described in rule 17.
- `.table-stack` (`index.css`) — the hand-written table that becomes labelled rows below `sm` (rule 18).
- `components/common/Skeletons.tsx` — the shapes the app waits in (rule 20), and `components/common/DataState.tsx`
  — the wrapper that picks the default one and turns a failed read into a retryable panel.
- `components/common/PageHeader.tsx` — title, description and action slot. The description clamps to two lines
  below `sm` with a More/Less toggle: at full width it costs one line, and on a phone the longest of them ran
  to four lines of a screen already carrying a title, a metric strip and a toolbar before any content.

## Checking a change

`test/responsiveCoverage.test.ts` gates the rules above that can be checked mechanically, over every `.tsx`
under `web/src`: a raw `<table>` outside a scroll container, a hand-written table that neither stacks nor is
an allowlisted matrix, a stacking table whose cells carry no `data-label`, a grid template with 3+ fixed
tracks and no breakpoint, a comma-separated (silently invalid) grid template, a dialog overriding its own height, a
bottom-docked element that does not clear the phone nav, a missing touch variant in the Tailwind config, a
per-site re-implementation of the hover-reveal workaround, a missing `viewport-fit=cover` (which would zero
every safe-area inset in the app), an icon-only button with no accessible name, a long dialog whose footer is
not pinned, a search box not typed as one, a wait rendered as the word "Loading" instead of a skeleton
(rule 20), a tooltip on an inert trigger that a tap cannot open (rule 21), and a page-level sticky element
that does not clear the app bar (rule 22), a page that shows a zero state without being able to tell empty
from loading (rule 25), and a clickable element with no keyboard route (rule 24 — this one
reads JSX opening tags with brace awareness, since an arrow function in an attribute contains the `>` a regex
would take for the end of the tag). Add an allowlist entry only with a stated reason.

A second suite in the same file (`responsive coverage (rows)`) checks the two rules that are about a
*relationship* rather than one element - a non-wrapping row whose children's own stated widths already
exceed a phone (rule 17), and a `flex-1` wrapper that blocks the truncate inside it (rule 16) - plus the
`min-w-0` floor in the four form primitives, a `TabsList` overridden into a fixed grid (which throws away
the scrolling strip the primitive gives it), a horizontal scroller with no `scroll-shadow-x` (rule 6), and a
`whitespace-nowrap` element inside a horizontal scroller that neither refuses to shrink nor asks to (also
rule 6 - this one reads the strip's whole subtree, because the item is often built in a `const` inside a
`.map()` rather than written as a child, and it excuses an element that has a `shrink-0` wrapper between it
and the strip).
Those two relationship checks read the file as indented lines rather than as a parse tree: the obvious tool
is the TypeScript parser and it cannot be used, because this suite runs in the Cloudflare workers pool where
`typescript` fails to load (it wants `node:os`). Lines are sound here because the front end is
Prettier-formatted at a fixed two-space step - and the cost is stated plainly in the file: an element whose
`className` sits on a different line from its tag is not counted, so both checks under-report.

Alongside the gate there is a **report**: `node scripts/uiAudit.mjs` walks every `.tsx` under `web/src` and
answers, per surface, whether it says anything about a phone (and if not, whether it writes any layout that
would need to), whether it says anything about a wide screen, and whether a page carries all three of the
states above. It is not a gate because most of its questions need a person; it exists so a sweep has an order
rather than a hunch, and so "nothing to do on this surface" is a claim someone made rather than one nobody
checked. Findings that have been argued about live in its `ACCEPTED` map with the reason, the same convention
the gate's allowlists use. `--verbose` adds the layout rows it judged safe.

And then there is **the app itself**: `node scripts/uiShots.mjs` (needs `scripts/start.sh` and puppeteer-core)
drives the built SPA through every route at 360, 390, 844×390, 768, 1024 and 1440, screenshots each into
`tmp/shots/<viewport>/<route>.png`, and measures what a source scan cannot — whether the page really scrolls
sideways, how big a control is once the whole cascade has resolved, whether text is clipped, whether a control
is off screen, whether the console threw. That is the only way most of the defects in rule 20–26 territory
were found, and each fix was re-measured with it rather than reasoned about.

Two things it is easy to get wrong when running it:

- Point it at the **worker on `:8787`** (`UI_BASE=http://localhost:8787`), which serves the built SPA. Through
  vite on `:5173` the `/v1` calls go via Prism, whose upstream fetch hits the undici `Premature close` bug and
  returns 500s, so every page renders "Can't reach the server".
- Confirm `matchMedia("(pointer: coarse)")` is true for the phone/tablet viewports, or every touch measurement
  is of the desktop rendering. And the touch floor must only be *asserted* on coarse pointers: with a cursor a
  28px row action is the deliberate dense design, not a defect.

On a real device, where neither of those can run, there is `web/src/lib/overflowProbe.ts`: dev builds only and
off unless a URL asks for it (`?overflow=1`, `?overflow=0` to stop). It applies the same rules as the sweep —
excusing declared scrollers, fixed chrome and `sr-only` boxes, reporting the deepest offenders rather than the
ancestors they widen — and prints to the console plus a readout in the corner, because a phone has no console
to open. `window.overflowProbe()` re-measures on demand.

Typecheck with `./node_modules/.bin/tsc -p web/tsconfig.json --noEmit` and check `$?` — run the binary
directly, since a shell hook filters `npx tsc` output and has reported "no errors" over real failures.

Those two are the automated gate. They cannot see whether a layout actually *reads* well, so the remaining
step is a human one: open the change at 360px, 390px, 768px and 1440px, and at 844x390 (phone in landscape).

# Global search: what it becomes

The search started as a modal command palette: a box, a grouped list, filter words for the people who knew
them. It is now the field in the middle of the top bar, and this plan is the rest of the way from "a box you
type into" to "the fastest way to anything in the app" - for the person who knows the filter words and for the
one who never will.

Written 2026-10-04. Items are ordered by value for the effort, not by dependency; each one stands alone.

## What is already built (not restated below)

- **Two shells, one search.** `usePaletteSearch` (web/src/components/layout/CommandPalette.tsx) is the whole
  search: query, filters, server search, frecency, Tab actions, Ask. `InlineSearch` draws it as the top bar
  field with a drop-down; `CommandPalette` draws it as the modal (phones, bars too narrow for the field).
  ⌘K focuses the field when it is on screen and opens the modal when it is not.
- **The field in the bar.** Centred between the breadcrumb and the clock; both have fixed widths (the
  breadcrumb's is the measured mean, 240px; the clock's slot is reserved from the first frame), so the field
  never moves between pages or on punching in. Placeholder "Search people, docs, tasks and more", falling to
  "Search…" and then to a compact ⌘K button as the room narrows (container queries, measured thresholds).
- **Open, it grows about its own centre** to 64rem (`useOpenSearchFit`, TopBar.tsx) - room for the results and
  a 24rem preview pane side by side. Inside the room nothing
  else moves; past it, the breadcrumb and the cluster fade out together.
- **Category chips.** All · People · Pages · Time · Work · Docs · Money · Hiring · Support, fixed order, only
  the ones the caller can search, greyed at zero, counted against the unscoped answer. A record category
  narrows the SERVER request (`in=` its tone's collections; the route takes up to 64). A typed `in:` wins.
- **Filters menu.** Whose (Anyone / Mine / My team), Created (any / 7 / 30 days / 12 months), Order (best match
  / newest first), and the full filter-word guide.
- **Completion chips.** While the caret is in a filter word the chip row becomes what can come after it - kinds
  after `in:`, statuses after `status:`, people after `@` - in plain words. Tab / Enter take the lit one, → and
  ← walk them, ↓ goes to the list. The half-typed word is left out of the search, so the list stays useful.
  The `?` / `-` guide stays in the list as rows.
- **`in:` kinds ranked, with counts.** Every kind is offered (no longer the first 8 alphabetically), biggest
  first: with other words in the box, by how many of their results are of that kind (free - the loaded answer);
  with none, by how many records of that kind the caller can search at all, from `GET /v1/search:counts` -
  one grouped read of `search_counts`, the index pre-counted by triggers (migration 0010) under the same scope
  predicate the search binds, instead of counting `search_docs` itself (measured: 95 rows visited vs 368 on the
  dev data, the gap growing with record volume). Ties go to the kinds this person opens most.
  Suggestions write a kind under its shown name (`in:tasks`, not `in:cards`; `inWordOf`).
- **Pills.** Every filter in force - typed or from the menu - as a pill that says what it means, with × and
  Clear all. Removing a typed one edits the box.
- **No dead ends.** Narrowed to nothing, the list offers `Search everything for "…"`, saying what it lets go.
- **Small things.** ↑ in the empty box recalls the last search; ⌘/Ctrl-click and middle-click open a result in a
  new tab; "Clear recent searches"; chip rows fade at an edge with more out of view.
- **Tests.** e2e/search.spec.ts (incl. completion, pills, widen, recall, new tab, crowded open), searchScope,
  paletteRecent, wide.spec.ts (centring, punch, page change, roomy open). Helpers `searchBox` / `searchPanel`
  in e2e/fixtures.ts find the search in either shell.

---

## 1. Filter words styled inside the box - DONE 2026-10-04

Built as below: `QueryHighlight` + `filterWordProblem` in CommandPalette.tsx, in both shells; the pill of a word
that names nothing turns destructive with the reason as its title. Not done: IME composition was not tested by
hand. Tests: search.spec.ts "filter words are styled in the box..." (drawn text width and a mid-query pill's
start within 1px of the input's own text, the bad word flagged and the good ones not) and phone.spec.ts (the
modal's box lines up too).

**Problem.** The pills under the chip row say what the filters mean, but the box itself is a flat string:
`in:leave status:pending @priya laptop` reads as one run of text, and a filter that names nothing (`in:leeve`,
`@nobody`) looks exactly like one that works - the person finds out from an empty list.

**What it does.** Each filter word in the box is drawn as a soft pill in place - the key (`in:`) muted, the
value in the primary colour - and a word that names nothing gets a wavy underline in the destructive colour,
with the reason on hover in its pill below ("No kind of record is called leeve"). Plain words stay plain.

**How.**
- A highlight layer behind the input: the same text, in the same font, size, padding and letter spacing,
  split into runs (plain / filter key / filter value / invalid). The input's own text is transparent; its
  caret and selection stay visible. Pills get their shape from a `box-shadow` spread and a radius, never from
  padding or weight, so not one glyph moves and the caret stays exactly on the letters.
- The layer follows the input's horizontal scroll (`scrollLeft` on scroll, input and selection change), so a
  query longer than the box stays aligned.
- Runs come from the same tokenizer as the pills (`typedFilterWords`), and validity from the server's own
  readings: `in:` via `collectionsNamedBy` against the caller's kinds, `@` via `resolvePerson`, `is:` mine/team,
  `status:` against the vocabulary once loaded, dates via `resolveDay` / the `on:` / `during:` spans. Unknown
  stays neutral rather than red while a vocabulary is still loading.
- One component (`QueryHighlight`) used by both shells; `aria-hidden`, since the input is what is read.
- The word being completed is drawn plain: it is not a filter yet.

**Done when.** Both shells draw filter words as pills and invalid ones underlined; the caret sits on the
right letter at every position, including after a long query scrolls; selection and IME composition work;
e2e covers an invalid `in:` getting the underline and its pill reason, and a valid one not.

## 2. Preview of the highlighted result - DONE 2026-10-04

Built: `PalettePreview` (CommandPalette.tsx) + `previewOf` (web/src/lib/searchPreview.ts, unit-tested in
test/searchPreview.test.ts). A 24rem pane in a relaxed layout (heading, two-column facts, the text at body size under
"Details", the actions in a fixed footer), shown beside the results when the field's drop-down is at least 52rem
wide - the open field grows to 64rem for it, and reaches about 53rem on a 1440 screen with the full sidebar.
Measured by InlineSearch, and the same answer gates the reads, so nothing is read for a pane that is not shown. One
deviation from the design below: NOT in the modal, which stays a single column (max-w-xl) - the modal is the
narrow-screen search, where a side pane would leave the list no room. Reads go through a per-opening record cache
in the hook (`records`), not lib/resourceStore, which is list-shaped. e2e: search.spec.ts "the lit result's
record shows beside the list...".

**Problem.** A result row is a title, a subtitle and a type. Choosing between three "Laptop request" rows means
opening each.

**What it does.** On a wide panel (open field ≥ 44rem, or the modal at `lg`), a right-hand pane shows the lit
row's record: status, owner, dates, the first lines of its text, and its decisions (the Tab actions, as
buttons). Arrow keys update it; a short delay before reading so walking the list does not fire a read per row.

**How.** Read on demand through the existing resource cache (lib/resourceStore), so a record read once in the
session is free; a per-collection summary shape (`previewOf(collection, row)`) next to `paletteVerbs`; no new
endpoint. Off on a phone and in the narrow field.

**Done when.** The pane follows the highlight, reads at most once per record per session, and its decision
buttons ask first exactly as the Tab actions do.

## 3. Decisions on the row itself - DONE 2026-10-04

Built: `DecisionButtons` on the lit row (and in the preview), sharing items 2's read and one `decideOn` with the
Tab flow. They are hidden from a screen reader and out of the Tab order (a listbox may hold only options), so Tab
on the row stays the accessible way to the same decisions. The read happens for the lit row only when its
collection can be decided or the preview is shown. e2e: the same test rejects from the row, after the confirm.

**Problem.** Approving from search exists, but behind Tab - a key nobody guesses.

**What it does.** A row that can be decided shows its verbs (Approve / Reject) as small buttons on hover and
when lit, with the same confirm and the same version check as the Tab flow; the hint bar keeps "⇥ actions".

**How.** The verbs need the record (`access.can`, its state): read for the LIT row only (debounced), cached
like the preview's read - items 2 and 3 share it. Rows stay option buttons; the verbs are siblings laid over the
row's right edge, not nested buttons.

## 4. Saved searches - DONE 2026-10-04

Built: web/src/lib/savedSearches.ts (`useSavedSearches`) + `SavedChip` / `NameSearch` / the Filters menu's
"Save this search…" in CommandPalette.tsx. Stored as `{ searches: [...] }` under `preferences/saved_searches` - a
preference value is an object by contract (openapi.yaml), as `push_subscriptions` wraps its `subs`. Every change
re-reads the stored list first (`refetchPref`) and writes it back whole. Naming and renaming happen in a field
that takes the chip row's place, pre-filled with the search's own pills and words; removing asks first. e2e:
search.spec.ts "a search saved by name comes back from its chip...".

**What it does.** "Save this search" (the words, the category, the menu filters) as a named chip at the front of
the chip row - "My pending leave", "Open IT tickets" - one press to run again, from any device.

**How.** Stored in the caller's `preferences` row (the same per-person, cross-device store as theme and nav, see
cross-device-prefs); a small cap (8); rename and remove from the chip's own menu. No sharing in the first cut.

## 5. Counts that survive a category - DONE 2026-10-04

Built as below (`countSeq` / `countsIn` in usePaletteSearch). e2e: search.spec.ts "with a category on, the other
categories keep counting as the words change".

**Problem.** With a category on, the other chips' counts vanish as soon as the words change: they are counted
from the unscoped answer, which is only in the cache if All ran for those exact words.

**How.** While a category is on and the unscoped key is not cached, fetch it too (debounced like the main
request, its own sequence guard, cached the same way). One extra request per settled search while a category is
on, none otherwise.

## 6. Grouped by when, when sorted by when - DONE 2026-10-04

Built: hits now carry `createdAt` from `search_docs.created_at` (services/globalSearch.ts, all four selects) and
the route sends it as `create_time` (openapi.yaml updated); the palette buckets newest-first records with
`whenLabel` (Today / Yesterday / This week / This month / Earlier, and "Date unknown" for an index row with no
creation time) by the org-local day. e2e: search.spec.ts "newest first, the records group by when...".

**What it does.** With Order: Newest first, records group under Today / This week / This month / Earlier rather
than by kind - the order already says time matters more than type.

**How.** Hits carry `created_at` (add it to the search response if absent - an index column, no extra read);
bucket by the org-local day (lib/orgDay), never a UTC slice.

---

## Open questions

- Should Esc clear the words before it closes (GitHub), or close and clear together (today)?
- Saved searches shared with a team, later - and if so, owned like board sharing (board-access) or like
  table-builder views?

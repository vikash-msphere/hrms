# `in:` suggestions: biggest kinds first, with counts

## Context

Typing `in:` turns the search's chip row into the kinds of record that can come after it. Today those chips
are sorted **alphabetically** and **cut at 8** (`suggestFilters` in web/src/lib/paletteQuery.ts ends with
`items.slice(0, limit)`, `limit = 8`). For someone who can search ~60 kinds, `in:` offers Applications,
Approval delegations, Assets… and the kinds that actually hold what they are looking for never appear unless
they type more of the name. The user wants the kinds with the most items first, and a count on each chip.

## What "count" means (recommended)

**How many results of that kind the rest of the search found** - the words and filters in the box other than
the `in:` word being typed (e.g. `laptop in:` → Tickets 12 · Assets 4 · Expenses 1). This is the same answer the
category chips already count against (`chipCounts` in CommandPalette.tsx: `hits` under All, else
`cache.current.get(unscopedKey)` - the unscoped search, which `countSeq` already fetches in the background while a
category is on). So it costs **no extra request**, and it is the number that matters at that moment: where the
words land.

When there are no other words (a bare `in:`), there is nothing to count. Then the chips are ordered by **how
often this person opens results of that kind from the search** - summed frecency (`loadFrecency` / `frecencyScore`,
already per user in this file; a record result's frecency key is its `collection/id` name), then alphabetical.

Not proposed: true totals per kind ("you can see 1,240 leave requests"). That is a grouped COUNT over every
`search_docs` row the caller can see, under the same scope predicate the search builds (globalSearch.ts
`branches`) - a read of the caller's whole visible index on each session's first `in:`, which for an admin on
the live data is exactly the cost the D1 read rules exist to avoid. If wanted later, measure it first in sqlite3
per measure-d1-reads-in-sqlite3 and add it to `GET /v1/search:vocabulary` (src/routes/searchVocabulary.ts), which
reads nothing today.

## Changes

### 1. Stop capping `in:` at 8 - web/src/lib/paletteQuery.ts
- In `suggestFilters`, the `in` branch (≈ line 349) keeps every matching kind: the cap stays 8 for the other
  keys (`status:`, `@`, `dept:`, dates) but not for `in:`, whose chips scroll sideways and are ranked by the
  caller. Order stays alphabetical here (the tests' default); ranking needs counts this module does not have.
- Comment on why `in:` is uncapped.

### 2. Rank and count in the hook - web/src/components/layout/CommandPalette.tsx
- Next to `chipCounts`, build `kindCounts: { by: Map<collection, number>; capped: boolean } | null` from the
  same `records` source (group `h.collection`; `capped` when `records.length >= SERVER_TOTAL`, so counts read
  "12+"). Null while there are no other words or the answer is not in yet.
- `kindUse: Map<collection, number>` - summed `frecencyScore(frecent[key])` for keys `collection/…`.
- In the `completion` memo (after `cache` and `chipCounts` exist - it cannot live in `suggestFilters`, because
  the counts come from `searchText`, which itself depends on the completion span): for `in` offers, sort by count
  desc (when known), then `kindUse` desc, then the existing order. Add `kindCounts`, `kindUse` to its deps.
- `Item` gains `count?: string` ("12", "12+"); `filterItem` leaves it unset; the completion memo fills it for
  `in` offers when counts are known.
- Chip render in `PaletteChips`: the count after the label as `FilterChip` draws it - a space, then
  `<span className="tabular-nums opacity-70">` - so the accessible name reads "Tickets 12". A kind with 0 results
  for these words stays offered (it is still a valid narrowing) but sits last and is muted
  (`text-muted-foreground`), not disabled.
- Reset nothing new: `pick` already resets on each keystroke, so the lit chip is the top-ranked one.

### 3. Tests
- test/paletteQuery.test.ts: `in:` offers are not cut at 8 (a vocabulary of 10+ collections returns all of them);
  `status:` still capped.
- e2e/search.spec.ts, new test (super): `letter in:` → the first `Kind suggestions` option is "Letter templates"
  with a count (`/^Letter templates \d+\+?$/`); a kind with no letter results comes after it.
- e2e/search.spec.ts "filter words complete…": the `→` walk reads the lit chip's name, which now ends in a count
  when the box has other words - strip it (`/\s*\d+\+?$/`) before building the "Remove filter: …" name.
- Existing option lookups by name (`{ name: "Leave requests" }`, `{ name: "Tasks", exact: true }` on a bare
  `in:tas`) keep working: substring match, and no counts without other words.

## Verification
- `./node_modules/.bin/tsc --noEmit -p web/tsconfig.json`, `-p e2e/tsconfig.json`; eslint on the two files.
- `./node_modules/.bin/vitest run test/paletteQuery.test.ts test/entityNames.test.ts`.
- `npm run test:e2e -- e2e/search.spec.ts e2e/searchScope.spec.ts e2e/paletteRecent.spec.ts e2e/wide.spec.ts e2e/phone.spec.ts`
  (valid run: no ECONNREFUSED in the log).
- Update search-plan.md's "already built" list: `in:` chips ranked by results, with counts.

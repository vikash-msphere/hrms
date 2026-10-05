# `in:` chips: rank by relevance, not by row count

## Context

Commit b65cd81 orders the `in:` kind chips by `search_counts` totals (migration 0010, applied in production).
That fails in two separate ways:

1. **The count is not a count of searchable items.** `search_counts` counts every live `search_docs` row. Many
   rows carry no text at all. An attendance punch is indexed with `title = note` (NULL on almost every punch) and
   `subtitle = source` ("clock"), and the palette renders such a hit as just "Attendance"
   (CommandPalette.tsx:908 `h.title || entityLabelSingular(...)`). Attendance grows people × days, so it tops the
   list with rows no word can find. The same applies to leave-encashments and benefit-enrollments (no title
   column at all), offers and shift/work-pattern assignments (title = an optional note).
2. **Even an honest count measures supply, not intent.** Locally, `automations` (119 seeded rules) and
   `notifications` (33 rows, 4 distinct titles) outrank employees (13). Catalogs and inboxes are large but are
   rarely what someone narrows to.

Today's other signals are weak or missing:
- `kindUse` is per-browser frecency of opened results, sharing a 50-entry cap with pages and settings. It never
  sees an `in:` pick.
- The page the person is on is ignored.
- Typed-prefix quality is ignored: once counts arrive, `in:re` can put "Leave requests" (a word-prefix match)
  above "Reimbursements" (a label-prefix match).

Intended outcome: the first chips are the kinds this person is most likely to pick, and the number on a chip is
how many items words can actually find.

## Ranking (one comparator, first difference wins)

1. **Typed match.** With letters after `in:`, a label or `in:` word that STARTS with them beats a word-prefix match.
2. **Results for the other words** (only when the box has other words, as today): more results first, and 0
   last and muted.
3. **Current page.** Kinds shown on the route the palette was opened from: `/tickets` → Tickets,
   `/settings/leave-types` → Leave types, `/employees/<id>/leave` → Leave requests and leave encashments.
4. **This person's kind affinity.** A decayed use count per kind, stored cross-device (below).
5. **Records before reference kinds.** "Reference" means the registry's own catalog definition: `scoping: flat`
   (automations, holidays, pay-*, leave types, vendors, boards, ...) or `self` (notifications). Everything
   `scoped` is a record kind.
6. **Searchable total.** Titled rows the caller can see (the fixed `search_counts`).
7. Alphabetical.

The chip's number is unchanged in meaning per mode: with words, that kind's result count; on a bare `in:`, the
searchable total. Only the bare total's definition changes.

## Changes

### 1. Count only titled rows - new migration `0011_search_counts_titled.sql`
0010 is applied, so it stays as it is. 0011:
- `DROP TRIGGER IF EXISTS` on `search_counts_ins` / `_del` / `_upd`, then recreate them with the same bodies, but
  a row counts only while `deleted = 0 AND title IS NOT NULL`. The generator already stores a blank title as NULL
  (`firstNonEmpty` / `titleExpr` in src/db/searchDdl.ts use `nullif(trim(..))`).
- `_upd`'s WHEN also fires when the title's nullness flips: `(old."title" IS NULL) IS NOT (new."title" IS NULL)`.
  A plain title edit still costs no counter write.
- Rebuild: `DELETE FROM "search_counts";` then the same grouped INSERT as 0010 with `AND "title" IS NOT NULL`.
- Add a `_journal.json` entry and a `meta/0011_snapshot.json` copied from 0010 (the drizzle schema is unchanged).
- Update the comments that say "how many records": `searchCounts` in src/db/schema.ts, `searchKindCounts` in
  src/services/globalSearch.ts, and src/routes/searchCounts.ts. `searchKindCounts` itself does not change.

### 2. Say which kinds are reference kinds - src/domain/searchIndex.ts
- `searchVocabulary` returns `{ collection, statuses, reference? : true }`, with `reference` set when
  `entry.scoping.kind !== "scoped"`. It is derived from the registry, so it costs no read and adds no config.
- Update openapi.yaml for the `/v1/search:vocabulary` response, and the web `FilterVocabulary` type in
  web/src/lib/paletteQuery.ts.

### 3. Kinds on the current route - web/src/lib/resourceRoute.ts
- `collectionsOnRoute(path: string): Set<string>`, the reverse of the maps that already exist:
  - `PAGE_OF` / `DEEP_OPEN`: the path equals the page route or starts with it plus `/`.
  - `settings/<panel>` → `SETTINGS_PANEL`.
  - `employees/<id>/<tab>` and `profile/<tab>` → `PROFILE_TAB_OF`.
- In CommandPalette, `useLocation().pathname`, read when the palette opens.

### 4. Kind affinity, cross-device - new web/src/lib/searchKinds.ts
- Preference key `search_kinds`, value `{ kinds: Record<collection, { n, t }> }`, capped at the 24 strongest. It
  is read through `readPref`, the same as `useSavedSearches` in lib/savedSearches.ts, and written with
  `writePrefDeferred` (lib/prefs.ts), so a burst of picks costs one PATCH.
- Bumped when an `in:` offer is accepted (`acceptFilter` path, kind `in`) and when a record result is opened
  (`go` / `goNewTab`, using `item.collection`).
- Uses the same decay as `frecencyScore`: move that function into the new module and export it, so it is not
  duplicated.
- Delete `kindUse`, which this replaces. Page and settings frecency stay as they are.

### 5. Pure ranker - web/src/lib/paletteQuery.ts
- `suggestFilters` marks each `in` item `prefix: true` when the label or `in:` word starts with the typed text.
- `rankKindOffers(items, { results?, pageKinds, affinity, reference, totals })` applies the comparator above and
  returns the items with `count` / `muted` filled in. The `completion` memo in CommandPalette.tsx shrinks to one
  call. The ranking moves out of the component, so it can be unit-tested.

## Not in this change
Indexing rule for rows with no title (e.g. skip attendance punches without a note). That changes what
`in:attendance` lists and needs a search DDL delta, so it is a separate decision.

## Tests
- test/searchKindCounts.test.ts:
  - an attendance session with no note is not counted;
  - adding a note counts it, and clearing the note uncounts it;
  - a soft-delete still uncounts;
  - the oracle becomes `count(search_docs WHERE title IS NOT NULL)` under the same scope.
- test/paletteQuery.test.ts, `rankKindOffers`:
  - prefix beats word-prefix;
  - words' result counts lead and zeros go last;
  - page kinds beat affinity, which beats record-over-reference, which beats the totals;
  - alphabetical is the final tiebreak.
- test/searchIndex.test.ts (or the vocabulary test): `reference` is set exactly for flat and self entries.
- e2e/search.spec.ts: rewrite "the kinds after in: come biggest first". As super:
  - bare `in:` on the dashboard puts every record kind before Automations / Notifications;
  - on `/tickets`, the first chip is "Tickets …";
  - the `letter in:` half stays.

  Affinity is covered by unit tests only, because an e2e of it would write the seeded login's preferences row
  (cross-device-prefs rule).

## Verification
- `./node_modules/.bin/tsc --noEmit -p web/tsconfig.json`, `-p tsconfig.json`, `-p e2e/tsconfig.json` (check `$?`).
- `./node_modules/.bin/vitest run test/searchKindCounts.test.ts test/paletteQuery.test.ts test/searchIndex.test.ts`.
- In sqlite3 on the local D1 file:
  - after applying 0011, `select collection, sum(n) from search_counts group by 1` matches
    `select collection, count(*) from search_docs where deleted=0 and title is not null group by 1`;
  - attendance drops to its noted sessions.
- `npm run test:e2e -- e2e/search.spec.ts e2e/searchScope.spec.ts e2e/paletteRecent.spec.ts` (a valid run has a
  full WebServer boot log and no ECONNREFUSED).
- Update in-filters-plan.md / search-plan.md so they describe the ranking as built.

# Frontend performance plan

Measured survey of `web/`, 2026-09-04. Every number below came from a real build or a real benchmark on
this checkout, not an estimate. Items are ordered by the order they should be done in, which is not the
order of their size: the two runtime fixes are zero-risk and go first.

## Baseline

The critical path is what `web/dist/index.html` loads before anything renders: the entry script, the four
chunks it `modulepreload`s, and the stylesheet. **373.6 kB gzipped.**

| chunk | gz |
|---|---|
| shell | 121.6 kB |
| sentry | 92.0 kB |
| index | 46.7 kB |
| react-vendor | 45.6 kB |
| radix | 44.8 kB |
| index.css | 22.8 kB |

Reproduce with:

```bash
npm run build:web && for f in $(rg -o '/assets/[^"]*\.(js|css)' web/dist/index.html); do printf "%8s gz  %s\n" $(gzip -c "web/dist$f" | wc -c) "$(basename $f)"; done
```

Every item is closed. The critical path is **285,867 gz, down from 373,568 - a 23.5% cut**, and two runtime
fixes land on top of that.

Four of the ten were withdrawn once measured rather than assumed. Their reasoning is kept rather than
deleted, because each was a plausible-looking idea a later reader would otherwise propose again - and two of
them (9 and 10) are specifically warnings about over-reading the byte attribution that found them.

| item | status | effect |
|---|---|---|
| 1. Cache the `Intl` formatters | done | 37x / 32x on the two hottest formatters |
| 2. Defer DataTable filtering | done | filtering off the keystroke |
| 3. Dashboard lazy | done | -37.9 kB gz critical path |
| 4. Identity before the bundle | done | one round trip off every cold load |
| 5. Drop Inter 800 | withdrawn | would have regressed the wordmark |
| 6. Defer the Sentry replay recorder | done | -40.0 kB gz critical path |
| 7. Cache the snapshot key | withdrawn | worth 17 us/render, costs a staleness hazard |
| 8. AclModal lazy | done | -9.9 kB gz critical path |
| 9. Settings registry metadata | withdrawn | metadata is genuinely needed; icons are ~0.5 kB gz |
| 10. Icon registries hold names | withdrawn | measured -529 bytes gz; the registries overlap |

Critical path, start to finish:

| chunk | before | after |
|---|---|---|
| shell | 121.6 kB | 97.1 kB |
| sentry | 92.0 kB | 51.7 kB |
| index | 46.7 kB | 23.2 kB |
| react-vendor | 45.6 kB | 45.6 kB |
| radix | 44.8 kB | 45.4 kB |
| index.css | 22.8 kB | 22.8 kB |
| **total** | **373.6 kB** | **285.9 kB** |

Nothing cheap is left. `react-vendor` and `radix` were investigated and are genuinely shell-reachable (radix
rose 0.6 kB when AclModal left, as some of its modules re-hoisted).

Inside `shell`, the biggest group by per-module attribution is lucide - 316 icon modules, 79.6 kB RAW. Do not
read that as 79.6 kB of prize: it is raw, not gzipped, icon path data compresses hard, and the 316 modules
come from just 87 imported names shared across 88 shell modules. Item 10 removed 38 of those 87 names and got
**529 bytes gz** back. The union is what it is because the sidebar's nav, the top bar's quick actions and the
notification glyphs all render at first paint and all draw on the same small vocabulary.

Three drift gates were added with this work, because each win is undone by an edit that still builds and
still runs: `test/mePrefetchDrift.test.ts`, `test/replaySplitDrift.test.ts`, and (pre-existing, relied on
here) `test/replayMaskCoverage.test.ts`. Every gate was verified to actually fail before being trusted.

---

## 1. Cache the `Intl` formatters

**Status: done.**

`formatMoney` built a fresh `Intl.NumberFormat` on every call, and `formatDate` went through
`toLocaleDateString`, which does the same thing internally. Constructing a formatter resolves locale data;
formatting with an existing one does not.

```
formatMoney x20000: uncached 226.4ms | cached  4.1ms | 55.2x
formatDate  x20000: uncached 341.5ms | cached 25.1ms | 13.6x
```

There are 207 `formatDate` call sites, 31 `formatMoney`, and 83 raw `toLocale*String` calls. A payroll
table of 25 rows with 6 money columns spent 1.7 ms per render inside the constructor alone, and it re-ran
on every filter keystroke and every sort.

Fixed by memoising the formatter per distinct option set in a module-level `Map`:

- `web/src/lib/utils.ts` - `formatMoney`, `formatDate`
- `web/src/lib/attendance.ts` - the three `Intl.DateTimeFormat` sites
- `web/src/pages/Attendance.tsx` - `hhmm`
- `web/src/components/common/MoneyInput.tsx` - the currency-symbol probe and the compact formatter

No behaviour change: the same options produce the same formatter, and a formatter is stateless across
`format()` calls. `Intl.DateTimeFormat(...).format(d)` and `d.toLocaleDateString(...)` produce identical
output for identical options, so `formatDate` reads the same as before.

`formatMoney`'s `try`/`catch` still guards construction. An unrecognised currency code throws inside the
helper and a failed construction is never cached, so a bad code falls through to `toFixed` on every call,
exactly as before.

## 2. Defer DataTable filtering off the keystroke

**Status: done.**

`DataTable`'s per-column filter inputs called `setFilters` synchronously on every keystroke. That re-ran
the `filtered` memo (a pass over every row per active filter, plus a full sort) and re-rendered 25 rows of
roughly ten cells each, inside the same commit as the input's own update. The debounce already in the file
covers only the hash-query mirror, not the filtering.

Fixed with `useDeferredValue` on the filter state that feeds `filtered`. React keeps the input responsive
and re-runs the expensive pass at a lower priority, abandoning a half-finished one when the next character
arrives. Nothing to tune, and no dropped keystrokes the way a timer-based debounce has.

Only the filters are deferred. Sort is a click rather than a stream of input, so deferring it would add
latency to a gesture that has none to hide. The filter chips, the URL mirror, `onFilterChange` and the
reset to page one all keep reading `filters` directly, so they still react to the typed value at once.

`renderCols` listing `expanded` in its dependencies was raised as a second fix here and then dropped: it
only feeds a `.map()` in JSX, and `setExpanded` re-renders the whole table either way, so removing it would
have saved rebuilding a ten-entry array and nothing else.

## 3. Make Dashboard a lazy route

**Status: done. Measured win: -37.9 kB gz on the critical path (-10.1%).**

`web/src/App.tsx` imported `Dashboard` statically, so the largest page in the app - 1635 lines - was
downloaded and parsed before anything rendered, on every route. It is now
`lazy(() => import("./pages/Dashboard"))` like every other page.

Everyone entering on a route other than the dashboard (a deep link, a notification link, a bookmark, a
reload anywhere) saves 38 kB. Dashboard landings would pay one extra round trip for the 24.5 kB chunk.

That round trip did not need new machinery. `App.tsx` already keeps a `PAGE_CHUNK` map and a `routeChunk()`
effect that downloads the current route's chunk in parallel with the `me` request, and holds the initial
render until it lands so the shell providers and the page mount in the same commit and their reads coalesce
into one `batch:run`. Dashboard just had to join the map. An empty hash parses to `page: "dashboard"`
(`router.ts`), so an ordinary landing hits the key.

Two changes:

- `web/src/App.tsx` - `Dashboard` moved from a static import to `lazy(() => import("./pages/Dashboard"))`,
  and a `dashboard` entry added to `PAGE_CHUNK`.
- `routeChunk()` now falls back to the dashboard chunk for an unrecognised route, mirroring `default:` in
  `renderPage()`. Without it a typo'd or stale URL waved straight through the chunk gate and split the
  landing into two commits and two `batch:run` windows. Every key the switch handles is already in
  `PAGE_CHUNK` - checked both directions, no drift - so the fallback is reached only by a route with no
  case at all.

Measured after the change:

```
373,568 -> 335,704 gz     index 46.7 -> 23.2 kB, shell 121.6 -> 107.2 kB
Dashboard chunk: 24.5 kB gz
```

One claim from the survey did not survive the build. Dashboard was said to drag `lib/kpiIcons.ts` and its
own lucide glyphs onto the critical path, but the `shell` chunk still holds the same 250 icon path arrays
after the split and the new `Dashboard` chunk holds none by that measure. The 37.9 kB is Dashboard's own
module and the code only it pulls; the icons sit in `shell` for a different reason and are untouched by
this. The comment in `App.tsx` states only what the build shows.

## 4. Start identity before the bundle finishes

**Status: done. Win: one round trip off every cold load, roughly 100-300 ms.**

Boot was two serial round trips. `GET /v1/users/me` could not fire until the whole bundle had downloaded
and parsed, because `useMe` runs inside React. Only then did the page mount, its `useCollection` reads fire,
and `POST /v1/batch:run` go.

`web/public/theme-init.js` is a blocking classic `<script>` in `<head>` (external rather than inline so the
CSP can keep `script-src 'self'`), so it runs while the module bundle is still being fetched. It now starts
the identity request there and parks the promise on `window.__hrmsMePrefetch`.

The answer is claimed in `api()` rather than in `useMe`, so it goes through the same 401/403/problem handling
as any other call - a prefetch that bypassed `api()` would have to re-implement the session-expiry path,
including the redirect and the cross-tab broadcast. `claimMePrefetch` takes the stash at most once (a
`Response` body can only be read once) and only for the exact request the prefetch made: `GET /users/me`, no
extra headers, no `asRealCaller`, no simulation. A prefetch that failed resolves to `null` and falls straight
through to a real request, so a transient blip at boot cannot turn into a failed sign-in.

### The view-as hazard, and why the prefetch declines it

While a "view as" simulation runs, `/users/me` answers as the SUBJECT, because `api()` stamps `X-View-As` on
it. A prefetch that omitted that header would be answered for the real admin, and the app would show an admin
their own shell while they believed they were looking at somebody else's.

`theme-init.js` cannot import `viewAsStore` or `api.ts` - it is not a module. Rather than mirror the store's
parsing and `api.ts`'s `REAL_CALLER_PATHS` carve-outs in a plain script, it reads the `hrms:viewAs` key and,
if anything is there, declines to prefetch at all. A rare admin mode pays one round trip; the wrong principal
is impossible. A malformed or stale key also skips, which is the safe direction.

`test/mePrefetchDrift.test.ts` is the gate: it holds the prefetch's headers, URL and credentials mode to the
ones `api.ts` builds, checks the skip reads the key `viewAsStore` actually declares, and checks
`claimMePrefetch` still guards on method, extra headers, `asRealCaller` and `getViewAs()`. Verified to fail:
changing a header value fails the header assertion, and renaming the storage key fails the skip assertion.

### The coalescer idle window: WITHDRAWN

The second half of this item was to flush the first `batch:run` window eagerly instead of waiting out
`IDLE_MS = 24` in `web/src/lib/getCoalescer.ts`, on the reading that the first window waits 24 ms for a
second wave that has not started yet.

That reading is wrong, and the file says so. A page load does not fire its reads in one burst: the shell's
providers mount, then the lazy page chunk resolves and mounts, then a workspace's sibling tabs, then widgets
whose parents had to render first. The trailing window exists to merge those waves; flushing the first one
eagerly would split boot back into several small `batch:run` calls, which is the problem the window was added
to fix. 24 ms, capped at `MAX_WAIT_MS = 120`, is cheap against a round trip of 100-300 ms.

Item 3 makes this more true rather than less: Dashboard is now a lazy chunk, so its mount is one more wave
for the window to catch.

## 5. Drop the unused Inter 800 faces

**Status: WITHDRAWN. The faces are not unused.**

The claim was that `font-extrabold` has zero matches in `web/src`, so `@fontsource/inter/latin-800.css` and
`latin-ext-800.css` in `web/src/main.tsx` ship 60.5 kB of woff2 nothing asks for.

The Tailwind class is indeed unused, but the weight is not reached through a class. `lib/org.tsx` offers
`{ value: "extrabold", weight: 800 }` in `NAME_WEIGHTS`, the wordmark weight picker, and
`web/src/components/layout/Sidebar.tsx:139` applies it as an inline `fontWeight` alongside
`orgNameFontStack(org.name_font)`. The default typeface in `NAME_FONTS` is
`{ value: "default", stack: "" }`, which resolves to `undefined` and inherits the UI font - Inter. The
`grotesk` stack also names Inter as its fallback.

So an org whose wordmark is set to the default typeface at Extra bold renders the sidebar name in Inter
800. Removing the imports would silently drop it to a synthesised or fallback weight. The faces stay.

The general lesson for the rest of this file: a `rg` for Tailwind weight classes does not prove a font
weight is dead, because `orgNameWeight()` reaches weights through an inline style driven by org settings.

## 6. Defer the Sentry session-replay recorder

**Status: done. Measured win: -40.0 kB gz on the critical path (-11.9%).**

Stubbing `replayIntegration` out of `web/src/instrument.ts` takes the `sentry` chunk from 92.0 to
52.1 kB gz. The recorder is the difference, and it records nothing unless an error or a bug report asks for
the buffer.

Three earlier attempts failed, and the reason the fourth works is the difference between them:

| approach | result |
|---|---|
| `import("@sentry/react")`, `@sentry/replay` unnamed in `manualChunks` | whole SDK forced eager, 444 kB total (worse) |
| `import("@sentry/react")`, `@sentry/replay` given its own chunk name | still eager, 445 kB total (worse) |
| a module that only RE-EXPORTED `replayIntegration`/`getReplay`, `@sentry/replay` named `sentry-replay` | correct split (sentry 51.7 + sentry-replay 41.1) but `sentry-replay` stayed `modulepreload`ed; no win |
| **`web/src/sentryReplay.ts` with real function bodies, same chunk naming** | **works: `sentry-replay` is absent from index.html** |

The first two fail because naming `@sentry` as a `manualChunk` makes a dynamic import of the whole namespace
pull the entire SDK in eagerly. The third is the interesting one: a module that only re-exports is a
transparent facade, and Rollup resolves straight through it to the underlying chunk, so the entry ended up
statically importing the recorder even though the chunk list looked correctly split. Giving the boundary
module real functions to hold - `installReplay(options)` and `activeReplay()`, wrapping `addIntegration` and
`getReplay` - leaves nothing to collapse.

Three pieces, all required:

- `web/vite.config.ts` - `@sentry/replay` gets a `sentry-replay` chunk, placed BEFORE the blanket `@sentry`
  rule that would otherwise sweep it into the eager chunk.
- `web/src/sentryReplay.ts` - the dynamic-import boundary, with function bodies rather than re-exports.
- `web/src/instrument.ts` - `replayIntegration` dropped from the eager `integrations` array and attached via
  `addIntegration`; `captureSessionReplay`, `startManualRecording` and `finishManualRecording` moved off
  `Sentry.getReplay()`, since a single static reference re-pins the whole chunk to the entry.

`REPLAY_PRIVACY` deliberately stays in `instrument.ts`, next to the long note explaining the masking policy
and where `test/replayMaskCoverage.test.ts` reads it. It is data; the 40 kB is recorder code.

### Loaded promptly, not on idle

The first version of this deferred the import to `requestIdleCallback(..., { timeout: 3000 })`, on the
reasoning that later is cheaper. That was wrong and would have shipped a real regression.

What takes the recorder off the critical path is that it is a separate dynamically imported chunk, so
index.html neither loads nor `modulepreload`s it. WHEN the import fires changes nothing about that. But the
SDK drops any replay shorter than its 5s `minReplayDuration`, measured from when the recorder starts, so a
3s idle delay leaves the first ~8 seconds of every session unable to produce a replay at all - and a report
filed the moment something breaks is the one most worth having a film of. It also put the recorder under
that floor for `e2e/replayMasking.spec.ts`, which flushes at 6s.

So `loadReplay()` is called immediately. `currentReplay()` awaits the load rather than racing it, so a report
raised before the chunk lands still gets a recorder. A chunk that will not load leaves every other Sentry
signal intact and clears its memo so a later report retries.

### The gate

`test/replaySplitDrift.test.ts`. Each of the three pieces can be undone with an edit that still builds, still
runs, still records replays, and silently returns 40 kB to the critical path. The test checks the chunk rule
exists and precedes the blanket rule, that `instrument.ts` reaches the recorder only dynamically and holds no
static `Sentry.replayIntegration` / `Sentry.getReplay`, and that the boundary module has not become a
re-export facade.

Verified to fail on all three regressions: removing the chunk rule, turning the boundary back into a
re-export, and reintroducing a static `Sentry.getReplay()` each fail exactly one assertion. Assertions run
against comment-stripped source, because these files document the very patterns they must not contain.

## 7. Cache the resource-store snapshot key

**Status: WITHDRAWN. Measured too small to be worth the staleness risk.**

`getSnapshot` in `web/src/lib/resourceStore.ts` calls `getEntry`, which rebuilds the entry's string key
(including `paramsKey(opts.params)`) on every call, and React calls `getSnapshot` at least twice per render
per mounted hook.

Benchmarked, the whole key-build plus map lookup costs:

```
no params: 0.039 us/call
2 params:  0.195 us/call
```

Thirty mounted hooks at three calls each is 3.5 to 17.5 microseconds per render - three orders of magnitude
below item 1, and invisible next to the React render it sits inside.

Against that, every way of memoising it has to stay correct across `dropEntry`, LRU eviction and
`clearCache`, or a hook keeps reading a snapshot from an entry the store has already discarded. Paying a
staleness hazard in the shared cache for 17 microseconds is a bad trade. The code stays as it is.

---

## 8. Make AclModal a lazy import

**Status: done. Measured win: -9.9 kB gz on the critical path (-3.3%).**

`web/src/components/access/AccessModeProvider.tsx:6` statically imports `AclModal`, and it is one of the
seven providers wrapping the whole tree - so all 26 kB of the access-management modal sits in the `shell`
chunk for every visitor on every route. Line 273 renders it unconditionally with `target` null until an admin
clicks a manage-access key, so on an ordinary page view none of it is used.

Fixed with `lazyPage(() => import("./AclModal").then((m) => ({ default: m.AclModal })))` - `lazyPage` rather
than `React.lazy` so a chunk request that loses a race with a deploy stays retryable through the crash
boundary.

Two details worth keeping:

- **Gated on first open, not on `target`.** `target && <AclModal/>` would have been simpler and would have
  changed behaviour. The modal resets `focusVerb`/`addUsers`/`addExpires`/`showHistory` itself whenever
  `target` changes, but `scopeSel` and `addAccess` deliberately persist across opens, and unmounting on close
  would reset those too. An `aclUsed` flag set by `open()` mounts it once on the first open and leaves it
  mounted, so every open after the first is identical to the static import. All that is skipped is the closed
  dialog it used to render before anyone asked for it.
- **`fetchSubjectOptions` moved to `web/src/components/access/subjectOptions.ts`.** It lived in
  `PreviewPanel.tsx`, and `AccessModeProvider` imports it for the "view as" people picker - so that import
  pinned the whole `PreviewPanel` component to the critical path even though only the modal renders it. Eight
  lines of fetch in a module of their own let `PreviewPanel` ride the modal's chunk.

`permMatrix`, `ruleLogic` and `customMethods` stay eager - each is also reached from `AccessTarget`,
`ActivityFeed`, `RowActions` or `PermissionsPanel`.

Measured: 295,720 -> 285,867 gz, with `shell` falling 107.5 -> 97.1 kB. The `radix` chunk rose 0.5 kB as some
of its modules re-hoisted; the net is -9.9 kB.

## 9. Split the settings registry's metadata from its panels

**Status: WITHDRAWN. The icons cost 0.5 kB gz, not the 13.2 kB the byte attribution suggested.**

`web/src/nav.ts:22` imports `SETTINGS_REGISTRY`, and nav.ts is shell code, so the whole registry - including
39 lucide icon components - is unavoidable at first paint. nav.ts wants one breadcrumb label per panel key
(see its comment at line 280) and `CommandPalette` wants to list settings pages in the palette. Neither needs
the panel bodies or their icons at load.

The 13.2 kB attributed to `settings/registry.ts` is its own METADATA - keys, titles, one-line descriptions,
search keywords - and both eager consumers genuinely need it: `nav.ts` for a breadcrumb label per panel key,
`CommandPalette` to offer "Settings: ..." entries in search. The 39 icon components it references are counted
under lucide-react instead, and they turn out to be nearly free (item 10 has the measurement).

There is also a blocker for the variant of this that defers the palette: `CommandPalette.tsx:172` binds
Cmd/Ctrl+K itself. Lazy-mounting it on first open would leave nothing listening for the shortcut, so the
keyboard entry point would have to move into `App.tsx` or `ShortcutLayer` first - splitting the palette's
keyboard contract across two files to save a couple of kB.

## 10. Icon registries hold components, not names

**Status: WITHDRAWN. Measured at -529 bytes gz, and most of even that is not the icons.**

A caution about this item's own framing first: it was written up as "80.9 kB raw - the largest single group in
the shell chunk", quoted next to gzipped figures everywhere else in this file. That is an apples-to-oranges
comparison and it made the icons look like the biggest prize left when they are nothing of the kind. Icon
path data is extremely compressible. Always compare gz to gz.

Sourcemap attribution puts more of `shell` in lucide-react than in any app directory: ~250 distinct icon path
arrays. No single icon is large. The cost is registries that name many icons statically and are reachable
from shell code - `settings/registry.ts` (39, via nav.ts), `lib/quickActions.ts` (23, via
TopBar/BottomNav/CommandPalette), `lib/notificationMeta.tsx` (33, via `lib/notifications.tsx`, a root
provider). Every glyph any of them might show is downloaded before first paint; a session renders a handful.

The proposal was to store icon NAMES and resolve them where they render, pushing each glyph into the chunk
that uses it. Measured twice before declining it.

The first attempt collapsed every `icon:` field in `settings/registry.ts` onto one icon but LEFT the 38
`import` names at the top of the file, so it only proved a floor. The clean run removes the imports too:

```
shell: 97,122 -> 96,593 gz   (-529 bytes)
distinct lucide icon modules in the chunk: 316 -> 313
```

**38 of the registry's icon names removed, and 3 of 316 icon modules left the chunk.** The other 35 are
referenced by other shell modules as well, so they stay. And since dropping 38 import bindings and shortening
38 object literals accounts for most of 529 bytes on its own, the icons' share of it is close to nil.

The reason is that the registries do not hold DIFFERENT icons. `nav.ts`, `lib/quickActions.ts`,
`lib/notificationMeta.tsx` and `settings/registry.ts` reach for the same vocabulary - Building2, Users,
Shield, KeyRound, Clock, Wallet, FileText - and Rollup includes each icon once. The 80.9 kB is the UNION
across every shell consumer, and any one registry's set is nearly a subset of it. Moving one registry's icons
elsewhere removes almost nothing, because the others still pull them.

So 80.9 kB of lucide is close to irreducible while the shell renders what it renders: the sidebar's nav
icons, the top bar's quick actions and the notification glyphs are all on screen at first paint. Reducing it
means rendering fewer distinct icons, not re-plumbing how they are imported.

The general lesson, worth more than the item: **per-module byte attribution shows what a chunk CONTAINS, not
what removing a module would SAVE.** Shared code is attributed to whoever the sourcemap names, so a module can
look expensive while its marginal cost is nil. Always confirm a split with a before/after build.

### How these three were found, and what that method cannot tell you

Not by reading imports. `web/vite.config.ts` was copied to a scratch config with `sourcemap: true` and a
separate `outDir`, built, and each chunk's minified bytes attributed back to source modules through the
sourcemap's mappings. That is worth repeating before the next round of guesses: it is the only reason the
`shell` chunk's real contents are known, and it contradicted an earlier guess in item 3 about where the icons
were coming from.

## Checked and already correct

These were investigated and found to need no change. Recorded so they do not get re-opened.

- **The `radix` chunk.** The hypothesis was that `@radix-ui/react-select` (49.5 kB, the largest of the
  twelve radix packages) is not reachable from the shell and should not sit on the critical path. Two
  builds disproved it: removing the `radix` chunk entirely gives 378.6 kB (worse, because Rollup hoists
  the same modules into `shell`), and carving `select`/`tabs`/`checkbox`/`avatar` into a `radix-lazy` chunk
  gives 375.9 kB with that chunk still `modulepreload`ed. All of it is genuinely shell-reachable. The
  current chunking is optimal.
- **Employee photos.** `lib/photoCache.ts` collapses the per-avatar `:getPhoto` calls into batched
  `employees:batchGetPhotos` requests, capped at 24, and persists results across page loads.
- **DataTable row count.** Pages at 25 rows, so no windowing library is warranted.
- **Context providers.** All seven providers wrapping the tree in `App.tsx` memoise their context value.
- **Tailwind.** Content globs are correct and there is no colour-pattern safelist. 22.8 kB gz for an app
  this size is reasonable.
- **Workspace chunking.** `PAGE_GROUPS` and the `panelGroup` private-weight guard in `web/vite.config.ts`
  are doing their job; the lazy route payloads are correctly isolated.
- **Resource store.** Dedup, TTL tiers, disk adoption and `batch:run` coalescing are all in place.

---

## Verification

Run against the tree with items 1, 2, 3, 4, 6 and 8 applied.

- `tsc --noEmit -p web/tsconfig.json` and `tsc --noEmit` both clean.
- `npm run build:web` clean. Critical path **373,568 -> 285,867 gz, -87,701 (-23.5%)**. Item 4 moves no
  bytes; it moves a round trip. Items 1 and 2 add +188 bytes for the formatter cache module.
- `sentry-replay` (41.1 kB gz) and `Dashboard` (24.5 kB gz) are both absent from `web/dist/index.html`, and
  no built chunk statically imports either. Checked in the output, not assumed from the config.
- One bug was found in this work by reviewing it afterwards, and is fixed: `currentReplay()` in
  `instrument.ts` ran a second `import("./sentryReplay")` after `loadReplay()` had already swallowed that
  import's failure, so a chunk that would not load rejected instead of resolving to `undefined`. That
  rejection reached `ReportProblemDialog`'s submit ahead of its try block, in a throws-to-fail dialog - a
  stale tab after a deploy, or an offline browser, and the person reporting a fault could not file the report
  at all. See item 6.
- `npm run test`: **182 files, 2175 tests, all pass** (2161 at the start of this work, plus the two new gates).

Both new gates were verified to fail before being trusted, then restored:

- `mePrefetchDrift` - changing a header value in `theme-init.js` fails the header assertion; renaming the
  view-as storage key fails the skip assertion.
- `replaySplitDrift` - removing the `@sentry/replay` chunk rule, turning the boundary module back into a
  re-export, and reintroducing a static `Sentry.getReplay()` each fail exactly one assertion.

One note on the test runs, so the record is not misleading. An earlier run, taken after items 1 and 2 and
before item 3, showed 2160 of 2161 with `test/changeDdlDrift.test.ts` failing on a trigger writing
`'access_rules'` where the generator emits `'access-rules'`. That is this branch's in-flight migration work,
not anything here: `src/db/changeDdl.ts` and `src/db/migrations/` were modified on disk during the session
by something other than these changes (`0000_lyrical_magik.sql` appeared untracked, and `changeDdl.ts` and
the migration meta files have mtimes from the middle of the session). By the later run the generator and the
migration agreed and the test passed. Everything in this plan is confined to `web/src/`.

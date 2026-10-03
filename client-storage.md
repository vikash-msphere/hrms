# Client storage

What the app keeps in the browser, why, and what makes it safe to keep.

Two forces shape this. D1 bills **rows read** and Workers bill **request count**, so a page that re-reads the
same rows is a cost, not just a slowness. And the browser is somebody's machine - possibly a shared one,
possibly not the org's - so everything kept there is data at rest outside the org's control. The whole design is
those two pulling against each other.

## The record store

`web/src/lib/clientStore.ts` is the single owner of everything persisted. One IndexedDB database, two object
stores (`meta` and `data`), and four classes of record with their own budgets:

| Class | Holds | Budget | Max age |
|---|---|---|---|
| `rows` | Cached collection reads (`lib/resourceStore.ts`) | 4M chars | 7 days |
| `faces` | Employee photos (`lib/photoCache.ts`) | 8M chars | 7 days |
| `snapshot` | The org settings snapshot, the approvals badge counts | 256K chars | 24 hours |
| `draft` | Drafts meant to outlive the session (`lib/draftStore.ts`) | 1M chars | 7 days |

Every record's key is `<schema>|<identity>|<class>|<key>`. The identity is the caller plus any active
simulation, so a browser shared by two people never serves one of them the other's rows, and hydration deletes
another identity's records rather than merely ignoring them.

**IndexedDB, not localStorage.** The two caches were previously provisioned for roughly 24 million characters
against a localStorage budget of about five million, competing for the same quota, and each answered a refused
write by throwing away everything it had stored and giving up on disk for the rest of the page life. So the
mechanism that exists to make a reload cheap disarmed itself on exactly the sessions that needed it. IndexedDB's
quota is orders of magnitude larger, its writes do not block the main thread, and a separate metadata store
means eviction sorts a small index instead of parsing megabytes of payload to find the oldest entry.

**Hydrated once, then synchronous.** IndexedDB is asynchronous and the row store is not, so the identity's
records are loaded into memory in one transaction at boot and the shell holds its first data-reading render on
it (`App.tsx`). That wait is free in practice: it starts when identity is known, runs alongside the route's code
chunk, and replaces the hundred-odd synchronous `localStorage` reads this used to do during render. Payloads are
held as unparsed JSON, so a collection nothing on the first screen touches costs no `JSON.parse`.

**What stays in localStorage.** Only what must be read synchronously before the first paint or the first
request: the theme (read by `web/public/theme-init.js` before React exists) and the active "view as" subject
(which has to stamp request number one), plus the reconciliation point and the small per-page UI toggles. Those
toggles are a few bytes each and their staleness is invisible; `gc()` sweeps the families that would otherwise
grow one key per ticket or per board.

## What may be persisted

`persistable()` in `lib/resourceStore.ts` is an explicit deny-list, not a heuristic. Compensation, salary
structures, payslips, payroll runs, loans, tax declarations, settlements, bonuses, dependents, benefit
enrolments, personal documents, background checks and API keys are cached **in memory only** - same dedup, same
freshness window, same cross-tab sharing, never written down. They are read on one page each rather than on
every page, so persisting them saved little and left the most sensitive data the system holds in plaintext on a
machine the org may not own. `test/resourceStoreCache.test.ts` pins the classification so a new sensitive
collection cannot default into persistence.

## What makes a stored copy trustworthy

Three questions, three mechanisms.

**"Has this collection changed?"** `GET /v1/changes?since=<ms>` names every collection written to since the
client last looked, from a stamp per collection maintained by database triggers (`src/db/changeDdl.ts`). One
request answers it for everything, so a page load costs one small request instead of a read per collection on
screen. The triggers are generated from the collection registry, plus `settings`, `roles`, `access_rules` and
`policy`, which the client caches from but which are not collections - `settings` most of all, because without
a stamp the config snapshot could not be told it was out of date at all.

`test/changeDdlDrift.test.ts` fails if a collection the client may persist has no stamp. That combination is the
one this cache cannot recover from: stale forever, with nothing able to correct it.

**"Are these rows still mine?"** A serialized row is not raw data - it carries the per-object `access.can` hints
(`src/http/accessHint.ts`) and the field redactions (`src/http/fieldAccess.ts`) computed for whoever fetched it.
So narrowing a rule, changing a role or moving someone's department leaves stored rows that are stale without
anything having been written, and a collection the caller has just LOST cannot even be named in the answer (the
route filters it to what they may list). `GET /v1/changes` therefore also returns an `authz_version`
(`src/domain/authzVersion.ts`): a hash of the caller's compiled grant plus their scope key, which the auth read
has already loaded, so it costs no query. A different value gives up every stored copy for that identity -
nothing narrower would be truthful.

**"Has anything changed since I fetched this page?"** The change feed answers once per page load. Inside a
session, every cached list has a freshness window (20 seconds for anything transactional, a minute for the
directory, five for the catalogs), and a lapsed window meant re-reading up to a hundred rows to be told the same
thing. Conditional GET (`src/http/listEtag.ts`) answers that in one indexed row: the list route emits an `ETag`,
the store stores it with the rows, and a revalidation sends it back as `If-None-Match`. Every list read is
coalesced through `POST /v1/batch:run`, so the sub-request carries the validator and the sub-response carries
the answer's own.

The etag is deliberately keyed on `max(at)` across ALL collection stamps rather than the collection's own. A
list response is not only its own rows - `decorate` folds in fields computed elsewhere, route-level hooks join,
`extra` carries aggregates - and there is no honest way to enumerate the contributing collections per route
without a second registry to drift. So it under-caches in a busy org, which is the right direction to be wrong
in. It also carries a five-minute window, because some list hooks answer relative to now (what is upcoming, what
is due today) and change with no write at all.

## Config is a special case

`getSetting` is awaited once, early, and its value decides behaviour for the rest of the page life: which
rounding to use, whether backdating is allowed, what the working week is. There is no later render to correct.
So a stored copy of the config is served only once the change feed has vouched for it (`reconciled()` in
`lib/resourceStore.ts`) - an admin who saves a setting and reloads has to see what they saved. Cached ROWS need
no such wait: they are painted immediately and corrected in place, which every subscriber already handles.

## Faces

A cached photo is keyed by the photo's own version, which the employee's `photo` marker carries (from the
`photo_at` column, set only when a photo is uploaded or cleared). Keyed by employee id alone, a replaced photo
was permanently wrong everywhere but the browser that replaced it: `invalidatePhoto` runs in the uploading tab
and nothing told any other browser. With the version in the key, every browser simply misses and fetches once,
and the old key ages out. Deliberately not the row's `update_time`: renaming someone must not cost a re-fetch of
their face.

## Cleanup

- **Sign-out purges everything but the look**: `purgeAll()` deletes the database and sessionStorage, and every
  localStorage key except `LOOK_KEYS` in `lib/clientStore.ts`: the theme, folds, view modes, zooms and "seen"
  marks. None of those can carry a name, and the per-person ones are namespaced to their owner, so keeping them
  hands nothing to the next person. It is awaited before the navigation, so nothing is abandoned.
- **A different identity purges the previous one's records** at hydration.
- **Deletions flush immediately**, not on the next idle callback like a write, and again on `pagehide` and
  `visibilitychange`. A deletion is how a stale copy is disowned, and it has to be gone before the page can be
  reloaded - saving a setting and reloading straight after is what a person does.
- **`gc()` at boot** (idle-scheduled) removes what nothing will read again: records of another schema version or
  identity, anything past its class max age, drafts an older build left un-namespaced in localStorage, and the
  ticket last-seen stamps older than 90 days (`lib/ticketsSeen.ts`).
- **Budgets evict by recency** within a class, so faces can never crowd out rows, and a refused write drops that
  batch rather than the whole store.

## Drafts

Two lifetimes, one mechanism each. `useDialogDraft` (`components/common/dialogGuard.ts`) is session-scoped, for
a long form that must survive a reload or a phone switching apps. `lib/draftStore.ts` is for drafts meant to
outlive the session - the announcement composer, a review write-up - and lives in the `draft` class, so they
expire and are purged with everything else. Both namespace the key to the caller: an un-namespaced draft on a
shared machine is offered back to whoever opens the same dialog next, which for a review write-up means handing
one person another's words about a named colleague.

## Deliberately not done

- **`useResource` is not served from cached list rows.** It would save one row read per detail navigation, and a
  list row is not always the same projection as an item read, so a partially-populated record could render as a
  complete one. Not worth it for one row.
- **`Clear-Site-Data: "cache"` only, never `"storage"`,** on logout and on lock. `"storage"` would also deregister
  the push service worker and silently cost the person their web-push subscription; the client clears its own
  storage before either request, so the header covers only what script cannot reach (the HTTP cache, which holds
  photos, and the back/forward cache).
- **The sensitive collections stay memory-only** even though the store is encrypted (below): encryption keeps a
  locked browser from reading its copies, and not writing them down at all is still the stronger answer for
  the data the system holds most carefully.

## Encryption at rest

Every payload in IndexedDB is AES-GCM ciphertext (`SCHEMA` 3), under a key the server derives per person
(`src/lib/appLock.ts clientKeyFor`) and hands out only as `client_key` on `/users/me` - that is, only to a
browser the app lock has not locked (`app-lock-plan.md`). The browser holds it as a non-extractable CryptoKey in
memory and never stores it. Each record's own key is the AES-GCM additional data, so a ciphertext moved under
another record's key fails to open.

- **No key, no disk.** Until the key arrives, and on a lane that never gets one, the store is memory-only: it
  never writes plain text.
- **Locking** reloads into a fresh page and the server refuses the key to a locked browser, so what is on disk
  cannot be read; it is not deleted either, which is what makes an unlock warm and keeps drafts. What a lock
  does remove is everything readable without the key: sessionStorage, localStorage except the visual toggles a
  sign-out keeps plus the lock's own bookkeeping and the sync point (`KEPT_ON_LOCK` in `lib/clientStore.ts`), Cache Storage, and any record still in plain text.
- **An admin PIN reset** moves the person's key epoch: records written under the old key fail to decrypt and are
  deleted at the next hydration.
- **Upgrading from plain text**: version-2 records are deleted at hydration, except drafts, which are
  re-encrypted in the same transaction that removes the plain copy.

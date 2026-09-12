// Shared client-side cache for collection reads. Without it, every component that calls useCollection fires
// its own HTTP request, so "employees" alone is fetched 30+ times per session. The store gives three things:
//   1. in-flight dedup - concurrent identical reads share ONE promise (the biggest request-count win),
//   2. a short TTL so navigations within the window reuse the cached rows instead of refetching,
//   3. subscribe/notify + mutation-driven invalidation so a write refreshes every mounted view of a collection.
// Cloudflare caps request COUNT (not payload), so collapsing duplicate reads is the lever.
import { list, listConditional, changesSince } from "@/api";
import { publish, subscribeTopic } from "@/lib/crossTabBus";
import { openFor, registerHydrator, put, del } from "@/lib/clientStore";

// ---- Freshness tiers ----------------------------------------------------------------------------------------
// D1 bills rows read, so the question for every cached collection is "how long may this be reused before we pay
// to read it again". One global 20s TTL answered that the same way for a leave request and for the department
// list, which is why opening five pages re-read the same catalogs five times.
//
// Three tiers instead:
//   CATALOG - reference lists someone edits in Settings a few times a year (departments, leave types, pay
//             components…). Reused for minutes; a write anywhere invalidates them anyway (invalidateCollections
//             + the cross-tab bus), so the TTL only bounds how long ANOTHER user's edit takes to show up.
//   SEMI    - the employee directory: read by nearly every page, changes when someone joins or leaves.
//   DEFAULT - everything transactional (requests, tickets, attendance…), unchanged at 20s.
const TTL_DEFAULT_MS = 20_000;
const TTL_SEMI_MS = 60_000;
const TTL_CATALOG_MS = 5 * 60_000;

// Exported for test/changeDdlDrift.test.ts: a catalog is reused for minutes and stored on disk, so one with no
// change stamp is stale until something writes to it locally - the one failure this cache cannot recover from.
export const CATALOG_COLLECTIONS = new Set([
  "departments", "leave-types", "pay-components", "pay-grades", "salary-structures", "pay-periods", "holidays",
  "projects", "shifts", "asset-categories", "expense-categories", "reimbursement-categories", "vendors",
  "benefit-plans", "letter-templates", "letterheads", "bank-formats", "ticket-checklists", "roles", "compliance-rules",
]);
const SEMI_COLLECTIONS = new Set(["employees"]);

/** How long a loaded copy of this collection may be reused before it is read again. */
export const freshnessMs = (collection: string) =>
  CATALOG_COLLECTIONS.has(collection) ? TTL_CATALOG_MS : SEMI_COLLECTIONS.has(collection) ? TTL_SEMI_MS : TTL_DEFAULT_MS;
const ttlFor = freshnessMs;

// ---- What may be written to disk ----------------------------------------------------------------------------
// Everything non-ephemeral is worth STORING, not just the long tiers: with `GET /v1/changes` answering "has this
// collection been written to", a stored copy is trustworthy however old it is, so a reload can serve leave
// requests, tickets and board cards from disk instead of re-reading them.
//
// With one exception, which is not about freshness. Persisting a collection means its rows sit on the disk of
// whatever machine the browser is on, for as long as the cache keeps them, readable by anything with access to
// that profile. For a department list or the directory that is a cache. For someone's pay, their tax
// declarations, their loan balance or their identity documents it is a copy of the most sensitive data the
// system holds, in plaintext, on a machine the org may not own - and it buys almost nothing, because these are
// read on one page each rather than on every page. So they are cached in MEMORY for the page life (same dedup,
// same TTL, same cross-tab sharing) and never written down.
//
// Listed explicitly rather than inferred: a new collection that belongs here must be added here, which is what
// test/resourceStoreCache.test.ts pins.
const MEMORY_ONLY = new Set([
  "compensation",
  "salary-structures",
  "pay-grades",
  "payslips",
  "payroll-runs",
  "loans",
  "tax-declarations",
  "tax-verifications",
  "settlements",
  "bonuses",
  "dependents",
  "benefit-enrollments",
  "personal-documents",
  "document-acknowledgements",
  "background-checks",
  "api-keys",
  "bank-formats",
  // An offer row carries `base_comp` - the annual compensation being offered (src/db/schema.ts) - which is the
  // same kind of figure `compensation` is on this list for, before the person it belongs to has even accepted.
  // It was persistable only because the rule above was applied by remembering, and the test that pins this set
  // asserts a hand-written allowlist, so nothing caught it. The Offers page reads it once; storing it bought
  // nothing.
  "offers",
  // Candidates are the one collection here whose subjects are not employees: name, personal email, phone and
  // free-text notes on people OUTSIDE the org, who never agreed to anything and cannot ask for it back. Same
  // reasoning, same conclusion - read on one page, so keep it off the disk.
  "candidates",
]);

/** Whether a loaded copy of this collection may be written to disk (see MEMORY_ONLY above). */
export const persistable = (collection: string) => !MEMORY_ONLY.has(collection);

// `meta` carries any non-`results` fields the list response returned (e.g. notifications' `snoozed_count`), so a
// consumer can read a piggybacked count without a second request.
type Snapshot = { rows: unknown[]; state: "loading" | "ready" | "error"; error: string | null; meta?: Record<string, unknown> };
// What identifies one cached read of a collection. `params` are collection-specific SERVER filters (e.g.
// leave-requests' `leave_type`): a narrowed read is a different key with its own rows, never a mutation of the
// unfiltered one - so the two coexist and a page can switch between them without refetching either.
export type ListOpts = { showDeleted?: boolean; deletedOnly?: boolean; max?: number; q?: string; params?: Record<string, string> };
const paramsKey = (params?: Record<string, string>) =>
  Object.entries(params ?? {})
    .filter(([, v]) => v)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
type Entry = {
  key: string;
  collection: string;
  opts: ListOpts;
  snap: Snapshot; // stable identity; replaced only when it changes (required by useSyncExternalStore)
  ts: number; // last successful load
  inflight: Promise<void> | null;
  // A forced read that arrived while `inflight` was already running, waiting for its turn - see ensureFetch.
  queuedForce: Promise<void> | null;
  subs: Set<() => void>;
  // When these rows were last edited LOCALLY (an optimistic guess, or a write's own reserialized row folded
  // back in). A list answer whose request left before that moment describes the state the caller has already
  // moved on from, so it must not be adopted - see ensureFetch.
  patchedAt: number;
  fromDisk?: boolean; // adopted from the stored copy and not re-read since - see syncChanges
  // The server's validator for these exact rows. Sent back on the next revalidation, which is what turns a
  // lapsed freshness window from a page of rows into one indexed row (see ensureFetch).
  etag?: string;
};

const entries = new Map<string, Entry>();

// ---- Retention ---------------------------------------------------------------------------------------------
// The map used to grow for the whole page life with nothing ever removed from it, and a search box mints a key
// per debounced term (Directory, Tickets, Expenses, Announcements all pass `q`). So typing thirty queries left
// thirty entries of up to a hundred rows each, retained until reload. `writeDisk` already refuses to persist a
// `q` key on exactly this reasoning - "grow a key per query typed and buy nothing" - and the memory side simply
// never got the same treatment.
//
// Two rules, both cheap:
//   - a query-shaped entry (`q`, or the trash view) is DROPPED once its last subscriber goes away. It answered
//     a question the user asked once; the next search is a different key anyway.
//   - everything else is LRU-capped, so a long session with many filter permutations settles instead of climbing.
// Neither can lose data: an evicted key is simply re-fetched the next time something mounts it.
const MAX_ENTRIES = 80;
const ephemeral = (e: Entry) => !!e.opts.q || !!e.opts.deletedOnly;

function dropEntry(e: Entry) {
  entries.delete(e.key);
  hasMoreByCollection.delete(e.key);
  // The collection's flag is derived from the keys that still EXIST, so dropping the truncated one has to
  // re-derive it. Without this, a search that returned a full page (`q` keys are dropped on their last
  // unsubscribe) left the collection marked truncated for the rest of the page life - so every table of it
  // went on claiming to show a window of a larger set after the search that was truncated had gone.
  recomputeTruncated(e.collection);
}

/**
 * Evict least-recently-loaded unsubscribed entries until the map is back under the cap.
 *
 * `keep` is the key of the entry being created right now: it has no subscribers yet and `ts` 0, so it would
 * otherwise sort FIRST for eviction and the caller would get back an entry already removed from the map.
 */
function evictIfNeeded(keep: string) {
  if (entries.size <= MAX_ENTRIES) return;
  const evictable = [...entries.values()].filter((e) => e.key !== keep && e.subs.size === 0 && !e.inflight).sort((a, b) => a.ts - b.ts);
  for (const e of evictable) {
    if (entries.size <= MAX_ENTRIES) break;
    dropEntry(e);
  }
}

// ---- hasMore index -----------------------------------------------------------------------------------------
// `next_page_token` presence per entry key, so "is this collection truncated" is a lookup rather than a scan of
// every entry. It matters because useCollectionHasMore reads it through the GLOBAL notify bus: every mounted
// DataTable is subscribed, so the old linear scan cost (tables x entries) on every single write, with the
// second term growing all session.
const hasMoreByCollection = new Map<string, boolean>(); // entry key -> has a cursor
const truncatedCollections = new Set<string>(); // collections with at least one truncated entry

// Recompute one collection's flag from the keys that still exist (a handful), never the whole map.
function recomputeTruncated(collection: string) {
  let any = false;
  for (const other of entries.values()) {
    if (other.collection !== collection) continue;
    if (hasMoreByCollection.get(other.key)) {
      any = true;
      break;
    }
  }
  if (any) truncatedCollections.add(collection);
  else truncatedCollections.delete(collection);
}

function indexHasMore(e: Entry) {
  const has = Boolean((e.snap.meta as { next_page_token?: string } | undefined)?.next_page_token);
  if (has) hasMoreByCollection.set(e.key, true);
  else hasMoreByCollection.delete(e.key);
  recomputeTruncated(e.collection);
}

// `m` mirrors the page size api.ts actually sends (capped at the server's 100), so two callers that differ only
// in an over-100 `max` share one cache entry instead of each minting a key for a page neither can get.
const keyOf = (collection: string, opts: ListOpts) =>
  `${collection}?d=${opts.deletedOnly ? 2 : opts.showDeleted ? 1 : 0}&m=${Math.min(opts.max ?? 100, 100)}&q=${opts.q ?? ""}&p=${paramsKey(opts.params)}`;

function getEntry(collection: string, opts: ListOpts): Entry {
  const key = keyOf(collection, opts);
  let e = entries.get(key);
  if (!e) {
    e = { key, collection, opts, snap: { rows: [], state: "loading", error: null }, ts: 0, inflight: null, queuedForce: null, subs: new Set(), patchedAt: 0 };
    entries.set(key, e);
    evictIfNeeded(key);
    // First touch in this page life: adopt whatever the last page life left on disk. A copy still inside its
    // tier's TTL makes the mount cost NOTHING (ensureFetch sees it fresh); an older copy still paints
    // immediately and is revalidated in the background.
    const disk = readDisk(key);
    if (disk) {
      // Adopted as FRESH while the change feed vouches for it (`trustDisk`), so this page load pays no read
      // for it at all; the sync invalidates it if the collection was actually written to. Without that
      // vouching, it keeps its stored age and the freshness tiers decide, exactly as before.
      e.ts = trustDisk ? Date.now() : disk.ts;
      e.fromDisk = true;
      if (trustDisk) adoptedFromDisk.add(e.collection); // what to give up if the reconciliation falls through
      e.etag = disk.etag; // so revalidating an adopted copy costs one indexed row, not a page of them
      e.snap = { rows: disk.rows, state: "ready", error: null, meta: disk.meta };
    }
  }
  return e;
}

// ---- Disk layer ---------------------------------------------------------------------------------------------
// A reload used to start from nothing: every collection the first screen touches was read again, even the
// department list nobody had edited in months. Persisting means a reload (or a second visit in the same browser)
// serves those rows and pays for no read at all.
//
// The storage itself belongs to lib/clientStore.ts, which namespaces it to the caller (and their active
// simulation), holds it to a budget, evicts by recency and purges it on sign-out. What is left here is the
// policy: which keys are worth storing, and when a stored copy may be believed.
//
// Payloads are handed over and hydrated back as UNPARSED JSON, so a page load pays no parse for a collection
// nothing on the first screen touches. `hydrated` holds them until the key is first mounted; a key that is
// mounted, dropped from `entries` by the LRU and mounted again re-reads from here rather than from the server.
let diskUser: string | null = null; // set by setResourceStoreUser; until then, disk is off
// Availability is the record store's problem, not this module's: a browser that refuses to store anything
// hydrates nothing and accepts writes as no-ops, so every read here simply misses and the store works from
// memory. There is no session-wide "disk is off" flag to keep in step any more.
const hydrated = new Map<string, { raw: string; ts: number; etag?: string }>();

registerHydrator("rows", {
  onRecords: (records) => {
    for (const r of records) hydrated.set(r.key, { raw: r.value, ts: r.ts, etag: r.etag });
  },
  // Evicted for budget: the copy is gone from disk, so stop offering it as one.
  onEvict: (keys) => {
    for (const k of keys) hydrated.delete(k);
  },
  // A different caller (or a simulation starting): whatever is held here is the previous identity's.
  onReset: () => hydrated.clear(),
});

// ---- Trusting the stored copies -----------------------------------------------------------------------------
// A stored copy used to be worth only a faster paint: whatever its freshness tier said, a page load minutes or
// hours later found it lapsed and re-read it. So a reload cost a read per collection on screen, almost always to
// discover that nothing had changed.
//
// `GET /v1/changes?since=<ms>` answers that question for EVERYTHING in one indexed read (see
// services/changes.ts). So the rule here inverts: a stored copy is adopted as FRESH, and the one change request
// invalidates exactly the collections that were actually written to. A page load costs one small request instead
// of N list reads; a collection somebody edited is re-read, and the rest are not.
//
// The in-session freshness tiers are untouched - adoption stamps the entry as fresh NOW, so the normal TTL still
// governs how long this page life reuses it. And the trust has an escape hatch at both ends: a client with no
// reference point (first visit, cleared storage) is told so and revalidates normally, and a reconciliation that
// fails or cannot be answered gives the stored copies up rather than presenting them as fresh.
// One thing the change feed alone cannot answer: WHOSE rows these are allowed to be. Every stored row carries
// decisions baked in at serialize time - the per-object `access.can` hints, and which fields were redacted -
// and those come from the caller's grants, not from the collection's contents. So narrowing a grant, dropping
// an ACL, changing a role or moving someone's department leaves a stored copy that is stale in a way no
// collection stamp reports: nothing was written to the collection, and a collection they can no longer list is
// not even named in the answer. The feed therefore also reports an `authz_epoch`, and a move in it gives up
// EVERY stored copy for that identity - nothing narrower would be truthful.
//
// The reference point stays in localStorage rather than in the record store: it has to be read synchronously,
// before the first entry is mounted, to decide whether stored copies may be adopted at all. It is two numbers
// and no personal data, and sign-out clears it with everything else.
const SYNC_KEY = "hrms.sync:"; // `${SYNC_KEY}<identity>` -> { at: <server ms of the last sync>, authz: <version> }
type SyncPoint = { at: number; authz: string };
let trustDisk = false; // set once the sync is in flight with a usable `since`
let syncedFor: string | null = null; // the identity the current reconciliation belongs to
// Collections served from a stored copy this page life. If the reconciliation cannot vouch for them after all,
// these are exactly the ones to give up - the rest were read from the server anyway.
const adoptedFromDisk = new Set<string>();

const syncKey = () => `${SYNC_KEY}${diskUser}`;

function readSyncPoint(): SyncPoint {
  try {
    const raw = localStorage.getItem(syncKey());
    const rec = raw ? (JSON.parse(raw) as Partial<SyncPoint>) : null;
    const at = typeof rec?.at === "number" && rec.at > 0 ? rec.at : 0;
    return { at, authz: typeof rec?.authz === "string" ? rec.authz : "" };
  } catch {
    return { at: 0, authz: "" };
  }
}

function writeSyncPoint(p: SyncPoint) {
  try {
    localStorage.setItem(syncKey(), JSON.stringify(p));
  } catch {
    /* storage refused; this page life just won't trust disk next time */
  }
}

/**
 * Whether a stored copy may be served WITHOUT re-reading it: true once a previous page life recorded a
 * successful reconciliation, so the change feed can say what has been written since. Other stores (the settings
 * snapshot) ask this for the same reason, and rely on the same invalidation to correct them - a collection that
 * did change is dropped by syncChanges below, which every store already listens for.
 */
export const storedCopiesTrusted = () => trustDisk;

// The reconciliation, as something to WAIT for. Cached rows do not need to: they are painted immediately and
// corrected in place when the answer lands, because a list that gains a row a moment later is what every
// subscriber already handles.
//
// A CONFIG READ is different. `getSetting` is awaited once, early, and its answer decides behaviour for the
// rest of the page life - which rounding to use, whether backdating is allowed, what the working week is. There
// is no second render to correct: whoever asked has the value. So a stored copy of the config may be served
// only once the feed has vouched for it, and that is what this is for. It costs no extra request (the feed
// call is already in the page's first batch) and no extra wait in the common case, where the answer is
// "nothing changed".
let reconciliation: Promise<void> = Promise.resolve();
export const reconciled = () => reconciliation;

/** The identity everything stored is namespaced to, or null before it is known. Other stores key their own
 *  copies off this so a browser shared by two people (or a running simulation) never serves one of them the
 *  other's numbers. Re-exported from the record store, which owns the namespace, so there is one answer. */
export { storedIdentity } from "@/lib/clientStore";

/**
 * Namespace the record store to the signed-in caller (plus any active "view as" subject), hydrate it, then
 * reconcile what is stored with what has been written since we last looked.
 *
 * Returns the hydration promise: the shell holds its first data-reading render on it (see App.tsx), because a
 * read fired before the stored copies are in memory pays for rows this browser already had.
 */
export function setResourceStoreUser(key: string | undefined): Promise<void> {
  diskUser = key || null;
  const hydrating = openFor(key);
  // Re-run per IDENTITY, not once per page life: signing in as someone else - or starting a simulation - is a
  // different disk namespace with its own reconciliation point, and trusting the previous identity's would
  // vouch for copies that were never checked. `trustDisk` is decided SYNCHRONOUSLY here, before hydration
  // resolves and therefore before any entry can adopt a stored copy.
  if (diskUser && syncedFor !== diskUser) {
    syncedFor = diskUser;
    const point = readSyncPoint();
    // No previous sync (or storage is off): nothing stored can be trusted, so revalidate the ordinary way. The
    // first successful sync below arms the next page load.
    trustDisk = point.at > 0;
    // Published as a promise, so a config read can wait for the verdict rather than answer ahead of it.
    reconciliation = hydrating.then(() => syncChanges(point));
  }
  return hydrating;
}

async function syncChanges(point: SyncPoint) {
  try {
    const r = await changesSince(point.at);
    // A different authz version says the caller's own permissions changed, so every stored row is suspect: the
    // rows carry the old `access.can` hints and the old redaction shape, and a collection they have just lost
    // cannot be named in the answer at all. Give the lot up. Compared for INEQUALITY - it is a hash of what
    // they may do, not a clock, so "different" is the only question it answers.
    //
    // A MISSING stamp on either side counts as MOVED, which is the opposite of what it used to do. Requiring
    // both to be present (`!!r.authz_version && !!point.authz && …`) made the one comparison that guards
    // stale redactions fail OPEN: a stored sync point with no stamp, or a response that did not carry one,
    // answered "not moved" and every stored row was adopted unchecked. Neither is reachable today - the
    // server always sends it and the write below always records it - which is exactly why it could sit there.
    // Giving the cache up costs one round of refetching; trusting it wrongly serves rows carrying permissions
    // the caller no longer holds, so the unknown case belongs on the safe side of the question.
    const authzMoved = r.authz_version !== point.authz;
    if (authzMoved || r.unknown_window) {
      trustDisk = false;
      clearCache();
      writeSyncPoint({ at: r.now, authz: r.authz_version ?? point.authz });
      return;
    }
    // Otherwise the answer names exactly the collections that have been written to. `invalidateCollections` is
    // the one path for giving those up - it drops them on disk, marks them stale in memory, refetches whatever
    // is mounted, and tells the other stores (the settings snapshot listens for exactly this).
    const stale = (r.collections ?? []).filter(Boolean);
    if (stale.length) invalidateCollections(stale);
    writeSyncPoint({ at: r.now, authz: r.authz_version ?? point.authz });
  } catch {
    // A failed reconciliation must never leave stored rows presented as fresh: give up the ones adopted from
    // disk, which puts this page life back on the ordinary freshness tiers.
    trustDisk = false;
    invalidateCollections([...adoptedFromDisk, "settings"]);
  }
}

// A tab left open all day used to reconcile exactly once, at boot: the in-session freshness tiers cover what is
// mounted, but a stored copy kept an age the next page load would trust. Coming back to a backgrounded tab is
// the moment that matters (someone returning after lunch), and it costs the same one small request.
const RESYNC_MIN_GAP_MS = 5 * 60_000;
let lastResync = Date.now();
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !diskUser) return;
    if (Date.now() - lastResync < RESYNC_MIN_GAP_MS) return;
    lastResync = Date.now();
    void syncChanges(readSyncPoint());
  });
}

type DiskRecord = { rows: unknown[]; ts: number; meta?: Record<string, unknown> };
// What `readDisk` hands back: the stored payload plus the validator it was fetched under, so a page load can
// revalidate the copy it adopted with one indexed row rather than a page of them.
type Adopted = DiskRecord & { etag?: string };

/** The stored copy of this key, parsed on demand. Kept in `hydrated` afterwards, so a key the LRU drops and
 *  something mounts again is served from here rather than re-read from the server. */
function readDisk(key: string): Adopted | null {
  const held = hydrated.get(key);
  if (!held) return null;
  try {
    const rec = JSON.parse(held.raw) as DiskRecord;
    if (!Array.isArray(rec?.rows)) return null;
    // The record store owns the timestamp now, so a payload written by an older build (or one whose `ts` did
    // not survive) still gets an honest age.
    return { rows: rec.rows, ts: typeof rec.ts === "number" ? rec.ts : held.ts, meta: rec.meta, etag: held.etag };
  } catch {
    hydrated.delete(key); // unparseable: nothing will ever get anything out of it
    return null;
  }
}

function writeDisk(e: Entry) {
  if (!diskUser || !persistable(e.collection)) return;
  // A search result or a trash view is a one-off answer to a question the user asked once: storing them would
  // grow a key per query typed and buy nothing (the next visit asks something else).
  if (e.opts.q || e.opts.deletedOnly) return;
  const key = keyOf(e.collection, e.opts);
  const raw = JSON.stringify({ rows: e.snap.rows, ts: e.ts, meta: e.snap.meta } satisfies DiskRecord);
  hydrated.set(key, { raw, ts: e.ts, etag: e.etag });
  // Queued and written off the fetch's own turn; the record store holds the class to its budget and evicts by
  // recency, so there is no cap to check and no keyspace to walk here.
  put("rows", key, raw, { collection: e.collection, etag: e.etag });
}

/** Forget the stored copies of these collections (all of them when passed nothing). */
function dropDisk(collections?: Set<string>) {
  if (!collections) {
    for (const key of [...hydrated.keys()]) {
      hydrated.delete(key);
      del("rows", key);
    }
    return;
  }
  // `hydrated` holds every stored key for this identity (hydration loads them all, and writeDisk adds its own),
  // so this is the complete set - no keyspace walk, and the entry key's own prefix IS the collection.
  for (const key of [...hydrated.keys()]) {
    if (!collections.has(key.split("?")[0]!)) continue;
    hydrated.delete(key);
    del("rows", key);
  }
}

function setSnap(e: Entry, patch: Partial<Snapshot>) {
  e.snap = { ...e.snap, ...patch };
  // Keep the truncation index in step with the snapshot that carries the cursor, so the global-bus readers
  // below can answer from a Set instead of walking every entry on every write.
  if ("meta" in patch) indexHasMore(e);
  e.subs.forEach((cb) => cb());
  globalSubs.forEach((cb) => cb());
}

// ---- Truncation ---------------------------------------------------------------------------------------------
// The server caps a list page (http/pagination.ts clampPageSize) and no collection view follows the cursor, so
// cached rows can be the FIRST PAGE rather than the whole collection. The list response says so by returning a
// `next_page_token`, which lands on `meta` above. A view that filters/sorts/exports the cached rows needs to
// know, or it presents a window as the total - so this is observable per collection, independent of which
// exact key (showDeleted / max) a given caller used: if ANY loaded key for the collection is truncated, every
// view of it is looking at a window.
const globalSubs = new Set<() => void>();

/** How many cached reads the store holds. Diagnostic for the retention test; nothing reads it at runtime. */
export const entryCount = () => entries.size;

export function subscribeAny(cb: () => void): () => void {
  globalSubs.add(cb);
  return () => {
    globalSubs.delete(cb);
  };
}

// O(1). Read on every store notification by every mounted DataTable (see useCollectionHasMore), which is why
// this is a Set lookup and not the walk over every cached entry it used to be.
export function collectionHasMore(collection: string | undefined): boolean {
  return !!collection && truncatedCollections.has(collection);
}

// Kick off a fetch if the entry is stale and not already loading. `force` bypasses the TTL (used by reload()).
export function ensureFetch(collection: string, opts: ListOpts, force = false): Promise<void> {
  const e = getEntry(collection, opts);
  // A FORCED read cannot ride an in-flight one. The request already on the wire may have been sent before the
  // write that forced this - so its answer is the state the caller is trying to leave behind, and adopting it
  // silently rolls the view back. (That is how a saved settings row kept reading as unsaved: the save's
  // invalidation landed on top of a revalidation already in flight, the pre-write rows came back, and every
  // form bound to them stayed dirty for the rest of the page's life.) Queue one behind it instead - one,
  // however many forced calls arrive, since they all want the same thing: rows read after this moment.
  if (e.inflight) {
    if (!force) return e.inflight;
    if (!e.queuedForce) {
      e.queuedForce = e.inflight
        .catch(() => {})
        .then(() => {
          e.queuedForce = null;
          return ensureFetch(collection, opts, true);
        });
    }
    return e.queuedForce;
  }
  const fresh = e.snap.state === "ready" && Date.now() - e.ts < ttlFor(collection);
  if (fresh && !force) return Promise.resolve();
  if (e.snap.state !== "ready") setSnap(e, { state: "loading" }); // keep stale rows visible while revalidating
  // A REVALIDATION, when we already hold rows and their validator: the freshness window lapsing is not evidence
  // that anything changed, and it usually hasn't. Sending the etag lets the server answer in one indexed row
  // instead of a page of them (src/http/listEtag.ts). A first load has nothing to send and reads normally.
  const validator = e.snap.state === "ready" && e.etag ? e.etag : undefined;
  // `force` is always a read prompted by a write (or by the reader asking outright), so it must not be handed
  // a request that was already on the wire before it - see the note on `fresh` in lib/getCoalescer.ts.
  // The other half of that ordering problem: an ordinary revalidation already on the wire when a write happens
  // answers with the state BEFORE the write. Nothing forces a re-read after it (a reaction, a vote, a read
  // receipt all invalidate nothing by design - the verb hands its own reserialized row back and the page folds
  // it in), so adopting that answer rolls the card back to the pre-write shape and leaves it there until
  // something unrelated reloads the collection. That is how a reaction switched away from could reappear on the
  // board, minutes after the server had cleared it. So: remember when this request left, and refuse its answer
  // if the rows were written locally in the meantime - reading again in its place, since an answer merely
  // dropped would leave the entry at the age it already had and nothing would correct it.
  //
  // Narrowly, though: only a REVALIDATION can roll anything back, because only it has rows to roll back TO. A
  // first load holds nothing, so there is nothing for a local write to lose and no reason to spend a second
  // request - it adopts the answer, exactly as it did before, and the write's own invalidation (where it has
  // one) reads again anyway. Boot is all first loads, and a forced re-read there is a request per raced
  // collection on a plan that counts them (see `docs/` on D1 reads).
  const startedAt = Date.now();
  const hadRows = e.snap.state === "ready" && e.snap.rows.length > 0;
  e.inflight = listConditional<unknown>(collection, opts, validator, force)
    .then((answer) => {
      if (hadRows && e.patchedAt >= startedAt) {
        // Queued rather than called straight: this request's own `finally` has not cleared `inflight` yet, so a
        // direct call would be parked behind it as a queued force anyway - same read, one step less.
        void Promise.resolve().then(() => ensureFetch(collection, opts, true));
        return;
      }
      e.ts = Date.now();
      if (answer.notModified) {
        // The rows we hold ARE the answer. Re-stamp them so the window starts again, and store that - a
        // reload should not have to re-establish what this just confirmed.
        e.fromDisk = false;
        writeDisk(e);
        setSnap(e, {}); // notify: a view waiting on `loading` has its answer now
        return;
      }
      e.fromDisk = false; // these rows came from the server, not from the stored copy
      e.etag = answer.etag;
      const { results, ...meta } = answer.response as { results?: unknown[] } & Record<string, unknown>;
      const rows = results ?? [];
      setSnap(e, { rows, state: "ready", error: null, meta });
      writeDisk(e); // so the next page life can skip this read entirely
      // Passive cross-tab share: whichever tab fetched hands the fresh rows to every sibling, so a subscribed
      // sibling adopts them (below) with NO request of its own. Free - the fetch already happened here.
      publish(TOPIC_ROWS, { key: keyOf(collection, opts), rows, ts: e.ts, startedAt, meta, etag: e.etag } satisfies RowsMsg);
    })
    .catch((err) => {
      setSnap(e, { state: "error", error: (err as Error).message });
    })
    .finally(() => {
      e.inflight = null;
    });
  return e.inflight;
}

// Follow the server cursor: fetch the NEXT page for this key and append it to the cached rows. No-op while a
// fetch is in flight or when the last response carried no next_page_token (nothing further to load). Appended
// pages ride the same snapshot, so every subscriber (and the truncation flag) updates together.
export function loadMoreRows(collection: string, opts: ListOpts): Promise<void> {
  const e = getEntry(collection, opts);
  if (e.inflight) return e.inflight;
  const token = (e.snap.meta as { next_page_token?: string } | undefined)?.next_page_token;
  if (!token) return Promise.resolve();
  e.inflight = list<unknown>(collection, { ...e.opts, pageToken: token })
    .then((resp) => {
      e.ts = Date.now();
      const { results, ...meta } = resp as { results?: unknown[] } & Record<string, unknown>;
      const rows = [...e.snap.rows, ...(results ?? [])];
      setSnap(e, { rows, state: "ready", error: null, meta });
      // Carries THIS entry's validator, unchanged: a follow-on page does not mint one (the etag describes the
      // first page, which is still what a revalidation asks about). Sending the message without it set the
      // sibling's etag to undefined, so the sibling then re-read a whole page where this tab spends one
      // indexed row - and lost the pages it had just adopted whenever nothing had changed.
      publish(TOPIC_ROWS, { key: keyOf(collection, opts), rows, ts: e.ts, meta, etag: e.etag } satisfies RowsMsg);
    })
    .catch((err) => {
      setSnap(e, { state: "error", error: (err as Error).message });
    })
    .finally(() => {
      e.inflight = null;
    });
  return e.inflight;
}

export function subscribe(collection: string, opts: ListOpts, cb: () => void): () => void {
  const e = getEntry(collection, opts);
  e.subs.add(cb);
  return () => {
    e.subs.delete(cb);
    // A search result (or the trash view) is a one-off answer, so it dies with its last reader rather than
    // being retained until reload. Anything else stays cached for the TTL and is LRU-capped instead.
    if (e.subs.size === 0 && !e.inflight && ephemeral(e)) dropEntry(e);
  };
}

export function getSnapshot(collection: string, opts: ListOpts): Snapshot {
  return getEntry(collection, opts).snap;
}

// Optimistic local edit shared across every subscriber of this exact key (e.g. flip a notification to read).
// Stamped, because these rows are now AHEAD of anything already on the wire: see `patchedAt` in ensureFetch.
export function patchRows(collection: string, opts: ListOpts, updater: (prev: unknown[]) => unknown[]) {
  const e = getEntry(collection, opts);
  e.patchedAt = Date.now();
  setSnap(e, { rows: updater(e.snap.rows) });
}

// Invalidate every cached key of the given collections and refetch the ones with live subscribers (so mounted
// views update immediately; unobserved keys just drop and reload lazily on next mount). Returns the subset of
// `collections` this tab did NOT refetch (no live subscriber here) - the caller broadcasts those so a sibling
// that IS showing them refetches instead; the ones we did refetch reach siblings for free via TOPIC_ROWS.
// Listeners for "these collections were just written". Cached rows refresh themselves (below), but a derived
// SERVER aggregate over them - the approvals badge's counts, which are not a collection and so have no cached
// key - has no other way to learn that its number moved. Fires for a local write and for a sibling tab's
// (TOPIC_INVAL routes through here too), so one subscription covers both.
const invalidationSubs = new Set<(collections: string[]) => void>();

export function subscribeInvalidations(cb: (collections: string[]) => void): () => void {
  invalidationSubs.add(cb);
  return () => {
    invalidationSubs.delete(cb);
  };
}

export function invalidateCollections(collections: string[]): string[] {
  invalidationSubs.forEach((cb) => cb(collections));
  const set = new Set(collections);
  const notRefetched = new Set(collections);
  // Drop the stored copies FIRST: a written collection's disk rows are known-stale, and a reload must not
  // adopt them (the refetch below may not even happen if nothing is mounted).
  dropDisk(set);
  for (const e of entries.values()) {
    if (!set.has(e.collection)) continue;
    e.ts = 0; // mark stale
    if (e.subs.size > 0) {
      void ensureFetch(e.collection, e.opts, true);
      notRefetched.delete(e.collection);
    }
  }
  return [...notRefetched];
}

/**
 * Re-read everything currently ON SCREEN, and resolve when it has all landed. This is what a deliberate
 * refresh gesture means (see components/layout/PullToRefresh): the user is asking about the rows they are
 * looking at, not asking to empty a cache. Unsubscribed keys are deliberately left alone - re-reading a
 * collection nothing is mounted on would spend D1 reads on rows nobody is waiting for, and it would be
 * re-read on its next mount anyway.
 *
 * Errors are swallowed: ensureFetch already puts a failure on the entry's own snapshot, where the page
 * renders it in context. The gesture only needs to know when to stop spinning.
 */
export function refetchMounted(): Promise<void> {
  const inflight: Promise<unknown>[] = [];
  for (const e of entries.values()) {
    if (e.subs.size === 0) continue;
    inflight.push(ensureFetch(e.collection, e.opts, true).catch(() => {}));
  }
  return Promise.all(inflight).then(() => {});
}

/**
 * Forget every cached read, in memory and on disk. The crash boundary's retry calls this: a page that died
 * rendering a row the store is holding would die identically on the next render, because a remount reads the
 * same cache. Subscribed keys refetch immediately (their entry object has to survive - useSyncExternalStore
 * registered its callback on it), unsubscribed ones are simply dropped and re-read when something mounts them.
 */
export function clearCache(): void {
  dropDisk();
  // Everything DERIVED from these rows has to go too - the org settings snapshot, the approvals badge, the
  // cached faces. Each of those is its own store with no cached key here to drop, so they say so themselves
  // rather than this module keeping a list of what they are.
  purgeSubs.forEach((cb) => cb());
  for (const e of [...entries.values()]) {
    e.ts = 0; // mark stale
    if (e.subs.size === 0 && !e.inflight) dropEntry(e);
    else void ensureFetch(e.collection, e.opts, true);
  }
}

// "Give up everything you have stored." Distinct from subscribeInvalidations, which names collections: this
// fires when no collection is the reason - the caller's own access changed, or a crash boundary is retrying -
// and every derived store has to start again from nothing.
const purgeSubs = new Set<() => void>();

export function subscribePurge(cb: () => void): () => void {
  purgeSubs.add(cb);
  return () => {
    purgeSubs.delete(cb);
  };
}

// ---- Cross-tab coherence -----------------------------------------------------
// A tab's own writes go through api.ts -> invalidateCollections here, then broadcast (api.ts) so siblings stay
// consistent WITHOUT each re-reading. Two topics:
//   TOPIC_ROWS  - fresh rows a sibling fetched; adopt them if we hold that exact key (else ignore, we'll fetch
//                 lazily on next mount). Guarded by ts so an older broadcast never clobbers newer local rows.
//   TOPIC_INVAL - collections a sibling wrote but couldn't refetch locally; mark stale + refetch our subscribed
//                 keys (one of us reads, then shares via TOPIC_ROWS). Applied WITHOUT re-broadcasting (no loop).
const TOPIC_ROWS = "rs:rows";
const TOPIC_INVAL = "rs:inval";
// `startedAt` is when the SIBLING's request left, not when it landed: a receiving tab that has written to these
// rows since then is ahead of the answer, however recently the answer arrived (same ordering as ensureFetch).
type RowsMsg = { key: string; rows: unknown[]; ts: number; startedAt?: number; meta?: Record<string, unknown>; etag?: string };

subscribeTopic<RowsMsg>(TOPIC_ROWS, ({ key, rows, ts, startedAt, meta, etag }) => {
  const e = entries.get(key);
  if (!e || ts <= e.ts) return; // not observed here, or we already hold equal/newer rows
  if (e.patchedAt >= (startedAt ?? ts)) return; // a read that left before our own write is behind us, not ahead
  e.ts = ts;
  e.etag = etag; // the sibling's validator describes these exact rows, so it is ours to revalidate with
  setSnap(e, { rows, state: "ready", error: null, meta });
  writeDisk(e); // a sibling's fetch is as good as our own - store it so a reload can reuse it
});

subscribeTopic<{ collections: string[] }>(TOPIC_INVAL, ({ collections }) => {
  invalidateCollections(collections); // local only - never rebroadcast a remote invalidation
});

// Broadcast a write's fallout to sibling tabs. Called by api.ts after a local write has invalidated the store.
export function broadcastInvalidation(notRefetched: string[]) {
  if (notRefetched.length) publish(TOPIC_INVAL, { collections: notRefetched });
}

// Verbs (invoke / lifecycle custom methods) that mutate MORE than the collection in their path. Keeps the
// notification bell + dependent collections fresh after an action. Unmapped verbs invalidate only their own
// collection (the common case). Add an entry when a new verb writes across collections.
const VERB_SIDE_EFFECTS: Record<string, string[]> = {
  "leave-requests:approve": ["leave-requests", "leave-balances", "notifications"],
  "leave-requests:reject": ["leave-requests", "leave-balances", "notifications"],
  "leave-requests:cancel": ["leave-requests", "leave-balances", "notifications"],
  "leave-requests:upload": ["leave-requests"], // the has_document flag lives on the request row
  "reimbursements:approve": ["reimbursements", "notifications"],
  "reimbursements:reject": ["reimbursements", "notifications"],
  "reimbursements:pay": ["reimbursements", "notifications"],
  "loans:approve": ["loans", "notifications"],
  "loans:reject": ["loans", "notifications"],
  "loans:disburse": ["loans", "notifications"],
  "overtime-requests:approve": ["overtime-requests", "notifications"],
  "overtime-requests:reject": ["overtime-requests", "notifications"],
  "remote-work-requests:approve": ["remote-work-requests", "notifications"],
  "remote-work-requests:reject": ["remote-work-requests", "notifications"],
  "asset-requests:approve": ["asset-requests", "notifications"],
  "asset-requests:reject": ["asset-requests", "notifications"],
  "asset-requests:cancel": ["asset-requests", "notifications"],
  // Issuing hands over a real asset, so the inventory changes too (the asset lands in pending_ack).
  "asset-requests:issue": ["asset-requests", "assets", "notifications"],
  // A sighting hands back the reserialized asset and every caller folds that row straight into the store, so
  // refetching would buy nothing - and a hundred-item stocktake walk would otherwise cost a hundred list reads.
  "assets:verify": [],
  // A delivery adds rows nobody has yet, so the inventory has to be refetched (the response carries them, but
  // every list showing assets - the page, the profile card, the printer's picker - reads them from the store).
  "assets:batchCreate": ["assets"],
  // Closing a count writes its snapshot and raises the "we couldn't find your kit" notices; nothing on the
  // asset rows changes (not finding something proves nothing about the thing).
  "stocktakes:close": ["stocktakes", "notifications"],
  "stocktakes:recordFound": [],
  "attendance-regularizations:approve": ["attendance-regularizations", "attendance", "notifications"],
  // Only APPROVAL rewrites the day's punches (the write is guarded on it in
  // services/attendanceRegularizations.ts); reject and cancel just close the request. They carry `attendance`
  // anyway because all three are one handler, so test/verbInvalidationDrift.test.ts - which reads the handler,
  // not its branches - attributes the write to each of them. One extra list read on a refusal is the right
  // price for a check that cannot be argued with about which branch ran.
  "attendance-regularizations:reject": ["attendance-regularizations", "attendance", "notifications"],
  "attendance-regularizations:cancel": ["attendance-regularizations", "attendance", "notifications"],
  "leave-encashments:approve": ["leave-encashments", "leave-balances", "notifications"],
  "leave-encashments:reject": ["leave-encashments", "notifications"],
  // Cancelling gives the days back, so the balance moves here exactly as it does on approval.
  "leave-encashments:cancel": ["leave-encashments", "leave-balances", "notifications"],
  "time-entries:approve": ["time-entries", "notifications"],
  "time-entries:reject": ["time-entries", "notifications"],
  // Hiring a candidate is the widest write in the app: it creates the employee, seeds their compensation and
  // (via the "Onboard a new hire" automation) opens their onboarding checklist and its tasks. Both routes into
  // it invalidate the same set, so the Onboarding page the pipeline hands off to reads the new rows.
  // `referrals` because a hire closes the referral that produced the candidate (and starts its bonus clock),
  // so the referrer's own list is wrong the moment this lands.
  "applications:hire": ["applications", "employees", "transitions", "transition-tasks", "compensation", "referrals", "notifications"],
  // A stage move runs the pipeline's rules inside the same request, so the records they create - a drafted
  // offer, a booked round, the hire itself - are already there when the response lands.
  "applications:advance": ["applications", "offers", "interviews", "job-requisitions", "employees", "transitions", "notifications"],
  "applications:reject": ["applications", "job-requisitions", "notifications"],
  "offers:accept": ["offers", "applications", "employees", "transitions", "transition-tasks", "compensation", "referrals", "notifications"],
  // Appending a task adds a row the checklist is showing.
  "transitions:appendTask": ["transitions", "transition-tasks", "notifications"],
  // COMPLETING an offboarding moves the person: terminated + disabled, and their login disabled with them
  // (services/transitions.ts terminateForOffboarding). Cancel and reopen do not - but all three are one
  // handler, so the drift test attributes the write to each; see the note on the regularization verbs above
  // for why they carry it rather than the check being taught about branches.
  "transitions:complete": ["transitions", "employees", "users", "notifications"],
  "transitions:cancel": ["transitions", "employees", "users", "notifications"],
  "transitions:reopen": ["transitions", "employees", "users", "notifications"],
  // Launching (or enrolling into) a cycle CREATES the reviews - the whole point of the press - and awarding
  // variable pay writes the bonuses it reported.
  "review-cycles:launch": ["review-cycles", "reviews", "notifications"],
  "review-cycles:enroll": ["review-cycles", "reviews", "notifications"],
  "review-cycles:award": ["review-cycles", "bonuses", "notifications"],
  // `:variablePay` computes and reports; it writes nothing (the award is the second press).
  "review-cycles:variablePay": [],
  // Nominating a peer and accepting a suggested one both file the feedback request itself.
  "reviews:nominate": ["reviews", "review-feedback", "notifications"],
  "reviews:suggestFeedback": ["reviews", "review-feedback", "notifications"],
  // A template stamps real goals onto real people - the row this verb answers with is the template, and the
  // rows a reader wants to see are the goals.
  "goal-templates:apply": ["goal-templates", "goals", "notifications"],
  // Default enrolment creates the enrollment rows the Benefits tab lists.
  "employees:enrollDefaultBenefits": ["employees", "benefit-enrollments", "notifications"],
  // Closing a sprint moves every unfinished card out of it.
  "sprints:complete": ["sprints", "cards", "notifications"],
  // Publishing a run starts the payslip-generation Operation, so the job appears on the Operations page. The
  // payslips themselves are written by that job, minutes later and out of band - a refetch here cannot see
  // them, which is what the job's own progress is for.
  "payroll-runs:publish": ["payroll-runs", "operations", "notifications"],
  "suggestions:respond": ["suggestions", "notifications"],
  // Votes hand back the reserialized suggestion and the page folds it in (optimistically applied first) -
  // same no-refetch shape as the board verbs below.
  "suggestions:upvote": [],
  "suggestions:downvote": [],
  // The board's own verbs hand back the fully reserialized post, and the feed folds that row straight into the
  // store - so refetching the whole board after each of them would buy nothing and cost a D1 read per reaction,
  // reply, vote, and per post scrolled past (markRead fires on dwell).
  "announcements:markRead": [],
  "announcements:react": [],
  // A reply hands back the reserialized post like its siblings, so the FEED needs no refetch - but it also
  // tells the post's author, and the bell is not the feed. `["notifications"]` is the pair said properly:
  // nothing for the board, one read for the thing that did change.
  "announcements:reply": ["notifications"],
  "announcements:vote": [],
  // Pin/unpin also hand back the reserialized post; the feed folds it in and re-sorts locally.
  "announcements:pin": [],
  "announcements:unpin": [],
  // Mark-all-read stamps receipts on many posts at once and hands back only a count, so the board has to
  // refetch to pick up the new read state.
  "announcements:markAllRead": ["announcements"],
  "announcements:publish": ["announcements", "notifications"],
  "notifications:markAllRead": ["notifications"],
  // The three collection-level methods that FILE a document: a generated letter, a generated Form 16, and the
  // official TRACES upload. Each one adds a row that every mounted list of somebody's documents is showing -
  // the profile's Documents card, the Documents page - so the collection has to be refetched. They used to go
  // out through the raw `api()` helper, which invalidates nothing, and the row they created appeared only
  // after a reload.
  "personal-documents:generateLetter": ["personal-documents"],
  "personal-documents:generateForm16": ["personal-documents"],
  "personal-documents:uploadForm16": ["personal-documents"],
};

// Collections a mutation on `path` (custom `verb` optional) should invalidate.
export function affectedCollections(path: string, verb?: string): string[] {
  const collection = path.split("?")[0]!.split("/")[0]!;
  if (verb) {
    const mapped = VERB_SIDE_EFFECTS[`${collection}:${verb}`];
    if (mapped) return mapped;
    // AN UNMAPPED VERB REFRESHES ITS OWN COLLECTION AND THE BELL.
    //
    // The map is hand-maintained and the fallback used to be `[collection]`, with a DEV-only console.debug as
    // the entire drift signal - so a verb added without an entry under-invalidated silently, and several had:
    // `expenses:approve/reject/pay` notified the submitter while their sibling `reimbursements:*` (identical
    // shape, one collection over) were mapped and refreshed the bell, which is exactly the asymmetry nobody
    // spots by reading either entry.
    //
    // Notifications are what nearly every unmapped verb has in common, because almost every verb in this app
    // tells SOMEBODY: an approval, a rejection, an assignment, a comment, a nudge. Guessing "it might notify"
    // costs one indexed list read; guessing "it cannot" leaves the bell wrong, which is the half of the UI a
    // person checks to find out whether their action reached anyone. So the default errs toward the read.
    //
    // A verb that genuinely refreshes NOTHING (the board's react/vote/markRead, which fold the reserialized
    // row back in themselves) still says so explicitly, as `[]` - the map is where a no-refetch decision is
    // recorded, and `[]` is a decision. test/verbInvalidationDrift.test.ts holds the map against the verbs'
    // own handlers, so a verb that writes a DIFFERENT collection cannot ride this default.
    //
    // Built on `always` rather than on `[collection]`, so the card->goal rollup below still applies to a card
    // VERB (`:move` is the commonest write on the board, and it is the one that changes a goal's progress).
    return [...always(collection), "notifications"];
  }
  return always(collection);
}

/** What any write to `collection` refreshes, verb or not. */
function always(collection: string): string[] {
  // A card's delivery/link/size/removal rolls up into its goal's progress server-side (recomputeGoalProgress),
  // and this holds for every card write (move verb, create, PATCH, delete) - so always refresh goals too.
  return collection === "cards" ? ["cards", "goals"] : [collection];
}

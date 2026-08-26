// Shared client-side cache for collection reads. Without it, every component that calls useCollection fires
// its own HTTP request, so "employees" alone is fetched 30+ times per session. The store gives three things:
//   1. in-flight dedup - concurrent identical reads share ONE promise (the biggest request-count win),
//   2. a short TTL so navigations within the window reuse the cached rows instead of refetching,
//   3. subscribe/notify + mutation-driven invalidation so a write refreshes every mounted view of a collection.
// Cloudflare caps request COUNT (not payload), so collapsing duplicate reads is the lever.
import { list, changesSince } from "@/api";
import { publish, subscribeTopic } from "@/lib/crossTabBus";

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

const CATALOG_COLLECTIONS = new Set([
  "departments", "leave-types", "pay-components", "pay-grades", "salary-structures", "pay-periods", "holidays",
  "projects", "shifts", "asset-categories", "expense-categories", "reimbursement-categories", "vendors",
  "benefit-plans", "letter-templates", "bank-formats", "ticket-checklists", "roles", "compliance-rules",
  "leave-encashment-rules", "board-templates",
]);
const SEMI_COLLECTIONS = new Set(["employees"]);

/** How long a loaded copy of this collection may be reused before it is read again. */
export const freshnessMs = (collection: string) =>
  CATALOG_COLLECTIONS.has(collection) ? TTL_CATALOG_MS : SEMI_COLLECTIONS.has(collection) ? TTL_SEMI_MS : TTL_DEFAULT_MS;
const ttlFor = freshnessMs;

// Everything non-ephemeral is worth storing now, not just the long tiers. Before the change feed below, a
// stored copy of a 20-second collection was pointless - it was stale by the time the page loaded again, so it
// bought a faster first paint and no fewer reads. With `GET /v1/changes` answering "has this collection been
// written to", a stored copy is trustworthy however old it is, so a reload can serve leave requests, tickets and
// board cards from disk too. What stays out is decided in writeDisk: searches and trash views (one-off answers).
const persistable = (_collection: string) => true;

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
  subs: Set<() => void>;
  fromDisk?: boolean; // adopted from the stored copy and not re-read since - see syncChanges
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

function indexHasMore(e: Entry) {
  const has = Boolean((e.snap.meta as { next_page_token?: string } | undefined)?.next_page_token);
  if (has) hasMoreByCollection.set(e.key, true);
  else hasMoreByCollection.delete(e.key);
  // Recompute the collection's flag from its own keys only (a handful), never the whole map.
  let any = false;
  for (const other of entries.values()) {
    if (other.collection !== e.collection) continue;
    if (hasMoreByCollection.get(other.key)) {
      any = true;
      break;
    }
  }
  if (any) truncatedCollections.add(e.collection);
  else truncatedCollections.delete(e.collection);
}

// `m` mirrors the page size api.ts actually sends (capped at the server's 100), so two callers that differ only
// in an over-100 `max` share one cache entry instead of each minting a key for a page neither can get.
const keyOf = (collection: string, opts: ListOpts) =>
  `${collection}?d=${opts.deletedOnly ? 2 : opts.showDeleted ? 1 : 0}&m=${Math.min(opts.max ?? 100, 100)}&q=${opts.q ?? ""}&p=${paramsKey(opts.params)}`;

function getEntry(collection: string, opts: ListOpts): Entry {
  const key = keyOf(collection, opts);
  let e = entries.get(key);
  if (!e) {
    e = { key, collection, opts, snap: { rows: [], state: "loading", error: null }, ts: 0, inflight: null, subs: new Set() };
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
      e.snap = { rows: disk.rows, state: "ready", error: null, meta: disk.meta };
    }
  }
  return e;
}

// ---- Disk layer (localStorage) -------------------------------------------------------------------------------
// A reload used to start from nothing: every collection the first screen touches was read again, even the
// department list nobody had edited in months. Persisting the long-lived tiers means a reload (or a second visit
// in the same browser) serves them from disk and pays for no read at all.
//
// Bounded and disposable by construction:
//   - keyed by the CALLER (and their active simulation), so nobody ever adopts another identity's rows,
//   - versioned, so a shape change orphans old copies instead of deserialising them,
//   - size-capped per entry, and the whole namespace is dropped if the browser refuses a write (quota),
//   - only ever a cache: any read that finds nothing behaves exactly as before.
const DISK_PREFIX = "rs1:"; // bump the digit to orphan every stored copy after a shape change
const DISK_MAX_BYTES = 96 * 1024; // one entry; a bigger payload isn't worth a quota risk
// Every collection is stored now (not just the two long tiers), each with a few option variants, so the cap is
// higher - and reaching it evicts the oldest fifth rather than everything (evictOldestDisk). Real entries are a
// few KB; the per-entry ceiling above is what bounds the worst case, and a quota refusal drops to memory-only.
const DISK_MAX_ENTRIES = 150;
let diskUser: string | null = null; // set by setResourceStoreUser; until then, disk is off
let diskOk = true; // flipped off for the session if storage throws (private mode, quota)
// The keys this page life has stored, so the entry cap is a Set size instead of a walk over every key in the
// origin. Seeded lazily on first write (a reload starts with whatever the last one left behind).
let owned: Set<string> = new Set();
let ownedSeeded = false;

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
const SYNC_KEY = "rs1sync:"; // `${SYNC_KEY}<user>` -> { at: <server ms at the last successful sync> }
let trustDisk = false; // set once the sync is in flight with a usable `since`
let syncedFor: string | null = null; // the identity the current reconciliation belongs to
// Collections served from a stored copy this page life. If the reconciliation cannot vouch for them after all,
// these are exactly the ones to give up - the rest were read from the server anyway.
const adoptedFromDisk = new Set<string>();

const syncKey = () => `${SYNC_KEY}${diskUser}`;

function readSyncedAt(): number {
  try {
    const raw = localStorage.getItem(syncKey());
    const at = raw ? (JSON.parse(raw) as { at?: number }).at : undefined;
    return typeof at === "number" && at > 0 ? at : 0;
  } catch {
    return 0;
  }
}

function writeSyncedAt(at: number) {
  try {
    localStorage.setItem(syncKey(), JSON.stringify({ at }));
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

/** The identity everything stored is namespaced to, or null before it is known. Other stores key their own
 *  copies off this so a browser shared by two people (or a running simulation) never serves one of them the
 *  other's numbers. */
export const storedIdentity = () => diskUser;

/** Namespace the disk cache to the signed-in caller (plus any active "view as" subject), then reconcile what is
 *  stored with what has been written since we last looked. */
export function setResourceStoreUser(key: string | undefined) {
  diskUser = key || null;
  // Re-run per IDENTITY, not once per page life: signing in as someone else - or starting a simulation - is a
  // different disk namespace with its own reconciliation point, and trusting the previous identity's would
  // vouch for copies that were never checked.
  if (diskUser && syncedFor !== diskUser) {
    syncedFor = diskUser;
    trustDisk = false;
    void syncChanges();
  }
}

async function syncChanges() {
  const since = readSyncedAt();
  // No previous sync (or storage is off): nothing stored can be trusted, so behave exactly as before. The first
  // successful sync below arms the next page load.
  if (since > 0) trustDisk = true;
  try {
    const r = await changesSince(since);
    // Either the server cannot speak for a gap this wide, or it named collections that have been written to.
    // In both cases the answer is the same shape: give up the copies in question. `invalidateCollections` is
    // the one path for that - it drops them on disk, marks them stale in memory, refetches whatever is mounted,
    // and tells the other stores (the settings snapshot listens for exactly this).
    const stale = r.unknown_window ? [...adoptedFromDisk, "settings"] : (r.collections ?? []).filter(Boolean);
    if (r.unknown_window) trustDisk = false;
    if (stale.length) invalidateCollections(stale);
    writeSyncedAt(r.now);
  } catch {
    // A failed reconciliation must never leave stored rows presented as fresh: give up the ones adopted from
    // disk, which puts this page life back on the ordinary freshness tiers.
    trustDisk = false;
    invalidateCollections([...adoptedFromDisk, "settings"]);
  }
}

const diskKey = (key: string) => `${DISK_PREFIX}${diskUser}:${key}`;

type DiskRecord = { rows: unknown[]; ts: number; meta?: Record<string, unknown> };

function readDisk(key: string): DiskRecord | null {
  if (!diskUser || !diskOk) return null;
  try {
    const raw = localStorage.getItem(diskKey(key));
    if (!raw) return null;
    const rec = JSON.parse(raw) as DiskRecord;
    return Array.isArray(rec?.rows) && typeof rec.ts === "number" ? rec : null;
  } catch {
    return null;
  }
}

/** The stored keys we already own, read once per page life rather than on every write. */
function seedOwned(): void {
  if (ownedSeeded) return;
  ownedSeeded = true;
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k?.startsWith(DISK_PREFIX)) owned.add(k);
  }
}

function writeDisk(e: Entry) {
  if (!diskUser || !diskOk || !persistable(e.collection)) return;
  // A search result or a trash view is a one-off answer to a question the user asked once: storing them would
  // grow a key per query typed and buy nothing (the next visit asks something else).
  if (e.opts.q || e.opts.deletedOnly) return;
  try {
    const payload = JSON.stringify({ rows: e.snap.rows, ts: e.ts, meta: e.snap.meta } satisfies DiskRecord);
    if (payload.length > DISK_MAX_BYTES) return;
    seedOwned();
    const key = diskKey(keyOf(e.collection, e.opts));
    // Counted from our own set of keys rather than by walking the whole localStorage keyspace, which this did on
    // every persistable fetch - and every other origin's keys are in that walk too.
    if (!owned.has(key) && owned.size >= DISK_MAX_ENTRIES) evictOldestDisk();
    localStorage.setItem(key, payload);
    owned.add(key);
  } catch {
    // Out of quota (or storage denied): drop everything we own and stop trying for this page life. The store
    // keeps working entirely in memory.
    diskOk = false;
    dropDisk();
  }
}

/**
 * Make room by dropping the OLDEST stored copies, a fifth of the cap at a time.
 *
 * This used to drop everything at the cap, which was defensible while only the two long tiers were stored (a
 * couple of dozen keys, rarely reached). Now that every collection is stored, reaching the cap is ordinary - and
 * wiping the lot would mean the next page load re-read everything, which is the cost this whole mechanism
 * exists to avoid. Oldest-first keeps what is most likely to be wanted again.
 */
function evictOldestDisk() {
  try {
    seedOwned();
    const aged = [...owned].map((k) => {
      let ts = 0;
      try {
        ts = (JSON.parse(localStorage.getItem(k) ?? "{}") as { ts?: number }).ts ?? 0;
      } catch {
        /* unparseable: age 0, so it goes first */
      }
      return { k, ts };
    });
    aged.sort((a, b) => a.ts - b.ts);
    for (const { k } of aged.slice(0, Math.max(1, Math.ceil(DISK_MAX_ENTRIES / 5)))) {
      localStorage.removeItem(k);
      owned.delete(k);
    }
  } catch {
    dropDisk(); // storage is misbehaving: fall back to the blunt instrument
  }
}

/** Forget the stored copies of these collections (all of them when passed nothing). */
function dropDisk(collections?: Set<string>) {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k?.startsWith(DISK_PREFIX)) continue;
      if (collections) {
        // key shape: "rs1:<user>:<collection>?<opts>"
        const collection = k.slice(DISK_PREFIX.length).split(":").slice(1).join(":").split("?")[0];
        if (!collection || !collections.has(collection)) continue;
      }
      localStorage.removeItem(k);
      owned.delete(k);
    }
  } catch {
    /* nothing we can do; memory-only from here */
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
  if (e.inflight) return e.inflight;
  const fresh = e.snap.state === "ready" && Date.now() - e.ts < ttlFor(collection);
  if (fresh && !force) return Promise.resolve();
  if (e.snap.state !== "ready") setSnap(e, { state: "loading" }); // keep stale rows visible while revalidating
  e.inflight = list<unknown>(collection, opts)
    .then((resp) => {
      e.ts = Date.now();
      e.fromDisk = false; // these rows came from the server, not from the stored copy
      const { results, ...meta } = resp as { results?: unknown[] } & Record<string, unknown>;
      const rows = results ?? [];
      setSnap(e, { rows, state: "ready", error: null, meta });
      writeDisk(e); // so the next page life can skip this read entirely
      // Passive cross-tab share: whichever tab fetched hands the fresh rows to every sibling, so a subscribed
      // sibling adopts them (below) with NO request of its own. Free - the fetch already happened here.
      publish(TOPIC_ROWS, { key: keyOf(collection, opts), rows, ts: e.ts, meta } satisfies RowsMsg);
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
      publish(TOPIC_ROWS, { key: keyOf(collection, opts), rows, ts: e.ts, meta } satisfies RowsMsg);
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
export function patchRows(collection: string, opts: ListOpts, updater: (prev: unknown[]) => unknown[]) {
  const e = getEntry(collection, opts);
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
      ensureFetch(e.collection, e.opts, true);
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
  for (const e of [...entries.values()]) {
    e.ts = 0; // mark stale
    if (e.subs.size === 0 && !e.inflight) dropEntry(e);
    else ensureFetch(e.collection, e.opts, true);
  }
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
type RowsMsg = { key: string; rows: unknown[]; ts: number; meta?: Record<string, unknown> };

subscribeTopic<RowsMsg>(TOPIC_ROWS, ({ key, rows, ts, meta }) => {
  const e = entries.get(key);
  if (!e || ts <= e.ts) return; // not observed here, or we already hold equal/newer rows
  e.ts = ts;
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
  "asset-requests:cancel": ["asset-requests"],
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
  "attendance-regularizations:reject": ["attendance-regularizations", "notifications"],
  "leave-encashments:approve": ["leave-encashments", "leave-balances", "notifications"],
  "leave-encashments:reject": ["leave-encashments", "notifications"],
  "time-entries:approve": ["time-entries", "notifications"],
  "time-entries:reject": ["time-entries", "notifications"],
  // Hiring a candidate is the widest write in the app: it creates the employee, seeds their compensation and
  // (via the "Onboard a new hire" automation) opens their onboarding checklist and its tasks. Both routes into
  // it invalidate the same set, so the Onboarding page the pipeline hands off to reads the new rows.
  "applications:hire": ["applications", "employees", "transitions", "transition-tasks", "compensation", "notifications"],
  // A stage move runs the pipeline's rules inside the same request, so the records they create - a drafted
  // offer, a booked round, the hire itself - are already there when the response lands.
  "applications:advance": ["applications", "offers", "interviews", "job-requisitions", "employees", "transitions", "notifications"],
  "applications:reject": ["applications", "job-requisitions", "notifications"],
  "offers:accept": ["offers", "applications", "employees", "transitions", "transition-tasks", "compensation", "notifications"],
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
  "announcements:reply": [],
  "announcements:vote": [],
  // Pin/unpin also hand back the reserialized post; the feed folds it in and re-sorts locally.
  "announcements:pin": [],
  "announcements:unpin": [],
  // Mark-all-read stamps receipts on many posts at once and hands back only a count, so the board has to
  // refetch to pick up the new read state.
  "announcements:markAllRead": ["announcements"],
  "announcements:publish": ["announcements", "notifications"],
  "notifications:markAllRead": ["notifications"],
};

// Collections a mutation on `path` (custom `verb` optional) should invalidate.
export function affectedCollections(path: string, verb?: string): string[] {
  const collection = path.split("?")[0]!.split("/")[0]!;
  if (verb) {
    const mapped = VERB_SIDE_EFFECTS[`${collection}:${verb}`];
    if (mapped) return mapped;
    if (import.meta.env?.DEV && collection !== "preferences" && collection !== "cards") {
      // Surface drift: a multi-collection verb with no map entry under-invalidates.
      console.debug(`[resourceStore] invoke ${collection}:${verb} not in VERB_SIDE_EFFECTS; invalidating only ${collection}`);
    }
  }
  // A card's delivery/link/size/removal rolls up into its goal's progress server-side (recomputeGoalProgress),
  // and this holds for every card write (move verb, create, PATCH, delete) - so always refresh goals too.
  if (collection === "cards") return ["cards", "goals"];
  return [collection];
}

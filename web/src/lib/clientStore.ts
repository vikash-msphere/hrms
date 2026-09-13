// The one owner of everything this app keeps in the browser.
//
// WHY IT EXISTS. Four caches (collection rows, employee faces, the settings snapshot, the approvals badge) each
// grew their own copy of the same three problems - namespace it to an identity, bound it, survive a refusal to
// write - and each solved them differently and incompletely. The row cache alone was provisioned for 150 entries
// of up to 96 KiB and the photo cache for 200 of up to 48 KiB, which is around 24 million characters against a
// localStorage budget of roughly five million: they competed for the same quota, and each answered the resulting
// failure by throwing away everything it had stored and giving up on disk for the rest of the page life. So the
// mechanism that exists to make a reload cheap was reliably disarming itself on the sessions that needed it most.
//
// Nothing swept anything, either: bumping a cache's version prefix orphaned its old copies rather than deleting
// them, an identity that signed out left its rows and faces on disk forever, and eviction read (and JSON-parsed)
// every stored payload on the main thread just to find out which was oldest.
//
// WHAT THIS IS. One IndexedDB database, one metadata index, one budget per class of thing, and one purge. It is
// IndexedDB rather than localStorage for three reasons that all matter here: the quota is orders of magnitude
// larger (so a real cache fits without thrashing), writes do not block the main thread (so storing a 96 KiB
// response is not a hitch in the fetch path), and a keyed metadata store means eviction sorts a small index
// instead of parsing megabytes of payload.
//
// WHAT STAYS IN localStorage. Exactly what must be read SYNCHRONOUSLY before the first paint or the first
// request: the theme (read by public/theme-init.js before React exists) and the active "view as" subject (which
// has to stamp request number one). Plus the small per-page UI toggles, which are a few bytes each and whose
// staleness is invisible - they are swept by `gc()` rather than moved.
//
// HOW CONSUMERS USE IT. Payloads are stored as STRINGS, deliberately: a string is cheap to structured-clone,
// its length is its budget cost, and holding it unparsed means boot hydration pays no JSON.parse for a
// collection nothing on the first screen touches. So a consumer hands over a string, registers a hydrator to
// receive its class's records once at boot, and parses lazily on first touch - which is what lets the row store
// stay synchronous (see lib/resourceStore.ts) even though IndexedDB is not.

const DB_NAME = "hrms";
const DB_VERSION = 1;
/** Bumped when a stored PAYLOAD shape changes. Records of another version are deleted, not merely ignored. */
const SCHEMA = 1;

/** What kind of thing is stored. Each class has its own budget, so faces can never crowd out rows. */
export type StoreClass = "rows" | "faces" | "snapshot" | "draft";

// Budgets in characters, which is what a stored string costs. Generous next to what localStorage allowed and
// still a rounding error against an IndexedDB quota (hundreds of MB in every current browser), so the eviction
// path below is a bound rather than something the app runs into on an ordinary day.
const BUDGET: Record<StoreClass, number> = {
  rows: 4_000_000,
  faces: 8_000_000,
  snapshot: 256_000,
  draft: 1_000_000,
};

// Per-record ceilings. A single payload past its class ceiling is not stored at all: it would evict most of the
// class to make room for one entry that is unlikely to be worth more than the rest of them together.
const MAX_RECORD: Record<StoreClass, number> = {
  rows: 400_000,
  faces: 200_000,
  snapshot: 256_000,
  draft: 200_000,
};

// How long a stored record may live before `gc()` removes it, regardless of what any freshness check says. This
// is about not keeping data on someone's disk for longer than it is useful, not about correctness (the change
// feed decides that): a draft nobody came back to inside a week is abandoned, and a face is worth a re-fetch
// after a week rather than a year.
const MAX_AGE_MS: Record<StoreClass, number> = {
  rows: 7 * 24 * 60 * 60_000,
  faces: 7 * 24 * 60 * 60_000,
  snapshot: 24 * 60 * 60_000,
  draft: 7 * 24 * 60 * 60_000,
};

/** A record as a consumer sees it: its own key, the unparsed payload, and when it was stored. */
export type StoredRecord = { key: string; value: string; ts: number; collection?: string; etag?: string };

type Meta = {
  k: string; // the full namespaced key (the keyPath of both stores)
  ver: number;
  id: string; // identity namespace
  cls: StoreClass;
  key: string; // the consumer's own key
  collection?: string;
  ts: number;
  bytes: number;
  etag?: string;
};

// The record's key: schema version, identity, class, then the consumer's own key. Never parsed back apart, so
// the separator only has to make collisions impossible between two different (identity, class, key) triples -
// and neither an identity (an email, plus any simulated subject) nor a class name can contain a pipe.
// Deliberately a printable one: a control character here made the whole file read as binary to grep.
const composite = (id: string, cls: StoreClass, key: string) => `${SCHEMA}|${id}|${cls}|${key}`;

// ---- Open ---------------------------------------------------------------------------------------------------
// Every failure mode lands in the same place: memory-only for the page life, with every consumer behaving as it
// does on a cache miss. That covers a browser with IndexedDB disabled (Firefox private windows), one that throws
// on open (older Safari private mode), and - via the timeout - a version change blocked by another tab, which
// would otherwise hold the boot gate open indefinitely.
const OPEN_TIMEOUT_MS = 3_000;

let db: IDBDatabase | null = null;
let dbFailed = false;
let identity: string | null = null;
let openedFor: string | null = null;
let ready: Promise<void> = Promise.resolve();
let readySettled = true;

/** The identity everything is namespaced to, or null before it is known. */
export const storedIdentity = () => identity;

function openDb(): Promise<IDBDatabase | null> {
  if (db) return Promise.resolve(db);
  if (dbFailed || typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: IDBDatabase | null) => {
      if (settled) return;
      settled = true;
      if (!value) dbFailed = true;
      resolve(value);
    };
    const timer = setTimeout(() => done(null), OPEN_TIMEOUT_MS);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      clearTimeout(timer);
      done(null);
      return;
    }
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("meta")) {
        const meta = d.createObjectStore("meta", { keyPath: "k" });
        meta.createIndex("by_scope", ["id", "cls"]);
      }
      if (!d.objectStoreNames.contains("data")) d.createObjectStore("data", { keyPath: "k" });
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      db = req.result;
      // Another tab upgrading the schema would otherwise leave this connection blocking it forever.
      db.onversionchange = () => {
        db?.close();
        db = null;
        dbFailed = true;
      };
      done(db);
    };
    req.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
    req.onblocked = () => {
      clearTimeout(timer);
      done(null);
    };
  });
}

function tx(mode: IDBTransactionMode): { meta: IDBObjectStore; data: IDBObjectStore } | null {
  if (!db) return null;
  try {
    const t = db.transaction(["meta", "data"], mode);
    return { meta: t.objectStore("meta"), data: t.objectStore("data") };
  } catch {
    return null;
  }
}

const wrap = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

// ---- The metadata index -------------------------------------------------------------------------------------
// Held in memory for this identity, so the budget is a running total and eviction sorts a few hundred small
// objects. Rebuilt from the `meta` store at boot; never read from disk again.
const index = new Map<string, Meta>();
const used: Record<StoreClass, number> = { rows: 0, faces: 0, snapshot: 0, draft: 0 };

function track(m: Meta) {
  const prev = index.get(m.k);
  if (prev) used[prev.cls] -= prev.bytes;
  index.set(m.k, m);
  used[m.cls] += m.bytes;
}

function untrack(k: string) {
  const prev = index.get(k);
  if (!prev) return;
  used[prev.cls] -= prev.bytes;
  index.delete(k);
}

// ---- Hydration ----------------------------------------------------------------------------------------------
// Consumers register at module load and are handed their class's records ONCE, when `openFor` resolves. That is
// the whole reason boot is gated on it (see App.tsx): after this, every consumer answers from memory, which is
// what lets a synchronous store like lib/resourceStore.ts sit on an asynchronous database.
// A class can have several consumers: the settings snapshot and the approvals badge both live in `snapshot`,
// each interested in one key of it, so every hydrator of a class is handed the whole class and picks out its own.
// `onReset` fires when the namespace changes, BEFORE the new identity's records arrive: a consumer holding the
// previous identity's copies in memory would otherwise go on serving them, which is the one thing namespacing
// exists to prevent.
type Hydrator = { onRecords: (records: StoredRecord[]) => void; onEvict?: (keys: string[]) => void; onReset?: () => void };
const hydrators = new Map<StoreClass, Set<Hydrator>>();

export function registerHydrator(cls: StoreClass, h: Hydrator): void {
  const set = hydrators.get(cls) ?? new Set<Hydrator>();
  set.add(h);
  hydrators.set(cls, set);
}

const notifyRecords = (cls: StoreClass, records: StoredRecord[]) => hydrators.get(cls)?.forEach((h) => h.onRecords(records));
const notifyEvicted = (cls: StoreClass, keys: string[]) => hydrators.get(cls)?.forEach((h) => h.onEvict?.(keys));

/** Whether hydration has finished (or failed). Consumers may read their hydrated records only after this. */
export const clientStoreReady = () => readySettled;

/** Resolves when this identity's records have been hydrated - or at once when storage is unavailable. */
export const whenReady = () => ready;

/**
 * Namespace storage to `key` and hydrate it. Idempotent per identity: called on every render of the shell, it
 * does its work the first time it sees an identity and returns the same promise after that.
 *
 * A DIFFERENT identity means a different person (or a simulation of one) on this browser: their records are
 * hydrated, and every other identity's are deleted rather than left to age out, because nothing is going to ask
 * for them again.
 */
export function openFor(key: string | undefined): Promise<void> {
  const next = key || null;
  if (openedFor === next) return ready;
  openedFor = next;
  identity = next;
  index.clear();
  queued.clear(); // anything not yet flushed belonged to the previous namespace
  for (const cls of Object.keys(used) as StoreClass[]) used[cls] = 0;
  for (const set of hydrators.values()) set.forEach((h) => h.onReset?.());
  if (!next) {
    readySettled = true;
    return (ready = Promise.resolve());
  }
  readySettled = false;
  return (ready = hydrate(next).finally(() => {
    readySettled = true;
  }));
}

async function hydrate(id: string): Promise<void> {
  const d = await openDb();
  if (!d) return;
  try {
    const t = tx("readwrite");
    if (!t) return;
    const metas = (await wrap(t.meta.getAll())) as Meta[];
    const mine: Meta[] = [];
    const doomed: string[] = [];
    for (const m of metas) {
      if (m.ver === SCHEMA && m.id === id) mine.push(m);
      else doomed.push(m.k); // another identity, or a payload shape this build no longer understands
    }
    for (const k of doomed) {
      t.meta.delete(k);
      t.data.delete(k);
    }
    const now = Date.now();
    const byClass = new Map<StoreClass, StoredRecord[]>();
    for (const m of mine) {
      if (now - m.ts > MAX_AGE_MS[m.cls]) {
        t.meta.delete(m.k);
        t.data.delete(m.k);
        continue;
      }
      const rec = (await wrap(t.data.get(m.k))) as { k: string; v: string } | undefined;
      if (!rec || typeof rec.v !== "string") {
        t.meta.delete(m.k); // metadata without a payload: nothing to hand anyone
        continue;
      }
      track(m);
      const list = byClass.get(m.cls) ?? [];
      list.push({ key: m.key, value: rec.v, ts: m.ts, collection: m.collection, etag: m.etag });
      byClass.set(m.cls, list);
    }
    for (const [cls, records] of byClass) notifyRecords(cls, records);
  } catch {
    /* a failed hydration is a cold cache, which every consumer already handles */
  }
}

// ---- Writes -------------------------------------------------------------------------------------------------
// Queued and flushed on an idle callback, so storing a response never lands in the fetch's own turn. The queue
// is keyed, so a value written repeatedly before a flush costs one write.
type Pending = { cls: StoreClass; key: string; value: string; collection?: string; etag?: string; ts: number };
const queued = new Map<string, Pending | null>(); // null = delete
// The flush in progress, as something to CHAIN onto. A promise rather than a boolean because a second caller
// must not be turned away: `del` promises its deletion is durable before the page can be reloaded, and an
// early return left it waiting for the next idle callback instead.
let flushing: Promise<void> | null = null;
let flushScheduled = false;

const idle = (fn: () => void) => {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(fn, { timeout: 1_000 });
  else setTimeout(fn, 0);
};

function scheduleFlush() {
  if (flushScheduled || flushing) return;
  flushScheduled = true;
  idle(() => {
    flushScheduled = false;
    void flush();
  });
}

/**
 * Store `value` under this identity. Silently does nothing when storage is unavailable or the payload is past
 * its class ceiling: every consumer treats a miss as "not stored", which is always a correct answer here.
 */
export function put(cls: StoreClass, key: string, value: string, opts: { collection?: string; etag?: string } = {}): void {
  if (!identity || dbFailed) return;
  if (value.length > MAX_RECORD[cls]) return;
  const k = composite(identity, cls, key);
  queued.set(k, { cls, key, value, collection: opts.collection, etag: opts.etag, ts: Date.now() });
  scheduleFlush();
}

/**
 * Forget one record.
 *
 * Flushed IMMEDIATELY, not on the next idle callback like a write. A deletion is how a stale copy is disowned -
 * a write landed, or the caller signed out of something - and it has to be gone before the page can be
 * reloaded. On an idle-only flush it was not: saving a setting and reloading straight after (which is what a
 * person does, and what e2e/employeeRecord.spec.ts does) re-adopted the copy the save had just invalidated.
 */
export function del(cls: StoreClass, key: string): void {
  if (!identity) return;
  const k = composite(identity, cls, key);
  untrack(k);
  if (dbFailed) return;
  queued.set(k, null);
  void flushNow();
}

/** Forget every record of a class whose metadata matches - e.g. all rows of a written collection. */
export function delWhere(cls: StoreClass, match: (m: { key: string; collection?: string; ts: number }) => boolean): string[] {
  const gone: string[] = [];
  for (const m of [...index.values()]) {
    if (m.cls !== cls || !match(m)) continue;
    gone.push(m.key);
    untrack(m.k);
    if (!dbFailed) queued.set(m.k, null);
  }
  if (gone.length) void flushNow(); // durable before a reload, for the reason `del` explains
  return gone;
}

/**
 * Send everything queued, after whatever is already in flight.
 *
 * The chaining is what makes `del` mean what it says: a deletion queued while a write was mid-flush used to be
 * dropped here and left to the next idle callback, so a reload in that window re-adopted the copy the write had
 * just invalidated.
 */
function flush(): Promise<void> {
  const run = (flushing ?? Promise.resolve()).then(runOneFlush);
  flushing = run;
  // `runOneFlush` never rejects, so this only ever runs the bookkeeping: release the chain and re-arm if
  // something was queued while it ran (which `scheduleFlush` refuses to do while a flush is in progress).
  void run.then(() => {
    if (flushing !== run) return;
    flushing = null;
    if (queued.size) scheduleFlush();
  });
  return run;
}

async function runOneFlush(): Promise<void> {
  if (!queued.size) return;
  // The namespace this batch belongs to, captured WITH the batch. Opening the database is a real await, and
  // `openFor` can switch identity across it - writing then would file one person's cached rows and faces under
  // another's namespace, which is the one thing the namespacing exists to prevent.
  const id = identity;
  const batch = [...queued.entries()];
  queued.clear();
  try {
    const d = await openDb();
    const t = d && tx("readwrite");
    if (!t) return;
    if (identity !== id) return; // a different caller owns the store now; this batch is not theirs to store
    for (const [k, p] of batch) {
      if (!p) {
        t.meta.delete(k);
        t.data.delete(k);
        continue;
      }
      const meta: Meta = { k, ver: SCHEMA, id: id!, cls: p.cls, key: p.key, collection: p.collection, ts: p.ts, bytes: p.value.length, etag: p.etag };
      track(meta);
      t.meta.put(meta);
      t.data.put({ k, v: p.value });
    }
    // Bring each touched class back inside its budget by dropping the least recently stored. Recency, not size:
    // the biggest stored copy is often the directory, which is also the one most worth keeping.
    const touched = new Set(batch.map(([, p]) => p?.cls).filter(Boolean) as StoreClass[]);
    for (const cls of touched) {
      if (used[cls] <= BUDGET[cls]) continue;
      const evicted: string[] = [];
      const oldest = [...index.values()].filter((m) => m.cls === cls).sort((a, b) => a.ts - b.ts);
      for (const m of oldest) {
        if (used[cls] <= BUDGET[cls]) break;
        untrack(m.k);
        t.meta.delete(m.k);
        t.data.delete(m.k);
        evicted.push(m.key);
      }
      // Tell the consumers, so none goes on holding an in-memory copy of something no longer stored.
      if (evicted.length) notifyEvicted(cls, evicted);
    }
  } catch {
    // A quota refusal or a broken transaction drops THIS batch and nothing else. Deliberately not the old
    // behaviour of wiping the store and refusing to persist for the rest of the page life: the next write is a
    // fresh attempt, and the budgets above are what keep this from recurring.
  }
}

/** Send anything queued now. The page being hidden is the last moment that reliably still runs. */
export function flushNow(): Promise<void> {
  flushScheduled = false;
  return flush();
}

// Two last chances, because they cover different exits: `visibilitychange` fires when the tab is backgrounded
// (and is what mobile browsers give instead of unload), `pagehide` when this document is actually going away -
// a reload, or following a link. A queued delete that misses both is a stale copy the next page load adopts.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushNow();
  });
  window.addEventListener("pagehide", () => void flushNow());
}

// ---- Purge --------------------------------------------------------------------------------------------------

/**
 * Delete everything this app has stored in this browser: the database and every localStorage key except the
 * theme, which is a visual preference rather than anything about the person and would otherwise flash the wrong
 * palette at whoever signs in next (the server row corrects it either way).
 *
 * Called on sign-out. `localStorage.clear()` is safe to reach for because the origin is entirely ours.
 */
export async function purgeAll(): Promise<void> {
  queued.clear();
  index.clear();
  for (const cls of Object.keys(used) as StoreClass[]) used[cls] = 0;
  try {
    const theme = localStorage.getItem("theme");
    localStorage.clear();
    if (theme) localStorage.setItem("theme", theme);
  } catch {
    /* storage denied: nothing was written to begin with */
  }
  try {
    sessionStorage.clear();
  } catch {
    /* same */
  }
  db?.close();
  db = null;
  identity = null;
  openedFor = null;
  if (typeof indexedDB === "undefined") return;
  await new Promise<void>((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.deleteDatabase(DB_NAME);
    } catch {
      resolve();
      return;
    }
    // Resolve either way: sign-out must never be held up by storage, and a deletion blocked by another tab is
    // completed by the browser as soon as that tab lets go.
    const t = setTimeout(resolve, 1_000);
    const finish = () => {
      clearTimeout(t);
      resolve();
    };
    req.onsuccess = finish;
    req.onerror = finish;
    req.onblocked = finish;
  });
}

/**
 * How many unsaved drafts this device is holding for the current identity.
 *
 * `purgeAll` takes the `draft` class with it - a half-written announcement, a review write-up and its ratings
 * grid, an unsent bulk delivery - and none of that exists on the server. Sign-out is a decision somebody makes
 * one click from "View my profile", so the menu asks when there is something to lose and stays silent when
 * there is not. Free: the index is already in memory, so this is a filter over a map, no read and no await.
 */
export function draftCount(): number {
  let n = 0;
  for (const m of index.values()) if (m.cls === "draft") n++;
  return n;
}

/** The classes `purgeCachedData` removes: everything that is a COPY of a server answer. `draft` is absent. */
const SERVER_DATA_CLASSES: StoreClass[] = ["rows", "faces", "snapshot"];

/**
 * Drop the cached copies of server data, keeping the person's own unsaved writing.
 *
 * Called when the SESSION LAPSES (api.ts `handle401`), which is the ordinary way this app is left - a 12-hour
 * TTL and a browser that gets closed. `purgeAll` above only ran from the sign-out MENU ITEM, so every other
 * exit left the whole cache on disk: up to 4 MB of collection rows and 8 MB of colleagues' faces, for the seven
 * days `MAX_AGE_MS` allows, on what may well be a shared computer. That is precisely the case the sign-out
 * purge was written for, reached by the door most people actually use.
 *
 * WHY NOT JUST CALL `purgeAll`. A 401 is not a decision the person made - it arrives mid-sentence. `purgeAll`
 * deletes the `draft` class too (the announcement composer's post, a review write-up: real writing, minutes or
 * days of it), and destroying that because a cookie expired would be a worse bug than the one being fixed. So
 * the split is by WHAT THE RECORD IS: a copy of something the server will hand back on the next sign-in goes,
 * and anything that exists only here stays. localStorage and sessionStorage are untouched for the same reason -
 * they hold UI preferences and the session-scoped dialog drafts (components/common/dialogGuard.ts), not records.
 *
 * Deletes across EVERY identity, not just the current one: with no live session there is no authoritative
 * identity, and a stale namespace is exactly what should not survive here. Never rejects - an expired session
 * must not be held up by storage.
 */
export async function purgeCachedData(): Promise<void> {
  const doomedClass = new Set<StoreClass>(SERVER_DATA_CLASSES);
  // Drop anything queued for these classes first, or the next idle flush writes back what is about to be
  // deleted. `index` follows, so the class budgets stop counting bytes that are no longer on disk.
  for (const [k, p] of [...queued.entries()]) if (p && doomedClass.has(p.cls)) queued.delete(k);
  for (const m of [...index.values()]) if (doomedClass.has(m.cls)) untrack(m.k);
  // NOT `onReset`. This is about what is left ON DISK, and the hydrators hold the copies the mounted page is
  // rendering from: api.ts shows a "sign in again" overlay IN PLACE where it can, precisely so the screen and
  // any half-typed form survive the lapse. Resetting them here would blank the app behind that overlay and buy
  // nothing - the bytes on screen are already on screen. The redirect path unloads the page anyway.

  const d = await openDb();
  if (!d) return;
  try {
    const t = tx("readwrite");
    if (!t) return;
    const metas = (await wrap(t.meta.getAll())) as Meta[];
    for (const m of metas) {
      if (!doomedClass.has(m.cls)) continue;
      t.meta.delete(m.k);
      t.data.delete(m.k);
    }
  } catch {
    /* storage unavailable or the transaction broke: nothing more to do, and the caller is on their way out */
  }
}

// ---- Collection ---------------------------------------------------------------------------------------------
// Records are already bounded by class budget and dropped by age at hydration, so what is left for `gc()` is the
// localStorage side: keys nothing reads any more. Each entry says how to decide, and an unbounded family (one
// key per ticket, per board, per table) gets a rule that keeps it from climbing for the life of the browser
// profile. Deliberately a data table rather than logic spread across the pages that write these: a new key
// family is one line here, and a family nobody claims is visible as an omission.
// Also the un-namespaced ancestors of keys that now carry the caller's identity. They are not merely dead: each
// holds one person's state under a key the next person on a shared browser reads, which is why they were
// namespaced. `prefs.unconfirmed` is the sharpest - `adoptUnconfirmed` PATCHed whatever it held onto whoever is
// signed in now - and `dash.personal` painted the dashboard from it before the server row arrived.
const LEGACY_KEYS = [
  "dash.hideAllClear",
  "prefs.unconfirmed",
  "dash.personal",
  "hrms.board.filter",
  "goals:filter",
  "boards:last",
  "hrms.letters.rail",
  "letterTemplate:last",
  "push-enroll-dismissed",
];

/**
 * localStorage families that must not grow without bound, and how many entries of each are worth keeping.
 *
 * `keepNewest` is required, not optional: an entry without one was silently skipped, so the two board families
 * below grew for the life of the browser profile while this table claimed to bound them. "Newest" is the
 * keyspace's own order (insertion, in every engine that has one) rather than a stored timestamp - these are
 * one-board UI toggles, and losing one costs a re-collapse.
 */
type Sweep = { prefix: string; keepNewest: number };
const SWEEPS: Sweep[] = [
  // One per board. Well past the number of boards anyone keeps a view of, so a sweep only ever reaches the
  // ones this identity has stopped opening.
  { prefix: "boards:collapsed:", keepNewest: 40 },
  { prefix: "boards:filter:", keepNewest: 40 },
];

/**
 * Remove what nothing will read again. Runs once at boot, on an idle callback, so it never competes with the
 * first paint. Everything it touches is a cache or a UI nicety - losing any of it costs a re-fetch or a
 * re-collapse, never data.
 */
export function gc(opts: { seenTickets?: () => void } = {}): void {
  idle(() => {
    try {
      for (const k of LEGACY_KEYS) localStorage.removeItem(k);
      // Drafts written by an earlier build of the app, before they were namespaced and given an expiry.
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (k.startsWith("review-draft:") || k.startsWith("board:composer:")) localStorage.removeItem(k);
        // The pre-clientStore caches. Their keys are orphaned by this module's existence, not by a version bump,
        // so nothing will ever come back for them.
        if (/^(rs1|rs1sync|ph1|st1|ap1):/.test(k)) localStorage.removeItem(k);
      }
      for (const s of SWEEPS) {
        const keys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k?.startsWith(s.prefix)) keys.push(k);
        }
        for (const k of keys.slice(0, Math.max(0, keys.length - s.keepNewest))) localStorage.removeItem(k);
      }
      // The last-seen ticket maps: lib/ticketsSeen.ts owns both the key shape (one map per identity) and the
      // pruning rule, so it does the whole sweep rather than handing a single map back here.
      opts.seenTickets?.();
    } catch {
      /* storage denied or a corrupt value: there is nothing to collect */
    }
  });
}

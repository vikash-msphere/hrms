// Employee-photo cache that collapses the per-avatar `:getPhoto` N+1 into batched requests. A Directory of 100
// rows used to fire 100 POSTs; now every avatar that mounts in the same tick enqueues its id and a single
// `employees:batchGetPhotos` call fetches them all. Resolved photos are cached for the session, so revisiting a
// page costs zero photo requests - and kept on disk (below), so a RELOAD costs none either.
import { api } from "@/api";
import { idOf } from "@/lib/utils";

type Entry = { dataUri: string | null; settled: boolean; subs: Set<() => void> }; // settled+null = known no-photo
const cache = new Map<string, Entry>();
const pending = new Set<string>();
let flushScheduled = false;
const MAX_PER_BATCH = 24; // match the server's batchGetPhotos cap; overflow re-schedules into the next flush

// ---- Disk layer ---------------------------------------------------------------------------------------------
// A face is the most reusable thing the app fetches: it is the same bytes on every page, and it changes only
// when someone uploads a new one (which invalidates it here explicitly). Without persistence, every reload paid
// a `:batchGetPhotos` per avatar wave - each one an R2 fetch plus an employee row per id.
//
// Bounded on purpose: photos are the biggest thing we would ever store, so a single oversized image is skipped
// and the whole store is capped. Nothing here is load-bearing - a miss just re-fetches.
const DISK_PREFIX = "ph1:";
const MAX_ENTRY_BYTES = 48 * 1024; // one photo; the server already downscales avatars well under this
const MAX_ENTRIES = 200; // ~a large directory's worth; oldest-written go first when full
let diskUser: string | null = null;
let diskOk = true;
// The stored keys this page life knows about, so the entry cap is a Set size instead of a walk over every key
// in the origin - the same bound lib/resourceStore.ts keeps for the same reason. Counting by walking cost a
// full `localStorage.key(i)` sweep PER PHOTO STORED, so one directory load of 100 faces did a hundred sweeps
// over every key on the origin (this cache's, the resource store's, prefs') on the main thread. Seeded lazily
// on first write from whatever the last page life left behind.
let owned: Set<string> = new Set();
let ownedSeeded = false;

/** Namespace stored photos to the caller (and any simulation), like the resource store's disk cache. */
export function setPhotoCacheUser(key: string | undefined) {
  diskUser = key || null;
}

const diskKey = (id: string) => `${DISK_PREFIX}${diskUser}:${id}`;

function readDisk(id: string): string | null | undefined {
  if (!diskUser || !diskOk) return undefined;
  try {
    const raw = localStorage.getItem(diskKey(id));
    if (raw === null) return undefined; // never stored
    return raw === "" ? null : raw; // "" is a stored known-no-photo
  } catch {
    return undefined;
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

function writeDisk(id: string, dataUri: string | null) {
  if (!diskUser || !diskOk) return;
  const payload = dataUri ?? "";
  if (payload.length > MAX_ENTRY_BYTES) return;
  try {
    seedOwned();
    const key = diskKey(id);
    // At the cap, evict ONE stored face to make room for this one, rather than clearing all of them. Dropping
    // everything meant an org larger than the cap re-cleared the whole store on every avatar past the two
    // hundredth - a full sweep plus 200 removals per face - and never kept a usable cache, so the reload it
    // exists to make free was paying for photos it had just thrown away. The victim is arbitrary (there is no
    // recency order on disk) and it does not matter: a miss just re-fetches.
    if (!owned.has(key) && owned.size >= MAX_ENTRIES) {
      const victim = owned.values().next().value;
      if (victim) {
        localStorage.removeItem(victim);
        owned.delete(victim);
      }
    }
    localStorage.setItem(key, payload);
    owned.add(key);
  } catch {
    diskOk = false; // out of quota / storage denied: memory-only from here
    dropDisk();
  }
}

function dropDisk(id?: string) {
  try {
    if (id) {
      const key = diskKey(id);
      localStorage.removeItem(key);
      owned.delete(key);
      return;
    }
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(DISK_PREFIX)) localStorage.removeItem(k);
    }
    owned = new Set();
  } catch {
    /* nothing to do */
  }
}

function entry(id: string): Entry {
  let e = cache.get(id);
  if (!e) {
    e = { dataUri: null, settled: false, subs: new Set() };
    const stored = readDisk(id);
    if (stored !== undefined) {
      e.dataUri = stored;
      e.settled = true; // a stored hit (or stored known-miss) needs no request at all
    }
    cache.set(id, e);
  }
  return e;
}

function settle(id: string, dataUri: string | null) {
  const e = entry(id);
  e.dataUri = dataUri;
  e.settled = true;
  writeDisk(id, dataUri);
  e.subs.forEach((cb) => cb());
}

async function flush() {
  flushScheduled = false;
  const ids = [...pending].slice(0, MAX_PER_BATCH);
  if (!ids.length) return;
  ids.forEach((id) => pending.delete(id));
  try {
    const resp = await api<{ photos: { employee: string; data_uri: string }[] }>("/employees:batchGetPhotos", {
      method: "POST",
      body: JSON.stringify({ employees: ids.map((id) => `employees/${id}`) }),
    });
    const got = new Map(resp.photos.map((p) => [idOf(p.employee), p.data_uri]));
    // Every requested id settles: a hit gets its data URI, a miss settles to null (no photo / not visible) so
    // it isn't re-requested.
    ids.forEach((id) => settle(id, got.get(id) ?? null));
  } catch {
    ids.forEach((id) => settle(id, null));
  }
  if (pending.size) schedule(); // ids enqueued past the cap, or while in flight
}

// Flush on a short trailing debounce rather than the immediate microtask: avatars mount in waves as data
// arrives (page rows, then celebration feed, then timeline), each in its own commit a few ms apart. A small
// window lets those waves coalesce into ONE :batchGetPhotos instead of one per wave.
const FLUSH_DELAY_MS = 50;
function schedule() {
  if (flushScheduled) return;
  flushScheduled = true;
  setTimeout(flush, FLUSH_DELAY_MS);
}

// Request an employee's photo; returns the cached data URI if known, else enqueues a batched fetch. Pass
// `hasPhoto=false` (the list's `photo` marker is absent) to skip the network entirely.
export function requestPhoto(employeeId: string, hasPhoto: boolean): string | null {
  if (!hasPhoto) return null;
  // `entry`, not `cache.get`: a first touch adopts the stored copy, which is what makes a reload free.
  const e = entry(employeeId);
  if (e.settled) return e.dataUri; // hit or known-miss
  if (!pending.has(employeeId)) {
    pending.add(employeeId);
    schedule();
  }
  return null;
}

export function subscribePhoto(employeeId: string, cb: () => void): () => void {
  const e = entry(employeeId);
  e.subs.add(cb);
  return () => {
    e.subs.delete(cb);
  };
}

// Drop a cached photo and refetch (after an upload/remove changes it).
export function invalidatePhoto(employeeId: string) {
  cache.delete(employeeId);
  dropDisk(employeeId); // the stored copy is the old face - forget it before anything can adopt it
  pending.add(employeeId);
  schedule();
}

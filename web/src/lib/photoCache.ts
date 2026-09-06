// Employee-photo cache that collapses the per-avatar `:getPhoto` N+1 into batched requests. A Directory of 100
// rows used to fire 100 POSTs; now every avatar that mounts in the same tick enqueues its id and a single
// `employees:batchGetPhotos` call fetches them all. Resolved photos are cached for the session, so revisiting a
// page costs zero photo requests - and kept on disk (below), so a RELOAD costs none either.
import { api } from "@/api";
import { idOf } from "@/lib/utils";
import { registerHydrator, put, del } from "@/lib/clientStore";
import { publish, subscribeTopic } from "@/lib/crossTabBus";
import { subscribePurge } from "@/lib/resourceStore";

type Entry = { dataUri: string | null; settled: boolean; subs: Set<() => void> }; // settled+null = known no-photo
const cache = new Map<string, Entry>();
const pending = new Map<string, string>(); // cache key -> employee id to ask for
let flushScheduled = false;
const MAX_PER_BATCH = 24; // match the server's batchGetPhotos cap; overflow re-schedules into the next flush

// ---- Versioned by the photo, not by the employee ------------------------------------------------------------
// A cached face used to be keyed by employee id alone, which made it permanently wrong everywhere but the
// browser that replaced it: `invalidatePhoto` runs in the tab that did the upload, and nothing told any other
// browser - or any other tab - that the bytes it was holding were last year's picture.
//
// The employee's `photo` marker carries the photo's own version now (serialize.ts stamps it from `photo_at`, set
// only when a photo is uploaded or cleared). The version is part of the cache key, so a replaced photo is a
// different key: every browser misses, fetches once, and the old key ages out of storage on its own. Nothing has
// to be told anything, and an ordinary employee edit - a name, a department - does not disturb the face, which
// keying off the row's `update_time` would have.
const keyFor = (employeeId: string, marker: string | undefined) => {
  const v = marker?.match(/[?&]v=(\d+)/)?.[1];
  return v ? `${employeeId}@${v}` : employeeId;
};

// ---- Disk layer ---------------------------------------------------------------------------------------------
// A face is the most reusable thing the app fetches: it is the same bytes on every page, and it changes only
// when someone uploads a new one. Without persistence, every reload paid a `:batchGetPhotos` per avatar wave -
// each one an R2 fetch plus an employee row per id.
//
// Storage, namespacing, the budget and eviction all belong to lib/clientStore.ts. Faces get the largest budget
// of any class there, because they are the biggest thing the app stores and the most worth keeping; within it
// the least recently stored go first, which the old localStorage version could not do (it had no recency order,
// so its victim was whichever key a Set happened to yield).
let diskUser: string | null = null;
const disk = new Map<string, string>(); // employee id -> data URI, or "" for a stored known-no-photo

registerHydrator("faces", {
  onRecords: (records) => {
    for (const r of records) disk.set(r.key, r.value);
  },
  onEvict: (keys) => {
    for (const k of keys) disk.delete(k);
  },
  // A different caller: which faces they may see is an access question, so none of these carries over.
  onReset: () => {
    disk.clear();
    cache.clear();
  },
});

/** Namespace stored photos to the caller (and any simulation), like the resource store's disk cache. */
export function setPhotoCacheUser(key: string | undefined) {
  diskUser = key || null;
}

function readDisk(id: string): string | null | undefined {
  if (!diskUser) return undefined;
  const raw = disk.get(id);
  if (raw === undefined) return undefined; // never stored
  return raw === "" ? null : raw; // "" is a stored known-no-photo
}

function writeDisk(id: string, dataUri: string | null) {
  if (!diskUser) return;
  const payload = dataUri ?? "";
  disk.set(id, payload);
  put("faces", id, payload);
}

function dropDisk(id: string) {
  disk.delete(id);
  del("faces", id);
}

function entry(key: string): Entry {
  let e = cache.get(key);
  if (!e) {
    e = { dataUri: null, settled: false, subs: new Set() };
    const stored = readDisk(key);
    if (stored !== undefined) {
      e.dataUri = stored;
      e.settled = true; // a stored hit (or stored known-miss) needs no request at all
    }
    cache.set(key, e);
  }
  return e;
}

function settle(key: string, dataUri: string | null) {
  const e = entry(key);
  e.dataUri = dataUri;
  e.settled = true;
  writeDisk(key, dataUri);
  e.subs.forEach((cb) => cb());
}

async function flush() {
  flushScheduled = false;
  const batch = [...pending].slice(0, MAX_PER_BATCH);
  if (!batch.length) return;
  batch.forEach(([key]) => pending.delete(key));
  // Two keys can name the same employee (an avatar rendered from a stale row alongside one from a fresh row),
  // so the request is deduped by id while every key still settles from the same answer.
  const ids = [...new Set(batch.map(([, id]) => id))];
  try {
    const resp = await api<{ photos: { employee: string; data_uri: string }[] }>("/employees:batchGetPhotos", {
      method: "POST",
      // A POST that reads: it fetches avatars and writes nothing, so a transient gateway refusal is worth
      // asking again rather than leaving a wave of avatars blank for the rest of the session.
      safeToRepeat: true,
      body: JSON.stringify({ employees: ids.map((id) => `employees/${id}`) }),
    });
    const got = new Map(resp.photos.map((p) => [idOf(p.employee), p.data_uri]));
    // Every requested key settles: a hit gets its data URI, a miss settles to null (no photo / not visible) so
    // it isn't re-requested.
    batch.forEach(([key, id]) => settle(key, got.get(id) ?? null));
  } catch {
    batch.forEach(([key]) => settle(key, null));
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

// Request an employee's photo; returns the cached data URI if known, else enqueues a batched fetch. `marker` is
// the employee row's `photo` field: absent means they have none, so no request is made at all, and its version
// is what makes a replaced photo a different cache key.
export function requestPhoto(employeeId: string, marker: string | undefined): string | null {
  if (!marker) return null;
  const key = keyFor(employeeId, marker);
  // `entry`, not `cache.get`: a first touch adopts the stored copy, which is what makes a reload free.
  const e = entry(key);
  if (e.settled) return e.dataUri; // hit or known-miss
  if (!pending.has(key)) {
    pending.set(key, employeeId);
    schedule();
  }
  return null;
}

export function subscribePhoto(employeeId: string, marker: string | undefined, cb: () => void): () => void {
  const e = entry(keyFor(employeeId, marker));
  e.subs.add(cb);
  return () => {
    e.subs.delete(cb);
  };
}

/**
 * Forget every cached copy of this employee's face, at any version.
 *
 * Called by the tab that just replaced or removed the photo. The upload also invalidates the `employees`
 * collection, so every view re-reads the row, sees the new version in its `photo` marker and requests under the
 * new key by itself - here we only make sure nothing goes on serving the old bytes in the meantime. Broadcast so
 * sibling tabs of the same browser drop theirs too; other browsers need no telling, since the version in the
 * marker is what they key on.
 */
export function invalidatePhoto(employeeId: string) {
  forget(employeeId);
  publish(TOPIC_PHOTO, { employee: employeeId } satisfies PhotoMsg);
}

function forget(employeeId: string) {
  for (const key of [...cache.keys()]) {
    if (key === employeeId || key.startsWith(`${employeeId}@`)) cache.delete(key);
  }
  for (const key of [...disk.keys()]) {
    if (key === employeeId || key.startsWith(`${employeeId}@`)) dropDisk(key);
  }
}

const TOPIC_PHOTO = "photo:invalidate";
type PhotoMsg = { employee: string };
subscribeTopic<PhotoMsg>(TOPIC_PHOTO, ({ employee }) => forget(employee)); // local only - never rebroadcast

// A whole-store purge (the caller's own access changed, or a crash boundary is retrying) covers faces too:
// which employees this caller may see is an access question, so a face they were allowed yesterday is not
// something to go on holding.
subscribePurge(() => {
  cache.clear();
  for (const key of [...disk.keys()]) dropDisk(key);
});

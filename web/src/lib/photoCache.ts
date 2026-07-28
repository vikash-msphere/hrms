// Session-wide employee-photo cache that collapses the per-avatar `:getPhoto` N+1 into batched requests. A
// Directory of 100 rows used to fire 100 POSTs; now every avatar that mounts in the same tick enqueues its id
// and a single `employees:batchGetPhotos` call fetches them all. Resolved photos (data URIs) are cached for the
// session, so revisiting a page costs zero photo requests.
import { api } from "@/api";
import { idOf } from "@/lib/utils";

type Entry = { dataUri: string | null; settled: boolean; subs: Set<() => void> }; // settled+null = known no-photo
const cache = new Map<string, Entry>();
const pending = new Set<string>();
let flushScheduled = false;
const MAX_PER_BATCH = 24; // match the server's batchGetPhotos cap; overflow re-schedules into the next flush

function entry(id: string): Entry {
  let e = cache.get(id);
  if (!e) {
    e = { dataUri: null, settled: false, subs: new Set() };
    cache.set(id, e);
  }
  return e;
}

function settle(id: string, dataUri: string | null) {
  const e = entry(id);
  e.dataUri = dataUri;
  e.settled = true;
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
  const e = cache.get(employeeId);
  if (e?.settled) return e.dataUri; // hit or known-miss
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
  pending.add(employeeId);
  schedule();
}

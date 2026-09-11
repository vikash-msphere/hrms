// In-isolate TTL cache for read-mostly reference data (replaces KV). Per-isolate, best-effort.
//
// Two properties beyond "a Map with timestamps", both of which it lacked:
//
// BOUNDED. Entries were only ever replaced, never removed, so an expired one sat in the Map until something
// asked for that exact key again. Most keys here are per-CALLER (`userGrant:<uuid>`, `objRules:<uuid>:<roles>`
// - see lib/policyLoad.ts), so the Map grew with the number of distinct people who used the isolate and never
// shrank, for the isolate's whole life, against a 128 MiB ceiling. Now every miss sweeps what has expired, and
// a hard cap evicts oldest-first if the sweep is not enough - so the ceiling is the cap, not the head count.
//
// ONE LOAD PER MISS. The cache stored the resolved VALUE, so N concurrent misses on a cold isolate each ran
// `load()`: the first page load of the day fired the same grant read once per in-flight request instead of
// once. Storing the in-flight PROMISE collapses them onto one read. A REJECTED load is evicted rather than
// remembered, so a transient failure does not become a cached failure for the rest of the TTL.
//
// Correctness never depends on any of this: entries are pure reductions of replica reads, so a cold isolate
// (or an eviction) recomputes the identical value.

type Entry = { value: Promise<unknown>; expires: number };
const store = new Map<string, Entry>();

/** Hard ceiling on live entries. Sized well above the per-role/manifest bands (tens of keys) so only the
 *  per-caller bands can ever reach it, and far below anything that troubles the isolate's memory. */
const MAX_ENTRIES = 2000;

/** Drop what has expired; then, if still over the cap, evict oldest-inserted first (Map iterates in insertion
 *  order) until under it. Called on a miss, which is the only time the store grows. */
function evict(now: number): void {
  for (const [key, entry] of store) if (entry.expires <= now) store.delete(key);
  if (store.size < MAX_ENTRIES) return;
  const over = store.size - MAX_ENTRIES + 1; // +1: make room for the entry about to be written
  let dropped = 0;
  for (const key of store.keys()) {
    if (dropped++ >= over) break;
    store.delete(key);
  }
}

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expires > now) return hit.value as Promise<T>;
  evict(now);
  // The in-flight promise goes in BEFORE it settles, so a concurrent caller joins this load instead of
  // starting its own. On rejection the entry is removed (and only if it is still ours - a `clearCache` or an
  // eviction may have replaced it meanwhile), so the next caller retries rather than inheriting the failure.
  const value = load();
  const entry: Entry = { value, expires: now + ttlMs };
  store.set(key, entry);
  try {
    return await value;
  } catch (e) {
    if (store.get(key) === entry) store.delete(key);
    throw e;
  }
}

// Drop one cached key (or the whole store). Best-effort, per-isolate: it speeds up local propagation in the
// isolate that performed a write; other isolates still converge within the TTL. Correctness never depends on
// it (entries are pure reductions of replica reads). Used by tests for isolation.
export function clearCache(key?: string): void {
  if (key === undefined) store.clear();
  else store.delete(key);
}

// Drop every cached key starting with `prefix`. Used to bust a whole band at once - e.g. an `everyone` rule
// edit must invalidate every `grant:<role>` entry (everyone rides each role's cached grant) without touching
// unrelated bands (userGrant:/manifest). Best-effort, per-isolate, like clearCache.
export function clearCachePrefix(prefix: string): void {
  for (const key of store.keys()) if (key.startsWith(prefix)) store.delete(key);
}

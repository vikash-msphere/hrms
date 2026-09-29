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
// ONE LOAD PER MISS, PER REQUEST. A batch envelope's sub-reads run concurrently on one request, and on a cold
// isolate each would otherwise fire the same grant read. So an entry holds its in-flight PROMISE, and callers
// in the SAME request (`scope` - the request's Deps, which a batch sub-read and an automation's re-dispatch
// share) join it. A REJECTED load is evicted rather than remembered, so a transient failure does not become a
// cached failure for the rest of the TTL.
//
// NEVER ACROSS REQUESTS. The Workers runtime runs a promise's continuations in the request that RESOLVED it, so
// a request that awaits another request's pending D1 read resumes inside that other request, and its own next
// query dies with "Cannot perform I/O on behalf of a different request". Under load this 500'd every request
// that joined a shared reload (the counters re-read every CHECK_MS, lib/cacheGenerations.ts, is joined by
// everything in flight). So a load another request started is treated as a miss, and what is shared across
// requests is only the SETTLED value, as plain data. Concurrent requests on a cold key each read once.
//
// Correctness never depends on any of this: entries are pure reductions of replica reads, so a cold isolate
// (or an eviction) recomputes the identical value.

type Entry = {
  /** The load itself. Awaited only by callers in `scope`, the request that started it. */
  pending: Promise<unknown>;
  scope: object;
  settled: boolean;
  /** The loaded value, once `settled`. Read by any request. */
  value: unknown;
  expires: number;
};
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

/**
 * The value under `key`, loading it on a miss.
 *
 * `scope` is the request asking (its Deps): a load still in flight is joined only by callers in the same scope,
 * and a load another request started counts as a miss (see NEVER ACROSS REQUESTS above).
 *
 * `stale`, when given, is asked about a live hit once it has resolved. A stale hit is dropped (only if it is still
 * the entry this call found - a concurrent caller may already have replaced it) and loaded again, and that fresh
 * value is returned WITHOUT asking again: a value that is stale the moment it lands (a read replica behind the
 * one the question was answered from) costs one extra load, never a loop. Concurrent callers in one request who
 * find the same stale entry join the one reload.
 */
export async function cached<T>(scope: object, key: string, ttlMs: number, load: () => Promise<T>, stale?: (value: T) => boolean): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expires > now && (hit.settled || hit.scope === scope)) {
    const value = (hit.settled ? hit.value : await hit.pending) as T;
    if (!stale || !stale(value)) return value;
    if (store.get(key) === hit) store.delete(key);
    return cached(scope, key, ttlMs, load);
  }
  evict(now);
  // The in-flight promise goes in BEFORE it settles, so a concurrent caller in this request joins this load
  // instead of starting its own. It replaces another request's pending entry, whose load then fills an entry
  // nobody reads; that request's own callers still hold its promise. On rejection the entry is removed (and only
  // if it is still ours - a `clearCache` or an eviction may have replaced it meanwhile), so the next caller
  // retries rather than inheriting the failure.
  const pending = load();
  const entry: Entry = { pending, scope, settled: false, value: undefined, expires: now + ttlMs };
  store.set(key, entry);
  try {
    const value = await pending;
    entry.value = value;
    entry.settled = true;
    return value;
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

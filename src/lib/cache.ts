// In-isolate TTL cache for read-mostly reference data (replaces KV). Per-isolate, best-effort.

type Entry<T> = { value: T; expires: number };
const store = new Map<string, Entry<unknown>>();

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await load();
  store.set(key, { value, expires: Date.now() + ttlMs });
  return value;
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

// Shared client-side cache for collection reads. Without it, every component that calls useCollection fires
// its own HTTP request, so "employees" alone is fetched 30+ times per session. The store gives three things:
//   1. in-flight dedup - concurrent identical reads share ONE promise (the biggest request-count win),
//   2. a short TTL so navigations within the window reuse the cached rows instead of refetching,
//   3. subscribe/notify + mutation-driven invalidation so a write refreshes every mounted view of a collection.
// Cloudflare caps request COUNT (not payload), so collapsing duplicate reads is the lever.
import { list } from "@/api";
import { publish, subscribeTopic } from "@/lib/crossTabBus";

const TTL_MS = 20_000;

// `meta` carries any non-`results` fields the list response returned (e.g. notifications' `snoozed_count`), so a
// consumer can read a piggybacked count without a second request.
type Snapshot = { rows: unknown[]; state: "loading" | "ready" | "error"; error: string | null; meta?: Record<string, unknown> };
type Entry = {
  collection: string;
  opts: { showDeleted?: boolean; max?: number; q?: string };
  snap: Snapshot; // stable identity; replaced only when it changes (required by useSyncExternalStore)
  ts: number; // last successful load
  inflight: Promise<void> | null;
  subs: Set<() => void>;
};

const entries = new Map<string, Entry>();

const keyOf = (collection: string, opts: { showDeleted?: boolean; max?: number; q?: string }) =>
  `${collection}?d=${opts.showDeleted ? 1 : 0}&m=${opts.max ?? 200}&q=${opts.q ?? ""}`;

function getEntry(collection: string, opts: { showDeleted?: boolean; max?: number; q?: string }): Entry {
  const key = keyOf(collection, opts);
  let e = entries.get(key);
  if (!e) {
    e = { collection, opts, snap: { rows: [], state: "loading", error: null }, ts: 0, inflight: null, subs: new Set() };
    entries.set(key, e);
  }
  return e;
}

function setSnap(e: Entry, patch: Partial<Snapshot>) {
  e.snap = { ...e.snap, ...patch };
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

export function subscribeAny(cb: () => void): () => void {
  globalSubs.add(cb);
  return () => {
    globalSubs.delete(cb);
  };
}

export function collectionHasMore(collection: string | undefined): boolean {
  if (!collection) return false;
  for (const e of entries.values()) {
    if (e.collection !== collection) continue;
    if ((e.snap.meta as { next_page_token?: string } | undefined)?.next_page_token) return true;
  }
  return false;
}

// Kick off a fetch if the entry is stale and not already loading. `force` bypasses the TTL (used by reload()).
export function ensureFetch(collection: string, opts: { showDeleted?: boolean; max?: number; q?: string }, force = false): Promise<void> {
  const e = getEntry(collection, opts);
  if (e.inflight) return e.inflight;
  const fresh = e.snap.state === "ready" && Date.now() - e.ts < TTL_MS;
  if (fresh && !force) return Promise.resolve();
  if (e.snap.state !== "ready") setSnap(e, { state: "loading" }); // keep stale rows visible while revalidating
  e.inflight = list<unknown>(collection, opts)
    .then((resp) => {
      e.ts = Date.now();
      const { results, ...meta } = resp as { results?: unknown[] } & Record<string, unknown>;
      const rows = results ?? [];
      setSnap(e, { rows, state: "ready", error: null, meta });
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

export function subscribe(collection: string, opts: { showDeleted?: boolean; max?: number; q?: string }, cb: () => void): () => void {
  const e = getEntry(collection, opts);
  e.subs.add(cb);
  return () => {
    e.subs.delete(cb);
  };
}

export function getSnapshot(collection: string, opts: { showDeleted?: boolean; max?: number; q?: string }): Snapshot {
  return getEntry(collection, opts).snap;
}

// Optimistic local edit shared across every subscriber of this exact key (e.g. flip a notification to read).
export function patchRows(collection: string, opts: { showDeleted?: boolean; max?: number; q?: string }, updater: (prev: unknown[]) => unknown[]) {
  const e = getEntry(collection, opts);
  setSnap(e, { rows: updater(e.snap.rows) });
}

// Invalidate every cached key of the given collections and refetch the ones with live subscribers (so mounted
// views update immediately; unobserved keys just drop and reload lazily on next mount). Returns the subset of
// `collections` this tab did NOT refetch (no live subscriber here) - the caller broadcasts those so a sibling
// that IS showing them refetches instead; the ones we did refetch reach siblings for free via TOPIC_ROWS.
export function invalidateCollections(collections: string[]): string[] {
  const set = new Set(collections);
  const notRefetched = new Set(collections);
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
  "attendance-regularizations:approve": ["attendance-regularizations", "attendance", "notifications"],
  "attendance-regularizations:reject": ["attendance-regularizations", "notifications"],
  "leave-encashments:approve": ["leave-encashments", "leave-balances", "notifications"],
  "leave-encashments:reject": ["leave-encashments", "notifications"],
  "time-entries:approve": ["time-entries", "notifications"],
  "time-entries:reject": ["time-entries", "notifications"],
  "suggestions:respond": ["suggestions", "notifications"],
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

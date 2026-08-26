import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { ensureFetch, subscribe, getSnapshot, patchRows, subscribeAny, collectionHasMore, loadMoreRows } from "@/lib/resourceStore";
import { usePermission } from "@/lib/perm";

export type LoadState = "loading" | "ready" | "error";

// Reads a collection through the shared resource store: identical reads across components are deduped into one
// request, a short TTL lets navigations reuse cached rows, and a mutation (via api.ts) refreshes every mounted
// view. Same return shape as before - pages don't change. `setRows` applies an optimistic edit shared by every
// subscriber of this exact key; `reload` forces a refetch (bypasses the TTL).
export function useCollection<T>(
  collection: string,
  opts: { showDeleted?: boolean; deletedOnly?: boolean; max?: number; enabled?: boolean; q?: string; params?: Record<string, string> } = {},
) {
  const { showDeleted = false, deletedOnly = false, max, enabled = true, q, params } = opts;
  // Collection-specific SERVER filters (e.g. `{ leave_type: "leave-types/<id>" }`). Serialised so a caller can
  // pass a fresh object literal each render without churning the store key.
  const paramsKey = JSON.stringify(
    Object.entries(params ?? {}).filter(([, v]) => v).sort(([a], [b]) => a.localeCompare(b)),
  );
  // Central capability gate: a caller without `<collection>.read` at ANY scope never fires the request -
  // the server would only 403 it. The read returns empty+ready, so data-driven UI collapses to its empty
  // state instead of skeleton-ing forever or spraying denials. This is also what makes "view as" honest for
  // collections the simulated user cannot read at all. (A self-scoped grant still strips to
  // `<collection>.read`, so ordinary self-service pages keep fetching; the server narrows the rows.)
  const canRead = usePermission(`${collection}.read`);
  // Stable opts object so the store key + effect identity don't churn each render. `enabled` is deliberately
  // NOT part of the key (it gates the fetch, not the cached data) - a disabled reader just never fetches and
  // sees whatever rows the store already holds ([] until some enabled reader loads it).
  const stableOpts = useMemo(
    () => ({ showDeleted, deletedOnly, max, q, params: Object.fromEntries(JSON.parse(paramsKey) as [string, string][]) }),
    [showDeleted, deletedOnly, max, q, paramsKey],
  );

  const snap = useSyncExternalStore(
    useCallback((cb) => subscribe(collection, stableOpts, cb), [collection, stableOpts]),
    () => getSnapshot(collection, stableOpts),
  );

  // Trigger a fetch on mount / when the key changes (the store no-ops if fresh or already in flight). Skipped
  // when `enabled` is false so a component can hold off a read it may not need (e.g. a private-by-default
  // dashboard KPI the viewer can't see - no wasted D1 read).
  useEffect(() => {
    if (enabled && canRead) void ensureFetch(collection, stableOpts);
  }, [collection, stableOpts, enabled, canRead]);

  const reload = useCallback(() => {
    if (canRead) void ensureFetch(collection, stableOpts, true);
  }, [collection, stableOpts, canRead]);

  const setRows = useCallback(
    (updater: T[] | ((prev: T[]) => T[])) => {
      patchRows(collection, stableOpts, (prev) =>
        typeof updater === "function" ? (updater as (p: T[]) => T[])(prev as T[]) : updater,
      );
    },
    [collection, stableOpts],
  );

  // The server caps a page at 100 rows (http/pagination.ts clampPageSize) and nothing here follows the cursor,
  // so `rows` can be a WINDOW rather than the whole collection. The list response says so via `next_page_token`,
  // which the store already keeps on `meta` - surfaced here as `hasMore` so a view can admit it rather than
  // presenting the window as the total. Client-side filtering/sorting/export only ever sees `rows`.
  const hasMore = Boolean((snap.meta as { next_page_token?: string } | undefined)?.next_page_token);

  // Follow the cursor: appends the next server page to the cached rows (no-op when exhausted). Reader-driven --
  // wired to a "Load more" button, or to the reader reaching the foot of a feed (useInfiniteScroll). Never
  // speculative: no page is fetched until someone has actually run out of rows, so D1 reads stay demand-led.
  const loadMore = useCallback(() => loadMoreRows(collection, stableOpts), [collection, stableOpts]);

  // No read capability -> a settled empty view (never a stuck skeleton, never a request).
  if (!canRead) return { rows: [] as T[], setRows, state: "ready" as LoadState, error: undefined, reload, meta: undefined, hasMore: false, loadMore: () => {} };
  return { rows: snap.rows as T[], setRows, state: snap.state as LoadState, error: snap.error, reload, meta: snap.meta, hasMore, loadMore };
}

/** Whether the cached rows for a collection are only its FIRST PAGE (the list response returned a cursor).
 *  Read-only and fetch-free: it reports on whatever some other reader already loaded. Lets a view that filters
 *  or exports cached rows say so, instead of presenting a 100-row window as the whole collection. Accepts
 *  several collections for a view assembled from more than one - true if ANY of them is truncated. */
export function useCollectionHasMore(collection: string | string[] | undefined): boolean {
  const key = Array.isArray(collection) ? collection.join(",") : (collection ?? "");
  const getSnapshot = useCallback(() => key.split(",").some((c) => collectionHasMore(c || undefined)), [key]);
  return useSyncExternalStore(subscribeAny, getSnapshot, () => false);
}

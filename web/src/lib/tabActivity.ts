import { useEffect, useState } from "react";
import { get } from "@/api";
import { readPref, writePrefDeferred } from "@/lib/prefs";
import { subscribe, getSnapshot } from "@/lib/resourceStore";

// Per-tab "new activity" badges. A tab lights up with a count of items created since the last time the caller
// viewed that tab. Unlike the notification badges (private, per-recipient), this is a pure content signal:
// every item newer than the tab's stored "seen" timestamp counts. The count comes from the server
// (`GET /v1/activity-counts`, one request for the whole bar) - see useTabActivity below for why no collection
// is ever fetched to answer it.
//
// The seen map is a single per-user preferences row (`tab_seen`), so it follows the user across devices, with a
// localStorage cache for instant paint (same pattern as the theme preference), read through the shared
// prefs snapshot (lib/prefs.ts) so it costs no request of its own.

const LS_KEY = "tab_seen";
const PREF_KEY = "tab_seen"; // /v1/preferences/{key}
// Match the default page reads (max 200, live rows) so the activity fetch shares the store entry pages use.
const OPTS = { showDeleted: false, max: 200 } as const;

type SeenMap = Record<string, number>; // tabKey -> epoch ms last viewed

function loadLocal(): SeenMap {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

let seen: SeenMap = loadLocal();
const seenSubs = new Set<() => void>();
const subscribeSeen = (cb: () => void) => {
  seenSubs.add(cb);
  return () => seenSubs.delete(cb);
};
function notifySeen() {
  seenSubs.forEach((cb) => cb());
}

// "Viewed a tab" happens on every navigation, so this is the most-written preference in the app. The copy that
// matters here is the local one - it is what the next page load measures "new" against - so it is written
// immediately; the server copy (which exists only to carry cleared badges to another device) coalesces over a
// long quiet window and is flushed when the tab is hidden. One request per browsing session, not one per click.
const SERVER_SAVE_DEBOUNCE_MS = 30_000;

function persist() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(seen));
  } catch {
    /* ignore */
  }
  writePrefDeferred(PREF_KEY, seen, SERVER_SAVE_DEBOUNCE_MS);
}

// Mark a tab viewed as of now - clears its badge and advances the reference the next visit measures "new" from.
export function markTabSeen(tabKey: string) {
  if (!tabKey || seen[tabKey] === undefined || Date.now() - seen[tabKey]! > 1000) {
    seen = { ...seen, [tabKey]: Date.now() };
    persist();
    notifySeen();
  }
}

// Pull the cross-device seen map once after login and merge it with this browser's cache (newest wins per tab).
let synced = false;
export async function syncTabSeenFromServer() {
  if (synced) return;
  synced = true;
  {
    const v = await readPref<SeenMap>(PREF_KEY);
    if (v && typeof v === "object") {
      const merged: SeenMap = { ...v };
      for (const [k, t] of Object.entries(seen)) merged[k] = Math.max(merged[k] ?? 0, t);
      seen = merged;
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(seen));
      } catch {
        /* ignore */
      }
      notifySeen();
    }
    // No row yet (or offline): the local cache stands, and the first markTabSeen seeds the server row.
  }
}

// One badge target: a stable storage `key`, the `collection` to read, and an optional `filter` to count only
// matching rows (e.g. tickets assigned to me). Keys must be globally unique across pages - namespace in-page
// sub-tabs like "tickets:assigned" so they don't collide with a workspace route key.
export type TabSpec = { key: string; collection?: string; filter?: (row: any) => boolean };

/**
 * New-item counts for a set of tabs, keyed by spec key. A tab never seen before is baselined to now, so its
 * very first, history-less visit shows nothing - only items that arrive afterwards count. Pass `deps` for any
 * reactive value a filter closes over (e.g. the current user id) so counts recompute when it changes; the spec
 * array itself may be rebuilt each render.
 *
 * This NEVER FETCHES A COLLECTION. It used to: each badged tab's collection was fetched and its rows counted
 * client-side, so opening one page of a six-tab workspace read six pages of rows to render six small numbers -
 * on every navigation, the most expensive habit in the app. A badge is a number, so it now costs a count:
 *
 *   - a plain tab (no `filter`) is answered by `GET /v1/activity-counts`, ONE request for the whole bar, which
 *     counts over the search index by `created_at` under each collection's own list scope. Cheaper AND more
 *     honest than the old client count, which could only see the first page of rows.
 *   - a FILTERED tab is counted from whatever the resource store already holds, and nothing is fetched for it.
 *     Those are in-page sub-tabs ("my tickets" / "all tickets") over a collection the page is already reading,
 *     so the rows are there; if they aren't yet, the badge simply waits for them.
 */
export function useTabActivity(tabs: TabSpec[], deps: unknown[] = []): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const key = tabs.map((t) => `${t.key}:${t.collection ?? ""}:${t.filter ? "f" : ""}`).join(",");
  useEffect(() => {
    const withColl = tabs.filter((t) => t.collection);
    // Baseline any tab we have no reference for, so the first encounter doesn't badge the whole backlog.
    let seeded = false;
    for (const t of withColl) {
      if (seen[t.key] === undefined) {
        seen[t.key] = Date.now();
        seeded = true;
      }
    }
    if (seeded) persist();

    const local = withColl.filter((t) => t.filter); // counted from cached rows
    const remote = withColl.filter((t) => !t.filter); // counted by the server
    let live = true;
    // Server counts, held so a store notification (which only affects the local half) doesn't drop them.
    let fromServer: Record<string, number> = {};
    // The moment each server count was measured FROM. Visiting a tab advances its seen time, and the count we
    // already hold was measured from the older one - so it is spent, and the badge clears without re-asking.
    let askedFrom: Record<string, number> = {};

    const recompute = () => {
      const next: Record<string, number> = {};
      for (const [k, n] of Object.entries(fromServer)) next[k] = (seen[k] ?? 0) > (askedFrom[k] ?? 0) ? 0 : n;
      for (const t of local) {
        const snap = getSnapshot(t.collection!, OPTS);
        if (snap.state !== "ready") continue;
        const since = seen[t.key] ?? 0;
        let n = 0;
        for (const row of snap.rows as { create_time?: string }[]) {
          if (row.create_time && +new Date(row.create_time) > since && (!t.filter || t.filter(row))) n++;
        }
        next[t.key] = n;
      }
      setCounts(next);
    };

    // One request for every plain tab in the bar. Rides the GET coalescer like every other read, so it joins
    // the page's own batch rather than adding a round trip.
    if (remote.length) {
      const since = Object.fromEntries(remote.map((t) => [t.key, Math.floor(seen[t.key] ?? 0)]));
      const ask = remote.map((t) => `${t.collection}:${since[t.key]}`).join(",");
      get<{ counts?: Record<string, number> }>(`activity-counts?tabs=${encodeURIComponent(ask)}`)
        .then((r) => {
          if (!live) return;
          // Back from collection to tab key: the request asked per collection, the badge is per tab.
          const byCollection = r.counts ?? {};
          fromServer = Object.fromEntries(remote.map((t) => [t.key, byCollection[t.collection!] ?? 0]));
          askedFrom = since;
          recompute();
        })
        .catch(() => {
          /* a failed count is a missing badge, never a wrong one */
        });
    }

    // Only the FILTERED tabs need to follow the store; the rest are answered above.
    const cols = [...new Set(local.map((t) => t.collection!))];
    const unsubs = cols.map((c) => subscribe(c, OPTS, recompute));
    unsubs.push(subscribeSeen(recompute));
    recompute();
    return () => {
      live = false;
      unsubs.forEach((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ...deps]);
  return counts;
}

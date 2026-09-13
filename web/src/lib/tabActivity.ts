import { useEffect, useState } from "react";
import { get } from "@/api";
import { readPref, stagePref, writePrefDeferred } from "@/lib/prefs";
import { subscribe, getSnapshot } from "@/lib/resourceStore";
import { storedIdentity } from "@/lib/clientStore";

// Per-tab "new activity" badges. A tab lights up with a count of items created since the last time the caller
// viewed that tab. Unlike the notification badges (private, per-recipient), this is a pure content signal:
// every item newer than the tab's stored "seen" timestamp counts. The count comes from the server
// (`GET /v1/activity-counts`, one request for the whole bar) - see useTabActivity below for why no collection
// is ever fetched to answer it.
//
// The seen map is a single per-user preferences row (`tab_seen`), so it follows the user across devices, with a
// localStorage cache for instant paint (same pattern as the theme preference), read through the shared
// prefs snapshot (lib/prefs.ts) so it costs no request of its own.

// The local cache is namespaced to the caller; the server row is per-user already. It used to be one global
// key, which was wrong in both directions on a shared browser: the next person to sign in measured "new"
// against someone else's visits, and `syncTabSeenFromServer` merged those stamps INTO their preferences row
// (newest wins), so the leak followed them to their other devices and silently suppressed badges they had
// never seen. Read after identity is known - which is before any navigation can mark a tab seen.
//
// Null until the caller IS known, and every read and write of the cache is skipped while it is: an "anon"
// fallback key is written by whoever navigates before identity lands and then never read back (the sync below
// reads the real key), so those stamps were silently lost and the badge lit up again for activity the reader
// had already looked at.
const lsKey = () => {
  const id = storedIdentity();
  return id ? `tab_seen:${id}` : null;
};
const PREF_KEY = "tab_seen"; // /v1/preferences/{key}
// Match the default page reads (one page, live rows) so the activity fetch shares the store entry pages use.
// 100 rather than 200 because 100 is what the server grants (api.ts#listPath); the old number described a
// page nobody was ever given.
const OPTS = { showDeleted: false, max: 100 } as const;

type SeenMap = Record<string, number>; // tabKey -> epoch ms last viewed

function loadLocal(): SeenMap {
  const key = lsKey();
  if (!key) return {};
  try {
    const v = JSON.parse(localStorage.getItem(key) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** Mirror the in-memory map to this caller's cache. A no-op until the caller is known (see `lsKey`). */
function writeLocal(): void {
  const key = lsKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(seen));
  } catch {
    /* ignore */
  }
}

// Empty until `syncTabSeenFromServer` runs, which is the first moment the caller is known. Before that there is
// no honest answer: reading a global key would be reading whoever used this browser last.
let seen: SeenMap = {};
const seenSubs = new Set<() => void>();
const subscribeSeen = (cb: () => void) => {
  seenSubs.add(cb);
  return () => seenSubs.delete(cb);
};
function notifySeen() {
  seenSubs.forEach((cb) => cb());
}

// "Viewed a tab" happens on every navigation, so this map moves constantly - but the server copy exists for
// exactly ONE purpose: carrying a badge you cleared here to your other device. A visit to a tab that wasn't
// badged has nothing to carry, so it costs no request at all: the local copy (what the next page load measures
// "new" against) is written immediately, the shared snapshot and any sibling tab are staged, and that is it.
// Only a visit that actually clears a badge schedules a save, coalesced over a long quiet window and flushed
// when the tab is hidden.
const SERVER_SAVE_DEBOUNCE_MS = 30_000;

// What each tab's badge currently shows, published by every mounted useTabActivity below. This is how
// markTabSeen knows whether a visit is clearing anything; a tab with no badge configured is simply absent.
const shown = new Map<string, number>();

function persist(toServer: boolean) {
  writeLocal();
  if (toServer) writePrefDeferred(PREF_KEY, seen, SERVER_SAVE_DEBOUNCE_MS);
  else stagePref(PREF_KEY, seen);
}

// Mark a tab viewed as of now - clears its badge and advances the reference the next visit measures "new" from.
export function markTabSeen(tabKey: string) {
  if (!tabKey || seen[tabKey] === undefined || Date.now() - seen[tabKey]! > 1000) {
    // Read the badge BEFORE advancing the reference, which is what clears it.
    const clearing = (shown.get(tabKey) ?? 0) > 0;
    seen = { ...seen, [tabKey]: Date.now() };
    persist(clearing);
    notifySeen();
  }
}

// Pull the cross-device seen map once after login and merge it with this browser's cache (newest wins per tab).
let synced = false;
export async function syncTabSeenFromServer() {
  if (synced) return;
  synced = true;
  {
    // Now that the caller is known, this browser's copy of THEIR map can be read; before this the module holds
    // nothing, so a badge measures against the server row (or baselines itself) rather than against a stranger.
    // MERGED, not assigned: a navigation between first paint and this moment advanced the in-memory map but
    // could not write it (there was no key to write to), and that visit still counts as seen.
    const local = loadLocal();
    for (const [k, t] of Object.entries(seen)) local[k] = Math.max(local[k] ?? 0, t);
    seen = local;
    writeLocal();
    notifySeen();
    const v = await readPref<SeenMap>(PREF_KEY);
    if (v && typeof v === "object") {
      const merged: SeenMap = { ...v };
      for (const [k, t] of Object.entries(seen)) merged[k] = Math.max(merged[k] ?? 0, t);
      seen = merged;
      writeLocal();
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
    // REPLACED, not mutated in place - the one convention in this module, since `seen` is what `stagePref` and
    // `writePrefDeferred` hand around: mutating it made whether a staged change was visible to a pending write
    // depend on which code path produced it.
    let seeded = false;
    const baselined = { ...seen };
    for (const t of withColl) {
      if (baselined[t.key] === undefined) {
        baselined[t.key] = Date.now();
        seeded = true;
      }
    }
    if (seeded) seen = baselined;
    // A baseline is not a cleared badge - there was nothing to clear - so it stays off the wire. The other
    // device baselines its own first visit the same way.
    if (seeded) persist(false);

    const local = withColl.filter((t) => t.filter); // counted from cached rows
    const remote = withColl.filter((t) => !t.filter); // counted by the server
    let live = true;
    // Server counts, held so a store notification (which only affects the local half) doesn't drop them.
    let fromServer: Record<string, number> = {};
    // The moment each server count was measured FROM. Visiting a tab advances its seen time, and the count we
    // already hold was measured from the older one - so it is spent, and the badge clears without re-asking.
    let askedFrom: Record<string, number> = {};
    // Counts that landed already spent: the tab was visited before its number came back (landing directly on a
    // badged tab), so the badge cleared without ever being drawn. markTabSeen couldn't see it to know the visit
    // was worth carrying to another device, so it is carried from here - once per count, not per recompute.
    const carried = new Set<string>();

    const recompute = () => {
      const next: Record<string, number> = {};
      for (const [k, n] of Object.entries(fromServer)) {
        const spent = (seen[k] ?? 0) > (askedFrom[k] ?? 0);
        next[k] = spent ? 0 : n;
        if (spent && n > 0 && !carried.has(k)) {
          carried.add(k);
          writePrefDeferred(PREF_KEY, seen, SERVER_SAVE_DEBOUNCE_MS);
        }
      }
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
      // Publish for markTabSeen, which uses it to tell a badge-clearing visit from a plain one.
      for (const [k, n] of Object.entries(next)) shown.set(k, n);
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
      for (const t of withColl) shown.delete(t.key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ...deps]);
  return counts;
}

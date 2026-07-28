import { useEffect, useState } from "react";
import { get, patch } from "@/api";
import { ensureFetch, subscribe, getSnapshot } from "@/lib/resourceStore";

// Per-tab "new activity" badges. A tab lights up with a count of items created since the last time the caller
// viewed that tab. Unlike the notification badges (private, per-recipient), this is a pure content signal read
// straight off the collections the resource store already caches - opening a workspace kicks a coalesced fetch
// of its sibling tabs, and every item newer than the tab's stored "seen" timestamp counts.
//
// The seen map is a single per-user preferences row (`tab_seen`), so it follows the user across devices, with a
// localStorage cache for instant paint (same pattern as the theme preference).

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

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persist() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(seen));
  } catch {
    /* ignore */
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    patch(`preferences/${PREF_KEY}`, { value: seen }).catch(() => {});
  }, 600);
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
  try {
    const r = await get<{ value?: SeenMap }>(`preferences/${PREF_KEY}`);
    const v = r?.value;
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
  } catch {
    /* 404 (no row yet) or offline: the local cache stands, and the first markTabSeen seeds the server row. */
  }
}

// One badge target: a stable storage `key`, the `collection` to read, and an optional `filter` to count only
// matching rows (e.g. tickets assigned to me). Keys must be globally unique across pages - namespace in-page
// sub-tabs like "tickets:assigned" so they don't collide with a workspace route key.
export type TabSpec = { key: string; collection?: string; filter?: (row: any) => boolean };

// New-item counts for a set of tabs, keyed by spec key. Fetches each collection (coalesced), then counts rows
// created after that tab's seen timestamp (and matching its filter). A tab never seen before is baselined to
// now, so its very first, history-less visit shows nothing - only items that arrive afterwards count. Pass
// `deps` for any reactive value a filter closes over (e.g. the current user id) so counts recompute when it
// changes; the spec array itself may be rebuilt each render.
export function useTabActivity(tabs: TabSpec[], deps: unknown[] = []): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const key = tabs.map((t) => `${t.key}:${t.collection ?? ""}`).join(",");
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

    const recompute = () => {
      const next: Record<string, number> = {};
      for (const t of withColl) {
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

    const cols = [...new Set(withColl.map((t) => t.collection!))];
    const unsubs = cols.map((c) => subscribe(c, OPTS, recompute));
    unsubs.push(subscribeSeen(recompute));
    for (const c of cols) void ensureFetch(c, OPTS);
    recompute();
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ...deps]);
  return counts;
}

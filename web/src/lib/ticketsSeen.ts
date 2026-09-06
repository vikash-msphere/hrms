// "Updated since you last opened it" for tickets: a map of ticket path -> the `update_time` this browser last
// showed, plus a `_baseline` stamped on the first visit so a year of old history doesn't all light up at once.
//
// Deliberately client-side. A read receipt per person per ticket would be a table and a write on every row
// scrolled past, to drive a dot; what this actually needs to know is what THIS browser has already shown, which
// is exactly what the browser can answer for itself.
//
// It lives here rather than in pages/Tickets.tsx for one reason: it is the only unbounded key family the app
// writes - one entry per ticket, forever - so its pruning rule has to be reachable from the boot-time sweep
// (lib/clientStore.ts `gc`) without pulling the whole Tickets page chunk into the main bundle.
import { storedIdentity } from "@/lib/clientStore";

// Namespaced to the CALLER, like the drafts and the tab badges. One global key was wrong on a shared machine:
// the next person to sign in measured "new" against someone else's reading, so every ticket the previous user
// had already opened stayed quiet for them - the dot they needed never appeared.
const BASE_KEY = "tickets-last-seen";
const seenKey = () => `${BASE_KEY}:${storedIdentity() ?? "anon"}`;

/** How long a ticket's last-seen stamp is worth keeping. Past this the dot is meaningless anyway: a ticket
 *  nobody has opened in three months is either closed or forgotten, and the `_baseline` covers both. */
const MAX_AGE_MS = 90 * 24 * 60 * 60_000;

export type SeenMap = Record<string, string>;

export function loadSeen(): SeenMap {
  try {
    return JSON.parse(localStorage.getItem(seenKey()) ?? "{}") as SeenMap;
  } catch {
    return {};
  }
}

export function saveSeen(map: SeenMap): void {
  try {
    localStorage.setItem(seenKey(), JSON.stringify(map));
  } catch {
    /* private mode: the dot is right for this session and forgotten after it */
  }
}

/** Stamp the baseline on a first visit, so only genuinely new activity shows a dot. */
export function seedSeen(): SeenMap {
  const s = loadSeen();
  if (!s._baseline) {
    s._baseline = new Date().toISOString();
    saveSeen(s);
  }
  return s;
}

/** Drop stamps older than MAX_AGE_MS. `_baseline` always survives - it is what unseen tickets measure against. */
export function pruneSeenTickets(map: SeenMap): SeenMap {
  const cutoff = Date.now() - MAX_AGE_MS;
  const kept: SeenMap = {};
  for (const [path, at] of Object.entries(map)) {
    if (path === "_baseline" || +new Date(at) >= cutoff) kept[path] = at;
  }
  return kept;
}

/**
 * The boot-time sweep, called by `gc()`.
 *
 * This module owns the key SHAPE as well as the pruning rule, so it does the whole job rather than handing
 * `gc` a map: the bare `tickets-last-seen` an older build wrote is removed outright (nothing reads it any
 * more), and every namespaced map is pruned in place.
 */
export function sweepSeenTickets(): void {
  try {
    localStorage.removeItem(BASE_KEY);
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(`${BASE_KEY}:`)) keys.push(k);
    }
    for (const k of keys) {
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      localStorage.setItem(k, JSON.stringify(pruneSeenTickets(JSON.parse(raw) as SeenMap)));
    }
  } catch {
    /* storage denied or a corrupt value: there is nothing to collect */
  }
}

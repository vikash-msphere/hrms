import { useEffect, useState } from "react";
import { getConditional } from "@/api";
import type { Celebration } from "@/types";

/**
 * Birthdays and work anniversaries, read ONCE PER TAB and revalidated rather than re-fetched.
 *
 * WHY THIS IS NOT A BARE `get()`. `employees:upcomingCelebrations` is the most expensive read in the app for
 * what it returns: the server walks the live employee roster and decrypts one AES-GCM blob per person to pull
 * a date of birth out of it (src/services/celebrations.ts). It is in the seeded allow list for every role, and
 * it had two callers firing it with a plain `get()` on every mount - the Dashboard whenever the calendar, the
 * KPI row or the timeline is on screen, and the leave calendar whenever the celebrations layer is switched on.
 * Per user, per dashboard load, forever.
 *
 * It is a CUSTOM METHOD, not a collection, so neither `useCollection` nor `lib/resourceStore.ts` reaches it -
 * which is why it had no caching of any kind. The route now answers with the same validator the factory's
 * lists use (src/http/listEtag.ts), and this holds it: a second mount revalidates, the server matches from one
 * indexed row, and the roster is never read and nothing is decrypted.
 *
 * MEMORY ONLY, deliberately. The rows name every colleague and their birthday, which is ordinary inside the
 * app and not something to leave on a disk the org may not own - the same judgement `MEMORY_ONLY` records for
 * the sensitive collections. A cache keyed per tab and lost on reload is the right lifetime for a card that
 * changes once a day.
 */
type Held = { etag?: string; rows: Celebration[] };
const held = new Map<number, Held>();

export function useCelebrations(within: number, enabled: boolean): { rows: Celebration[]; loading: boolean } {
  const [rows, setRows] = useState<Celebration[]>(() => held.get(within)?.rows ?? []);
  // A held copy is shown immediately and revalidated behind it, so the card does not flash a spinner on every
  // remount for an answer that has not changed.
  const [loading, setLoading] = useState(() => !held.has(within));

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const cached = held.get(within);
    if (cached) setRows(cached.rows);
    setLoading(!cached);
    void getConditional<{ results: Celebration[] }>(`employees:upcomingCelebrations?within=${within}`, cached?.etag)
      .then((answer) => {
        if (!live) return;
        if (answer.notModified) return; // the held copy stands
        const next = answer.body.results ?? [];
        held.set(within, { etag: answer.etag, rows: next });
        setRows(next);
      })
      // A card that decorates the dashboard is never the reason the page exists: a failure renders nothing
      // rather than an error, and the next mount tries again.
      .catch(() => { if (live) setRows(cached?.rows ?? []); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [within, enabled]);

  return { rows, loading };
}

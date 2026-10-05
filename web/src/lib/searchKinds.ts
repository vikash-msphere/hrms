import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readPref, writePrefDeferred } from "@/lib/prefs";

// Which kinds of record each person narrows ⌘K to, and opens from it: the `in:` suggestions' ranking after the
// page they are on (paletteQuery.ts rankKindOffers). Bumped when an `in:` suggestion is taken and when a record
// result is opened. Kept in the caller's own `preferences` row, so it follows them to another browser like the
// saved searches do (lib/savedSearches.ts), and only ever about kinds - never which record or what was typed.
//
// The value is the whole map, written back whole: two devices bumping inside the same few seconds lose one bump,
// which costs a ranking hint, not data.

/** A use count and when it last happened (epoch ms). */
export type Use = { n: number; t: number };

/** Use count decayed by recency: recent and frequent floats up, stale fades. Shared with the palette's
 *  page/record frecency (CommandPalette.tsx), so both learn at the same rate. */
export function frecencyScore(e?: Use): number {
  if (!e) return 0;
  const days = (Date.now() - e.t) / 86_400_000;
  return e.n / (1 + days); // linear recency decay
}

const PREF_KEY = "search_kinds"; // /v1/preferences/{key}
/** The strongest kinds kept: the head of the chip row, not a history. */
const KEEP = 24;

// Stored as `{ kinds: {...} }`: a preference's value is an object by contract (openapi.yaml).
function kindsOf(v: unknown): Record<string, Use> {
  const kinds = (v as { kinds?: unknown } | null)?.kinds;
  if (!kinds || typeof kinds !== "object") return {};
  return Object.fromEntries(
    Object.entries(kinds as Record<string, Use>).filter(([, u]) => !!u && typeof u.n === "number" && typeof u.t === "number"),
  );
}

/**
 * The caller's kind affinity (collection -> decayed score), read the first time `enabled` is true (the search
 * being opened), and `bump` to count one more use of a kind.
 */
export function useKindAffinity(enabled: boolean): { affinity: ReadonlyMap<string, number>; bump: (collection: string) => void } {
  const [kinds, setKinds] = useState<Record<string, Use>>({});
  const latest = useRef(kinds);
  latest.current = kinds;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    // readPref answers absent rather than failing (lib/prefs.ts), so there is no rejection to handle.
    void readPref<unknown>(PREF_KEY).then((v) => live && setKinds(kindsOf(v)));
    return () => {
      live = false;
    };
  }, [enabled]);
  // Computed from the ref rather than in a state updater: the write is a side effect (see navPrefs.ts).
  const bump = useCallback((collection: string) => {
    const prev = latest.current[collection];
    const next = Object.fromEntries(
      Object.entries({ ...latest.current, [collection]: { n: (prev?.n ?? 0) + 1, t: Date.now() } })
        .sort(([, a], [, b]) => frecencyScore(b) - frecencyScore(a))
        .slice(0, KEEP),
    );
    latest.current = next;
    setKinds(next);
    // Coalesced over 30 s, as tab_seen is (lib/tabActivity.ts): a pick and the few results opened after it are
    // one D1 write, not one each, and the write still goes out when the tab hides.
    writePrefDeferred(PREF_KEY, { kinds: next }, 30_000);
  }, []);
  const affinity = useMemo(() => new Map(Object.entries(kinds).map(([c, u]) => [c, frecencyScore(u)])), [kinds]);
  return { affinity, bump };
}

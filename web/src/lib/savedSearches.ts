import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/ui/use-toast";
import { readPref, updatePref } from "@/lib/prefs";

// Searches a person saved by name, run again from a chip at the front of the search's chip row
// (CommandPalette.tsx). Stored in the caller's own `preferences` row, so they follow the person to another
// browser or machine like the theme and the sidebar do (cross-device prefs).
//
// What is saved is everything that makes the search what it is: the words in the box (filter words included),
// the category chip, and the Filters menu's choices - so running it again is exactly the search that was saved.

export type SavedSearch = {
  id: string;
  name: string;
  query: string;
  scope: string; // the category chip ("all", "people", "time", ...)
  refine: { owner: string; since: string; sort: string }; // the Filters menu, as the palette's `Refine`
  // Shown as a chip at the front of the search's chip row, one press away. Off unless the person pins it: every
  // saved search is in the Saved menu, and only the ones they reach for every day earn room in the row.
  pinned?: boolean;
};

const PREF_KEY = "saved_searches"; // /v1/preferences/{key}
/** How many a person can keep: a chip row, not a library. The oldest makes way for a new one. */
export const SAVED_MAX = 8;

function isSaved(v: unknown): v is SavedSearch {
  const s = v as SavedSearch | null;
  return !!s && typeof s === "object" && typeof s.id === "string" && typeof s.name === "string" && typeof s.query === "string"
    && typeof s.scope === "string" && !!s.refine && typeof s.refine === "object";
}
// Stored as `{ searches: [...] }`: a preference's value is an object by contract (openapi.yaml), so the list is
// wrapped, as `push_subscriptions` wraps its `subs`.
type Stored = { searches?: unknown };
const listOf = (v: unknown): SavedSearch[] => {
  const searches = (v as Stored | null)?.searches;
  return Array.isArray(searches) ? searches.filter(isSaved) : [];
};

/**
 * The caller's saved searches, read the first time `enabled` is true (the search being opened - not on every
 * page load), and the ways to change them. Every change goes through `updatePref`: it is ONE list that every
 * device appends to, so it is re-read before the edit and written back guarded on that read (lib/prefs.ts).
 */
export function useSavedSearches(enabled: boolean) {
  const [saved, setSaved] = useState<SavedSearch[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    // readPref answers absent rather than failing (lib/prefs.ts), so there is no rejection to handle.
    void readPref<unknown>(PREF_KEY).then((v) => live && setSaved(listOf(v)));
    return () => {
      live = false;
    };
  }, [enabled]);

  const { toast } = useToast();
  // A change that cannot be made safely (the stored list could not be read, or kept changing underneath) is
  // refused and said so, never written from a guess: the list on screen stays what is stored.
  const change = useCallback(async (update: (list: SavedSearch[]) => SavedSearch[]) => {
    try {
      const next = await updatePref<Stored>(PREF_KEY, (v) => ({ searches: update(listOf(v)) }));
      setSaved(listOf(next));
    } catch {
      toast({ variant: "destructive", title: "Saved searches not changed", description: "They couldn't be read just now. Try again in a moment." });
    }
  }, [toast]);

  const save = useCallback(
    (s: Omit<SavedSearch, "id">) =>
      change((list) => {
        // The same search saved again replaces the old one (under its new name) rather than doubling it.
        const same = (o: SavedSearch) => o.query === s.query && o.scope === s.scope && JSON.stringify(o.refine) === JSON.stringify(s.refine);
        return [{ ...s, id: crypto.randomUUID() }, ...list.filter((o) => !same(o))].slice(0, SAVED_MAX);
      }),
    [change],
  );
  const rename = useCallback((id: string, name: string) => change((list) => list.map((o) => (o.id === id ? { ...o, name } : o))), [change]);
  const pin = useCallback((id: string, pinned: boolean) => change((list) => list.map((o) => (o.id === id ? { ...o, pinned } : o))), [change]);
  const remove = useCallback((id: string) => change((list) => list.filter((o) => o.id !== id)), [change]);
  return { saved, save, rename, pin, remove };
}

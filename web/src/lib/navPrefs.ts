import { useCallback, useEffect, useRef, useState } from "react";
import { readPref, writePrefDeferred } from "@/lib/prefs";
import { readLocal, writeLocal } from "@/lib/localPref";

// The sidebar's shape: collapsed to the icon rail or not, and which groups are folded. Persisted per user via
// /v1/preferences (cross-device source of truth, so the sidebar comes back the same in another browser or on
// another machine) with a localStorage copy for first paint, following the same pattern as theme.ts /
// dashboardPrefs.ts.
//
// The localStorage keys are namespaced to the caller's email and listed in lib/clientStore.ts `LOOK_KEYS`, so
// they also survive a sign-out and the app lock on this browser.
export type NavPrefs = {
  rail: boolean; // the whole sidebar collapsed to the w-16 icon rail (the manual choice, not the narrow auto-rail)
  collapsed: string[]; // labels of the groups the user folded
};

const PREF_KEY = "nav"; // /v1/preferences/{key}
const collapseKey = (email: string) => `nav:collapsed:${email}`;
const railKey = (email: string) => `nav:rail:${email}`;

function isNavPrefs(v: unknown): v is NavPrefs {
  const p = v as NavPrefs | null;
  return !!p && typeof p === "object" && typeof p.rail === "boolean" && Array.isArray(p.collapsed) && p.collapsed.every((g) => typeof g === "string");
}

function loadLocal(email: string): NavPrefs {
  let collapsed: string[] = [];
  try {
    const v = JSON.parse(readLocal(collapseKey(email)) || "[]");
    if (Array.isArray(v)) collapsed = v.filter((g): g is string => typeof g === "string");
  } catch {
    /* a malformed copy reads as nothing folded */
  }
  return { rail: readLocal(railKey(email)) === "1", collapsed };
}

function saveLocal(email: string, p: NavPrefs) {
  writeLocal(railKey(email), p.rail ? "1" : "0");
  writeLocal(collapseKey(email), JSON.stringify(p.collapsed));
}

/** The caller's sidebar prefs: this browser's copy immediately, the server row once it arrives, and an
 *  updater that writes both. */
export function useNavPrefs(email: string): [NavPrefs, (patch: Partial<NavPrefs>) => void] {
  const [prefs, setPrefs] = useState<NavPrefs>(() => loadLocal(email));
  const latest = useRef(prefs);
  latest.current = prefs;
  useEffect(() => {
    let live = true;
    readPref<unknown>(PREF_KEY)
      .then((v) => {
        if (!live) return;
        if (isNavPrefs(v)) {
          setPrefs(v);
          saveLocal(email, v);
        } else {
          // No row yet: seed it from this browser, so the sidebar someone already arranged here is what their
          // other browsers pick up, rather than every one of them starting from the default.
          writePrefDeferred(PREF_KEY, latest.current, 5_000);
        }
      })
      .catch(() => {}); // offline: this browser's copy stands
    return () => {
      live = false;
    };
  }, [email]);
  // Computed from the ref rather than in a state updater: the writes are side effects, and StrictMode runs an
  // updater twice (see dashboardPrefs.ts).
  const update = useCallback(
    (patch: Partial<NavPrefs>) => {
      const next = { ...latest.current, ...patch };
      latest.current = next; // two updates in one tick compose
      setPrefs(next);
      saveLocal(email, next);
      // Coalesced like the other preferences: a few quick folds cost one request, flushed when the tab hides.
      writePrefDeferred(PREF_KEY, next, 5_000);
    },
    [email],
  );
  return [prefs, update];
}

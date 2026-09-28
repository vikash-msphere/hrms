import { useCallback, useEffect, useRef, useState } from "react";
import { storedIdentity } from "@/lib/clientStore";
import { readPref, writePrefDeferred } from "@/lib/prefs";
import type { KpiCategory } from "@/lib/dashboardConfig";

// The viewer's PERSONAL dashboard layout - distinct from the org-wide settings/dashboard blob (who may see
// what). Persisted per user via /v1/preferences (cross-device source of truth) with a localStorage cache for
// instant first paint, following the same pattern as theme.ts / tablePrefs.ts.
export type DashPersonalPrefs = {
  catFilter?: KpiCategory | null; // focused KPI band (legend pill); null/undefined = show all
  hideClear?: boolean; // drop zero-valued neutral cards from the grid
  pinnedKpis?: string[]; // KPI keys floated to the front of the wall
  hiddenKpis?: string[]; // KPI keys the viewer chose to hide (their own declutter, not org config)
  timelineOpen?: boolean; // mobile-only: whether the team timeline section is expanded
  // Whole-section layout (the "Customize" popover): the viewer's section order and the sections they switched
  // off. Section keys from DASH_SECTIONS (Dashboard.tsx); unknown saved keys are dropped and newly-shipped
  // sections append in default position, so stale prefs never hide new features.
  sectionOrder?: string[];
  hiddenSections?: string[];
};

const PREF_KEY = "dashboard"; // /v1/preferences/{key}
// NAMESPACED to the caller, like `tab_seen:`, `dt:` and `draft:`. `loadLocal` is the `useState` initializer, so
// the dashboard paints from this key before the server row arrives: under one global key that was user A's
// pinned KPIs, hidden KPIs, hidden sections and section order shown to user B on a shared browser - and since
// the `readPref` guard only replaces it when a row comes BACK, a B with no row yet kept A's layout, and their
// next pin or hide wrote it to B's server row. `lib/tabActivity.ts` documents the same failure for its own key.
//
// Null until the identity is known: an "anon" copy written before it lands is adopted by the first real caller,
// which is the leak with an extra step.
const lsKey = () => {
  const id = storedIdentity();
  return id ? `dash.personal:${id}` : null;
};
function loadLocal(): DashPersonalPrefs {
  const key = lsKey();
  if (!key) return {};
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as DashPersonalPrefs) : {};
  } catch {
    return {};
  }
}

function writeLocal(p: DashPersonalPrefs) {
  const key = lsKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(p));
  } catch {
    /* private mode */
  }
}

function persist(p: DashPersonalPrefs) {
  writeLocal(p);
  // Coalesced like the other high-churn preferences: one request per quiet window (or when the tab is hidden),
  // not one per pin/hide/reorder.
  writePrefDeferred(PREF_KEY, p, 5_000);
}

/** Personal dashboard prefs: localStorage snapshot immediately, the server row (cross-device) once it
 *  arrives, and a merge-updater that persists to both. */
export function useDashPrefs(): [DashPersonalPrefs, (patch: Partial<DashPersonalPrefs>) => void] {
  const [prefs, setPrefs] = useState<DashPersonalPrefs>(loadLocal);
  useEffect(() => {
    let live = true;
    readPref<DashPersonalPrefs>(PREF_KEY)
      .then((v) => {
        if (live && v && typeof v === "object") {
          setPrefs(v);
          writeLocal(v);
        }
      })
      .catch(() => {}); // no row yet or offline - the local snapshot stands
    return () => {
      live = false;
    };
  }, []);
  // The next value is computed from a ref rather than inside the updater, because `persist` is a side effect:
  // a localStorage write, a read-modify-write of the unconfirmed record and a `setTimeout` re-arm. A React
  // updater must be pure - React re-runs it whenever it likes, and StrictMode (web/src/main.tsx) deliberately
  // invokes it twice - so every one of those happened twice per pin, hide or reorder.
  const latest = useRef(prefs);
  latest.current = prefs;
  const update = useCallback((p: Partial<DashPersonalPrefs>) => {
    const next = { ...latest.current, ...p };
    latest.current = next; // so two updates in one tick compose rather than the second dropping the first
    setPrefs(next);
    persist(next);
  }, []);
  return [prefs, update];
}

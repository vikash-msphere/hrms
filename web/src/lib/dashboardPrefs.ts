import { useCallback, useEffect, useState } from "react";
import { get, patch } from "@/api";
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
const LS_KEY = "dash.personal";
// The pre-prefs "hide all-clear" toggle lived under this key; migrate it once so nobody loses the setting.
const LEGACY_HIDE_CLEAR_KEY = "dash.hideAllClear";

function loadLocal(): DashPersonalPrefs {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as DashPersonalPrefs;
    return localStorage.getItem(LEGACY_HIDE_CLEAR_KEY) === "1" ? { hideClear: true } : {};
  } catch {
    return {};
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persist(p: DashPersonalPrefs) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(p));
  } catch {
    /* private mode */
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    patch(`preferences/${PREF_KEY}`, { value: p }).catch(() => {});
  }, 700);
}

/** Personal dashboard prefs: localStorage snapshot immediately, the server row (cross-device) once it
 *  arrives, and a merge-updater that persists to both. */
export function useDashPrefs(): [DashPersonalPrefs, (patch: Partial<DashPersonalPrefs>) => void] {
  const [prefs, setPrefs] = useState<DashPersonalPrefs>(loadLocal);
  useEffect(() => {
    let live = true;
    get<{ value?: DashPersonalPrefs }>(`preferences/${PREF_KEY}`)
      .then((r) => {
        if (live && r?.value && typeof r.value === "object") {
          setPrefs(r.value);
          try {
            localStorage.setItem(LS_KEY, JSON.stringify(r.value));
          } catch {
            /* private mode */
          }
        }
      })
      .catch(() => {}); // 404 (none yet) or offline - the local snapshot stands
    return () => {
      live = false;
    };
  }, []);
  const update = useCallback((p: Partial<DashPersonalPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...p };
      persist(next);
      return next;
    });
  }, []);
  return [prefs, update];
}

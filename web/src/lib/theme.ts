import { useCallback, useEffect, useState } from "react";
import { readPref, writePref } from "@/lib/prefs";
import { readLocal, writeLocal } from "@/lib/localPref";

// Theme preference. The server (per-user `preferences/theme` row, read through the shared prefs snapshot in
// lib/prefs.ts) is the cross-device source of truth;
// localStorage is a no-flash cache read by the inline script in index.html on first paint. On login we
// pull the server row (syncThemeFromServer) and it wins if it differs; on every change we push it back.
// Keep the storage key in step with that inline script.
export type Theme = "light" | "dark" | "system";
const STORAGE_KEY = "theme";
const PREF_KEY = "theme"; // /v1/preferences/{key}

function isTheme(v: unknown): v is Theme {
  return v === "light" || v === "dark" || v === "system";
}

// Push the caller's preference to the server (fire-and-forget, lightly debounced).
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persistToServer(theme: Theme) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void writePref(PREF_KEY, { theme });
  }, 400);
}

// Pull the server-stored preference once after login and apply it. Call when `me` is known.
let synced = false;
export async function syncThemeFromServer() {
  if (synced) return;
  synced = true;
  const stored = await readPref<{ theme?: unknown }>(PREF_KEY);
  const t = stored?.theme;
  if (isTheme(t)) {
    if (t !== getStoredTheme()) {
      writeLocal(STORAGE_KEY, t);
      applyResolved(resolveTheme(t), true);
      window.dispatchEvent(new Event("themechange"));
    }
    return;
  }
  // No row yet (or a malformed one) -> seed the server from this browser so other devices pick it up.
  persistToServer(getStoredTheme());
}

const mql = () => window.matchMedia("(prefers-color-scheme: dark)");

// Guarded, and it has to be: `useTheme` calls this from a `useState` INITIALIZER, so a browser with site data
// blocked (Safari "Block All Cookies", enterprise policy, some webviews) threw a SecurityError during render
// and the whole app came up as the crash boundary. "No stored theme" and "no storage at all" are the same
// answer here - fall back to `system` and let the OS decide - which is what the inline theme-init.js in
// web/index.html has always done.
export function getStoredTheme(): Theme {
  const v = readLocal(STORAGE_KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

// The concrete light/dark a given preference resolves to right now.
export function resolveTheme(theme: Theme): "light" | "dark" {
  return theme === "system" ? (mql().matches ? "dark" : "light") : theme;
}

// Flip the `.dark` class to match a resolved mode. `animate` runs a brief colour cross-fade (used for an
// explicit user toggle, not the silent first-paint or OS-driven change).
export function applyResolved(resolved: "light" | "dark", animate = false) {
  const root = document.documentElement;
  if (animate) {
    root.classList.add("theme-transition");
    window.setTimeout(() => root.classList.remove("theme-transition"), 250);
  }
  root.classList.toggle("dark", resolved === "dark");
}

// App-wide theme hook: returns the stored preference, the resolved mode, and a setter that persists and
// applies. While on "system" it tracks OS changes live.
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);
  const [resolved, setResolved] = useState<"light" | "dark">(() => resolveTheme(getStoredTheme()));

  useEffect(() => {
    const m = mql();
    const onChange = () => {
      if (getStoredTheme() === "system") {
        const r = m.matches ? "dark" : "light";
        applyResolved(r);
        setResolved(r);
      }
    };
    m.addEventListener("change", onChange);
    // syncThemeFromServer applies a cross-device pref out of band; re-read so the toggle reflects it.
    const onSync = () => {
      const t = getStoredTheme();
      setThemeState(t);
      setResolved(resolveTheme(t));
    };
    window.addEventListener("themechange", onSync);
    return () => {
      m.removeEventListener("change", onChange);
      window.removeEventListener("themechange", onSync);
    };
  }, []);

  const setTheme = useCallback((next: Theme) => {
    // The write may be refused (storage blocked); the theme still applies for this page, and the server pref
    // below is what carries it across devices anyway.
    writeLocal(STORAGE_KEY, next);
    const r = resolveTheme(next);
    applyResolved(r, true);
    setThemeState(next);
    setResolved(r);
    // Other useTheme() consumers (e.g. the sidebar logo, which swaps light/dark artwork) hold their own state,
    // so announce the change the same way syncThemeFromServer does.
    window.dispatchEvent(new Event("themechange"));
    persistToServer(next);
  }, []);

  // Convenience: cycle light -> dark -> system for a single-button toggle.
  const cycle = useCallback(() => {
    setTheme(theme === "light" ? "dark" : theme === "dark" ? "system" : "light");
  }, [theme, setTheme]);

  return { theme, resolved, setTheme, cycle };
}

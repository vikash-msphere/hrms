import { useCallback, useEffect, useState } from "react";
import { get, patch, ApiError } from "@/api";

// Theme preference. The server (per-user `preferences/theme` row) is the cross-device source of truth;
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
    patch(`preferences/${PREF_KEY}`, { value: { theme } }).catch(() => {});
  }, 400);
}

// Pull the server-stored preference once after login and apply it. Call when `me` is known.
let synced = false;
export async function syncThemeFromServer() {
  if (synced) return;
  synced = true;
  try {
    const r = await get<{ value?: { theme?: unknown } }>(`preferences/${PREF_KEY}`);
    const t = r?.value?.theme;
    if (isTheme(t)) {
      if (t !== getStoredTheme()) {
        localStorage.setItem(STORAGE_KEY, t);
        applyResolved(resolveTheme(t), true);
        window.dispatchEvent(new Event("themechange"));
      }
      return;
    }
    // Row exists but malformed: seed it from this browser's cache.
    persistToServer(getStoredTheme());
  } catch (e) {
    // No row yet -> seed the server from this browser so other devices pick it up. Other errors: ignore.
    if (e instanceof ApiError && e.status === 404) persistToServer(getStoredTheme());
  }
}

const mql = () => window.matchMedia("(prefers-color-scheme: dark)");

export function getStoredTheme(): Theme {
  const v = localStorage.getItem(STORAGE_KEY);
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
    localStorage.setItem(STORAGE_KEY, next);
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

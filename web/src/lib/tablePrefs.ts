import { readPref, writePrefDeferred } from "@/lib/prefs";

// Saved per-table layout. Persisted per user via /v1/preferences, with a
// localStorage cache for instant load and offline tolerance.
// A named snapshot of everything that decides WHICH rows a table shows and in what shape
// ("Active engineers", "Pending high-priority"). It covers the server-side search box and the
// visible column set too - a view that restored only the column filters would appear to do
// nothing on a page whose narrowing is done through the search box.
export type SavedView = {
  name: string;
  sort?: string; // "columnId.asc" | "columnId.desc"
  filters: Record<string, string>;
  search?: string; // value of the page's server-side search box, when the table has one
  hidden?: string[]; // hidden column ids; undefined leaves the current column layout alone
  isDefault?: boolean; // applied on load when the URL carries no explicit table state
};

export type TablePrefs = {
  order?: string[];
  hidden?: string[];
  widths?: Record<string, number>;
  pageSize?: number; // 0 = show all
  density?: "comfortable" | "compact";
  views?: SavedView[];
};

// The server is the source of truth (rows are scoped per user). localStorage is just
// an instant-load cache; namespace it by user so layouts never bleed across accounts
// sharing a browser.
let currentUser = "anon";
export function setTablePrefsUser(userKey: string | undefined) {
  currentUser = userKey || "anon";
}
const lsKey = (id: string) => `dt:${currentUser}:${id}`;
const prefKey = (id: string) => `table_${id}`;

export function loadLocalPrefs(tableId?: string): TablePrefs {
  if (!tableId) return {};
  try {
    return JSON.parse(localStorage.getItem(lsKey(tableId)) || "{}");
  } catch {
    return {};
  }
}

export async function fetchServerPrefs(tableId?: string): Promise<TablePrefs | null> {
  if (!tableId) return null;
  // Read out of the shared prefs snapshot (lib/prefs.ts): every table on the page, and the shell's own
  // preferences, come out of ONE request instead of one per table.
  return (await readPref<TablePrefs>(prefKey(tableId))) ?? null;
}

const SERVER_SAVE_DEBOUNCE_MS = 5_000;
export function savePrefs(tableId: string | undefined, p: TablePrefs) {
  if (!tableId) return;
  try {
    localStorage.setItem(lsKey(tableId), JSON.stringify(p));
  } catch {
    /* ignore */
  }
  // The server copy is for other devices, so it rides the shared deferred writer: dragging four columns is one
  // request at the end, not four along the way (localStorage above already has it for this device).
  writePrefDeferred(prefKey(tableId), p, SERVER_SAVE_DEBOUNCE_MS);
}

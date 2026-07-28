import { get, patch } from "@/api";

// Saved per-table layout. Persisted per user via /v1/preferences, with a
// localStorage cache for instant load and offline tolerance.
export type TablePrefs = {
  order?: string[];
  hidden?: string[];
  widths?: Record<string, number>;
  pageSize?: number; // 0 = show all
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
  try {
    // get() routes through the coalescer, so table-pref reads fold into the page's batch + dedup.
    const r = await get<{ value?: TablePrefs }>(`preferences/${prefKey(tableId)}`);
    return r?.value ?? null;
  } catch {
    return null; // 404 (none yet) or offline
  }
}

const timers: Record<string, ReturnType<typeof setTimeout>> = {};
export function savePrefs(tableId: string | undefined, p: TablePrefs) {
  if (!tableId) return;
  try {
    localStorage.setItem(lsKey(tableId), JSON.stringify(p));
  } catch {
    /* ignore */
  }
  clearTimeout(timers[tableId]);
  timers[tableId] = setTimeout(() => {
    patch(`preferences/${prefKey(tableId)}`, { value: p }).catch(() => {});
  }, 700);
}

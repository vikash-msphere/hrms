import { listAll, patch } from "@/api";
import { publish, subscribeTopic } from "@/lib/crossTabBus";

// One read of the caller's OWN preferences, shared by every consumer of them.
//
// Preferences are small per-user blobs (theme, tab-seen map, dashboard layout, a table's columns, push
// subscriptions) and each consumer used to fetch its own row: `preferences/theme`, `preferences/tab_seen`,
// `preferences/table:<id>`, ... That is one request per blob on every page load - the shell alone spent two,
// and each table on screen added another. The whole collection is a handful of rows scoped to the caller, so
// reading it ONCE and handing keys out of the result costs a single request no matter how many blobs are read.
//
// Reads go through this cache; WRITES go straight to the row (PATCH preferences/<key>) and update the cache in
// place, so a later reader sees what was just written without a refetch.

type Row = { key: string; value?: unknown };

let loaded: Promise<Map<string, unknown>> | null = null;

// Follows the cursor rather than asking for a page size the server will not grant: `max: 200` was clamped to
// 100 silently (api.ts#listPath), and a preference that fell past the page read as ABSENT - i.e. as the
// default - which is indistinguishable from never having been set. One request in practice; a caller with
// many saved table layouts pays a second.
function load(): Promise<Map<string, unknown>> {
  return (loaded ??= listAll<Row>("preferences")
    .then((rows) => new Map(rows.map((p) => [p.key, p.value])))
    .catch(() => new Map<string, unknown>()) // no rows / offline: every key reads as absent
    .then(adoptUnconfirmed));
}

/** The caller's stored value for `key`, or undefined if they have no row for it yet. */
export async function readPref<T>(key: string): Promise<T | undefined> {
  const all = await load();
  const v = all.get(key);
  return v === undefined || v === null ? undefined : (v as T);
}

/** Persist a preference and keep the shared snapshot in step. Fire-and-forget: a failed save is not fatal. */
export function writePref(key: string, value: unknown): Promise<void> {
  apply(key, value);
  // This value is newer than anything a deferred write left outstanding for the key, so that record must not
  // outlive it and overlay a stale value on the next page life.
  clearUnconfirmed(key);
  // A sibling tab of the same user holds its own snapshot. Hand it the new value directly rather than telling
  // it to re-read: we know exactly what changed, so a write costs no reads anywhere.
  publish(TOPIC_SET, { key, value } satisfies SetMsg);
  return patch(`preferences/${key}`, { value }).then(
    () => {},
    () => {},
  );
}

function apply(key: string, value: unknown) {
  if (loaded) void loaded.then((all) => all.set(key, value));
  else loaded = Promise.resolve(new Map([[key, value]]));
}

// ---- Deferred writes ----------------------------------------------------------------------------------------
// Some preferences move constantly: the tab-seen map advances on every navigation, a table's columns change as
// you drag them, the dashboard layout as you reorder it. Each of those is a WRITE, and a write per interaction
// is a request per interaction - for a blob whose only job is to follow you to another device. None of them is
// urgent: the copy that matters for this device is in localStorage (each consumer writes that itself,
// immediately), so the server copy can coalesce.
//
// So: apply locally now (readers and sibling tabs see it at once), and send ONE request per key per quiet
// window - flushed when the tab is hidden, which is the last moment that still reaches another device.
const pending = new Map<string, { value: unknown; timer: ReturnType<typeof setTimeout> }>();

/**
 * Update the shared snapshot and sibling tabs WITHOUT scheduling a request. For a preference whose value moves
 * far more often than another device needs to hear about it: stage every change so readers here and in a
 * sibling tab are correct, and call writePrefDeferred only for the changes that are worth a request. Whatever
 * was staged in between rides along, since the flush sends the value as it stands then.
 */
export function stagePref(key: string, value: unknown): void {
  apply(key, value);
  publish(TOPIC_SET, { key, value } satisfies SetMsg);
}

export function writePrefDeferred(key: string, value: unknown, delayMs: number): void {
  stagePref(key, value);
  markUnconfirmed(key, value);
  const existing = pending.get(key);
  if (existing) clearTimeout(existing.timer);
  pending.set(key, { value, timer: setTimeout(() => flushPref(key), delayMs) });
}

// ---- Unconfirmed writes -------------------------------------------------------------------------------------
// A deferred write is only staged in memory until its quiet window lapses, so a reload inside that window used
// to LOSE it: the timer died with the document, the next page life read the older server row, and the change
// the reader had just made was silently undone in front of them (hide a dashboard card, reload, and it is
// back). Flushing on the way out narrows that, but cannot close it - the parting write and the next page's read
// are two requests in flight at once, and either can land first.
//
// So a deferred value is also written down as UNCONFIRMED, and cleared only once the server has taken it. A
// page that starts while one is outstanding believes the local copy over the row it fetched, and re-sends it.
// This device therefore never forgets what it was told; another device sees it as soon as one of the sends
// lands. It is one small object, so it is stored whole rather than a key at a time.
const UNCONFIRMED_LS = "prefs.unconfirmed";

function readUnconfirmed(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(UNCONFIRMED_LS);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {}; // private mode, or something else's key under this name
  }
}

function saveUnconfirmed(map: Record<string, unknown>) {
  try {
    if (Object.keys(map).length) localStorage.setItem(UNCONFIRMED_LS, JSON.stringify(map));
    else localStorage.removeItem(UNCONFIRMED_LS);
  } catch {
    /* private mode: the write still goes out, it just cannot survive this page */
  }
}

function markUnconfirmed(key: string, value: unknown) {
  saveUnconfirmed({ ...readUnconfirmed(), [key]: value });
}

function clearUnconfirmed(key: string) {
  const map = readUnconfirmed();
  if (!(key in map)) return;
  delete map[key];
  saveUnconfirmed(map);
}

/** Overlay whatever this device wrote but never saw stored, and send it again. */
function adoptUnconfirmed(all: Map<string, unknown>): Map<string, unknown> {
  for (const [key, value] of Object.entries(readUnconfirmed())) {
    all.set(key, value);
    void patch(`preferences/${key}`, { value }).then(
      () => clearUnconfirmed(key),
      () => {}, // still unconfirmed: the next page life tries again
    );
  }
  return all;
}

function flushPref(key: string, unloading = false) {
  const p = pending.get(key);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(key);
  // `keepalive` on the way out: a request started by a document that is going away is CANCELLED with it, so
  // without this the last change before a reload or a navigation was staged locally, never sent, and then
  // silently undone - the next page load read the older server row and overwrote the local copy with it.
  // (Hide a dashboard card and reload straight away, and it came back.) Preference blobs are far inside the
  // 64KB keepalive budget.
  void patch(`preferences/${key}`, { value: p.value }, undefined, unloading ? { keepalive: true } : undefined).then(
    () => clearUnconfirmed(key),
    () => {}, // left unconfirmed, so the next page life re-sends it rather than reading the older row back
  );
}

/** Send every deferred preference now. `unloading` when the document may not outlive the request. */
export function flushPrefs(unloading = false): void {
  for (const key of [...pending.keys()]) flushPref(key, unloading);
}

// The last chances to carry pending preferences off this device. `visibilitychange` covers the tab being
// backgrounded and is the one mobile browsers honour; `pagehide` covers what it does not - a reload, a
// same-tab navigation away, a close - none of which need ever hide the tab first. Neither `beforeunload` nor
// `unload` is used: mobile browsers skip them.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPrefs(true);
  });
}
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => flushPrefs(true));
}

// A preference written in ANOTHER TAB arrives as the value itself, and is applied here directly. Deliberately
// NOT wired to the store's write-invalidation bus: preferences are written constantly (the tab-seen map moves
// on every navigation), and dropping the snapshot on each of those turned one write into a write PLUS a re-read
// of every preference the page then touched.
const TOPIC_SET = "prefs:set";
type SetMsg = { key: string; value: unknown };
subscribeTopic<SetMsg>(TOPIC_SET, ({ key, value }) => apply(key, value));

// No invalidation hook is needed for identity: whose preferences these are can only change by signing in or
// starting/stopping a "view as", and both reload the page (lib/viewAsStore.ts), which drops this module with
// every other cache.

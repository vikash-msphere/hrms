import { get, listAll, patch } from "@/api";
import { storedIdentity } from "@/lib/clientStore";
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

// Values written BEFORE the snapshot was ever read.
//
// `apply` used to answer that case by claiming the memo itself - `loaded = Promise.resolve(new Map([[key,
// value]]))` - which silently cancelled the read: `load()`'s `??=` then found a snapshot already there, and
// `GET /v1/preferences` was never issued for the rest of the page life. Every other key read as absent, which
// is indistinguishable from unset, so the theme sync overwrote the cross-device row with this browser's value,
// `tab_seen` lost its cross-device merge, every table's saved views and column layout read as empty and were
// saved back that way, and `adoptUnconfirmed` never ran at all.
//
// It was reachable on an ordinary cold load, not by any unusual sequence: effects run child-before-parent, so
// `Workspace`'s tab-activity seeding and `markTabSeen` (both `stagePref`) fire before App's own effect, which
// is where the first `readPref` callers live. A route whose page happens to mount a table with a `tableId` was
// saved by that table's prefs read getting in first - which is to say the whole thing hung on render order.
//
// Staged instead, and overlaid onto the fetched rows: a value written here is NEWER than anything the server
// can hand back, so it wins, and the read still happens.
const staged = new Map<string, unknown>();

// Follows the cursor rather than asking for a page size the server will not grant: `max: 200` was clamped to
// 100 silently (api.ts#listPath), and a preference that fell past the page read as ABSENT - i.e. as the
// default - which is indistinguishable from never having been set. One request in practice; a caller with
// many saved table layouts pays a second.
function load(): Promise<Map<string, unknown>> {
  return (loaded ??= listAll<Row>("preferences")
    .then((rows) => new Map(rows.map((p) => [p.key, p.value])))
    .catch(() => new Map<string, unknown>()) // no rows / offline: every key reads as absent
    .then(adoptUnconfirmed)
    .then((all) => {
      // After `adoptUnconfirmed`, not before: what a previous page life failed to confirm is older than what
      // this one has already written.
      for (const [k, v] of staged) all.set(k, v);
      staged.clear();
      return all;
    }));
}

/** The caller's stored value for `key`, or undefined if they have no row for it yet. */
export async function readPref<T>(key: string): Promise<T | undefined> {
  const all = await load();
  const v = all.get(key);
  return v === undefined || v === null ? undefined : (v as T);
}

/**
 * Re-read ONE preference from the server, bypassing the page-life snapshot, and refresh the snapshot with it.
 *
 * For the read-modify-write case, which the memoized snapshot is wrong for. A preference whose value is a LIST
 * that several writers append to - `push_subscriptions`, one entry per device - is read here, edited, and
 * PATCHed back whole, with no `If-Match` and no server-side merge. A tab open since before another device
 * enrolled holds that device's absence in the snapshot, so enabling (or disabling) push in this browser wrote
 * the stale list back and silently dropped the other device's subscription.
 *
 * Falls back to the snapshot when the row cannot be read (never written yet, or offline): that is the same
 * answer as before, not a reason to refuse the write.
 */
export async function refetchPref<T>(key: string): Promise<T | undefined> {
  try {
    const row = await get<{ value?: unknown }>(`preferences/${key}`);
    const v = row?.value;
    apply(key, v);
    return v === undefined || v === null ? undefined : (v as T);
  } catch {
    return readPref<T>(key);
  }
}

/** Persist a preference and keep the shared snapshot in step. Fire-and-forget: a failed save is not fatal. */
export function writePref(key: string, value: unknown): Promise<void> {
  apply(key, value);
  // An immediate write supersedes whatever a deferred one left armed for the same key. `flushPref` sends the
  // value CAPTURED when its timer was set, so a timer left running lands the OLDER value on top of this one,
  // minutes later, with nothing on screen to say the save was undone. No key uses both paths today - which is
  // precisely why the first one that does would not have this caught for it.
  const deferred = pending.get(key);
  if (deferred) {
    clearTimeout(deferred.timer);
    pending.delete(key);
  }
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
  else staged.set(key, value); // see `staged`: never claim the memo, or the snapshot is never read at all
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
  // "Rides along" has to be implemented, not just promised. `flushPref` sends `pending.get(key).value`, which
  // is the value CAPTURED when the timer was armed - so a stage in between was applied here and to sibling tabs
  // and then dropped on the floor. `tabActivity` hit this on an ordinary pair of navigations: visit a badged
  // tab (deferred, 30 s), visit an unbadged one inside the window (staged only), and the flush sent the first
  // map - the second tab's stamp never reached the server, `clearUnconfirmed` removed the local record, and the
  // tab badged again on another device for activity the reader had already looked at.
  const p = pending.get(key);
  if (!p) return;
  p.value = value;
  markUnconfirmed(key, value); // the outstanding record must describe what will actually be sent
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
//
// NAMESPACED TO THE CALLER, like every other per-user key in the app (`draft:`, `tab_seen:`, `dt:`,
// `nav:collapsed:`, `palette:frecent:`). What lands in here is not incidental - it is every saved table view
// with its filters and search text, the dashboard layout, the tab-seen map - and `adoptUnconfirmed` does not
// merely read it back, it PATCHes it onto `preferences/*` AS WHOEVER IS SIGNED IN NOW. Under one global key
// that meant: A saves a view, their session lapses inside the 5 s window (an ordinary exit leaves localStorage
// alone - only the sign-out menu clears it), B signs in on the same browser, and A's layouts become B's, on the
// server, following B to their other devices. `lib/tablePrefs.ts` states the invariant this defeated in as many
// words, then routed the identical payload through a shared key one layer down.
//
// Null until the identity is known: an "anon" record would be written by whoever writes before identity lands
// and then adopted by the first real caller, which is the same leak with an extra step.
const unconfirmedKey = () => {
  const id = storedIdentity();
  return id ? `prefs.unconfirmed:${id}` : null;
};

function readUnconfirmed(): Record<string, unknown> {
  const key = unconfirmedKey();
  if (!key) return {};
  try {
    const raw = localStorage.getItem(key);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {}; // private mode, or something else's key under this name
  }
}

function saveUnconfirmed(map: Record<string, unknown>) {
  const key = unconfirmedKey();
  if (!key) return;
  try {
    if (Object.keys(map).length) localStorage.setItem(key, JSON.stringify(map));
    else localStorage.removeItem(key);
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

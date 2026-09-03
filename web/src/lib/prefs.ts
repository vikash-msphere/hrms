import { list, patch } from "@/api";
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

function load(): Promise<Map<string, unknown>> {
  return (loaded ??= list<Row>("preferences", { max: 200 })
    .then((r) => new Map((r.results ?? []).map((p) => [p.key, p.value])))
    .catch(() => new Map<string, unknown>())); // no rows / offline: every key reads as absent
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
  const existing = pending.get(key);
  if (existing) clearTimeout(existing.timer);
  pending.set(key, { value, timer: setTimeout(() => flushPref(key), delayMs) });
}

function flushPref(key: string) {
  const p = pending.get(key);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(key);
  void patch(`preferences/${key}`, { value: p.value }).catch(() => {});
}

/** Send every deferred preference now. */
export function flushPrefs(): void {
  for (const key of [...pending.keys()]) flushPref(key);
}

// `visibilitychange` (not `beforeunload`/`unload`, which mobile browsers skip) is the reliable last chance to
// carry pending preferences off this device.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPrefs();
  });
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

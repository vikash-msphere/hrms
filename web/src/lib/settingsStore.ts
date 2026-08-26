import { list } from "@/api";
import { subscribeInvalidations, storedCopiesTrusted } from "@/lib/resourceStore";

// One read of the org's settings, shared by every consumer of them.
//
// Settings are small org-wide config blobs (organization, attendance, holidays, expenses, ctc, asset-tags,
// referrals, ticket-categories, …) and roughly thirty places read one: the shell, most feature pages, several
// dialogs, every Settings panel. Each used to fetch its own `settings/<key>` row, so a page cost one request per
// blob it consulted - and the server answered each by scanning the same tiny table. `GET /v1/settings` returns
// every key the caller may read (managed keys are excluded server-side) in ONE request, so that is what this
// reads, once, and hands keys out of.
//
// Writes stay ordinary `patch("settings/<key>")` calls: they invalidate the `settings` collection like any other
// write, and this snapshot drops itself when that happens (below) - so the editor that saved and the page behind
// it agree, in this tab and in siblings, without anything having to remember to refresh.

type Row = { key: string; value?: unknown };

let loaded: Promise<Map<string, unknown>> | null = null;

// ---- Disk copy ----------------------------------------------------------------------------------------------
// The snapshot is also kept in localStorage, and that is about REQUEST SHAPE as much as request count: config
// gates other reads. The dashboard cannot ask for its KPI counts until it knows which cards this viewer sees,
// so waiting on the network for `settings` pushed the summary read - and the row reads behind it - into later
// `batch:run` calls. Answering from disk resolves the config in a microtask, so those reads join the page's
// FIRST batch instead of trailing it.
//
// Safe because it is only ever a head start: the network read still happens (it is the same one request, in the
// page's first batch either way) and replaces the copy when it lands. Any settings write drops it. Stale-safe
// too: these blobs are org configuration the server re-reads and enforces on every write.
const DISK_PREFIX = "st1:";
const MAX_AGE_MS = 24 * 60 * 60_000;
let diskUser: string | null = null;

/** Namespace the stored copy to the caller (org config is the same for everyone, but their view of it is not). */
export function setSettingsUser(key: string | undefined) {
  diskUser = key || null;
}

const diskKey = () => `${DISK_PREFIX}${diskUser}`;

function readDisk(): Map<string, unknown> | null {
  if (!diskUser) return null;
  try {
    const raw = localStorage.getItem(diskKey());
    if (!raw) return null;
    const rec = JSON.parse(raw) as { at: number; entries: [string, unknown][] };
    if (!Array.isArray(rec?.entries) || typeof rec.at !== "number" || Date.now() - rec.at > MAX_AGE_MS) return null;
    return new Map(rec.entries);
  } catch {
    return null;
  }
}

function writeDisk(all: Map<string, unknown>) {
  if (!diskUser) return;
  try {
    localStorage.setItem(diskKey(), JSON.stringify({ at: Date.now(), entries: [...all] }));
  } catch {
    /* private mode / quota: memory-only, everything still works */
  }
}

function dropDisk() {
  try {
    if (diskUser) localStorage.removeItem(diskKey());
  } catch {
    /* nothing to do */
  }
}

function fetchAll(): Promise<Map<string, unknown>> {
  return list<Row>("settings", { max: 200 })
    .then((r) => new Map((r.results ?? []).map((s) => [s.key, s.value])))
    .catch(() => new Map<string, unknown>()); // unreadable / offline: every key reads as unset
}

function load(): Promise<Map<string, unknown>> {
  if (loaded) return loaded;
  const disk = readDisk();
  if (disk) {
    loaded = Promise.resolve(disk);
    // Nothing to refresh when the change feed vouches for the stored copy: `GET /v1/changes` (one request for
    // the whole app) reports whether `settings` has been written to at all, and the invalidation below drops
    // this snapshot if it has. So an org whose config nobody touched pays NO settings read on a page load,
    // rather than one to confirm the config it already had.
    if (storedCopiesTrusted()) return loaded;
    // Otherwise: serve the stored copy now, and refresh it in the background. Values are updated IN PLACE so a
    // consumer that already read a key keeps working against the same map.
    void fetchAll().then((fresh) => {
      if (!fresh.size) return; // a failed refresh says nothing about the config; keep what we have
      disk.clear();
      for (const [k, v] of fresh) disk.set(k, v);
      writeDisk(disk);
    });
    return loaded;
  }
  return (loaded = fetchAll().then((all) => {
    writeDisk(all);
    return all;
  }));
}

/** The org's value for `key`, or undefined when it has never been configured. */
export async function readSetting<T>(key: string): Promise<T | undefined> {
  const all = await load();
  const v = all.get(key);
  return v === undefined || v === null ? undefined : (v as T);
}

/**
 * The row shape `GET /v1/settings/<key>` used to return, served from the snapshot. Every caller reads a setting
 * as `{ value }`, so keeping that shape means a consumer changes its CALL and nothing else - and an unset key
 * resolves to `{ value: undefined }` instead of rejecting with a 404, which every one of those consumers was
 * already treating as "not configured".
 */
export async function getSetting<T>(key: string): Promise<{ value?: T }> {
  return { value: await readSetting<T>(key) };
}

/** Drop the snapshot (memory and disk); the next read fetches it again. */
export function invalidateSettings() {
  loaded = null;
  dropDisk();
}

// Any write to a settings row - this tab's editor or a sibling tab's - invalidates the collection, and settings
// are org-wide, so a stale copy is wrong for everyone rather than just for the writer.
subscribeInvalidations((collections) => {
  if (collections.includes("settings")) invalidateSettings();
});

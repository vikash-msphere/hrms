import { list } from "@/api";
import { subscribeInvalidations, storedCopiesTrusted, subscribePurge, reconciled } from "@/lib/resourceStore";
import { registerHydrator, put, del } from "@/lib/clientStore";

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
// Bumped on every invalidation, so a read that is WAITING for the reconciliation can tell whether the copy it
// was about to serve was dropped while it waited.
let generation = 0;

// ---- Disk copy ----------------------------------------------------------------------------------------------
// The snapshot is also kept on disk, and that is about REQUEST SHAPE as much as request count: config gates
// other reads. The dashboard cannot ask for its KPI counts until it knows which cards this viewer sees, so
// waiting on the network for `settings` pushed the summary read - and the row reads behind it - into later
// `batch:run` calls. Answering from the stored copy resolves the config in a microtask, so those reads join the
// page's FIRST batch instead of trailing it.
//
// It used to be safe only in the sense that it was a head start, with a 24-hour age as the backstop. That was
// wrong: with the change feed vouching for the stored copy (below), the refresh was skipped entirely, and the
// `settings` table carried no change stamp - so an org whose config another admin had edited went on reading
// yesterday's config, for up to a day, with nothing able to correct it. The stamp exists now
// (src/db/changeDdl.ts), which makes the vouching honest, and the age is back to being a backstop rather than
// the mechanism.
const DISK_KEY = "settings";
let diskUser: string | null = null;
let stored: Map<string, unknown> | null = null;

registerHydrator("snapshot", {
  onRecords: (records) => {
    const rec = records.find((r) => r.key === DISK_KEY);
    if (!rec) return;
    try {
      const entries = JSON.parse(rec.value) as [string, unknown][];
      if (Array.isArray(entries)) stored = new Map(entries);
    } catch {
      /* unparseable: no stored copy, which is a state this already handles */
    }
  },
  onEvict: () => {
    stored = null;
  },
  // A different caller sees a different subset of the config (managed keys are excluded server-side).
  onReset: () => {
    stored = null;
    loaded = null;
  },
});

/** Namespace the stored copy to the caller (org config is the same for everyone, but their view of it is not). */
export function setSettingsUser(key: string | undefined) {
  diskUser = key || null;
}

function readDisk(): Map<string, unknown> | null {
  return diskUser && stored?.size ? stored : null;
}

function writeDisk(all: Map<string, unknown>) {
  if (!diskUser) return;
  stored = new Map(all);
  put("snapshot", DISK_KEY, JSON.stringify([...all]));
}

function dropDisk() {
  stored = null;
  del("snapshot", DISK_KEY);
}

function fetchAll(): Promise<Map<string, unknown>> {
  return list<Row>("settings", { max: 200 })
    .then((r) => new Map((r.results ?? []).map((s) => [s.key, s.value])))
    .catch(() => new Map<string, unknown>()); // unreadable / offline: every key reads as unset
}

// How long a config read waits for the change feed's verdict before serving the stored copy anyway. Generous
// against the normal case (the feed is already in the page's first batch) so the bound is only ever reached by
// a connection that has stopped answering.
const RECONCILE_WAIT_MS = 3_000;
const afterMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function load(): Promise<Map<string, unknown>> {
  if (loaded) return loaded;
  const disk = readDisk();
  if (disk) {
    // A stored copy may be served without reading the config again - but only once the change feed has
    // VOUCHED for it. `GET /v1/changes` (one request for the whole app, already in the page's first batch)
    // reports whether `settings` has been written to; if it has, the invalidation below drops this snapshot
    // and the read below happens instead.
    //
    // Waiting for that verdict is the difference between a cache and a wrong answer. A config read is awaited
    // once and its value decides behaviour for the rest of the page life, so there is no later render to
    // correct: an admin who saves a setting and reloads has to see what they saved, and a page that answered
    // ahead of the feed showed them the value they had just replaced.
    if (storedCopiesTrusted()) {
      const gen = generation;
      // BOUNDED. The verdict rides the page's first `batch:run` and normally lands in tens of milliseconds,
      // but nothing in api.ts sets a timeout, so a connection that stalls without erroring never settles it -
      // and every consumer of this is awaiting a value it needs before it can render. Unbounded, one stalled
      // request left the dashboard's cards, payroll's rounding and the attendance rules waiting forever.
      // Timing out serves the stored copy, which is exactly what this did before the wait existed: a config
      // that may be a page-load stale, rather than a page that never finishes.
      loaded = Promise.race([reconciled(), afterMs(RECONCILE_WAIT_MS)]).then(() => {
        // A bumped generation means the feed named `settings` while we waited (invalidateSettings ran), so
        // this copy is exactly the one not to serve.
        if (generation === gen) return disk;
        return (loaded = fetchAll().then((all) => (writeDisk(all), all)));
      });
      return loaded;
    }
    loaded = Promise.resolve(disk);
    // No reconciliation to wait for (a first visit, or storage that has been cleared): serve the stored copy
    // now and refresh it in the background. Values are updated IN PLACE so a consumer that already read a key
    // keeps working against the same map.
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
  generation++;
  loaded = null;
  dropDisk();
}

// Any write to a settings row - this tab's editor or a sibling tab's - invalidates the collection, and settings
// are org-wide, so a stale copy is wrong for everyone rather than just for the writer.
subscribeInvalidations((collections) => {
  if (collections.includes("settings")) invalidateSettings();
});

// And when the store gives up everything (the caller's own access changed, or a crash boundary is retrying):
// this snapshot is derived from a read they may no longer be entitled to the same answer for.
subscribePurge(invalidateSettings);

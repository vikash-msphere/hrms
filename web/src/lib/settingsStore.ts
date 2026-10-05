import { ApiError, list, patch } from "@/api";
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
// Writes go through `saveSetting` below, which invalidates the `settings` collection like any other write, so
// this snapshot drops itself (see the subscription at the bottom) - the editor that saved and the page behind it
// agree, in this tab and in siblings, without anything having to remember to refresh.
//
// It also carries each row's ETAG, which is what makes a settings write safe. Every panel edits a whole config
// BLOB and PATCHes the whole thing back (`{ value: { categories: [...] } }`), so two admins - or one admin in two
// tabs - editing different parts of the same key silently overwrote each other's entire section. The server has
// always honoured `If-Match` (services/settings.ts puts the version in the UPDATE's WHERE, so the DB decides
// whether the write still applies) and deliberately keeps last-write-wins for a caller that sends none; nothing
// on the client ever sent one. The etag travels with the value it belongs to, in one snapshot, so the two can
// never drift: a write is checked against the exact version the admin was looking at.

type Row = { key: string; value?: unknown; etag?: string };

// ONE read of the table: every key's value and the etag of the version it was read at, as one object, so a
// value can never be handed out with another read's version or with none. `unknown` marks a stand-in for a
// read that did not land (the fetch failed, or a bounded wait ran out with nothing stored to serve).
// Render-time consumers read one as "nothing configured" and fall back to defaults, which is the right
// degradation for them. An EDITOR must not: a form hydrated from it shows a configured key as blank, and
// saving that form writes the blank over the real row. `getSetting` reports it so an editor can refuse it.
type Snapshot = { values: Map<string, unknown>; etags: Map<string, string>; unknown?: true };
const unknownSnapshot = (): Snapshot => ({ values: new Map(), etags: new Map(), unknown: true });

let loaded: Promise<Snapshot> | null = null;
// Per-key etag of the version a READER was last given (see `getSetting`). Unlike a snapshot's etags this does
// not move when the snapshot is refreshed behind an open form, which is the whole point: it is the version
// whatever is on somebody's screen was built from, and therefore the one their save has to be guarded on.
const handedOut = new Map<string, string>();
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
let stored: Snapshot | null = null;

// The stored payload is VERSIONED because it now carries etags beside the values, and a value served with the
// wrong key's etag would be worse than no stored copy at all. An older (unversioned) payload therefore reads as
// "no stored copy" - a state this already handles, at the cost of one extra fetch, once.
const DISK_FORMAT = 2;
type DiskPayload = { v: number; entries: [string, unknown][]; etags: [string, string][] };

registerHydrator("snapshot", {
  onRecords: (records) => {
    const rec = records.find((r) => r.key === DISK_KEY);
    if (!rec) return;
    try {
      const payload = JSON.parse(rec.value) as DiskPayload;
      if (payload?.v !== DISK_FORMAT || !Array.isArray(payload.entries)) return;
      stored = { values: new Map(payload.entries), etags: new Map(Array.isArray(payload.etags) ? payload.etags : []) };
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

function readDisk(): Snapshot | null {
  return diskUser && stored?.values.size ? stored : null;
}

function writeDisk(snap: Snapshot) {
  if (!diskUser) return;
  stored = { values: new Map(snap.values), etags: new Map(snap.etags) };
  const payload: DiskPayload = { v: DISK_FORMAT, entries: [...snap.values], etags: [...snap.etags] };
  put("snapshot", DISK_KEY, JSON.stringify(payload));
}

function dropDisk() {
  stored = null;
  del("snapshot", DISK_KEY);
}

// WALKS THE CURSOR, unconditionally. This used to ask for `max: 200` and read the answer as the whole table -
// but the server caps a page at 100 (http/pagination.ts#clampPageSize) and api.ts clamps the request to match,
// silently, so the 200 was a belief rather than a window. This is the CONFIG SNAPSHOT: a key that falls past
// the page reads as unset and every consumer of it quietly falls back to its default, which is an org policy
// that is configured and not applied - the failure `getSettingValue`'s own header calls out. The app reads
// about two dozen keys today, so it is a cliff rather than a present defect, and invisible right up to it. A
// partial snapshot is worse than a slow one.
//
// Returns a whole `Snapshot` and assigns nothing: whoever adopts it adopts its values and etags together.
async function fetchAll(): Promise<Snapshot> {
  try {
    const rows: Row[] = [];
    let pageToken: string | undefined;
    const seen = new Set<string>();
    // Same two guards `listAll` uses: a repeated token catches a cursor that is stuck, the page ceiling one
    // that advances but never ends. Settings is a tiny table, so this is one request in practice.
    for (let page = 0; page < 20; page++) {
      const r = await list<Row>("settings", { max: 100, pageToken });
      rows.push(...(r.results ?? []));
      pageToken = r.next_page_token;
      if (!pageToken || seen.has(pageToken)) break;
      seen.add(pageToken);
    }
    // Etags are replaced wholesale alongside the values they describe, never merged into the old set: a
    // leftover etag for a key this read did not return would be a version claim about a row we have not seen.
    return {
      values: new Map(rows.map((s) => [s.key, s.value])),
      etags: new Map(rows.flatMap((s) => (s.etag ? [[s.key, s.etag] as [string, string]] : []))),
    };
  } catch {
    // unreadable / offline: every key reads as unset, and the snapshot says it is not a real answer
    return unknownSnapshot();
  }
}

// How long a config read waits for the change feed's verdict before serving the stored copy anyway. Generous
// against the normal case (the feed is already in the page's first batch) so the bound is only ever reached by
// a connection that has stopped answering.
const RECONCILE_WAIT_MS = 3_000;
const afterMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function load(): Promise<Snapshot> {
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
        // The feed named `settings` while we waited, so this copy IS the one not to serve and a fresh read is
        // required. BOUNDED like every other wait in here: nothing in api.ts sets a timeout, so a refetch that
        // stalls without erroring never settles, and every consumer of this is awaiting a value it needs
        // before it can render - a "Report a problem" Send button that never enables, the dashboard's cards,
        // payroll's rounding. On a timeout the stored copy is served: a config one write behind, which is what
        // this branch served before the wait existed, rather than a page that never finishes. The refetch
        // keeps running and corrects `loaded` for whoever asks next.
        const refetchGen = generation;
        const refetched = fetchAll().then((snap) => {
          // Generation-guarded like the wait above, and for the same reason. A save that lands while this read
          // is in flight bumps the generation and drops the snapshot; without the check this completion then
          // re-stamped the pre-write values as current, in memory AND on disk, so the next `getSetting` - and
          // the next page load - answered with the values the save had just replaced. A superseded read is still
          // served to the waiters that asked for it, with its own etags, so a save built on it is checked
          // against the version it actually shows.
          if (generation !== refetchGen) return snap;
          if (snap.unknown) {
            loaded = null; // a failed read is not an answer to keep: the next reader tries again
            return snap;
          }
          writeDisk(snap);
          loaded = Promise.resolve(snap);
          return snap;
        });
        return (loaded = Promise.race([refetched, afterMs(RECONCILE_WAIT_MS).then(() => disk)]));
      });
      return loaded;
    }
    loaded = Promise.resolve(disk);
    // No reconciliation to wait for (a first visit, or storage that has been cleared): serve the stored copy
    // now and refresh it in the background. Values and etags are updated IN PLACE, together, so a consumer that
    // already read a key keeps working against the same snapshot.
    const bgGen = generation;
    void fetchAll().then((fresh) => {
      if (fresh.unknown) return; // a failed refresh says nothing about the config; keep what we have
      if (generation !== bgGen) return; // a save landed while this was in flight: these values are the stale ones
      disk.values.clear();
      for (const [k, v] of fresh.values) disk.values.set(k, v);
      disk.etags.clear();
      for (const [k, e] of fresh.etags) disk.etags.set(k, e);
      writeDisk(disk);
    });
    return loaded;
  }
  // No stored copy to fall back on (a first-ever session, or one that has been cleared): the fetch is bounded
  // the same way the reconciliation wait above is. Unbounded, one sub-request sharing this read's batch that
  // stalls without erroring (routes/batch.ts dispatches the whole envelope through one `Promise.all`) leaves
  // EVERY settings consumer on the page waiting forever, not just whichever read was actually slow. A timeout
  // resolves this batch of waiters to "nothing configured yet" - the same answer an outright failed fetch
  // already gives (`fetchAll`'s own catch) - while the real fetch keeps running in the background and corrects
  // `loaded` for whoever asks next if it does eventually land. Both stand-ins are unknown snapshots, so an
  // editor can tell them from an org that has configured nothing.
  const freshGen = generation;
  const fresh = fetchAll().then((snap) => {
    // Generation-guarded: a save that lands before this first read completes has already dropped the snapshot,
    // and adopting the pre-write values here would put them back as current for the rest of the page life.
    if (generation !== freshGen) return snap;
    if (snap.unknown) {
      loaded = null; // a failed read is not an answer to keep: the next reader tries again
      return snap;
    }
    writeDisk(snap);
    loaded = Promise.resolve(snap);
    return snap;
  });
  return (loaded = Promise.race([fresh, afterMs(RECONCILE_WAIT_MS).then(unknownSnapshot)]));
}

/** The org's value for `key`, or undefined when it has never been configured. */
export async function readSetting<T>(key: string): Promise<T | undefined> {
  const v = (await load()).values.get(key);
  return v === undefined || v === null ? undefined : (v as T);
}

/**
 * The row shape `GET /v1/settings/<key>` used to return, served from the snapshot. Every caller reads a setting
 * as `{ value }`, so keeping that shape means a consumer changes its CALL and nothing else - and an unset key
 * resolves to `{ value: undefined }` instead of rejecting with a 404, which every one of those consumers was
 * already treating as "not configured".
 *
 * `unknown` is set when the read did not land (see `Snapshot`): the value is absent because nothing answered,
 * not because nothing is configured. An editor that hydrates a form must refuse it; a consumer that only
 * renders can ignore it and keep its defaults.
 */
export async function getSetting<T>(key: string): Promise<{ value?: T; version?: string; unknown?: true }> {
  const snap = await load();
  if (snap.unknown) {
    handedOut.delete(key);
    return { unknown: true };
  }
  const v = snap.values.get(key);
  const value = v === undefined || v === null ? undefined : (v as T);
  // THE VERSION THE VALUE WAS READ AT, from the same snapshot, handed back with it. A panel that rebuilds a
  // whole blob from a snapshot it took at mount must write against the version THAT value came from; looking
  // one up at write time is a different claim, and in one specific case a false one - see `saveSetting`.
  const version = snap.etags.get(key);
  // Remembered as well as returned, because most panels take the value and drop the version. A read that saw
  // no row clears it: the reader's form is built on "no row", so its save may only create one.
  if (version) handedOut.set(key, version);
  else handedOut.delete(key);
  return { value, version };
}

/**
 * `getSetting` for an EDITOR, which must never hydrate a form from a read that did not land. An unknown answer
 * is asked again (a failed read is not kept, so the next ask fetches) and rejected if it stays unknown, so the
 * panel can say it could not load instead of offering defaults that its save would write over the real row.
 */
export async function getSettingForEdit<T>(key: string): Promise<{ value?: T; version?: string }> {
  for (let attempt = 0; ; attempt++) {
    const s = await getSetting<T>(key);
    if (!s.unknown) return s;
    if (attempt >= 2) throw new Error(`settings/${key} could not be read`);
    await afterMs(1_500);
  }
}

/**
 * Write one settings key, guarded on the version this session actually read.
 *
 * THE one way to save a setting. Every panel edits a config blob and PATCHes the whole blob back, so a write
 * that carries no version is not "last write wins" over one field - it is one admin's entire ticket-category
 * list, or kudos ladder, or dashboard layout, replacing another's with no sign anything was lost. Sending the
 * snapshot's `If-Match` puts the version in the server's UPDATE ... WHERE, so the DB refuses the second write
 * and the caller gets a 409 to re-read and re-apply. The SPA already has the message for it
 * (lib/problemText.ts), which could never fire while nothing sent a validator.
 *
 * NO VERSION MEANS CREATE-ONLY. A reader that holds no version for the key saw no row - the key was never
 * written, or the read that should have shown it failed or timed out. The two look identical from here, so the
 * save sends `If-None-Match: *` and lets the server decide: it creates the row when there is none and answers
 * 409 when there is one. Sending nothing instead is a last-write-wins overwrite of a row nobody on screen has
 * seen, and that is how a quick-create menu save once replaced the whole organization blob - name, logos,
 * address and all - with `{ quick_actions }`: the editor's read had come back empty, so its form, and its save,
 * were built on nothing.
 *
 * `version` may be `null` for a caller that tracks its own read and saw no row; `undefined` means "use what
 * `getSetting` handed this session".
 */
export async function saveSetting(key: string, body: { value: unknown }, version?: string | null): Promise<string | undefined> {
  try {
    // `version` is the one the caller's VALUE was read at (getSetting hands it back). Pass it whenever the
    // write rebuilds a blob from a snapshot taken earlier. Without it the fallback is `handedOut`, the version
    // `getSetting` last gave this session for the key, which does not move when the snapshot refreshes
    // underneath an open form.
    //
    // The LIVE snapshot etag is never a fallback. A sibling tab's write to the same key refreshes the snapshot,
    // so its etag is the sibling's new version: sent as If-Match it matches, the server accepts, and a panel
    // holding a pre-write copy of the blob writes the sibling's fields back to their old values with a green
    // toast. It is a validator for a version nobody on screen has seen.
    const held = version === undefined ? handedOut.get(key) : version ?? undefined;
    const saved = await patch<{ etag?: string }>(`settings/${key}`, body, held, held ? undefined : { headers: { "If-None-Match": "*" } });
    // The version this write CREATED, taken from its own answer, and returned for a caller that tracks its
    // own. Without it the panel that just saved is holding the version it saved OVER: press Save twice (flip a
    // switch, put it back - which is what a form with a toggle is) and the second press is refused as a
    // conflict with the reader's own first press.
    if (saved?.etag) handedOut.set(key, saved.etag);
    else handedOut.delete(key);
    return saved?.etag;
  } catch (e) {
    // A save refused as a CONFLICT means the version this session holds is no longer the current one, so the
    // SNAPSHOT is what has to go. Without this the etag that just lost stayed in the map and every later
    // attempt sent it again: the first conflict turned into a panel whose Save could never succeed, for the
    // rest of the page's life, however many times somebody pressed it. Dropping it makes the next attempt carry
    // a live version - and, because the values are re-read too, an attempt built on what actually won.
    //
    // The guard is re-armed on the WINNER's version, read fresh here, not left empty. The panels tell the
    // reader their copy lost and that pressing Save again replaces the other version (Settings.tsx
    // `saveSettingError`), so that press must be guarded on the version they were just told about. Left empty
    // it went create-only, which the existing row refuses on every press: a Save that could never land.
    //
    // ANY OTHER refusal leaves both alone. A 400 says nothing about versions - the row has not moved - and
    // `employee_fields` answers its first save with one on purpose (confirm the removal), so dropping the
    // version there made the confirmed re-send create-only and refused it as a conflict it never had.
    if (e instanceof ApiError && e.status === 409) {
      handedOut.delete(key);
      invalidateSettings();
      await getSetting(key).catch(() => undefined); // re-arms `handedOut` when the re-read lands
    }
    throw e;
  }
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

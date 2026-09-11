/// <reference types="vite/client" />
import { describe, it, expect, beforeEach, vi } from "vitest";

// The SPA's read cache (web/src/lib/resourceStore.ts): freshness TIERS and the on-disk copy. Both exist to stop
// the app paying for the same rows over and over - a catalog nobody edits was being re-read every 20 seconds,
// and every reload started from nothing - so both are pinned here, including the parts that must NOT happen
// (transactional collections stay short-lived; stored rows never cross identities).

// Two stand-ins, both installed before the first call (the workers runtime has neither).
//
// localStorage still holds ONE thing: the reconciliation point (`hrms.sync:<identity>`), which has to be read
// synchronously, before the first entry can adopt anything.
class FakeStorage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}
const store = new FakeStorage();
(globalThis as unknown as { localStorage: FakeStorage }).localStorage = store;

// The stored copies themselves live in IndexedDB (web/src/lib/clientStore.ts). The fake below is the smallest
// thing that behaves like one: two keyed object stores, and requests that settle in a microtask - which is what
// makes the asynchrony real here, since that is exactly what the boot-time hydration has to wait for.
const idb = { meta: new Map<string, Record<string, unknown>>(), data: new Map<string, Record<string, unknown>>() };

function request<T>(value: T) {
  const r: Record<string, unknown> = { result: value };
  queueMicrotask(() => (r.onsuccess as (() => void) | undefined)?.());
  return r;
}

const objectStore = (name: "meta" | "data") => ({
  getAll: () => request([...idb[name].values()]),
  get: (k: string) => request(idb[name].get(k)),
  put: (v: { k: string }) => {
    idb[name].set(v.k, v);
    return request(undefined);
  },
  delete: (k: string) => {
    idb[name].delete(k);
    return request(undefined);
  },
  createIndex: () => {},
});

(globalThis as unknown as { indexedDB: unknown }).indexedDB = {
  open: () => {
    const r: Record<string, unknown> = {};
    queueMicrotask(() => {
      r.result = { objectStoreNames: { contains: () => true }, transaction: () => ({ objectStore }), close: () => {} };
      (r.onsuccess as (() => void) | undefined)?.();
    });
    return r;
  },
  deleteDatabase: () => {
    idb.meta.clear();
    idb.data.clear();
    return request(undefined);
  },
};

// The store asks `GET /v1/changes` once per identity to decide whether its stored copies can be trusted, and
// `list()` whenever it does read a collection. Both are stubbed so the tests below are about the store's
// decisions rather than about the network: `changesAnswer` is what the feed replies, `listed` records every
// collection the store actually went and read.
const listed: string[] = [];
let changesAnswer: { now: number; collections?: string[]; unknown_window?: boolean; authz_version?: string } | Error = { now: Date.now(), collections: [], authz_version: "v1" };
// `notModified` is what the store gets back when it revalidates with a validator the server still agrees with
// (conditional GET, src/http/listEtag.ts). Off by default so these tests are about the store's decisions;
// switched on where the point IS the revalidation.
let answerNotModified = false;
vi.mock("@/api", () => ({
  list: (collection: string) => {
    listed.push(collection);
    return Promise.resolve({ results: [] });
  },
  listConditional: (collection: string, opts: { q?: string } | undefined, etag?: string) => {
    listed.push(collection);
    if (answerNotModified && etag) return Promise.resolve({ notModified: true as const });
    // A read whose page came back full answers with a cursor, which is what marks the rows a WINDOW rather
    // than the collection. Keyed off a sentinel query so only the test that is about truncation gets one.
    const response: Record<string, unknown> = { results: [{ path: `${collection}/fetched` }] };
    if (opts?.q === "truncated") response.next_page_token = "next";
    return Promise.resolve({ response, etag: 'W/"fresh"' });
  },
  changesSince: () => (changesAnswer instanceof Error ? Promise.reject(changesAnswer) : Promise.resolve(changesAnswer)),
}));

const { freshnessMs, setResourceStoreUser, getSnapshot, invalidateCollections, subscribe, entryCount, ensureFetch, storedCopiesTrusted, persistable, collectionHasMore } =
  await import("@/lib/resourceStore");
const { flushNow, put } = await import("@/lib/clientStore");

// A record as a previous page life would have left it. The composite key is clientStore's: schema version,
// identity, class, then the store's own entry key - "<collection>?<opts>" as keyOf builds it. `m` is the page
// size the store actually asks for, which is the server's own cap (clampPageSize).
const entryKey = (collection: string, opts = "d=0&m=100&q=&p=") => `${collection}?${opts}`;
const recordKey = (user: string, collection: string, opts?: string) => `1|${user}|rows|${entryKey(collection, opts)}`;
function seed(user: string, collection: string, rows: unknown[], ageMs = 0, opts?: string) {
  const k = recordKey(user, collection, opts);
  const ts = Date.now() - ageMs;
  idb.meta.set(k, { k, ver: 1, id: user, cls: "rows", key: entryKey(collection, opts), collection, ts, bytes: 1 });
  idb.data.set(k, { k, v: JSON.stringify({ rows, ts }) });
}

// The reconciliation point a previous page life would have left behind: with one, stored copies are trusted
// until the feed says otherwise. `authz` is the caller's access version at that moment - the feed answering
// with a different one means their permissions moved, and everything stored goes.
const seedSync = (user: string, ageMs = 60_000, authz = "v1") =>
  store.setItem(`hrms.sync:${user}`, JSON.stringify({ at: Date.now() - ageMs, authz }));

beforeEach(async () => {
  store.clear();
  idb.meta.clear();
  idb.data.clear();
  listed.length = 0;
  changesAnswer = { now: Date.now(), collections: [], authz_version: "v1" };
  answerNotModified = false;
  await setResourceStoreUser(undefined);
});

describe("resource store freshness tiers", () => {
  it("reuses a reference catalog for minutes and a transactional collection for seconds", () => {
    expect(freshnessMs("departments")).toBeGreaterThanOrEqual(5 * 60_000);
    expect(freshnessMs("leave-types")).toBe(freshnessMs("departments"));
    expect(freshnessMs("pay-components")).toBe(freshnessMs("departments"));
    // The directory sits in between: read by nearly every page, but it changes when someone joins.
    expect(freshnessMs("employees")).toBeGreaterThan(20_000);
    expect(freshnessMs("employees")).toBeLessThan(freshnessMs("departments"));
    // Anything that carries a decision or money keeps the short window.
    for (const c of ["leave-requests", "expenses", "payroll-runs", "attendance", "notifications", "tickets"]) {
      expect(freshnessMs(c), c).toBe(20_000);
    }
  });
});

describe("resource store disk cache", () => {
  it("adopts a stored copy on first touch, so a reload costs no request", async () => {
    seed("a@x.test", "departments", [{ path: "departments/1", display_name: "Ops" }]);
    await setResourceStoreUser("a@x.test");
    const snap = getSnapshot("departments", {});
    expect(snap.state).toBe("ready");
    expect(snap.rows).toHaveLength(1);
  });

  it("never adopts another identity's rows", async () => {
    seed("other@x.test", "departments", [{ path: "departments/1" }], 0, "d=0&m=7&q=&p=");
    await setResourceStoreUser("a@x.test");
    const snap = getSnapshot("departments", { max: 7 });
    expect(snap.rows).toEqual([]);
    expect(snap.state).toBe("loading"); // nothing to adopt -> it will fetch, as before
    // And they are not merely ignored: nothing is going to come back for another identity's records, so
    // hydration deletes them rather than leaving them on the disk of a shared machine.
    expect(idb.data.has(recordKey("other@x.test", "departments", "d=0&m=7&q=&p="))).toBe(false);
  });

  it("stores nothing under a caller who has not been set (a simulation switching identity mid-flight)", () => {
    seed("a@x.test", "holidays", [{ path: "holidays/1" }]);
    const snap = getSnapshot("holidays", {});
    expect(snap.rows).toEqual([]); // disk is off until setResourceStoreUser names the caller
  });

  it("abandons a queued write when the caller changes before it reaches the disk", async () => {
    // Writes are queued and flushed off the fetch's own turn, and opening the database is a real await. So a
    // simulation starting - or a second person signing in - can switch the namespace WHILE a batch is in
    // flight. Filing that batch under whoever is current now would hand one person's cached rows to another,
    // which is the one thing the namespacing exists to prevent.
    await setResourceStoreUser("a@x.test");
    put("rows", entryKey("departments"), JSON.stringify({ rows: [{ path: "departments/1" }], ts: Date.now() }), { collection: "departments" });
    const flushed = flushNow();
    await setResourceStoreUser("b@x.test"); // lands inside the flush's own await on openDb
    await flushed;
    // Nothing was written for either identity: not for B (they never asked for it) and not for A (their
    // namespace is no longer the one being stored to).
    expect(idb.data.has(recordKey("b@x.test", "departments"))).toBe(false);
    expect(idb.data.has(recordKey("a@x.test", "departments"))).toBe(false);
  });

  it("forgets the stored copy of a collection that was just written", async () => {
    seed("a@x.test", "vendors", [{ path: "vendors/1" }], 0, "d=0&m=9&q=&p=");
    await setResourceStoreUser("a@x.test");
    invalidateCollections(["vendors"]);
    await flushNow();
    expect(idb.data.has(recordKey("a@x.test", "vendors", "d=0&m=9&q=&p="))).toBe(false);
    // And the next reader starts empty rather than adopting pre-write rows.
    expect(getSnapshot("vendors", { max: 9 }).rows).toEqual([]);
  });

  it("never writes a collection down that carries pay or identity", async () => {
    // These are cached in memory like anything else - same dedup, same TTL - but a copy of someone's pay on the
    // disk of whatever machine the browser is on buys nothing (they are read on one page, not on every page).
    // `offers` and `candidates` were persistable while every collection either side of them on this list was
    // not: an offer row carries the annual compensation being offered, and a candidate row is contact details
    // and free-text notes on someone outside the org. Both are named here because this assertion is a
    // hand-written allowlist - the one shape of test that cannot notice the collection nobody added.
    for (const c of ["payslips", "compensation", "loans", "tax-declarations", "personal-documents", "background-checks", "offers", "candidates"]) {
      expect(persistable(c), c).toBe(false);
    }
    // While the reference lists and the directory - read by nearly every page - are exactly what to store.
    for (const c of ["departments", "employees", "leave-types", "holidays"]) {
      expect(persistable(c), c).toBe(true);
    }
  });
});

describe("resource store retention: the entry map does not grow for the whole session", () => {
  // Four pages key a read on a DEBOUNCED search term (Directory, Tickets, Expenses, Announcements), so every
  // term typed minted a cache entry - and nothing was ever removed from the map, so thirty searches left thirty
  // entries of up to a hundred rows each until reload. `writeDisk` already refuses to persist a `q` key on
  // exactly this reasoning; the in-memory side simply never got the same rule.

  it("drops a search entry once its last reader goes away, and keeps an ordinary one", () => {
    setResourceStoreUser("a@x.test");
    const noop = () => {};

    // A search: one reader, then gone.
    const unsubSearch = subscribe("employees", { q: "ali" }, noop);
    expect(entryCount()).toBeGreaterThan(0);
    const withSearch = entryCount();
    unsubSearch();
    expect(entryCount()).toBe(withSearch - 1); // the query's answer died with the question

    // An ordinary read stays cached for its TTL after the reader unmounts - that is the whole point of the
    // store, and navigating away must not throw the rows away. A key nothing else in this file has touched, so
    // the count moves for this subscription and not an earlier test's entry.
    const before = entryCount();
    const unsubPlain = subscribe("departments", { params: { retention: "plain" } }, noop);
    expect(entryCount()).toBe(before + 1);
    unsubPlain();
    expect(entryCount()).toBe(before + 1);
  });

  it("caps the map, evicting the least recently loaded unsubscribed entries", () => {
    setResourceStoreUser("a@x.test");
    // Far more distinct keys than the cap, none subscribed - the shape a long session of filter permutations
    // produces. Unbounded, this climbed to 400.
    for (let i = 0; i < 400; i++) getSnapshot("tickets", { params: { state: `s${i}` } });
    expect(entryCount()).toBeLessThanOrEqual(100);
  });

  // "Is this collection truncated" is derived from the keys the store still holds, so DROPPING the truncated
  // one has to re-derive it. It did not: a search that filled a page left the collection flagged for the rest
  // of the page life, and every table of it went on saying it was showing a window of a larger set.
  it("stops reporting a collection as truncated once the truncated read is dropped", async () => {
    setResourceStoreUser("a@x.test");
    const unsub = subscribe("employees", { q: "truncated" }, () => {});
    await ensureFetch("employees", { q: "truncated" });
    expect(collectionHasMore("employees")).toBe(true);
    // The search is cleared. Its entry is ephemeral, so it dies with its last reader - and with it the only
    // reason anything was calling this collection a window.
    unsub();
    expect(collectionHasMore("employees")).toBe(false);
  });

  it("keeps a subscribed entry even when the map is over the cap", () => {
    setResourceStoreUser("a@x.test");
    const keep = subscribe("goals", { params: { owner: "keep-me" } }, () => {});
    for (let i = 0; i < 400; i++) getSnapshot("tickets", { params: { state: `t${i}` } });
    // A mounted view's rows are never evicted from under it: `useSyncExternalStore` would read a snapshot the
    // store no longer holds and the view would blank.
    expect(getSnapshot("goals", { params: { owner: "keep-me" } }).state).toBe("loading");
    expect(entryCount()).toBeLessThanOrEqual(101); // the cap, plus the pinned one
    keep();
  });
});

// A stored copy used to be worth only a faster paint: whatever its tier said, the next page load found it
// lapsed and re-read it - so a reload cost a read per collection on screen to discover nothing had changed.
// `GET /v1/changes` answers that for everything at once, which is what lets these copies be SERVED rather than
// merely painted.
describe("resource store: trusting stored copies against the change feed", () => {
  const identity = (name: string) => {
    seedSync(name);
    return setResourceStoreUser(name);
  };

  it("serves a stored copy without reading it when nothing has changed", async () => {
    changesAnswer = { now: Date.now(), collections: [] };
    seed("t1@x.test", "leave-requests", [{ path: "leave-requests/1" }], 10 * 60_000); // long past its 20s tier
    await identity("t1@x.test");
    expect(storedCopiesTrusted()).toBe(true);
    expect(getSnapshot("leave-requests", {}).rows).toHaveLength(1);
    await ensureFetch("leave-requests", {});
    expect(listed).not.toContain("leave-requests"); // the whole point: no read at all
  });

  it("re-reads exactly the collections the feed named, and no others", async () => {
    changesAnswer = { now: Date.now(), collections: ["holidays"] };
    seed("t2@x.test", "holidays", [{ path: "holidays/1" }], 10 * 60_000);
    seed("t2@x.test", "departments", [{ path: "departments/1" }], 10 * 60_000);
    await identity("t2@x.test");
    subscribe("holidays", {}, () => {}); // a mounted view of the changed collection refetches immediately
    subscribe("departments", {}, () => {});
    await new Promise((r) => setTimeout(r, 0)); // let the feed's answer land
    await ensureFetch("holidays", {});
    await ensureFetch("departments", {});
    expect(listed).toContain("holidays");
    expect(listed).not.toContain("departments");
  });

  it("does not trust anything on a first-ever visit, when there is no reconciliation point", async () => {
    seed("t3@x.test", "vendors", [{ path: "vendors/1" }], 10 * 60_000);
    await setResourceStoreUser("t3@x.test"); // no sync record seeded
    expect(storedCopiesTrusted()).toBe(false);
    await ensureFetch("vendors", {});
    expect(listed).toContain("vendors"); // stale by its own tier -> read, exactly as before
  });

  it("gives up its stored copies when the feed cannot speak for the gap", async () => {
    changesAnswer = { now: Date.now(), unknown_window: true };
    seed("t4@x.test", "tickets", [{ path: "tickets/1" }], 10 * 60_000);
    await identity("t4@x.test");
    expect(getSnapshot("tickets", {}).rows).toHaveLength(1); // painted from disk...
    await new Promise((r) => setTimeout(r, 0));
    expect(storedCopiesTrusted()).toBe(false);
    await ensureFetch("tickets", {});
    expect(listed).toContain("tickets"); // ...but never presented as fresh
  });

  it("gives them up when the reconciliation itself fails", async () => {
    changesAnswer = new Error("offline");
    seed("t5@x.test", "goals", [{ path: "goals/1" }], 10 * 60_000);
    await identity("t5@x.test");
    getSnapshot("goals", {}); // adopted while the answer is in flight
    await new Promise((r) => setTimeout(r, 0));
    expect(storedCopiesTrusted()).toBe(false);
    await ensureFetch("goals", {});
    expect(listed).toContain("goals");
  });

  // The case no collection stamp can report. A stored row carries the `access.can` hints and the field
  // redactions computed for whoever fetched it, so narrowing a rule leaves rows that are stale without anything
  // having been written - and a collection the caller has just LOST is filtered out of the answer entirely, so
  // it could never be named. Hence: a different access version gives up everything.
  it("gives up every stored copy when the caller's own access has changed", async () => {
    changesAnswer = { now: Date.now(), collections: [], authz_version: "v2" };
    seed("t6@x.test", "shifts", [{ path: "shifts/1" }], 10 * 60_000);
    seed("t6@x.test", "projects", [{ path: "projects/1" }], 10 * 60_000);
    seedSync("t6@x.test", 60_000, "v1"); // what their access looked like last time
    await setResourceStoreUser("t6@x.test");
    await new Promise((r) => setTimeout(r, 0));
    expect(storedCopiesTrusted()).toBe(false);
    await flushNow();
    expect(idb.data.has(recordKey("t6@x.test", "shifts"))).toBe(false);
    expect(idb.data.has(recordKey("t6@x.test", "projects"))).toBe(false);
    // And neither is served: both are re-read, though the feed named neither and could not have.
    await ensureFetch("shifts", {});
    await ensureFetch("projects", {});
    expect(listed).toContain("shifts");
    expect(listed).toContain("projects");
  });

  // What the change feed does NOT cover: the rest of the session. A twenty-second window means a page left
  // open revalidates several times a minute, and re-reading a hundred rows to be told nothing changed was the
  // largest remaining source of D1 reads. With a validator the server answers in one indexed row.
  it("revalidates a lapsed copy with its validator, and keeps the rows when nothing changed", async () => {
    seed("t8@x.test", "departments", [{ path: "departments/1" }], 10 * 60_000); // past its 5-minute tier
    seedSync("t8@x.test", 60_000, "v1");
    await setResourceStoreUser("t8@x.test");
    await new Promise((r) => setTimeout(r, 0));
    // The stored copy carries no etag, so the first read of it is unconditional and comes back with one.
    await ensureFetch("departments", {}, true);
    answerNotModified = true;
    await ensureFetch("departments", {}, true);
    const snap = getSnapshot("departments", {});
    expect(snap.state).toBe("ready");
    expect(snap.rows).toEqual([{ path: "departments/fetched" }]); // kept across the 304, not emptied by it
    expect(listed.filter((c) => c === "departments")).toHaveLength(2);
  });

  it("keeps them when the access version is unchanged", async () => {
    changesAnswer = { now: Date.now(), collections: [], authz_version: "v1" };
    seed("t7@x.test", "departments", [{ path: "departments/1" }], 10 * 60_000);
    seedSync("t7@x.test", 60_000, "v1");
    await setResourceStoreUser("t7@x.test");
    await new Promise((r) => setTimeout(r, 0));
    expect(storedCopiesTrusted()).toBe(true);
    await ensureFetch("departments", {});
    expect(listed).not.toContain("departments");
  });
});

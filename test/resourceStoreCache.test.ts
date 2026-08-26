/// <reference types="vite/client" />
import { describe, it, expect, beforeEach, vi } from "vitest";

// The SPA's read cache (web/src/lib/resourceStore.ts): freshness TIERS and the on-disk copy. Both exist to stop
// the app paying for the same rows over and over - a catalog nobody edits was being re-read every 20 seconds,
// and every reload started from nothing - so both are pinned here, including the parts that must NOT happen
// (transactional collections stay short-lived; stored rows never cross identities).

// The store reads localStorage lazily, inside its functions, so a stand-in installed before the first call is
// enough (the workers runtime has no localStorage of its own).
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

// The store asks `GET /v1/changes` once per identity to decide whether its stored copies can be trusted, and
// `list()` whenever it does read a collection. Both are stubbed so the tests below are about the store's
// decisions rather than about the network: `changesAnswer` is what the feed replies, `listed` records every
// collection the store actually went and read.
const listed: string[] = [];
let changesAnswer: { now: number; collections?: string[]; unknown_window?: boolean } | Error = { now: Date.now(), collections: [] };
vi.mock("@/api", () => ({
  list: (collection: string) => {
    listed.push(collection);
    return Promise.resolve({ results: [] });
  },
  changesSince: () => (changesAnswer instanceof Error ? Promise.reject(changesAnswer) : Promise.resolve(changesAnswer)),
}));

const { freshnessMs, setResourceStoreUser, getSnapshot, invalidateCollections, subscribe, entryCount, ensureFetch, storedCopiesTrusted } = await import("@/lib/resourceStore");

// The disk key the store uses: "rs1:<user>:<collection>?<opts>" (opts as keyOf builds them). `m` is the page
// size the store actually asks for, which is the server's own cap (clampPageSize) - it used to read 200, a size
// no request has ever been granted.
const diskKey = (user: string, collection: string, opts = "d=0&m=100&q=&p=") => `rs1:${user}:${collection}?${opts}`;
const seed = (user: string, collection: string, rows: unknown[], ageMs = 0, opts?: string) =>
  store.setItem(diskKey(user, collection, opts), JSON.stringify({ rows, ts: Date.now() - ageMs }));

// The reconciliation point a previous page life would have left behind: with one, stored copies are trusted
// until the feed says otherwise.
const seedSync = (user: string, ageMs = 60_000) => store.setItem(`rs1sync:${user}`, JSON.stringify({ at: Date.now() - ageMs }));

beforeEach(() => {
  store.clear();
  listed.length = 0;
  changesAnswer = { now: Date.now(), collections: [] };
  setResourceStoreUser(undefined);
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
  it("adopts a stored copy on first touch, so a reload costs no request", () => {
    setResourceStoreUser("a@x.test");
    seed("a@x.test", "departments", [{ path: "departments/1", display_name: "Ops" }]);
    const snap = getSnapshot("departments", {});
    expect(snap.state).toBe("ready");
    expect(snap.rows).toHaveLength(1);
  });

  it("never adopts another identity's rows", () => {
    seed("other@x.test", "departments", [{ path: "departments/1" }], 0, "d=0&m=7&q=&p=");
    setResourceStoreUser("a@x.test");
    const snap = getSnapshot("departments", { max: 7 });
    expect(snap.rows).toEqual([]);
    expect(snap.state).toBe("loading"); // nothing to adopt -> it will fetch, as before
  });

  it("stores nothing under a caller who has not been set (a simulation switching identity mid-flight)", () => {
    seed("a@x.test", "holidays", [{ path: "holidays/1" }]);
    const snap = getSnapshot("holidays", {});
    expect(snap.rows).toEqual([]); // disk is off until setResourceStoreUser names the caller
  });

  it("forgets the stored copy of a collection that was just written", () => {
    setResourceStoreUser("a@x.test");
    seed("a@x.test", "vendors", [{ path: "vendors/1" }], 0, "d=0&m=9&q=&p=");
    invalidateCollections(["vendors"]);
    expect(store.getItem(diskKey("a@x.test", "vendors", "d=0&m=9&q=&p="))).toBeNull();
    // And the next reader starts empty rather than adopting pre-write rows.
    expect(getSnapshot("vendors", { max: 9 }).rows).toEqual([]);
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
    setResourceStoreUser(name);
  };

  it("serves a stored copy without reading it when nothing has changed", async () => {
    changesAnswer = { now: Date.now(), collections: [] };
    seed("t1@x.test", "leave-requests", [{ path: "leave-requests/1" }], 10 * 60_000); // long past its 20s tier
    identity("t1@x.test");
    expect(storedCopiesTrusted()).toBe(true);
    expect(getSnapshot("leave-requests", {}).rows).toHaveLength(1);
    await ensureFetch("leave-requests", {});
    expect(listed).not.toContain("leave-requests"); // the whole point: no read at all
  });

  it("re-reads exactly the collections the feed named, and no others", async () => {
    changesAnswer = { now: Date.now(), collections: ["holidays"] };
    seed("t2@x.test", "holidays", [{ path: "holidays/1" }], 10 * 60_000);
    seed("t2@x.test", "departments", [{ path: "departments/1" }], 10 * 60_000);
    identity("t2@x.test");
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
    setResourceStoreUser("t3@x.test"); // no sync record seeded
    expect(storedCopiesTrusted()).toBe(false);
    await ensureFetch("vendors", {});
    expect(listed).toContain("vendors"); // stale by its own tier -> read, exactly as before
  });

  it("gives up its stored copies when the feed cannot speak for the gap", async () => {
    changesAnswer = { now: Date.now(), unknown_window: true };
    seed("t4@x.test", "tickets", [{ path: "tickets/1" }], 10 * 60_000);
    identity("t4@x.test");
    expect(getSnapshot("tickets", {}).rows).toHaveLength(1); // painted from disk...
    await new Promise((r) => setTimeout(r, 0));
    expect(storedCopiesTrusted()).toBe(false);
    await ensureFetch("tickets", {});
    expect(listed).toContain("tickets"); // ...but never presented as fresh
  });

  it("gives them up when the reconciliation itself fails", async () => {
    changesAnswer = new Error("offline");
    seed("t5@x.test", "goals", [{ path: "goals/1" }], 10 * 60_000);
    identity("t5@x.test");
    getSnapshot("goals", {}); // adopted while the answer is in flight
    await new Promise((r) => setTimeout(r, 0));
    expect(storedCopiesTrusted()).toBe(false);
    await ensureFetch("goals", {});
    expect(listed).toContain("goals");
  });
});

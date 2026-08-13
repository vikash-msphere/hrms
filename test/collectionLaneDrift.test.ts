/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// ONE way to define a collection. Every route file that exposes the AEP standard methods (a collection-level
// `GET /` plus an item-level `GET /:id`) must be built by http/collectionRoute.ts, so the paging cursor, the
// If-Match check, the soft-delete/restore pair, the access hints and the audit action stems have exactly one
// implementation. Hand-copying that surface is what produced every drift defect the conversion has found so far
// (a `?id=` silently dropped in five collections, a lifecycle verb 500ing on a column that does not exist, a
// missing lock guard, a collection with no tests at all).
//
// PENDING is the shrinking list of files still hand-rolled. It is a budget, not an exemption list: this suite
// fails BOTH when a new hand-rolled collection appears (use the factory) and when a listed one is converted
// without being removed (keep the ledger honest).
//
// NOT_COLLECTIONS is the permanent exemption: key/value config surfaces that borrow the route shape but have no
// collection semantics - the item id is a key the caller chooses, so PATCH upserts and there is nothing to
// create or delete. Each carries its reason, and a test below pins the property that makes the claim true: no
// `POST /` and no DELETE. If one ever grows a create or a delete it has become a collection, that test fails,
// and it moves into the factory lane.
const sources = import.meta.glob("../src/routes/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const basename = (path: string) => path.split("/").pop()!.replace(/\.ts$/, "");
// A collection-level list plus an item-level get: the shape the factory owns. A factory-built file registers
// neither by hand, so this matches only the hand-written ones.
const isHandRolledCollection = (src: string) => /\.get\("\/"/.test(src) && /\.get\((?:"|`)\/:/.test(src);
// `collectionRoutes({...})` or `collectionRoutes<Input>({...})` - the type argument is common enough that
// missing it would silently under-count converted collections.
const usesFactory = (src: string) => /collectionRoutes\s*(?:<[^>]*>)?\s*\(/.test(src);

// Remaining conversion work, by plan step (collection-factory-plan.md). Delete a name when its file lands on
// the factory; never add one without a reason.
const PENDING = new Set([
  // step 5 - collections whose custom methods are the bulk of the file
  "accessRules", "apiKeys", "applications", "automations", "bankFormats", "boards", "candidates",
  "documentRoutes", "goals", "interviewFeedback", "interviews", "leaveRequests", "offers",
  "operations", "overtimeRequests", "payrollRuns", "referrals", "reimbursements", "remoteWorkRequests",
  "requisitions", "reviewFeedback", "roles", "sprints", "suggestions",
  "taxDeclarations", "ticketChecklists", "timeEntries", "users",
  // step 6 - the heavy three, converted last
  "announcements", "cards", "employees",
]);

// Route shape without collection semantics. Not conversion debt - these are done.
const NOT_COLLECTIONS = new Map([
  ["payrollDebit", "one settings key rendered per bank: no table of its own, PATCH /:bank upserts the blob"],
  ["policy", "leave-policy key/value: the id is the policy key, PATCH sets its value"],
  ["preferences", "per-user key/value: the id is the preference key, PATCH upserts it"],
  ["settings", "org key/value blobs: the id is the settings key, PATCH upserts it"],
]);

describe("every collection is built by the factory", () => {
  const entries = Object.entries(sources).map(([path, src]) => ({ name: basename(path), src }));

  it("finds the route sources (the glob is not silently empty)", () => {
    expect(entries.length).toBeGreaterThan(80);
  });

  it("has no hand-rolled collection outside the PENDING budget", () => {
    const offenders = entries
      .filter((e) => isHandRolledCollection(e.src) && !usesFactory(e.src) && !PENDING.has(e.name) && !NOT_COLLECTIONS.has(e.name))
      .map((e) => e.name);
    expect(offenders, "build these with collectionRoutes() from src/http/collectionRoute.ts - a hand-rolled standard-method surface drifts").toEqual([]);
  });

  it("lists nothing in PENDING that has already been converted", () => {
    const stale = [...PENDING].filter((name) => {
      const entry = entries.find((e) => e.name === name);
      return entry ? usesFactory(entry.src) : true; // gone or converted -> the entry is stale
    });
    expect(stale, "these are on the factory (or no longer exist) - remove them from PENDING").toEqual([]);
  });

  it("has every converted collection actually going through the factory", () => {
    const converted = entries.filter((e) => usesFactory(e.src));
    expect(converted.length, "the conversion has landed a good number of collections by now").toBeGreaterThanOrEqual(32);
    // A converted file must not also hand-register the standard methods - that would mean two lanes in one file.
    const mixed = converted.filter((e) => isHandRolledCollection(e.src)).map((e) => e.name);
    expect(mixed, "a factory-built collection must not also register GET / and GET /:id by hand").toEqual([]);
  });

  // The exemption is only honest while the claim holds: a key/value surface has no create and no delete, because
  // the caller names the key and PATCH upserts it. Growing either makes it a collection, and this test says so.
  it.each([...NOT_COLLECTIONS])("keeps %s a key/value surface, not a collection (%s)", (name) => {
    const entry = entries.find((e) => e.name === name);
    expect(entry, `src/routes/${name}.ts is gone - drop it from NOT_COLLECTIONS`).toBeDefined();
    expect(/\.post\(\s*(?:"|`)\//.test(entry!.src), `${name} grew a create - it is a collection now, build it with collectionRoutes()`).toBe(false);
    expect(/\.delete\(/.test(entry!.src), `${name} grew a delete - it is a collection now, build it with collectionRoutes()`).toBe(false);
  });
});

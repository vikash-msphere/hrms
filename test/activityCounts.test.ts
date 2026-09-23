/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import type { ListScope } from "../src/domain/access";
import { activityCounts, parseTabs } from "../src/services/activityCounts";
import { SEARCH_INDEX } from "../src/domain/searchIndex";

// The tab-bar badge counts. Two things have to hold, or the badge is either a leak or a lie:
//   1. a count only ever includes rows the caller's own list of that collection would have returned, and
//   2. it counts what the SOURCE tables hold - the numbers ride the search index, which the migration's
//      triggers keep in step with every write, so the test writes rows and never touches search_docs.

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

// Deleting the source rows takes their index docs with them (the AFTER DELETE triggers), so each test starts
// from an empty index without the test knowing search_docs exists.
const TABLES = [schema.tickets, schema.boards, schema.employees];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

const A = { uuid: genId(), code: "04-001-001" };
const B = { uuid: genId(), code: "04-002-001" };

const user = (employeeId: string | null): AppUser => ({ employeeId } as unknown as AppUser);
const all = (): ListScope => ({ breadth: "all", deptCode: null, ownerId: null, seeRestricted: true });
const own = (ownerId: string): ListScope => ({ breadth: "own", deptCode: null, ownerId, seeRestricted: true });

const DAY = 86_400_000;

async function seed(now: number) {
  await deps.db.insert(schema.employees).values([
    { uuid: A.uuid, code: A.code, firstName: "A", lastName: "A", workEmail: "a@x.test", status: "active" },
    { uuid: B.uuid, code: B.code, firstName: "B", lastName: "B", workEmail: "b@x.test", status: "active" },
  ]);
  // Tickets: two of A's are new, one is old, one is new but soft-deleted; one of B's is new.
  await deps.db.insert(schema.tickets).values([
    { uuid: genId(), code: `${A.code}-t1`, employeeId: A.uuid, subject: "new 1", priority: "medium", state: "OPEN", createdAt: new Date(now - 60_000) },
    { uuid: genId(), code: `${A.code}-t2`, employeeId: A.uuid, subject: "new 2", priority: "medium", state: "OPEN", createdAt: new Date(now - 30_000) },
    { uuid: genId(), code: `${A.code}-t3`, employeeId: A.uuid, subject: "old", priority: "medium", state: "OPEN", createdAt: new Date(now - 3 * DAY) },
    { uuid: genId(), code: `${A.code}-t4`, employeeId: A.uuid, subject: "binned", priority: "medium", state: "OPEN", createdAt: new Date(now - 10_000), deleteTime: new Date() },
    { uuid: genId(), code: `${B.code}-t1`, employeeId: B.uuid, subject: "b new", priority: "medium", state: "OPEN", createdAt: new Date(now - 20_000) },
  ]);
  // A flat catalog (no scope beyond the read grant): one new board, one old.
  await deps.db.insert(schema.boards).values([
    { uuid: genId(), code: "01-001", name: "New board", createdAt: new Date(now - 5_000) },
    { uuid: genId(), code: "01-002", name: "Old board", createdAt: new Date(now - 30 * DAY) },
  ]);
}

describe("activity counts", () => {
  it("counts only what arrived since the given moment, skipping soft-deleted rows", async () => {
    const now = Date.now();
    await seed(now);
    const since = now - DAY;
    const scopes = new Map<string, ListScope>([["tickets", all()], ["boards", all()]]);
    const out = await activityCounts(deps, user(A.uuid), scopes, [
      { collection: "tickets", since },
      { collection: "boards", since },
    ]);
    expect(out.tickets).toBe(3); // A's two new + B's one; the old one and the soft-deleted one excluded
    expect(out.boards).toBe(1); // the 30-day-old board is not news
  });

  it("binds each count to that collection's own list scope", async () => {
    const now = Date.now();
    await seed(now);
    const out = await activityCounts(deps, user(B.uuid), new Map([["tickets", own(B.uuid)]]), [
      { collection: "tickets", since: now - DAY },
    ]);
    expect(out.tickets).toBe(1); // B's own new ticket only - A's are not theirs to count
  });

  it("counts nothing for a collection the middleware did not scope", async () => {
    const now = Date.now();
    await seed(now);
    const out = await activityCounts(deps, user(A.uuid), new Map([["boards", all()]]), [
      { collection: "tickets", since: now - DAY },
      { collection: "boards", since: now - DAY },
    ]);
    expect(out.tickets).toBeUndefined(); // absent from the scopes map -> never queried
    expect(out.boards).toBe(1);
  });

  it("reports nothing new when the reference moment is now", async () => {
    const now = Date.now();
    await seed(now);
    const out = await activityCounts(deps, user(A.uuid), new Map([["tickets", all()]]), [
      { collection: "tickets", since: now },
    ]);
    expect(out.tickets).toBe(0);
  });

  describe("parseTabs", () => {
    it("takes well-formed pairs and drops the rest", () => {
      expect(parseTabs("tickets:1000,boards:2000")).toEqual([
        { collection: "tickets", since: 1000 },
        { collection: "boards", since: 2000 },
      ]);
      expect(parseTabs(undefined)).toEqual([]);
      expect(parseTabs("tickets")).toEqual([]); // no timestamp
      expect(parseTabs("tickets:abc")).toEqual([]); // not a number
      expect(parseTabs("tickets:-5")).toEqual([]); // not a moment
      expect(parseTabs("not-a-collection:1000")).toEqual([]); // unknown collection
      expect(parseTabs("tickets:1000,tickets:2000")).toEqual([{ collection: "tickets", since: 1000 }]); // first wins
    });

    it("caps how many collections one request can ask about", () => {
      const many = SEARCH_INDEX.slice(0, 30).map((e) => `${e.collection}:1000`).join(",");
      expect(parseTabs(many)).toHaveLength(24);
    });
  });
});

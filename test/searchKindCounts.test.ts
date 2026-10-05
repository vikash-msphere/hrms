/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { and, count, eq, isNotNull } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import type { ListScope } from "../src/domain/access";
import { applyScope } from "../src/services/listScope";
import { searchKindCounts } from "../src/services/globalSearch";

// The `in:` suggestions' totals (services/globalSearch.ts searchKindCounts) come from `search_counts`, the index
// pre-counted by triggers (migrations 0010, 0011) - so they are only right if (a) the triggers keep the counters in
// step with the TITLED `search_docs` rows (what words can find), and (b) the scope predicate bound to the counters answers exactly what it answers bound to
// `search_docs`. The oracle for both is the expensive way: count `search_docs` itself under the same scope.
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

beforeEach(async () => {
  for (const t of [schema.leaveRequests, schema.leaveTypes, schema.employees]) await deps.db.delete(t); // triggers clear the index, and the counters with it
});

const docs = schema.searchDocs;
const user = { uuid: genId(), role: "employee", status: "active" } as AppUser;
const all: ListScope = { breadth: "all", deptCode: null, ownerId: null, seeRestricted: true };
const dept = (deptCode: string, extra: Partial<ListScope> = {}): ListScope => ({ breadth: "dept", deptCode, ownerId: null, seeRestricted: true, ...extra });
const own = (ownerId: string): ListScope => ({ breadth: "own", deptCode: null, ownerId, seeRestricted: true });

async function person(code: string): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.employees).values({ uuid, code, firstName: "P", lastName: code, workEmail: `${code}@test.example`, status: "active" });
  return uuid;
}
// A leave request's index title is its reason, so `reason: null` makes a row no word can find.
async function leave(employeeId: string, code: string, reason: string | null = "x"): Promise<string> {
  const leaveTypeId = genId();
  await deps.db.insert(schema.leaveTypes).values({ uuid: leaveTypeId, code: `lt-${leaveTypeId.slice(0, 4)}`, name: "Casual" });
  const uuid = genId();
  await deps.db.insert(schema.leaveRequests).values({
    uuid, code, employeeId, leaveTypeId, startDate: new Date("2026-01-01"), endDate: new Date("2026-01-02"), days: 1, state: "PENDING", reason,
  });
  return uuid;
}

/** The expensive answer: the titled `search_docs` rows counted directly under the same scope. */
async function oracle(collection: string, scope: ListScope): Promise<number> {
  const [row] = await deps.db.select({ n: count() }).from(docs).where(and(
    eq(docs.collection, collection), eq(docs.deleted, false), isNotNull(docs.title),
    applyScope(scope, docs.code, docs.ownerId),
    scope.seeRestricted ? undefined : eq(docs.restricted, false),
  ));
  return row!.n;
}
const counted = async (collection: string, scope: ListScope) => (await searchKindCounts(deps, user, new Map([[collection, scope]])))[collection] ?? 0;

describe("searchKindCounts", () => {
  it("answers every breadth exactly as counting the index would", async () => {
    const alice = await person("04-a01");
    const bob = await person("05-b01");
    await leave(alice, "04-a01-001");
    await leave(alice, "04-a01-002");
    await leave(bob, "05-b01-001");

    for (const scope of [all, dept("04"), dept("05"), own(alice), own(bob), dept("05", { subtrees: ["04"] }), dept("09")]) {
      expect(await counted("leave-requests", scope), JSON.stringify(scope)).toBe(await oracle("leave-requests", scope));
      expect(await counted("employees", scope), JSON.stringify(scope)).toBe(await oracle("employees", scope));
    }
    expect(await counted("leave-requests", all)).toBe(3);
    expect(await counted("leave-requests", dept("04"))).toBe(2);
  });

  it("follows the index as rows are added, moved, restricted, soft-deleted and deleted", async () => {
    const alice = await person("04-a01");
    const first = await leave(alice, "04-a01-001");
    await leave(alice, "04-a01-002");
    expect(await counted("leave-requests", all)).toBe(2);

    // Moved to another department: counted there, and no longer here.
    await deps.db.update(docs).set({ code: "07-c01-001" }).where(eq(docs.recordId, first));
    expect(await counted("leave-requests", dept("07"))).toBe(1);
    expect(await counted("leave-requests", dept("04"))).toBe(1);

    // Restricted: still there for a caller who may see restricted rows, gone for one who may not.
    await deps.db.update(docs).set({ restricted: true }).where(eq(docs.recordId, first));
    expect(await counted("leave-requests", all)).toBe(2);
    expect(await counted("leave-requests", { ...all, seeRestricted: false })).toBe(1);
    expect(await counted("leave-requests", { ...all, seeRestricted: false })).toBe(await oracle("leave-requests", { ...all, seeRestricted: false }));

    // Soft-deleted, back, then gone for good.
    await deps.db.update(docs).set({ deleted: true }).where(eq(docs.recordId, first));
    expect(await counted("leave-requests", all)).toBe(1);
    await deps.db.update(docs).set({ deleted: false }).where(eq(docs.recordId, first));
    expect(await counted("leave-requests", all)).toBe(2);
    await deps.db.delete(schema.leaveRequests).where(eq(schema.leaveRequests.uuid, first));
    expect(await counted("leave-requests", all)).toBe(1);
  });

  it("counts only the rows words can find: a row without a title is left out until it gets one", async () => {
    const alice = await person("04-a01");
    const bare = await leave(alice, "04-a01-001", null);
    await leave(alice, "04-a01-002", "   "); // blank is no title either (the index stores it as NULL)
    await leave(alice, "04-a01-003");
    expect(await counted("leave-requests", all)).toBe(1);
    expect(await counted("leave-requests", all)).toBe(await oracle("leave-requests", all));

    // A reason written in: now findable, so counted. Edited: still one. Cleared: gone again.
    await deps.db.update(schema.leaveRequests).set({ reason: "family wedding" }).where(eq(schema.leaveRequests.uuid, bare));
    expect(await counted("leave-requests", all)).toBe(2);
    await deps.db.update(schema.leaveRequests).set({ reason: "cousin's wedding" }).where(eq(schema.leaveRequests.uuid, bare));
    expect(await counted("leave-requests", all)).toBe(2);
    await deps.db.update(schema.leaveRequests).set({ reason: null }).where(eq(schema.leaveRequests.uuid, bare));
    expect(await counted("leave-requests", all)).toBe(1);

    // An untitled row soft-deleted and deleted moves nothing; it was never counted.
    await deps.db.update(docs).set({ deleted: true }).where(eq(docs.recordId, bare));
    await deps.db.delete(schema.leaveRequests).where(eq(schema.leaveRequests.uuid, bare));
    expect(await counted("leave-requests", all)).toBe(1);
    expect(await counted("leave-requests", all)).toBe(await oracle("leave-requests", all));
  });

  it("leaves out a kind whose scope names single records, rather than counting past what may be seen", async () => {
    const alice = await person("04-a01");
    await leave(alice, "04-a01-001");
    const scopes = new Map<string, ListScope>([
      ["leave-requests", dept("05", { shares: ["04-a01-001"] })],
      ["employees", dept("05", { denies: ["04-a01"] })],
    ]);
    expect(await searchKindCounts(deps, user, scopes)).toEqual({});
  });

  it("names no kind the caller may not list, and none with nothing in it", async () => {
    const alice = await person("04-a01");
    await leave(alice, "04-a01-001");
    expect(Object.keys(await searchKindCounts(deps, user, new Map([["employees", all]])))).toEqual(["employees"]);
    expect(await searchKindCounts(deps, user, new Map([["holidays", all]]))).toEqual({});
  });
});

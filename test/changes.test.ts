/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { changedSince } from "../src/services/changes";
import { listableCollectionsFor } from "../src/middleware/authz";
import { rulesToGrant, deriveNarrowing, type CompiledRule } from "../src/domain/compileGrants";

// "What has been written since I last looked" - the answer a client trusts its stored copies against. The
// property that matters is COMPLETENESS: a write this fails to report is a client serving stale rows and never
// finding out. So these tests write through the ordinary tables and assert the stamps followed, which is a test
// of the generated triggers as much as of the query.

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
  await deps.db.delete(schema.holidays);
  // Bottom-up: the side-table cases below hang watchers and contributors off goals and cards, which hang off
  // employees, so clearing the parents first would be refused by the foreign keys.
  await deps.db.delete(schema.goalWatchers);
  await deps.db.delete(schema.goalContributors);
  await deps.db.delete(schema.cardWatchers);
  await deps.db.delete(schema.cards);
  await deps.db.delete(schema.boards);
  await deps.db.delete(schema.goals);
  await deps.db.delete(schema.employees);
  await deps.db.delete(schema.collectionVersions);
});

const seedHoliday = async (name: string) => {
  const uuid = genId();
  await deps.db.insert(schema.holidays).values({ uuid, code: `h-${genId().slice(0, 5)}`, name, date: new Date("2099-01-01"), kind: "fixed" });
  return uuid;
};

// The stamps come from a clock inside SQLite, so a test that writes and immediately asks "changed since now?"
// races it. Every case here asks about a window that started comfortably before the write.
const AGO = 60_000;

describe("changes feed", () => {
  it("names a collection that was inserted into", async () => {
    const before = Date.now() - AGO;
    await seedHoliday("Diwali");
    const out = await changedSince(deps, before);
    expect(out.collections).toContain("holidays");
  });

  it("names it for an UPDATE and for a DELETE too, not just an insert", async () => {
    const id = await seedHoliday("Diwali");
    await deps.db.delete(schema.collectionVersions); // forget the insert's stamp
    await deps.db.update(schema.holidays).set({ name: "Deepavali" }).where(eq(schema.holidays.uuid, id));
    expect((await changedSince(deps, Date.now() - AGO)).collections).toContain("holidays");

    await deps.db.delete(schema.collectionVersions);
    await deps.db.delete(schema.holidays).where(eq(schema.holidays.uuid, id));
    expect((await changedSince(deps, Date.now() - AGO)).collections).toContain("holidays");
  });

  it("names only the collections that were actually written to", async () => {
    const before = Date.now() - AGO;
    await seedHoliday("Diwali");
    const out = await changedSince(deps, before);
    expect(out.collections).toEqual(["holidays"]); // employees was not touched, so it is not named
  });

  it("says nothing changed - an ANSWER, not a refusal - when the window is quiet", async () => {
    await seedHoliday("Diwali");
    const after = Date.now() + 1000; // everything already stamped is older than this
    const out = await changedSince(deps, after);
    expect(out.collections).toEqual([]);
    expect(out.now).toBeLessThanOrEqual(Date.now());
  });

  it("refuses to answer without a reference point, rather than claiming nothing changed", async () => {
    await seedHoliday("Diwali");
    // A first visit (nothing stored), or a nonsense value: the client must revalidate normally instead of
    // trusting copies this cannot speak for.
    expect((await changedSince(deps, 0)).collections).toBeNull();
    expect((await changedSince(deps, Number.NaN)).collections).toBeNull();
  });

  it("answers a copy from long ago as exactly as a recent one - the stamps are state, not history", async () => {
    await seedHoliday("Diwali");
    const weekAgo = Date.now() - 7 * 24 * 60 * 60_000;
    expect((await changedSince(deps, weekAgo)).collections).toContain("holidays");
  });

  // THE REFERENCE POINT IS REWOUND, and the two clocks are why.
  //
  // The stamps come from the DATABASE's clock (a SQLite trigger, src/db/changeDdl.ts); `now` is the Worker's.
  // Handing the client the Worker's reading unrewound means a database clock even slightly behind it stamps a
  // write BELOW the value the client will send back, `at > since` is false for it ever after, and that
  // collection is never named again until somebody writes to it - a stored copy served stale for its whole
  // life, which is the one failure this mechanism exists to prevent. Re-reporting a collection costs a read;
  // missing one is silent.
  it("hands back a reference point BEHIND its own clock, so a skewed database clock cannot hide a write", async () => {
    const before = Date.now();
    const out = await changedSince(deps, before - 1000);
    expect(out.now).toBeLessThan(before);
    // And the unknown-window answer carries the same rewound value, since the client stores that one too.
    expect((await changedSince(deps, 0)).now).toBeLessThan(before);
  });

  // A stamp EQUAL to the reference point is reported, not dropped. `now` is captured before the read, so a
  // write committing in that same millisecond lands exactly on the boundary a strict `>` discards.
  it("reports a collection stamped at the reference point itself", async () => {
    await seedHoliday("Diwali");
    const stamp = (await deps.db.select().from(schema.collectionVersions))
      .find((r) => r.collection === "holidays")!;
    expect((await changedSince(deps, +new Date(stamp.at))).collections).toContain("holidays");
  });
});

// A SIDE TABLE HAS TO STAMP ITS PARENT.
//
// `goal_watchers`, `goal_contributors` and `card_watchers` back fields the PARENT resource ships - a goal
// carries `watching`/`watcher_count`/`contributors`, a card carries the first two (src/http/serialize.ts) -
// and the verbs that write them (`:watch`, `:unwatch`, `:setContributors`) touch nothing else. So nothing
// stamped `goals` or `cards`, this feed reported that neither had changed, and a stored copy kept the old
// watch state and the old credit split for as long as it lived: press Watch, reload, and the button is back
// where it started. The global list validator (src/http/listEtag.ts) is built from these same stamps, so the
// list re-read that would have corrected it was answered 304 as well.
//
// Written through the ORDINARY tables, exactly as the cases above are, so this is a test of the generated
// trigger rather than of a mapping table.
describe("a write to a side table stamps the collection it changes", () => {
  const seedEmployee = async () => {
    const uuid = genId();
    await deps.db.insert(schema.employees).values({
      uuid, code: `04-${genId().slice(0, 3)}`, firstName: "Watch", lastName: "Er",
      workEmail: `${uuid}@test.example`, status: "active",
    });
    return uuid;
  };

  it("stamps `goals` when somebody watches one, and when they stop", async () => {
    const employeeId = await seedEmployee();
    const goalId = genId();
    await deps.db.insert(schema.goals).values({ uuid: goalId, code: `04-${genId().slice(0, 6)}`, employeeId, title: "Ship it" });

    await deps.db.delete(schema.collectionVersions); // forget the goal's own insert stamp
    const watchId = genId();
    await deps.db.insert(schema.goalWatchers).values({ uuid: watchId, goalId, employeeId });
    expect((await changedSince(deps, Date.now() - AGO)).collections).toContain("goals");

    await deps.db.delete(schema.collectionVersions);
    await deps.db.delete(schema.goalWatchers).where(eq(schema.goalWatchers.uuid, watchId));
    expect((await changedSince(deps, Date.now() - AGO)).collections).toContain("goals");
  });

  it("stamps `goals` when the credit split is rewritten", async () => {
    const employeeId = await seedEmployee();
    const other = await seedEmployee();
    const goalId = genId();
    await deps.db.insert(schema.goals).values({ uuid: goalId, code: `04-${genId().slice(0, 6)}`, employeeId, title: "Ship it" });

    await deps.db.delete(schema.collectionVersions);
    await deps.db.insert(schema.goalContributors).values({ uuid: genId(), goalId, employeeId: other, share: 30 });
    expect((await changedSince(deps, Date.now() - AGO)).collections).toContain("goals");
  });

  it("stamps `cards` when somebody watches one", async () => {
    const employeeId = await seedEmployee();
    const boardId = genId();
    await deps.db.insert(schema.boards).values({ uuid: boardId, code: `b-${genId().slice(0, 5)}`, name: "Board" });
    const cardId = genId();
    await deps.db.insert(schema.cards).values({ uuid: cardId, code: `c-${genId().slice(0, 5)}`, boardId, employeeId, columnKey: "todo", title: "Card" });

    await deps.db.delete(schema.collectionVersions);
    await deps.db.insert(schema.cardWatchers).values({ uuid: genId(), cardId, employeeId });
    expect((await changedSince(deps, Date.now() - AGO)).collections).toContain("cards");
  });
});

// The answer is collection NAMES, so "which names may this caller be told" is the whole access story. It is the
// same list decision a real GET /v1/<collection> gets, reduced to a boolean - so a caller learns nothing about
// a collection they could not have read for themselves.
describe("which collections a caller may be told about", () => {
  const rule = (pattern: string, level: "read" | "write" | null): CompiledRule => {
    const n = deriveNarrowing(pattern);
    return { namespace: n.namespace, pattern, scopeKind: n.scopeKind, scopeCode: n.scopeCode, matchCode: n.scopeKind === "exact" ? n.scopeCode : null, level, effect: "allow" };
  };
  const user = (patterns: string[]): AppUser =>
    ({ grant: rulesToGrant(patterns.map((p) => rule(p, "read"))), employeeCode: "04-001-001" }) as unknown as AppUser;

  it("names only what the caller may list", () => {
    const listable = listableCollectionsFor(user(["holidays", "leave-requests"]));
    expect(listable.has("holidays")).toBe(true);
    expect(listable.has("leave-requests")).toBe(true);
    expect(listable.has("payroll-runs")).toBe(false); // not granted -> never named
  });

  it("gives a caller with no grants nothing at all", () => {
    expect(listableCollectionsFor(user([])).size).toBe(0);
  });

  it("covers `settings`, which is cached like a collection but is not code-scoped", () => {
    expect(listableCollectionsFor(user(["settings"])).has("settings")).toBe(true);
    expect(listableCollectionsFor(user(["holidays"])).has("settings")).toBe(false);
  });
});

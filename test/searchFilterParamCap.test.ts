/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { searchFilter } from "../src/services/searchFilter";
import { eq, sql } from "drizzle-orm";

// D1 binds at most 100 parameters per statement (lib/dbBatch.ts PARAM_CAP). `searchFilter` returns up to
// MAX_MATCHES (500) ids, and binding one parameter per id blew that cap: a text search on a collection where
// more than ~90 rows matched failed the WHOLE list with `D1_ERROR: too many SQL variables`. It only appears
// once a collection is big enough to be worth searching, which is why an empty dev database never showed it.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const b = env as unknown as Bindings;
let deps: Deps;

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
  await deps.db.delete(schema.employees); // the delete trigger clears the index rows with them
});

/** `n` employees who all match the same word, so one query returns all of them. */
async function seedMatching(n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const uuid = genId();
    ids.push(uuid);
    await deps.db.insert(schema.employees).values({
      uuid,
      code: `04-${i.toString(36)}`,
      firstName: "Searchable",
      lastName: `Person${i}`,
      jobTitle: "Engineer",
      workEmail: `p${i}@test.example`,
      status: "active",
    });
  }
  return ids;
}

describe("searchFilter stays inside D1's parameter cap", () => {
  it("filters on a query matching far more rows than D1 can bind as parameters", async () => {
    const ids = await seedMatching(140);
    const where = await searchFilter(deps, "employees", "searchable", schema.employees.uuid);
    expect(where).toBeDefined();
    // The whole point: this statement RUNS. Bound one-id-per-parameter it threw before reaching the rows.
    const rows = await deps.db.select({ uuid: schema.employees.uuid }).from(schema.employees).where(where);
    expect(rows.length).toBe(140);
    expect(new Set(rows.map((r) => r.uuid))).toEqual(new Set(ids));
  });

  it("still narrows to the matches, and to nothing when there are none", async () => {
    await seedMatching(3);
    const hit = await searchFilter(deps, "employees", "searchable", schema.employees.uuid);
    expect((await deps.db.select().from(schema.employees).where(hit)).length).toBe(3);

    const miss = await searchFilter(deps, "employees", "zzzznotpresent", schema.employees.uuid);
    expect((await deps.db.select().from(schema.employees).where(miss)).length).toBe(0);
  });

  it("does not filter at all for a blank or one-character query", async () => {
    await seedMatching(2);
    expect(await searchFilter(deps, "employees", "", schema.employees.uuid)).toBeUndefined();
    expect(await searchFilter(deps, "employees", "a", schema.employees.uuid)).toBeUndefined();
  });
});

// WHICH matches come back when there are more than the cap allows - and whether a deleted row is allowed to
// take one of those slots.
//
// Neither was decided before: the query had no ORDER BY, so `LIMIT 500` took whatever the FTS join reached
// first (rowid order, i.e. the OLDEST rows), and it had no `deleted` filter, so trash consumed the budget that
// live rows needed. On a collection big enough to be worth searching, the list's search box answered with old
// records and silently omitted recent ones. services/globalSearch.ts already did both; this is the sibling
// catching up.
describe("searchFilter spends its cap on the right rows", () => {
  it("excludes soft-deleted rows, so they cannot eat the match budget", async () => {
    const ids = await seedMatching(4);
    // The index carries a `deleted` flag rather than dropping the row (see db/searchDdl.ts), which is exactly
    // why the filter has to be asked for.
    await deps.db.update(schema.employees).set({ deleteTime: new Date() }).where(eq(schema.employees.uuid, ids[0]!));

    const where = await searchFilter(deps, "employees", "searchable", schema.employees.uuid);
    // Asked WITHOUT the caller's own soft-delete filter, so what is measured is this function's own answer.
    const rows = await deps.db.select({ uuid: schema.employees.uuid }).from(schema.employees).where(where);
    expect(rows.map((r) => r.uuid)).not.toContain(ids[0]);
    expect(rows).toHaveLength(3);
  });

  it("orders by relevance, so the cap keeps the best matches and not the oldest", async () => {
    // An exact-title match and a body-only match, inserted oldest-first. Under rowid order the older, weaker
    // row leads; under rank the stronger one does.
    const weak = genId();
    await deps.db.insert(schema.employees).values({ uuid: weak, code: "04-w", firstName: "Priya", lastName: "Kumar", jobTitle: "Rigging Specialist", workEmail: "weak@test.example", status: "active" });
    const strong = genId();
    await deps.db.insert(schema.employees).values({ uuid: strong, code: "04-s", firstName: "Rigging", lastName: "Rigging", jobTitle: "Rigging", workEmail: "strong@test.example", status: "active" });

    const ranked = await deps.db.all<{ id: string }>(sql`
      select d."record_id" as id
      from "search_fts" f join "search_docs" d on d."rowid" = f."rowid"
      where f."text" match '"rigging"*' and d."collection" = 'employees' and d."deleted" = 0
      order by f."rank"
    `);
    expect(ranked.map((r) => r.id)).toHaveLength(2);
    // The denser match leads. Without `order by f."rank"` this is insertion order and `weak` comes first -
    // which is the whole failure: at the cap, the tail is dropped.
    expect(ranked[0]!.id).toBe(strong);
  });
});

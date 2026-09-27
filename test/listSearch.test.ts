/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { AppUser, Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { DEFAULT_POLICY } from "../bootstrap/authz/policy";
import type { ListScope } from "../src/domain/access";
import { crudService } from "../src/services/crud";
import { vendorSpec } from "../src/services/vendors";
import { listEvents } from "../src/services/events";
import { listAssets } from "../src/services/assets";

// A list page's search box answered over the WHOLE collection (`?q=`, services/searchFilter.ts), for the lists
// that used to answer it from the hundred rows a page holds: every collection-factory catalogue through the
// generic list, and the custom lists of the growing tables. What is held: the text narrows, and only narrows -
// the caller's scope is still the outer bound.

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
  for (const t of [schema.vendors, schema.events, schema.assets]) await deps.db.delete(t);
});

const ALL: ListScope = { breadth: "all", deptCode: null, ownerId: null, seeRestricted: true };
const NONE: ListScope = { breadth: "own", deptCode: null, ownerId: null, seeRestricted: false };
const actor = { uuid: genId(), policy: DEFAULT_POLICY } as unknown as AppUser;

describe("list search over the whole collection", () => {
  it("narrows a factory catalogue's generic list to its text matches", async () => {
    await deps.db.insert(schema.vendors).values([
      { uuid: genId(), code: "v1", name: "Acme Cloud Hosting" },
      { uuid: genId(), code: "v2", name: "Zomato Business" },
    ] as never);
    const svc = crudService(vendorSpec);
    expect((await svc.list(deps, actor, ALL, 100)).items).toHaveLength(2);
    const found = await svc.list(deps, actor, ALL, 100, undefined, false, false, "acme");
    expect(found.items.map((v) => v.name)).toEqual(["Acme Cloud Hosting"]);
    expect((await svc.list(deps, actor, ALL, 100, undefined, false, false, "zomato")).items).toHaveLength(1);
  });

  it("still binds the caller's scope around the text match", async () => {
    await deps.db.insert(schema.vendors).values({ uuid: genId(), code: "v1", name: "Acme Cloud Hosting" } as never);
    // An own-scoped caller of a catalogue with no owner column lists nothing, search or not.
    expect((await crudService(vendorSpec).list(deps, actor, NONE, 100, undefined, false, false, "acme")).items).toEqual([]);
  });

  it("searches events and assets through their own lists", async () => {
    await deps.db.insert(schema.events).values([
      { uuid: genId(), code: "e1", title: "Annual offsite", startTime: new Date("2026-10-01"), endTime: new Date("2026-10-02"), allDay: true },
      { uuid: genId(), code: "e2", title: "Town hall", startTime: new Date("2026-10-05"), endTime: new Date("2026-10-05"), allDay: true },
    ] as never);
    expect((await listEvents(deps, ALL, 100, undefined, false, false, "offsite")).items.map((e) => e.title)).toEqual(["Annual offsite"]);

    await deps.db.insert(schema.assets).values([
      { uuid: genId(), code: "a1", name: "MacBook Pro 14", assetTag: "LAP-0012", status: "in_stock" },
      { uuid: genId(), code: "a2", name: "Aeron chair", assetTag: "FUR-0001", status: "in_stock" },
    ] as never);
    const tagged = await listAssets(deps, ALL, { maxPageSize: 100, q: "LAP-0012" });
    expect(tagged.items.map((a) => a.name)).toEqual(["MacBook Pro 14"]);
  });
});

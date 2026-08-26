/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import type { ListScope } from "../src/domain/access";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { clampPageSize } from "../src/http/pagination";
import { listHolidays } from "../src/services/holidays";
import { listEmployees } from "../src/services/employees";

// A list response is CAPPED, and the cap is invisible unless the response says so. The web caches one page per
// collection and filters/sorts/exports it client-side, so if a capped page came back without a cursor the UI
// would present the first 100 rows as the entire collection - a filter would report "no results" for a record
// that exists. These pin the contract the UI relies on to admit truncation (useCollection's `hasMore`).
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
});

const actor = { uuid: "u", email: "a@b.c", role: "super_admin", status: "active", employeeId: null, employeeCode: null, name: null } as unknown as AppUser;
// The row filter the authz middleware hands a list request. Org-wide here, which is what every seeded role
// resolves to on the holiday catalog - the cap is what these tests are about, not the scope.
const ALL: ListScope = { breadth: "all", deptCode: null, ownerId: null, seeRestricted: true };

async function seedHolidays(n: number) {
  const rows = Array.from({ length: n }, (_, i) => ({ uuid: genId(), code: `h-${i}`, date: new Date("2026-03-04"), name: `Holiday ${i}` }));
  for (let i = 0; i < rows.length; i += 8) await deps.db.insert(schema.holidays).values(rows.slice(i, i + 8));
}

describe("list pagination cap", () => {
  it("clamps any requested page size to 100", () => {
    // The web asks for 200 (api.ts `list`), and one page asks for 500 - both land here.
    expect(clampPageSize(200)).toBe(100);
    expect(clampPageSize(500)).toBe(100);
    expect(clampPageSize(undefined)).toBe(50);
  });

  it("returns a cursor when the collection is larger than one page, so the client can tell it was truncated", async () => {
    await seedHolidays(150);
    const page = await listHolidays(deps, actor, ALL, clampPageSize(500));
    expect(page.items.length).toBe(100); // NOT 150, however much the caller asked for
    expect(page.nextPageToken, "a truncated page MUST carry a cursor or the UI cannot know it is partial").toBeTruthy();
  });

  it("returns no cursor when the whole collection fits, so a complete page is not labelled partial", async () => {
    await seedHolidays(12);
    const page = await listHolidays(deps, actor, ALL, clampPageSize(200));
    expect(page.items.length).toBe(12);
    expect(page.nextPageToken).toBeUndefined();
  });
});

// The point of server-side `?q=`: a record past the first page is unreachable by client-side filtering, but a
// server-filtered list finds it. These use employees, whose list is scoped, so the filter must also compose
// with that scope rather than bypassing it.
describe("list ?q= searches the whole collection, not just the loaded page", () => {
  const superScope = { breadth: "all" as const, deptCode: null, ownerId: null, seeRestricted: true };

  beforeEach(async () => {
    await deps.db.delete(schema.employees);
  });

  async function seedPeople(n: number) {
    const rows = Array.from({ length: n }, (_, i) => ({
      uuid: genId(), code: `04-${String(i).padStart(4, "0")}`,
      firstName: "Filler", lastName: `Person${i}`, workEmail: `f${i}@test.example`, status: "active" as const,
    }));
    for (let i = 0; i < rows.length; i += 8) await deps.db.insert(schema.employees).values(rows.slice(i, i + 8));
  }

  it("finds a record that sits well past the first page", async () => {
    await seedPeople(250);
    // A page is a window on the NEWEST rows, so the needle is stamped as the oldest record in the table: it is
    // nowhere near the first 100 and only the server-side filter can reach it.
    await deps.db.insert(schema.employees).values({
      uuid: genId(), code: "04-9999", firstName: "Zoya", lastName: "Kapoor",
      workEmail: "zoya@test.example", jobTitle: "Principal Engineer", status: "active",
      createdAt: new Date("2020-01-01T00:00:00Z"), updatedAt: new Date("2020-01-01T00:00:00Z"),
    });

    const firstPage = await listEmployees(deps, superScope, clampPageSize(200));
    expect(firstPage.items.length).toBe(100);
    expect(firstPage.items.some((r: { lastName: string }) => r.lastName === "Kapoor")).toBe(false); // invisible to client-side filtering

    const searched = await listEmployees(deps, superScope, clampPageSize(200), undefined, false, "kapoor");
    expect(searched.items.map((r: { lastName: string }) => r.lastName)).toEqual(["Kapoor"]);
    // Matching is on any indexed column, not just the name.
    expect((await listEmployees(deps, superScope, 100, undefined, false, "principal")).items.length).toBe(1);
  });

  it("returns nothing for a query that matches nothing, rather than falling back to the unfiltered list", async () => {
    await seedPeople(20);
    expect((await listEmployees(deps, superScope, 100, undefined, false, "zzzznomatch")).items).toEqual([]);
  });

  it("ignores a blank or one-character query instead of filtering everything out", async () => {
    await seedPeople(20);
    expect((await listEmployees(deps, superScope, 100, undefined, false, "")).items.length).toBe(20);
    expect((await listEmployees(deps, superScope, 100, undefined, false, "  ")).items.length).toBe(20);
    expect((await listEmployees(deps, superScope, 100, undefined, false, "a")).items.length).toBe(20);
  });

  it("narrows within the caller's scope - it can never widen it", async () => {
    await seedPeople(5);
    const mine = (await deps.db.select().from(schema.employees).limit(1))[0]!;
    // An "own" scope sees exactly one row; searching for a colleague must still return nothing.
    const ownScope = { breadth: "own" as const, deptCode: null, ownerId: mine.uuid, seeRestricted: true };
    expect((await listEmployees(deps, ownScope, 100)).items.length).toBe(1);
    expect((await listEmployees(deps, ownScope, 100, undefined, false, "filler")).items.map((r: { uuid: string }) => r.uuid)).toEqual([mine.uuid]);
    expect((await listEmployees(deps, ownScope, 100, undefined, false, `person${mine.lastName === "Person0" ? 1 : 0}`)).items).toEqual([]);
  });
});

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
import { listAnnouncements } from "../src/services/announcements";
import { listSuggestions } from "../src/services/suggestions";
import { listTimeEntries } from "../src/services/timeEntries";
import { listEvents } from "../src/services/events";

// A list response is ONE PAGE, and the web treats that page as the collection: it caches it, filters, sorts and
// exports it client-side, and a feed asks for a single page before the reader scrolls. So WHICH end of the
// collection the first page comes from is the whole product behaviour, not a detail - under oldest-first the
// board opened on the very first post ever written and the newest one could only be reached by paging to the
// end. These pin newest-first, and pin that a list which PRESENTS rows in some other order still pages on the
// cursor's own key (sorting the whole set by one key and seeking on another silently drops rows between pages).
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;
const ALL: ListScope = { breadth: "all", deptCode: null, ownerId: null, seeRestricted: true };
const t = 1_700_000_000_000;
const at = (i: number) => new Date(t + i * 1000);
/** Three rows, written oldest to newest, so "first" means something. */
const AGES = ["old", "mid", "new"] as const;

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

let employeeId: string;
beforeEach(async () => {
  await deps.db.delete(schema.announcements);
  await deps.db.delete(schema.suggestions);
  await deps.db.delete(schema.timeEntries);
  await deps.db.delete(schema.events);
  employeeId = genId();
  await deps.db.insert(schema.employees).values({
    uuid: employeeId, code: `04-${genId().slice(0, 3)}`, firstName: "Lister", lastName: "User",
    workEmail: `${employeeId}@test.example`, status: "active",
  });
});

describe("the first page is a window on the NEWEST rows", () => {
  it("the board opens on the newest post, not the first one ever written", async () => {
    for (const [i, title] of AGES.entries()) {
      await deps.db.insert(schema.announcements).values({
        uuid: genId(), code: `a-${i}`, title, body: title, kind: "post", published: true, disabled: false,
        createdAt: at(i), updatedAt: at(i),
      });
    }
    const page = await listAnnouncements(deps, ALL, 1);
    expect(page.items.map((a) => a.title), "the newest post is on page 1").toEqual(["new"]);
    expect(page.nextPageToken, "and the older ones are behind the cursor").toBeTruthy();
  });

  it("pages the whole board exactly once, newest to oldest", async () => {
    for (const [i, title] of AGES.entries()) {
      await deps.db.insert(schema.announcements).values({
        uuid: genId(), code: `a-${i}`, title, body: title, kind: "post", published: true, disabled: false,
        createdAt: at(i), updatedAt: at(i),
      });
    }
    const seen: string[] = [];
    let token: string | undefined;
    for (let guard = 0; guard < 5; guard++) {
      const page = await listAnnouncements(deps, ALL, 1, token);
      seen.push(...page.items.map((a) => a.title));
      token = page.nextPageToken;
      if (!token) break;
    }
    expect(seen).toEqual(["new", "mid", "old"]);
  });

  it("opens the suggestion box on the newest suggestion", async () => {
    for (const [i, title] of AGES.entries()) {
      await deps.db.insert(schema.suggestions).values({
        uuid: genId(), code: `s-${i}`, submitterId: employeeId, title, body: title, status: "new",
        createdAt: at(i), updatedAt: at(i),
      });
    }
    const page = await listSuggestions(deps, ALL, 1);
    expect(page.items.map((s) => s.title)).toEqual(["new"]);
  });

  it("opens the events list on the newest event", async () => {
    for (const [i, title] of AGES.entries()) {
      await deps.db.insert(schema.events).values({
        uuid: genId(), code: `e-${i}`, title, startTime: at(i), endTime: at(i), createdAt: at(i), updatedAt: at(i),
      });
    }
    const page = await listEvents(deps, ALL, 1);
    expect(page.items.map((e) => e.title)).toEqual(["new"]);
  });
});

describe("a presentation order does not decide the paging", () => {
  // Timesheets are READ by worked day but PAGED on createdAt, which is what the cursor carries. Logging an old
  // day last makes those two orders disagree, which is exactly when a set sorted by `date` and seeked by
  // `createdAt` used to skip a row: it seeked past an entry that had never been returned.
  it("pages every time entry exactly once when a day is logged out of order", async () => {
    const projectId = genId();
    await deps.db.insert(schema.projects).values({ uuid: projectId, code: "pr-1", name: "Client work" });
    // Written newest-day first, then the forgotten Monday: creation order and worked-day order disagree.
    const days = [
      { hours: 8, date: at(300), createdAt: at(1) },
      { hours: 7, date: at(200), createdAt: at(2) },
      { hours: 6, date: at(100), createdAt: at(3) },
    ];
    for (const [i, d] of days.entries()) {
      await deps.db.insert(schema.timeEntries).values({
        uuid: genId(), code: `04-000-${i}`, employeeId, projectId, date: d.date, hours: d.hours,
        createdAt: d.createdAt, updatedAt: d.createdAt,
      });
    }
    const seen: number[] = [];
    let token: string | undefined;
    for (let guard = 0; guard < 6; guard++) {
      const page = await listTimeEntries(deps, ALL, 1, token);
      seen.push(...page.items.map((e) => e.hours));
      token = page.nextPageToken;
      if (!token) break;
    }
    expect(seen.sort(), "no entry may fall between two pages").toEqual([6, 7, 8]);
  });
});

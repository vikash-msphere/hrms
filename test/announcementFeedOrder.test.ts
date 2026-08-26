/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import type { ListScope } from "../src/domain/access";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { boardOrderValue } from "../src/domain/board";
import { createAnnouncement, listAnnouncements, setPinned, updateAnnouncement } from "../src/services/announcements";
import { setPublished } from "../src/services/lifecycle";

// The board is READ in one order (pinned first, then when the post went live) and PAGED in another - or it
// used to be, which is why "Load older posts" could drop a post at the TOP of the feed and why a pinned post
// older than the first page was invisible until you paged down to it. These tests hold the two together: the
// cursor walks the collection in exactly the order the feed displays, and nothing an author does afterwards
// (an edit, a re-schedule) can move a post that has already gone out.
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

const TABLES = [schema.announcements, schema.notifications, schema.auditLog, schema.eventLog, schema.settings, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

async function seedActor(): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: `04-${genId().slice(0, 3)}`, firstName: "Poster", lastName: "User", workEmail: `${employeeId}@test.example`, status: "active" });
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role: "employee", employeeId });
  return { uuid, email: `${uuid}@test.example`, role: "employee", status: "active", employeeId, employeeCode: null } as unknown as AppUser;
}

const editors: ListScope = { breadth: "all", deptCode: null, ownerId: null, seeRestricted: true };
const DAY = 86_400_000;

// A post written `daysAgo` days back. Board rows are written by the service (codes, audit, notifications), so
// the age is applied afterwards - the only way to have a row that is genuinely old.
async function postedDaysAgo(actor: AppUser, title: string, daysAgo: number) {
  const row = await createAnnouncement(deps, actor, { kind: "announcement", title, body: "x" });
  await deps.db.update(schema.announcements).set({ createdAt: new Date(Date.now() - daysAgo * DAY) }).where(eq(schema.announcements.uuid, row.uuid));
  return row.uuid;
}

/** Follow the cursor to the end, one small page at a time, and return every title it handed out. */
async function walk(pageSize: number): Promise<string[]> {
  const titles: string[] = [];
  let token: string | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const page = await listAnnouncements(deps, editors, pageSize, token);
    titles.push(...page.items.map((r) => r.title));
    token = page.nextPageToken;
    if (!token) return titles;
  }
  throw new Error("cursor never ran out");
}

/** The order the feed renders in, computed from the rows themselves. */
async function expectedOrder(): Promise<string[]> {
  const rows = await deps.db.select().from(schema.announcements);
  return rows
    .sort((a, b) => boardOrderValue(b) - boardOrderValue(a) || (a.uuid < b.uuid ? 1 : -1))
    .map((r) => r.title);
}

describe("board feed order", () => {
  it("pages in the same order it is read, with every post handed out exactly once", async () => {
    const actor = await seedActor();
    await postedDaysAgo(actor, "Oldest", 30);
    await postedDaysAgo(actor, "Older", 20);
    await postedDaysAgo(actor, "Old", 10);
    await postedDaysAgo(actor, "Recent", 2);
    await createAnnouncement(deps, actor, { kind: "announcement", title: "Newest", body: "x" });

    const walked = await walk(2);
    expect(walked).toEqual(await expectedOrder());
    expect(new Set(walked).size).toBe(walked.length);
    expect(walked).toEqual(["Newest", "Recent", "Old", "Older", "Oldest"]);
  });

  it("places a draft published later by when it went LIVE, on the page a reader is looking at", async () => {
    const actor = await seedActor();
    await postedDaysAgo(actor, "Newest", 0);
    await postedDaysAgo(actor, "Middle", 5);
    await postedDaysAgo(actor, "Oldest", 30);
    // Written a month ago, published just now: the board is about when a post went OUT, so it leads - and it
    // has to lead on the FIRST page, not arrive at the top after someone loads older posts.
    const draft = await createAnnouncement(deps, actor, { kind: "announcement", title: "Held back", body: "x", published: false });
    await deps.db.update(schema.announcements).set({ createdAt: new Date(Date.now() - 40 * DAY) }).where(eq(schema.announcements.uuid, draft.uuid));
    await setPublished(deps, actor, schema.announcements, "announcement", "announcements", draft.uuid, true, true);

    const first = await listAnnouncements(deps, editors, 2);
    expect(first.items.map((r) => r.title)).toEqual(["Held back", "Newest"]);
    expect(await walk(2)).toEqual(["Held back", "Newest", "Middle", "Oldest"]);
  });

  it("puts a pinned post on the first page however old it is", async () => {
    const actor = await seedActor();
    const ancient = await postedDaysAgo(actor, "Ancient notice", 90);
    await postedDaysAgo(actor, "A", 3);
    await postedDaysAgo(actor, "B", 2);
    await postedDaysAgo(actor, "C", 1);
    await setPinned(deps, actor, ancient, true);

    const first = await listAnnouncements(deps, editors, 2);
    expect(first.items.map((r) => r.title)).toEqual(["Ancient notice", "C"]);
    expect(await walk(2)).toEqual(["Ancient notice", "C", "B", "A"]);
    expect(await walk(2)).toEqual(await expectedOrder());
  });

  it("orders several pinned posts by when they were pinned, newest pin first", async () => {
    const actor = await seedActor();
    const one = await postedDaysAgo(actor, "First pinned", 9);
    const two = await postedDaysAgo(actor, "Second pinned", 8);
    await postedDaysAgo(actor, "Unpinned", 1);
    await setPinned(deps, actor, one, true);
    await deps.db.update(schema.announcements).set({ pinnedAt: new Date(Date.now() - 60_000) }).where(eq(schema.announcements.uuid, one));
    await setPinned(deps, actor, two, true);

    expect(await walk(1)).toEqual(["Second pinned", "First pinned", "Unpinned"]);
  });
});

// `publish_time` is a draft's SCHEDULE and nothing else. The moment it can be set to the past, or moved after
// the post has gone out, the feed's order stops being a fact about the board and becomes something an author
// can edit - which is the other half of "posts move around".
describe("publish_time is a schedule, not a dial", () => {
  it("refuses a publish_time on a post going out now", async () => {
    const actor = await seedActor();
    await expect(
      createAnnouncement(deps, actor, { kind: "announcement", title: "Backdated", body: "x", publish_time: new Date(Date.now() - 5 * DAY).toISOString() }),
    ).rejects.toThrow(/only for a draft/);
  });

  it("refuses a schedule in the past", async () => {
    const actor = await seedActor();
    await expect(
      createAnnouncement(deps, actor, { kind: "announcement", title: "Yesterday", body: "x", published: false, publish_time: new Date(Date.now() - DAY).toISOString() }),
    ).rejects.toThrow(/must be in the future/);
  });

  it("lets a draft be re-scheduled, forwards only", async () => {
    const actor = await seedActor();
    const draft = await createAnnouncement(deps, actor, { kind: "announcement", title: "Later", body: "x", published: false, publish_time: new Date(Date.now() + DAY).toISOString() });

    const moved = await updateAnnouncement(deps, actor, draft.uuid, { publish_time: new Date(Date.now() + 2 * DAY).toISOString() });
    expect(+new Date(moved.publishTime!)).toBeGreaterThan(Date.now());
    await expect(updateAnnouncement(deps, actor, draft.uuid, { publish_time: new Date(Date.now() - DAY).toISOString() })).rejects.toThrow(/must be in the future/);
  });

  it("refuses to move a live post's time, and lets an unchanged one through", async () => {
    const actor = await seedActor();
    const live = await createAnnouncement(deps, actor, { kind: "announcement", title: "Out", body: "x" });

    await expect(updateAnnouncement(deps, actor, live.uuid, { publish_time: new Date(Date.now() - 5 * DAY).toISOString() })).rejects.toThrow(/can't be changed/);
    // The composer sends `publish_time: null` on an edit that doesn't touch the schedule; a no-op must not 400.
    const edited = await updateAnnouncement(deps, actor, live.uuid, { title: "Out (fixed)", publish_time: null });
    expect(edited.title).toBe("Out (fixed)");
    expect(edited.publishTime).toBeNull();
  });
});

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
import { createAnnouncement, listAnnouncements, publishDueAnnouncements, updateAnnouncement } from "../src/services/announcements";

// A draft is a post that exists without having been announced. Two promises hold it together, and both are
// tested here: nobody is told about it until it goes live, and nobody outside the editors can see it in the
// meantime. Scheduling is the same thing with a clock attached - the cron flips it, exactly once.
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

// The list scope the authz middleware hands a board request. Org-wide breadth (every grant on `announcements`
// is unscoped), so what these vary is `seeRestricted`: an editor sees drafts and disabled posts, nobody else does.
const editors: ListScope = { breadth: "all", deptCode: null, ownerId: null, seeRestricted: true };
const everyone: ListScope = { breadth: "all", deptCode: null, ownerId: null, seeRestricted: false };
const notificationCount = async () => (await deps.db.select().from(schema.notifications)).length;

describe("board drafts", () => {
  it("keeps a draft off the board and out of the bell until it is published", async () => {
    const actor = await seedActor();
    await seedActor(); // somebody to notify, so a broadcast would be visible
    const draft = await createAnnouncement(deps, actor, { kind: "announcement", title: "Later", body: "Not yet", published: false });

    expect(draft.published).toBe(false);
    expect(await notificationCount()).toBe(0);
    expect((await listAnnouncements(deps, everyone, 50)).items).toHaveLength(0);
    expect((await listAnnouncements(deps, editors, 50)).items.map((r) => r.title)).toEqual(["Later"]);
  });

  it("still notifies everyone for an ordinary post", async () => {
    const actor = await seedActor();
    await seedActor();
    await createAnnouncement(deps, actor, { kind: "announcement", title: "Now", body: "Out it goes" });
    expect(await notificationCount()).toBeGreaterThan(0);
  });

  it("is never applied to a kudos - recognition is sent, not staged", async () => {
    const giver = await seedActor();
    const other = await seedActor();
    const kudos = await createAnnouncement(deps, giver, { kind: "kudos", recipient: `employees/${other.employeeId}`, message: "Great work", published: false });
    expect(kudos.published).toBe(true);
  });
});

describe("scheduled publishing", () => {
  it("publishes a draft whose time has come, and leaves a future one alone", async () => {
    const actor = await seedActor();
    await seedActor();
    const due = await createAnnouncement(deps, actor, { kind: "announcement", title: "Due", body: "x", published: false, publish_time: new Date(Date.now() - 60_000).toISOString() });
    const later = await createAnnouncement(deps, actor, { kind: "announcement", title: "Later", body: "y", published: false, publish_time: new Date(Date.now() + 3_600_000).toISOString() });
    const undated = await createAnnouncement(deps, actor, { kind: "announcement", title: "Undated", body: "z", published: false });

    expect(await publishDueAnnouncements(deps)).toBe(1);

    const rows = Object.fromEntries((await listAnnouncements(deps, editors, 50)).items.map((r) => [r.uuid, r]));
    expect(rows[due.uuid]!.published).toBe(true);
    expect(rows[later.uuid]!.published).toBe(false);
    expect(rows[undated.uuid]!.published).toBe(false);
    // The author's chosen time is what the post says it went out - the tick doesn't rewrite it.
    expect(+new Date(rows[due.uuid]!.publishTime!)).toBe(+new Date(due.publishTime!));
    expect(await notificationCount()).toBeGreaterThan(0);
  });

  it("announces a published draft exactly once, however many ticks run", async () => {
    const actor = await seedActor();
    await seedActor();
    await createAnnouncement(deps, actor, { kind: "announcement", title: "Due", body: "x", published: false, publish_time: new Date(Date.now() - 60_000).toISOString() });

    expect(await publishDueAnnouncements(deps)).toBe(1);
    const after = await notificationCount();
    expect(await publishDueAnnouncements(deps)).toBe(0);
    expect(await notificationCount()).toBe(after);
  });
});

// A poll's body is its DESCRIPTION and is optional; every other kind is its body. So the one field means two
// different things depending on the row it is on, and an edit has to be judged by the row rather than by the
// field - clearing a poll's description is an ordinary edit, clearing an announcement's guts the post.
describe("body on an edit", () => {
  it("lets a poll's description be cleared", async () => {
    const actor = await seedActor();
    const poll = await createAnnouncement(deps, actor, { kind: "poll", title: "Lunch?", body: "Some context", options: ["Yes", "No"] });

    const updated = await updateAnnouncement(deps, actor, poll.uuid, { body: "" });
    expect(updated.body).toBe("");
    expect(updated.bodyText).toBe("");
  });

  it("refuses to empty the body of a post that IS its body", async () => {
    const actor = await seedActor();
    const post = await createAnnouncement(deps, actor, { kind: "announcement", title: "Notice", body: "The words" });

    await expect(updateAnnouncement(deps, actor, post.uuid, { body: "" })).rejects.toThrow(/body is required/);
    await expect(updateAnnouncement(deps, actor, post.uuid, { body: "   " })).rejects.toThrow(/body is required/);
    expect((await listAnnouncements(deps, editors, 50)).items[0]!.body).toBe("The words");
  });
});

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
import {
  createAnnouncement,
  addReply,
  markAnnouncementRead,
  markAllAnnouncementsRead,
  reactionsFor,
  setPinned,
  toggleReaction,
  updateAnnouncement,
} from "../src/services/announcements";
import { setPublished } from "../src/services/lifecycle";
import { mentionedTokens, newMentions, MAX_MENTIONS } from "../src/domain/mentions";
import { richToPlain } from "../src/domain/richText";

// The board's engagement layer: pinning, catching up in one call, who is behind a reaction, and being named
// in a post. Every one of these is about what the READER of the board gets, so they are tested through the
// services the routes call rather than through the wire.
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

const TABLES = [schema.announcementReads, schema.announcementReactions, schema.announcementReplies, schema.announcements, schema.notifications, schema.auditLog, schema.eventLog, schema.settings, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

async function seedActor(first = "Poster"): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: `04-${genId().slice(0, 3)}`, firstName: first, lastName: "User", workEmail: `${employeeId}@test.example`, status: "active" });
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role: "employee", employeeId });
  return { uuid, email: `${uuid}@test.example`, role: "employee", status: "active", employeeId, employeeCode: null } as unknown as AppUser;
}

const editors = { seeRestricted: true } as never;
const everyone = { seeRestricted: false } as never;
const post = (actor: AppUser, title: string) => createAnnouncement(deps, actor, { kind: "post", title, body: `${title} body`, published: true });
const notifications = () => deps.db.select().from(schema.notifications);
const mentionRef = async (actor: AppUser) => `employees/${await deps.idCodec.encode("employees", actor.employeeId!)}`;

describe("pinning", () => {
  it("stamps and clears the pin time, and refuses to pin a draft", async () => {
    const actor = await seedActor();
    const live = await post(actor, "Live");
    const pinned = await setPinned(deps, actor, live.uuid, true);
    expect(pinned.pinnedAt).toBeTruthy();

    // Re-pinning moves it to the front of the pinned group rather than toggling it off.
    const repinned = await setPinned(deps, actor, live.uuid, true);
    expect(+new Date(repinned.pinnedAt!)).toBeGreaterThanOrEqual(+new Date(pinned.pinnedAt!));

    expect((await setPinned(deps, actor, live.uuid, false)).pinnedAt).toBeNull();

    const draft = await createAnnouncement(deps, actor, { kind: "post", title: "Later", body: "Not yet", published: false });
    await expect(setPinned(deps, actor, draft.uuid, true)).rejects.toThrow(/draft/i);
  });
});

describe("mark all read", () => {
  it("stamps a receipt on every visible post except the caller's own, and is idempotent", async () => {
    const author = await seedActor("Author");
    const reader = await seedActor("Reader");
    const a = await post(author, "One");
    const c = await post(author, "Two");
    const mine = await post(reader, "Mine");
    await createAnnouncement(deps, author, { kind: "post", title: "Draft", body: "Hidden", published: false });

    // An ordinary reader sees the two published posts that are not theirs; the draft is invisible to them.
    expect(await markAllAnnouncementsRead(deps, reader, everyone)).toEqual({ marked: 2 });
    const reads = await deps.db.select().from(schema.announcementReads);
    expect(reads.map((r) => r.announcementId).sort()).toEqual([a.uuid, c.uuid].sort());
    expect(reads.every((r) => r.employeeId === reader.employeeId)).toBe(true);
    expect(mine.uuid).not.toBe(reads[0]!.announcementId);

    // Nothing left to mark, and no duplicate rows on a second call.
    expect(await markAllAnnouncementsRead(deps, reader, everyone)).toEqual({ marked: 0 });
    expect((await deps.db.select().from(schema.announcementReads))).toHaveLength(2);
  });

  it("counts a post already read post-by-post only once, and reaches drafts for an editor", async () => {
    const author = await seedActor("Author");
    const editor = await seedActor("Editor");
    const one = await post(author, "One");
    await post(author, "Two");
    await createAnnouncement(deps, author, { kind: "post", title: "Draft", body: "Hidden", published: false });
    await markAnnouncementRead(deps, editor, one.uuid);

    // An editor sees restricted rows on the board, so catching up covers the draft they can see too.
    expect(await markAllAnnouncementsRead(deps, editor, editors)).toEqual({ marked: 2 });
    expect((await deps.db.select().from(schema.announcementReads))).toHaveLength(3);
  });
});

describe("reaction groups", () => {
  it("names who is behind each count, and marks the viewer's own", async () => {
    const author = await seedActor("Author");
    const first = await seedActor("First");
    const second = await seedActor("Second");
    const p = await post(author, "React to me");
    await toggleReaction(deps, first, p.uuid, "👍");
    await toggleReaction(deps, second, p.uuid, "👍");
    await toggleReaction(deps, second, p.uuid + "", "🎉"); // one reaction per viewer: this REPLACES the 👍

    const groups = (await reactionsFor(deps, [p.uuid], first.employeeId)).get(p.uuid)!;
    const thumbs = groups.find((g) => g.emoji === "👍")!;
    expect(thumbs.count).toBe(1);
    expect(thumbs.reacted).toBe(true);
    expect(thumbs.reactors).toEqual([first.employeeId]);
    const party = groups.find((g) => g.emoji === "🎉")!;
    expect(party.reacted).toBe(false);
    expect(party.reactors).toEqual([second.employeeId]);
  });
});

describe("mentions", () => {
  it("parses tokens, caps them, and reduces to plain text as an @name", () => {
    const tok = (n: number) => String(n).repeat(26).slice(0, 26).replace(/[^0-9a-hj-km-np-tv-z]/g, "a");
    const body = `hi [@A B](employees/${tok(1)}) and [@C D](employees/${tok(2)}) and again [@A B](employees/${tok(1)})`;
    expect(mentionedTokens(body)).toEqual([tok(1), tok(2)]);
    expect(newMentions(body, `[@A B](employees/${tok(1)})`)).toEqual([tok(2)]);
    expect(richToPlain(body)).toBe("hi @A B and @C D and again @A B");

    // An address is not a mention, and neither is a token that is not an employee ref.
    expect(mentionedTokens("mail me at user@host.example")).toEqual([]);
    expect(mentionedTokens(`[@A B](goals/${tok(1)})`)).toEqual([]);

    const many = Array.from({ length: MAX_MENTIONS + 5 }, (_, i) => `[@P${i}](employees/${tok(i % 9 + 1)}${""})`).join(" ");
    expect(mentionedTokens(many).length).toBeLessThanOrEqual(MAX_MENTIONS);
  });

  it("notifies a mentioned employee when a post is published, and never the author naming themselves", async () => {
    const author = await seedActor("Author");
    const named = await seedActor("Named");
    const body = `heads up ${await mentionRef(named).then((r) => `[@Named User](${r})`)} and me [@Author User](${await mentionRef(author)})`;
    await createAnnouncement(deps, author, { kind: "post", title: "Ping", body, published: true });

    const mentions = (await notifications()).filter((n) => n.type === "announcement.mention");
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.recipientId).toBe(named.employeeId);
  });

  it("stays silent for a draft and notifies once it is published", async () => {
    const author = await seedActor("Author");
    const named = await seedActor("Named");
    const body = `[@Named User](${await mentionRef(named)}) look at this`;
    const draft = await createAnnouncement(deps, author, { kind: "post", title: "Later", body, published: false });
    expect((await notifications()).filter((n) => n.type === "announcement.mention")).toHaveLength(0);

    await setPublished(deps, author, schema.announcements, "announcement", "announcements", draft.uuid, true);
    expect((await notifications()).filter((n) => n.type === "announcement.mention")).toHaveLength(1);
  });

  it("notifies only NEW names on an edit", async () => {
    const author = await seedActor("Author");
    const first = await seedActor("First");
    const second = await seedActor("Second");
    const firstRef = await mentionRef(first);
    const live = await createAnnouncement(deps, author, { kind: "post", title: "Ping", body: `[@First User](${firstRef}) hello`, published: true });
    expect((await notifications()).filter((n) => n.type === "announcement.mention")).toHaveLength(1);

    await updateAnnouncement(deps, author, live.uuid, { body: `[@First User](${firstRef}) and [@Second User](${await mentionRef(second)}) hello` });
    const mentions = (await notifications()).filter((n) => n.type === "announcement.mention");
    expect(mentions).toHaveLength(2); // the second person only - the first is not told twice
    expect(mentions.filter((n) => n.recipientId === first.employeeId)).toHaveLength(1);
    expect(mentions.filter((n) => n.recipientId === second.employeeId)).toHaveLength(1);
  });

  it("notifies someone named in a reply", async () => {
    const author = await seedActor("Author");
    const replier = await seedActor("Replier");
    const named = await seedActor("Named");
    const p = await post(author, "Thread");
    await addReply(deps, replier, p.uuid, `[@Named User](${await mentionRef(named)}) can you confirm?`);

    const mentions = (await notifications()).filter((n) => n.type === "announcement.mention");
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.recipientId).toBe(named.employeeId);
  });
});

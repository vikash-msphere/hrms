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
import { clampPageSize } from "../src/http/pagination";
import { PARAM_CAP } from "../src/lib/dbBatch";
import { readsFor, reactionsFor, repliesFor, pollDataFor } from "../src/services/announcements";
import { purgeExpiredAccessRules } from "../src/services/accessRules";
import { createBoard } from "../src/services/boards";
import { createCard, addCardTodos, watchersFor } from "../src/services/cards";
import { createTicket, addTodos as addTicketTodos } from "../src/services/tickets";

// D1 binds at most 100 parameters per statement (lib/dbBatch.ts PARAM_CAP). Every case below used to bind one
// parameter per ID and answer `D1_ERROR: too many SQL variables` once a real amount of data was in - the class
// of bug that cannot appear on a dev database and appears on every busy one. `searchFilterParamCap.test.ts`
// pins the same rule for the text-search filter; this covers the id-keyed reads and the multi-row inserts.
//
// A page is `clampPageSize` = 100 ids, which is the cap EXACTLY - no margin for the predicate beside it, nor
// for a scoped caller's own bound parameters. So "a full page works" is the floor here, not the target.
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

const TABLES = [
  schema.announcementReactions, schema.announcementReplies, schema.announcementReads,
  schema.announcementPollVotes, schema.announcementPollOptions, schema.announcements,
  schema.cardTodos, schema.cardWatchers, schema.cardMovements, schema.cards, schema.boards,
  schema.ticketTodos, schema.tickets, schema.settings,
  schema.accessRules, schema.auditLog, schema.eventLog, schema.notifications, schema.users, schema.employees, schema.roles,
];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

/** A real employee row - reactions, votes and read receipts all carry a foreign key to one. */
// Employee codes come from a COUNTER, not from random characters. `04-${genId().slice(0, 3)}` draws three
// base32 characters - 32,768 possibilities - and this file seeds a whole roster, so the birthday bound makes a
// duplicate `employees.code` (UNIQUE) a matter of when, not if: the suite failed roughly one run in a hundred
// on an insert that has nothing to do with what is being tested. A counter is unique by construction.
let seedSeq = 0;
const nextCode = () => `04-${(++seedSeq).toString(36).padStart(3, "0")}`;

async function seedEmployee(): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.employees).values({ uuid, code: `04-${genId().slice(0, 4)}`, firstName: "P", lastName: uuid.slice(0, 4), workEmail: `${uuid}@test.example`, status: "active" });
  return uuid;
}

async function seedActor(): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: nextCode(), firstName: "Test", lastName: "User", workEmail: `${employeeId}@test.example`, status: "active" });
  const uuid = genId();
  const email = `${uuid}@test.example`;
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email, role: "employee", employeeId });
  return { uuid, email, role: "employee", status: "active", employeeId, employeeCode: null, name: "Test User" } as unknown as AppUser;
}

describe("the board's per-page reads stay inside D1's parameter cap", () => {
  // The one that was not bounded by the page size at all: this binds a parameter per REPLY across every post
  // on the page. Twenty posts is the SPA's own FEED_PAGE_SIZE (web/src/pages/Announcements.tsx), and six
  // replies each is an ordinary thread - 120 ids, and the WHOLE board list failed, not one post.
  it("loads a page of posts whose replies far outnumber the parameter cap", async () => {
    const reactor = await seedEmployee();
    const postIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      const post = (await deps.db.insert(schema.announcements).values({ code: `A${1000 + i}`, title: `post ${i}`, body: "x" }).returning())[0]!;
      postIds.push(post.uuid);
      for (let j = 0; j < 6; j++) {
        const reply = (await deps.db.insert(schema.announcementReplies).values({ announcementId: post.uuid, authorEmail: "a@example.com", body: `r${j}` }).returning())[0]!;
        // Reply-level reactions ride the same unbounded list, one parameter each.
        await deps.db.insert(schema.announcementReactions).values({ announcementId: post.uuid, replyId: reply.uuid, employeeId: reactor, emoji: "👍" });
      }
    }
    expect((await deps.db.select().from(schema.announcementReplies)).length).toBeGreaterThan(PARAM_CAP);

    const byPost = await repliesFor(deps, postIds, null);
    expect(byPost.size).toBe(20);
    for (const id of postIds) expect(byPost.get(id)).toHaveLength(6);
    // Chunking must not lose the ordering guarantee: replies read oldest-first across the WHOLE set, not
    // within one chunk.
    for (const list of byPost.values()) {
      const times = list.map((r) => +r.createdAt);
      expect([...times].sort((x, y) => x - y)).toEqual(times);
    }
    // And each reply still carries its own grouped reactions.
    expect([...byPost.values()].flat().every((r) => ((r as { _reactions?: unknown[] })._reactions ?? []).length === 1)).toBe(true);
  });

  it("decorates a FULL page of posts - reads, reactions and poll tallies alike", async () => {
    const size = clampPageSize(1000); // 100: the largest page the server will hand out
    expect(size).toBe(PARAM_CAP); // the id list alone is the whole budget, which is the point
    const voter = await seedEmployee();
    const postIds: string[] = [];
    for (let i = 0; i < size; i++) {
      const post = (await deps.db.insert(schema.announcements).values({ code: `P${2000 + i}`, kind: "poll", title: `poll ${i}`, body: "x" }).returning())[0]!;
      postIds.push(post.uuid);
      const opt = (await deps.db.insert(schema.announcementPollOptions).values({ announcementId: post.uuid, label: "yes", position: 0 }).returning())[0]!;
      await deps.db.insert(schema.announcementPollVotes).values({ announcementId: post.uuid, optionId: opt.uuid, employeeId: voter });
      await deps.db.insert(schema.announcementReads).values({ announcementId: post.uuid, employeeId: voter });
      await deps.db.insert(schema.announcementReactions).values({ announcementId: post.uuid, employeeId: voter, emoji: "🎉" });
    }
    expect((await readsFor(deps, postIds)).size).toBe(size);
    expect((await reactionsFor(deps, postIds, null)).size).toBe(size);
    expect((await pollDataFor(deps, postIds, null)).size).toBe(size);
    // Poll options come back in position order after being read in chunks.
    const polls = await pollDataFor(deps, postIds, null);
    for (const p of polls.values()) expect(p.options.map((o) => o.votes)).toEqual([1]);
  });
});

describe("the nightly access-rule purge stays inside the parameter cap", () => {
  // How many rules lapse on one night is decided by whoever granted them, not by anything the purge controls:
  // a bulk time-boxed grant (a clone, an audit window, a project's access all dated the same day) lapses
  // together. Past a hundred the DELETE threw, so nothing was purged and no audit entry was written either -
  // and the cron only recorded a failed subtask.
  it("purges more expired rules than D1 can bind as parameters", async () => {
    const n = 120;
    const past = new Date(Date.now() - 60_000);
    for (let i = 0; i < n; i++) {
      await deps.db.insert(schema.accessRules).values({
        subject: "employee", subjectKind: "role", namespace: "goals",
        pattern: `goals.lapsed${i}.*`, scopeKind: "all", level: "read", effect: "allow", status: "active", expiresAt: past,
      });
    }
    // One that has NOT lapsed, to prove the purge is still selective after chunking.
    await deps.db.insert(schema.accessRules).values({
      subject: "employee", subjectKind: "role", namespace: "goals",
      pattern: "goals.live.*", scopeKind: "all", level: "read", effect: "allow", status: "active",
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    expect(await purgeExpiredAccessRules(deps)).toBe(n);
    const left = await deps.db.select().from(schema.accessRules);
    expect(left).toHaveLength(1);
    expect(left[0]!.pattern).toBe("goals.live.*");
    // Each lapsed rule keeps its own entry - that is the only record of who lost what.
    expect((await deps.db.select().from(schema.auditLog)).filter((e) => e.action === "access-rule.expire")).toHaveLength(n);
  });
});

describe("multi-row inserts are split, not guessed at", () => {
  // A checklist row binds six parameters (uuid, card_id, text, done, created_at, updated_at), so ONE
  // multi-row insert holds sixteen items. Applying a predefined checklist is exactly the path that arrives
  // with a long list, and it failed the whole call.
  it("adds a checklist far longer than one statement can hold", async () => {
    const actor = await seedActor();
    const board = await createBoard(deps, actor, { name: "Ops" });
    const card = await createCard(deps, actor, { board: `boards/${board.uuid}`, title: "Quarterly close", column_key: "backlog" });

    const texts = Array.from({ length: 40 }, (_, i) => `step ${i + 1}`);
    await addCardTodos(deps, actor, card.uuid, texts);

    const todos = await deps.db.select().from(schema.cardTodos);
    expect(todos).toHaveLength(40);
    expect(new Set(todos.map((t) => t.text))).toEqual(new Set(texts));
  });

  it("seeds a card's checklist at creation the same way", async () => {
    const actor = await seedActor();
    const board = await createBoard(deps, actor, { name: "Ops" });
    const texts = Array.from({ length: 30 }, (_, i) => `item ${i}`);
    await createCard(deps, actor, { board: `boards/${board.uuid}`, title: "Onboard", column_key: "backlog", initial_todos: texts });
    expect(await deps.db.select().from(schema.cardTodos)).toHaveLength(30);
  });

  // The ticket's checklist is the same table shape and the same catalogue, so it had the same defect.
  it("adds a ticket checklist longer than one statement can hold, and seeds one at creation", async () => {
    const actor = await seedActor();
    await deps.db.insert(schema.settings).values({
      key: "ticket-categories",
      value: JSON.stringify({ categories: [{ key: "it", name: "IT support", assignee: null, members: [], department: null }] }),
    });
    const seeded = Array.from({ length: 25 }, (_, i) => `seed ${i}`);
    const ticket = await createTicket(deps, actor, { category: "it", subject: "Laptop refresh", initial_todos: seeded });
    expect(await deps.db.select().from(schema.ticketTodos)).toHaveLength(25);

    await addTicketTodos(deps, actor, ticket.uuid, Array.from({ length: 40 }, (_, i) => `later ${i}`));
    expect(await deps.db.select().from(schema.ticketTodos)).toHaveLength(65);
  });

  it("reads the watchers of a full page of cards", async () => {
    const actor = await seedActor();
    const board = await createBoard(deps, actor, { name: "Big" });
    const ids: string[] = [];
    for (let i = 0; i < clampPageSize(1000); i++) {
      const card = await createCard(deps, actor, { board: `boards/${board.uuid}`, title: `c${i}`, column_key: "backlog" });
      ids.push(card.uuid);
    }
    const watchers = await watchersFor(deps, ids);
    // Whoever filed a card watches it, so every one of them has an entry.
    expect(watchers.size).toBe(ids.length);
  });
});

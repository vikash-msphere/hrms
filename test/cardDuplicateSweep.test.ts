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
import type { ListScope } from "../src/domain/access";
import { vectorIdOf } from "../src/lib/vector";
import { sweepCardDuplicates, boardDuplicates, pruneDuplicateSuggestions } from "../src/services/cardDuplicateSweep";

// The duplicate check the board runs on itself overnight.
//
// The properties worth holding: only OPEN cards are compared (a delivered lookalike is history), the sweep
// writes a suggestion and never touches a card, a pair is reported ONCE however many rows the sweep wrote
// for it, and the reader's own scope decides what they are shown - the cron could not know who would ask.

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

const BOARD = genId();
const ME = genId();
const all = (): ListScope => ({ breadth: "all", deptCode: null, ownerId: null, seeRestricted: true });

/** An index that answers every query with the same neighbours, which is what makes a pair in these tests. */
function fakeIndex(neighbours: { id: string; score: number }[], hasVector = true) {
  return {
    async upsert() { /* unused */ },
    async query() { return neighbours; },
    async fetch(ids: string[]) {
      const out = new Map<string, number[]>();
      if (hasVector) for (const id of ids) out.set(id, [0.1, 0.2]);
      return out;
    },
    async remove() { /* unused */ },
  };
}

const TABLES = [schema.aiSuggestions, schema.cards, schema.boards, schema.employees, schema.settings];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  await deps.db.insert(schema.settings).values({ key: "ai", value: JSON.stringify({ features: { "cards.triage": true } }) });
  await deps.db.insert(schema.employees).values({ uuid: ME, code: "04-001-001", firstName: "Me", lastName: "X", workEmail: "me@x.test", status: "active" });
  await deps.db.insert(schema.boards).values({ uuid: BOARD, code: "b-1", name: "Delivery", columnsJson: JSON.stringify([{ key: "todo", label: "To do" }]) });
});

let n = 0;
async function card(over: Partial<typeof schema.cards.$inferInsert> = {}) {
  const uuid = genId();
  await deps.db.insert(schema.cards).values({
    uuid, code: `c-${uuid.slice(0, 6)}`, boardId: BOARD, employeeId: ME, title: `Card ${++n}`, columnKey: "todo", ...over,
  });
  return uuid;
}
const near = (ids: string[], score = 0.95) => ids.map((id) => ({ id: vectorIdOf("cards", id), score }));

describe("the sweep", () => {
  it("records the pair as a suggestion and leaves both cards alone", async () => {
    const a = await card({ title: "Rewrite the onboarding emails" });
    const b2 = await card({ title: "Redo the welcome email sequence" });
    deps.vectors = fakeIndex(near([a, b2]));

    const out = await sweepCardDuplicates(deps);
    expect(out.scanned).toBe(2);
    expect(out.flagged).toBe(2);

    const rows = await deps.db.select().from(schema.aiSuggestions);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.state).toBe("pending");
    // Nothing on the card moved: not a label, not a column, not a delete stamp.
    const cards = await deps.db.select().from(schema.cards);
    expect(cards.every((c) => !c.deleteTime && c.columnKey === "todo")).toBe(true);
  });

  it("compares open work only", async () => {
    const open = await card();
    const delivered = await card({ deliveredAt: new Date() });
    deps.vectors = fakeIndex(near([open, delivered]));
    const out = await sweepCardDuplicates(deps);
    // The delivered card is neither swept nor offered as a lookalike: filing the same thing twice is a
    // problem exactly while both are open. So the open card is examined and found to have nothing.
    expect(out).toEqual({ scanned: 1, flagged: 0 });
    const rows = await deps.db.select().from(schema.aiSuggestions);
    expect(rows.map((r) => r.hostRecordId)).toEqual([open]);
    expect(rows[0]!.payloadJson).not.toContain(delivered);
    expect(await boardDuplicates(deps, all(), BOARD)).toEqual([]);
  });

  it("does not pair a card with a lookalike on another board", async () => {
    const other = genId();
    await deps.db.insert(schema.boards).values({ uuid: other, code: "b-2", name: "Another team", columnsJson: JSON.stringify([{ key: "backlog", label: "Backlog" }]) });
    const mine = await card();
    const theirs = await card({ boardId: other, columnKey: "backlog" });
    deps.vectors = fakeIndex(near([mine, theirs]));
    await sweepCardDuplicates(deps);
    // The index is org-wide; a backlog is not. Two teams tracking similar work on their own boards is not
    // somebody having filed the same thing twice - and the stored payload carries a COLUMN KEY, which would
    // be the other board's vocabulary rendered against this one's.
    expect(await boardDuplicates(deps, all(), BOARD)).toEqual([]);
  });

  it("clears its previous answer when a pair stops looking alike", async () => {
    const a = await card();
    const b2 = await card();
    deps.vectors = fakeIndex(near([a, b2]));
    await sweepCardDuplicates(deps);
    expect(await deps.db.select().from(schema.aiSuggestions)).toHaveLength(2);

    // The next night, nothing is close enough any more (somebody rewrote one of them).
    deps.vectors = fakeIndex(near([a, b2], 0.4));
    await sweepCardDuplicates(deps);
    // A stale warning about a pair that stopped existing is worse than none, because somebody checks it -
    // so the warning is replaced by an empty list rather than left to age.
    expect(await boardDuplicates(deps, all(), BOARD)).toEqual([]);
  });

  it("records that it looked at a card even when it found nothing", async () => {
    // WHY THIS MATTERS: `updated_at` on the suggestion row is the sweep's only record of having looked at a
    // card, and the candidate query leads with cards that have no row. Deleting the row on an empty result
    // would put that card straight back at the front of the queue, so a backlog bigger than one tick would
    // be the same cards every night while the rest were never reached.
    await card();
    await card();
    deps.vectors = fakeIndex([]); // nothing near anything
    const out = await sweepCardDuplicates(deps);
    expect(out).toEqual({ scanned: 2, flagged: 0 });
    const rows = await deps.db.select().from(schema.aiSuggestions);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.basis === 0)).toBe(true);
    // And it still shows nothing to whoever is grooming the board.
    expect(await boardDuplicates(deps, all(), BOARD)).toEqual([]);
  });

  it("reads nothing at all when the feature is off", async () => {
    await deps.db.delete(schema.settings);
    await card();
    let asked = false;
    deps.vectors = { ...fakeIndex([]), async fetch(ids: string[]) { asked = true; return new Map(ids.map((i) => [i, [0.1]])); } };
    expect(await sweepCardDuplicates(deps)).toEqual({ scanned: 0, flagged: 0 });
    expect(asked).toBe(false);
  });

  it("skips a card the embed drain has not reached", async () => {
    await card();
    deps.vectors = fakeIndex([], false);
    expect((await sweepCardDuplicates(deps)).scanned).toBe(0);
  });
});

describe("reading it back", () => {
  it("reports one line per pair, not one per row the sweep wrote", async () => {
    const a = await card();
    const b2 = await card();
    deps.vectors = fakeIndex(near([a, b2]));
    await sweepCardDuplicates(deps);
    const pairs = await boardDuplicates(deps, all(), BOARD);
    // The sweep wrote a row for each card; a groomer wants one line about one problem.
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.duplicates).toHaveLength(1);
  });

  it("drops a pair whose other half the caller may not list", async () => {
    const a = await card();
    const b2 = await card();
    deps.vectors = fakeIndex(near([a, b2]));
    await sweepCardDuplicates(deps);
    // An own-breadth caller who owns neither card: `applyScope` fails them both.
    const narrow: ListScope = { breadth: "own", deptCode: null, ownerId: "somebody-else", seeRestricted: false };
    expect(await boardDuplicates(deps, narrow, BOARD)).toEqual([]);
  });

  it("says nothing on a board that has never been swept", async () => {
    await card();
    expect(await boardDuplicates(deps, all(), BOARD)).toEqual([]);
  });
});

describe("hygiene", () => {
  it("clears answers about cards that have since been delivered", async () => {
    const a = await card();
    const b2 = await card();
    deps.vectors = fakeIndex(near([a, b2]));
    await sweepCardDuplicates(deps);
    await deps.db.update(schema.cards).set({ deliveredAt: new Date() });
    expect(await pruneDuplicateSuggestions(deps)).toBe(2);
    expect(await deps.db.select().from(schema.aiSuggestions)).toEqual([]);
  });
});

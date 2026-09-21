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
import { cardFlow } from "../src/domain/cardFlow";
import { cardFlowFor } from "../src/services/cardFlow";

// How long work like this card has taken on this board.
//
// The properties worth holding: an UNFINISHED stay is not a sample (counting it makes a board look faster as
// it gets slower), a size band that is too thin falls back to the whole column rather than answering from
// three cards, and the corpus is the caller's own list scope so a denied card cannot move a percentile.

const DAY = 86_400_000;
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

describe("the arithmetic", () => {
  const T0 = Date.parse("2026-01-01T00:00:00Z");
  const NOW = T0 + 40 * DAY;

  /** A card that entered `review` on day `d` and left it `stay` days later. */
  const stayed = (id: string, d: number, stay: number) => [
    { cardId: id, toColumn: "review", at: T0 + d * DAY },
    { cardId: id, toColumn: "done", at: T0 + (d + stay) * DAY },
  ];

  it("reads a card's age against what left the column before it", () => {
    const moves = [...stayed("a", 0, 2), ...stayed("b", 1, 3), ...stayed("c", 2, 4), ...stayed("d", 3, 1), ...stayed("e", 4, 10)];
    const corpus = ["a", "b", "c", "d", "e"].map((uuid) => ({ uuid, columnKey: "done", size: null, deliveredAt: null }));
    const out = cardFlow(
      { uuid: "mine", columnKey: "review", size: null, columnSince: NOW - 5 * DAY, deliveredAt: null },
      [...corpus, { uuid: "mine", columnKey: "review", size: null, deliveredAt: null }],
      moves,
      NOW,
    );
    expect(out.days_here).toBe(5);
    expect(out.dwell).toMatchObject({ count: 5, basis: "column" });
    // Four of the five cleared review in five days or less, so this one is slower than 80% of them.
    expect(out.slower_than).toBe(80);
  });

  it("does not count a stay that has not ended", () => {
    // One card left after 2 days; two others are still sitting there. Only the finished stay is a sample.
    const moves = [
      ...stayed("a", 0, 2),
      { cardId: "b", toColumn: "review", at: T0 },
      { cardId: "c", toColumn: "review", at: T0 },
    ];
    const corpus = ["a", "b", "c"].map((uuid) => ({ uuid, columnKey: "review", size: null, deliveredAt: null }));
    const out = cardFlow({ uuid: "mine", columnKey: "review", size: null, columnSince: NOW, deliveredAt: null }, corpus, moves, NOW);
    expect(out.dwell!.count).toBe(1);
  });

  it("falls back to the whole column when the size band is too thin", () => {
    const moves = [...stayed("a", 0, 2), ...stayed("b", 1, 3), ...stayed("c", 2, 4), ...stayed("d", 3, 1), ...stayed("e", 4, 10), ...stayed("f", 5, 6)];
    const corpus = [
      { uuid: "a", columnKey: "done", size: 8, deliveredAt: null },
      ...["b", "c", "d", "e", "f"].map((uuid) => ({ uuid, columnKey: "done", size: 1, deliveredAt: null })),
    ];
    // Size 8 has exactly one comparable card, which is not a distribution.
    const thin = cardFlow({ uuid: "mine", columnKey: "review", size: 8, columnSince: NOW, deliveredAt: null }, corpus, moves, NOW);
    expect(thin.dwell!.basis).toBe("column");
    expect(thin.dwell!.count).toBe(6);
    // Size 1 has five, which is the floor.
    const thick = cardFlow({ uuid: "mine", columnKey: "review", size: 1, columnSince: NOW, deliveredAt: null }, corpus, moves, NOW);
    expect(thick.dwell!.basis).toBe("size");
    expect(thick.dwell!.count).toBe(5);
  });

  it("forecasts from entering this column to delivery, taking the LAST entry", () => {
    const moves = [
      { cardId: "a", toColumn: "review", at: T0 },
      // Bounced back and re-entered: the remaining distance is measured from the second entry.
      { cardId: "a", toColumn: "doing", at: T0 + 1 * DAY },
      { cardId: "a", toColumn: "review", at: T0 + 6 * DAY },
    ];
    const corpus = [{ uuid: "a", columnKey: "done", size: null, deliveredAt: T0 + 8 * DAY }];
    const out = cardFlow({ uuid: "mine", columnKey: "review", size: null, columnSince: NOW, deliveredAt: null }, corpus, moves, NOW);
    expect(out.to_delivery).toMatchObject({ p50: 2, count: 1 });
  });

  it("gives a delivered card no percentile either", () => {
    const moves = [...stayed("a", 0, 2), ...stayed("b", 1, 3), ...stayed("c", 2, 4)];
    const corpus = ["a", "b", "c"].map((uuid) => ({ uuid, columnKey: "done", size: null, deliveredAt: null }));
    const out = cardFlow(
      { uuid: "mine", columnKey: "review", size: null, columnSince: NOW - 9 * DAY, deliveredAt: NOW },
      corpus,
      moves,
      NOW,
    );
    // Its "age" is time since it landed in done, so a rank drawn from it would read as "longer than 100% of
    // comparable work" about a card that is finished - with no age beside it to check the claim against.
    expect(out.slower_than).toBeUndefined();
  });

  it("says nothing about the age of a card that is already delivered", () => {
    const moves = [...stayed("a", 0, 2)];
    const corpus = [{ uuid: "a", columnKey: "done", size: null, deliveredAt: T0 + 2 * DAY }];
    const out = cardFlow({ uuid: "mine", columnKey: "review", size: null, columnSince: NOW - 9 * DAY, deliveredAt: NOW }, corpus, moves, NOW);
    expect(out.days_here).toBeNull();
  });
});

describe("the read", () => {
  const ALL: ListScope = { breadth: "all", deptCode: null, ownerId: null, seeRestricted: true };
  const BOARD = genId();
  const ME = genId();
  const TABLES = [schema.cardMovements, schema.cards, schema.boards, schema.employees];

  beforeEach(async () => {
    for (const t of TABLES) await deps.db.delete(t);
    await deps.db.insert(schema.employees).values({ uuid: ME, code: "04-001-001", firstName: "Me", lastName: "X", workEmail: "me@x.test", status: "active" });
    await deps.db.insert(schema.boards).values({ uuid: BOARD, code: "b-1", name: "Delivery", columnsJson: JSON.stringify([{ key: "review", label: "Review" }]) });
  });

  let n = 0;
  async function card(over: Partial<typeof schema.cards.$inferInsert> = {}) {
    const uuid = genId();
    await deps.db.insert(schema.cards).values({
      uuid, code: `c-${uuid.slice(0, 6)}`, boardId: BOARD, employeeId: ME, title: `Card ${++n}`, columnKey: "review", ...over,
    });
    return uuid;
  }
  async function moved(cardId: string, column: string, at: number) {
    await deps.db.insert(schema.cardMovements).values({ uuid: genId(), cardId, boardId: BOARD, toColumn: column, at: new Date(at) });
  }

  it("answers from the board's own movement log", async () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      const c = await card({ columnKey: "done" });
      await moved(c, "review", now - 20 * DAY);
      await moved(c, "done", now - 18 * DAY);
    }
    const mine = await card({ columnSince: new Date(now - 6 * DAY) });
    const out = await cardFlowFor(deps, ALL, mine);
    expect(out!.dwell!.count).toBe(3);
    expect(out!.days_here).toBe(6);
    expect(out!.slower_than).toBe(100);
  });

  it("is nothing at all on a board with no history", async () => {
    const mine = await card({ columnSince: new Date() });
    expect(await cardFlowFor(deps, ALL, mine)).toBeNull();
  });

  it("counts only the cards the caller could have listed", async () => {
    const now = Date.now();
    const other = await card({ columnKey: "done", code: "09-999-999", employeeId: ME });
    await moved(other, "review", now - 20 * DAY);
    await moved(other, "done", now - 18 * DAY);
    const mine = await card({ columnSince: new Date(now - 1 * DAY) });
    // An own-breadth caller who owns neither card: the corpus is empty, so there is nothing to answer with.
    const narrow: ListScope = { breadth: "own", deptCode: null, ownerId: "somebody-else", seeRestricted: false };
    expect(await cardFlowFor(deps, narrow, mine)).toBeNull();
  });
});

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
import { suggestCardTriage, suggestGoalForCard, suggestStepsForCard } from "../src/services/cardTriage";

// What comparable finished work says about a card, and whether it is already on the board twice.
//
// The three properties worth the tests: only DELIVERED cards vote (an open card's filing is a guess), only
// OPEN cards can be duplicates (a delivered lookalike is history), and every neighbour is re-checked against
// the caller's own list scope so the panel can never cite a card they could not have listed.

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
const DEPT_A = genId();
const DEPT_B = genId();
const ME = genId();

/** An index that answers with whatever the test put in it, so the neighbours are the test's choice. */
function fakeIndex(neighbours: { id: string; score: number }[], selfVector: number[] | null = [0.1, 0.2]) {
  return {
    async upsert() { /* unused */ },
    async query() { return neighbours; },
    async fetch(ids: string[]) {
      const out = new Map<string, number[]>();
      if (selfVector) for (const id of ids) out.set(id, selfVector);
      return out;
    },
    async remove() { /* unused */ },
  };
}

const TABLES = [schema.eventLog, schema.cardTodos, schema.goals, schema.cards, schema.boards, schema.departments, schema.employees, schema.settings];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  await deps.db.insert(schema.settings).values({ key: "ai", value: JSON.stringify({ features: { "cards.triage": true } }) });
  await deps.db.insert(schema.employees).values({ uuid: ME, code: "04-001-001", firstName: "Me", lastName: "X", workEmail: "me@x.test", status: "active" });
  await deps.db.insert(schema.departments).values([
    { uuid: DEPT_A, code: "04", name: "Engineering" },
    { uuid: DEPT_B, code: "02", name: "Product" },
  ]);
  await deps.db.insert(schema.boards).values({ uuid: BOARD, code: "b-1", name: "Delivery", columnsJson: JSON.stringify([{ key: "todo", label: "To do" }]) });
});

let seq = 0;
async function card(over: Partial<typeof schema.cards.$inferInsert> = {}) {
  const uuid = genId();
  await deps.db.insert(schema.cards).values({
    uuid, code: `c-${uuid.slice(0, 6)}`, boardId: BOARD, employeeId: ME, title: `Card ${++seq}`,
    columnKey: "todo", priority: "medium", ...over,
  });
  return uuid;
}

const all = (): ListScope => ({ breadth: "all", deptCode: null, ownerId: null, seeRestricted: true });
const near = (ids: string[], score = 0.9) => ids.map((id) => ({ id: vectorIdOf("cards", id), score }));
const nearGoals = (ids: string[], score = 0.9) => ids.map((id) => ({ id: vectorIdOf("goals", id), score }));

async function goal(over: Partial<typeof schema.goals.$inferInsert> = {}) {
  const uuid = genId();
  await deps.db.insert(schema.goals).values({ uuid, code: `g-${uuid.slice(0, 6)}`, employeeId: ME, title: "Cut onboarding time", ...over });
  return uuid;
}

describe("what finished work says about this card", () => {
  it("votes department, priority and size from DELIVERED neighbours only", async () => {
    const subject = await card();
    // Three delivered cards agree on Engineering / high / 3. One OPEN card says Product - and must not vote,
    // because its filing is a guess nobody has tested.
    const delivered = [];
    for (let i = 0; i < 3; i++) {
      delivered.push(await card({ departmentId: DEPT_A, priority: "high", size: 3, deliveredAt: new Date() }));
    }
    const open = await card({ departmentId: DEPT_B, priority: "low", size: 13 });

    deps.vectors = fakeIndex(near([...delivered, open, subject]));
    const out = await suggestCardTriage(deps, all(), subject);

    expect(out?.department?.value).toBe(DEPT_A);
    expect(out?.priority?.value).toBe("high");
    expect(out?.size?.value).toBe("3");
    // The evidence is cited so a person can check it rather than trust it, and the open card is not in it.
    expect(out?.basis).toHaveLength(3);
    expect(out?.basis.map((x) => x.path)).not.toContain(`cards/${open}`);
  });

  it("says nothing on a tie rather than breaking it", async () => {
    const subject = await card();
    const a = await card({ departmentId: DEPT_A, deliveredAt: new Date() });
    const b2 = await card({ departmentId: DEPT_B, deliveredAt: new Date() });
    const c = await card({ departmentId: DEPT_A, deliveredAt: new Date() });
    const d = await card({ departmentId: DEPT_B, deliveredAt: new Date() });
    deps.vectors = fakeIndex(near([a, b2, c, d, subject]));
    // Two each on DEPARTMENT. "The first one alphabetically" would be shown to a person with the same
    // confidence as a real answer, so the honest output for that field is nothing.
    const out = await suggestCardTriage(deps, all(), subject);
    expect(out?.department).toBeNull();
    // The panel still appears, because priority is NOT tied here - all four cards carry the default. That is
    // the right behaviour and worth pinning: a tie silences one field, not the whole suggestion.
    expect(out?.priority?.value).toBe("medium");
  });
});

describe("what the same neighbours also say", () => {
  const DAY = 86_400_000;

  it("reports how long comparable work took, start to delivery", async () => {
    const subject = await card();
    const now = Date.now();
    const ids = [];
    for (const days of [2, 4, 6]) {
      ids.push(await card({ startedAt: new Date(now - days * DAY), deliveredAt: new Date(now), departmentId: DEPT_A }));
    }
    deps.vectors = fakeIndex(near([...ids, subject]));
    const out = await suggestCardTriage(deps, all(), subject);
    expect(out?.took).toMatchObject({ p50: 4, p85: 6, count: 3 });
  });

  it("falls back to when the card was filed, on a board that stamps neither start nor commitment", async () => {
    const subject = await card();
    const old = await card({ createdAt: new Date(Date.now() - 10 * DAY), deliveredAt: new Date() });
    deps.vectors = fakeIndex(near([old, subject]));
    const out = await suggestCardTriage(deps, all(), subject);
    // "We have no idea" is the answer this replaces, so a board with no commitment point still gets a number.
    expect(out?.took?.count).toBe(1);
    expect(out?.took?.p50).toBeGreaterThanOrEqual(9.9);
  });

  it("reads what blocked them from the event log, not from the card row", async () => {
    const subject = await card();
    const a = await card({ deliveredAt: new Date(), departmentId: DEPT_A });
    const b2 = await card({ deliveredAt: new Date(), departmentId: DEPT_A });
    // Both were blocked and then unblocked, which CLEARS `block_reason` on the row - the card table cannot
    // answer this question afterwards at all.
    for (const [id, reason] of [[a, "waiting on vendor access"], [b2, "waiting on vendor access"]] as const) {
      await deps.db.insert(schema.eventLog).values({
        uuid: genId(), code: `e-${genId().slice(0, 6)}`, type: "card.blocked", subject: `cards/${id}`,
        payloadJson: JSON.stringify({ reason }),
      });
    }
    deps.vectors = fakeIndex(near([a, b2, subject]));
    const out = await suggestCardTriage(deps, all(), subject);
    expect(out?.blocked).toMatchObject({ cards: 2, of: 2, reasons: ["waiting on vendor access"] });
  });

  it("says nothing about blocking when nothing was blocked", async () => {
    const subject = await card();
    const a = await card({ deliveredAt: new Date() });
    deps.vectors = fakeIndex(near([a, subject]));
    expect((await suggestCardTriage(deps, all(), subject))?.blocked).toBeUndefined();
  });
});

describe("the goal a card is serving", () => {
  it("offers live goals the card reads like, best first", async () => {
    const subject = await card();
    const g = await goal();
    deps.vectors = fakeIndex(nearGoals([g], 0.9));
    const out = await suggestGoalForCard(deps, all(), subject);
    expect(out.map((x) => x.path)).toEqual([`goals/${g}`]);
    expect(out[0]!.owner).toBe("Me X");
  });

  it("says nothing about a card that already names a goal", async () => {
    const g = await goal();
    const subject = await card({ goalId: g });
    let asked = false;
    deps.vectors = { ...fakeIndex(nearGoals([g])), async query() { asked = true; return nearGoals([g]); } };
    expect(await suggestGoalForCard(deps, all(), subject)).toEqual([]);
    // That decision was made by a person, so the index is not even asked.
    expect(asked).toBe(false);
  });

  it("never offers a finished goal", async () => {
    const subject = await card();
    const done = await goal({ status: "completed" });
    deps.vectors = fakeIndex(nearGoals([done], 0.95));
    expect(await suggestGoalForCard(deps, all(), subject)).toEqual([]);
  });

  it("names no goal the caller could not have listed", async () => {
    const subject = await card();
    const g = await goal();
    deps.vectors = fakeIndex(nearGoals([g], 0.95));
    expect(await suggestGoalForCard(deps, undefined, subject)).toEqual([]);
  });
});

describe("the steps comparable work took", () => {
  async function todos(cardId: string, texts: string[]) {
    for (const text of texts) await deps.db.insert(schema.cardTodos).values({ uuid: genId(), cardId, text });
  }

  it("offers what several delivered cards wrote down, commonest first", async () => {
    const subject = await card();
    const a = await card({ deliveredAt: new Date() });
    const b2 = await card({ deliveredAt: new Date() });
    const c = await card({ deliveredAt: new Date() });
    await todos(a, ["Raise a change request", "Update the runbook"]);
    await todos(b2, ["Raise a change request", "Tell the on-call"]);
    await todos(c, ["Raise a change request"]);
    deps.vectors = fakeIndex(near([a, b2, c, subject], 0.9));
    const out = await suggestStepsForCard(deps, all(), subject);
    // Three cards wrote the change request; one wrote each of the others, which is an anecdote.
    expect(out).toEqual([{ text: "Raise a change request", seen: 3, of: 3 }]);
  });

  it("counts a step once per card, however often that card repeated it", async () => {
    const subject = await card();
    const a = await card({ deliveredAt: new Date() });
    const b2 = await card({ deliveredAt: new Date() });
    const c = await card({ deliveredAt: new Date() });
    await todos(a, ["Deploy", "Deploy", "Deploy"]);
    await todos(b2, ["Deploy"]);
    await todos(c, ["Something else"]);
    deps.vectors = fakeIndex(near([a, b2, c, subject], 0.9));
    // Three comparable cards were read; two of them wrote "Deploy", and a's three copies count once.
    expect((await suggestStepsForCard(deps, all(), subject))[0]).toEqual({ text: "Deploy", seen: 2, of: 3 });
  });

  it("reads checklists off DELIVERED work only", async () => {
    const subject = await card();
    const openOne = await card();
    const openTwo = await card();
    await todos(openOne, ["A plan, not a record"]);
    await todos(openTwo, ["A plan, not a record"]);
    deps.vectors = fakeIndex(near([openOne, openTwo, subject], 0.9));
    expect(await suggestStepsForCard(deps, all(), subject)).toEqual([]);
  });

  it("says nothing on a board with too little comparable history", async () => {
    const subject = await card();
    const a = await card({ deliveredAt: new Date() });
    const b2 = await card({ deliveredAt: new Date() });
    await todos(a, ["Something"]);
    await todos(b2, ["Something"]);
    deps.vectors = fakeIndex(near([a, b2, subject], 0.9));
    // Two neighbours is an anecdote, which is what MIN_NEIGHBOURS says and now what it does; the
    // `task-checklist` draft kind is the fallback for this case.
    expect(await suggestStepsForCard(deps, all(), subject)).toEqual([]);
  });

  it("reads nothing from cards the caller could not have listed", async () => {
    const subject = await card();
    const a = await card({ deliveredAt: new Date() });
    const b2 = await card({ deliveredAt: new Date() });
    const c = await card({ deliveredAt: new Date() });
    await todos(a, ["Step"]);
    await todos(b2, ["Step"]);
    await todos(c, ["Step"]);
    deps.vectors = fakeIndex(near([a, b2, c, subject], 0.9));
    expect(await suggestStepsForCard(deps, undefined, subject)).toEqual([]);
  });
});

describe("duplicates", () => {
  it("flags an OPEN lookalike and never a delivered one", async () => {
    const subject = await card();
    const openTwin = await card({ columnKey: "todo" });
    const doneTwin = await card({ deliveredAt: new Date() });
    // Both score above the floor. Only the open one is somebody about to do the same work twice; the
    // delivered one is history, and usually the reason this card exists.
    deps.vectors = fakeIndex(near([openTwin, doneTwin, subject], 0.95));
    const out = await suggestCardTriage(deps, all(), subject);
    expect(out?.duplicates.map((d) => d.path)).toEqual([`cards/${openTwin}`]);
  });

  it("ignores a lookalike that is not alike enough", async () => {
    const subject = await card();
    const vague = await card();
    // Below the floor. A false duplicate sends somebody to read a card that has nothing to do with theirs,
    // and two of those teach people to ignore the panel.
    deps.vectors = fakeIndex(near([vague, subject], 0.5));
    expect(await suggestCardTriage(deps, all(), subject)).toBeNull();
  });
});

describe("what the caller may not see", () => {
  it("cites nothing when the scope is absent, however close the neighbours", async () => {
    const subject = await card();
    const twin = await card({ departmentId: DEPT_A, priority: "high", size: 3, deliveredAt: new Date() });
    deps.vectors = fakeIndex(near([twin, subject], 0.95));
    // `applyScope` fails closed for an absent scope, and this panel must inherit that rather than quietly
    // reading the table - it answers with cards OTHER than the one named, which is the whole reason the verb
    // is registered in SCOPE_READING_VERBS.
    expect(await suggestCardTriage(deps, undefined, subject)).toBeNull();
  });
});

describe("the switch and the index", () => {
  it("reads nothing at all when the feature is off", async () => {
    await deps.db.delete(schema.settings);
    const subject = await card();
    let asked = false;
    deps.vectors = { ...fakeIndex([]), async fetch(ids: string[]) { asked = true; return new Map<string, number[]>(ids.map((i) => [i, [0.1]])); } };
    expect(await suggestCardTriage(deps, all(), subject)).toBeNull();
    // Off must COST nothing, not merely produce nothing: the switch is checked before the index is touched.
    expect(asked).toBe(false);
  });

  it("is absent, not broken, for a card the drain has not reached", async () => {
    const subject = await card();
    deps.vectors = fakeIndex([], null); // no vector for this card yet
    expect(await suggestCardTriage(deps, all(), subject)).toBeNull();
  });

  it("is absent when there is no index bound at all", async () => {
    const subject = await card();
    deps.vectors = undefined;
    expect(await suggestCardTriage(deps, all(), subject)).toBeNull();
  });
});

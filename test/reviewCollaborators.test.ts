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
import { collaboratorsFor } from "../src/services/reviewCollaborators";
import { rankCollaborators } from "../src/domain/reviewCollaborators";

// Who saw this person's work, so a 360 asks them rather than whoever the manager remembers.
//
// The properties worth holding: a card with both names on it outranks sharing a board, a leaver is never
// offered, and a collection the caller may not list contributes nothing instead of refusing the request.

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

const ALL: ListScope = { breadth: "all", deptCode: null, ownerId: null, seeRestricted: true };
const BOARD = genId();
const CYCLE = genId();
const SUBJECT = genId();
const PAIR = genId();     // worked the same cards
const NEARBY = genId();   // same board, different cards
const GONE = genId();     // worked with them and has since left
const CYCLE_START = Date.parse("2026-01-01T00:00:00Z");
const CYCLE_END = Date.parse("2026-03-31T00:00:00Z");
const IN_WINDOW = new Date(Date.parse("2026-02-10T09:00:00Z"));
const REVIEW = { uuid: genId(), employeeId: SUBJECT, cycleId: CYCLE, createdAt: IN_WINDOW };

const everything = () => new Map<string, ListScope>([["goals", ALL], ["cards", ALL], ["announcements", ALL]]);
const TABLES = [schema.goalContributors, schema.goals, schema.cards, schema.boards, schema.announcements, schema.reviewCycles, schema.employees];

beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  await deps.db.insert(schema.employees).values([
    { uuid: SUBJECT, code: "04-001-001", firstName: "Sam", lastName: "Subject", workEmail: "sam@x.test", status: "active" },
    { uuid: PAIR, code: "04-001-002", firstName: "Pat", lastName: "Pair", workEmail: "pat@x.test", status: "active" },
    { uuid: NEARBY, code: "04-001-003", firstName: "Nia", lastName: "Nearby", workEmail: "nia@x.test", status: "active" },
    { uuid: GONE, code: "04-001-004", firstName: "Gia", lastName: "Gone", workEmail: "gia@x.test", status: "terminated" },
  ]);
  await deps.db.insert(schema.reviewCycles).values({ uuid: CYCLE, code: "rc-1", name: "Q1", state: "ACTIVE", periodStart: new Date(CYCLE_START), periodEnd: new Date(CYCLE_END) });
  await deps.db.insert(schema.boards).values({ uuid: BOARD, code: "b-1", name: "Delivery", columnsJson: JSON.stringify([{ key: "todo", label: "To do" }]) });
});

let n = 0;
async function card(over: Partial<typeof schema.cards.$inferInsert> = {}) {
  const uuid = genId();
  await deps.db.insert(schema.cards).values({
    uuid, code: `c-${uuid.slice(0, 6)}`, boardId: BOARD, employeeId: SUBJECT, title: `Card ${++n}`,
    columnKey: "todo", createdAt: IN_WINDOW, ...over,
  });
  return uuid;
}

describe("who worked with them", () => {
  it("puts a shared task above a shared board", async () => {
    await card({ employeeId: SUBJECT, assigneeId: PAIR });
    await card({ employeeId: SUBJECT, assigneeId: PAIR });
    await card({ employeeId: NEARBY, assigneeId: NEARBY }); // same board, nothing in common
    const out = await collaboratorsFor(deps, everything(), REVIEW);
    expect(out.map((c) => c.employee)).toEqual([`employees/${PAIR}`, `employees/${NEARBY}`]);
    expect(out[0]!.reasons[0]).toMatchObject({ kind: "same_task", count: 2 });
    expect(out[1]!.reasons[0]!.kind).toBe("same_board");
  });

  it("counts one card once, however many roles somebody holds on it", async () => {
    await card({ employeeId: PAIR, assigneeId: PAIR, reporterId: SUBJECT });
    const out = await collaboratorsFor(deps, everything(), REVIEW);
    expect(out[0]!.reasons.find((r) => r.kind === "same_task")!.count).toBe(1);
  });

  it("finds a shared goal in either direction", async () => {
    const mine = genId();
    const theirs = genId();
    await deps.db.insert(schema.goals).values([
      { uuid: mine, code: "g-1", employeeId: SUBJECT, title: "Mine", createdAt: IN_WINDOW },
      { uuid: theirs, code: "g-2", employeeId: PAIR, title: "Theirs", createdAt: IN_WINDOW },
    ]);
    await deps.db.insert(schema.goalContributors).values([
      { uuid: genId(), goalId: mine, employeeId: PAIR, share: 20, createdAt: IN_WINDOW },
      { uuid: genId(), goalId: theirs, employeeId: SUBJECT, share: 30, createdAt: IN_WINDOW },
    ]);
    const out = await collaboratorsFor(deps, everything(), REVIEW);
    expect(out[0]!.reasons.find((r) => r.kind === "shared_goal")!.count).toBe(2);
  });

  it("counts kudos written in either direction", async () => {
    await deps.db.insert(schema.announcements).values([
      { uuid: genId(), code: "a-1", kind: "kudos", title: "", body: "thanks", authorEmployeeId: PAIR, recipientEmployeeId: SUBJECT, createdAt: IN_WINDOW },
      { uuid: genId(), code: "a-2", kind: "kudos", title: "", body: "great work", authorEmployeeId: SUBJECT, recipientEmployeeId: PAIR, createdAt: IN_WINDOW },
    ]);
    const out = await collaboratorsFor(deps, everything(), REVIEW);
    expect(out[0]!.reasons.find((r) => r.kind === "kudos")!.count).toBe(2);
  });

  it("never offers somebody who has left", async () => {
    await card({ employeeId: SUBJECT, assigneeId: GONE });
    expect(await collaboratorsFor(deps, everything(), REVIEW)).toEqual([]);
  });

  it("keeps to the cycle's window", async () => {
    await card({ employeeId: SUBJECT, assigneeId: PAIR, createdAt: new Date(Date.parse("2025-08-01T00:00:00Z")) });
    expect(await collaboratorsFor(deps, everything(), REVIEW)).toEqual([]);
  });

  it("loses a signal the caller may not list, not the whole answer", async () => {
    await card({ employeeId: SUBJECT, assigneeId: PAIR });
    await deps.db.insert(schema.announcements).values({ uuid: genId(), code: "a-1", kind: "kudos", title: "", body: "thanks", authorEmployeeId: NEARBY, recipientEmployeeId: SUBJECT, createdAt: IN_WINDOW });
    const noWall = new Map<string, ListScope>([["cards", ALL], ["goals", ALL]]);
    const out = await collaboratorsFor(deps, noWall, REVIEW);
    expect(out.map((c) => c.employee)).toEqual([`employees/${PAIR}`]);
  });
});

describe("the ranking", () => {
  it("orders by the weight of the evidence and breaks ties by name", () => {
    const out = rankCollaborators(
      new Map([
        ["a", [{ kind: "same_board" as const, detail: "", count: 1 }]],
        ["b", [{ kind: "same_task" as const, detail: "", count: 1 }]],
        ["c", [{ kind: "same_board" as const, detail: "", count: 1 }]],
      ]),
      new Map([["a", "Zoe"], ["b", "Bo"], ["c", "Ada"]]),
    );
    expect(out.map((c) => c.name)).toEqual(["Bo", "Ada", "Zoe"]);
  });
});

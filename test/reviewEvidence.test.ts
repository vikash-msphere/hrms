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
import { reviewEvidenceFor } from "../src/services/reviewEvidence";
import { evidenceWindow } from "../src/domain/reviewEvidence";

// What the person did in the cycle, gathered from four collections.
//
// The properties worth holding: the cycle's period BOUNDS it (a pack about one quarter that quotes last
// year's kudos is worse than no pack), a collection the caller may not list contributes nothing rather than
// refusing, and the private halves of a 1:1 are never in the answer whatever scope the caller holds.

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
const GIVER = genId();
const OTHER = genId();

const CYCLE_START = Date.parse("2026-01-01T00:00:00Z");
const CYCLE_END = Date.parse("2026-03-31T00:00:00Z");
const IN_WINDOW = Date.parse("2026-02-10T09:00:00Z");
const BEFORE_WINDOW = Date.parse("2025-11-10T09:00:00Z");

const REVIEW = { uuid: genId(), employeeId: SUBJECT, cycleId: CYCLE, createdAt: new Date(IN_WINDOW) };

/** Every collection an evidence pack reads, at full breadth: the default the tests narrow from. */
const everything = () => new Map<string, ListScope>([
  ["goals", ALL],
  ["cards", ALL],
  ["announcements", ALL],
  ["check-ins", ALL],
]);

const TABLES = [
  schema.goalContributors, schema.goals, schema.cards, schema.boards, schema.announcements,
  schema.checkIns, schema.reviewCycles, schema.employees, schema.departments,
];

beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  await deps.db.insert(schema.employees).values([
    { uuid: SUBJECT, code: "04-001-001", firstName: "Sam", lastName: "Reviewee", workEmail: "sam@x.test", status: "active" },
    { uuid: GIVER, code: "04-001-002", firstName: "Ravi", lastName: "Giver", workEmail: "ravi@x.test", status: "active" },
    { uuid: OTHER, code: "04-001-003", firstName: "Ola", lastName: "Owner", workEmail: "ola@x.test", status: "active" },
  ]);
  await deps.db.insert(schema.reviewCycles).values({
    uuid: CYCLE, code: "rc-1", name: "Q1", state: "ACTIVE",
    periodStart: new Date(CYCLE_START), periodEnd: new Date(CYCLE_END),
  });
  await deps.db.insert(schema.boards).values({ uuid: BOARD, code: "b-1", name: "Delivery", columnsJson: JSON.stringify([{ key: "done", label: "Done" }]) });
});

let seq = 0;
async function card(over: Partial<typeof schema.cards.$inferInsert> = {}) {
  const uuid = genId();
  await deps.db.insert(schema.cards).values({
    uuid, code: `c-${uuid.slice(0, 6)}`, boardId: BOARD, employeeId: SUBJECT, title: `Card ${++seq}`,
    columnKey: "done", keyPrefix: "MS", seq: seq, deliveredAt: new Date(IN_WINDOW), ...over,
  });
  return uuid;
}

async function kudos(over: Partial<typeof schema.announcements.$inferInsert> = {}) {
  const uuid = genId();
  await deps.db.insert(schema.announcements).values({
    uuid, code: `a-${uuid.slice(0, 6)}`, kind: "kudos", title: "", body: "Carried the migration weekend",
    authorEmployeeId: GIVER, recipientEmployeeId: SUBJECT, createdAt: new Date(IN_WINDOW), ...over,
  });
  return uuid;
}

async function goal(over: Partial<typeof schema.goals.$inferInsert> = {}) {
  const uuid = genId();
  await deps.db.insert(schema.goals).values({
    uuid, code: `g-${uuid.slice(0, 6)}`, employeeId: OTHER, title: "Ship the new onboarding", progress: 40, ...over,
  });
  return uuid;
}

describe("review evidence pack", () => {
  it("gathers delivered cards, kudos, contributions and 1:1 notes", async () => {
    const g = await goal({ cycleId: CYCLE });
    await deps.db.insert(schema.goalContributors).values({ uuid: genId(), goalId: g, employeeId: SUBJECT, share: 30, note: "ran the pilot" });
    const c = await card({ goalId: g, size: 3 });
    await kudos();
    await deps.db.insert(schema.checkIns).values({
      uuid: genId(), code: "ci-1", employeeId: SUBJECT, counterpartId: OTHER, notes: "agreed to take the migration",
      employeeNote: "private, mine", counterpartNote: "private, theirs", createdAt: new Date(IN_WINDOW),
    });

    const out = await reviewEvidenceFor(deps, everything(), REVIEW);
    expect(out.window).toEqual({ start: "2026-01-01", end: "2026-03-31" });
    expect(out.cards.map((x) => x.path)).toEqual([`cards/${c}`]);
    expect(out.cards[0]!.key).toBe("MS-1");
    expect(out.cards[0]!.goal).toEqual({ path: `goals/${g}`, title: "Ship the new onboarding" });
    expect(out.kudos[0]!.from).toBe("Ravi Giver");
    expect(out.contributions[0]).toMatchObject({ path: `goals/${g}`, share: 30, note: "ran the pilot" });
    expect(out.check_ins[0]!.notes).toBe("agreed to take the migration");
    expect(out.truncated).toBe(false);
  });

  it("never reads either private half of a 1:1", async () => {
    await deps.db.insert(schema.checkIns).values({
      uuid: genId(), code: "ci-1", employeeId: SUBJECT, counterpartId: OTHER, notes: "shared",
      employeeNote: "SECRET-EMPLOYEE", counterpartNote: "SECRET-COUNTERPART", createdAt: new Date(IN_WINDOW),
    });
    const out = await reviewEvidenceFor(deps, everything(), REVIEW);
    // The columns are not selected at all, so this holds the whole answer rather than one field of it.
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });

  it("keeps to the cycle's window", async () => {
    await card({ deliveredAt: new Date(BEFORE_WINDOW) });
    await kudos({ createdAt: new Date(BEFORE_WINDOW) });
    const out = await reviewEvidenceFor(deps, everything(), REVIEW);
    expect(out.cards).toEqual([]);
    expect(out.kudos).toEqual([]);
  });

  it("windows 1:1s by the date it shows, not the date the row was filed", async () => {
    // A 1:1 is normally booked before it happens. Bounding on `created_at` dropped the December-booked
    // January meeting out of a Q1 pack, and let an April meeting in - rendered with an April date, outside
    // the window the same response states.
    await deps.db.insert(schema.checkIns).values([
      {
        uuid: genId(), code: "ci-in", employeeId: SUBJECT, notes: "booked in December, held in January",
        createdAt: new Date(BEFORE_WINDOW), meetingDate: new Date(Date.parse("2026-01-20T00:00:00Z")),
      },
      {
        uuid: genId(), code: "ci-out", employeeId: SUBJECT, notes: "booked in March, held in April",
        createdAt: new Date(IN_WINDOW), meetingDate: new Date(Date.parse("2026-04-20T00:00:00Z")),
      },
    ]);
    const out = await reviewEvidenceFor(deps, everything(), REVIEW);
    expect(out.check_ins.map((c) => c.notes)).toEqual(["booked in December, held in January"]);
  });

  it("falls back to when it was filed for a 1:1 that was never dated", async () => {
    await deps.db.insert(schema.checkIns).values({
      uuid: genId(), code: "ci-undated", employeeId: SUBJECT, notes: "no meeting date", createdAt: new Date(IN_WINDOW),
    });
    const out = await reviewEvidenceFor(deps, everything(), REVIEW);
    expect(out.check_ins).toHaveLength(1);
  });

  it("counts only work the person owned or was assigned", async () => {
    await card({ employeeId: OTHER, assigneeId: OTHER });
    const assigned = await card({ employeeId: OTHER, assigneeId: SUBJECT });
    const out = await reviewEvidenceFor(deps, everything(), REVIEW);
    expect(out.cards.map((x) => x.path)).toEqual([`cards/${assigned}`]);
  });

  it("leaves their own goals to the review's own snapshot", async () => {
    const mine = await goal({ employeeId: SUBJECT, cycleId: CYCLE });
    await deps.db.insert(schema.goalContributors).values({ uuid: genId(), goalId: mine, employeeId: SUBJECT, share: 50 });
    const out = await reviewEvidenceFor(deps, everything(), REVIEW);
    expect(out.contributions).toEqual([]);
  });

  it("gives an empty section for a collection the caller may not list", async () => {
    await card();
    await kudos();
    // A manager who may read the review and list cards, but holds nothing on the wall or on 1:1s.
    const partial = new Map<string, ListScope>([["cards", ALL], ["goals", ALL]]);
    const out = await reviewEvidenceFor(deps, partial, REVIEW);
    expect(out.cards).toHaveLength(1);
    expect(out.kudos).toEqual([]);
    expect(out.check_ins).toEqual([]);
  });

  it("fails closed on a scope it was handed with no breadth", async () => {
    await card();
    // `applyScope` answers an undefined scope with `1 = 0`; an absent entry never becomes "all rows".
    const none = new Map<string, ListScope>([["cards", { breadth: "own", deptCode: null, ownerId: "somebody-else", seeRestricted: false }]]);
    const out = await reviewEvidenceFor(deps, none, REVIEW);
    expect(out.cards).toEqual([]);
  });

  it("leaves a moderated kudos off the pack", async () => {
    await kudos({ disabled: true });
    const out = await reviewEvidenceFor(deps, everything(), REVIEW);
    expect(out.kudos).toEqual([]);
  });

  it("says when a section was cut short", async () => {
    for (let i = 0; i < 30; i++) await card();
    const out = await reviewEvidenceFor(deps, everything(), REVIEW);
    expect(out.cards).toHaveLength(25);
    expect(out.truncated).toBe(true);
  });
});

describe("the window", () => {
  it("runs to the END of the cycle's last day", () => {
    const { to } = evidenceWindow({ periodStart: CYCLE_START, periodEnd: CYCLE_END }, REVIEW);
    // Work delivered during the last day of the cycle belongs to the cycle.
    expect(to).toBe(CYCLE_END + 86_400_000);
  });

  it("falls back to the review's own life when the cycle is undated", () => {
    const now = Date.parse("2026-04-01T00:00:00Z");
    const { from, to, window } = evidenceWindow({}, REVIEW, now);
    expect(from).toBe(IN_WINDOW);
    expect(to).toBe(now);
    // Nothing is claimed about a period the cycle never named.
    expect(window).toEqual({});
  });
});

/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { seedManifest } from "./seedManifest";
import { genId } from "../src/lib/idCodec";
import { createBoard } from "../src/services/boards";
import { createCard, moveCard, commentCard, setCardBlocked, watchCard, rollRecurringCards } from "../src/services/cards";
import { createGoal, updateGoalProgress, commentGoal, watchGoal, setGoalConfidence } from "../src/services/goals";

// Following work you do not own. Notifications used to reach exactly one person on exactly two events, so
// the people whose own plans turned on a card or a goal found out late or not at all. These pin who hears
// what - and, just as importantly, who does NOT hear it twice.
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
  await seedManifest(b.DB);
  deps = makeDeps(b);
});

const TABLES = [
  schema.cardWatchers, schema.cardTodos, schema.cardComments, schema.cardMovements, schema.cards, schema.boards,
  schema.goalWatchers, schema.goalComments, schema.goals, schema.notifications, schema.eventLog, schema.auditLog,
  schema.users, schema.employees, schema.roles,
];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

async function seedEmployee(first: string): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.employees).values({ uuid, code: `04-${genId().slice(0, 3)}`, firstName: first, lastName: "User", workEmail: `${uuid}@test.example`, status: "active" });
  return uuid;
}

async function seedActor(first = "Actor"): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const employeeId = await seedEmployee(first);
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role: "employee", employeeId });
  return { uuid, email: `${uuid}@test.example`, role: "employee", status: "active", employeeId, employeeCode: null, name: `${first} User` } as unknown as AppUser;
}

/** A watcher, as an AppUser: watching is done BY the caller, so the verb needs one of these per person. */
async function seedWatcher(first: string): Promise<AppUser> {
  return seedActor(first);
}

const notifsFor = (employeeId: string) => deps.db.select().from(schema.notifications).where(eq(schema.notifications.recipientId, employeeId));

describe("card watchers", () => {
  it("tells a watcher about a column move, a comment and a block - and not about the actor's own doing", async () => {
    const owner = await seedActor("Owner");
    const watcher = await seedWatcher("Watcher");
    const board = await createBoard(deps, owner, { name: "Watched board" });
    const card = await createCard(deps, owner, { board: `boards/${board.uuid}`, title: "Ship it" });

    await watchCard(deps, watcher, card.uuid, true);
    const cols = (await deps.db.select().from(schema.boards).where(eq(schema.boards.uuid, board.uuid)).limit(1))[0]!;
    const columns = JSON.parse(cols.columnsJson) as { key: string }[];

    await moveCard(deps, owner, card.uuid, { column: columns[1]!.key });
    await commentCard(deps, owner, card.uuid, "picked this up");
    await setCardBlocked(deps, owner, card.uuid, true, "waiting on vendor");
    await setCardBlocked(deps, owner, card.uuid, false);

    const types = (await notifsFor(watcher.employeeId!)).map((n) => n.type).sort();
    expect(types).toEqual(["board.card_blocked", "board.card_comment", "board.card_moved", "board.card_unblocked"]);
    // The person doing the work is not told about their own moves - they are the one making them.
    expect((await notifsFor(owner.employeeId!)).length).toBe(0);
  });

  it("watches idempotently, unwatches what was never watched, and stops telling somebody who left", async () => {
    const owner = await seedActor("Owner");
    const watcher = await seedWatcher("Watcher");
    const board = await createBoard(deps, owner, { name: "Board" });
    const card = await createCard(deps, owner, { board: `boards/${board.uuid}`, title: "Task" });

    // Counted for THIS person, not over the card: whoever filed the task is already following it.
    const rowsFor = async (employeeId: string) =>
      (await deps.db.select().from(schema.cardWatchers).where(eq(schema.cardWatchers.cardId, card.uuid))).filter((w) => w.employeeId === employeeId);

    await watchCard(deps, watcher, card.uuid, true);
    await watchCard(deps, watcher, card.uuid, true); // pressing twice is one watcher, not two notifications
    expect((await rowsFor(watcher.employeeId!)).length).toBe(1);

    await watchCard(deps, watcher, card.uuid, false);
    await watchCard(deps, watcher, card.uuid, false); // and unwatching what you do not watch is not an error
    expect((await rowsFor(watcher.employeeId!)).length).toBe(0);

    await commentCard(deps, owner, card.uuid, "anyone?");
    expect((await notifsFor(watcher.employeeId!)).length).toBe(0);
  });

  it("puts whoever joins the conversation on the card, so they hear the reply to their own question", async () => {
    const owner = await seedActor("Owner");
    const asker = await seedWatcher("Asker");
    const board = await createBoard(deps, owner, { name: "Board" });
    const card = await createCard(deps, owner, { board: `boards/${board.uuid}`, title: "Task" });

    await commentCard(deps, asker, card.uuid, "is this still needed?");
    const watching = await deps.db.select().from(schema.cardWatchers).where(eq(schema.cardWatchers.cardId, card.uuid));
    // The owner is on it already as the reporter; commenting adds the person who asked the question.
    expect(watching.map((w) => w.employeeId).sort()).toEqual([owner.employeeId, asker.employeeId].sort());

    await commentCard(deps, owner, card.uuid, "yes - starting today");
    expect((await notifsFor(asker.employeeId!)).some((n) => n.type === "board.card_comment")).toBe(true);
  });

  it("does not tell the assignee twice: they already get the block notification aimed at them", async () => {
    const owner = await seedActor("Owner");
    const doer = await seedWatcher("Doer");
    const board = await createBoard(deps, owner, { name: "Board" });
    const card = await createCard(deps, owner, { board: `boards/${board.uuid}`, title: "Task", assignee: `employees/${doer.employeeId}` });
    await watchCard(deps, doer, card.uuid, true);

    await setCardBlocked(deps, owner, card.uuid, true, "blocked");
    const blocked = (await notifsFor(doer.employeeId!)).filter((n) => n.type === "board.card_blocked");
    expect(blocked.length).toBe(1); // the direct one, not the direct one plus the watcher copy
  });
});

describe("goal watchers", () => {
  it("tells a watcher about a real progress move, a comment and a slipping confidence call", async () => {
    const owner = await seedActor("Owner");
    const watcher = await seedWatcher("Watcher");
    const goal = await createGoal(deps, owner, { title: "Land the migration" });
    await watchGoal(deps, watcher, goal.uuid, true);

    await updateGoalProgress(deps, owner, goal.uuid, 40);
    await updateGoalProgress(deps, owner, goal.uuid, 40); // a re-save at the same number is not news
    await commentGoal(deps, owner, goal.uuid, "halfway");
    await setGoalConfidence(deps, owner, goal.uuid, "at_risk", "vendor slipped");

    const types = (await notifsFor(watcher.employeeId!)).map((n) => n.type).sort();
    expect(types).toEqual(["goal.at_risk", "goal.comment", "goal.progress"]);
  });

  it("never tells the goal's owner as a watcher - they are told directly or are the one acting", async () => {
    const owner = await seedActor("Owner");
    const other = await seedWatcher("Other");
    const goal = await createGoal(deps, owner, { title: "Mine" });
    // Somebody adds the OWNER as a watcher of their own goal (nothing forbids it).
    await deps.db.insert(schema.goalWatchers).values({ goalId: goal.uuid, employeeId: owner.employeeId! });
    await watchGoal(deps, other, goal.uuid, true);

    await updateGoalProgress(deps, other, goal.uuid, 20);
    expect((await notifsFor(owner.employeeId!)).filter((n) => n.type === "goal.progress").length).toBe(0);
    // The watcher who is not the owner still hears it.
    await updateGoalProgress(deps, owner, goal.uuid, 30);
    expect((await notifsFor(other.employeeId!)).filter((n) => n.type === "goal.progress").length).toBe(1);
  });
});

describe("recurring cards", () => {
  it("files the next one when a delivered card carries a cadence, and moves the cadence onto it", async () => {
    const owner = await seedActor("Owner");
    const doer = await seedEmployee("Doer");
    const board = await createBoard(deps, owner, { name: "Ops", task_prefix: "OPS" });
    const cols = JSON.parse((await deps.db.select().from(schema.boards).where(eq(schema.boards.uuid, board.uuid)).limit(1))[0]!.columnsJson) as { key: string }[];
    // A due date one month back, so this chore is a month late however long after 2026 the suite runs.
    const lastDue = new Date(+deps.clock.now());
    lastDue.setUTCMonth(lastDue.getUTCMonth() - 1, 12); // the 12th: a day every month has
    const card = await createCard(deps, owner, {
      board: `boards/${board.uuid}`, title: "Access review", assignee: `employees/${doer}`,
      due_date: lastDue.toISOString().slice(0, 10), cadence: "monthly", size: 3, initial_todos: ["pull the list", "check leavers"],
    });
    await moveCard(deps, owner, card.uuid, { column: cols[cols.length - 1]!.key }); // deliver it

    expect(await rollRecurringCards(deps)).toBe(1);
    const all = await deps.db.select().from(schema.cards).where(eq(schema.cards.boardId, board.uuid));
    const next = all.find((c) => c.uuid !== card.uuid)!;
    // The rhythm is measured from the OLD due date - so the day-of-month sticks - but stepped until it is
    // actually AHEAD. One step from the old date is the next occurrence only for a series being kept up with:
    // measured from a due date a month past, it lands the replacement in the past, and the chore is filed
    // already overdue with every later one inheriting the lag.
    const nextDue = new Date(next.dueDate!);
    expect(nextDue.getUTCDate()).toBe(12);
    expect(+nextDue).toBeGreaterThan(+deps.clock.now());
    expect(next.assigneeId).toBe(doer);
    expect(next.size).toBe(3);
    expect(next.cadence).toBe("monthly");
    // Exactly one card in the series carries the cadence, so the next tick cannot file a third.
    expect(all.find((c) => c.uuid === card.uuid)!.cadence).toBeNull();
    expect(await rollRecurringCards(deps)).toBe(0);
    // The checklist comes with it, unticked: it is the same chore.
    const todos = await deps.db.select().from(schema.cardTodos).where(eq(schema.cardTodos.cardId, next.uuid));
    expect(todos.map((t) => t.text)).toEqual(["pull the list", "check leavers"]);
    expect(todos.every((t) => !t.done)).toBe(true);
  });

  it("leaves a series on a soft-deleted board dormant, cadence intact, rather than eating it", async () => {
    // Soft-deleting a board does not touch its cards, so a delivered recurring card on a deleted board used
    // to stay in the roll's query while `createCard` refuses the board with "board not found". The series was
    // claimed - cadence cleared - and the create it was claimed for threw: the repeating chore stopped
    // existing, permanently, and the throw took every later series in the same tick with it.
    const owner = await seedActor("Owner");
    const board = await createBoard(deps, owner, { name: "Doomed" });
    const cols = JSON.parse((await deps.db.select().from(schema.boards).where(eq(schema.boards.uuid, board.uuid)).limit(1))[0]!.columnsJson) as { key: string }[];
    const card = await createCard(deps, owner, { board: `boards/${board.uuid}`, title: "Weekly sweep", due_date: "2026-01-01", cadence: "weekly" });
    await moveCard(deps, owner, card.uuid, { column: cols[cols.length - 1]!.key }); // deliver it
    await deps.db.update(schema.boards).set({ deleteTime: new Date() }).where(eq(schema.boards.uuid, board.uuid));

    // No throw, nothing filed, and no second card.
    expect(await rollRecurringCards(deps)).toBe(0);
    expect((await deps.db.select().from(schema.cards)).length).toBe(1);
    // The cadence survives, so restoring the board resumes the series instead of it having quietly ended.
    expect((await deps.db.select().from(schema.cards).where(eq(schema.cards.uuid, card.uuid)))[0]!.cadence).toBe("weekly");
    await deps.db.update(schema.boards).set({ deleteTime: null }).where(eq(schema.boards.uuid, board.uuid));
    expect(await rollRecurringCards(deps)).toBe(1);
  });

  it("leaves an undelivered recurring card alone - a late chore is chased, not duplicated", async () => {
    const owner = await seedActor("Owner");
    const board = await createBoard(deps, owner, { name: "Ops" });
    await createCard(deps, owner, { board: `boards/${board.uuid}`, title: "Weekly sweep", due_date: "2026-01-01", cadence: "weekly" });
    expect(await rollRecurringCards(deps)).toBe(0);
    expect((await deps.db.select().from(schema.cards)).length).toBe(1);
  });

  it("carries the reporter down the series, even though the tick that files it is nobody", async () => {
    const owner = await seedActor("Owner");
    const board = await createBoard(deps, owner, { name: "Ops" });
    const cols = JSON.parse((await deps.db.select().from(schema.boards).where(eq(schema.boards.uuid, board.uuid)).limit(1))[0]!.columnsJson) as { key: string }[];
    const card = await createCard(deps, owner, { board: `boards/${board.uuid}`, title: "Weekly sweep", cadence: "weekly" });
    await moveCard(deps, owner, card.uuid, { column: cols[cols.length - 1]!.key });

    await rollRecurringCards(deps);
    const next = (await deps.db.select().from(schema.cards)).find((c) => c.uuid !== card.uuid)!;
    // The chore was filed by a person; the next instance of it is not suddenly nobody's.
    expect(next.reporterId).toBe(owner.employeeId);
    const watching = await deps.db.select().from(schema.cardWatchers).where(eq(schema.cardWatchers.cardId, next.uuid));
    expect(watching.map((w) => w.employeeId)).toEqual([owner.employeeId]);
  });

  it("does not carry the goal link, which would inflate that goal's task count forever", async () => {
    const owner = await seedActor("Owner");
    const board = await createBoard(deps, owner, { name: "Ops" });
    const cols = JSON.parse((await deps.db.select().from(schema.boards).where(eq(schema.boards.uuid, board.uuid)).limit(1))[0]!.columnsJson) as { key: string }[];
    const goal = await createGoal(deps, owner, { title: "Keep the lights on" });
    const card = await createCard(deps, owner, { board: `boards/${board.uuid}`, title: "Weekly sweep", cadence: "weekly", goal: `goals/${goal.uuid}` });
    await moveCard(deps, owner, card.uuid, { column: cols[cols.length - 1]!.key });

    await rollRecurringCards(deps);
    const next = (await deps.db.select().from(schema.cards)).find((c) => c.uuid !== card.uuid)!;
    expect(next.goalId).toBeNull();
  });
});

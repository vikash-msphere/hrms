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
import { genId } from "../src/lib/idCodec";
import { createBoard, configureBoard, boardMetrics } from "../src/services/boards";
import { createCard, updateCard, moveCard, deleteCard, setCardBlocked, commentCard, getCardWithComments, addCardTodos, toggleCardTodo, removeCardTodo, listCards } from "../src/services/cards";
import { createGoal } from "../src/services/goals";
import { createSprint, activateSprint, completeSprint } from "../src/services/sprints";
import { listActivity, listAllActivity } from "../src/services/activity";

// Real-D1 (miniflare) flow test for the kanban board: WIP enforcement, commitment/delivery timestamps, the
// movement log feeding analytics, and the delivery -> goal roll-up. Exercises the actual services end to end.
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

const TABLES = [schema.cardTodos, schema.cardComments, schema.cardMovements, schema.cards, schema.sprints, schema.boards, schema.goals, schema.eventLog, schema.settings, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

async function seedActor(): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: `04-${genId().slice(0, 3)}`, firstName: "Test", lastName: "User", workEmail: `${employeeId}@test.example`, status: "active" });
  const uuid = genId();
  const email = `${uuid}@test.example`;
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email, role: "employee", employeeId });
  return { uuid, email, role: "employee", status: "active", employeeId, employeeCode: null, name: "Test User" } as unknown as AppUser;
}

const cardRow = (id: string) => deps.db.select().from(schema.cards).where(eq(schema.cards.uuid, id)).limit(1).then((r) => r[0]!);

describe("kanban flow: WIP + timestamps + movements + goal roll-up", () => {
  it("enforces the destination column's WIP limit", async () => {
    const actor = await seedActor();
    const board = await createBoard(deps, actor, { name: "WIP board" });
    await configureBoard(deps, actor, board.uuid, {
      columns: [
        { key: "todo", label: "To do", wipLimit: null, policy: "", commitment: false, delivery: false },
        { key: "doing", label: "Doing", wipLimit: 1, policy: "", commitment: true, delivery: false },
        { key: "done", label: "Done", wipLimit: null, policy: "", commitment: false, delivery: true },
      ],
    });
    const c1 = await createCard(deps, actor, { board: `boards/${board.uuid}`, title: "One", column_key: "todo" });
    const c2 = await createCard(deps, actor, { board: `boards/${board.uuid}`, title: "Two", column_key: "todo" });

    await moveCard(deps, actor, c1.uuid, "doing"); // fills the WIP-1 column
    await expect(moveCard(deps, actor, c2.uuid, "doing")).rejects.toThrow(/WIP limit/i);
    // Moving back out of a full column is always allowed.
    await expect(moveCard(deps, actor, c1.uuid, "todo")).resolves.toBeTruthy();
  });

  it("enforces per-assignee WIP independently per person", async () => {
    const actor = await seedActor();
    const emp = actor.employeeId!;
    const board = await createBoard(deps, actor, { name: "Per-assignee WIP" });
    await configureBoard(deps, actor, board.uuid, {
      columns: [
        { key: "todo", label: "To do", wipLimit: null, policy: "", commitment: false, delivery: false },
        { key: "doing", label: "Doing", wipLimit: 1, limitScope: "assignee", policy: "", commitment: true, delivery: false },
        { key: "done", label: "Done", wipLimit: null, policy: "", commitment: false, delivery: true },
      ],
    });
    const a1 = await createCard(deps, actor, { board: `boards/${board.uuid}`, title: "A1", column_key: "todo", assignee: `employees/${emp}` });
    const a2 = await createCard(deps, actor, { board: `boards/${board.uuid}`, title: "A2", column_key: "todo", assignee: `employees/${emp}` });
    const un = await createCard(deps, actor, { board: `boards/${board.uuid}`, title: "Unassigned", column_key: "todo" });

    await moveCard(deps, actor, a1.uuid, "doing"); // emp's bucket now has 1
    await expect(moveCard(deps, actor, a2.uuid, "doing")).rejects.toThrow(/already has 1/i); // emp's bucket full
    await expect(moveCard(deps, actor, un.uuid, "doing")).resolves.toBeTruthy(); // unassigned bucket is separate
  });

  it("stamps commitment/started/delivery times and logs every move", async () => {
    const actor = await seedActor();
    const board = await createBoard(deps, actor, { name: "Flow board" }); // default columns: backlog, ready(commit), in_progress, review, done(delivery)
    const card = await createCard(deps, actor, { board: `boards/${board.uuid}`, title: "Ship it" });

    let row = await cardRow(card.uuid);
    expect(row.committedAt).toBeNull();
    expect(row.deliveredAt).toBeNull();

    await moveCard(deps, actor, card.uuid, "ready"); // commitment point
    row = await cardRow(card.uuid);
    expect(row.committedAt).not.toBeNull();
    expect(row.startedAt).toBeNull(); // not past commitment yet

    await moveCard(deps, actor, card.uuid, "in_progress");
    row = await cardRow(card.uuid);
    expect(row.startedAt).not.toBeNull();

    await moveCard(deps, actor, card.uuid, "done"); // delivery point
    row = await cardRow(card.uuid);
    expect(row.deliveredAt).not.toBeNull();

    const moves = await deps.db.select().from(schema.cardMovements).where(eq(schema.cardMovements.cardId, card.uuid));
    expect(moves.length).toBe(4); // create (null->backlog) + 3 moves
    expect(moves[0]!.fromColumn).toBeNull();

    const m = await boardMetrics(deps, actor, board.uuid, 30);
    expect(m.cfd.length).toBe(30);
    expect(m.lead_time.count).toBe(1); // one delivered card with a commitment
    expect(m.cycle_time.count).toBe(1);
    expect(m.throughput.delivered).toBe(1);
    expect(m.columns.map((c) => c.key)).toContain("done");
  });

  it("rolls a goal's progress up from its linked tasks, weighted by story points", async () => {
    const actor = await seedActor();
    const goal = await createGoal(deps, actor, { title: "Q3 objective" });
    const board = await createBoard(deps, actor, { name: "Goal board" });
    const b = `boards/${board.uuid}`;
    const g = `goals/${goal.uuid}`;
    const small = await createCard(deps, actor, { board: b, title: "Small", goal: g, size: 2 });
    const big = await createCard(deps, actor, { board: b, title: "Big", goal: g, size: 3 });
    const goalNow = async () => (await deps.db.select().from(schema.goals).where(eq(schema.goals.uuid, goal.uuid)).limit(1))[0]!;

    expect((await goalNow()).progress).toBe(0); // 2 linked tasks, none delivered

    await moveCard(deps, actor, small.uuid, "done"); // deliver 2 of 5 pts
    expect((await goalNow()).progress).toBe(40);

    await moveCard(deps, actor, big.uuid, "done"); // deliver all 5 pts
    let gr = await goalNow();
    expect(gr.progress).toBe(100);
    expect(gr.status).toBe("completed");

    // Delete the (delivered) big card → recompute over the remaining small card (2/2 delivered) = 100 still.
    await deleteCard(deps, actor, big.uuid);
    expect((await goalNow()).progress).toBe(100);

    // Unlink the last card → goal is left untouched (no zeroing of a now-unlinked goal).
    await updateCard(deps, actor, small.uuid, { goal: null });
    expect((await goalNow()).progress).toBe(100);
  });

  it("falls back to task count when linked tasks have no story points", async () => {
    const actor = await seedActor();
    const goal = await createGoal(deps, actor, { title: "Countable" });
    const board = await createBoard(deps, actor, { name: "Count board" });
    const b = `boards/${board.uuid}`, g = `goals/${goal.uuid}`;
    const c1 = await createCard(deps, actor, { board: b, title: "One", goal: g });
    await createCard(deps, actor, { board: b, title: "Two", goal: g });
    await moveCard(deps, actor, c1.uuid, "done"); // 1 of 2 tasks
    const gr = (await deps.db.select().from(schema.goals).where(eq(schema.goals.uuid, goal.uuid)).limit(1))[0]!;
    expect(gr.progress).toBe(50);
  });

  it("org-wide feed resolves the touched record's name and the actor's name", async () => {
    const actor = await seedActor();
    const goal = await createGoal(deps, actor, { title: "Name resolution goal" });
    const { items } = await listAllActivity(deps, { entity: "goals" });
    const created = items.find((r) => r.action === "goal.create" && r.entityId === goal.uuid);
    expect(created).toBeTruthy();
    // enrichNames: goal title (pickName over the goals table) + actor employee name (from employees).
    expect((created as { entityName?: string }).entityName).toBe("Name resolution goal");
    expect((created as { actorName?: string }).actorName).toBe("Test User");
  });

  it("card checklist: add / toggle / remove, with list progress", async () => {
    const actor = await seedActor();
    const board = await createBoard(deps, actor, { name: "Checklist board" });
    const card = await createCard(deps, actor, { board: `boards/${board.uuid}`, title: "Has checklist" });

    const added = await addCardTodos(deps, actor, card.uuid, ["design", "build", "ship"]);
    expect(added._todos.map((t) => t.text)).toEqual(["design", "build", "ship"]);
    const firstId = added._todos[0]!.uuid;

    const toggled = await toggleCardTodo(deps, actor, card.uuid, firstId, true);
    expect(toggled._todos.find((t) => t.uuid === firstId)!.done).toBe(true);

    // Compact progress rides on the list (board tiles) without loading items.
    const page = await listCards(deps, { breadth: "all", deptCode: null, ownerId: null, seeRestricted: true }, 50, undefined, board.uuid);
    const row = page.items.find((r) => r.uuid === card.uuid)! as typeof page.items[number] & { todoTotal: number; todoDone: number };
    expect(row.todoTotal).toBe(3);
    expect(row.todoDone).toBe(1);

    const removed = await removeCardTodo(deps, actor, card.uuid, firstId);
    expect(removed._todos.length).toBe(2);
    expect(removed._todos.some((t) => t.uuid === firstId)).toBe(false);

    // Checklist seeded at creation (the create dialog stages items + expands templates).
    const seeded = await createCard(deps, actor, { board: `boards/${board.uuid}`, title: "Seeded", initial_todos: ["  x  ", "y", ""] });
    const withTodos = await getCardWithComments(deps, actor, seeded.uuid);
    expect(withTodos._todos.map((t) => t.text)).toEqual(["x", "y"]); // trimmed, blanks dropped
  });

  it("round-trips labels (board catalog + card keys, deduped)", async () => {
    const actor = await seedActor();
    const board = await createBoard(deps, actor, { name: "Labels", labels: [{ key: "bug", label: "Bug", color: "#e34948" }, { key: "urgent", label: "Urgent" }] });
    const b = (await deps.db.select().from(schema.boards).where(eq(schema.boards.uuid, board.uuid)).limit(1))[0]!;
    expect(JSON.parse(b.labelsJson).map((l: { key: string }) => l.key)).toEqual(["bug", "urgent"]);
    const card = await createCard(deps, actor, { board: `boards/${board.uuid}`, title: "Fix", labels: ["bug", "bug", "urgent"] });
    const c = await cardRow(card.uuid);
    expect(JSON.parse(c.labelsJson)).toEqual(["bug", "urgent"]); // deduped
  });

  it("assigns per-board incrementing task keys (PREFIX-N)", async () => {
    const actor = await seedActor();
    const board = await createBoard(deps, actor, { name: "Marketing Site", task_prefix: "MS" });
    const c1 = await createCard(deps, actor, { board: `boards/${board.uuid}`, title: "One" });
    const c2 = await createCard(deps, actor, { board: `boards/${board.uuid}`, title: "Two" });
    expect([c1.seq, c2.seq]).toEqual([1, 2]);
    expect(c1.keyPrefix).toBe("MS");
    // A second board keeps its own sequence.
    const other = await createBoard(deps, actor, { name: "Platform Team" }); // derived prefix "PT"
    const o1 = await createCard(deps, actor, { board: `boards/${other.uuid}`, title: "X" });
    expect(o1.seq).toBe(1);
    expect(o1.keyPrefix).toBe("PT");
  });

  it("blocks a task by another task (dependency link)", async () => {
    const actor = await seedActor();
    const board = await createBoard(deps, actor, { name: "Deps" });
    const a = await createCard(deps, actor, { board: `boards/${board.uuid}`, title: "A" });
    const b = await createCard(deps, actor, { board: `boards/${board.uuid}`, title: "B" });
    await setCardBlocked(deps, actor, b.uuid, true, "waiting", `cards/${a.uuid}`);
    let row = await cardRow(b.uuid);
    expect(row.blocked).toBe(true);
    expect(row.blockedById).toBe(a.uuid);
    expect(row.blockReason).toBe("waiting");
    await setCardBlocked(deps, actor, b.uuid, false); // unblock clears the link + reason
    row = await cardRow(b.uuid);
    expect(row.blockedById).toBeNull();
    expect(row.blockReason).toBeNull();
    await expect(setCardBlocked(deps, actor, b.uuid, true, null, `cards/${b.uuid}`)).rejects.toThrow(/itself/i);
  });

  it("writes an append-only audit trail: actor id, request metadata, and update diffs", async () => {
    const actor = await seedActor();
    (actor as { reqMeta?: unknown }).reqMeta = { ip: "1.2.3.4", ua: "vitest-agent" };
    const board = await createBoard(deps, actor, { name: "Audited" });
    const card = await createCard(deps, actor, { board: `boards/${board.uuid}`, title: "Tracked" });
    await moveCard(deps, actor, card.uuid, "ready");
    await updateCard(deps, actor, card.uuid, { title: "Renamed" });
    const rows = (await deps.db.select().from(schema.auditLog).where(eq(schema.auditLog.entity, "cards"))).filter((r) => r.entityId === card.uuid);
    expect(rows.map((r) => r.action).sort()).toEqual(["card.create", "card.move", "card.update"]);
    expect(rows.every((r) => r.actorId === actor.employeeId)).toBe(true); // enriched actor id
    expect(rows.every((r) => r.ip === "1.2.3.4" && r.userAgent === "vitest-agent")).toBe(true); // request metadata
    const upd = rows.find((r) => r.action === "card.update")!;
    expect(JSON.parse(upd.meta!).diff.title).toEqual({ from: "Tracked", to: "Renamed" }); // before → after
    const mv = rows.find((r) => r.action === "card.move")!;
    expect(JSON.parse(mv.meta!)).toEqual({ from: "backlog", to: "ready" }); // move records from → to
    // Server-side filters: by action category (tone) and free text (over action/meta/actor).
    const byTone = await listActivity(deps, "cards", card.uuid, { tone: "move" });
    expect(byTone.items.map((r) => r.action)).toEqual(["card.move"]);
    const byText = await listActivity(deps, "cards", card.uuid, { q: "ready" });
    expect(byText.items.map((r) => r.action)).toEqual(["card.move"]); // meta {to:"ready"} matches
  });

  it("threads comments on a card", async () => {
    const actor = await seedActor();
    const board = await createBoard(deps, actor, { name: "Comment board" });
    const card = await createCard(deps, actor, { board: `boards/${board.uuid}`, title: "Discuss" });
    await commentCard(deps, actor, card.uuid, "first");
    const withC = await commentCard(deps, actor, card.uuid, "second");
    expect(withC._comments.map((c) => c.body)).toEqual(["first", "second"]); // oldest-first
    expect((await getCardWithComments(deps, actor, card.uuid))._comments.length).toBe(2);
    await expect(commentCard(deps, actor, card.uuid, "  ")).rejects.toThrow(/body is required/i);
  });

  it("card department: set on create, changed and cleared on update, org default when omitted", async () => {
    const actor = await seedActor();
    const board = await createBoard(deps, actor, { name: "Cross-functional" });
    const design = genId(), eng = genId(), ops = genId();
    await deps.db.insert(schema.departments).values([
      { uuid: design, code: `d-${genId().slice(0, 3)}`, name: "Design" },
      { uuid: eng, code: `d-${genId().slice(0, 3)}`, name: "Engineering" },
      { uuid: ops, code: `d-${genId().slice(0, 3)}`, name: "Ops" },
    ]);

    const c = await createCard(deps, actor, { board: `boards/${board.uuid}`, title: "Explicit", department: `departments/${design}` });
    expect(c.departmentId).toBe(design);

    await updateCard(deps, actor, c.uuid, { department: `departments/${eng}` });
    expect((await cardRow(c.uuid)).departmentId).toBe(eng);

    await updateCard(deps, actor, c.uuid, { department: null }); // explicitly clear
    expect((await cardRow(c.uuid)).departmentId).toBeNull();

    // No org default set + department omitted -> no department.
    const none = await createCard(deps, actor, { board: `boards/${board.uuid}`, title: "No default" });
    expect(none.departmentId).toBeNull();

    // Org default set + department omitted -> inherits the org default.
    await deps.db.insert(schema.settings).values({ key: "organization", value: JSON.stringify({ default_department: `departments/${ops}` }) });
    const defaulted = await createCard(deps, actor, { board: `boards/${board.uuid}`, title: "Uses default" });
    expect(defaulted.departmentId).toBe(ops);
  });

  it("scrum: one active sprint per board; completing sweeps unfinished cards to the backlog", async () => {
    const actor = await seedActor();
    const board = await createBoard(deps, actor, { name: "Scrum board", mode: "scrum" });
    const s1 = await createSprint(deps, actor, { board: `boards/${board.uuid}`, name: "Sprint 1" });
    const s2 = await createSprint(deps, actor, { board: `boards/${board.uuid}`, name: "Sprint 2" });

    await activateSprint(deps, actor, s1.uuid);
    await expect(activateSprint(deps, actor, s2.uuid)).rejects.toThrow(/already active/i); // one active per board

    const done = await createCard(deps, actor, { board: `boards/${board.uuid}`, sprint: `sprints/${s1.uuid}`, title: "Done" });
    const wip = await createCard(deps, actor, { board: `boards/${board.uuid}`, sprint: `sprints/${s1.uuid}`, title: "Unfinished" });
    await moveCard(deps, actor, done.uuid, "done"); // delivered

    await completeSprint(deps, actor, s1.uuid);
    const doneRow = await cardRow(done.uuid);
    const wipRow = await cardRow(wip.uuid);
    expect(doneRow.sprintId).toBe(s1.uuid); // delivered card stays in the completed sprint (for velocity)
    expect(wipRow.sprintId).toBeNull(); // unfinished card swept back to the product backlog
  });

  it("move: to_sprint reassigns backlog <-> sprint atomically with column + rank", async () => {
    const actor = await seedActor();
    const board = await createBoard(deps, actor, { name: "Scrum board", mode: "scrum" });
    const s1 = await createSprint(deps, actor, { board: `boards/${board.uuid}`, name: "Sprint 1" });
    const card = await createCard(deps, actor, { board: `boards/${board.uuid}`, title: "Backlog item" });
    expect((await cardRow(card.uuid)).sprintId).toBeNull();

    // Pull into the sprint: one move call sets sprint + column + rank.
    await moveCard(deps, actor, card.uuid, "in_progress", undefined, 512, undefined, undefined, undefined, undefined, `sprints/${s1.uuid}`);
    let row = await cardRow(card.uuid);
    expect(row.sprintId).toBe(s1.uuid);
    expect(row.columnKey).toBe("in_progress");
    expect(row.rank).toBe(512);

    // Send back to the backlog (to_sprint null) with a reorder rank; column unchanged.
    await moveCard(deps, actor, card.uuid, "in_progress", undefined, 256, undefined, undefined, undefined, undefined, null);
    row = await cardRow(card.uuid);
    expect(row.sprintId).toBeNull();
    expect(row.rank).toBe(256);

    // A move that says nothing about sprints leaves the assignment alone.
    await moveCard(deps, actor, card.uuid, "review");
    expect((await cardRow(card.uuid)).sprintId).toBeNull();
  });
});

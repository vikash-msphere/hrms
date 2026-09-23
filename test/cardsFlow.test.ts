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
import { createCard, updateCard, moveCard, deleteCard, setCardBlocked, commentCard, getCardWithComments, addCardTodos, toggleCardTodo, removeCardTodo, promoteCardTodo, listCards } from "../src/services/cards";
import { createGoal } from "../src/services/goals";
import { createSprint, activateSprint, completeSprint } from "../src/services/sprints";
import { listActivity, listAllActivity } from "../src/services/activity";
import { etagOf } from "../src/http/serialize";

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

const TABLES = [schema.cardTodos, schema.cardComments, schema.cardMovements, schema.cards, schema.sprints, schema.boards, schema.goals, schema.eventLog, schema.notifications, schema.settings, schema.users, schema.employees, schema.departments, schema.roles];
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

    await moveCard(deps, actor, c1.uuid, { column: "doing" }); // fills the WIP-1 column
    await expect(moveCard(deps, actor, c2.uuid, { column: "doing" })).rejects.toThrow(/WIP limit/i);
    // Moving back out of a full column is always allowed.
    await expect(moveCard(deps, actor, c1.uuid, { column: "todo" })).resolves.toBeTruthy();
  });

  it("honours the ETag the SPA sends with a move", async () => {
    // The SPA has always sent the card's version with a move (`invoke(..., "move", card.etag, move)`) and the
    // sibling verbs take one, but `move` discarded it - so the client was being careful about a version the
    // server ignored. (The write is also guarded on the column that was read, which is what makes the WIP
    // count above hold under two people dragging at once; that half needs an interleaved race to observe.)
    const actor = await seedActor();
    const board = await createBoard(deps, actor, { name: "Guarded board" });
    const card = await createCard(deps, actor, { board: `boards/${board.uuid}`, title: "Contended", column_key: "backlog" });
    const current = etagOf(+new Date((await deps.db.select().from(schema.cards).where(eq(schema.cards.uuid, card.uuid)).limit(1))[0]!.updatedAt));

    const movesOf = () => deps.db.select().from(schema.cardMovements).where(eq(schema.cardMovements.cardId, card.uuid));
    const atCreate = (await movesOf()).length; // the create logs the card's arrival (null -> backlog)

    await expect(moveCard(deps, actor, card.uuid, { column: "ready" }, '"not-the-version"')).rejects.toThrow(/etag/i);
    expect(await movesOf()).toHaveLength(atCreate); // refused before anything was written

    await expect(moveCard(deps, actor, card.uuid, { column: "ready" }, current)).resolves.toBeTruthy();
    const moves = await movesOf();
    expect(moves).toHaveLength(atCreate + 1);
    expect(moves[moves.length - 1]!.fromColumn).toBe("backlog");
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

    await moveCard(deps, actor, a1.uuid, { column: "doing" }); // emp's bucket now has 1
    await expect(moveCard(deps, actor, a2.uuid, { column: "doing" })).rejects.toThrow(/already has 1/i); // emp's bucket full
    await expect(moveCard(deps, actor, un.uuid, { column: "doing" })).resolves.toBeTruthy(); // unassigned bucket is separate
  });

  it("stamps commitment/started/delivery times and logs every move", async () => {
    const actor = await seedActor();
    const board = await createBoard(deps, actor, { name: "Flow board" }); // default columns: backlog, ready(commit), in_progress, review, done(delivery)
    const card = await createCard(deps, actor, { board: `boards/${board.uuid}`, title: "Ship it" });

    let row = await cardRow(card.uuid);
    expect(row.committedAt).toBeNull();
    expect(row.deliveredAt).toBeNull();

    await moveCard(deps, actor, card.uuid, { column: "ready" }); // commitment point
    row = await cardRow(card.uuid);
    expect(row.committedAt).not.toBeNull();
    expect(row.startedAt).toBeNull(); // not past commitment yet

    await moveCard(deps, actor, card.uuid, { column: "in_progress" });
    row = await cardRow(card.uuid);
    expect(row.startedAt).not.toBeNull();

    await moveCard(deps, actor, card.uuid, { column: "done" }); // delivery point
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

  // A deleted card is not work, and every other count on the board already agreed (`card_count` reads
  // `delete_time`). This read did not, so a deleted card kept contributing its lead time, its cycle time and
  // its delivery to throughput - and never left the CFD, because the diagram reconstructs a card's column from
  // its last movement and a soft delete writes no movement. It sat in whatever column it was in, on every day
  // of every window, forever.
  it("drops soft-deleted cards from the flow metrics and the CFD", async () => {
    const actor = await seedActor();
    const board = await createBoard(deps, actor, { name: "Metrics board" });
    await configureBoard(deps, actor, board.uuid, {
      columns: [
        { key: "backlog", label: "Backlog", wipLimit: null, policy: "", commitment: false, delivery: false },
        { key: "ready", label: "Ready", wipLimit: null, policy: "", commitment: true, delivery: false },
        { key: "done", label: "Done", wipLimit: null, policy: "", commitment: false, delivery: true },
      ],
    });
    const b1 = `boards/${board.uuid}`;
    const keep = await createCard(deps, actor, { board: b1, title: "Kept" });
    const gone = await createCard(deps, actor, { board: b1, title: "Deleted" });
    for (const c of [keep, gone]) {
      await moveCard(deps, actor, c.uuid, { column: "ready" });
      await moveCard(deps, actor, c.uuid, { column: "done" });
    }

    const before = await boardMetrics(deps, actor, board.uuid, 30);
    expect(before.throughput.delivered).toBe(2);
    expect(before.lead_time.count).toBe(2);

    await deleteCard(deps, actor, gone.uuid);

    const after = await boardMetrics(deps, actor, board.uuid, 30);
    expect(after.throughput.delivered).toBe(1);
    expect(after.lead_time.count).toBe(1);
    expect(after.cycle_time.count).toBe(1);
    // The CFD counts cards by column per day; the deleted one must be in none of them. Today's row is the
    // last, and both cards are sitting in `done`.
    expect(after.cfd[after.cfd.length - 1]!.counts.done).toBe(1);
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

    await moveCard(deps, actor, small.uuid, { column: "done" }); // deliver 2 of 5 pts
    expect((await goalNow()).progress).toBe(40);

    await moveCard(deps, actor, big.uuid, { column: "done" }); // deliver all 5 pts
    const gr = await goalNow();
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
    await moveCard(deps, actor, c1.uuid, { column: "done" }); // 1 of 2 tasks
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

  // The profile's Performance tab asks for the work one person is DOING, across every board. On the assignee,
  // not the owner: `employee_id` is what the row is authz-scoped by and defaults to whoever filed the card, so
  // a task a manager filed for somebody else is owned by the manager and done by the report.
  it("lists one person's tasks by assignee, across boards, ignoring the owner", async () => {
    const actor = await seedActor();
    const doer = genId();
    await deps.db.insert(schema.employees).values({ uuid: doer, code: `04-${genId().slice(0, 3)}`, firstName: "Dee", lastName: "Oer", workEmail: `${doer}@test.example`, status: "active" });
    const one = await createBoard(deps, actor, { name: "Board one" });
    const two = await createBoard(deps, actor, { name: "Board two" });
    const mine = await createCard(deps, actor, { board: `boards/${one.uuid}`, title: "Filed for Dee", assignee: `employees/${doer}` });
    const alsoMine = await createCard(deps, actor, { board: `boards/${two.uuid}`, title: "Other board, same person", assignee: `employees/${doer}` });
    // Owned by the actor and assigned to nobody: it must not arrive on Dee's list just because Dee's tasks are
    // being asked for on a board the actor owns.
    await createCard(deps, actor, { board: `boards/${one.uuid}`, title: "Unassigned" });

    const scope = { breadth: "all", deptCode: null, ownerId: null, seeRestricted: true } as const;
    const page = await listCards(deps, scope, 50, undefined, undefined, false, false, doer);
    expect(page.items.map((c) => c.uuid).sort()).toEqual([mine.uuid, alsoMine.uuid].sort());
    expect(page.items.every((c) => c.employeeId === actor.employeeId)).toBe(true);

    // Composes with the board filter rather than replacing it.
    const onBoardTwo = await listCards(deps, scope, 50, undefined, two.uuid, false, false, doer);
    expect(onBoardTwo.items.map((c) => c.uuid)).toEqual([alsoMine.uuid]);
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

  it("promotes a checklist item into a card that inherits the parent's context, and ticks the item", async () => {
    const actor = await seedActor();
    const doer = genId();
    await deps.db.insert(schema.employees).values({ uuid: doer, code: `04-${genId().slice(0, 3)}`, firstName: "Dee", lastName: "Oer", workEmail: `${doer}@test.example`, status: "active" });
    const board = await createBoard(deps, actor, { name: "Promote board", task_prefix: "PB" });
    const dept = genId();
    await deps.db.insert(schema.departments).values({ uuid: dept, code: `03-${genId().slice(0, 3)}`, name: "Delivery" });
    const goal = await createGoal(deps, actor, { title: "Ship the thing" });
    const parent = await createCard(deps, actor, {
      board: `boards/${board.uuid}`, title: "Importer", assignee: `employees/${doer}`,
      department: `departments/${dept}`, goal: `goals/${goal.uuid}`,
    });
    const added = await addCardTodos(deps, actor, parent.uuid, ["write the mapping"]);
    const todoId = added._todos[0]!.uuid;

    const after = await promoteCardTodo(deps, actor, parent.uuid, todoId);
    const child = (await listCards(deps, { breadth: "all", deptCode: null, ownerId: null, seeRestricted: true }, 50, undefined, board.uuid))
      .items.find((c) => c.title === "write the mapping")!;

    // Same board, first column, and the context the item was sitting in - so it lands where that work lives.
    expect(child.boardId).toBe(board.uuid);
    expect(child.assigneeId).toBe(doer);
    expect(child.departmentId).toBe(dept);
    // NOT the goal: the parent is still linked, and copying it would count one piece of work twice in the
    // goal's delivered share.
    expect(child.goalId).toBeNull();
    expect(child.description).toContain("Importer");

    // The item is ticked and points at where the work went, so the checklist and the board cannot both claim
    // it as outstanding.
    const item = after._todos.find((t) => t.uuid === todoId)!;
    expect(item.done).toBe(true);
    expect(item.text).toBe(`write the mapping → PB-${child.seq}`);
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
    await moveCard(deps, actor, card.uuid, { column: "ready" });
    await updateCard(deps, actor, card.uuid, { title: "Renamed" });
    const rows = (await deps.db.select().from(schema.auditLog).where(eq(schema.auditLog.entity, "cards"))).filter((r) => r.entityId === card.uuid);
    expect(rows.map((r) => r.action).sort()).toEqual(["card.create", "card.move", "card.update"]);
    expect(rows.every((r) => r.actorId === actor.employeeId)).toBe(true); // enriched actor id
    expect(rows.every((r) => r.ip === "1.2.3.4" && r.userAgent === "vitest-agent")).toBe(true); // request metadata
    const upd = rows.find((r) => r.action === "card.update")!;
    expect(JSON.parse(upd.meta!).diff.title).toEqual({ from: "Tracked", to: "Renamed" }); // before → after
    const mv = rows.find((r) => r.action === "card.move")!;
    expect(JSON.parse(mv.meta!)).toEqual({ from: "backlog", to: "ready" }); // move records from → to
    // Server-side filters: by action category (tone) and free text (over the action, the actor and the
    // snapshotted object name). NOT over `meta` - that column holds the from/to VALUES of whatever the audit
    // filters let through, and a substring search across it is a grep over material whose own access control
    // lives elsewhere (see services/activity.ts textAndToneConds).
    const byTone = await listActivity(deps, "cards", card.uuid, { tone: "move" });
    expect(byTone.items.map((r) => r.action)).toEqual(["card.move"]);
    const byText = await listActivity(deps, "cards", card.uuid, { q: "move" });
    expect(byText.items.map((r) => r.action)).toEqual(["card.move"]); // action "card.move" matches
    // A word that appears ONLY inside the meta blob finds nothing.
    expect((await listActivity(deps, "cards", card.uuid, { q: "ready" })).items).toEqual([]);
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

  it("naming someone in a card comment notifies them, and never notifies the author", async () => {
    const actor = await seedActor();
    const board = await createBoard(deps, actor, { name: "Mention board" });
    const card = await createCard(deps, actor, { board: `boards/${board.uuid}`, title: "Needs a decision" });
    // A second employee to name. The token carries the WIRE id, which is what an author's client would write.
    const otherId = genId();
    await deps.db.insert(schema.employees).values({ uuid: otherId, code: `04-${genId().slice(0, 3)}`, firstName: "Priya", lastName: "Nair", workEmail: `${otherId}@test.example`, status: "active" });
    const otherToken = await deps.idCodec.encode("employees", otherId);
    const selfToken = await deps.idCodec.encode("employees", actor.employeeId!);

    await commentCard(deps, actor, card.uuid, `[@Priya Nair](employees/${otherToken}) can you look? cc [@Me](employees/${selfToken})`);

    const notes = await deps.db.select().from(schema.notifications);
    const mentions = notes.filter((n) => n.type === "board.mention");
    expect(mentions).toHaveLength(1); // the other person, once; the author names themselves for free
    expect(mentions[0]!.recipientId).toBe(otherId);
    expect(mentions[0]!.subject).toBe(`cards/${card.uuid}`);
    expect(mentions[0]!.link).toBe("boards");
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
    await moveCard(deps, actor, done.uuid, { column: "done" }); // delivered

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
    await moveCard(deps, actor, card.uuid, { column: "in_progress", rank: 512, sprint: `sprints/${s1.uuid}` });
    let row = await cardRow(card.uuid);
    expect(row.sprintId).toBe(s1.uuid);
    expect(row.columnKey).toBe("in_progress");
    expect(row.rank).toBe(512);

    // Send back to the backlog (to_sprint null) with a reorder rank; column unchanged.
    await moveCard(deps, actor, card.uuid, { column: "in_progress", rank: 256, sprint: null });
    row = await cardRow(card.uuid);
    expect(row.sprintId).toBeNull();
    expect(row.rank).toBe(256);

    // A move that says nothing about sprints leaves the assignment alone.
    await moveCard(deps, actor, card.uuid, { column: "review" });
    expect((await cardRow(card.uuid)).sprintId).toBeNull();
  });

  // A stand-up is four people filing tasks on one board at once. Both of a card's allocated numbers are
  // read-then-write max+1 - its `code` and the per-board `seq` behind the human key - so simultaneous creates
  // compose the same pair. Unique indexes fail the loser and services/cards.ts re-numbers it; what must never
  // happen is two tasks answering to MS-4, which is the number people say out loud.
  it("numbers cards filed at the same moment apart", async () => {
    const actor = await seedActor();
    const board = await createBoard(deps, actor, { name: "Stand-up board" });

    const cards = await Promise.all(
      ["One", "Two", "Three", "Four"].map((title) => createCard(deps, actor, { board: `boards/${board.uuid}`, title })),
    );

    expect(new Set(cards.map((c) => c.seq)).size).toBe(4);
    expect(new Set(cards.map((c) => c.code)).size).toBe(4);
    // The numbers are the run 1..4, not four arbitrary distinct values: the key is read as a sequence.
    expect(cards.map((c) => c.seq).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1, 2, 3, 4]);
  });
});

// Who filed a task. The card already had an owner (`employee`, the authz-scoped accountable person) and an
// assignee; when a manager files one FOR somebody both of those become that person, and "who asked for this"
// was left in the audit trail where the board cannot show it and a filter cannot reach it.
describe("the reporter", () => {
  it("is stamped from the CALLER even when the task is filed for somebody else", async () => {
    const actor = await seedActor();
    const other = genId();
    await deps.db.insert(schema.employees).values({ uuid: other, code: `04-${genId().slice(0, 3)}`, firstName: "Oth", lastName: "Er", workEmail: `${other}@test.example`, status: "active" });
    const board = await createBoard(deps, actor, { name: "Board" });

    const card = await createCard(deps, actor, { board: `boards/${board.uuid}`, title: "Fix the importer", employee: `employees/${other}`, assignee: `employees/${other}` });
    // Owner and assignee are the other person; the reporter is the one who actually filed it.
    expect(card.employeeId).toBe(other);
    expect(card.assigneeId).toBe(other);
    expect(card.reporterId).toBe(actor.employeeId);
  });

  it("ignores a reporter named by the caller, and survives an edit untouched", async () => {
    const actor = await seedActor();
    const impostor = genId();
    await deps.db.insert(schema.employees).values({ uuid: impostor, code: `04-${genId().slice(0, 3)}`, firstName: "Imp", lastName: "Ostor", workEmail: `${impostor}@test.example`, status: "active" });
    const board = await createBoard(deps, actor, { name: "Board" });

    // The service reads the reporter off the ACTOR and has no branch for an incoming one, so a body that
    // names somebody else changes nothing. (The route's write schemas are `.strict()`, so over HTTP such a
    // body is refused outright - that layer is covered by the openapi/route drift tests.)
    const card = await createCard(deps, actor, { board: `boards/${board.uuid}`, title: "Task", ...({ reporter: `employees/${impostor}` } as object) });
    expect(card.reporterId).toBe(actor.employeeId);

    const patched = await updateCard(deps, actor, card.uuid, { title: "Task, renamed", ...({ reporter: `employees/${impostor}` } as object) });
    expect(patched.reporterId).toBe(actor.employeeId);
  });

  it("follows the task it filed, so the person who asked hears how it is going", async () => {
    const actor = await seedActor();
    const board = await createBoard(deps, actor, { name: "Board" });
    const card = await createCard(deps, actor, { board: `boards/${board.uuid}`, title: "Task" });
    const watchers = await deps.db.select().from(schema.cardWatchers).where(eq(schema.cardWatchers.cardId, card.uuid));
    expect(watchers.map((w) => w.employeeId)).toEqual([actor.employeeId]);
  });
});

// THE TWO ALLOCATED NUMBERS ON A CARD, and what they cost to allocate.
//
// Creating one card used to read every card on the board (for the per-board `seq` behind the human key MS-4)
// AND every live card in the destination column (for the rank at the bottom of it), then take `Math.max` in
// the isolate. That is the shape services/codeAlloc.ts was rewritten out of - "ruinous on an append-only
// table … per action, on a platform that bills rows read" - and a board is not bounded: finished cards stay
// for the history and the CFD analytics. The `seq` read was inside `withFreshCode`, so a contended board paid
// for it up to four times in one request.
//
// Both are `max()` aggregates now, each an index seek (schema.ts `card_board_seq_idx`,
// `card_board_col_rank_idx`). The rule they implement is unchanged - max+1, read-then-write, the unique index
// failing the loser and `withFreshCode` retrying - so these pin the BEHAVIOUR the rewrite had to preserve.
describe("card numbering survives the aggregate rewrite", () => {
  it("hands out consecutive per-board keys, and never reuses one a deleted card held", async () => {
    const actor = await seedActor();
    const board = await createBoard(deps, actor, { name: "Numbering" });
    const b = `boards/${board.uuid}`;

    const first = await createCard(deps, actor, { board: b, title: "One" });
    const second = await createCard(deps, actor, { board: b, title: "Two" });
    expect(second.seq).toBe(first.seq! + 1);

    // A deleted card still owns its number: the key MS-2 was on a sticker, in a branch name, in a chat.
    await deleteCard(deps, actor, second.uuid);
    const third = await createCard(deps, actor, { board: b, title: "Three" });
    expect(third.seq).toBe(second.seq! + 1);
  });

  it("numbers each board independently", async () => {
    const actor = await seedActor();
    const one = await createBoard(deps, actor, { name: "Board one" });
    const two = await createBoard(deps, actor, { name: "Board two" });
    const a = await createCard(deps, actor, { board: `boards/${one.uuid}`, title: "A" });
    const b = await createCard(deps, actor, { board: `boards/${two.uuid}`, title: "B" });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(1); // a per-board sequence, not a global one
  });

  it("ranks a new card below the column it lands in, per column", async () => {
    const actor = await seedActor();
    const board = await createBoard(deps, actor, { name: "Ranking" });
    const b = `boards/${board.uuid}`;

    const t1 = await createCard(deps, actor, { board: b, title: "backlog one", column_key: "backlog" });
    const t2 = await createCard(deps, actor, { board: b, title: "backlog two", column_key: "backlog" });
    expect(t2.rank).toBeGreaterThan(t1.rank);

    // Rank is per COLUMN, so the first card of another column starts from that column's own bottom.
    const d1 = await createCard(deps, actor, { board: b, title: "review one", column_key: "review" });
    expect(d1.rank).toBe(t1.rank);

    // A deleted card does not hold a column's rank open - the aggregate filters it, as the old read did.
    await deleteCard(deps, actor, t2.uuid);
    const t3 = await createCard(deps, actor, { board: b, title: "backlog three", column_key: "backlog" });
    expect(t3.rank).toBe(t1.rank + (t2.rank - t1.rank));
  });

  it("moves a card to the bottom of the destination column", async () => {
    const actor = await seedActor();
    const board = await createBoard(deps, actor, { name: "Moving" });
    const b = `boards/${board.uuid}`;
    const d1 = await createCard(deps, actor, { board: b, title: "review one", column_key: "review" });
    const t1 = await createCard(deps, actor, { board: b, title: "backlog one", column_key: "backlog" });

    const moved = await moveCard(deps, actor, t1.uuid, { column: "review" });
    expect(moved.columnKey).toBe("review");
    expect(moved.rank).toBeGreaterThan(d1.rank);
  });
});

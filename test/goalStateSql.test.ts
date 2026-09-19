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
import type { ListScope } from "../src/domain/access";
import { goalPace, staleDays, STALE_AFTER_DAYS } from "../src/domain/goals";
import { weightedProgress } from "../web/src/lib/goalMeasure";
import { listGoals, GOAL_STATES, type GoalState, type GoalCounts } from "../src/services/goals";
import { orgToday, dayStartMs } from "../src/services/orgDay";

/** Fixture dates anchored on the ORG calendar day, which is what the SQL compares against. */
const orgDayFn = (ymd: string) => (offset: number) => new Date(dayStartMs(ymd) + offset * DAY);

// ONE DEFINITION OF "THIS GOAL IS IN TROUBLE", NOW IN TWO LANGUAGES.
//
// `domain/goals.ts` answers pace and silence per ROW, for the serializer. `services/goals.ts#goalStateSql`
// answers the same questions in SQL, because "how many of the org's goals are behind" cannot be answered a row
// at a time - and the chips above a goals list were answering it from the 100 rows the browser happened to hold.
//
// Two implementations of one rule is exactly the drift `test/goalStateDrift.test.ts` exists to stop between the
// client and the server. This is the same guard for the SQL: every goal below is classified by the TypeScript
// rules and by a real query, and the two sets have to match - including at each boundary, which is where an
// off-by-one in a rounding or an inclusive range actually lands.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const DAY = 86_400_000;
let deps: Deps;
const b = env as unknown as Bindings;
const ALL: ListScope = { breadth: "all", deptCode: null, ownerId: null, seeRestricted: true };

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

const TABLES = [schema.goalComments, schema.goals, schema.employees, schema.users, schema.roles, schema.settings];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

async function seedActor(): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: `04-${genId().slice(0, 3)}`, firstName: "Owner", lastName: "User", workEmail: `${employeeId}@test.example`, status: "active" });
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role: "employee", employeeId });
  return { uuid, email: `${uuid}@test.example`, role: "employee", status: "active", employeeId, employeeCode: null } as unknown as AppUser;
}

type Row = typeof schema.goals.$inferSelect;

/** A goal written straight to the table, so each field the rules read can be placed exactly. */
async function goal(employeeId: string, title: string, g: Partial<Row>): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.goals).values({
    uuid,
    code: `05-${genId().slice(0, 4)}`,
    employeeId,
    title,
    progress: 0,
    status: "in_progress",
    stage: "AGREED",
    createdAt: new Date(Date.now() - 60 * DAY),
    updatedAt: new Date(),
    ...g,
  } as typeof schema.goals.$inferInsert);
  return uuid;
}

const titlesFor = async (state: GoalState) =>
  (await listGoals(deps, ALL, 100, undefined, { state })).items.map((g) => (g as { title: string }).title).sort();

describe("the SQL health states match the rules the serializer uses", () => {
  it("classifies the same goals as domain/goals.ts does, state by state", async () => {
    const actor = await seedActor();
    const me = actor.employeeId!;
    const now = Date.now();
    // THE ORG'S CALENDAR DAY, not the UTC one - the same source `goalStateSql` is handed. The default org
    // timezone is Asia/Kolkata, so between 18:30 and midnight UTC the two disagree, and a fixture built from
    // `toISOString().slice(0, 10)` puts "due today" on yesterday and every boundary case one day out. That is
    // the trap this codebase keeps `services/orgDay.ts` for, and a test is not exempt from it.
    const todayMs = dayStartMs(await orgToday(deps));
    const day = (offset: number) => new Date(todayMs + offset * DAY);

    // A spread that lands on every state and on the edges between them.
    await goal(me, "overdue by a day", { dueDate: day(-1), progress: 50 });
    await goal(me, "due today", { dueDate: day(0), progress: 50 });
    await goal(me, "due in a week", { dueDate: day(7), progress: 50 });
    await goal(me, "due in eight days", { dueDate: day(8), progress: 50 });
    await goal(me, "finished and late", { dueDate: day(-30), progress: 100, status: "completed" });
    await goal(me, "cancelled and late", { dueDate: day(-30), progress: 10, status: "cancelled" });
    // Pace: set 60 days ago, due in 30 - so ~two thirds elapsed and a goal at 10% is far behind, one at 70% is not.
    await goal(me, "behind on pace", { dueDate: day(30), progress: 10 });
    await goal(me, "ahead on pace", { dueDate: day(30), progress: 90 });
    // The owner's own call counts even when the arithmetic is happy.
    await goal(me, "owner says at risk", { dueDate: day(30), progress: 90, confidence: "at_risk" });
    await goal(me, "owner says off track", { dueDate: day(30), progress: 90, confidence: "off_track" });
    await goal(me, "owner says on track", { dueDate: day(30), progress: 90, confidence: "on_track" });
    // Back-dated: due before it was set, so there is no line to be behind (the domain returns null).
    await goal(me, "due before it was set", { createdAt: new Date(now), dueDate: day(-5), progress: 0 });
    // No due date at all: cannot be behind, can be silent.
    await goal(me, "no date, untouched", { dueDate: null, updatedAt: new Date(now - (STALE_AFTER_DAYS + 1) * DAY) });
    await goal(me, "no date, fresh", { dueDate: null, updatedAt: new Date(now) });
    // Silence boundary, and the comment that breaks it.
    await goal(me, "quiet by a day", { dueDate: day(30), progress: 60, updatedAt: new Date(now - (STALE_AFTER_DAYS + 1) * DAY) });
    await goal(me, "quiet to the hour", { dueDate: day(30), progress: 60, updatedAt: new Date(now - STALE_AFTER_DAYS * DAY - 3600_000) });
    await goal(me, "one day short of quiet", { dueDate: day(30), progress: 60, updatedAt: new Date(now - (STALE_AFTER_DAYS - 1) * DAY) });
    const commented = await goal(me, "old row, recent comment", { dueDate: day(30), progress: 60, updatedAt: new Date(now - 90 * DAY) });
    await deps.db.insert(schema.goalComments).values({ goalId: commented, authorId: me, authorEmail: "a@test.example", body: "still going", createdAt: new Date(now - DAY) });
    // The handshake, and a goal nobody has begun.
    await goal(me, "a draft", { stage: "DRAFT" });
    await goal(me, "waiting for approval", { stage: "PROPOSED" });
    await goal(me, "not begun", { status: "not_started" });

    // The same rows, read back and classified by the TypeScript rules - the ones the serializer emits from.
    const rows = (await deps.db.select().from(schema.goals)) as Row[];
    const lastComment = new Map<string, Date>();
    for (const c of await deps.db.select().from(schema.goalComments)) {
      const at = new Date(Number(c.createdAt));
      const held = lastComment.get(c.goalId);
      if (!held || at > held) lastComment.set(c.goalId, at);
    }
    const isOpen = (r: Row) => r.status === "not_started" || r.status === "in_progress";
    const expected: Record<GoalState, (r: Row) => boolean> = {
      active: isOpen,
      overdue: (r) => isOpen(r) && !!r.dueDate && +new Date(r.dueDate) < todayMs,
      due_soon: (r) => isOpen(r) && !!r.dueDate && +new Date(r.dueDate) >= todayMs && +new Date(r.dueDate) <= todayMs + 7 * DAY,
      at_risk: (r) => {
        if (!isOpen(r)) return false;
        if (r.confidence === "at_risk" || r.confidence === "off_track") return true;
        const pace = goalPace(r, now);
        return pace?.state === "behind" || pace?.state === "at_risk";
      },
      quiet: (r) => isOpen(r) && (staleDays(r, lastComment.get(r.uuid), now) ?? 0) >= STALE_AFTER_DAYS,
      unagreed: (r) => r.stage !== "AGREED",
      trouble: (r) => expected.overdue(r) || expected.at_risk(r) || expected.quiet(r),
      not_started: (r) => r.status === "not_started",
      in_progress: (r) => r.status === "in_progress",
      completed: (r) => r.status === "completed",
      cancelled: (r) => r.status === "cancelled",
    };

    for (const state of GOAL_STATES) {
      const want = rows.filter(expected[state]).map((r) => r.title).sort();
      expect(await titlesFor(state), `state=${state}`).toEqual(want);
      // A state that matched nothing proves nothing about the two implementations agreeing.
      expect(want.length, `the fixture exercises state=${state}`).toBeGreaterThan(0);
    }
  });

  it("asks the health questions only of open goals", async () => {
    // A completed goal has arrived at whatever it arrived at, and a red chip on delivered work is a permanent
    // accusation. The domain says this by returning null for pace and staleness; the SQL says it with `open`.
    const actor = await seedActor();
    const me = actor.employeeId!;
    const long = new Date(Date.now() - 200 * DAY);
    for (const status of ["completed", "cancelled"] as const) {
      await goal(me, `finished ${status}`, { status, dueDate: new Date(Date.now() - 90 * DAY), progress: 5, updatedAt: long, confidence: "off_track" });
    }
    for (const state of ["overdue", "due_soon", "at_risk", "quiet", "active"] as const) {
      expect(await titlesFor(state), `state=${state}`).toEqual([]);
    }
    expect(await titlesFor("completed")).toEqual(["finished completed"]);
    expect(await titlesFor("cancelled")).toEqual(["finished cancelled"]);
  });

  it("counts the whole filtered set, not the page returned beside it", async () => {
    // The point of the whole exercise. The SPA counted `rows` - one server page - so every chip above a goals
    // list was a statement about 100 rows dressed as a statement about the org.
    const actor = await seedActor();
    const me = actor.employeeId!;
    const day = orgDayFn(await orgToday(deps));
    for (let i = 0; i < 12; i++) await goal(me, `goal ${i}`, { dueDate: i < 4 ? day(-1) : day(30), progress: 50 });

    const page = await listGoals(deps, ALL, 5, undefined, { withCounts: true });
    expect(page.items).toHaveLength(5);
    const counts = (page as { extra?: { counts?: GoalCounts } }).extra?.counts;
    expect(counts?.states.all).toBe(12);
    expect(counts?.states.overdue).toBe(4);
  });

  it("counts every chip over the set the OTHER filters leave, so a pressed chip does not zero its neighbours", async () => {
    // A chip says what pressing it would show. Counted over the state-filtered set, "Overdue 4" would sit
    // beside "At risk 0" the moment Overdue was pressed - and the reader would conclude the risk had gone.
    const actor = await seedActor();
    const me = actor.employeeId!;
    const day = orgDayFn(await orgToday(deps));
    await goal(me, "late", { dueDate: day(-1), progress: 50 });
    await goal(me, "slipping", { dueDate: day(30), progress: 0 });
    await goal(me, "a draft", { stage: "DRAFT" });

    const page = await listGoals(deps, ALL, 100, undefined, { state: "overdue", withCounts: true });
    expect(page.items).toHaveLength(1); // the rows ARE narrowed
    const counts = (page as { extra?: { counts?: GoalCounts } }).extra?.counts;
    expect(counts?.states.all).toBe(3);
    expect(counts?.states.overdue).toBe(1);
    // Two, and deliberately: the states OVERLAP. A goal past its date is almost always behind its pace as well
    // (the line ran out), so the chips are not a partition and their numbers do not add up to `all`.
    expect(counts?.states.at_risk).toBe(2);
    expect(counts?.states.unagreed).toBe(1);
  });

  it("counts only what the caller's scope can list", async () => {
    // Same binding as the list itself (`applyScope`), so the number always equals what the caller would have
    // counted from the rows. A count that sees further than the list is a disclosure.
    const actor = await seedActor();
    const mine = actor.employeeId!;
    const other = genId();
    await deps.db.insert(schema.employees).values({ uuid: other, code: "04-oth", firstName: "Otto", lastName: "Other", workEmail: "oth@test.example", status: "active" });
    await goal(mine, "mine", {});
    await goal(other, "theirs", {});
    await goal(other, "theirs too", {});

    const own = { breadth: "own", deptCode: null, ownerId: mine, seeRestricted: false } as ListScope;
    const page = await listGoals(deps, own, 100, undefined, { withCounts: true });
    const counts = (page as { extra?: { counts?: GoalCounts } }).extra?.counts;
    expect(page.items).toHaveLength(1);
    expect(counts?.states.all).toBe(1);
    expect(counts?.owners.map((o) => o.employee)).toEqual([`employees/${mine}`]);
  });

  it("rolls a mixed set up by the mean, exactly as the shared rule does", async () => {
    // The rule's whole point: weight only when EVERY goal carries one, otherwise the plain mean, so no goal is
    // ever left out of the number. A set with one unweighted goal in it is the case the two answers differ on.
    const actor = await seedActor();
    const me = actor.employeeId!;
    await goal(me, "weighted", { weight: 80, progress: 100 });
    await goal(me, "unweighted", { weight: 0, progress: 0 });

    const page = await listGoals(deps, ALL, 100, undefined, { withCounts: true });
    const owner = ((page as { extra?: { counts?: GoalCounts } }).extra?.counts?.owners ?? [])[0]!;
    expect(owner.progress).toBe(weightedProgress([{ weight: 80, progress: 100 }, { weight: 0, progress: 0 }]));
    expect(owner.progress).toBe(50); // the mean, not 100
  });

  it("rolls up per owner: how many are in flight, how many are late, and what their weights total", async () => {
    const actor = await seedActor();
    const a = actor.employeeId!;
    const bId = genId();
    await deps.db.insert(schema.employees).values({ uuid: bId, code: "04-bee", firstName: "Bee", lastName: "Keeper", workEmail: "bee@test.example", status: "active" });
    const day = orgDayFn(await orgToday(deps));
    await goal(a, "a1", { weight: 60, progress: 40, dueDate: day(-2) });
    await goal(a, "a2", { weight: 60, progress: 60, dueDate: day(30) });
    await goal(a, "a-done", { weight: 99, progress: 100, status: "completed" });
    await goal(bId, "b1", { weight: 10, progress: 0, dueDate: day(30) });

    const page = await listGoals(deps, ALL, 100, undefined, { withCounts: true });
    const owners = (page as { extra?: { counts?: GoalCounts } }).extra?.counts?.owners ?? [];
    const first = owners.find((o) => o.employee === `employees/${a}`)!;
    // The finished goal is not in flight, so it is in none of these: an over-100 spread is about OPEN weights.
    expect(first.active).toBe(2);
    expect(first.overdue).toBe(1);
    expect(first.weight).toBe(120);
    // The shared weighting rule, so this figure and the one a review scores are the same arithmetic.
    expect(first.progress).toBe(weightedProgress([{ weight: 60, progress: 40 }, { weight: 60, progress: 60 }]));
    expect(owners.find((o) => o.employee === `employees/${bId}`)!.active).toBe(1);
  });

  it("narrows to one manager's reports", async () => {
    const actor = await seedActor();
    const manager = genId();
    await deps.db.insert(schema.employees).values({ uuid: manager, code: "04-mgr", firstName: "Mara", lastName: "Manager", workEmail: "mgr@test.example", status: "active" });
    const report = genId();
    await deps.db.insert(schema.employees).values({ uuid: report, code: "04-rep", firstName: "Ravi", lastName: "Report", workEmail: "rep@test.example", status: "active", managerId: manager });
    const elsewhere = genId();
    await deps.db.insert(schema.employees).values({ uuid: elsewhere, code: "04-els", firstName: "Elsa", lastName: "Elsewhere", workEmail: "els@test.example", status: "active" });

    await goal(report, "the report's goal", {});
    await goal(elsewhere, "somebody else's goal", {});
    await goal(manager, "the manager's own goal", {});
    await goal(actor.employeeId!, "the actor's goal", {});

    const titles = (await listGoals(deps, ALL, 100, undefined, { manager: `employees/${manager}` })).items.map((g) => (g as { title: string }).title);
    // Their reports' goals, and not their own: "my team" is the people who report to me.
    expect(titles).toEqual(["the report's goal"]);
  });
});

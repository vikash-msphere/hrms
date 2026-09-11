/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { runScheduledAutomations, invalidateAutomationCache, withDispatchBudget, dispatchAutomations, MAX_TOTAL_DISPATCHES } from "../src/services/automationEngine";
import { computeEmployeeMetrics } from "../src/services/scheduledMetrics";
import { queueForDigest, flushDigests } from "../src/services/notificationDigest";
import { activeDelegatesFor } from "../src/services/approvalDelegations";
import { SCHEDULE_TRIGGER, type Schedule, type Condition, type Action } from "../src/domain/automations";
import { genId } from "../src/lib/idCodec";

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

const TABLES = [
  schema.notificationDigestQueue, schema.notifications, schema.overtimeRequests, schema.approvalDelegations,
  schema.automationRuns, schema.automations, schema.cards, schema.boards, schema.reviews, schema.reviewCycles,
  schema.goals, schema.employees,
];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

async function seedEmployee(over: Partial<typeof schema.employees.$inferInsert> = {}): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.employees).values({
    uuid, code: over.code ?? `04-${genId().slice(0, 3)}`, firstName: "Test", lastName: "User",
    workEmail: `${uuid}@test.example`, status: "active", ...over,
  });
  return uuid;
}

async function seedScheduledRule(opts: { schedule: Schedule; condition?: Condition | null; actions: Action[]; enabled?: boolean }) {
  await deps.db.insert(schema.automations).values({
    uuid: genId(), code: `aut-${genId().slice(0, 4)}`, name: "sched", description: "",
    triggerType: SCHEDULE_TRIGGER, conditionJson: opts.condition ? JSON.stringify(opts.condition) : null,
    actionsJson: JSON.stringify(opts.actions), scheduleJson: JSON.stringify(opts.schedule), disabled: opts.enabled === false,
  });
  invalidateAutomationCache();
}

const notifsFor = (emp: string) => deps.db.select().from(schema.notifications).where(eq(schema.notifications.recipientId, emp));

describe("scheduled automations", () => {
  it("fires a due 'once' broadcast rule and is idempotent within the same day", async () => {
    const emp = await seedEmployee();
    // A daily rule is always due; broadcast to everyone.
    await seedScheduledRule({ schedule: { freq: "daily", scope: "once" }, actions: [{ kind: "notifyAudience", audience: { kind: "everyone" }, title: "Daily standup" }] });

    const first = await runScheduledAutomations(deps);
    expect(first).toBe(1);
    expect((await notifsFor(emp)).length).toBe(1);

    // Second run same day: the per-day guard prevents a re-fire.
    const second = await runScheduledAutomations(deps);
    expect(second).toBe(0);
    expect((await notifsFor(emp)).length).toBe(1);
  });

  it("perEmployee rule fires only for managers whose pendingApprovals meets the condition", async () => {
    const busyMgr = await seedEmployee({ code: "04-100" });
    const idleMgr = await seedEmployee({ code: "04-101" });
    const report = await seedEmployee({ code: "04-102", managerId: busyMgr });
    // One PENDING overtime request owned by the report -> counts against busyMgr's pendingApprovals.
    await deps.db.insert(schema.overtimeRequests).values({ uuid: genId(), code: "ot-1", employeeId: report, date: new Date(0), startTime: new Date(0), endTime: new Date(3600_000), state: "PENDING" });

    await seedScheduledRule({
      schedule: { freq: "daily", scope: "perEmployee" },
      condition: { field: "pendingApprovals", op: "gte", value: 1 },
      actions: [{ kind: "notify", recipient: { of: "subject" }, title: "Approvals waiting" }],
    });

    const fired = await runScheduledAutomations(deps);
    expect(fired).toBe(1); // only the busy manager
    expect((await notifsFor(busyMgr)).length).toBe(1);
    expect((await notifsFor(idleMgr)).length).toBe(0);
    expect((await notifsFor(report)).length).toBe(0);
  });

  it("perEmployee goal metrics: overdue and due-soon goals fire only for their owner", async () => {
    const slipping = await seedEmployee({ code: "04-110" });
    const onTrack = await seedEmployee({ code: "04-111" });
    const day = 86_400_000;
    const now = +deps.clock.now();
    const goal = (employeeId: string, dueOffsetDays: number | null, status: "not_started" | "in_progress" | "completed" = "in_progress") =>
      deps.db.insert(schema.goals).values({
        uuid: genId(), code: `g-${genId().slice(0, 4)}`, employeeId, title: "g", status,
        dueDate: dueOffsetDays == null ? null : new Date(now + dueOffsetDays * day),
      });
    await goal(slipping, -3); // overdue
    await goal(slipping, 2); // due soon
    await goal(onTrack, 30); // comfortably out
    await goal(onTrack, -10, "completed"); // closed goals never count
    await goal(onTrack, null); // undated never counts

    await seedScheduledRule({
      schedule: { freq: "daily", scope: "perEmployee" },
      condition: { field: "goalsOverdue", op: "gte", value: 1 },
      actions: [{ kind: "notify", recipient: { of: "subject" }, title: "Overdue goals" }],
    });

    const fired = await runScheduledAutomations(deps);
    expect(fired).toBe(1);
    expect((await notifsFor(slipping)).length).toBe(1);
    expect((await notifsFor(onTrack)).length).toBe(0);
  });

  it("does not fire a weekly rule on the wrong weekday", async () => {
    await seedEmployee();
    // Pick a weekday that is definitely not today.
    const notToday = (new Date().getUTCDay() + 3) % 7;
    await seedScheduledRule({ schedule: { freq: "weekly", day: notToday, scope: "once" }, actions: [{ kind: "notifyAudience", audience: { kind: "everyone" }, title: "x" }] });
    expect(await runScheduledAutomations(deps)).toBe(0);
  });

  it("perEmployee task metrics fire for the ASSIGNEE, not the card's owner", async () => {
    const owner = await seedEmployee({ code: "04-120" });
    const doer = await seedEmployee({ code: "04-121" });
    const board = genId();
    await deps.db.insert(schema.boards).values({ uuid: board, code: `01-${genId().slice(0, 3)}`, name: "Board" });
    const day = 86_400_000;
    const now = +deps.clock.now();
    await deps.db.insert(schema.cards).values({
      uuid: genId(), code: `c-${genId().slice(0, 4)}`, boardId: board, employeeId: owner, assigneeId: doer,
      columnKey: "doing", rank: 1, title: "late", dueDate: new Date(now - 3 * day),
    });

    await seedScheduledRule({
      schedule: { freq: "daily", scope: "perEmployee" },
      condition: { field: "tasksOverdue", op: "gte", value: 1 },
      actions: [{ kind: "notify", recipient: { of: "subject" }, title: "Overdue tasks" }],
    });

    expect(await runScheduledAutomations(deps)).toBe(1);
    expect((await notifsFor(doer)).length).toBe(1);
    // The card is the owner's row, but it is not in the owner's queue - chasing them would be chasing the
    // wrong person, and it is the reason these count off `assignee_id`.
    expect((await notifsFor(owner)).length).toBe(0);
  });
});

// The metric arithmetic itself, asserted directly: a rule firing proves the wiring, and these prove the
// numbers the rules compare against.
describe("scheduled metrics", () => {
  const day = 86_400_000;
  const boardWith = async () => {
    const board = genId();
    await deps.db.insert(schema.boards).values({ uuid: board, code: `01-${genId().slice(0, 3)}`, name: "Board" });
    return board;
  };
  const card = (board: string, assigneeId: string | null, over: Partial<typeof schema.cards.$inferInsert> = {}) =>
    deps.db.insert(schema.cards).values({
      uuid: genId(), code: `c-${genId().slice(0, 4)}`, boardId: board, employeeId: over.employeeId ?? assigneeId ?? genId(),
      assigneeId, columnKey: "doing", rank: 1, title: "card", ...over,
    });

  it("counts a person's open tasks by lateness and by block, and drops the ones that are finished or gone", async () => {
    const me = await seedEmployee({ code: "04-130" });
    const board = await boardWith();
    const now = +deps.clock.now();
    await card(board, me, { dueDate: new Date(now - 2 * day) }); // overdue
    await card(board, me, { dueDate: new Date(now + 3 * day) }); // due soon
    await card(board, me, { dueDate: new Date(now + 30 * day) }); // comfortably out
    await card(board, me, { blocked: true }); // blocked, undated
    await card(board, me, { dueDate: new Date(now - 5 * day), deliveredAt: new Date(now - day) }); // delivered late: finished work
    await card(board, me, { dueDate: new Date(now - 5 * day), deleteTime: new Date(now) }); // binned
    await card(board, null, { dueDate: new Date(now - 5 * day), employeeId: me }); // unassigned: nobody's queue

    const m = (await computeEmployeeMetrics(deps, [{ uuid: me, managerId: null }])).get(me)!;
    expect({ due: m.tasksDueSoon, over: m.tasksOverdue, blocked: m.tasksBlocked }).toEqual({ due: 1, over: 1, blocked: 1 });
  });

  it("puts a self-assessment on the employee and a write-up on their manager, inside an ACTIVE cycle only", async () => {
    const mgr = await seedEmployee({ code: "04-140" });
    const a = await seedEmployee({ code: "04-141", managerId: mgr });
    const bEmp = await seedEmployee({ code: "04-142", managerId: mgr });
    const c = await seedEmployee({ code: "04-143", managerId: mgr });
    const cycle = async (state: "DRAFT" | "ACTIVE" | "CLOSED") => {
      const uuid = genId();
      await deps.db.insert(schema.reviewCycles).values({ uuid, code: `rc-${genId().slice(0, 4)}`, name: state, state });
      return uuid;
    };
    const active = await cycle("ACTIVE");
    const draft = await cycle("DRAFT");
    const review = (employeeId: string, cycleId: string, state: "SELF" | "MANAGER" | "SHARED") =>
      deps.db.insert(schema.reviews).values({ uuid: genId(), code: `rv-${genId().slice(0, 4)}`, cycleId, employeeId, state });
    await review(a, active, "SELF"); // a owes their own
    await review(bEmp, active, "MANAGER"); // the manager owes b's
    await review(c, active, "SHARED"); // done: owes nobody
    await review(c, draft, "SELF"); // a cycle HR is still building chases nobody

    const roster = [mgr, a, bEmp, c].map((uuid) => ({ uuid, managerId: uuid === mgr ? null : mgr }));
    const metrics = await computeEmployeeMetrics(deps, roster);
    expect(metrics.get(a)!.selfReviewsDue).toBe(1);
    expect(metrics.get(c)!.selfReviewsDue).toBe(0);
    expect(metrics.get(mgr)!.teamReviewsDue).toBe(1);
    expect(metrics.get(mgr)!.selfReviewsDue).toBe(0);
  });

  it("counts goal-setting as missing until a live goal exists in the cycle, and tells the manager how many", async () => {
    const mgr = await seedEmployee({ code: "04-150" });
    const filed = await seedEmployee({ code: "04-151", managerId: mgr });
    const empty = await seedEmployee({ code: "04-152", managerId: mgr });
    const cancelledOnly = await seedEmployee({ code: "04-153", managerId: mgr });
    const cycle = genId();
    const now = +deps.clock.now();
    await deps.db.insert(schema.reviewCycles).values({
      uuid: cycle, code: `rc-${genId().slice(0, 4)}`, name: "H1", state: "ACTIVE", goalSettingDueDate: new Date(now + 7 * day),
    });
    // A cycle with no goal-setting date asks for nothing, so it can never be missing.
    const undated = genId();
    await deps.db.insert(schema.reviewCycles).values({ uuid: undated, code: `rc-${genId().slice(0, 4)}`, name: "Undated", state: "ACTIVE" });
    const goal = (employeeId: string, cycleId: string | null, status: "in_progress" | "cancelled" = "in_progress") =>
      deps.db.insert(schema.goals).values({ uuid: genId(), code: `g-${genId().slice(0, 4)}`, employeeId, cycleId, title: "g", status });
    await goal(filed, cycle);
    await goal(cancelledOnly, cycle, "cancelled"); // a called-off goal is not a goal they set
    await goal(empty, null); // a goal outside the cycle answers nothing for it

    const roster = [mgr, filed, empty, cancelledOnly].map((uuid) => ({ uuid, managerId: uuid === mgr ? null : mgr }));
    const metrics = await computeEmployeeMetrics(deps, roster);
    expect(metrics.get(filed)!.goalSettingMissing).toBe(0);
    expect(metrics.get(empty)!.goalSettingMissing).toBe(1);
    expect(metrics.get(cancelledOnly)!.goalSettingMissing).toBe(1);
    // The manager sits above two people who have filed nothing - and has filed nothing themselves, which is
    // their own count, not their team's.
    expect(metrics.get(mgr)!.teamGoalSettingMissing).toBe(2);
    expect(metrics.get(mgr)!.goalSettingMissing).toBe(1);
  });
});

describe("notification digest", () => {
  it("parks queued items and flushes them into one summary per recipient", async () => {
    const a = await seedEmployee({ code: "04-200" });
    const c = await seedEmployee({ code: "04-201" });
    await queueForDigest(deps, { recipientId: a, type: "t", title: "First" });
    await queueForDigest(deps, { recipientId: a, type: "t", title: "Second" });
    await queueForDigest(deps, { recipientId: c, type: "t", title: "Only" });

    const delivered = await flushDigests(deps);
    expect(delivered).toBe(2); // one summary each

    const an = await notifsFor(a);
    expect(an.length).toBe(1);
    expect(an[0]!.title).toContain("2 updates");
    expect((await notifsFor(c))[0]!.title).toContain("1 update");

    // Queue is drained; a second flush delivers nothing.
    expect(await flushDigests(deps)).toBe(0);
  });
});

describe("automation dispatch budget: one allowance per originating action, and drops are reported", () => {
  // The ceiling exists so a rule whose `apiCall` re-triggers its own trigger cannot loop forever. It lives on
  // the shared Deps, and the scheduled handler builds ONE Deps for the whole nightly tick - so an unreset
  // counter turned a per-action guard into a budget for the entire NIGHT: past the fiftieth event, every later
  // per-employee emission and every subsequent subtask was dropped with nothing but a console.warn to show it,
  // while the cron_runs row still stamped `done`. withDispatchBudget re-arms per subtask and hands the drop
  // count back so it can reach the row.

  it("re-arms per call and restores the caller's own counter", async () => {
    const outer = { n: 7, dropped: 0 };
    deps.automationBudget = outer;

    const { result, dropped } = await withDispatchBudget(deps, async () => {
      // Inside, the counter is fresh - the outer 7 must not eat into this action's allowance.
      expect(deps.automationBudget!.n).toBe(0);
      deps.automationBudget!.n = 3;
      deps.automationBudget!.dropped = 2;
      return "done";
    });

    expect(result).toBe("done");
    expect(dropped).toBe(2);
    // The caller's counter is handed back untouched, so a nested action cannot reset its parent's guard.
    expect(deps.automationBudget).toBe(outer);
    expect(deps.automationBudget!.n).toBe(7);
    deps.automationBudget = undefined;
  });

  it("counts what the ceiling refused, and gives the next subtask a full allowance", async () => {
    // The budget is spent by EVENT dispatch, which is what the emitting cron subtasks (probation ending, work
    // anniversary, document expiring, asset custody) do once per employee or per asset. Ten events past the
    // ceiling, so the tail is refused. Counted OFF the constant rather than off a literal: the ceiling moved
    // once already (50 -> 250, to clear the bounded bulk verbs) and a hardcoded 60 quietly stopped testing
    // anything the moment it did.
    const emp = await seedEmployee({ code: "04-900" });
    const fire = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await dispatchAutomations(deps, { type: "schedule.workAnniversary", subject: `employees/${emp}`, employeeId: emp, payload: { years: 1 }, occurredAt: new Date() }, null, 0);
      }
    };

    const first = await withDispatchBudget(deps, () => fire(MAX_TOTAL_DISPATCHES + 10).then(() => 0));
    // Ten refused, and SAID so - the number that used to exist only in Workers Logs while the cron row stayed
    // green. subtasks() turns this into the `error` state on cron_runs.
    expect(first.dropped).toBe(10);

    // A second subtask on the SAME Deps - the shape the nightly tick has, since it builds one Deps for the
    // whole night. Sharing the counter, this subtask was refused outright; re-armed, it dispatches in full.
    const second = await withDispatchBudget(deps, () => fire(10).then(() => 0));
    expect(second.dropped).toBe(0);
  });
});

describe("approval delegation lookup", () => {
  it("returns only delegates whose window covers the given date", async () => {
    const mgr = await seedEmployee({ code: "04-300" });
    const dActive = await seedEmployee({ code: "04-301" });
    const dPast = await seedEmployee({ code: "04-302" });
    const day = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
    await deps.db.insert(schema.approvalDelegations).values({ uuid: genId(), code: "ad-1", delegatorId: mgr, delegateId: dActive, fromDate: day(2026, 0, 1), toDate: day(2026, 11, 31) });
    await deps.db.insert(schema.approvalDelegations).values({ uuid: genId(), code: "ad-2", delegatorId: mgr, delegateId: dPast, fromDate: day(2025, 0, 1), toDate: day(2025, 0, 10) });

    const covering = await activeDelegatesFor(deps, mgr, day(2026, 5, 15));
    expect(covering).toEqual([dActive]);
  });
});

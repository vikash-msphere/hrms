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
import { runScheduledAutomations, invalidateAutomationCache, withDispatchBudget, dispatchAutomations } from "../src/services/automationEngine";
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
  schema.automationRuns, schema.automations, schema.goals, schema.employees,
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
    // anniversary, document expiring, asset custody) do once per employee or per asset. Sixty events crosses
    // the fifty ceiling, so the tail is refused.
    const emp = await seedEmployee({ code: "04-900" });
    const fire = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await dispatchAutomations(deps, { type: "schedule.workAnniversary", subject: `employees/${emp}`, employeeId: emp, payload: { years: 1 }, occurredAt: new Date() }, null, 0);
      }
    };

    const first = await withDispatchBudget(deps, () => fire(60).then(() => 0));
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

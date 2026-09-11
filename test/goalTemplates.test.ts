/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { applyGoalTemplate } from "../src/services/goalTemplates";
import { orgDayFromToday } from "../src/services/orgDay";
import { createGoal } from "../src/services/goals";
import { createReviewCycle } from "../src/services/reviewCycles";
import { grantFor } from "../src/domain/grants";
import { DEFAULT_POLICY } from "../src/domain/manifests";

// Goal templates: a blueprint, and the press that stamps it onto people. The interesting parts are that an
// applied goal is an ORDINARY goal (same code, audit, notification, stage) and that applying twice is a no-op
// rather than a pile of duplicates.
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

const TABLES = [schema.goalComments, schema.goals, schema.goalTemplates, schema.reviewCycles, schema.notifications, schema.auditLog, schema.eventLog, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
});

async function seedActor(): Promise<AppUser & { employeeId: string }> {
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({
    uuid: employeeId, code: `04-${genId().slice(0, 3)}`, firstName: "Test", lastName: "User",
    workEmail: `${employeeId}@test.example`, status: "active",
  });
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role: "employee", employeeId });
  return { uuid, email: `${uuid}@test.example`, role: "employee", status: "active", employeeId, employeeCode: null, grant: grantFor("super_admin"), policy: DEFAULT_POLICY } as unknown as AppUser & { employeeId: string };
}

async function seedTemplate(fields: Partial<typeof schema.goalTemplates.$inferInsert> = {}) {
  const uuid = genId();
  await deps.db.insert(schema.goalTemplates).values({
    uuid, code: `gt-${genId().slice(0, 4)}`, title: "Complete security training", weight: 20, dueInDays: 30, ...fields,
  });
  return uuid;
}

describe("applying a goal template", () => {
  it("writes an ordinary goal - code, owner, weight, and a date computed from the interval", async () => {
    const actor = await seedActor();
    const target = await seedActor();
    const tpl = await seedTemplate();

    const res = await applyGoalTemplate(deps, actor, tpl, [`employees/${target.employeeId}`]);
    expect(res._applied).toBe(1);

    const [goal] = await deps.db.select().from(schema.goals);
    expect(goal!.title).toBe("Complete security training");
    expect(goal!.employeeId).toBe(target.employeeId);
    expect(goal!.weight).toBe(20);
    expect(goal!.code).toBeTruthy(); // allocated the same way a hand-written goal's is
    // The template holds "30 days"; the goal holds the date that lands on - counted in the ORG's day, the way
    // the service counts it (services/orgDay.ts). Computed here as `now + 30 days` in UTC, this assertion
    // failed for the hours of every day when the two calendars disagree - from 18:30 UTC for an IST org - on
    // code that was doing exactly the right thing.
    const expected = await orgDayFromToday(deps, 30);
    expect(new Date(goal!.dueDate!).toISOString().slice(0, 10)).toBe(expected);
    // And the owner hears about it, because somebody else set it.
    const notes = await deps.db.select().from(schema.notifications);
    expect(notes.some((n) => n.recipientId === target.employeeId && n.type === "goal.assigned")).toBe(true);
  });

  it("starts a measured template at its baseline rather than at nothing", async () => {
    const actor = await seedActor();
    const target = await seedActor();
    const tpl = await seedTemplate({ title: "Cut churn", baselineValue: 8, targetValue: 4, unit: "%" });

    await applyGoalTemplate(deps, actor, tpl, [`employees/${target.employeeId}`]);
    const [goal] = await deps.db.select().from(schema.goals);
    expect(goal!.currentValue).toBe(8);
    expect(goal!.progress).toBe(0); // at the baseline, none of the distance is travelled
  });

  it("skips somebody who already holds it in the same cycle, so a double press is a no-op", async () => {
    const actor = await seedActor();
    const target = await seedActor();
    const tpl = await seedTemplate();

    const first = await applyGoalTemplate(deps, actor, tpl, [`employees/${target.employeeId}`]);
    const second = await applyGoalTemplate(deps, actor, tpl, [`employees/${target.employeeId}`]);
    expect(first._applied).toBe(1);
    expect(second._applied).toBe(0);
    expect(second._skipped).toBe(1);
    expect(await deps.db.select().from(schema.goals)).toHaveLength(1);
  });

  it("treats the same goal in a DIFFERENT cycle as a new goal", async () => {
    const actor = await seedActor();
    const target = await seedActor();
    const tpl = await seedTemplate();
    const cycle = await createReviewCycle(deps, actor, { name: "H1", period_start: "2026-01-01", period_end: "2026-06-30" });

    await applyGoalTemplate(deps, actor, tpl, [`employees/${target.employeeId}`]);
    const inCycle = await applyGoalTemplate(deps, actor, tpl, [`employees/${target.employeeId}`], `review-cycles/${cycle.uuid}`);
    expect(inCycle._applied).toBe(1);
    const goals = await deps.db.select().from(schema.goals);
    expect(goals).toHaveLength(2);
    expect(goals.filter((g) => g.cycleId === cycle.uuid)).toHaveLength(1);
  });

  it("applies to a whole list at once and records who it touched", async () => {
    const actor = await seedActor();
    const a = await seedActor();
    const c = await seedActor();
    const tpl = await seedTemplate({ dueInDays: null });

    const res = await applyGoalTemplate(deps, actor, tpl, [`employees/${a.employeeId}`, `employees/${c.employeeId}`, `employees/${a.employeeId}`]);
    expect(res._applied).toBe(2); // the duplicate reference is one person
    expect((await deps.db.select().from(schema.goals)).every((g) => g.dueDate === null)).toBe(true);
    const entry = (await deps.db.select().from(schema.auditLog)).find((e) => e.action === "goal-template.apply");
    expect(JSON.parse(entry!.meta ?? "{}").note).toMatch(/created 2 goals/);
  });

  // `apply` builds goal rows itself rather than calling createGoal once per employee (that cost 16 D1
  // statements a head, and the verb accepts 200 employees against a 1,000-subrequest invocation ceiling). The
  // price of not going through createGoal is that the two can drift, so this compares the row each writes.
  it("writes the same row createGoal would, field for field", async () => {
    const actor = await seedActor();
    const viaTemplate = await seedActor();
    const byHand = await seedActor();
    const tpl = await seedTemplate({ title: "Cut churn", weight: 25, dueInDays: 45, unit: "%", baselineValue: 8, targetValue: 4, description: "quarterly" });

    await applyGoalTemplate(deps, actor, tpl, [`employees/${viaTemplate.employeeId}`]);
    // The hand-written goal is given the date the TEMPLATE would land on, counted the same way the service
    // counts it - in the org's day, not in UTC (see the note on the first test).
    const due = await orgDayFromToday(deps, 45);
    await createGoal(deps, actor, {
      employee: `employees/${byHand.employeeId}`,
      title: "Cut churn", description: "quarterly", weight: 25, due_date: due,
      unit: "%", baseline_value: 8, target_value: 4, current_value: 8,
    });

    const goals = await deps.db.select().from(schema.goals);
    const applied = goals.find((g) => g.employeeId === viaTemplate.employeeId)!;
    const handwritten = goals.find((g) => g.employeeId === byHand.employeeId)!;
    // Everything except the identity/ownership columns and the server clock has to match.
    const shape = (g: typeof applied) => {
      const { uuid, code, employeeId, createdAt, updatedAt, agreedAt, agreedById, ...rest } = g;
      return rest;
    };
    expect(shape(applied)).toEqual(shape(handwritten));
    // The stage rule is per-employee, not per-run: both were written FOR someone else, so both are agreed.
    expect(applied.stage).toBe(handwritten.stage);
    expect(applied.agreedById).toBe(handwritten.agreedById);
  });

  // The reason `apply` does not loop `createGoal`: every D1 round trip is a Worker SUBREQUEST, the ceiling is
  // 1,000 per invocation, and this verb accepts 200 employees. Looped it cost 16 a head (15 inside createGoal
  // plus one de-duplicating read), which is ~3,200 - so the press died partway through on any real team,
  // having already created goals for the first sixty. This pins the shape, not a number: naming four times as
  // many people must not cost four times as much.
  it("costs the same number of round trips however many people it names", async () => {
    const actor = await seedActor();
    const tpl = await seedTemplate();
    const people: string[] = [];
    for (let i = 0; i < 12; i++) people.push((await seedActor()).employeeId);

    // A round trip is `batch()` once, or a prepared statement actually executed. Preparing a statement that
    // then rides inside a batch costs nothing, and `prepare(q).bind(...)` returns a NEW statement - so the
    // executors have to be wrapped on whatever `bind` hands back too, or this counts nothing at all.
    const count = async (refs: string[]) => {
      const seen: string[] = [];
      const real = (deps.db as any).session.client;
      const prepare = real.prepare.bind(real);
      const batch = real.batch.bind(real);
      const wrap = (st: any, q: string): any => {
        let charged = false;
        for (const m of ["run", "all", "first", "raw", "values"]) {
          const fn = st[m]?.bind(st);
          if (fn) st[m] = (...a: unknown[]) => { if (!charged) { charged = true; seen.push(q); } return fn(...a); };
        }
        const bind = st.bind?.bind(st);
        if (bind) st.bind = (...a: unknown[]) => wrap(bind(...a), q);
        return st;
      };
      real.prepare = (q: string) => wrap(prepare(q), q);
      real.batch = (s: unknown[]) => { seen.push("batch"); return batch(s); };
      try {
        await applyGoalTemplate(deps, actor, tpl, refs);
      } finally {
        real.prepare = prepare;
        real.batch = batch;
      }
      return seen.length;
    };

    const three = await count(people.slice(0, 3).map((e) => `employees/${e}`));
    const twelve = await count(people.slice(3).map((e) => `employees/${e}`));
    expect(three).toBeLessThanOrEqual(20);
    // Flat, not merely cheaper: four times the people, the same round trips. Past ~90 the chunked reads add a
    // few, which is why this is a small allowance rather than exact equality.
    expect(twelve).toBeLessThanOrEqual(three + 2);
  });

  it("refuses an empty list and a template that is gone", async () => {
    const actor = await seedActor();
    const tpl = await seedTemplate();
    await expect(applyGoalTemplate(deps, actor, tpl, [])).rejects.toThrow(/at least one employee/);
    await deps.db.update(schema.goalTemplates).set({ deleteTime: new Date() }).where(eq(schema.goalTemplates.uuid, tpl));
    await expect(applyGoalTemplate(deps, actor, tpl, ["employees/x"])).rejects.toThrow(/not found/);
  });
});

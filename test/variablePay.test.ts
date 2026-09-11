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
import { variablePayRun, awardVariablePay, VARIABLE_PAY_KIND } from "../src/services/variablePay";
import { createReviewCycle, launchReviewCycle } from "../src/services/reviewCycles";
import { listReviews, submitSelf, submitManager } from "../src/services/reviews";
import { createGoal } from "../src/services/goals";
import { grantFor } from "../src/domain/grants";
import { DEFAULT_POLICY } from "../src/domain/manifests";
import type { ListScope } from "../src/domain/access";

// Attainment -> money. The arithmetic is simple; what matters is that nothing is paid twice, nothing is paid
// from a number the caller supplied, and a person with no target or no score is skipped rather than guessed at.
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

const TABLES = [schema.bonuses, schema.compensation, schema.goalComments, schema.goals, schema.reviewFeedback, schema.reviews, schema.reviewCycles, schema.notifications, schema.auditLog, schema.eventLog, schema.settings, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
});

async function seedActor(managerId?: string): Promise<AppUser & { employeeId: string }> {
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({
    uuid: employeeId, code: `04-${genId().slice(0, 3)}`, firstName: "Test", lastName: "User",
    workEmail: `${employeeId}@test.example`, status: "active", ...(managerId ? { managerId } : {}),
  });
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role: "employee", employeeId });
  return { uuid, email: `${uuid}@test.example`, role: "employee", status: "active", employeeId, employeeCode: null, grant: grantFor("super_admin"), policy: DEFAULT_POLICY } as unknown as AppUser & { employeeId: string };
}

const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);

/** A compensation row with a variable-pay target, effective well before the cycle ends. */
async function seedComp(employeeId: string, target: number | null) {
  await deps.db.insert(schema.compensation).values({
    uuid: genId(), code: `c-${genId().slice(0, 4)}`, employeeId,
    ctcAnnual: 1_200_000, basePay: 50_000, specialAllowance: 0, currency: "INR",
    variablePayTarget: target, effectiveFrom: new Date(Date.now() - 365 * DAY),
  });
}

/** A launched cycle with one shared review, whose single goal sits at `progress`. */
async function cycleWith(manager: AppUser & { employeeId: string }, employee: AppUser & { employeeId: string }, progress: number) {
  const cycle = await createReviewCycle(deps, manager, { name: `Cycle ${genId().slice(0, 4)}`, period_start: ymd(Date.now() - 30 * DAY), period_end: ymd(Date.now() - DAY) });
  await createGoal(deps, manager, { title: "the work", employee: `employees/${employee.employeeId}`, weight: 100, progress, due_date: ymd(Date.now() - 5 * DAY), cycle: `review-cycles/${cycle.uuid}` });
  await launchReviewCycle(deps, manager, cycle.uuid, [`employees/${employee.employeeId}`]);
  const review = (await listReviews(deps, ALL, 100)).items.find((r) => r.employeeId === employee.employeeId)!;
  await submitSelf(deps, employee, review.uuid, "done");
  await submitManager(deps, manager, review.uuid, { overall_rating: 4 }); // freezes the goals snapshot
  return cycle;
}

describe("the variable-pay run", () => {
  it("multiplies the target by what was attained", async () => {
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);
    await seedComp(employee.employeeId, 200_000);
    const cycle = await cycleWith(manager, employee, 70);

    const { lines } = await variablePayRun(deps, ALL, cycle.uuid);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ attainment: 70, target: 200_000, recommended: 140_000 });
    expect(lines[0]!.blocked).toBeUndefined(); // payable: nothing in its way
  });

  it("says why a line cannot be paid instead of showing a blank", async () => {
    const manager = await seedActor();
    const noTarget = await seedActor(manager.employeeId);
    await seedComp(noTarget.employeeId, null);
    const cycle = await cycleWith(manager, noTarget, 80);

    const { lines } = await variablePayRun(deps, ALL, cycle.uuid);
    expect(lines[0]).toMatchObject({ attainment: 80, target: null, recommended: null, blocked: "no_target" });
  });

  it("awards the computed figure, never one supplied by the caller", async () => {
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);
    await seedComp(employee.employeeId, 100_000);
    const cycle = await cycleWith(manager, employee, 50);

    const res = await awardVariablePay(deps, manager, ALL, cycle.uuid, [`employees/${employee.employeeId}`]);
    expect(res.result).toMatchObject({ awarded: 1, total: 50_000, skipped: 0 });
    // The award hands back the run it already did, with the lines it paid patched - the route renders that
    // instead of running the whole (per-cycle) computation a second time.
    expect(res.lines[0]).toMatchObject({ awarded: 50_000, blocked: "already_awarded" });
    const [bonus] = await deps.db.select().from(schema.bonuses);
    expect(bonus!.amount).toBe(50_000);
    expect(bonus!.kind).toBe(VARIABLE_PAY_KIND);
    expect(bonus!.reason).toContain("Variable pay for");
    expect(bonus!.employeeId).toBe(employee.employeeId);
  });

  it("never pays the same cycle twice", async () => {
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);
    await seedComp(employee.employeeId, 100_000);
    const cycle = await cycleWith(manager, employee, 50);

    await awardVariablePay(deps, manager, ALL, cycle.uuid, [`employees/${employee.employeeId}`]);
    const again = await awardVariablePay(deps, manager, ALL, cycle.uuid, [`employees/${employee.employeeId}`]);
    expect(again.result).toMatchObject({ awarded: 0, skipped: 1 });
    expect(await deps.db.select().from(schema.bonuses)).toHaveLength(1);

    // And the second run reports the payment rather than re-offering it.
    const { lines } = await variablePayRun(deps, ALL, cycle.uuid);
    expect(lines[0]).toMatchObject({ awarded: 50_000, blocked: "already_awarded" });
  });

  // The sequential case above is answered by the pre-read (`awardedForCycle`), which is a read taken before
  // the write loop starts. Two runs that OVERLAP both take that read before either writes, so both saw
  // "nothing paid yet" and both paid - a double payout, on the one table where that is unrecoverable once
  // payroll has picked the bonuses up. The partial unique index `bonus_cycle_emp_idx` is what actually decides
  // it; the loser counts as skipped, exactly as the pre-read would have reported had it seen the winner.
  it("pays once when two award runs overlap", async () => {
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);
    await seedComp(employee.employeeId, 100_000);
    const cycle = await cycleWith(manager, employee, 50);

    const both = [`employees/${employee.employeeId}`];
    const [a, z] = await Promise.all([
      awardVariablePay(deps, manager, ALL, cycle.uuid, both),
      awardVariablePay(deps, manager, ALL, cycle.uuid, both),
    ]);

    // Exactly one bonus row exists, whichever run won.
    const rows = await deps.db.select().from(schema.bonuses);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(50_000);
    // And exactly one run claims to have awarded it - the other reports a skip, not a success and not a 500.
    expect(a.result.awarded + z.result.awarded).toBe(1);
    expect(a.result.skipped + z.result.skipped).toBe(1);
  });

  it("skips a zero attainment rather than writing a zero bonus", async () => {
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);
    await seedComp(employee.employeeId, 100_000);
    const cycle = await cycleWith(manager, employee, 0);

    const res = await awardVariablePay(deps, manager, ALL, cycle.uuid, [`employees/${employee.employeeId}`]);
    expect(res.result).toMatchObject({ awarded: 0, skipped: 1 });
    expect(await deps.db.select().from(schema.bonuses)).toHaveLength(0);
  });

  it("refuses a cycle nobody has launched, and an empty selection", async () => {
    const manager = await seedActor();
    const draft = await createReviewCycle(deps, manager, { name: "Draft", period_start: ymd(Date.now() - 30 * DAY), period_end: ymd(Date.now()) });
    await expect(awardVariablePay(deps, manager, ALL, draft.uuid, ["employees/x"])).rejects.toThrow(/not been launched/);
    await expect(awardVariablePay(deps, manager, ALL, draft.uuid, [])).rejects.toThrow(/at least one person/);
  });

  it("records the cycle the money came out of", async () => {
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);
    await seedComp(employee.employeeId, 80_000);
    const cycle = await cycleWith(manager, employee, 100);
    await awardVariablePay(deps, manager, ALL, cycle.uuid, [`employees/${employee.employeeId}`]);

    const entry = (await deps.db.select().from(schema.auditLog)).find((e) => e.action === "review-cycle.awardVariablePay");
    expect(entry).toBeTruthy();
    expect(entry!.entityId).toBe(cycle.uuid);
    expect(JSON.parse(entry!.meta ?? "{}").note).toMatch(/totalling 80000 INR/);
  });

  it("carries the target forward onto the next compensation revision", async () => {
    // A raise should not silently drop somebody's variable component - the next revision inherits it unless
    // the raise says otherwise.
    const { reviseCompensation } = await import("../src/services/compensation");
    const actor = await seedActor();
    await seedComp(actor.employeeId, 150_000);
    await reviseCompensation(deps, actor, { employee: `employees/${actor.employeeId}`, annual_ctc: 1_500_000, effective_from: ymd(Date.now()) });
    const rows = await deps.db.select().from(schema.compensation).where(eq(schema.compensation.employeeId, actor.employeeId));
    expect(rows.every((r) => r.variablePayTarget === 150_000)).toBe(true);
  });
});

/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { bustRef } from "../src/lib/refData";
import { carryForwardLeave } from "../src/cron";

// The year-end rollover, which is the only night of the year it does anything and the night it forfeits leave
// and creates real encashment payouts.
//
// The pure split maths is covered by test/carryForward.test.ts. What is covered HERE is the subtask around it,
// because that is where it used to spend a D1 round-trip per employee, per balance row and per leave type on a
// tick that shares one invocation's subrequest budget with twenty-one other subtasks - so a roster of any size
// ran out part-way through, leaving some people's leave forfeited and paid out and the rest untouched. The
// claims are now one batch per employee, the year's encashments one read for the whole org, and the roster is
// processed a slice at a time with the remainder handed to the job queue.
//
// The batching is only correct if it did not lose the guarantees the per-row loop had, so that is what these
// assert: a claim that loses its race is still detected and still leaves its row alone, only the rows that
// actually landed are forfeited and paid out, and a re-run stamps nobody twice.

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
  schema.leaveEncashments, schema.leaveBalances, schema.leaveTypes, schema.compensation, schema.jobs,
  schema.notifications, schema.auditLog, schema.eventLog, schema.settings, schema.users, schema.employees,
  schema.roles, schema.codeSequences,
];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  deps.refCache?.clear();
  deps.clock = { now: () => new Date() };
});

const short = (p: string) => `${p}-${genId().slice(0, 6)}`;

async function setCaps(caps: Record<string, unknown>) {
  const value = JSON.stringify(caps);
  await deps.db.insert(schema.settings).values({ key: "leave-caps", value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } });
  bustRef(deps, "settings");
}

async function seedEmployee(): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.employees).values({
    uuid, code: short("04"), firstName: "Test", lastName: `User${uuid.slice(0, 3)}`,
    workEmail: `${uuid}@test.example`, status: "active", startDate: new Date(Date.UTC(2020, 0, 1)),
  });
  return uuid;
}

async function seedLeaveType(opts: { carryForward: boolean; cap: number | null; encashable?: boolean }): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.leaveTypes).values({
    uuid, code: short("lt"), name: `Type ${uuid.slice(0, 4)}`,
    carryForward: opts.carryForward, carryForwardCapDays: opts.cap, encashable: opts.encashable ?? false,
  });
  bustRef(deps, "leave_types");
  return uuid;
}

/** A balance owed a rollover: stamped with LAST year, so the probe finds it and it actually rolls over
 *  (a never-stamped row is only initialized, which is the deliberate no-forfeiture-on-first-run rule). */
async function seedBalance(employeeId: string, leaveTypeId: string, days: number): Promise<string> {
  const uuid = genId();
  const lastYear = String(new Date().getUTCFullYear() - 1);
  await deps.db.insert(schema.leaveBalances).values({
    uuid, code: short("lb"), employeeId, leaveTypeId, balanceDays: days, lastCarryForwardYear: lastYear,
  });
  return uuid;
}

const balanceOf = async (uuid: string) =>
  (await deps.db.select().from(schema.leaveBalances).where(eq(schema.leaveBalances.uuid, uuid)).limit(1))[0]!;

const jobsOfKind = async (kind: string) =>
  (await deps.db.select().from(schema.jobs)).filter((j) => j.kind === kind);

describe("year-end carry-forward", () => {
  it("caps every balance of an employee in one pass and stamps them all", async () => {
    await setCaps({ carry_forward_mode: "per_type", carry_forward_excess: "forfeit" });
    const emp = await seedEmployee();
    const capped = await seedLeaveType({ carryForward: true, cap: 10 });
    const resets = await seedLeaveType({ carryForward: false, cap: null });
    const a = await seedBalance(emp, capped, 18);
    const z = await seedBalance(emp, resets, 7);

    const processed = await carryForwardLeave(deps);

    expect(processed).toBe(2);
    const year = String(new Date().getUTCFullYear());
    expect(await balanceOf(a)).toMatchObject({ balanceDays: 10, lastCarryForwardYear: year });
    expect(await balanceOf(z)).toMatchObject({ balanceDays: 0, lastCarryForwardYear: year });
  });

  it("is idempotent: a second run finds nothing to do", async () => {
    await setCaps({ carry_forward_mode: "per_type", carry_forward_excess: "forfeit" });
    const emp = await seedEmployee();
    const lt = await seedLeaveType({ carryForward: true, cap: 10 });
    const bal = await seedBalance(emp, lt, 18);

    expect(await carryForwardLeave(deps)).toBe(1);
    expect(await carryForwardLeave(deps)).toBe(0);
    // The absolute write must not run twice: 10 days carried, not 10 re-capped from 10 and re-forfeited.
    expect((await balanceOf(bal)).balanceDays).toBe(10);
  });

  it("rolls a balance over exactly once when two ticks run at the same time", async () => {
    // Two overlapping runs are a real case, not a contrived one: `cron-runs:run` fires a tick on demand with
    // no lock against the schedule (routes/cronTrigger.ts). Both read the same balances and both build a claim
    // for the same row, and the guards - the year stamp and the balance that was read - are what make exactly
    // one of them land. Batching the claims must not weaken that: the batch reports which statements touched
    // no row, and the loser has to leave the row and the payout alone.
    await setCaps({ carry_forward_mode: "per_type", carry_forward_excess: "encash", encashment_mode: "per_type" });
    const emp = await seedEmployee();
    await deps.db.insert(schema.compensation).values({
      uuid: genId(), code: short("cp"), employeeId: emp, basePay: 60000, specialAllowance: 0,
      currency: "INR", effectiveFrom: new Date(Date.UTC(2020, 0, 1)),
    });
    const lt = await seedLeaveType({ carryForward: true, cap: 10, encashable: true });
    const bal = await seedBalance(emp, lt, 18);

    const [a, z] = await Promise.all([carryForwardLeave(deps), carryForwardLeave(deps)]);

    // One run claimed the row; the other found it stamped (or its balance moved) and did nothing with it.
    expect(a + z).toBe(1);
    const after = await balanceOf(bal);
    expect(after.balanceDays).toBe(10); // capped once, not re-capped from 10 and re-forfeited
    expect(after.lastCarryForwardYear).toBe(String(new Date().getUTCFullYear()));
    // And the excess is paid out ONCE. A second payout here would be real money for days the employee has
    // already been paid for, which is what the stamp guard exists to prevent.
    const paid = await deps.db.select().from(schema.leaveEncashments).where(eq(schema.leaveEncashments.employeeId, emp));
    expect(paid).toHaveLength(1);
    expect(paid[0]!.days).toBe(8);
  });

  it("auto-encashes the excess once, sized off the year's cap, from one org-wide read", async () => {
    await setCaps({ carry_forward_mode: "per_type", carry_forward_excess: "encash", encashment_mode: "per_type" });
    const emp = await seedEmployee();
    await deps.db.insert(schema.compensation).values({
      uuid: genId(), code: short("cp"), employeeId: emp, basePay: 60000, specialAllowance: 0,
      currency: "INR", effectiveFrom: new Date(Date.UTC(2020, 0, 1)),
    });
    const lt = await seedLeaveType({ carryForward: true, cap: 10, encashable: true });
    await deps.db.update(schema.leaveTypes).set({ encashmentCapDaysPerYear: 5 }).where(eq(schema.leaveTypes.uuid, lt));
    bustRef(deps, "leave_types");
    const bal = await seedBalance(emp, lt, 18);

    await carryForwardLeave(deps);

    expect((await balanceOf(bal)).balanceDays).toBe(10);
    const paid = await deps.db.select().from(schema.leaveEncashments).where(eq(schema.leaveEncashments.employeeId, emp));
    // 8 days of excess against a 5-day annual cap: the cap wins, and there is exactly one payout.
    expect(paid).toHaveLength(1);
    expect(paid[0]!.days).toBe(5);
    expect(paid[0]!.state).toBe("APPROVED");
  });

  it("counts an encashment already made this year against the cap", async () => {
    await setCaps({ carry_forward_mode: "per_type", carry_forward_excess: "encash", encashment_mode: "per_type" });
    const emp = await seedEmployee();
    await deps.db.insert(schema.compensation).values({
      uuid: genId(), code: short("cp"), employeeId: emp, basePay: 60000, specialAllowance: 0,
      currency: "INR", effectiveFrom: new Date(Date.UTC(2020, 0, 1)),
    });
    const lt = await seedLeaveType({ carryForward: true, cap: 10, encashable: true });
    await deps.db.update(schema.leaveTypes).set({ encashmentCapDaysPerYear: 5 }).where(eq(schema.leaveTypes.uuid, lt));
    bustRef(deps, "leave_types");
    const bal = await seedBalance(emp, lt, 18);
    // Three days already taken as cash this year. The org-wide read has to see them, or the rollover pays out
    // past the annual cap - which is the whole reason the cap is measured over the ORG's year.
    await deps.db.insert(schema.leaveEncashments).values({
      uuid: genId(), code: short("le"), employeeId: emp, leaveTypeId: lt, days: 3,
      ratePerDay: 2000, amount: 6000, currency: "INR", state: "APPROVED",
    });

    await carryForwardLeave(deps);

    const rolled = await deps.db
      .select()
      .from(schema.leaveEncashments)
      .where(and(eq(schema.leaveEncashments.employeeId, emp), eq(schema.leaveEncashments.days, 2)));
    expect(rolled).toHaveLength(1); // 5-day cap less the 3 already taken
    expect((await balanceOf(bal)).balanceDays).toBe(10);
  });

  it("processes a slice of the roster and queues the rest instead of running the invocation dry", async () => {
    await setCaps({ carry_forward_mode: "per_type", carry_forward_excess: "forfeit" });
    const lt = await seedLeaveType({ carryForward: true, cap: 10 });
    // Comfortably past the per-invocation slice, which is what a year-end roster looks like.
    const balances: string[] = [];
    for (let i = 0; i < 13; i++) balances.push(await seedBalance(await seedEmployee(), lt, 18));

    const first = await carryForwardLeave(deps);
    expect(first).toBe(10); // the slice, not the roster
    expect(await jobsOfKind("leave.carryForward")).toHaveLength(1);

    // The queued continuation needs no cursor: the year stamp is what makes an already-rolled row invisible,
    // so another pass simply finds whoever is left.
    const second = await carryForwardLeave(deps);
    expect(second).toBe(3);
    const year = String(new Date().getUTCFullYear());
    for (const uuid of balances) expect(await balanceOf(uuid)).toMatchObject({ balanceDays: 10, lastCarryForwardYear: year });
  });

  it("queues nothing when the roster fits in one pass", async () => {
    await setCaps({ carry_forward_mode: "per_type", carry_forward_excess: "forfeit" });
    const lt = await seedLeaveType({ carryForward: true, cap: 10 });
    await seedBalance(await seedEmployee(), lt, 18);

    await carryForwardLeave(deps);

    expect(await jobsOfKind("leave.carryForward")).toHaveLength(0);
  });
});

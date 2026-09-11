/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { bustRef } from "../src/lib/refData";
import { accrueLeave } from "../src/services/leaveAccrual";
import { createLeaveRequest, cancelLeaveRequest } from "../src/services/leaveRequests";

// Two things the leave paths get wrong when they are written against UTC and against a read they never re-take:
// WHICH MONTH the nightly accrual is crediting, and WHETHER the overlap check it just passed is still true by
// the time the row lands. Both hand out or spend leave days, and leave days are encashable - so both are money.

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

const TABLES = [schema.leaveRequests, schema.leaveBalances, schema.leaveTypes, schema.notifications, schema.auditLog, schema.eventLog, schema.settings, schema.users, schema.employees, schema.roles, schema.codeSequences];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  deps.refCache?.clear();
  deps.clock = { now: () => new Date() };
});

/** Point the org at a timezone. The settings read is memoized per-Deps, so drop the snapshot with it. */
async function setTimezone(tz: string) {
  await deps.db.insert(schema.settings).values({ key: "attendance", value: JSON.stringify({ timezone: tz }) }).onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify({ timezone: tz }) } });
  bustRef(deps, "settings");
}

async function seedEmployee(startDate: string): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.employees).values({
    uuid, code: `04-${genId().slice(0, 5)}`, firstName: "Test", lastName: "User",
    workEmail: `${uuid}@test.example`, status: "active", startDate: new Date(Date.parse(`${startDate}T00:00:00Z`)),
  });
  return uuid;
}

async function seedLeaveType(over: Partial<typeof schema.leaveTypes.$inferInsert> = {}): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.leaveTypes).values({
    uuid, code: `lt-${genId().slice(0, 4)}`, name: "Annual", accrualDaysPerYear: 12, paid: true, ...over,
  });
  bustRef(deps, "leave_types");
  return uuid;
}

async function seedActor(employeeId: string): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role: "employee", employeeId });
  return { uuid, email: `${uuid}@test.example`, role: "employee", status: "active", employeeId, employeeCode: null } as unknown as AppUser;
}

const balanceOf = (employeeId: string, leaveTypeId: string) =>
  deps.db.select().from(schema.leaveBalances).where(and(eq(schema.leaveBalances.employeeId, employeeId), eq(schema.leaveBalances.leaveTypeId, leaveTypeId))).limit(1).then((r) => r[0]);

describe("leave accrual credits the ORG's month, not the Worker's", () => {
  // The nightly tick fires at 02:00 UTC. That instant is the 1st in Asia/Kolkata and still the 31st in
  // America/New_York - so read in UTC, an org in the Americas had the new month's entitlement credited on the
  // evening of the previous month. The marker the balance carries is what makes it visible: it names the month
  // that was paid for.
  const nightlyTick = new Date("2026-04-01T02:00:00.000Z");

  it("stops at March for an org whose local day is still 31 March", async () => {
    await setTimezone("America/New_York"); // 2026-03-31 22:00 local
    const employeeId = await seedEmployee("2026-01-01");
    const leaveTypeId = await seedLeaveType();
    deps.clock = { now: () => nightlyTick };

    await accrueLeave(deps);

    expect((await balanceOf(employeeId, leaveTypeId))!.lastAccrualYm).toBe("2026-03");
  });

  it("reaches April for an org whose local day has rolled over", async () => {
    await setTimezone("Asia/Kolkata"); // 2026-04-01 07:30 local
    const employeeId = await seedEmployee("2026-01-01");
    const leaveTypeId = await seedLeaveType();
    deps.clock = { now: () => nightlyTick };

    await accrueLeave(deps);

    expect((await balanceOf(employeeId, leaveTypeId))!.lastAccrualYm).toBe("2026-04");
  });

  it("reads the injected clock at all, so a month boundary can be driven", async () => {
    await setTimezone("Asia/Kolkata");
    const employeeId = await seedEmployee("2026-01-01");
    const leaveTypeId = await seedLeaveType();
    // Well in the past relative to real wall-clock time: against `Date.now()` this credited every month up to
    // today and the assertion below could not be written at all.
    deps.clock = { now: () => new Date("2026-02-10T02:00:00.000Z") };

    await accrueLeave(deps);

    const bal = (await balanceOf(employeeId, leaveTypeId))!;
    expect(bal.lastAccrualYm).toBe("2026-02");
    expect(bal.balanceDays).toBe(2); // 12/year = 1/month, for January and February
  });
});

describe("two leave requests for the same days cannot both land", () => {
  // The overlap check is a READ. Two submissions - a double-clicked button, the same person on two devices -
  // both pass it before either writes, so the days were booked twice and the balance debited twice for them.
  // The row is re-checked after the insert, when both competitors can finally see each other, and the loser
  // unwinds. The tie is broken on `uuid`, a total order, so exactly one survives - never both, never neither.
  async function raceTwoRequests() {
    const employeeId = await seedEmployee("2026-01-01");
    const leaveTypeId = await seedLeaveType({ accrualDaysPerYear: 0 });
    const actor = await seedActor(employeeId);
    await deps.db.insert(schema.leaveBalances).values({
      code: `04-${genId().slice(0, 5)}`, employeeId, leaveTypeId, balanceDays: 10,
    });
    const submit = () =>
      createLeaveRequest(deps, actor, {
        employee: `employees/${employeeId}`,
        leave_type: `leave-types/${leaveTypeId}`,
        start_date: "2026-06-10",
        end_date: "2026-06-11",
      });
    const outcomes = await Promise.allSettled([submit(), submit()]);
    return { employeeId, leaveTypeId, outcomes };
  }

  it("keeps exactly one, and debits the balance exactly once", async () => {
    const { employeeId, leaveTypeId, outcomes } = await raceTwoRequests();

    const live = (await deps.db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.employeeId, employeeId)))
      .filter((r) => r.state === "PENDING" || r.state === "APPROVED");
    expect(live).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    // 10 days, one two-day request charged. The loser unwinds before the balance is touched, so it costs
    // nothing - unguarded, both debited and the employee lost four days for two days of leave.
    expect((await balanceOf(employeeId, leaveTypeId))!.balanceDays).toBe(8);
  });

  // The two re-checks do NOT have to be simultaneous: one writer's can run before the other has even inserted.
  // Ordering the tie on `uuid` alone survived the simultaneous case and let BOTH rows through that one, so the
  // guard has to hold whichever way the pair interleaves. Repeated because the interleaving is what varies.
  it("holds however the two submissions interleave", async () => {
    for (let round = 0; round < 8; round++) {
      for (const t of TABLES) await deps.db.delete(t); // same order as beforeEach: children before their parents
      deps.refCache?.clear();

      const { employeeId } = await raceTwoRequests();

      const live = (await deps.db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.employeeId, employeeId)))
        .filter((r) => r.state === "PENDING" || r.state === "APPROVED");
      expect(live, `round ${round}`).toHaveLength(1); // never two, and never none either
    }
  });

  it("tells the loser why, rather than failing obscurely", async () => {
    const { outcomes } = await raceTwoRequests();

    const rejected = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toContain("overlaps an existing leave request");
  });

  it("still lets a half-day abut its neighbour rather than colliding with it", async () => {
    const employeeId = await seedEmployee("2026-01-01");
    const leaveTypeId = await seedLeaveType({ accrualDaysPerYear: 0 });
    const actor = await seedActor(employeeId);
    await deps.db.insert(schema.leaveBalances).values({
      code: `04-${genId().slice(0, 5)}`, employeeId, leaveTypeId, balanceDays: 10,
    });
    const on = (day: string, startSession: number, endSession: number) =>
      createLeaveRequest(deps, actor, {
        employee: `employees/${employeeId}`, leave_type: `leave-types/${leaveTypeId}`,
        start_date: day, end_date: day, start_session: startSession, end_session: endSession,
      });

    await on("2026-06-10", 1, 1); // the morning
    await on("2026-06-10", 2, 2); // the afternoon - a different half of the same day, not an overlap

    const live = await deps.db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.employeeId, employeeId));
    expect(live).toHaveLength(2);
  });
});

describe("cancelling approved leave turns on the ORG's day, not the Worker's", () => {
  // `start_date` is date-only, anchored at UTC midnight. The gate asks "has this leave already started", and
  // comparing that anchor against the raw instant answers a different question everywhere but UTC: west of
  // UTC it flipped to "yes" the evening BEFORE (refusing to cancel leave that had not begun), and east of it
  // stayed "no" into the morning OF the leave (refunding a day already being taken).
  const LEAVE_DAY = "2026-06-10";

  async function approvedLeave() {
    const employeeId = await seedEmployee("2026-01-01");
    const leaveTypeId = await seedLeaveType({ accrualDaysPerYear: 0 });
    const actor = await seedActor(employeeId);
    await deps.db.insert(schema.leaveBalances).values({ code: `04-${genId().slice(0, 5)}`, employeeId, leaveTypeId, balanceDays: 10 });
    const row = await createLeaveRequest(deps, actor, {
      employee: `employees/${employeeId}`, leave_type: `leave-types/${leaveTypeId}`, start_date: LEAVE_DAY, end_date: LEAVE_DAY,
    });
    await deps.db.update(schema.leaveRequests).set({ state: "APPROVED" }).where(eq(schema.leaveRequests.uuid, row.uuid));
    return { actor, id: row.uuid, employeeId, leaveTypeId };
  }

  it("still lets it be cancelled the evening before, west of UTC", async () => {
    await setTimezone("America/New_York"); // 2026-06-09 21:00 local - the leave is tomorrow
    const { actor, id } = await approvedLeave();
    deps.clock = { now: () => new Date("2026-06-10T01:00:00.000Z") };

    await cancelLeaveRequest(deps, actor, id);

    expect((await deps.db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.uuid, id)))[0]!.state).toBe("CANCELLED");
  });

  it("refuses it on the morning of the leave, east of UTC", async () => {
    await setTimezone("Asia/Kolkata"); // 2026-06-10 06:30 local - the leave day has begun
    const { actor, id } = await approvedLeave();
    deps.clock = { now: () => new Date("2026-06-10T01:00:00.000Z") };

    await expect(cancelLeaveRequest(deps, actor, id)).rejects.toThrow("already started");
  });

  it("does not refund the balance for a day already being taken", async () => {
    await setTimezone("Asia/Kolkata");
    const { actor, id, employeeId, leaveTypeId } = await approvedLeave();
    const reserved = (await balanceOf(employeeId, leaveTypeId))!.balanceDays;
    deps.clock = { now: () => new Date("2026-06-10T01:00:00.000Z") };

    await expect(cancelLeaveRequest(deps, actor, id)).rejects.toThrow();

    expect((await balanceOf(employeeId, leaveTypeId))!.balanceDays).toBe(reserved);
  });
});

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
import { setTrackedFrom } from "../src/services/trackedFrom";
import { updateEmployee } from "../src/services/employees";
import { createRun, buildRunItems, listRunItems, recomputeLopUnits } from "../src/services/payroll";
import { DEFAULT_ATTENDANCE } from "../src/domain/attendance";
import { importLeaveHistory } from "../src/services/leaveHistoryImport";

// When HRMS records start for the people who joined before go-live (`employees.tracked_from`).
//
// The day rule itself is pure and pinned in test/attendanceLop.test.ts. What is pinned HERE is everything a
// pure test cannot see: who the bulk act dates and to what, that it only ever fills an empty date, that the
// single-record edit refuses what the bulk act refuses, and that a real run build stops docking the days
// before the date - the one place this feature is money.

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
});

const TABLES = [
  schema.lopAdjustments, schema.payrollRunItems, schema.payslips, schema.payrollRuns, schema.payPeriods,
  schema.leaveRequests, schema.leaveTypes, schema.attendanceSessions, schema.compensation,
  schema.notifications, schema.eventLog, schema.automationRuns, schema.auditLog,
  schema.users, schema.employees, schema.roles, schema.settings,
];

// Saturday 26 September 2026, 11:30 in IST (the default org zone). Go-live was Thursday the 24th.
const NOW = "2026-09-26T06:00:00Z";
const short = (p: string) => `${p}-${genId().slice(0, 6)}`;
const actor = { uuid: genId(), email: "admin@t.example", role: "super_admin", status: "active", employeeId: null, employeeCode: null } as unknown as AppUser;

beforeEach(async () => {
  deps = makeDeps(b);
  deps.clock = { now: () => new Date(NOW) };
  for (const t of TABLES) await deps.db.delete(t);
  // A real account behind the actor: a run records who created it.
  await deps.db.insert(schema.roles).values({ name: "super_admin", label: "Super admin" }).onConflictDoNothing();
  await deps.db.insert(schema.users).values({ uuid: actor.uuid, code: short("u"), email: actor.email, role: "super_admin" });
});

let n = 0;
async function person(over: { start?: string | null; createdAt?: string; trackedFrom?: string } = {}): Promise<string> {
  n += 1;
  const id = genId();
  await deps.db.insert(schema.employees).values({
    uuid: id,
    code: `04-001-${String(n).padStart(3, "0")}`,
    firstName: "Test",
    lastName: `Person${n}`,
    workEmail: `${id}@t.example`,
    status: "active",
    startDate: over.start === null ? null : new Date(`${over.start ?? "2021-03-01"}T00:00:00Z`),
    trackedFrom: over.trackedFrom ? new Date(`${over.trackedFrom}T00:00:00Z`) : null,
    createdAt: new Date(over.createdAt ?? "2026-09-20T05:00:00Z"),
  });
  return id;
}
const trackedOf = async (id: string) => {
  const row = (await deps.db.select({ t: schema.employees.trackedFrom }).from(schema.employees).where(eq(schema.employees.uuid, id)))[0]!;
  return row.t ? new Date(row.t).toISOString().slice(0, 10) : null;
};

describe("employees:setTrackedFrom", () => {
  it("dates everyone who joined before go-live, and leaves later joiners and existing dates alone", async () => {
    const early = await person();
    // Created at 01:30 on the 26th in IST, which is still the 25th in UTC: the org's day is the one that counts.
    const importedLate = await person({ createdAt: "2026-09-25T20:00:00Z" });
    const joinedOnGoLive = await person({ start: "2026-09-24" });
    const alreadyDated = await person({ start: "2019-01-01", trackedFrom: "2026-09-01" });
    const noStart = await person({ start: null });

    const plan = await setTrackedFrom(deps, actor, { date: "2026-09-24", dryRun: true });
    const outcome = (id: string) => plan.results.find((r) => r.employee === `employees/${id}`);
    expect(outcome(early)).toMatchObject({ outcome: "set", tracked_from: "2026-09-24", created_day: "2026-09-20" });
    expect(outcome(importedLate)).toMatchObject({ outcome: "set", tracked_from: "2026-09-26" });
    expect(outcome(joinedOnGoLive)).toMatchObject({ outcome: "joined_after" });
    expect(outcome(joinedOnGoLive)!.tracked_from).toBeUndefined();
    expect(outcome(alreadyDated)).toMatchObject({ outcome: "already_set", tracked_from: "2026-09-01" });
    expect(outcome(noStart)).toMatchObject({ outcome: "set", tracked_from: "2026-09-24" });
    expect(plan.counts).toEqual({ set: 3, already_set: 1, joined_after: 1 });
    // A dry run writes nothing.
    expect(await trackedOf(early)).toBeNull();
    expect((await deps.db.select().from(schema.auditLog)).length).toBe(0);

    const applied = await setTrackedFrom(deps, actor, { date: "2026-09-24", dryRun: false });
    expect(applied.counts).toEqual({ set: 3, already_set: 1, joined_after: 1 });
    expect(await trackedOf(early)).toBe("2026-09-24");
    expect(await trackedOf(importedLate)).toBe("2026-09-26");
    expect(await trackedOf(joinedOnGoLive)).toBeNull();
    expect(await trackedOf(alreadyDated)).toBe("2026-09-01");
    expect(await trackedOf(noStart)).toBe("2026-09-24");

    // One entry per person dated, on their own record, saying what changed.
    const trail = await deps.db.select().from(schema.auditLog);
    expect(trail.map((a) => a.entityId).sort()).toEqual([early, importedLate, noStart].sort());
    for (const a of trail) {
      expect(a.action).toBe("employee.update");
      expect(JSON.parse(a.meta!).diff.trackedFrom.from).toBeNull();
    }
  });

  it("changes nothing the second time", async () => {
    const id = await person();
    await setTrackedFrom(deps, actor, { date: "2026-09-24", dryRun: false });
    const again = await setTrackedFrom(deps, actor, { date: "2026-09-10", dryRun: false });
    expect(again.counts).toEqual({ set: 0, already_set: 1, joined_after: 0 });
    expect(await trackedOf(id)).toBe("2026-09-24");
  });

  it("refuses a date that is not a calendar day, or is still to come", async () => {
    await person();
    await expect(setTrackedFrom(deps, actor, { date: "2026-02-30", dryRun: true })).rejects.toThrow(/calendar date/);
    await expect(setTrackedFrom(deps, actor, { date: "24/09/2026", dryRun: true })).rejects.toThrow(/calendar date/);
    await expect(setTrackedFrom(deps, actor, { date: "2026-09-27", dryRun: true })).rejects.toThrow(/future/);
  });
});

describe("tracked_from on one employee record", () => {
  it("is set, cleared and refused by the same rules as the bulk act", async () => {
    const id = await person();
    await updateEmployee(deps, actor, id, { tracked_from: "2026-09-24" });
    expect(await trackedOf(id)).toBe("2026-09-24");
    await expect(updateEmployee(deps, actor, id, { tracked_from: "2026-09-31" })).rejects.toThrow(/calendar date/);
    await expect(updateEmployee(deps, actor, id, { tracked_from: "2026-10-01" })).rejects.toThrow(/future/);
    await updateEmployee(deps, actor, id, { tracked_from: null });
    expect(await trackedOf(id)).toBeNull();
  });
});

describe("a run build does not dock the days before HRMS records start", () => {
  // September 2026 as the period, built on the 26th: the loss-of-pay walk runs 1-26 September. The employee
  // joined in 2021, HRMS went live on Thursday the 24th, and they punched full days on the 24th and 25th -
  // so before the date there are seventeen working days with nothing in them.
  async function setup() {
    const emp = await person();
    await deps.db.insert(schema.compensation).values({
      uuid: genId(), code: short("cmp"), employeeId: emp, ctcAnnual: 0, basePay: 22_000, specialAllowance: 0,
      currency: "INR", effectiveFrom: new Date("2025-01-01"), effectiveTo: null,
    });
    // 09:00 to 18:00 IST on the two days since go-live.
    for (const d of ["2026-09-24", "2026-09-25"]) {
      await deps.db.insert(schema.attendanceSessions).values({
        uuid: genId(), code: short("att"), employeeId: emp,
        clockIn: new Date(`${d}T03:30:00Z`), clockOut: new Date(`${d}T12:30:00Z`),
      });
    }
    await deps.db.insert(schema.settings).values({ key: "attendance", value: JSON.stringify({ ...DEFAULT_ATTENDANCE, lop_enabled: true }), updatedAt: new Date() });
    deps = makeDeps(b);
    deps.clock = { now: () => new Date(NOW) };
    const period = genId();
    await deps.db.insert(schema.payPeriods).values({ uuid: period, code: short("pp"), label: "Sep 2026", periodStart: new Date("2026-09-01T00:00:00Z"), periodEnd: new Date("2026-09-30T00:00:00Z"), payDate: new Date("2026-09-30T00:00:00Z") });
    return { emp, period };
  }
  async function lopUnits(period: string) {
    const run = await createRun(deps, actor, `pay-periods/${period}`);
    await buildRunItems(deps, actor, run.uuid);
    return (await listRunItems(deps, run.uuid))[0]!.lines.find((l) => l.code === "LOP")?.units ?? 0;
  }

  it("docks every empty working day without a date, and none of the days before it with one", async () => {
    const { emp, period } = await setup();
    expect(await lopUnits(period)).toBe(17);
    await deps.db.update(schema.employees).set({ trackedFrom: new Date("2026-09-24T00:00:00Z") }).where(eq(schema.employees.uuid, emp));
    expect(await lopUnits(period)).toBe(0);
    // A restatement of the period reads it the same way the build did.
    expect(await recomputeLopUnits(deps, emp, period)).toBe(0);
  });

  it("still docks unpaid leave taken before the date", async () => {
    const { emp, period } = await setup();
    await deps.db.update(schema.employees).set({ trackedFrom: new Date("2026-09-24T00:00:00Z") }).where(eq(schema.employees.uuid, emp));
    const lwp = genId();
    await deps.db.insert(schema.leaveTypes).values({ uuid: lwp, code: short("lt"), name: "Loss of Pay", paid: false });
    await deps.db.insert(schema.leaveRequests).values({
      uuid: genId(), code: short("lr"), employeeId: emp, leaveTypeId: lwp, state: "APPROVED", days: 1,
      startDate: new Date("2026-09-10T00:00:00Z"), endDate: new Date("2026-09-10T00:00:00Z"),
    });
    expect(await lopUnits(period)).toBe(1);
  });

  // The first month HRMS pays began in the system before it: 1-23 September. An absence the old system knew
  // about on those days is only docked if it is brought in - as Loss of Pay leave through the history import.
  it("docks the unpaid days before the date that the history import brings in", async () => {
    const { emp, period } = await setup();
    await deps.db.update(schema.employees).set({ trackedFrom: new Date("2026-09-24T00:00:00Z") }).where(eq(schema.employees.uuid, emp));
    const lwp = genId();
    await deps.db.insert(schema.leaveTypes).values({ uuid: lwp, code: short("lt"), name: "Loss of Pay", paid: false });
    const res = await importLeaveHistory(deps, actor, [
      { employee: `employees/${emp}`, leave_type: `leave-types/${lwp}`, start_date: "2026-09-10", end_date: "2026-09-11" },
    ], false);
    expect(res.results[0]).toMatchObject({ kind: "history", days: 2, outcome: "created" });
    expect(await lopUnits(period)).toBe(2);
  });
});

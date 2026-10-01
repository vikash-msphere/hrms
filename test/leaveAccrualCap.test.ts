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
import { accrueLeave } from "../src/services/leaveAccrual";

// A leave type's accrual cap (leave_types.accrual_cap_days): the most a balance may ACCRUE to. The nightly walk
// cuts a credit to what fits, forfeits the rest, and still moves the marker - so a month at the cap is paid for
// and is not owed again once the balance drops.

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

const TABLES = [schema.leaveBalances, schema.leaveTypes, schema.auditLog, schema.settings, schema.employees, schema.codeSequences];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  deps.refCache?.clear();
  // Mid-June in every timezone: January to June credited, 12/year = 1 a month.
  deps.clock = { now: () => new Date("2026-06-10T02:00:00.000Z") };
});

async function seedEmployee(): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.employees).values({
    uuid, code: `04-${genId().slice(0, 5)}`, firstName: "Test", lastName: "User",
    workEmail: `${uuid}@test.example`, status: "active", startDate: new Date(Date.parse("2026-01-01T00:00:00Z")),
  });
  return uuid;
}

async function seedLeaveType(accrualCapDays: number | null): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.leaveTypes).values({
    uuid, code: `lt-${genId().slice(0, 4)}`, name: "Annual", accrualDaysPerYear: 12, paid: true, accrualCapDays,
  });
  bustRef(deps, "leave_types");
  return uuid;
}

async function seedBalance(employeeId: string, leaveTypeId: string, balanceDays: number, lastAccrualYm: string) {
  await deps.db.insert(schema.leaveBalances).values({
    uuid: genId(), code: `bal-${genId().slice(0, 4)}`, employeeId, leaveTypeId, balanceDays, lastAccrualYm,
    accrualPricedStart: new Date(Date.parse("2026-01-01T00:00:00Z")),
  });
}

const balanceOf = (employeeId: string, leaveTypeId: string) =>
  deps.db.select().from(schema.leaveBalances).where(and(eq(schema.leaveBalances.employeeId, employeeId), eq(schema.leaveBalances.leaveTypeId, leaveTypeId))).limit(1).then((r) => r[0]!);

describe("the accrual cap", () => {
  it("accrues uncapped when the type has no cap", async () => {
    const emp = await seedEmployee();
    const lt = await seedLeaveType(null);
    await accrueLeave(deps);
    expect((await balanceOf(emp, lt)).balanceDays).toBe(6);
  });

  it("stops a first-time balance at the cap and still marks the months credited", async () => {
    const emp = await seedEmployee();
    const lt = await seedLeaveType(4);
    await accrueLeave(deps);
    const bal = await balanceOf(emp, lt);
    expect(bal.balanceDays).toBe(4);
    expect(bal.lastAccrualYm).toBe("2026-06");
  });

  it("cuts a credit to what fits under the cap", async () => {
    const emp = await seedEmployee();
    const lt = await seedLeaveType(5.5);
    await seedBalance(emp, lt, 5, "2026-05");
    await accrueLeave(deps);
    expect((await balanceOf(emp, lt)).balanceDays).toBe(5.5);
  });

  it("credits nothing at the cap, moves the marker, and does not owe the month later", async () => {
    const emp = await seedEmployee();
    const lt = await seedLeaveType(5);
    await seedBalance(emp, lt, 5, "2026-05");
    await accrueLeave(deps);
    const bal = await balanceOf(emp, lt);
    expect(bal.balanceDays).toBe(5);
    expect(bal.lastAccrualYm).toBe("2026-06");

    // Spent below the cap: the June credit was forfeited, not deferred, so the next tick in June adds nothing.
    await deps.db.update(schema.leaveBalances).set({ balanceDays: 2 }).where(eq(schema.leaveBalances.uuid, bal.uuid));
    await accrueLeave(deps);
    expect((await balanceOf(emp, lt)).balanceDays).toBe(2);
  });

  it("leaves a balance above the cap where it is", async () => {
    const emp = await seedEmployee();
    const lt = await seedLeaveType(4);
    await seedBalance(emp, lt, 10, "2026-05");
    await accrueLeave(deps);
    expect((await balanceOf(emp, lt)).balanceDays).toBe(10);
  });

  it("never rounds a capped balance above a cap that is off the half-day grid", async () => {
    const emp = await seedEmployee();
    const lt = await seedLeaveType(4.3);
    await accrueLeave(deps);
    expect((await balanceOf(emp, lt)).balanceDays).toBe(4);
    // And the tick after does not re-round it up past the cap.
    await accrueLeave(deps);
    expect((await balanceOf(emp, lt)).balanceDays).toBe(4);
  });
});

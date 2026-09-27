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
import { createCorrection, importOpenings } from "../src/services/leaveAdjustments";
import { encashedDaysThisYear, encashedDaysThisYearAll } from "../src/services/leaveEncashments";
import { updateEmployee } from "../src/services/employees";
import { orgYear } from "../src/services/orgDay";
import { grantFor } from "../bootstrap/authz/grants";
import { resolveRequest, decide } from "../src/domain/permissions";

// Opening leave balances (services/leaveAdjustments.ts), through the real accrual and the real ledger write.
//
// The arithmetic of what HRMS credited before the floor is pinned in test/leave.test.ts. What is pinned HERE
// is the money: that the first night's backlog is replaced by the old system's figure and nothing else moves,
// that a re-import changes only the difference, that two imports racing each other apply once, that the
// nightly run afterwards neither re-credits nor claws back, and that a preview writes nothing.

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
  schema.leaveAdjustments, schema.leaveEncashments, schema.leaveRequests, schema.leaveBalances, schema.leaveTypes,
  schema.notifications, schema.auditLog, schema.eventLog, schema.settings, schema.users, schema.employees, schema.roles, schema.codeSequences,
];
// The first nightly run after go-live (25 September 2026), and a day after it.
const at = (iso: string) => { deps.clock = { now: () => new Date(iso) }; };
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  deps.refCache?.clear();
  at("2026-09-25T02:00:00Z");
});

async function seedEmployee(startDate = "2021-03-01"): Promise<{ id: string; code: string }> {
  const id = genId();
  const code = `04-${genId().slice(0, 5)}`;
  await deps.db.insert(schema.employees).values({
    uuid: id, code, firstName: "Asha", lastName: "Rao",
    workEmail: `${id}@test.example`, status: "active", startDate: new Date(`${startDate}T00:00:00Z`),
  });
  return { id, code };
}
async function seedLeaveType(over: Partial<typeof schema.leaveTypes.$inferInsert> = {}): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.leaveTypes).values({ uuid, code: `lt-${genId().slice(0, 4)}`, name: "Earned Leave", accrualDaysPerYear: 12, paid: true, ...over });
  bustRef(deps, "leave_types");
  return uuid;
}
async function seedAdmin(): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "super_admin", label: "Super admin" }).onConflictDoNothing();
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role: "super_admin" });
  return { uuid, email: `${uuid}@test.example`, role: "super_admin", status: "active", employeeId: null, employeeCode: null } as unknown as AppUser;
}
const setTracked = (id: string, ymd: string) =>
  deps.db.update(schema.employees).set({ trackedFrom: new Date(`${ymd}T00:00:00Z`) }).where(eq(schema.employees.uuid, id));
const balanceOf = (employeeId: string, leaveTypeId: string) =>
  deps.db.select().from(schema.leaveBalances).where(and(eq(schema.leaveBalances.employeeId, employeeId), eq(schema.leaveBalances.leaveTypeId, leaveTypeId))).limit(1).then((r) => r[0]);
const ledger = (employeeId: string) => deps.db.select().from(schema.leaveAdjustments).where(eq(schema.leaveAdjustments.employeeId, employeeId));
const item = (employeeId: string, leaveTypeId: string, opening_days: number, encashed_days?: number) =>
  ({ employee: `employees/${employeeId}`, leave_type: `leave-types/${leaveTypeId}`, opening_days, ...(encashed_days != null ? { encashed_days } : {}) });

/** Somebody who joined in March 2021, the backlog the first night credited, and records starting at go-live. */
async function goLive() {
  const emp = await seedEmployee();
  const el = await seedLeaveType();
  const admin = await seedAdmin();
  await accrueLeave(deps); // no date yet: every month since the start date, in one go
  expect((await balanceOf(emp.id, el))!.balanceDays).toBe(67);
  await setTracked(emp.id, "2026-09-24");
  at("2026-09-26T06:00:00Z");
  return { emp, el, admin };
}

describe("an opening balance replaces the backlog the first night credited", () => {
  it("previews without writing, then applies exactly the old system's figure", async () => {
    const { emp, el, admin } = await goLive();
    const preview = await importOpenings(deps, admin, [item(emp.id, el, 10)], true);
    expect(preview.results[0]).toMatchObject({ outcome: "applied", as_of: "2026-09-24", current: 67, removed: 67, opening: 10, change: -57, result: 10 });
    expect((await balanceOf(emp.id, el))!.balanceDays).toBe(67);
    expect(await ledger(emp.id)).toEqual([]);

    const applied = await importOpenings(deps, admin, [item(emp.id, el, 10)], false);
    expect(applied.counts).toEqual({ applied: 1, unchanged: 0, error: 0 });
    expect((await balanceOf(emp.id, el))!.balanceDays).toBe(10);
    const [row] = await ledger(emp.id);
    expect(row).toMatchObject({ kind: "opening", days: -57, openingDays: 10, removedDays: 67, openingSeq: 1, createdBy: admin.uuid });
    // The person is told once.
    const notes = await deps.db.select().from(schema.notifications).where(eq(schema.notifications.recipientId, emp.id));
    expect(notes.map((n) => n.type)).toEqual(["leave.opening_balance"]);
  });

  it("keeps what happened in HRMS since go-live", async () => {
    const { emp, el, admin } = await goLive();
    // Two days taken in HRMS on 25 September, against the inflated balance.
    await deps.db.update(schema.leaveBalances).set({ balanceDays: 65 }).where(and(eq(schema.leaveBalances.employeeId, emp.id), eq(schema.leaveBalances.leaveTypeId, el)));
    const r = await importOpenings(deps, admin, [item(emp.id, el, 10)], false);
    expect(r.results[0]).toMatchObject({ current: 65, removed: 67, change: -57, result: 8 });
    expect((await balanceOf(emp.id, el))!.balanceDays).toBe(8);
  });

  it("moves a re-import by the difference only, and changes nothing when it matches", async () => {
    const { emp, el, admin } = await goLive();
    await importOpenings(deps, admin, [item(emp.id, el, 10)], false);
    const again = await importOpenings(deps, admin, [item(emp.id, el, 12)], false);
    expect(again.results[0]).toMatchObject({ removed: 0, previous_opening: 10, change: 2, result: 12 });
    expect((await balanceOf(emp.id, el))!.balanceDays).toBe(12);
    const same = await importOpenings(deps, admin, [item(emp.id, el, 12)], false);
    expect(same.counts).toEqual({ applied: 0, unchanged: 1, error: 0 });
    expect((await ledger(emp.id)).map((l) => l.openingSeq).sort()).toEqual([1, 2]);
  });

  it("refuses an opening that would leave the balance below zero, and writes nothing for it", async () => {
    const { emp, el, admin } = await goLive();
    await deps.db.update(schema.leaveBalances).set({ balanceDays: 64 }).where(and(eq(schema.leaveBalances.employeeId, emp.id), eq(schema.leaveBalances.leaveTypeId, el)));
    const r = await importOpenings(deps, admin, [item(emp.id, el, 1)], false);
    expect(r.results[0]).toMatchObject({ outcome: "error", result: -2 });
    expect((await balanceOf(emp.id, el))!.balanceDays).toBe(64);
    expect(await ledger(emp.id)).toEqual([]);
  });

  it("applies once when two imports of the same opening race", async () => {
    const { emp, el, admin } = await goLive();
    const [a, c] = await Promise.all([
      importOpenings(deps, admin, [item(emp.id, el, 10)], false),
      importOpenings(deps, admin, [item(emp.id, el, 10)], false),
    ]);
    const outcomes = [a.results[0]!.outcome, c.results[0]!.outcome].sort();
    expect(outcomes).toEqual(["applied", "error"]);
    expect((await balanceOf(emp.id, el))!.balanceDays).toBe(10);
    expect((await ledger(emp.id)).length).toBe(1);
  });

  it("is followed by an accrual that credits HRMS's own months and nothing before them", async () => {
    const { emp, el, admin } = await goLive();
    await importOpenings(deps, admin, [item(emp.id, el, 10)], false);
    at("2026-10-01T02:00:00Z");
    await accrueLeave(deps);
    expect((await balanceOf(emp.id, el))!.balanceDays).toBe(11); // October's day, on top of the opening
    // A start date corrected years back afterwards does not bring the old months back.
    await deps.db.update(schema.employees).set({ startDate: new Date("2019-01-01T00:00:00Z") }).where(eq(schema.employees.uuid, emp.id));
    at("2026-10-02T02:00:00Z");
    await accrueLeave(deps);
    expect((await balanceOf(emp.id, el))!.balanceDays).toBe(11);
  });

  it("opens a balance HRMS has not credited yet, and needs the records-start date first", async () => {
    const emp = await seedEmployee();
    const el = await seedLeaveType();
    const admin = await seedAdmin();
    const noDate = await importOpenings(deps, admin, [item(emp.id, el, 5)], true);
    expect(noDate.results[0]!.error).toMatch(/HRMS records start/);
    await setTracked(emp.id, "2026-09-24");
    const r = await importOpenings(deps, admin, [item(emp.id, el, 5)], false);
    expect(r.results[0]).toMatchObject({ current: 0, removed: 0, change: 5, result: 5 });
    expect((await balanceOf(emp.id, el))!.balanceDays).toBe(5);
    // The next night starts it at the floor: October only.
    at("2026-10-01T02:00:00Z");
    await accrueLeave(deps);
    expect((await balanceOf(emp.id, el))!.balanceDays).toBe(6);
  });
});

describe("a correction by hand", () => {
  it("moves the balance by exactly its days, with its reason, and never below zero", async () => {
    const { emp, el, admin } = await goLive();
    const row = await createCorrection(deps, admin, { employee: `employees/${emp.id}`, leave_type: `leave-types/${el}`, days: 1.5, reason: "Comp-off for the audit weekend" });
    expect(row).toMatchObject({ kind: "correction", days: 1.5, reason: "Comp-off for the audit weekend" });
    expect((await balanceOf(emp.id, el))!.balanceDays).toBe(68.5);
    await expect(createCorrection(deps, admin, { employee: `employees/${emp.id}`, leave_type: `leave-types/${el}`, days: -100, reason: "x" })).rejects.toThrow(/below zero/);
    await expect(createCorrection(deps, admin, { employee: `employees/${emp.id}`, leave_type: `leave-types/${el}`, days: 1, reason: " " })).rejects.toThrow(/why/);
    await expect(createCorrection(deps, admin, { employee: `employees/${emp.id}`, leave_type: `leave-types/${el}`, days: 0, reason: "x" })).rejects.toThrow(/non-zero/);
  });
});

describe("what an opening fixes in place", () => {
  it("keeps the records-start date it was measured against", async () => {
    const { emp, el, admin } = await goLive();
    await importOpenings(deps, admin, [item(emp.id, el, 10)], false);
    await expect(updateEmployee(deps, admin, emp.id, { tracked_from: "2026-09-10" })).rejects.toThrow(/can't move now/);
    // Sending the same date back is not a move.
    await updateEmployee(deps, admin, emp.id, { tracked_from: "2026-09-24" });
  });

  it("counts days encashed before HRMS against the year's encashment cap", async () => {
    const { emp, el, admin } = await goLive();
    await importOpenings(deps, admin, [item(emp.id, el, 10, 3)], false);
    const year = await orgYear(deps);
    expect(await encashedDaysThisYear(deps, emp.id, year, el)).toBe(3);
    expect(await encashedDaysThisYear(deps, emp.id, year)).toBe(3);
    const all = await encashedDaysThisYearAll(deps, year);
    expect(all.total(emp.id)).toBe(3);
    expect(all.perType(emp.id, el)).toBe(3);
  });
});

describe("who may import openings", () => {
  const can = (role: string, path: string) => decide(grantFor(role), resolveRequest("POST", path), { employeeCode: "04-001-001" }).allow;
  // Going live is each owner's own job: HR brings in leave balances and leave history, payroll brings in pay and
  // tax so far (bootstrap/authz/roles/). Nobody else - an import moves balances for a whole workforce at once.
  it("leave openings and leave history: HR and super", () => {
    for (const path of ["/v1/leave-adjustments:importOpenings", "/v1/leave-requests:importHistory"]) {
      for (const role of ["hr_admin", "super_admin"]) expect(can(role, path), `${role} ${path}`).toBe(true);
      for (const role of ["employee", "manager", "payroll_admin"]) expect(can(role, path), `${role} ${path}`).toBe(false);
    }
  });
  it("pay and tax openings: payroll and super", () => {
    const path = "/v1/payroll-openings:importOpenings";
    for (const role of ["payroll_admin", "super_admin"]) expect(can(role, path), role).toBe(true);
    for (const role of ["employee", "manager", "hr_admin"]) expect(can(role, path), role).toBe(false);
  });
});

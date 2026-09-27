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
import { createRun, buildRunItems, listRunItems, runStaleness } from "../src/services/payroll";
import { approveLateEarlyRequest, createLateEarlyRequest } from "../src/services/lateEarlyRequests";
import { DEFAULT_ATTENDANCE } from "../src/domain/attendance";

// What the punctuality policy does to PAY, through a real run build.
//
// The arithmetic is pure and pinned in test/punctuality.test.ts. What is pinned HERE is the join: that an
// approved request and the org's policy reach `assembleLop`, move a real run item's loss-of-pay line, show up
// in the line's breakdown, and restate a period that has already been paid. Each of those is a place where the
// feature could look finished on screen while payroll quietly ignored it.

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
  schema.lateEarlyRequests, schema.attendanceDayMarks, schema.attendanceSessions, schema.compensation,
  schema.notifications, schema.eventLog, schema.automationRuns, schema.auditLog,
  schema.users, schema.employees, schema.roles, schema.settings,
];
beforeEach(async () => {
  deps = makeDeps(b); // fresh per-request caches: settings are memoized per Deps
  for (const t of TABLES) await deps.db.delete(t);
});

const short = (p: string) => `${p}-${genId().slice(0, 6)}`;

// One working week as the whole period (Mon 5 - Fri 9 January 2026), so 22,000 of gross is 4,400 a day.
const WEEK = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"] as const;

async function person(code: string, managerId?: string): Promise<{ id: string; actor: AppUser }> {
  const id = genId();
  await deps.db.insert(schema.employees).values({ uuid: id, code, firstName: "Pay", lastName: code, workEmail: `${id}@t.example`, status: "active", startDate: new Date("2020-01-01"), managerId: managerId ?? null });
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: short("u"), email: `${uuid}@t.example`, role: "employee", employeeId: id });
  return { id, actor: { uuid, email: `${uuid}@t.example`, role: "employee", status: "active", employeeId: id, employeeCode: code } as unknown as AppUser };
}

async function setting(key: string, value: unknown) {
  await deps.db.insert(schema.settings).values({ key, value: JSON.stringify(value), updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify(value), updatedAt: new Date() } });
  deps = makeDeps(b);
}

/** A day's punch in IST (the default org zone): `inAt` / `outAt` as "HH:MM" local. */
async function punch(employeeId: string, ymd: string, inAt: string, outAt: string) {
  const utc = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return new Date(Date.parse(`${ymd}T00:00:00Z`) + ((h! * 60 + m!) - 330) * 60_000); };
  await deps.db.insert(schema.attendanceSessions).values({ uuid: genId(), code: short("att"), employeeId, clockIn: utc(inAt), clockOut: utc(outAt) });
}

async function setup(punctuality: unknown) {
  const mgr = await person("04-001-900");
  const emp = await person("04-001-901", mgr.id);
  await deps.db.insert(schema.compensation).values({
    uuid: genId(), code: short("cmp"), employeeId: emp.id, ctcAnnual: 0, basePay: 22_000, specialAllowance: 0,
    currency: "INR", effectiveFrom: new Date("2025-01-01"), effectiveTo: null,
  });
  await setting("attendance", { ...DEFAULT_ATTENDANCE, lop_enabled: true, shift_start: "09:00", shift_end: "18:00", grace_minutes: 15 });
  await setting("punctuality", punctuality);
  const period = genId();
  await deps.db.insert(schema.payPeriods).values({ uuid: period, code: short("pp"), label: "W1 Jan 2026", periodStart: new Date(`${WEEK[0]}T00:00:00Z`), periodEnd: new Date(`${WEEK[4]}T00:00:00Z`), payDate: new Date(`${WEEK[4]}T00:00:00Z`) });
  return { emp, mgr, period };
}

async function build(period: string, actor: AppUser) {
  const run = await createRun(deps, actor, `pay-periods/${period}`);
  await buildRunItems(deps, actor, run.uuid);
  return run.uuid;
}
const lopLine = async (runId: string) => (await listRunItems(deps, runId))[0]!.lines.find((l) => l.code === "LOP");

// Every unexcused mark docks half a day; nothing is free.
const STRICT = { penalties: { enabled: true, counts: "both", free_marks: 0, every: 1, deduct_days: 0.5 } };

describe("unexcused lateness docks pay through the loss-of-pay line", () => {
  it("docks a full week of late arrivals, and says what the line is made of", async () => {
    const { emp, period } = await setup(STRICT);
    // In at 09:40 every day and out at 18:40: nine full hours, so no ABSENCE at all - only five marks.
    for (const d of WEEK) await punch(emp.id, d, "09:40", "18:40");
    const lop = (await lopLine(await build(period, emp.actor)))!;
    expect(lop.units).toBe(2.5);
    expect(lop.amount).toBe(-11_000);
    // The marks are the whole of it, so the breakdown is one part carrying the whole amount.
    expect(lop.parts).toEqual([{ label: "Late / early marks (2.5d, 5 marks)", amount: -11_000 }]);
  });

  it("docks nothing for lateness while the policy's penalties are off", async () => {
    const { emp, period } = await setup({});
    for (const d of WEEK) await punch(emp.id, d, "09:40", "18:40");
    expect(await lopLine(await build(period, emp.actor))).toBeUndefined();
  });

  it("does not count a day the approved late arrival excuses", async () => {
    const { emp, mgr, period } = await setup({ ...STRICT, requests: { backdate_days: null } });
    for (const d of WEEK) await punch(emp.id, d, "09:40", "18:40");
    const req = await createLateEarlyRequest(deps, emp.actor, { date: WEEK[0], kind: "late_arrival", at: "10:00", reason: "Train" });
    await approveLateEarlyRequest(deps, mgr.actor, req.uuid);
    const lop = (await lopLine(await build(period, emp.actor)))!;
    expect(lop.units).toBe(2); // four marks, not five
  });

  it("caps a severely late day at half, and charges it once", async () => {
    const { emp, period } = await setup({ penalties: { ...STRICT.penalties, severe_minutes: 120 } });
    await punch(emp.id, WEEK[0], "12:00", "21:00"); // nine hours worked, three hours late
    for (const d of WEEK.slice(1)) await punch(emp.id, d, "09:00", "18:00");
    const lop = (await lopLine(await build(period, emp.actor)))!;
    expect(lop.units).toBe(0.5);
    // A capped day is absence, not a mark: no marks part in the breakdown.
    expect(lop.parts).toBeUndefined();
  });
});

describe("approved time counted as worked time", () => {
  it("keeps an approved late start from turning the day into a half day, when the policy credits it", async () => {
    const credited = { requests: { backdate_days: null }, attendance: { credit_minutes: true } };
    for (const [policy, expected] of [[{ requests: { backdate_days: null } }, 0.5], [credited, undefined]] as const) {
      const { emp, mgr, period } = await setup(policy);
      // 11:00 to 18:30 is 450 minutes, under the 480 full day; the approved two-hour late start covers it.
      await punch(emp.id, WEEK[0], "11:00", "18:30");
      for (const d of WEEK.slice(1)) await punch(emp.id, d, "09:00", "18:00");
      const req = await createLateEarlyRequest(deps, emp.actor, { date: WEEK[0], kind: "late_arrival", at: "11:00", reason: "School run" });
      await approveLateEarlyRequest(deps, mgr.actor, req.uuid);
      const lop = await lopLine(await build(period, emp.actor));
      expect(lop?.units).toBe(expected);
      for (const t of TABLES) await deps.db.delete(t);
    }
  });
});

describe("a run built before the decision", () => {
  it("reports itself stale once a request for its period is decided", async () => {
    const { emp, mgr, period } = await setup({ ...STRICT, requests: { backdate_days: null } });
    for (const d of WEEK) await punch(emp.id, d, "09:40", "18:40");
    const req = await createLateEarlyRequest(deps, emp.actor, { date: WEEK[1], kind: "late_arrival", at: "10:00", reason: "Train" });
    const runId = await build(period, emp.actor);
    await new Promise((r) => setTimeout(r, 5)); // the decision must post-date the build stamp
    await approveLateEarlyRequest(deps, mgr.actor, req.uuid);
    const run = (await deps.db.select().from(schema.payrollRuns).where(eq(schema.payrollRuns.uuid, runId)))[0]!;
    const staleness = await runStaleness(deps, run);
    expect(staleness.changes).toContain("Late arrival / early departure requests (loss-of-pay)");
  });

  it("restates a PUBLISHED period instead of disagreeing with its payslip", async () => {
    const { emp, mgr, period } = await setup({ ...STRICT, requests: { backdate_days: null } });
    for (const d of WEEK) await punch(emp.id, d, "09:40", "18:40");
    const runId = await build(period, emp.actor);
    expect((await lopLine(runId))!.units).toBe(2.5);
    await deps.db.update(schema.payrollRuns).set({ state: "PUBLISHED" }).where(eq(schema.payrollRuns.uuid, runId));

    // Approved afterwards, for a day inside the closed period: one mark fewer, so half a day is owed back.
    const req = await createLateEarlyRequest(deps, emp.actor, { date: WEEK[2], kind: "late_arrival", at: "10:00", reason: "Train" });
    await approveLateEarlyRequest(deps, mgr.actor, req.uuid);

    const adj = await deps.db.select().from(schema.lopAdjustments);
    expect(adj.length).toBe(1);
    expect(adj[0]).toMatchObject({ employeeId: emp.id, payPeriodId: period, chargedUnits: 2.5, correctUnits: 2, dayUnits: 0.5 });
    expect(adj[0]!.amount).toBe(2_200); // positive: owed back, at the run's own 4,400 a day
  });
});

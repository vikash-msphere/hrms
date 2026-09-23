/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
// Loss-of-pay corrections against a CLOSED period, end to end through the database.
//
// `test/lopAdjust.test.ts` covers the arithmetic. This covers everything around it, which is where the risk
// actually sits: deciding whether a day's period is closed at all, recomputing what that period should have
// docked from live attendance, and writing exactly one row per (employee, period) without either duplicating
// a correction or paying the same one twice.
//
// THE CASE THIS FILE EXISTS FOR is the last of those. `charged` is a historical constant, so once a
// correction has been PAID the next restatement must net it off - and the open-row unique index cannot help,
// because it deliberately permits a new row after payment. That is the advance double-credit shape, and it
// is the one failure here that moves money and says nothing.
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { restateLopForDay, restateLopForRange } from "../src/services/payroll";
import type { Line } from "../src/domain/payroll";

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

beforeEach(async () => {
  deps = makeDeps(b); // fresh refCache: settings and periods are memoized per Deps
  for (const t of [schema.lopAdjustments, schema.payrollRunItems, schema.payrollRuns, schema.payPeriods,
    schema.leaveRequests, schema.leaveTypes, schema.employees, schema.settings]) {
    await deps.db.delete(t);
  }
});

const short = (p: string) => `${p}-${genId().slice(0, 6)}`;
const D = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);

/** LOP on, Mon-Fri, so the fixture's absences are real working days. */
async function lopOn(enabled = true) {
  await deps.db.insert(schema.settings).values({
    key: "attendance",
    value: JSON.stringify({ timezone: "Asia/Kolkata", work_days: [1, 2, 3, 4, 5], lop_enabled: enabled, lop_basis: "working_days" }),
  });
}

async function employee(): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.employees).values({
    uuid, code: short("04"), firstName: "Lo", lastName: "Pee", workEmail: `${uuid}@t.example`, status: "active",
    startDate: new Date(D(2020, 1, 1)),
  });
  return uuid;
}

/** March 2026, paid 28 March. Entirely in the past, so "closed" depends only on whether a run committed. */
async function march(): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.payPeriods).values({
    uuid, code: short("pp"), label: "March 2026",
    periodStart: new Date(D(2026, 3, 1)), periodEnd: new Date(D(2026, 3, 31)), payDate: new Date(D(2026, 3, 28)),
  });
  return uuid;
}

/**
 * A run for `periodId` that docked `lopUnits` days at 1,000 a day from a 22,000 regular wage.
 *
 * The LOP line carries both amount and units, which is what `dailyRateOf` reads to price a correction at the
 * rate the period ACTUALLY docked at rather than reconstructing it.
 */
async function runWithLop(periodId: string, employeeId: string, state: "DRAFT" | "APPROVED" | "PUBLISHED", lopUnits: number) {
  const runId = genId();
  await deps.db.insert(schema.payrollRuns).values({ uuid: runId, code: short("pr"), payPeriodId: periodId, state, itemsBuiltAt: new Date() });
  const lines: Line[] = [
    { code: "BASIC", name: "Basic", kind: "earning", amount: 22_000 },
    ...(lopUnits > 0 ? [{ code: "LOP", name: "Loss of pay", kind: "earning" as const, amount: -1_000 * lopUnits, units: lopUnits }] : []),
  ];
  const gross = 22_000 - 1_000 * lopUnits;
  await deps.db.insert(schema.payrollRunItems).values({
    uuid: genId(), code: short("ri"), runId, employeeId,
    linesJson: JSON.stringify(lines), gross, taxableGross: gross, totalDeductions: 0, tax: 0, net: gross,
  });
  return runId;
}

/**
 * A full worked day: clocked in 09:30 and out 18:30 local, so the day clears `full_day_minutes`.
 *
 * WITHOUT THESE THE FIXTURE IS A LIE. `lopDayUnits` docks any scheduled working day with no punch, no
 * approved leave and no holiday - so an employee with no attendance rows at all is absent for the WHOLE
 * month, and the first version of this file asserted a 2-day dock against a period the recompute correctly
 * read as 22 days absent. The run's LOP line said 2 and the attendance said 22, which is not a state the
 * app can produce; the test was describing a month that could not exist.
 */
async function workedDays(employeeId: string, year: number, month: number, absentDays: number[]) {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const absent = new Set(absentDays);
  for (let d = 1; d <= last; d++) {
    const dow = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
    if (dow === 0 || dow === 6 || absent.has(d)) continue;
    await deps.db.insert(schema.attendanceSessions).values({
      uuid: genId(), code: short("at"), employeeId,
      // 04:00Z is 09:30 in Asia/Kolkata, and 13:00Z is 18:30 - the same local day at both ends, 540 minutes.
      clockIn: new Date(Date.UTC(year, month - 1, d, 4, 0)),
      clockOut: new Date(Date.UTC(year, month - 1, d, 13, 0)),
    });
  }
}

/** Approved leave for one day, which EXCUSES that day and so reduces the period's correct LOP. */
async function approvedLeave(employeeId: string, dayMs: number) {
  const typeId = genId();
  await deps.db.insert(schema.leaveTypes).values({ uuid: typeId, code: short("lt"), name: short("Casual") });
  await deps.db.insert(schema.leaveRequests).values({
    uuid: genId(), code: short("lr"), employeeId, leaveTypeId: typeId,
    startDate: new Date(dayMs), endDate: new Date(dayMs), days: 1, state: "APPROVED",
  });
}

const adjustments = () => deps.db.select().from(schema.lopAdjustments);

// 2 March 2026 is a Monday - a working day, so an absence on it is dockable.
const MON = D(2026, 3, 2);

describe("restateLopForDay against a closed period", () => {
  it("raises a correction when a docked day is later excused", async () => {
    // The run docked 2 days. Leave is approved for one of them afterwards, so only 1 was really dockable and
    // the employee is owed that day back.
    await lopOn();
    const emp = await employee();
    const period = await march();
    await workedDays(emp, 2026, 3, [2, 3]); // worked every March working day but the 2nd and 3rd
    await runWithLop(period, emp, "PUBLISHED", 2);
    await approvedLeave(emp, MON);

    await restateLopForDay(deps, emp, MON);

    const rows = await adjustments();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ employeeId: emp, payPeriodId: period, chargedUnits: 2, correctUnits: 1, dayUnits: 1 });
    expect(rows[0]!.amount).toBe(1_000); // positive: owed BACK, priced at the run's own daily rate
  });

  it("raises nothing while the period's run is still a draft", async () => {
    // An open period needs no correction: its own build will read the new attendance.
    await lopOn();
    const emp = await employee();
    const period = await march();
    await workedDays(emp, 2026, 3, [2, 3]); // worked every March working day but the 2nd and 3rd
    await runWithLop(period, emp, "DRAFT", 2);
    await approvedLeave(emp, MON);

    await restateLopForDay(deps, emp, MON);
    expect((await adjustments()).length).toBe(0);
  });

  it("raises nothing when loss of pay is switched off", async () => {
    // `recomputeLopUnits` answers null, not 0. Zero would restate the period to nothing docked and refund
    // every dock the org ever made, on one settings toggle.
    await lopOn(false);
    const emp = await employee();
    const period = await march();
    await workedDays(emp, 2026, 3, [2, 3]); // worked every March working day but the 2nd and 3rd
    await runWithLop(period, emp, "PUBLISHED", 2);
    await approvedLeave(emp, MON);

    await restateLopForDay(deps, emp, MON);
    expect((await adjustments()).length).toBe(0);
  });

  it("raises nothing for a day in no pay period at all", async () => {
    await lopOn();
    const emp = await employee();
    const period = await march();
    await workedDays(emp, 2026, 3, [2, 3]); // worked every March working day but the 2nd and 3rd
    await runWithLop(period, emp, "PUBLISHED", 2);
    await restateLopForDay(deps, emp, D(2027, 6, 1));
    expect((await adjustments()).length).toBe(0);
  });

  it("REPLACES the open correction rather than adding a second", async () => {
    // Restating twice must leave one row. The partial unique index is the backstop; this asserts the service
    // does not rely on hitting it.
    await lopOn();
    const emp = await employee();
    const period = await march();
    await workedDays(emp, 2026, 3, [2, 3]); // worked every March working day but the 2nd and 3rd
    await runWithLop(period, emp, "PUBLISHED", 2);
    await approvedLeave(emp, MON);

    await restateLopForDay(deps, emp, MON);
    await restateLopForDay(deps, emp, MON);

    const rows = await adjustments();
    expect(rows.length).toBe(1);
    expect(rows[0]!.dayUnits).toBe(1);
  });

  it("clears an open correction once the period is docked correctly again", async () => {
    // Attendance can be corrected back. A stale row would pay a correction for a change that was undone, so
    // it is deleted rather than left sitting at zero.
    await lopOn();
    const emp = await employee();
    const period = await march();
    await workedDays(emp, 2026, 3, [2, 3]); // worked every March working day but the 2nd and 3rd
    await runWithLop(period, emp, "PUBLISHED", 2);
    await approvedLeave(emp, MON);
    await restateLopForDay(deps, emp, MON);
    expect((await adjustments()).length).toBe(1);

    // The leave is withdrawn: the day is dockable again and the run was right all along.
    await deps.db.update(schema.leaveRequests).set({ state: "CANCELLED" });
    deps = makeDeps(b);
    await restateLopForDay(deps, emp, MON);
    expect((await adjustments()).length).toBe(0);
  });

  it("nets off a correction that has already been PAID instead of restating the whole thing", async () => {
    // THE DOUBLE-PAY. Dock 2, excuse one day, pay that correction; then excuse the second day. `charged`
    // is still 2, so a naive restatement would raise another 2 - putting 3 days back for a 2-day error. The
    // open-row index cannot catch it, because a new open row beside a PAID one is legitimate.
    await lopOn();
    const emp = await employee();
    const period = await march();
    await workedDays(emp, 2026, 3, [2, 3]); // worked every March working day but the 2nd and 3rd
    const runId = await runWithLop(period, emp, "PUBLISHED", 2);
    await approvedLeave(emp, MON);
    await restateLopForDay(deps, emp, MON);

    // Settle the first correction, exactly as a run pickup would.
    const first = (await adjustments())[0]!;
    expect(first.dayUnits).toBe(1);
    await deps.db.update(schema.lopAdjustments).set({ paidRunId: runId, paidAt: new Date() }).where(eq(schema.lopAdjustments.uuid, first.uuid));

    // Now the second day is excused too. TUE 3 March.
    await approvedLeave(emp, D(2026, 3, 3));
    deps = makeDeps(b);
    await restateLopForDay(deps, emp, MON);

    const open = (await adjustments()).filter((a) => a.paidRunId === null);
    expect(open.length).toBe(1);
    expect(open[0]!.dayUnits).toBe(1); // the RESIDUAL, not the restated total of 2
    const paidOut = (await adjustments()).reduce((s, a) => s + a.dayUnits, 0);
    expect(paidOut).toBe(2); // two days back for a two-day error, never three
  });
});

describe("restateLopForRange", () => {
  it("restates each closed period a range touches, once", async () => {
    // A leave spanning a month boundary belongs to two periods, and a restatement is about the period rather
    // than the day that triggered it - so walking 30 days must not write 30 times.
    await lopOn();
    const emp = await employee();
    const mar = await march();
    const apr = genId();
    await deps.db.insert(schema.payPeriods).values({
      uuid: apr, code: short("pp"), label: "April 2026",
      periodStart: new Date(D(2026, 4, 1)), periodEnd: new Date(D(2026, 4, 30)), payDate: new Date(D(2026, 4, 28)),
    });
    // One absent day either side of the boundary, matching the one day each run docked.
    await workedDays(emp, 2026, 3, [30]);
    await workedDays(emp, 2026, 4, [1]);
    await runWithLop(mar, emp, "PUBLISHED", 1);
    await runWithLop(apr, emp, "PUBLISHED", 1);
    // Leave across the boundary: 30 March to 2 April.
    const typeId = genId();
    await deps.db.insert(schema.leaveTypes).values({ uuid: typeId, code: short("lt"), name: short("Casual") });
    await deps.db.insert(schema.leaveRequests).values({
      uuid: genId(), code: short("lr"), employeeId: emp, leaveTypeId: typeId,
      startDate: new Date(D(2026, 3, 30)), endDate: new Date(D(2026, 4, 2)), days: 4, state: "APPROVED",
    });

    await restateLopForRange(deps, emp, D(2026, 3, 30), D(2026, 4, 2));

    const rows = await adjustments();
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.payPeriodId))).toEqual(new Set([mar, apr]));
  });
});

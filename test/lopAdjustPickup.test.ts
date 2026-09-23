/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
// A loss-of-pay correction being PAID by a real run, and what that payment does to the next restatement.
//
// WHAT WAS UNTESTED. `test/lopAdjust.test.ts` covers the arithmetic and `test/lopRestate.test.ts` covers the
// queue, but the seam between them was taken on trust. The netting test there settles a correction with a
// direct write:
//
//     // Settle the first correction, exactly as a run pickup would.
//     await deps.db.update(schema.lopAdjustments).set({ paidRunId: runId, paidAt: new Date() })...
//
// "exactly as a run pickup would" is an assumption wearing a comment. Nothing anywhere proved that building
// a run actually sets `paid_run_id`, and the double-pay guard is built entirely on that marker: `settled`
// sums the rows where `paid_run_id is not null`. If the build put the line on the payslip and failed to
// stamp the marker, every test in the suite would still pass and the correction would be paid again by the
// next run, and again by the one after - a refund that repeats monthly, which is the same shape as the
// advance double-credit and just as quiet.
//
// So this file asserts the marker through the real build, and then runs the second correction against a
// marker the RUN wrote rather than one the test wrote. That is the only version of the netting test that
// can fail if the wiring is wrong.
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq, isNull } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { createRun, buildRunItems, listRunItems, restateLopForDay } from "../src/services/payroll";
import { LOP_ADJUST_CODE } from "../src/domain/lopAdjust";
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
    schema.attendanceSessions, schema.leaveRequests, schema.leaveTypes, schema.compensation,
    schema.users, schema.employees, schema.settings]) {
    await deps.db.delete(t);
  }
});

const short = (p: string) => `${p}-${genId().slice(0, 6)}`;
const D = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);

/** LOP on, Mon-Fri, so the fixture's absences land on real working days. */
async function lopOn() {
  await deps.db.insert(schema.settings).values({
    key: "attendance",
    value: JSON.stringify({ timezone: "Asia/Kolkata", work_days: [1, 2, 3, 4, 5], lop_enabled: true, lop_basis: "working_days" }),
  });
}

/**
 * An employee on 22,000 a month, which over March 2026's 22 working days is exactly the 1,000/day that the
 * closed run docked at. Keeping the two in step matters: `lopAdjustment` prices the correction off the CLOSED
 * run's own LOP line, so a mismatch here would hide a pricing bug behind a coincidence.
 */
async function employee(): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.employees).values({
    uuid, code: short("04"), firstName: "Lo", lastName: "Pee", workEmail: `${uuid}@t.example`, status: "active",
    startDate: new Date(D(2020, 1, 1)),
  });
  await deps.db.insert(schema.compensation).values({
    uuid: genId(), code: short("cmp"), employeeId: uuid, ctcAnnual: 264_000, basePay: 22_000,
    specialAllowance: 0, currency: "INR", effectiveFrom: new Date(D(2020, 1, 1)), effectiveTo: null,
  });
  return uuid;
}

// `as unknown as AppUser` drops `policy` and `roles`, and a service that reaches for either throws a long
// way from here. The build path used below does not, and the cast is the fixture convention in the money
// tests; if this file ever starts failing inside authz rather than on an assertion, that is the reason.
async function actorFor(employeeId: string): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const uuid = genId();
  const email = `${uuid}@t.example`;
  await deps.db.insert(schema.users).values({ uuid, code: short("u"), email, role: "employee", employeeId });
  return { uuid, email, role: "employee", status: "active", employeeId, employeeCode: null } as unknown as AppUser;
}

async function period(label: string, y: number, m: number): Promise<string> {
  const uuid = genId();
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  await deps.db.insert(schema.payPeriods).values({
    uuid, code: short("pp"), label,
    periodStart: new Date(D(y, m, 1)), periodEnd: new Date(D(y, m, last)), payDate: new Date(D(y, m, last)),
  });
  return uuid;
}

/** A PUBLISHED March run that docked `lopUnits` days at 1,000 each - the closed period being corrected. */
async function publishedMarchRun(periodId: string, employeeId: string, lopUnits: number) {
  const runId = genId();
  await deps.db.insert(schema.payrollRuns).values({
    uuid: runId, code: short("pr"), payPeriodId: periodId, state: "PUBLISHED", itemsBuiltAt: new Date(),
  });
  const lines: Line[] = [
    { code: "BASIC", name: "Basic", kind: "earning", amount: 22_000 },
    { code: "LOP", name: "Loss of pay", kind: "earning", amount: -1_000 * lopUnits, units: lopUnits },
  ];
  const gross = 22_000 - 1_000 * lopUnits;
  await deps.db.insert(schema.payrollRunItems).values({
    uuid: genId(), code: short("ri"), runId, employeeId,
    linesJson: JSON.stringify(lines), gross, taxableGross: gross, totalDeductions: 0, tax: 0, net: gross,
  });
  return runId;
}

/** Full worked days for the month, minus `absentDays`. Without these the recompute reads the whole month as
 *  absent and the fixture describes a state the app cannot produce. */
async function workedDays(employeeId: string, year: number, month: number, absentDays: number[]) {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const absent = new Set(absentDays);
  for (let d = 1; d <= last; d++) {
    const dow = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
    if (dow === 0 || dow === 6 || absent.has(d)) continue;
    await deps.db.insert(schema.attendanceSessions).values({
      uuid: genId(), code: short("at"), employeeId,
      // 04:00Z is 09:30 in Asia/Kolkata and 13:00Z is 18:30: the same local day at both ends, 540 minutes.
      clockIn: new Date(Date.UTC(year, month - 1, d, 4, 0)),
      clockOut: new Date(Date.UTC(year, month - 1, d, 13, 0)),
    });
  }
}

/** Approved leave for one day, which EXCUSES it and so lowers the period's correct loss of pay. */
async function approvedLeave(employeeId: string, dayMs: number) {
  const typeId = genId();
  await deps.db.insert(schema.leaveTypes).values({ uuid: typeId, code: short("lt"), name: short("Casual") });
  await deps.db.insert(schema.leaveRequests).values({
    uuid: genId(), code: short("lr"), employeeId, leaveTypeId: typeId,
    startDate: new Date(dayMs), endDate: new Date(dayMs), days: 1, state: "APPROVED",
  });
}

const adjustments = () => deps.db.select().from(schema.lopAdjustments);
const openAdjustments = () => deps.db.select().from(schema.lopAdjustments).where(isNull(schema.lopAdjustments.paidRunId));

// 2 and 3 March 2026 are a Monday and a Tuesday: working days, so absences on them are dockable.
const MON = D(2026, 3, 2);
const TUE = D(2026, 3, 3);

describe("a run pays a loss-of-pay correction", () => {
  it("puts a signed LOPADJ line on the payslip naming the period it corrects", async () => {
    await lopOn();
    const emp = await employee();
    const actor = await actorFor(emp);
    const march = await period("March 2026", 2026, 3);
    await workedDays(emp, 2026, 3, [2]); // absent only the 2nd
    await publishedMarchRun(march, emp, 1);
    await approvedLeave(emp, MON); // ...and that absence is excused after March closed
    await restateLopForDay(deps, emp, MON);
    expect((await openAdjustments())[0]!.dayUnits).toBe(1);

    const april = await period("April 2026", 2026, 4);
    const run = await createRun(deps, actor, `pay-periods/${april}`);
    await buildRunItems(deps, actor, run.uuid);

    const lines = (await listRunItems(deps, run.uuid))[0]!.lines;
    const adj = lines.find((l) => l.code === LOP_ADJUST_CODE)!;
    expect(adj).toBeDefined();
    // An EARNING, not a deduction: loss of pay itself is a negative earning, so a refund has to sit on the
    // same side or the two never net out across a payslip.
    expect(adj.kind).toBe("earning");
    expect(adj.amount).toBe(1_000);
    expect(adj.units).toBe(1);
    // Named for MARCH while appearing on the April payslip - the entire point of the line is that it is not
    // about this month, and a reader who cannot see which month it corrects cannot check it.
    expect(adj.name).toContain("March 2026");
  });

  it("stamps paid_run_id with the run that paid it, which is what stops the second payment", async () => {
    await lopOn();
    const emp = await employee();
    const actor = await actorFor(emp);
    const march = await period("March 2026", 2026, 3);
    await workedDays(emp, 2026, 3, [2]);
    await publishedMarchRun(march, emp, 1);
    await approvedLeave(emp, MON);
    await restateLopForDay(deps, emp, MON);

    const april = await period("April 2026", 2026, 4);
    const run = await createRun(deps, actor, `pay-periods/${april}`);
    await buildRunItems(deps, actor, run.uuid);

    const rows = await adjustments();
    expect(rows.length).toBe(1);
    expect(rows[0]!.paidRunId).toBe(run.uuid);
    expect(rows[0]!.paidAt).not.toBeNull();
    // And it has LEFT the queue, so the May build does not read it again.
    expect((await openAdjustments()).length).toBe(0);
  });

  it("does not pay the same correction twice when a later run is built", async () => {
    // The marker's whole job. With `paid_run_id` set, `openAdjustmentsFor` must not return the row, so May
    // sees nothing to pay. If the marker were missing, this is where the monthly repeat would show up.
    await lopOn();
    const emp = await employee();
    const actor = await actorFor(emp);
    const march = await period("March 2026", 2026, 3);
    await workedDays(emp, 2026, 3, [2]);
    await publishedMarchRun(march, emp, 1);
    await approvedLeave(emp, MON);
    await restateLopForDay(deps, emp, MON);

    const april = await period("April 2026", 2026, 4);
    const aprilRun = await createRun(deps, actor, `pay-periods/${april}`);
    await buildRunItems(deps, actor, aprilRun.uuid);

    const may = await period("May 2026", 2026, 5);
    const mayRun = await createRun(deps, actor, `pay-periods/${may}`);
    await buildRunItems(deps, actor, mayRun.uuid);

    const mayLines = (await listRunItems(deps, mayRun.uuid))[0]!.lines;
    expect(mayLines.find((l) => l.code === LOP_ADJUST_CODE)).toBeUndefined();
    // Still exactly one correction, still pinned to April.
    const rows = await adjustments();
    expect(rows.length).toBe(1);
    expect(rows[0]!.paidRunId).toBe(aprilRun.uuid);
  });

  it("nets a second correction against what the RUN already paid, not against a marker a test wrote", async () => {
    // THE DOUBLE-PAY, end to end. Dock 2, excuse one day, let a real run pay it; then excuse the second day.
    // `charged` is still 2, so a restatement that ignored the settled day would raise another 2 and put 3
    // days back for a 2-day error. The open-row unique index cannot catch it, because a new open row beside
    // a PAID one is legitimate - the marker is the only thing standing in the way.
    await lopOn();
    const emp = await employee();
    const actor = await actorFor(emp);
    const march = await period("March 2026", 2026, 3);
    await workedDays(emp, 2026, 3, [2, 3]); // absent the 2nd and the 3rd
    await publishedMarchRun(march, emp, 2);
    await approvedLeave(emp, MON);
    await restateLopForDay(deps, emp, MON);
    expect((await openAdjustments())[0]!.dayUnits).toBe(1);

    const april = await period("April 2026", 2026, 4);
    const aprilRun = await createRun(deps, actor, `pay-periods/${april}`);
    await buildRunItems(deps, actor, aprilRun.uuid);
    expect((await openAdjustments()).length).toBe(0); // paid by the run, not by this test

    // Now the second day is excused too.
    await approvedLeave(emp, TUE);
    deps = makeDeps(b); // the period and settings caches are memoized per Deps
    await restateLopForDay(deps, emp, MON);

    const open = await openAdjustments();
    expect(open.length).toBe(1);
    expect(open[0]!.dayUnits).toBe(1); // the RESIDUAL, not the restated total of 2
    const total = (await adjustments()).reduce((s, a) => s + a.dayUnits, 0);
    expect(total).toBe(2); // two days back for a two-day error, never three

    // And the residual is payable exactly once more.
    const may = await period("May 2026", 2026, 5);
    const mayRun = await createRun(deps, actor, `pay-periods/${may}`);
    await buildRunItems(deps, actor, mayRun.uuid);
    const mayAdj = (await listRunItems(deps, mayRun.uuid))[0]!.lines.find((l) => l.code === LOP_ADJUST_CODE)!;
    expect(mayAdj.amount).toBe(1_000);
    const paidOut = (await adjustments()).reduce((s, a) => s + a.amount, 0);
    expect(paidOut).toBe(2_000); // 2,000 refunded for 2,000 over-docked
  });

  it("recovers money on a run when the correction is negative", async () => {
    // The other direction, which has no test anywhere through a run. The March run docked ONE day but the
    // attendance says two were absent, so the employee was underdocked and owes a day back. A build that
    // only handled refunds - or that clamped the line to positive - would silently drop the recovery.
    await lopOn();
    const emp = await employee();
    const actor = await actorFor(emp);
    const march = await period("March 2026", 2026, 3);
    await workedDays(emp, 2026, 3, [2, 3]); // two absences...
    await publishedMarchRun(march, emp, 1); // ...but the run docked only one
    await restateLopForDay(deps, emp, MON);

    const open = await openAdjustments();
    expect(open.length).toBe(1);
    expect(open[0]!.dayUnits).toBe(-1);

    const april = await period("April 2026", 2026, 4);
    const run = await createRun(deps, actor, `pay-periods/${april}`);
    await buildRunItems(deps, actor, run.uuid);

    const adj = (await listRunItems(deps, run.uuid))[0]!.lines.find((l) => l.code === LOP_ADJUST_CODE)!;
    expect(adj.kind).toBe("earning"); // still an earning; the SIGN carries the direction
    expect(adj.amount).toBe(-1_000);
    expect(adj.name).toContain("recovered");
    const row = (await adjustments())[0]!;
    expect(row.paidRunId).toBe(run.uuid);
  });

  it("leaves nothing queued when a correction is raised and then cancelled before any run pays it", async () => {
    // A correction that resolves itself must GO, not sit at zero. A zero row would be picked up by the next
    // build, priced at nothing, and marked paid - a payslip line saying nothing happened.
    await lopOn();
    const emp = await employee();
    const actor = await actorFor(emp);
    const march = await period("March 2026", 2026, 3);
    await workedDays(emp, 2026, 3, [2]);
    await publishedMarchRun(march, emp, 1);
    await approvedLeave(emp, MON);
    await restateLopForDay(deps, emp, MON);
    expect((await openAdjustments()).length).toBe(1);

    // The leave is rescinded, so March was docked correctly after all.
    await deps.db.delete(schema.leaveRequests).where(eq(schema.leaveRequests.employeeId, emp));
    deps = makeDeps(b);
    await restateLopForDay(deps, emp, MON);
    expect((await adjustments()).length).toBe(0);

    const april = await period("April 2026", 2026, 4);
    const run = await createRun(deps, actor, `pay-periods/${april}`);
    await buildRunItems(deps, actor, run.uuid);
    const lines = (await listRunItems(deps, run.uuid))[0]!.lines;
    expect(lines.find((l) => l.code === LOP_ADJUST_CODE)).toBeUndefined();
  });

  it("prices a company with more employees than one statement can bind", async () => {
    // THE CORRECTION QUEUE IS READ FOR EVERY EMPLOYEE THE RUN MAY PRICE, so its id list is the company's
    // headcount - and D1 binds at most 100 parameters per statement. Unchunked, the whole build answered 500
    // (`D1_ERROR: too many SQL variables`) for any org past about a hundred people: not a wrong payslip, no
    // payroll at all, and only above a size no other test in this file reaches. Every other case here runs one
    // employee, which is exactly why it shipped.
    await lopOn();
    const staff: string[] = [];
    for (let i = 0; i < 120; i++) staff.push(await employee());
    const actor = await actorFor(staff[0]!);

    // One of them is also owed a correction, so the read this is about has something to find as well as a long
    // list to find it in - a chunked read that returned nothing would pass a bare "it did not throw".
    const march = await period("March 2026", 2026, 3);
    await workedDays(staff[0]!, 2026, 3, [2]);
    await publishedMarchRun(march, staff[0]!, 1);
    await approvedLeave(staff[0]!, MON);
    await restateLopForDay(deps, staff[0]!, MON);

    const april = await period("April 2026", 2026, 4);
    const run = await createRun(deps, actor, `pay-periods/${april}`);
    await buildRunItems(deps, actor, run.uuid);

    const items = await listRunItems(deps, run.uuid);
    expect(items.length).toBe(120);
    const corrected = items.find((i) => i.lines.some((l) => l.code === LOP_ADJUST_CODE))!;
    expect(corrected).toBeDefined();
    expect(corrected.lines.find((l) => l.code === LOP_ADJUST_CODE)!.amount).toBe(1_000);
  });
});

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
import { createRun, buildRunItems, listRunItems, transition, runStaleness } from "../src/services/payroll";
import { finalizedTotals, fyWindow, getEmployeeTaxProjection } from "../src/services/taxProjection";
import { createPayrollOpening, updatePayrollOpening, importPayrollOpenings, checkFigures } from "../src/services/payrollOpenings";
import { assembleForm16 } from "../src/services/form16";
import { reviseCompensation } from "../src/services/compensation";

// Pay and tax already paid this financial year before HRMS ran payroll (services/payrollOpenings.ts).
//
// The money this is about is the first HRMS payroll's TDS: it is the year's tax spread over the months left,
// less what was already deducted, and "already deducted" was zero for everyone who was paid April-August by
// the system before. What is pinned here is that the opening reaches every reader of the year's totals - the
// build's TDS, the PT cap, the ESI rule, the Tax page, Form 16 - and that it can never cover a month HRMS paid.

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
  schema.payrollOpenings, schema.payrollRunItems, schema.payslips, schema.payrollRuns, schema.payPeriods,
  schema.compensation, schema.payComponents, schema.notifications, schema.eventLog, schema.automationRuns,
  schema.auditLog, schema.users, schema.employees, schema.roles, schema.settings,
];

// Saturday 26 September 2026 in IST. HRMS went live on the 24th; the old system paid April to August.
const NOW = "2026-09-26T06:00:00Z";
const FY = "2026-27";
const short = (p: string) => `${p}-${genId().slice(0, 6)}`;
const actor = { uuid: genId(), email: "admin@t.example", role: "super_admin", status: "active", employeeId: null, employeeCode: null } as unknown as AppUser;

beforeEach(async () => {
  deps = makeDeps(b);
  deps.clock = { now: () => new Date(NOW) };
  for (const t of TABLES) await deps.db.delete(t);
  await deps.db.insert(schema.roles).values({ name: "super_admin", label: "Super admin" }).onConflictDoNothing();
  await deps.db.insert(schema.users).values({ uuid: actor.uuid, code: short("u"), email: actor.email, role: "super_admin" });
  await deps.db.insert(schema.settings).values({ key: "approvals", value: JSON.stringify({ allow_self_approval: true }), updatedAt: new Date() });
});

let n = 0;
async function person(basePay = 100_000): Promise<string> {
  n += 1;
  const id = genId();
  await deps.db.insert(schema.employees).values({
    uuid: id, code: `04-002-${String(n).padStart(3, "0")}`, firstName: "Test", lastName: `Payee${n}`,
    workEmail: `${id}@t.example`, status: "active", startDate: new Date("2021-03-01T00:00:00Z"),
    trackedFrom: new Date("2026-09-24T00:00:00Z"),
  });
  await deps.db.insert(schema.compensation).values({
    uuid: genId(), code: short("cmp"), employeeId: id, ctcAnnual: 0, basePay, specialAllowance: 0,
    currency: "INR", effectiveFrom: new Date("2025-01-01"), effectiveTo: null,
  });
  return id;
}
async function component(over: { name: string; method: string; rate?: number; cap?: number; regime?: string }) {
  await deps.db.insert(schema.payComponents).values({
    uuid: genId(), code: short("pc"), name: over.name, kind: "deduction",
    method: over.method as typeof schema.payComponents.$inferInsert.method, rate: over.rate ?? null, cap: over.cap ?? null,
    regime: over.regime ?? null, pfWages: false, recurring: true,
  });
}
async function period(month: string): Promise<string> {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const uuid = genId();
  const end = new Date(Date.UTC(y, m, 0));
  await deps.db.insert(schema.payPeriods).values({ uuid, code: short("pp"), label: month, periodStart: new Date(Date.UTC(y, m - 1, 1)), periodEnd: end, payDate: end });
  return uuid;
}
async function build(periodId: string) {
  const run = await createRun(deps, actor, `pay-periods/${periodId}`);
  await buildRunItems(deps, actor, run.uuid);
  return run;
}
const lineOf = async (runId: string, code: string) => (await listRunItems(deps, runId))[0]!.lines.find((l) => l.code === code)?.amount ?? 0;
const opening = (emp: string, over: Record<string, unknown> = {}) =>
  createPayrollOpening(deps, actor, { employee: `employees/${emp}`, financial_year: FY, paid_through: "2026-08", gross: 500_000, taxable_gross: 500_000, tds: 20_000, pt: 1_000, ...over });

describe("the year's totals include pay before HRMS", () => {
  it("folds the figures and the months they cover into finalizedTotals", async () => {
    const emp = await person();
    await opening(emp);
    const t = (await finalizedTotals(deps, fyWindow(new Date("2026-09-30")))).get(emp)!;
    expect(t).toMatchObject({ gross: 500_000, taxableGross: 500_000, tax: 20_000, pt: 1_000, months: 5 });
    expect([...t.earnedMonths].sort()).toEqual(["2026-04", "2026-05", "2026-06", "2026-07", "2026-08"]);
    expect([...t.paidMonths].sort()).toEqual(["2026-04", "2026-05", "2026-06", "2026-07", "2026-08"]);
    expect(t.opening).toMatchObject({ taxableGross: 500_000, tax: 20_000, paidThrough: "2026-08" });
    // Another year's reading is untouched.
    expect((await finalizedTotals(deps, fyWindow(new Date("2025-09-30")))).get(emp)).toBeUndefined();
  });

  it("takes the TDS already deducted off the first HRMS payroll's withholding", async () => {
    await component({ name: "Income Tax (TDS)", method: "income_tax", regime: "new" });
    // 24 lakh a year: well clear of the new regime's rebate, so the year has tax to spread.
    const emp = await person(200_000);
    const sep = await period("2026-09");
    const without = await lineOf((await build(sep)).uuid, "TDS");
    expect(without).toBeGreaterThan(0);
    // Exactly what the salary was worth for those five months, so only the tax already deducted differs.
    await opening(emp, { gross: 1_000_000, taxable_gross: 1_000_000 });
    const withOpening = await lineOf((await build(sep)).uuid, "TDS");
    // Same year's income either way (the five months are income whether HRMS paid them or not); the tax still
    // owed is 20,000 less, spread over the seven months September to March.
    expect(Math.abs(withOpening - (without - 20_000 / 7))).toBeLessThanOrEqual(1);
  });

  it("stops charging professional tax once the year's cap was reached before HRMS", async () => {
    await component({ name: "Professional Tax", method: "pt" });
    const emp = await person();
    const sep = await period("2026-09");
    expect(await lineOf((await build(sep)).uuid, "PT")).toBeGreaterThan(0);
    await opening(emp, { pt: 2_500 });
    expect(await lineOf((await build(sep)).uuid, "PT")).toBe(0);
  });

  it("keeps ESI going when the system before was deducting it in this contribution period", async () => {
    await component({ name: "ESI", method: "esi", rate: 0.75, cap: 21_000 });
    // Above the ceiling now, after a raise: a fresh test says no ESI.
    const emp = await person(25_000);
    const sep = await period("2026-09");
    expect(await lineOf((await build(sep)).uuid, "ESI")).toBe(0);
    await opening(emp, { gross: 100_000, taxable_gross: 100_000, tds: 0, pt: 0, esi_contributing: true });
    expect(await lineOf((await build(sep)).uuid, "ESI")).toBeGreaterThan(0);
  });

  it("marks a built draft run stale when pay before HRMS is entered for somebody in it", async () => {
    const emp = await person();
    const run = await build(await period("2026-09"));
    deps.clock = { now: () => new Date(Date.parse(NOW) + 60_000) };
    await opening(emp);
    const row = (await deps.db.select().from(schema.payrollRuns).where(eq(schema.payrollRuns.uuid, run.uuid)))[0]!;
    expect((await runStaleness(deps, row)).changes).toContain("Pay and tax before HRMS");
  });

  it("names the amount on the Tax page and on Form 16", async () => {
    await component({ name: "Income Tax (TDS)", method: "income_tax", regime: "new" });
    const emp = await person();
    await opening(emp);
    const row = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, emp)))[0]!;
    const p = await getEmployeeTaxProjection(deps, row, {}, new Date(NOW));
    expect(p.beforeHrms).toEqual({ taxableGross: 500_000, tax: 20_000, paidThrough: "2026-08" });
    expect(p.deductedToDate).toBe(20_000);
    const form = await assembleForm16(deps, emp, FY);
    const text = JSON.stringify(form.content.blocks);
    expect(text).toContain("through August 2026");
  });
});

const periodsOf = (row: { arrearsPeriodsJson: string | null }) => JSON.parse(row.arrearsPeriodsJson ?? "[]") as { label: string; months: number }[];

describe("a backdated raise owes arrears for the months paid before HRMS", () => {
  it("counts each month the opening covers inside the window, at the old rate", async () => {
    const emp = await person(100_000);
    await opening(emp); // April to August 2026, paid by the system before HRMS
    const row = await reviseCompensation(deps, actor, { employee: `employees/${emp}`, annual_ctc: 1_500_000, effective_from: "2026-04-01" });
    const delta = row.basePay + row.specialAllowance - 100_000;
    expect(delta).toBeGreaterThan(0);
    expect(row.arrearsAmount).toBeCloseTo(delta * 5, 2);
    expect(periodsOf(row).map((p) => [p.label, p.months])).toEqual([
      ["Apr 2026 (before HRMS)", 1], ["May 2026 (before HRMS)", 1], ["Jun 2026 (before HRMS)", 1],
      ["Jul 2026 (before HRMS)", 1], ["Aug 2026 (before HRMS)", 1],
    ]);
  });

  it("only from the month someone joined, and only from the effective date", async () => {
    const emp = await person(100_000);
    await deps.db.update(schema.employees).set({ startDate: new Date("2026-06-16T00:00:00Z") }).where(eq(schema.employees.uuid, emp));
    await opening(emp);
    const row = await reviseCompensation(deps, actor, { employee: `employees/${emp}`, annual_ctc: 1_500_000, effective_from: "2026-05-01" });
    // Joined 16 June: half of June (15 of 30 days), then July and August.
    expect(periodsOf(row).map((p) => p.months)).toEqual([0.5, 1, 1]);
    const delta = row.basePay + row.specialAllowance - 100_000;
    expect(row.arrearsAmount).toBeCloseTo(delta * 2.5, 2);
  });

  it("owes nothing without an opening, as before", async () => {
    const emp = await person(100_000);
    const row = await reviseCompensation(deps, actor, { employee: `employees/${emp}`, annual_ctc: 1_500_000, effective_from: "2026-04-01" });
    expect(row.arrearsAmount).toBe(0);
  });
});

describe("what an opening may cover", () => {
  it("refuses a month a finalized HRMS run already paid", async () => {
    const emp = await person();
    const aug = await build(await period("2026-08"));
    await transition(deps, actor, aug.uuid, "REVIEW");
    await transition(deps, actor, aug.uuid, "APPROVED");
    await expect(opening(emp)).rejects.toThrow(/already paid this person for 2026-08/);
    const ok = await opening(emp, { paid_through: "2026-07", gross: 400_000, taxable_gross: 400_000 });
    await expect(updatePayrollOpening(deps, actor, ok.uuid, { paid_through: "2026-08" })).rejects.toThrow(/already paid/);
  });

  it("refuses a payroll build for a month the pay before HRMS already covers", async () => {
    const emp = await person();
    await opening(emp);
    const aug = await period("2026-08");
    const run = await createRun(deps, actor, `pay-periods/${aug}`);
    await expect(buildRunItems(deps, actor, run.uuid)).rejects.toThrow(/pay before HRMS already covers 2026-08 for Test Payee/);
    // The next month is HRMS's to pay.
    await expect(build(await period("2026-09"))).resolves.toBeTruthy();
  });

  it("refuses figures that do not add up, and a second entry for the same year", async () => {
    const emp = await person();
    await expect(opening(emp, { financial_year: "2026-28" })).rejects.toThrow(/financial_year/);
    await expect(opening(emp, { paid_through: "2027-04" })).rejects.toThrow(/month in 2026-27/);
    await expect(opening(emp, { paid_through: "2026-10" })).rejects.toThrow(/hasn't started/);
    await expect(opening(emp, { tds: 600_000 })).rejects.toThrow(/tds can't be more/);
    const first = await opening(emp);
    await expect(opening(emp)).rejects.toThrow(/already has pay before HRMS/);
    // Deleted, a new one can be entered for the year.
    await deps.db.update(schema.payrollOpenings).set({ deleteTime: new Date() }).where(eq(schema.payrollOpenings.uuid, first.uuid));
    await expect(opening(emp)).resolves.toBeTruthy();
  });

  it("checks the pure rules on their own", () => {
    const f = { financialYear: FY, paidThrough: "2026-08", gross: 1, taxableGross: 1, tds: 0, pt: 0, esiContributing: false, note: null };
    expect(checkFigures(f, "2026-09")).toBeNull();
    expect(checkFigures({ ...f, paidThrough: "2026-13" }, "2026-09")).toMatch(/must be a month/);
    expect(checkFigures({ ...f, gross: -1 }, "2026-09")).toMatch(/gross must be/);
  });
});

describe("payroll-openings:importOpenings", () => {
  it("previews without writing, applies, then changes only what differs", async () => {
    const a = await person();
    const c = await person();
    const items = [
      { employee: `employees/${a}`, financial_year: FY, paid_through: "2026-08", gross: 500_000, taxable_gross: 480_000, tds: 20_000, pt: 1_000 },
      { employee: `employees/${c}`, financial_year: FY, paid_through: "2026-08", gross: 300_000, tds: 5_000 },
      { employee: `employees/${c}`, financial_year: FY, paid_through: "2026-07", gross: 1 },
      { employee: "employees/nobody", financial_year: FY, paid_through: "2026-08", gross: 1 },
    ];
    const plan = await importPayrollOpenings(deps, actor, items, true);
    expect(plan.counts).toEqual({ created: 2, updated: 0, unchanged: 0, error: 2 });
    expect(plan.results[2]).toMatchObject({ outcome: "error", error: expect.stringMatching(/more than once/) });
    expect(plan.results[3]).toMatchObject({ outcome: "error", error: "no such employee" });
    expect(await deps.db.select().from(schema.payrollOpenings)).toHaveLength(0);

    const applied = await importPayrollOpenings(deps, actor, items.slice(0, 2), false);
    expect(applied.counts).toEqual({ created: 2, updated: 0, unchanged: 0, error: 0 });
    const rows = await deps.db.select().from(schema.payrollOpenings);
    expect(rows.map((r) => r.taxableGross).sort()).toEqual([300_000, 480_000]); // a blank taxable gross is the gross
    expect(rows.every((r) => r.code?.startsWith("04-002-"))).toBe(true); // coded under the owner
    expect((await deps.db.select().from(schema.auditLog)).filter((x) => x.action === "payroll_opening.create")).toHaveLength(2);

    const again = await importPayrollOpenings(deps, actor, items.slice(0, 2), false);
    expect(again.counts).toEqual({ created: 0, updated: 0, unchanged: 2, error: 0 });

    const fixed = await importPayrollOpenings(deps, actor, [{ ...items[1]!, tds: 6_000 }], false);
    expect(fixed.counts.updated).toBe(1);
    expect(fixed.results[0]!.previous).toMatchObject({ tds: 5_000 });
    const after = (await deps.db.select().from(schema.payrollOpenings).where(eq(schema.payrollOpenings.employeeId, c)))[0]!;
    expect(after.tds).toBe(6_000);
    expect(await deps.db.select().from(schema.payrollOpenings)).toHaveLength(2);
  });

  it("applies once when two imports of the same new entry race", async () => {
    const a = await person();
    const item = { employee: `employees/${a}`, financial_year: FY, paid_through: "2026-08", gross: 500_000 };
    const [x, y] = await Promise.all([importPayrollOpenings(deps, actor, [item], false), importPayrollOpenings(deps, actor, [item], false)]);
    const outcomes = [x.results[0]!.outcome, y.results[0]!.outcome].sort();
    expect(outcomes[0]).toBe("created");
    expect(await deps.db.select().from(schema.payrollOpenings)).toHaveLength(1);
  });
});

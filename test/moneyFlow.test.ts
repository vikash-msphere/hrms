/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
// Glob every migration (ordered by filename) so squashing/adding migrations never breaks this suite.
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";

import { createRun, buildRunItems, transition, listRunItems, getRun, runStaleness, previewRunItemPayslip } from "../src/services/payroll";
import { createLoan, approveLoan, disburseLoan, recordLoanRepayment } from "../src/services/loans";
import { recordBonus } from "../src/services/bonuses";
import { computeAndStoreEncashment, approveEncashment, cancelEncashment } from "../src/services/leaveEncashments";
import { createReimbursement, approveReimbursement, approvedUnpaidReimbursements } from "../src/services/reimbursements";
import { computeAndStoreSettlement } from "../src/services/settlements";
import { createSalaryStructure } from "../src/services/salaryStructures";
import { reviseCompensation, reapplySplitCurrent, splitStatus } from "../src/services/compensation";
import { createPayComponent } from "../src/services/payComponents";
import { createPayPeriod } from "../src/services/payPeriods";
import { getTaxDetails, setTaxDetails, listPendingTaxVerifications } from "../src/services/taxDetails";
import { acceptOffer } from "../src/services/ats";

// DB-backed regression tests for the money-handling service logic. Real D1 (miniflare); each test seeds only
// what it needs and clears between runs. These guard the fixes: FnF structure gross, encashment cap-at-approve,
// FnF reimbursement settle, bonus double-submit dedup, one-committed-run-per-period, loan net cap, manual
// repayment dedup, single-currency guard, and offer->compensation seeding.
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

// FK-safe clear order: children before parents.
const TABLES = [
  schema.loanRepayments, schema.payrollRunItems, schema.payslips, schema.payrollRuns, schema.payPeriods,
  schema.loans, schema.bonuses, schema.leaveEncashments, schema.leaveBalances, schema.leaveRequests, schema.leaveTypes,
  schema.reimbursements, schema.settlements, schema.compensation, schema.salaryStructures, schema.payComponents,
  schema.offers, schema.applications, schema.candidates, schema.jobRequisitions,
  schema.transitions, schema.jobs, schema.notifications, schema.eventLog, schema.automationRuns, schema.workflowInstances,
  schema.users, schema.employees, schema.roles,
];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

const short = (p: string) => `${p}-${genId().slice(0, 6)}`;
const today = () => new Date().toISOString().slice(0, 10);

async function seedEmployee(over: Partial<typeof schema.employees.$inferInsert> = {}): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.employees).values({
    uuid, code: over.code ?? short("04"), firstName: over.firstName ?? "Test", lastName: over.lastName ?? "User",
    workEmail: `${uuid}@test.example`, status: "active", ...over,
  });
  return uuid;
}
async function seedActor(employeeId: string): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const uuid = genId();
  const email = `${uuid}@test.example`;
  await deps.db.insert(schema.users).values({ uuid, code: short("u"), email, role: "employee", employeeId });
  return { uuid, email, role: "employee", status: "active", employeeId, employeeCode: null } as unknown as AppUser;
}
async function seedComp(employeeId: string, over: Partial<typeof schema.compensation.$inferInsert> = {}) {
  await deps.db.insert(schema.compensation).values({
    uuid: genId(), code: short("cmp"), employeeId, ctcAnnual: 0, basePay: 30000, specialAllowance: 0,
    currency: "INR", effectiveFrom: new Date("2025-01-01"), effectiveTo: null, ...over,
  });
}
async function seedPeriod(): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.payPeriods).values({
    uuid, code: short("pp"), label: "Jan 2026",
    periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-01-31"), payDate: new Date("2026-01-31"),
  });
  return uuid;
}
async function seedComponent(over: { name: string; kind?: "earning" | "deduction" | "employer_contribution"; method?: string; rate?: number | null }): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.payComponents).values({
    uuid, code: short("pc"), name: over.name, kind: over.kind ?? "earning",
    method: (over.method ?? "fixed") as typeof schema.payComponents.$inferInsert.method, rate: over.rate ?? null, recurring: true,
  });
  return uuid;
}

// Directly seed a compensation row with an explicit effective window.
async function seedCompRow(employeeId: string, basePay: number, effectiveFrom: string, effectiveTo: string | null) {
  await deps.db.insert(schema.compensation).values({
    uuid: genId(), code: short("cmp"), employeeId, ctcAnnual: basePay * 12, basePay, specialAllowance: 0,
    currency: "INR", effectiveFrom: new Date(effectiveFrom), effectiveTo: effectiveTo ? new Date(effectiveTo) : null,
  });
}
async function seedPeriodRange(label: string, start: string, end: string): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.payPeriods).values({ uuid, code: short("pp"), label, periodStart: new Date(start), periodEnd: new Date(end), payDate: new Date(end) });
  return uuid;
}

describe("payroll: prices each period at the compensation effective THEN (not the latest)", () => {
  it("an old period uses the old comp; the current period uses the raised comp", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedCompRow(emp, 40000, "2025-06-01", "2026-01-01"); // old rate, closed at Jan 1 2026
    await seedCompRow(emp, 60000, "2026-01-01", null); // raised rate from Jan 1 2026

    const dec = await seedPeriodRange("Dec 2025", "2025-12-01", "2025-12-31");
    const jan = await seedPeriodRange("Jan 2026", "2026-01-01", "2026-01-31");
    const decRun = await createRun(deps, actor, `pay-periods/${dec}`);
    const janRun = await createRun(deps, actor, `pay-periods/${jan}`);
    await buildRunItems(deps, actor, decRun.uuid);
    await buildRunItems(deps, actor, janRun.uuid);

    const basic = async (runId: string) => (await listRunItems(deps, runId))[0]!.lines.find((l) => l.code === "BASIC")!.amount;
    expect(await basic(decRun.uuid)).toBe(40000); // priced at the comp in force during December
    expect(await basic(janRun.uuid)).toBe(60000); // January picks up the raise
  });
});

describe("compensation: backdated-raise arrears count only already-PUBLISHED periods", () => {
  it("arrears > 0 when a published period sits in the window; 0 when none (no double-pay)", async () => {
    const actor = await seedActor(await seedEmployee());
    const paidEmp = await seedEmployee({ code: short("04") });
    const freshEmp = await seedEmployee({ code: short("04") });
    await seedCompRow(paidEmp, 40000, "2025-01-01", null);
    await seedCompRow(freshEmp, 40000, "2025-01-01", null);

    // paidEmp was already paid an Aug-2025 period in a PUBLISHED run; freshEmp was not.
    const aug = await seedPeriodRange("Aug 2025", "2025-08-01", "2025-08-31");
    const pubRun = genId();
    await deps.db.insert(schema.payrollRuns).values({ uuid: pubRun, code: short("pr"), payPeriodId: aug, state: "PUBLISHED" });
    await deps.db.insert(schema.payrollRunItems).values({ uuid: genId(), runId: pubRun, employeeId: paidEmp, linesJson: "[]", gross: 40000, totalDeductions: 0, net: 40000 });

    // Backdated raise effective Jul 1 2025 (window [Jul 1, now) includes the published Aug period).
    const paidRow = await reviseCompensation(deps, actor, { employee: `employees/${paidEmp}`, annual_ctc: 900000, effective_from: "2025-07-01" });
    const freshRow = await reviseCompensation(deps, actor, { employee: `employees/${freshEmp}`, annual_ctc: 900000, effective_from: "2025-07-01" });
    expect(paidRow.arrearsAmount).toBeGreaterThan(0); // owed the delta for the one published period
    expect(freshRow.arrearsAmount).toBe(0); // never paid at the old rate -> period-effective pricing handles it
  });
});

describe("payroll: mid-period joiner is prorated (not paid a full month)", () => {
  it("prorates BASIC by calendar days employed; a full-period employee is unaffected", async () => {
    const actor = await seedActor(await seedEmployee());
    const full = await seedEmployee({ code: short("04") });
    const joiner = await seedEmployee({ code: short("04"), startDate: new Date("2026-01-17") }); // Jan 17..31 = 15/31
    await seedComp(full, { basePay: 31000 });
    await seedComp(joiner, { basePay: 31000 });
    const period = await seedPeriod(); // Jan 2026 (1..31)
    const run = await createRun(deps, actor, `pay-periods/${period}`);
    await buildRunItems(deps, actor, run.uuid);

    const items = await listRunItems(deps, run.uuid);
    const basicOf = (empId: string) => items.find((i) => i.employee === `employees/${empId}`)!.lines.find((l) => l.code === "BASIC")!.amount;
    expect(basicOf(full)).toBe(31000); // employed the whole period
    expect(basicOf(joiner)).toBe(15000); // 31000 x 15/31
  });
});

describe("payroll: ESI is sticky within a contribution period (continues after a mid-period raise past the ceiling)", () => {
  it("keeps deducting ESI for someone who contributed earlier this period, even now above the ceiling", async () => {
    const actor = await seedActor(await seedEmployee());
    await seedComponent({ name: "ESI", kind: "deduction", method: "esi", rate: 0.75 });
    const sticky = await seedEmployee({ code: short("04") }); // contributed in May, now raised above ceiling
    const fresh = await seedEmployee({ code: short("04") }); // above ceiling, never contributed -> not eligible
    await seedComp(sticky, { basePay: 30000 }); // > 21k ceiling now
    await seedComp(fresh, { basePay: 30000 });

    // A PUBLISHED May run (same Apr-Sep contribution period) already had an ESI line for `sticky`.
    const may = await seedPeriodRange("May 2026", "2026-05-01", "2026-05-31");
    const mayRun = genId();
    await deps.db.insert(schema.payrollRuns).values({ uuid: mayRun, code: short("pr"), payPeriodId: may, state: "PUBLISHED" });
    await deps.db.insert(schema.payrollRunItems).values({ uuid: genId(), runId: mayRun, employeeId: sticky, linesJson: JSON.stringify([{ code: "ESI", name: "ESI", kind: "deduction", amount: 150 }]), gross: 20000, totalDeductions: 150, net: 19850 });

    const june = await seedPeriodRange("Jun 2026", "2026-06-01", "2026-06-30");
    const run = await createRun(deps, actor, `pay-periods/${june}`);
    await buildRunItems(deps, actor, run.uuid);

    const items = await listRunItems(deps, run.uuid);
    const esiOf = (id: string) => items.find((i) => i.employee === `employees/${id}`)!.lines.find((l) => l.code === "ESI");
    expect(esiOf(sticky)?.amount).toBe(225); // ceil(30000 x 0.75%) - still contributing (sticky), on the actual wage
    expect(esiOf(fresh)).toBeUndefined(); // above ceiling, no prior contribution this period
  });
});

describe("payroll: ESI eligibility keys off the FULL monthly wage, not the prorated amount", () => {
  it("a high-wage mid-period joiner is not pulled under the ESI ceiling by proration", async () => {
    const actor = await seedActor(await seedEmployee());
    await seedComponent({ name: "ESI", kind: "deduction", method: "esi", rate: 0.75 });
    const highJoiner = await seedEmployee({ code: short("04"), startDate: new Date("2026-01-17") }); // 40k rate, prorated < 21k
    const lowFull = await seedEmployee({ code: short("04") }); // 18k, full period, ESI-eligible
    await seedComp(highJoiner, { basePay: 40000 });
    await seedComp(lowFull, { basePay: 18000 });
    const period = await seedPeriod();
    const run = await createRun(deps, actor, `pay-periods/${period}`);
    await buildRunItems(deps, actor, run.uuid);

    const items = await listRunItems(deps, run.uuid);
    const esiOf = (empId: string) => items.find((i) => i.employee === `employees/${empId}`)!.lines.find((l) => l.code === "ESI");
    expect(esiOf(highJoiner)).toBeUndefined(); // full wage 40k > ceiling -> not ESI-eligible despite prorated gross < 21k
    expect(esiOf(lowFull)?.amount).toBe(135); // ceil(18000 x 0.75%)
  });
});

describe("payroll: one committed run per pay period", () => {
  it("blocks approving a second run for a period that already has an APPROVED run", async () => {
    const actor = await seedActor(await seedEmployee());
    const period = await seedPeriod();
    const runA = await createRun(deps, actor, `pay-periods/${period}`);
    const runB = await createRun(deps, actor, `pay-periods/${period}`);
    await transition(deps, actor, runA.uuid, "REVIEW");
    await transition(deps, actor, runA.uuid, "APPROVED");
    await transition(deps, actor, runB.uuid, "REVIEW");
    await expect(transition(deps, actor, runB.uuid, "APPROVED")).rejects.toThrow(/already approved/);
  });
});

describe("payroll: loan recovery is capped so net never goes negative", () => {
  it("deducts only the available net; the shortfall stays outstanding for the next run", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 10000 }); // gross 10000, no statutory components
    // A one-installment loan whose EMI (50000) dwarfs the pay.
    const loan = await createLoan(deps, actor, { employee: `employees/${emp}`, principal: 50000, installments: 1 });
    await approveLoan(deps, actor, loan.uuid);
    await disburseLoan(deps, actor, loan.uuid);

    const period = await seedPeriod();
    const run = await createRun(deps, actor, `pay-periods/${period}`);
    await buildRunItems(deps, actor, run.uuid);

    const items = await listRunItems(deps, run.uuid);
    expect(items).toHaveLength(1);
    expect(items[0]!.net).toBe(0); // capped at 0, never negative
    const loanLine = items[0]!.lines.find((l) => l.code === "LOAN");
    expect(loanLine?.amount).toBe(10000); // only what the pay could cover
    const after = (await deps.db.select().from(schema.loans).where(eq(schema.loans.uuid, loan.uuid)))[0]!;
    expect(after.repaid).toBe(10000);
    expect(after.status).toBe("DISBURSED"); // still open; balance recovers over later runs
  });
});

describe("payroll: loan recovery does not garnish a reimbursement payout", () => {
  it("caps loan recovery at the salary net, leaving the reimbursement intact", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 5000 }); // small salary
    const loan = await createLoan(deps, actor, { employee: `employees/${emp}`, principal: 50000, installments: 1 }); // EMI 50000
    await approveLoan(deps, actor, loan.uuid);
    await disburseLoan(deps, actor, loan.uuid);
    const claim = await createReimbursement(deps, actor, { employee: `employees/${emp}`, amount: 3000 });
    await approveReimbursement(deps, actor, claim.uuid);

    const period = await seedPeriod();
    const run = await createRun(deps, actor, `pay-periods/${period}`);
    await buildRunItems(deps, actor, run.uuid);

    const item = (await listRunItems(deps, run.uuid))[0]!;
    const line = (code: string) => item.lines.find((l) => l.code === code)?.amount;
    expect(line("REIMB")).toBe(3000); // reimbursement present in full
    expect(line("LOAN")).toBe(5000); // loan took only the salary portion (5000), not the reimbursement
    expect(item.net).toBe(3000); // net = reimbursement, untouched by loan recovery
  });
});

describe("loans: manual repayment double-submit is idempotent", () => {
  it("an identical manual repayment within the window is a no-op", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const loan = await createLoan(deps, actor, { employee: `employees/${emp}`, principal: 50000, installments: 10 });
    await approveLoan(deps, actor, loan.uuid); // monthly = 5000
    await disburseLoan(deps, actor, loan.uuid);

    await recordLoanRepayment(deps, actor, loan.uuid, 5000);
    await recordLoanRepayment(deps, actor, loan.uuid, 5000); // retry (double-submit)

    const after = (await deps.db.select().from(schema.loans).where(eq(schema.loans.uuid, loan.uuid)))[0]!;
    expect(after.repaid).toBe(5000); // advanced once, not twice
    const ledger = await deps.db.select().from(schema.loanRepayments).where(eq(schema.loanRepayments.loanId, loan.uuid));
    expect(ledger).toHaveLength(1);
  });
});

describe("bonuses: double-submit dedup keyed on reason", () => {
  it("collapses an identical re-submit but keeps distinct-reason awards separate", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const first = await recordBonus(deps, actor, { employee: `employees/${emp}`, amount: 1000, kind: "Spot", reason: "r1", award_date: today() });
    const dup = await recordBonus(deps, actor, { employee: `employees/${emp}`, amount: 1000, kind: "Spot", reason: "r1", award_date: today() });
    expect(dup.uuid).toBe(first.uuid); // reused, not a second payable
    await recordBonus(deps, actor, { employee: `employees/${emp}`, amount: 1000, kind: "Spot", reason: "r2", award_date: today() }); // different reason
    const rows = await deps.db.select().from(schema.bonuses).where(eq(schema.bonuses.employeeId, emp));
    expect(rows).toHaveLength(2);
  });
});

describe("leave encashment: annual cap re-checked at approve", () => {
  it("blocks approving a second request that, once committed, would breach the cap", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 30000 }); // per-day 1000
    const lt = genId();
    await deps.db.insert(schema.leaveTypes).values({ uuid: lt, code: short("lt"), name: "Earned", encashable: true, encashmentCapDaysPerYear: 5, minBalanceRetainedDays: 0 });
    await deps.db.insert(schema.leaveBalances).values({ uuid: genId(), code: short("lb"), employeeId: emp, leaveTypeId: lt, balanceDays: 30 });

    // Both pass the create-time cap check (PENDING rows don't count toward committed days).
    const a = await computeAndStoreEncashment(deps, actor, { employee: `employees/${emp}`, leave_type: `leave-types/${lt}`, days: 5 });
    const b2 = await computeAndStoreEncashment(deps, actor, { employee: `employees/${emp}`, leave_type: `leave-types/${lt}`, days: 5 });
    await approveEncashment(deps, actor, a.uuid); // 5 committed, at the cap
    await expect(approveEncashment(deps, actor, b2.uuid)).rejects.toThrow(/cap/); // would make 10 > 5
  });
});

describe("leave encashment: approve debits the balance (atomic guarded decrement)", () => {
  it("debits exactly the approved days from the balance", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 30000 });
    const lt = genId();
    await deps.db.insert(schema.leaveTypes).values({ uuid: lt, code: short("lt"), name: "Earned", encashable: true, minBalanceRetainedDays: 0 });
    await deps.db.insert(schema.leaveBalances).values({ uuid: genId(), code: short("lb"), employeeId: emp, leaveTypeId: lt, balanceDays: 10 });

    const enc = await computeAndStoreEncashment(deps, actor, { employee: `employees/${emp}`, leave_type: `leave-types/${lt}`, days: 4 });
    await approveEncashment(deps, actor, enc.uuid);

    const bal = (await deps.db.select().from(schema.leaveBalances).where(and(eq(schema.leaveBalances.employeeId, emp), eq(schema.leaveBalances.leaveTypeId, lt))))[0]!;
    expect(bal.balanceDays).toBe(6); // 10 - 4, debited once
  });

  it("approve/cancel are exactly-once: a repeat approve or cancel can't double-apply the balance", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 30000 });
    const lt = genId();
    await deps.db.insert(schema.leaveTypes).values({ uuid: lt, code: short("lt"), name: "Earned", encashable: true, minBalanceRetainedDays: 0 });
    await deps.db.insert(schema.leaveBalances).values({ uuid: genId(), code: short("lb"), employeeId: emp, leaveTypeId: lt, balanceDays: 10 });
    const balOf = async () => (await deps.db.select().from(schema.leaveBalances).where(and(eq(schema.leaveBalances.employeeId, emp), eq(schema.leaveBalances.leaveTypeId, lt))))[0]!.balanceDays;

    const enc = await computeAndStoreEncashment(deps, actor, { employee: `employees/${emp}`, leave_type: `leave-types/${lt}`, days: 4 });
    await approveEncashment(deps, actor, enc.uuid);
    // A second approve of the SAME row must NOT debit again (would be 2 -> over-debit). It no-ops loudly.
    await expect(approveEncashment(deps, actor, enc.uuid)).rejects.toThrow(/not pending/);
    expect(await balOf()).toBe(6); // debited exactly once

    await cancelEncashment(deps, actor, enc.uuid); // credits the 4 back -> 10
    expect(await balOf()).toBe(10);
    // A second cancel must NOT credit again (would be 14 -> phantom balance). It no-ops loudly.
    await expect(cancelEncashment(deps, actor, enc.uuid)).rejects.toThrow();
    expect(await balOf()).toBe(10); // credited exactly once
  });
});

describe("FnF settlement", () => {
  it("prices monthly gross through the employee's salary structure (excluded earnings don't inflate it)", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const inStruct = await seedComponent({ name: "HRA", method: "fixed", rate: 5000 });
    await seedComponent({ name: "Conveyance", method: "fixed", rate: 3000 }); // NOT in the structure
    const struct = await createSalaryStructure(deps, actor, { display_name: "Basic pack", lines: [{ component: `pay-components/${inStruct}`, rate: null }] });
    await seedComp(emp, { basePay: 20000, structureId: struct.uuid });

    // Full final month -> salary line == monthly gross. Structure = basic(20000) + HRA(5000) = 25000, NOT 28000.
    const s = await computeAndStoreSettlement(deps, actor, { employee: `employees/${emp}`, settlement_date: "2026-01-31", leave_days: 0, notice_shortfall_days: 0 });
    const lines = JSON.parse(s.linesJson) as { name: string; amount: number }[];
    expect(lines.find((l) => l.name.startsWith("Salary"))?.amount).toBe(25000);
  });

  it("settles approved reimbursements (marks them PAID) so payroll can't pay them again", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 40000 });
    const claim = await createReimbursement(deps, actor, { employee: `employees/${emp}`, amount: 2000 });
    await approveReimbursement(deps, actor, claim.uuid);

    const s = await computeAndStoreSettlement(deps, actor, { employee: `employees/${emp}`, settlement_date: "2026-01-31", leave_days: 0, notice_shortfall_days: 0 });
    expect(s.totalEarnings).toBeGreaterThanOrEqual(2000); // included in the FnF payout
    const after = (await deps.db.select().from(schema.reimbursements).where(eq(schema.reimbursements.uuid, claim.uuid)))[0]!;
    expect(after.state).toBe("PAID"); // reused paid marker, no payroll run
    expect(after.paidRunId).toBeNull();
    expect(await approvedUnpaidReimbursements(deps, emp)).toHaveLength(0); // gone from the payroll queue
  });
});

describe("payroll: single-currency guard", () => {
  it("fails the build when an employee's compensation currency differs from the org currency", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 30000, currency: "USD" }); // org default is INR
    const period = await seedPeriod();
    const run = await createRun(deps, actor, `pay-periods/${period}`);
    await expect(buildRunItems(deps, actor, run.uuid)).rejects.toThrow(/USD/);
  });

  it("fails the build when a payable (bonus) is in a different currency", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 30000 }); // INR
    await recordBonus(deps, actor, { employee: `employees/${emp}`, amount: 1000, currency_code: "USD", kind: "Spot", reason: "fx", award_date: today() });
    const period = await seedPeriod();
    const run = await createRun(deps, actor, `pay-periods/${period}`);
    await expect(buildRunItems(deps, actor, run.uuid)).rejects.toThrow(/USD/);
  });
});

describe("pay components: amount validation", () => {
  it("rejects a negative rate and a percent over 100", async () => {
    const actor = await seedActor(await seedEmployee());
    await expect(createPayComponent(deps, actor, { display_name: "Bad", kind: "earning", method: "fixed", rate: -100 })).rejects.toThrow(/non-negative/);
    await expect(createPayComponent(deps, actor, { display_name: "Bad%", kind: "earning", method: "percent_base", rate: 150 })).rejects.toThrow(/cannot exceed 100/);
  });
});

describe("pay periods: overlap + range guard", () => {
  it("rejects a period overlapping a live one, and a reversed range", async () => {
    const actor = await seedActor(await seedEmployee());
    await createPayPeriod(deps, actor, { display_name: "Jan", period_start: "2026-01-01", period_end: "2026-01-31", pay_date: "2026-01-31" });
    await expect(createPayPeriod(deps, actor, { display_name: "Overlap", period_start: "2026-01-15", period_end: "2026-02-15", pay_date: "2026-02-15" })).rejects.toThrow(/overlaps/);
    await expect(createPayPeriod(deps, actor, { display_name: "Reversed", period_start: "2026-03-31", period_end: "2026-03-01", pay_date: "2026-03-31" })).rejects.toThrow(/on or after/);
  });
});

describe("prior-employer figures: declared, then HR/payroll verified before they affect withholding", () => {
  it("declared figures don't count; a self-verify is blocked; an admin verify feeds the projection", async () => {
    const emp = await seedEmployee();
    const self = await seedActor(emp);
    const admin = await seedActor(await seedEmployee({ code: short("04") })); // a different person (HR/payroll)
    await seedComp(emp, { basePay: 100000 }); // recurring monthly gross 100000
    // A payroll_admin verifier who should be alerted when a declaration is filed.
    const verifierEmp = await seedEmployee({ code: short("04") });
    await deps.db.insert(schema.roles).values({ name: "payroll_admin", label: "Payroll" }).onConflictDoNothing();
    await deps.db.insert(schema.users).values({ uuid: genId(), code: short("u"), email: `${genId()}@test.example`, role: "payroll_admin", employeeId: verifierEmp });

    // Employee declares prior-employer income. Unverified -> zero effect on the projection.
    await setTaxDetails(deps, self, emp, { prior_employer_income: 500000 });
    const declared = await getTaxDetails(deps, self, emp);
    // The verifier is alerted to a declaration awaiting verification.
    const declNotifs = await deps.db.select().from(schema.notifications).where(eq(schema.notifications.recipientId, verifierEmp));
    expect(declNotifs.some((n) => n.type === "tax.declared")).toBe(true);
    // ...and it's in the verification queue (the Approvals inbox source), with the declared figure.
    const pending = await listPendingTaxVerifications(deps);
    expect(pending.some((p) => p.employee === `employees/${emp}` && p.prior_employer_income === 500000)).toBe(true);
    expect(declared.verification_status).toBe("DECLARED");
    expect(declared.verified_income).toBeNull();
    expect(declared.prior_employer_income).toBe(500000); // shown as declared
    expect(declared.prior_employer_income_effective).toBe(0); // but not used

    // The subject employee cannot verify their own figures (maker-checker).
    await expect(setTaxDetails(deps, self, emp, { action: "verify" })).rejects.toThrow(/another/i);

    // HR/payroll (a different person) verifies -> now it feeds the annual gross.
    await setTaxDetails(deps, admin, emp, { action: "verify" });
    const verified = await getTaxDetails(deps, self, emp);
    expect(verified.verification_status).toBe("VERIFIED");
    expect(verified.verified_income).toBe(500000);
    expect(verified.prior_employer_income_effective).toBe(500000);
    expect(verified.annual_gross).toBe(declared.annual_gross + 500000); // prior income now counted
    // ...and it drops out of the verification queue once verified.
    expect((await listPendingTaxVerifications(deps)).some((p) => p.employee === `employees/${emp}`)).toBe(false);

    // The subject employee is notified that HR verified their declaration.
    const notifs = await deps.db.select().from(schema.notifications).where(eq(schema.notifications.recipientId, emp));
    expect(notifs.some((n) => n.type === "tax.verified")).toBe(true);
  });
});

describe("ATS: accepting an offer seeds the hire's compensation from the offered CTC", () => {
  it("creates a compensation row equal to offer.baseComp", async () => {
    const actor = await seedActor(await seedEmployee());
    const reqId = genId();
    await deps.db.insert(schema.jobRequisitions).values({ uuid: reqId, code: short("req"), title: "Engineer", openings: 1, status: "open" });
    const candId = genId();
    await deps.db.insert(schema.candidates).values({ uuid: candId, code: short("cand"), name: "Jane Doe", email: `${candId}@test.example` });
    const appId = genId();
    await deps.db.insert(schema.applications).values({ uuid: appId, code: short("app"), candidateId: candId, requisitionId: reqId, stage: "offer", status: "active" });
    const offerId = genId();
    await deps.db.insert(schema.offers).values({ uuid: offerId, code: short("off"), applicationId: appId, baseComp: 1_200_000, currency: "INR", status: "extended", joinDate: new Date("2026-02-01") });

    await acceptOffer(deps, actor, offerId);

    const offer = (await deps.db.select().from(schema.offers).where(eq(schema.offers.uuid, offerId)))[0]!;
    expect(offer.createdEmployeeId).toBeTruthy();
    const comp = (await deps.db.select().from(schema.compensation).where(and(eq(schema.compensation.employeeId, offer.createdEmployeeId!), eq(schema.compensation.ctcAnnual, 1_200_000))))[0];
    expect(comp).toBeTruthy();
    expect(comp!.basePay).toBeGreaterThan(0); // CTC was split (not a raw copy)
  });
});

describe("compensation split re-apply (propagating a component change to existing employees)", () => {
  it("a new employer contribution makes cached splits stale; reapply re-solves them with CTC held fixed", async () => {
    const actor = await seedActor(await seedEmployee());
    const emp = await seedEmployee({ code: short("07") });
    await reviseCompensation(deps, actor, { employee: `employees/${emp}`, annual_ctc: 1_200_000, effective_from: "2025-07-01" });
    const compRow = async () => (await deps.db.select().from(schema.compensation).where(eq(schema.compensation.employeeId, emp)))[0]!;
    const before = await compRow();

    // No employer contributions yet: basic + Special Allowance already reconstruct the CTC, so nothing is stale.
    expect((await splitStatus(deps)).stale).toBe(0);

    // Add a gratuity employer contribution (always applied). The CTC build-up grows, so the cached Special
    // Allowance no longer reconstructs the (fixed) CTC - the split is now stale.
    await seedComponent({ name: "Gratuity", kind: "employer_contribution", method: "percent_base", rate: 4.81 });
    expect((await splitStatus(deps)).stale).toBe(1);

    const res = await reapplySplitCurrent(deps, actor);
    expect(res.updated).toBe(1);
    expect((await splitStatus(deps)).stale).toBe(0);

    // Annual CTC (the promise) is untouched; the Special Allowance shrank to absorb the new gratuity cost.
    const after = await compRow();
    expect(after.ctcAnnual).toBe(before.ctcAnnual);
    expect(after.specialAllowance).toBeLessThan(before.specialAllowance);
    expect(after.basePay).toBe(before.basePay); // basic = basic_pct% of an unchanged CTC, so it holds
  });
});

describe("payroll run staleness (inputs changed after the build)", () => {
  it("flags an editable run whose income inputs changed since build; never flags a published run", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await reviseCompensation(deps, actor, { employee: `employees/${emp}`, annual_ctc: 1_200_000, effective_from: "2025-07-01" });
    const period = await seedPeriodRange("Jul 2025", "2025-07-01", "2025-07-31");
    const run = await createRun(deps, actor, `pay-periods/${period}`);
    await buildRunItems(deps, actor, run.uuid);

    const built = await getRun(deps, run.uuid);
    expect(built.itemsBuiltAt).toBeTruthy(); // build stamps the moment its numbers were computed
    // Nothing has changed since the build, so it's current.
    expect((await runStaleness(deps, built)).stale).toBe(false);

    // An income-affecting change lands AFTER the build (timestamp forced strictly later for determinism).
    await deps.db.update(schema.compensation)
      .set({ updatedAt: new Date(built.itemsBuiltAt!.getTime() + 1000) })
      .where(eq(schema.compensation.employeeId, emp));
    const s = await runStaleness(deps, built);
    expect(s.stale).toBe(true);
    expect(s.changes).toContain("Compensation revisions");

    // A committed (PUBLISHED) run is immutable and self-corrects in the next run, so it's never flagged stale.
    expect((await runStaleness(deps, { ...built, state: "PUBLISHED" })).stale).toBe(false);
  });
});

describe("payslip preview (pre-publish, nothing persisted)", () => {
  it("renders a PDF for one built run item and writes no payslip row or file", async () => {
    const emp = await seedEmployee({ firstName: "Priya", lastName: "Sharma", jobTitle: "Engineer" });
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 50000 });
    const period = await seedPeriod();
    const run = await createRun(deps, actor, `pay-periods/${period}`);
    await buildRunItems(deps, actor, run.uuid);

    const { bytes, fileName } = await previewRunItemPayslip(deps, run.uuid, emp);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-"); // a real PDF, rendered inline
    expect(fileName.endsWith(".pdf")).toBe(true);

    // The preview is a pure read: no payslip resource, and the run stays editable (DRAFT).
    expect(await deps.db.select().from(schema.payslips).where(eq(schema.payslips.runId, run.uuid))).toEqual([]);
    expect((await getRun(deps, run.uuid)).state).toBe("DRAFT");
  });

  it("404s for an employee with no item in the run (build first)", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 40000 });
    const outsider = await seedEmployee();
    const period = await seedPeriod();
    const run = await createRun(deps, actor, `pay-periods/${period}`);
    await buildRunItems(deps, actor, run.uuid);

    await expect(previewRunItemPayslip(deps, run.uuid, outsider)).rejects.toThrow(/no item for that employee/);
  });
});

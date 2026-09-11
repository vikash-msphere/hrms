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

import { createRun, buildRunItems, transition, deleteRun, listRunItems, getRun, runStaleness, previewRunItemPayslip, publishRun } from "../src/services/payroll";
import { createLoan, approveLoan, disburseLoan, recordLoanRepayment, repaidCreditStmt, resetLoanRepaymentStmts } from "../src/services/loans";
import { recordBonus, unpaidBonuses } from "../src/services/bonuses";
import { computeAndStoreEncashment, approveEncashment, cancelEncashment, approvedUnpaidEncashments } from "../src/services/leaveEncashments";
import { createReimbursement, approveReimbursement, approvedUnpaidReimbursements, payReimbursement, markReimbursementsPaidByRun, markReimbursementsSettledStmt } from "../src/services/reimbursements";
import { computeAndStoreSettlement } from "../src/services/settlements";
import { createSalaryStructure } from "../src/services/salaryStructures";
import { reviseCompensation, updateCompensation, deleteCompensation, reapplySplitCurrent, splitStatus, listCompensation, decorateCompensation } from "../src/services/compensation";
import { toCompensationResource } from "../src/http/serialize";
import { createPayComponent, updatePayComponent } from "../src/services/payComponents";
import { createPayPeriod } from "../src/services/payPeriods";
import { getTaxDetails, setTaxDetails, listPendingTaxVerifications } from "../src/services/taxDetails";
import { finalizedTotals, settlementTotals, fyWindow } from "../src/services/taxProjection";
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
  schema.reimbursements, schema.settlements, schema.compensation, schema.salaryStructures, schema.payGrades, schema.payComponents,
  schema.taxDeclarations,
  schema.offers, schema.applications, schema.candidates, schema.jobRequisitions,
  schema.transitions, schema.jobs, schema.notifications, schema.eventLog, schema.automationRuns, schema.workflowInstances,
  schema.users, schema.employees, schema.roles,
  schema.settings, // org policy blobs (e.g. settings/ctc) - a test that sets one must not leak it into the next
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
async function seedComponent(over: { name: string; kind?: "earning" | "deduction" | "employer_contribution"; method?: string; rate?: number | null; cap?: number | null; pfWages?: boolean; regime?: string }): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.payComponents).values({
    uuid, code: short("pc"), name: over.name, kind: over.kind ?? "earning",
    method: (over.method ?? "fixed") as typeof schema.payComponents.$inferInsert.method, rate: over.rate ?? null,
    cap: over.cap ?? null, regime: over.regime ?? null, pfWages: over.pfWages ?? false, recurring: true,
  });
  return uuid;
}

// Write an org policy blob directly (the beforeEach clears settings, so nothing leaks between tests).
async function seedSetting(key: string, value: unknown) {
  await deps.db.insert(schema.settings).values({ key, value: JSON.stringify(value), updatedAt: new Date() }).onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify(value) } });
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

describe("payroll: employer contributions ride on the item and follow each component's CTC side", () => {
  // The CTC side is data on the component: in_ctc true = counted inside CTC, false = paid over and above it.
  const setInCtc = async (name: string, inCtc: boolean) => {
    await deps.db.update(schema.payComponents).set({ inCtc }).where(eq(schema.payComponents.name, name));
  };
  it("costs employer PF/gratuity per employee, leaves gross+net alone, and marks a contribution above CTC when its component says so", async () => {
    const actor = await seedActor(await seedEmployee());
    await seedComponent({ name: "Provident Fund", kind: "deduction", method: "epf", rate: 12 }); // employee share
    await seedComponent({ name: "Employer PF", kind: "employer_contribution", method: "epf", rate: 12 });
    await seedComponent({ name: "Gratuity", kind: "employer_contribution", method: "percent_base", rate: 4.81 });
    const emp = await seedEmployee({ code: short("04"), epfEnrolled: true });
    const optedOut = await seedEmployee({ code: short("04") }); // epfEnrolled defaults false -> no PF either side
    await seedComp(emp, { basePay: 30000 });
    await seedComp(optedOut, { basePay: 30000 });

    const itemFor = async (runId: string, id: string) => (await listRunItems(deps, runId)).find((i) => i.employee === `employees/${id}`)!;

    // Default: every contribution counts INSIDE CTC.
    const inRun = await createRun(deps, actor, `pay-periods/${await seedPeriod()}`);
    await buildRunItems(deps, actor, inRun.uuid);
    const inItem = await itemFor(inRun.uuid, emp);
    expect(inItem.lines.find((l) => l.code === "ER_EPF")).toMatchObject({ name: "Employer PF", kind: "employer_contribution", amount: 3600 });
    expect(inItem.lines.find((l) => l.code === "ER_EPF")).not.toHaveProperty("above_ctc");
    expect(inItem.employer_cost).toBe(5043); // 3600 employer PF + 1443 gratuity, all inside CTC
    expect(inItem.above_ctc_cost).toBe(0);
    // Cost to company never leaks into the employee's pay: gross = basic, net = basic - the 12% employee share.
    expect(inItem.gross).toBe(30000);
    expect(inItem.net).toBe(26400);
    // Opted out of PF: no employee deduction and no employer share, gratuity still costed.
    const outItem = await itemFor(inRun.uuid, optedOut);
    expect(outItem.lines.find((l) => l.code === "ER_EPF")).toBeUndefined();
    expect(outItem.employer_cost).toBe(1443);
    expect(outItem.net).toBe(30000);

    // Flip the PF component: it now rides OVER AND ABOVE CTC. Same money, different classification - and
    // gratuity is untouched, because the choice belongs to the component, not to PF as a policy.
    await setInCtc("Employer PF", false);
    const aboveRun = await createRun(deps, actor, `pay-periods/${await seedPeriodRange("Feb 2026", "2026-02-01", "2026-02-28")}`);
    await buildRunItems(deps, actor, aboveRun.uuid);
    const aboveItem = await itemFor(aboveRun.uuid, emp);
    expect(aboveItem.lines.find((l) => l.code === "ER_EPF")).toMatchObject({ amount: 3600, above_ctc: true });
    expect(aboveItem.employer_cost).toBe(1443); // gratuity only - PF is outside CTC now
    expect(aboveItem.above_ctc_cost).toBe(3600);
    expect(aboveItem.gross).toBe(30000); // the employee's own pay is untouched by the policy
    expect(aboveItem.net).toBe(26400);
  });

  it("allows one EPF component per side and refuses a second on the same side", async () => {
    const actor = await seedActor(await seedEmployee());
    const employee = await createPayComponent(deps, actor, { display_name: "Provident Fund", kind: "deduction", method: "epf", rate: 12, cap: 15000, recurring: true });
    const employer = await createPayComponent(deps, actor, { display_name: "Employer PF", kind: "employer_contribution", method: "epf", rate: 12, cap: 15000, recurring: true });
    // Either direction of a side flip names the component in the way, so the refusal is actionable.
    await expect(updatePayComponent(deps, actor, employer.uuid, { kind: "deduction" }))
      .rejects.toThrow(/one EPF component may exist per employee side - "Provident Fund" already occupies it/);
    // A second row on either side would make payroll charge that side twice.
    await expect(createPayComponent(deps, actor, { display_name: "Employer PF (extra)", kind: "employer_contribution", method: "epf", rate: 12, recurring: true }))
      .rejects.toThrow(/one EPF component may exist per employer side - "Employer PF" already occupies it/);
    // Flipping the employee row to the employer side collides with the row already there...
    await expect(updatePayComponent(deps, actor, employee.uuid, { kind: "employer_contribution" }))
      .rejects.toThrow(/one EPF component may exist per employer side - "Employer PF" already occupies it/);
    // ...but is fine once that row is gone (an employer-only PF setup is legitimate).
    await deps.db.delete(schema.payComponents).where(eq(schema.payComponents.name, "Employer PF"));
    expect((await updatePayComponent(deps, actor, employee.uuid, { kind: "employer_contribution" })).kind).toBe("employer_contribution");
  });

  it("solves a freshly saved CTC against the live catalog, so a new split needs no re-apply", async () => {
    const actor = await seedActor(await seedEmployee());
    await seedComponent({ name: "House Rent Allowance", kind: "earning", method: "percent_base", rate: 40 });
    await seedComponent({ name: "Employer PF", kind: "employer_contribution", method: "epf", rate: 12 });
    await seedComponent({ name: "Gratuity", kind: "employer_contribution", method: "percent_base", rate: 4.81 });
    const emp = await seedEmployee({ code: short("04"), epfEnrolled: true });

    await reviseCompensation(deps, actor, { employee: `employees/${emp}`, annual_ctc: 1_200_000, effective_from: "2026-01-01" });
    // The stored basic + Special Allowance reconstruct the promised CTC: the in-CTC employer contributions are
    // INSIDE the target, not riding on top of it. A dry-run re-apply must therefore find nothing stale - if the
    // save used different rules from the re-apply, this is where that shows up.
    expect(await splitStatus(deps)).toMatchObject({ stale: 0, skipped: 0 });

    // Flipping the PF component to over-and-above CTC changes the target the split solves for, so the stored
    // row IS stale until re-applied - and then reconciles again under the new side.
    await setInCtc("Employer PF", false);
    expect((await splitStatus(deps)).stale).toBe(1);
    await reapplySplitCurrent(deps, actor);
    expect(await splitStatus(deps)).toMatchObject({ stale: 0, skipped: 0 });
  });

  it("warns on a run that priced a stale split, names the employee, and clears after re-apply + rebuild", async () => {
    const actor = await seedActor(await seedEmployee());
    await seedComponent({ name: "Employer PF", kind: "employer_contribution", method: "epf", rate: 12 });
    const emp = await seedEmployee({ code: short("04"), firstName: "Stale", lastName: "Split", epfEnrolled: true });
    await reviseCompensation(deps, actor, { employee: `employees/${emp}`, annual_ctc: 1_200_000, effective_from: "2026-01-01" });

    const run = await createRun(deps, actor, `pay-periods/${await seedPeriod()}`);
    await buildRunItems(deps, actor, run.uuid);
    const staleness = async () => runStaleness(deps, await getRun(deps, run.uuid));
    // Freshly built off a freshly solved split: nothing to warn about.
    expect((await staleness()).split_drift).toBeUndefined();

    // Move the PF component outside CTC. The stored split now solves the WRONG target, and - the point of this
    // guard - the run's own `stale`/`changes` check cannot express that: it only knows an input was touched.
    await setInCtc("Employer PF", false);
    const drifted = await staleness();
    expect(drifted.split_drift).toEqual({ stale: ["Stale Split"], skipped: [] });

    // The documented fix: re-apply the splits, then rebuild. Both are needed - re-applying alone leaves the run's
    // stored items on the old numbers.
    await reapplySplitCurrent(deps, actor);
    await buildRunItems(deps, actor, run.uuid);
    expect((await staleness()).split_drift).toBeUndefined();
  });

  it("does not call a run stale for the payables it just paid itself", async () => {
    // Staleness asks "was an income-affecting input touched after this run was built", and the build itself
    // touches inputs: every payable it pays is marked paid-by-this-run, and every one of those tables -
    // bonuses, encashments, overtime, arrears, claims, the loan ledger - is on the list it watches.
    //
    // So the build stamp has to be taken AFTER those markers, or a run flags itself the moment it finishes and
    // rebuilding produces the same warning again. A permanent warning on a banner that exists to be believed
    // is worse than none: it is read once and then ignored, including on the run where an input really did move.
    const actor = await seedActor(await seedEmployee());
    const emp = await seedEmployee({ code: short("04") });
    await seedComp(emp, { basePay: 40000 });
    await recordBonus(deps, actor, { employee: `employees/${emp}`, amount: 5000, kind: "Spot", reason: "self-stale", award_date: today() });

    const run = await createRun(deps, actor, `pay-periods/${await seedPeriod()}`);
    await buildRunItems(deps, actor, run.uuid);
    expect(await unpaidBonuses(deps, emp)).toHaveLength(0); // the run really did pay it, so it really did write to `bonuses`
    expect(await runStaleness(deps, await getRun(deps, run.uuid))).toMatchObject({ stale: false, changes: [] });

    // And a real change afterwards still reports, so the fix did not simply blind the check.
    await recordBonus(deps, actor, { employee: `employees/${emp}`, amount: 100, kind: "Spot", reason: "after-build", award_date: today() });
    expect(await runStaleness(deps, await getRun(deps, run.uuid))).toMatchObject({ stale: true, changes: ["Bonuses"] });
  });

  // STALENESS IS NARROWED TO WHAT COULD MOVE *THIS* RUN. Every probe used to ask its question of the whole
  // table with no predicate but the timestamp. That was survivable while this was a banner and is not now that
  // approve GATES on it with no override: `employees.updated_at` bumps when anyone uploads a photo or changes
  // their notification preferences, and `settings` is one row per key, so an asset-tag toggle counted. An
  // editable run could not stay fresh long enough to be reviewed, and the documented remedy (rebuild, then
  // approve) raced exactly the same way.
  describe("staleness only reports changes that could price this run", () => {
    const rebuiltRun = async () => {
      const actor = await seedActor(await seedEmployee());
      const emp = await seedEmployee({ code: short("04") });
      await seedComp(emp, { basePay: 30000 });
      const run = await createRun(deps, actor, `pay-periods/${await seedPeriod()}`);
      await buildRunItems(deps, actor, run.uuid);
      return { actor, emp, run };
    };
    const stale = async (runId: string) => runStaleness(deps, await getRun(deps, runId));

    it("ignores an employee the run never paid, and still catches one it did", async () => {
      const { emp, run } = await rebuiltRun();
      // Somebody in another department, with no item in this run. A profile edit of theirs is not an input to
      // a payroll that does not pay them.
      const outsider = await seedEmployee({ code: short("09") });
      await deps.db.update(schema.employees).set({ bio: "edited", updatedAt: new Date() }).where(eq(schema.employees.uuid, outsider));
      expect(await stale(run.uuid)).toMatchObject({ stale: false, changes: [] });

      // The same edit on somebody the run DID pay still reports: the narrowing is by population, not a blanket
      // blinding of the probe.
      await deps.db.update(schema.employees).set({ bio: "edited", updatedAt: new Date() }).where(eq(schema.employees.uuid, emp));
      expect((await stale(run.uuid)).changes).toContain("Employee records (joiners, tax verifications, EPF, status)");
    });

    it("ignores a settings key payroll does not read, and still catches one it does", async () => {
      const { run } = await rebuiltRun();
      await seedSetting("asset-tags", { found_page: { enabled: true } });
      expect(await stale(run.uuid)).toMatchObject({ stale: false, changes: [] });

      await seedSetting("ctc", { basic_pct: 55 });
      expect((await stale(run.uuid)).changes).toContain("Pay-run settings (CTC / tax / overtime / PT)");
    });

    it("ignores a holiday outside the pay period, and still catches one inside it", async () => {
      const { run } = await rebuiltRun(); // the period is Jan 2026
      await deps.db.insert(schema.holidays).values({ uuid: genId(), code: short("hol"), date: new Date("2026-08-15"), name: "Independence Day" });
      expect(await stale(run.uuid)).toMatchObject({ stale: false, changes: [] });

      await deps.db.insert(schema.holidays).values({ uuid: genId(), code: short("hol"), date: new Date("2026-01-26"), name: "Republic Day" });
      expect((await stale(run.uuid)).changes).toContain("Holidays");
    });
  });

  it("keeps the employer ESI share in step with the employee's sticky eligibility", async () => {
    const actor = await seedActor(await seedEmployee());
    await seedComponent({ name: "ESI", kind: "deduction", method: "esi", rate: 0.75 });
    await seedComponent({ name: "Employer ESI", kind: "employer_contribution", method: "esi", rate: 3.25 });
    const sticky = await seedEmployee({ code: short("04") }); // contributed in May, now above the ceiling
    const fresh = await seedEmployee({ code: short("04") }); // above the ceiling, never contributed
    await seedComp(sticky, { basePay: 30000 });
    await seedComp(fresh, { basePay: 30000 });

    const may = await seedPeriodRange("May 2026", "2026-05-01", "2026-05-31");
    const mayRun = genId();
    await deps.db.insert(schema.payrollRuns).values({ uuid: mayRun, code: short("pr"), payPeriodId: may, state: "PUBLISHED" });
    await deps.db.insert(schema.payrollRunItems).values({ uuid: genId(), runId: mayRun, employeeId: sticky, linesJson: JSON.stringify([{ code: "ESI", name: "ESI", kind: "deduction", amount: 150 }]), gross: 20000, totalDeductions: 150, net: 19850 });

    const run = await createRun(deps, actor, `pay-periods/${await seedPeriodRange("Jun 2026", "2026-06-01", "2026-06-30")}`);
    await buildRunItems(deps, actor, run.uuid);
    const items = await listRunItems(deps, run.uuid);
    const erEsiOf = (id: string) => items.find((i) => i.employee === `employees/${id}`)!.lines.find((l) => l.code === "ER_ESI");
    expect(erEsiOf(sticky)?.amount).toBe(975); // ceil(30000 x 3.25%) - eligible because the employee side still is
    expect(erEsiOf(fresh)).toBeUndefined(); // not in ESI, so no employer share either
  });
});

describe("payroll: one committed run per pay period", () => {
  it("blocks approving a second run for a period that already has an APPROVED run", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 30000 });
    const period = await seedPeriod();
    const runA = await createRun(deps, actor, `pay-periods/${period}`);
    const runB = await createRun(deps, actor, `pay-periods/${period}`);
    await buildRunItems(deps, actor, runA.uuid);
    await buildRunItems(deps, actor, runB.uuid);
    await transition(deps, actor, runA.uuid, "REVIEW");
    await transition(deps, actor, runA.uuid, "APPROVED");
    await transition(deps, actor, runB.uuid, "REVIEW");
    await expect(transition(deps, actor, runB.uuid, "APPROVED")).rejects.toThrow(/already approved/);
  });

  it("refuses to approve a run built before its inputs moved, until it is rebuilt", async () => {
    // Staleness is a GATE, not a banner. `runStaleness` has always been computed and rendered on the run page,
    // and approve ignored it - so an input that moved after the build (here a compensation revision) shipped
    // superseded figures to anyone who did not read the warning, and to every API caller, who never saw one.
    // Approve is where that becomes irreversible: it consumes the period's one committed-run slot, unlocks the
    // bank file, and APPROVED never rolls back.
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 30000 });
    const period = await seedPeriod();
    const run = await createRun(deps, actor, `pay-periods/${period}`);
    await buildRunItems(deps, actor, run.uuid);
    await transition(deps, actor, run.uuid, "REVIEW");

    // The BUILD STAMP is rewound rather than the input advanced. Same relation - a compensation row whose
    // `updated_at` post-dates the build - but it survives the rebuild below: pushing the input into the future
    // instead would leave it ahead of the REBUILD's stamp too, so the run would still read stale afterwards
    // and the test would be pinning "always refuses" rather than "refuses until rebuilt". The comparison is
    // strict (`updated_at > built_at`), so the rebuild's own stamp clears it even landing in the same
    // millisecond as the seeded row.
    const built = (await getRun(deps, run.uuid)).itemsBuiltAt!;
    await deps.db
      .update(schema.payrollRuns)
      .set({ itemsBuiltAt: new Date(+built - 60_000) })
      .where(eq(schema.payrollRuns.uuid, run.uuid));
    expect((await runStaleness(deps, await getRun(deps, run.uuid))).stale).toBe(true);

    await expect(transition(deps, actor, run.uuid, "APPROVED")).rejects.toThrow(/rebuild it before approving/);

    // The remedy, and the only one offered: rebuild (legal while the run is editable), then approve.
    await buildRunItems(deps, actor, run.uuid);
    expect((await transition(deps, actor, run.uuid, "APPROVED")).state).toBe("APPROVED");
  });

  it("refuses to approve a run that was never built, or built empty (it would lock the period and pay nobody)", async () => {
    const actor = await seedActor(await seedEmployee());
    const period = await seedPeriod();
    const run = await createRun(deps, actor, `pay-periods/${period}`);
    await transition(deps, actor, run.uuid, "REVIEW");
    await expect(transition(deps, actor, run.uuid, "APPROVED")).rejects.toThrow(/build the run/);

    // Built, but nobody has compensation on record -> zero items. Still refused.
    await buildRunItems(deps, actor, run.uuid);
    await expect(transition(deps, actor, run.uuid, "APPROVED")).rejects.toThrow(/no payslip items/);
  });

  // SEGREGATION OF DUTIES on the payroll commit. `transition` carried a comment claiming maker-checker was
  // enforced on approve, and nothing compared the approver with the submitter - only the seeded grant's
  // role-level rule (payroll_admin cannot approve), which says which ROLE may approve, not which PERSON may
  // not. On a deployment with one super admin that is no four-eyes at all, on the one step that moves money
  // and never rolls back. Opt-in and off by default, exactly like `access-approval` for permission changes,
  // because a one-admin org has nobody else to approve and a rule with no way out stops payroll.
  describe("four-eyes on approve (settings/payroll-approval)", () => {
    const builtAndSubmitted = async () => {
      const emp = await seedEmployee();
      const submitter = await seedActor(emp);
      await seedComp(emp, { basePay: 30000 });
      const run = await createRun(deps, submitter, `pay-periods/${await seedPeriod()}`);
      await buildRunItems(deps, submitter, run.uuid);
      await transition(deps, submitter, run.uuid, "REVIEW");
      return { submitter, run };
    };

    it("OFF by default: the submitter may approve their own run", async () => {
      const { submitter, run } = await builtAndSubmitted();
      expect((await transition(deps, submitter, run.uuid, "APPROVED")).state).toBe("APPROVED");
    });

    it("ON: the submitter is refused, and a second person approves", async () => {
      await seedSetting("payroll-approval", { enabled: true });
      const { submitter, run } = await builtAndSubmitted();
      await expect(transition(deps, submitter, run.uuid, "APPROVED")).rejects.toThrow(/someone other than the person who submitted/);

      const checker = await seedActor(await seedEmployee({ code: short("04") }));
      const approved = await transition(deps, checker, run.uuid, "APPROVED");
      expect(approved.state).toBe("APPROVED");
      expect(approved.approvedBy).toBe(checker.uuid);
      expect(approved.submittedBy).toBe(submitter.uuid);
    });
  });

  it("publishes a run exactly once, however many times :publish is called", async () => {
    // Publish is not idempotent in its effects: it notifies every employee in the run, emits
    // `payroll.published` (so every rule on it fires) and enqueues a payslip-generation job. So "refused the
    // second time" is not a nicety - a second pass means everyone gets a duplicate "Payslip available" and a
    // duplicate payslip batch is queued.
    //
    // SCOPE, stated honestly: this pins the sequential answer, which `canTransition` gives once the state has
    // moved. It does NOT reach the guarded state predicate on the write itself - that only matters when two
    // callers read APPROVED before either writes, and this harness serialises the two calls (D1 resolves the
    // first chain before the second's read returns), so the interleaving cannot be staged here. The predicate
    // is the backstop for that case and is unverified by this test.
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 30000 });
    const period = await seedPeriod();
    const run = await createRun(deps, actor, `pay-periods/${period}`);
    await buildRunItems(deps, actor, run.uuid);
    await transition(deps, actor, run.uuid, "REVIEW");
    await transition(deps, actor, run.uuid, "APPROVED");

    const outcomes = await Promise.allSettled([publishRun(deps, actor, run.uuid), publishRun(deps, actor, run.uuid)]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);

    await expect(publishRun(deps, actor, run.uuid)).rejects.toThrow(/must be APPROVED|already been published/);

    // One payslip job, not two.
    const jobs = await deps.db.select().from(schema.jobs).where(eq(schema.jobs.kind, "payslip.generateRun"));
    expect(jobs).toHaveLength(1);
    // One "payslip available" notice per employee in the run, not two.
    const notes = await deps.db.select().from(schema.notifications).where(eq(schema.notifications.recipientId, emp));
    expect(notes.filter((n) => n.type === "payslip.published")).toHaveLength(1);
  });
});

describe("payroll: loan recovery is capped so net never goes negative", () => {
  it("deducts only the available net; the shortfall stays outstanding for the next run", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 10000 }); // gross 10000, no statutory components
    // A one-installment loan whose EMI (50000) dwarfs the pay.
    const loan = await createLoan(deps, actor, { start_date: "2026-01-01", employee: `employees/${emp}`, principal: 50000, installments: 1 });
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
    const loan = await createLoan(deps, actor, { start_date: "2026-01-01", employee: `employees/${emp}`, principal: 50000, installments: 1 }); // EMI 50000
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

describe("loans: an identical manual repayment is refused, not swallowed", () => {
  it("blocks the double-submit, and records it when the caller confirms it is a second payment", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const loan = await createLoan(deps, actor, { start_date: "2026-01-01", employee: `employees/${emp}`, principal: 50000, installments: 10 });
    await approveLoan(deps, actor, loan.uuid); // monthly = 5000
    await disburseLoan(deps, actor, loan.uuid);

    await recordLoanRepayment(deps, actor, loan.uuid, 5000);
    // The retry REFUSES. It used to return the loan unchanged with no error, which is right for a
    // double-click and silently loses a genuine second payment of the same amount - and the two are
    // indistinguishable from the request. So the caller is asked instead of guessed at.
    await expect(recordLoanRepayment(deps, actor, loan.uuid, 5000)).rejects.toMatchObject({ httpStatus: 409 });
    const afterRefusal = (await deps.db.select().from(schema.loans).where(eq(schema.loans.uuid, loan.uuid)))[0]!;
    expect(afterRefusal.repaid).toBe(5000); // advanced once, not twice
    expect(await deps.db.select().from(schema.loanRepayments).where(eq(schema.loanRepayments.loanId, loan.uuid))).toHaveLength(1);

    // Confirmed (`allow_duplicate`), the same amount is a second, real repayment: ledger and running total move together.
    await recordLoanRepayment(deps, actor, loan.uuid, 5000, true);
    const after = (await deps.db.select().from(schema.loans).where(eq(schema.loans.uuid, loan.uuid)))[0]!;
    expect(after.repaid).toBe(10000);
    expect(await deps.db.select().from(schema.loanRepayments).where(eq(schema.loanRepayments.loanId, loan.uuid))).toHaveLength(2);
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

    // A re-apply re-solves what somebody is paid, so it lands on THEIR compensation record - not only as an
    // org-wide tally, which is invisible from the one place a person actually looks.
    const entries = (await deps.db.select().from(schema.auditLog)).filter((r) => r.action === "compensation.reapplySplit");
    const perRow = entries.filter((r) => r.entityId === before.uuid);
    expect(perRow).toHaveLength(1);
    const diff = (JSON.parse(perRow[0]!.meta!) as { diff: Record<string, { from: number; to: number }> }).diff;
    expect(diff.specialAllowance!.from).toBe(before.specialAllowance);
    expect(diff.specialAllowance!.to).toBeLessThan(before.specialAllowance); // absorbed the new gratuity cost
    // The tally still gets its own entry: "how much of the company did this move" is about the ACTION.
    expect(entries.filter((r) => !r.entityId)).toHaveLength(1);

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

// A payroll build reads its payout queues once at the start and stamps them paid in one batch at the end.
// These lock in what must happen when a payable leaves the queue in between: the money must never move.
describe("payroll: a payable that changes mid-build is never paid", () => {
  // Wrap deps so that `fn` runs just before the build's Nth db.batch - i.e. after the build has read its
  // queues, before it commits. That is exactly the window a concurrent request would land in.
  function racingDeps(nth: number, fn: () => Promise<unknown>): Deps {
    let batches = 0;
    const db = new Proxy(deps.db, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (prop !== "batch") return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        return async (...args: unknown[]) => {
          if (++batches === nth) await fn();
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    return { ...deps, db: db as Deps["db"] };
  }

  it("aborts the build (and pays nobody) when an encashment is cancelled while the run is building", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 30000 });
    const lt = genId();
    await deps.db.insert(schema.leaveTypes).values({ uuid: lt, code: short("lt"), name: "Earned", encashable: true, minBalanceRetainedDays: 0 });
    await deps.db.insert(schema.leaveBalances).values({ uuid: genId(), code: short("lb"), employeeId: emp, leaveTypeId: lt, balanceDays: 10 });
    const enc = await computeAndStoreEncashment(deps, actor, { employee: `employees/${emp}`, leave_type: `leave-types/${lt}`, days: 4 });
    await approveEncashment(deps, actor, enc.uuid); // queued for payout, balance debited to 6

    const period = await seedPeriod();
    const run = await createRun(deps, actor, `pay-periods/${period}`);
    // Batch 1 is the build's reset; batch 2 is its commit. Cancel between them: the encashment leaves the
    // queue and its days go back on the balance, while the build still holds it as payable.
    const raced = racingDeps(2, () => cancelEncashment(deps, actor, enc.uuid));
    await expect(buildRunItems(raced, actor, run.uuid)).rejects.toThrow(/changed while the run was building/);

    const after = (await deps.db.select().from(schema.leaveEncashments).where(eq(schema.leaveEncashments.uuid, enc.uuid)))[0]!;
    expect(after.state).toBe("CANCELLED"); // NOT flipped to PAID over the cancellation
    expect(after.paidRunId).toBeNull();
    const bal = (await deps.db.select().from(schema.leaveBalances).where(eq(schema.leaveBalances.employeeId, emp)))[0]!;
    expect(bal.balanceDays).toBe(10); // days stayed credited back - not paid out AND kept
    // The run is back to "never built": no items, no build stamp, so nothing can be approved or published.
    expect(await deps.db.select().from(schema.payrollRunItems).where(eq(schema.payrollRunItems.runId, run.uuid))).toEqual([]);
    expect((await runStaleness(deps, await getRun(deps, run.uuid))).built_time).toBeNull();
  });

  it("aborts the build when a reimbursement is paid separately while the run is building", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 30000 });
    const claim = await createReimbursement(deps, actor, { employee: `employees/${emp}`, amount: 2000 });
    await approveReimbursement(deps, actor, claim.uuid);

    const period = await seedPeriod();
    const run = await createRun(deps, actor, `pay-periods/${period}`);
    const raced = racingDeps(2, () => payReimbursement(deps, actor, claim.uuid)); // paid out of band
    await expect(buildRunItems(raced, actor, run.uuid)).rejects.toThrow(/changed while the run was building/);

    const after = (await deps.db.select().from(schema.reimbursements).where(eq(schema.reimbursements.uuid, claim.uuid)))[0]!;
    expect(after.paidRunId).toBeNull(); // the separate payout stands; the run did not also claim it
    expect(await deps.db.select().from(schema.payrollRunItems).where(eq(schema.payrollRunItems.runId, run.uuid))).toEqual([]);
  });

  it("aborts the build when a loan is closed by a manual repayment while the run is building", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 40000 });
    const loan = await createLoan(deps, actor, { start_date: "2026-01-01", employee: `employees/${emp}`, principal: 6000, installments: 6 }); // EMI 1000
    await approveLoan(deps, actor, loan.uuid);
    await disburseLoan(deps, actor, loan.uuid);

    const period = await seedPeriod();
    const run = await createRun(deps, actor, `pay-periods/${period}`);
    const raced = racingDeps(2, () => recordLoanRepayment(deps, actor, loan.uuid, 6000)); // settles it in full
    await expect(buildRunItems(raced, actor, run.uuid)).rejects.toThrow(/changed while the run was building/);

    const after = (await deps.db.select().from(schema.loans).where(eq(schema.loans.uuid, loan.uuid)))[0]!;
    expect(after.status).toBe("CLOSED");
    expect(after.repaid).toBe(6000); // the run's installment was rolled back, not stacked on top
    const ledger = await deps.db.select().from(schema.loanRepayments).where(eq(schema.loanRepayments.loanId, loan.uuid));
    expect(ledger).toHaveLength(1); // only the manual repayment survives
    expect(await deps.db.select().from(schema.payrollRunItems).where(eq(schema.payrollRunItems.runId, run.uuid))).toEqual([]);
  });
});

describe("loans: `repaid` is the ledger's running total (relative, never an absolute overwrite)", () => {
  it("keeps a manual repayment and a payroll installment that land against the same starting balance", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 40000 });
    const loan = await createLoan(deps, actor, { start_date: "2026-01-01", employee: `employees/${emp}`, principal: 10000, installments: 10 }); // EMI 1000
    await approveLoan(deps, actor, loan.uuid);
    await disburseLoan(deps, actor, loan.uuid);
    const repaidOf = async () => (await deps.db.select().from(schema.loans).where(eq(schema.loans.uuid, loan.uuid)))[0]!.repaid;

    // Both writers computed their move from the same `repaid = 0` snapshot; both must count.
    await Promise.all([recordLoanRepayment(deps, actor, loan.uuid, 500), repaidCreditStmt(deps, loan.uuid, 1000, new Date())]);
    expect(await repaidOf()).toBe(1500);
  });

  it("a run's rollback re-derives `repaid` from the ledger, keeping repayments it never made", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 40000 });
    const loan = await createLoan(deps, actor, { start_date: "2026-01-01", employee: `employees/${emp}`, principal: 10000, installments: 10 }); // EMI 1000
    await approveLoan(deps, actor, loan.uuid);
    await disburseLoan(deps, actor, loan.uuid);
    await recordLoanRepayment(deps, actor, loan.uuid, 2500); // manual, run-less

    const period = await seedPeriod();
    const run = await createRun(deps, actor, `pay-periods/${period}`);
    await buildRunItems(deps, actor, run.uuid); // + 1000 installment
    const loanRow = async () => (await deps.db.select().from(schema.loans).where(eq(schema.loans.uuid, loan.uuid)))[0]!;
    expect((await loanRow()).repaid).toBe(3500);

    // Rolling the run's repayments back leaves the manual one untouched (recomputed from the ledger).
    for (const s of await resetLoanRepaymentStmts(deps, run.uuid)) await s;
    expect((await loanRow()).repaid).toBe(2500);
    expect(await deps.db.select().from(schema.loanRepayments).where(eq(schema.loanRepayments.runId, run.uuid))).toEqual([]);
  });

  it("closes at the principal, refuses further credits, and reopens when the closing run is rolled back", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 40000 });
    const loan = await createLoan(deps, actor, { start_date: "2026-01-01", employee: `employees/${emp}`, principal: 1000, installments: 1 }); // EMI 1000 = full
    await approveLoan(deps, actor, loan.uuid);
    await disburseLoan(deps, actor, loan.uuid);
    const loanRow = async () => (await deps.db.select().from(schema.loans).where(eq(schema.loans.uuid, loan.uuid)))[0]!;

    const period = await seedPeriod();
    const run = await createRun(deps, actor, `pay-periods/${period}`);
    await buildRunItems(deps, actor, run.uuid);
    expect((await loanRow()).status).toBe("CLOSED");

    // A closed loan takes no further credit (the guard), so nothing can deduct for it again.
    await repaidCreditStmt(deps, loan.uuid, 1000, new Date());
    expect((await loanRow()).repaid).toBe(1000);

    for (const s of await resetLoanRepaymentStmts(deps, run.uuid)) await s;
    const reopened = await loanRow();
    expect(reopened.status).toBe("DISBURSED");
    expect(reopened.repaid).toBe(0);
  });
});

// A terminated employee is in no payroll run, so the full & final settlement is the last chance to pay what
// they are owed - and the last chance to recover what they owe.
describe("FnF settlement: every open payable is settled at exit", () => {
  it("pays the leaver's unpaid bonus, approved encashment and arrears, and recovers the loan outstanding", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 30000 });
    await recordBonus(deps, actor, { employee: `employees/${emp}`, amount: 5000, kind: "Retention", award_date: today() });
    const lt = genId();
    await deps.db.insert(schema.leaveTypes).values({ uuid: lt, code: short("lt"), name: "Earned", encashable: true, minBalanceRetainedDays: 0 });
    await deps.db.insert(schema.leaveBalances).values({ uuid: genId(), code: short("lb"), employeeId: emp, leaveTypeId: lt, balanceDays: 10 });
    const enc = await computeAndStoreEncashment(deps, actor, { employee: `employees/${emp}`, leave_type: `leave-types/${lt}`, days: 4 });
    await approveEncashment(deps, actor, enc.uuid); // balance 10 -> 6, queued for payout
    const loan = await createLoan(deps, actor, { start_date: "2026-01-01", employee: `employees/${emp}`, principal: 12000, installments: 12 });
    await approveLoan(deps, actor, loan.uuid);
    await disburseLoan(deps, actor, loan.uuid);

    const s = await computeAndStoreSettlement(deps, actor, { employee: `employees/${emp}`, settlement_date: "2026-01-31", notice_shortfall_days: 0 });
    const lines = JSON.parse(s.linesJson) as { name: string; kind: string; amount: number }[];
    const line = (frag: string) => lines.find((l) => l.name.toLowerCase().includes(frag))?.amount;
    expect(line("retention")).toBe(5000); // the bonus a run would never have paid
    expect(line("approved leave encashment")).toBe(4000); // 4 days x 30000/30
    expect(line("loan recovery")).toBe(12000); // the WHOLE outstanding, not one installment
    expect(line("leave encashment (6")).toBe(6000); // the 6 days still on the balance

    // Every source row left its queue, so nothing can be paid twice.
    expect(await unpaidBonuses(deps, emp)).toHaveLength(0);
    expect(await approvedUnpaidEncashments(deps, emp)).toHaveLength(0);
    expect((await deps.db.select().from(schema.loans).where(eq(schema.loans.uuid, loan.uuid)))[0]!.status).toBe("CLOSED");
    // The encashed balance is consumed, not left on the books for a second payout.
    const bal = (await deps.db.select().from(schema.leaveBalances).where(eq(schema.leaveBalances.employeeId, emp)))[0]!;
    expect(bal.balanceDays).toBe(0);
  });

  it("recomputing a settlement releases the first one's claims and prices the same figures again", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 30000 });
    await recordBonus(deps, actor, { employee: `employees/${emp}`, amount: 5000, kind: "Retention", award_date: today() });
    const lt = genId();
    await deps.db.insert(schema.leaveTypes).values({ uuid: lt, code: short("lt"), name: "Earned", encashable: true, minBalanceRetainedDays: 0 });
    await deps.db.insert(schema.leaveBalances).values({ uuid: genId(), code: short("lb"), employeeId: emp, leaveTypeId: lt, balanceDays: 10 });
    const loan = await createLoan(deps, actor, { start_date: "2026-01-01", employee: `employees/${emp}`, principal: 3000, installments: 3 });
    await approveLoan(deps, actor, loan.uuid);
    await disburseLoan(deps, actor, loan.uuid);

    const first = await computeAndStoreSettlement(deps, actor, { employee: `employees/${emp}`, settlement_date: "2026-01-31" });
    const second = await computeAndStoreSettlement(deps, actor, { employee: `employees/${emp}`, settlement_date: "2026-01-31" });
    // Without release-then-reprice the recompute would read empty queues and understate the payout.
    expect(second.net).toBe(first.net);
    expect(second.totalEarnings).toBe(first.totalEarnings);
    // Superseded, so the FnF letter can't render a stale snapshot whose claims were released.
    expect(await deps.db.select().from(schema.settlements).where(eq(schema.settlements.employeeId, emp))).toHaveLength(1);
    // The loan is recovered exactly once: one ledger row, repaid == principal.
    const ledger = await deps.db.select().from(schema.loanRepayments).where(eq(schema.loanRepayments.loanId, loan.uuid));
    expect(ledger).toHaveLength(1);
    expect((await deps.db.select().from(schema.loans).where(eq(schema.loans.uuid, loan.uuid)))[0]!.repaid).toBe(3000);
    // And the leave balance is debited once, not twice.
    expect((await deps.db.select().from(schema.leaveBalances).where(eq(schema.leaveBalances.employeeId, emp)))[0]!.balanceDays).toBe(0);
  });
});

// A payroll run and an FnF settlement read the SAME payable queues for the same person. They overlap in
// practice rather than in theory: a run prices every employee who is not yet `terminated`, and an FnF is
// normally computed on the last working day, before the exit transition flips that status.
//
// The run half has always been guarded and CHECKED (it undoes the build and fails loudly on drift). The
// settlement half was neither: one marker carried no guard at all, and the commit ran unchecked - so a claim
// the run took in the window stayed in the settlement's net and was paid on both.
describe("FnF: a payable a payroll run took mid-compute is never paid twice", () => {
  it("the settled-marker refuses a claim a run has already paid, rather than overwriting its stamp", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const period = await seedPeriod();
    const run = await createRun(deps, actor, `pay-periods/${period}`);

    const claim = await createReimbursement(deps, actor, { employee: `employees/${emp}`, amount: 900, description: "Taxi" });
    await approveReimbursement(deps, actor, claim.uuid);
    const runPaidAt = new Date("2026-01-31T00:00:00Z");
    await markReimbursementsPaidByRun(deps, [claim.uuid], run.uuid, runPaidAt);

    // The settlement's marker, over the same id. It must land on NOTHING.
    const touched = await markReimbursementsSettledStmt(deps, [claim.uuid], new Date("2026-02-05T00:00:00Z"))
      .returning({ uuid: schema.reimbursements.uuid });
    expect(touched).toHaveLength(0);

    // The run's stamp survives intact - the row still says which run paid it, and when.
    const row = (await deps.db.select().from(schema.reimbursements).where(eq(schema.reimbursements.uuid, claim.uuid)))[0]!;
    expect(row.state).toBe("PAID");
    expect(row.paidRunId).toBe(run.uuid);
    expect(+row.paidAt!).toBe(+runPaidAt);
  });

  it("a run committing inside the compute window aborts the settlement instead of double-paying the claim", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 30000 });
    const period = await seedPeriod();
    const run = await createRun(deps, actor, `pay-periods/${period}`);

    const claim = await createReimbursement(deps, actor, { employee: `employees/${emp}`, amount: 900, description: "Taxi" });
    await approveReimbursement(deps, actor, claim.uuid);

    // THE RACE, at the exact boundary it happens on: the settlement has already read the queue and priced the
    // claim, and the run's commit lands before the settlement's does. Firing it from inside `batch` is what
    // makes that ordering deterministic instead of a timing accident nothing would reproduce.
    // `batch` is generic over its statement tuple, so the stand-in is typed through `unknown` rather than
    // pretending to reproduce that signature - it only needs to fire once and delegate.
    type BatchFn = Deps["db"]["batch"];
    const asAny = deps.db as unknown as { batch: BatchFn };
    const realBatch = asAny.batch.bind(deps.db) as unknown as (stmts: unknown) => Promise<unknown>;
    let raced = false;
    asAny.batch = (async (stmts: unknown) => {
      if (!raced) {
        raced = true;
        await markReimbursementsPaidByRun(deps, [claim.uuid], run.uuid, new Date("2026-01-31T00:00:00Z"));
      }
      return realBatch(stmts);
    }) as unknown as BatchFn;

    try {
      await expect(
        computeAndStoreSettlement(deps, actor, { employee: `employees/${emp}`, settlement_date: "2026-01-31" }),
      ).rejects.toThrow(/payables changed/i);
    } finally {
      asAny.batch = realBatch as unknown as BatchFn;
    }
    expect(raced).toBe(true);

    // Nothing survives the abort: no settlement row to pay from, and the claim belongs to the run alone.
    expect(await deps.db.select().from(schema.settlements).where(eq(schema.settlements.employeeId, emp))).toHaveLength(0);
    const row = (await deps.db.select().from(schema.reimbursements).where(eq(schema.reimbursements.uuid, claim.uuid)))[0]!;
    expect(row.state).toBe("PAID");
    expect(row.paidRunId).toBe(run.uuid);
    // And the release must not have re-queued a claim the RUN paid - that would be a third payout waiting.
    expect(await approvedUnpaidReimbursements(deps, emp)).toHaveLength(0);
  });
});

describe("payroll: a run cannot be deleted once its bank payout file exists", () => {
  it("refuses the delete that would re-queue already-disbursed payables", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 30000 });
    const period = await seedPeriod();
    const run = await createRun(deps, actor, `pay-periods/${period}`);
    await buildRunItems(deps, actor, run.uuid);
    await transition(deps, actor, run.uuid, "REVIEW");
    await transition(deps, actor, run.uuid, "APPROVED");
    await deleteRun(deps, actor, run.uuid); // still deletable: no file has been generated

    const run2 = await createRun(deps, actor, `pay-periods/${period}`);
    await buildRunItems(deps, actor, run2.uuid);
    await transition(deps, actor, run2.uuid, "REVIEW");
    await transition(deps, actor, run2.uuid, "APPROVED");
    await deps.db.update(schema.payrollRuns).set({ bankFileAt: new Date() }).where(eq(schema.payrollRuns.uuid, run2.uuid)); // buildBankFile stamps this
    await expect(deleteRun(deps, actor, run2.uuid)).rejects.toThrow(/bank payout file/);
  });
});

describe("compensation: only one open row per employee", () => {
  it("rejects the loser of two concurrent revisions instead of paying the raise twice", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 30000, ctcAnnual: 360000 });
    const revise = () => reviseCompensation(deps, actor, { employee: `employees/${emp}`, annual_ctc: 480000, effective_from: "2026-02-01" });
    const results = await Promise.allSettled([revise(), revise()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const open = (await deps.db.select().from(schema.compensation).where(eq(schema.compensation.employeeId, emp))).filter((c) => c.effectiveTo === null);
    expect(open).toHaveLength(1); // never two "current" salaries
  });
});

// The timeline is editable: a salary entered wrong is a mistake, and every one of these writes is audited.
// What must hold after any of them is the same invariant payroll depends on - one contiguous chain of
// half-open intervals per employee, with exactly one open row.
describe("compensation: the timeline can be added to, corrected and pruned", () => {
  // Every LIVE revision, oldest first, as [from, to) day strings - the shape each case asserts on.
  const chain = async (emp: string) =>
    (await deps.db.select().from(schema.compensation).where(eq(schema.compensation.employeeId, emp)))
      .filter((c) => !c.deleteTime)
      .sort((a, b) => +new Date(a.effectiveFrom) - +new Date(b.effectiveFrom))
      .map((c) => [c.effectiveFrom.toISOString().slice(0, 10), c.effectiveTo?.toISOString().slice(0, 10) ?? null]);

  it("inserts a revision INSIDE the history: the one before it closes at the new date, the one after is untouched", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedCompRow(emp, 30000, "2025-01-01", "2026-01-01");
    await seedCompRow(emp, 50000, "2026-01-01", null);

    const mid = await reviseCompensation(deps, actor, { employee: `employees/${emp}`, annual_ctc: 480000, effective_from: "2025-07-01" });
    expect(mid.effectiveTo?.toISOString().slice(0, 10)).toBe("2026-01-01"); // ends where the next revision starts
    expect(await chain(emp)).toEqual([
      ["2025-01-01", "2025-07-01"],
      ["2025-07-01", "2026-01-01"],
      ["2026-01-01", null], // still the current salary - a middle insert does not reopen anything
    ]);
  });

  it("refuses a second revision starting the same day (that is a correction, not an addition)", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedCompRow(emp, 30000, "2025-01-01", null);
    await expect(reviseCompensation(deps, actor, { employee: `employees/${emp}`, annual_ctc: 600000, effective_from: "2025-01-01" }))
      .rejects.toThrow(/already takes effect/);
  });

  it("corrects a CTC in place, re-deriving the split", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const row = await reviseCompensation(deps, actor, { employee: `employees/${emp}`, annual_ctc: 360000, effective_from: "2025-01-01" });
    const fixed = await updateCompensation(deps, actor, row.uuid, { annual_ctc: 720000 });
    expect(fixed.ctcAnnual).toBe(720000);
    expect(fixed.basePay).toBeGreaterThan(row.basePay); // the cached basic followed the corrected CTC
  });

  it("moves a date within its slot, dragging the previous revision's end with it", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedCompRow(emp, 30000, "2025-01-01", "2026-01-01");
    await seedCompRow(emp, 50000, "2026-01-01", null);
    const open = (await deps.db.select().from(schema.compensation).where(eq(schema.compensation.employeeId, emp))).find((c) => !c.effectiveTo)!;

    await updateCompensation(deps, actor, open.uuid, { effective_from: "2025-09-01" });
    expect(await chain(emp)).toEqual([["2025-01-01", "2025-09-01"], ["2025-09-01", null]]); // no gap, no overlap
  });

  it("refuses a date that would cross a neighbouring revision", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedCompRow(emp, 30000, "2025-01-01", "2026-01-01");
    await seedCompRow(emp, 50000, "2026-01-01", null);
    const open = (await deps.db.select().from(schema.compensation).where(eq(schema.compensation.employeeId, emp))).find((c) => !c.effectiveTo)!;
    await expect(updateCompensation(deps, actor, open.uuid, { effective_from: "2024-06-01" })).rejects.toThrow(/between this employee's neighbouring revisions/);
  });

  it("removing the current revision reopens the one before it", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedCompRow(emp, 30000, "2025-01-01", "2026-01-01");
    await seedCompRow(emp, 50000, "2026-01-01", null);
    const open = (await deps.db.select().from(schema.compensation).where(eq(schema.compensation.employeeId, emp))).find((c) => !c.effectiveTo)!;

    await deleteCompensation(deps, actor, open.uuid);
    expect(await chain(emp)).toEqual([["2025-01-01", null]]); // the predecessor is the current salary again
    // Soft: the row is still there, just out of the timeline (audit links and past payslips still resolve).
    const all = await deps.db.select().from(schema.compensation).where(eq(schema.compensation.employeeId, emp));
    expect(all).toHaveLength(2);
    expect(all.find((c) => c.uuid === open.uuid)!.deleteTime).toBeTruthy();
  });

  it("removing a middle revision hands its window to the one before it", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedCompRow(emp, 30000, "2025-01-01", "2025-07-01");
    await seedCompRow(emp, 40000, "2025-07-01", "2026-01-01");
    await seedCompRow(emp, 50000, "2026-01-01", null);
    const middle = (await deps.db.select().from(schema.compensation).where(eq(schema.compensation.employeeId, emp)))
      .find((c) => c.effectiveFrom.toISOString().startsWith("2025-07"))!;

    await deleteCompensation(deps, actor, middle.uuid);
    expect(await chain(emp)).toEqual([["2025-01-01", "2026-01-01"], ["2026-01-01", null]]);
  });

  it("refuses to remove a revision whose retro arrears a run already paid", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedCompRow(emp, 30000, "2025-01-01", null);
    const row = await reviseCompensation(deps, actor, { employee: `employees/${emp}`, annual_ctc: 720000, effective_from: "2025-06-01" });
    await deps.db.update(schema.compensation).set({ arrearsPaidAt: new Date() }).where(eq(schema.compensation.uuid, row.uuid));
    await expect(deleteCompensation(deps, actor, row.uuid)).rejects.toThrow(/already been paid out/);
  });

  it("keeps already-paid arrears at the disbursed amount when the revision is corrected", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedCompRow(emp, 30000, "2025-01-01", null);
    const row = await reviseCompensation(deps, actor, { employee: `employees/${emp}`, annual_ctc: 720000, effective_from: "2025-06-01" });
    await deps.db.update(schema.compensation).set({ arrearsAmount: 12345, arrearsPaidAt: new Date() }).where(eq(schema.compensation.uuid, row.uuid));
    const fixed = await updateCompensation(deps, actor, row.uuid, { annual_ctc: 900000 });
    expect(fixed.ctcAnnual).toBe(900000); // the salary itself is corrected
    expect(fixed.arrearsAmount).toBe(12345); // but not the record of what was actually paid out
  });

  it("records the old and new figures on every timeline write, so the trail says what changed", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    // The audit meta for the newest row about this record - the shape ActivityFeed renders as "x → y".
    const lastMeta = async (id: string, action: string) => {
      const rows = await deps.db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, id));
      const row = rows.filter((r) => r.action === action).sort((a, b) => +new Date(b.at) - +new Date(a.at))[0]!;
      return { meta: JSON.parse(row.meta!) as { diff?: Record<string, { from: unknown; to: unknown }> }, entityName: row.entityName };
    };

    const first = await reviseCompensation(deps, actor, { employee: `employees/${emp}`, annual_ctc: 360000, effective_from: "2025-01-01" });
    expect((await lastMeta(first.uuid, "compensation.revise")).meta.diff!.ctcAnnual).toEqual({ from: null, to: 360000 }); // first ever: no prior salary
    expect((await lastMeta(first.uuid, "compensation.revise")).entityName).toBeTruthy(); // labelled by its effective date

    const raise = await reviseCompensation(deps, actor, { employee: `employees/${emp}`, annual_ctc: 720000, effective_from: "2026-01-01" });
    expect((await lastMeta(raise.uuid, "compensation.revise")).meta.diff!.ctcAnnual).toEqual({ from: 360000, to: 720000 });

    await updateCompensation(deps, actor, raise.uuid, { annual_ctc: 800000 });
    expect((await lastMeta(raise.uuid, "compensation.update")).meta.diff!.ctcAnnual).toEqual({ from: 720000, to: 800000 });

    await deleteCompensation(deps, actor, raise.uuid);
    // A removal states what left the timeline and the salary the employee falls back to.
    expect((await lastMeta(raise.uuid, "compensation.delete")).meta.diff!.ctcAnnual).toEqual({ from: 800000, to: 360000 });
  });

  it("keeps a removed revision out of payroll pricing", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedCompRow(emp, 40000, "2025-06-01", "2026-01-01");
    await seedCompRow(emp, 90000, "2026-01-01", null); // the wrong figure, entered by mistake
    const wrong = (await deps.db.select().from(schema.compensation).where(eq(schema.compensation.employeeId, emp))).find((c) => !c.effectiveTo)!;
    await deleteCompensation(deps, actor, wrong.uuid);

    const jan = await seedPeriodRange("Jan 2026", "2026-01-01", "2026-01-31");
    const run = await createRun(deps, actor, `pay-periods/${jan}`);
    await buildRunItems(deps, actor, run.uuid);
    const basic = (await listRunItems(deps, run.uuid))[0]!.lines.find((l) => l.code === "BASIC")!.amount;
    expect(basic).toBe(40000); // priced at the revision that took the window back, not the removed one
  });
});

// ---- Statutory + tax bases (money-audit A1/A2/A3/A5) -----------------------------------------------------
describe("payroll: statutory + tax bases are the wage actually paid", () => {
  it("nets loss of pay out of gross, the taxable base, PF wages and ESI wages", async () => {
    const emp = await seedEmployee({ epfEnrolled: true });
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 12000 });
    await seedComponent({ name: "Provident Fund", kind: "deduction", method: "epf", rate: 12, cap: 15000 });
    await seedComponent({ name: "Employer PF", kind: "employer_contribution", method: "epf", rate: 12, cap: 15000 });
    await seedComponent({ name: "EDLI Charges", kind: "employer_contribution", method: "edli", rate: 0.5, cap: 15000 });
    await seedComponent({ name: "PF Admin", kind: "employer_contribution", method: "pf_admin", rate: 0.5, cap: 15000 });
    await seedComponent({ name: "ESI", kind: "deduction", method: "esi", rate: 0.75, cap: 21000 });
    await seedComponent({ name: "Professional Tax", kind: "deduction", method: "pt" });
    await seedSetting("professional-tax", { slabs: [{ up_to: 5000, amount: 0 }, { up_to: null, amount: 200 }] });

    const period = await seedPeriod();
    const run = await createRun(deps, actor, `pay-periods/${period}`);
    // A manually keyed loss of pay of 3000 (a quarter of the month).
    await buildRunItems(deps, actor, run.uuid, { [emp]: [{ code: "LOP", name: "Loss of pay (6d)", kind: "deduction", amount: 3000 }] });

    const item = (await listRunItems(deps, run.uuid))[0]!;
    const line = (code: string) => item.lines.find((l) => l.code === code);
    // Docked pay is a NEGATIVE EARNING, so it leaves gross and the taxable base rather than sitting beside them.
    expect(line("LOP")).toMatchObject({ kind: "earning", amount: -3000 });
    expect(item.gross).toBe(9000);
    expect(item.taxable_gross).toBe(9000);
    // PF on the 9000 of basic actually paid (not 12000), and every PF-family employer line on the same wage.
    expect(line("EPF")!.amount).toBe(1080);
    expect(line("ER_EPF")!.amount).toBe(1080);
    expect(line("ER_EDLI")!.amount).toBe(45);
    expect(line("ER_PF_ADMIN")!.amount).toBe(45);
    // ESI on the 9000 paid: ceil(9000 x 0.75%) = 68. PT still keys off the monthly wage BRACKET (12000 -> 200).
    expect(line("ESI")!.amount).toBe(68);
    expect(line("PT")!.amount).toBe(200);
  });

  it("charges ESI on arrears + overtime, and PF only on the basic slice of the arrears", async () => {
    const emp = await seedEmployee({ epfEnrolled: true });
    const actor = await seedActor(emp);
    // A backdated revision left 4000 of arrears, of which 3000 is the rise in basic (PF wages).
    await seedComp(emp, { basePay: 12000, arrearsAmount: 4000, arrearsBaseAmount: 3000 });
    await seedComponent({ name: "Provident Fund", kind: "deduction", method: "epf", rate: 12, cap: 20000 });
    await seedComponent({ name: "ESI", kind: "deduction", method: "esi", rate: 0.75, cap: 21000 });

    const period = await seedPeriod();
    const run = await createRun(deps, actor, `pay-periods/${period}`);
    await buildRunItems(deps, actor, run.uuid);
    const item = (await listRunItems(deps, run.uuid))[0]!;
    const line = (code: string) => item.lines.find((l) => l.code === code);
    expect(line("ARREARS")!.amount).toBe(4000);
    // ESI wages = 12000 + 4000 arrears -> ceil(16000 x 0.75%) = 120.
    expect(line("ESI")!.amount).toBe(120);
    // PF wages = 12000 + the 3000 basic slice = 15000 -> 1800 (the 1000 non-basic arrears carry no PF).
    expect(line("EPF")!.amount).toBe(1800);
  });
});

// ---- Payout precision (money-audit D1) -------------------------------------------------------------------
describe("payroll: the net is settled to the precision the money is paid at", () => {
  it("adds a rounding line so the payslip, the item and the bank file agree", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 12345.67 }); // INR pays in whole rupees
    const period = await seedPeriod();
    const run = await createRun(deps, actor, `pay-periods/${period}`);
    await buildRunItems(deps, actor, run.uuid);
    const item = (await listRunItems(deps, run.uuid))[0]!;
    expect(item.net).toBe(12346); // exactly what leaves the bank
    expect(item.lines.find((l) => l.code === "ROUND")).toMatchObject({ kind: "earning", amount: 0.33, taxable: false });
    expect(item.taxable_gross).toBe(12345.67); // rounding is not income
  });
});

// ---- Who is paid (money-audit E1) ------------------------------------------------------------------------
describe("payroll: pays everyone who has not left", () => {
  it("includes an on_leave employee and excludes a terminated one", async () => {
    const onLeave = await seedEmployee({ status: "on_leave", code: short("01") });
    const left = await seedEmployee({ status: "terminated", code: short("02") });
    const actor = await seedActor(onLeave);
    await seedComp(onLeave, { basePay: 20000 });
    await seedComp(left, { basePay: 20000 });
    const period = await seedPeriod();
    const run = await createRun(deps, actor, `pay-periods/${period}`);
    await buildRunItems(deps, actor, run.uuid);
    const items = await listRunItems(deps, run.uuid);
    expect(items.map((i) => i.employee)).toEqual([`employees/${onLeave}`]);
  });
});

// ---- Loan installments (money-audit E2) ------------------------------------------------------------------
describe("payroll: an EMI starts on the agreed date and is collected once a month", () => {
  it("collects nothing before the loan's start date", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 50000 });
    const loan = await createLoan(deps, actor, { start_date: "2026-03-01", employee: `employees/${emp}`, principal: 12000, installments: 12 });
    await approveLoan(deps, actor, loan.uuid);
    await disburseLoan(deps, actor, loan.uuid);
    // January period: recovery only begins in March.
    const jan = await createRun(deps, actor, `pay-periods/${await seedPeriod()}`);
    await buildRunItems(deps, actor, jan.uuid);
    expect((await listRunItems(deps, jan.uuid))[0]!.lines.find((l) => l.code === "LOAN")).toBeUndefined();

    const mar = await createRun(deps, actor, `pay-periods/${await seedPeriodRange("Mar 2026", "2026-03-01", "2026-03-31")}`);
    await buildRunItems(deps, actor, mar.uuid);
    expect((await listRunItems(deps, mar.uuid))[0]!.lines.find((l) => l.code === "LOAN")!.amount).toBe(1000);
  });

  it("does not take a second installment from another run in the same month", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 50000 });
    const loan = await createLoan(deps, actor, { start_date: "2026-01-01", employee: `employees/${emp}`, principal: 12000, installments: 12 });
    await approveLoan(deps, actor, loan.uuid);
    await disburseLoan(deps, actor, loan.uuid);

    const first = await createRun(deps, actor, `pay-periods/${await seedPeriodRange("Jan 2026 (1-15)", "2026-01-01", "2026-01-15")}`);
    await buildRunItems(deps, actor, first.uuid);
    expect((await listRunItems(deps, first.uuid))[0]!.lines.find((l) => l.code === "LOAN")!.amount).toBe(1000);

    // A second, separate period inside the SAME calendar month: the EMI is monthly, so nothing more is due.
    const second = await createRun(deps, actor, `pay-periods/${await seedPeriodRange("Jan 2026 (16-31)", "2026-01-16", "2026-01-31")}`);
    await buildRunItems(deps, actor, second.uuid);
    expect((await listRunItems(deps, second.uuid))[0]!.lines.find((l) => l.code === "LOAN")).toBeUndefined();
    // And a rebuild of the FIRST run still collects its own installment (idempotent, not double).
    await buildRunItems(deps, actor, first.uuid);
    expect((await listRunItems(deps, first.uuid))[0]!.lines.find((l) => l.code === "LOAN")!.amount).toBe(1000);
    expect((await deps.db.select().from(schema.loans).where(eq(schema.loans.uuid, loan.uuid)))[0]!.repaid).toBe(1000);
  });
});

// ---- Loan interest concession (money-audit E4) -----------------------------------------------------------
describe("payroll: a cheap employer loan is a taxable perquisite", () => {
  it("lifts the taxable base only - never gross, deductions or net", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 50000 });
    await seedSetting("loan-perquisite", { enabled: true, sbi_rate_pct: 9, interest_charged_pct: 0, exempt_principal_upto: 20000 });
    const loan = await createLoan(deps, actor, { start_date: "2026-06-01", employee: `employees/${emp}`, principal: 200000, installments: 20 });
    await approveLoan(deps, actor, loan.uuid);
    await disburseLoan(deps, actor, loan.uuid);

    const run = await createRun(deps, actor, `pay-periods/${await seedPeriod()}`);
    await buildRunItems(deps, actor, run.uuid);
    const item = (await listRunItems(deps, run.uuid))[0]!;
    expect(item.lines.find((l) => l.code === "PERQ_LOAN")).toMatchObject({ kind: "perquisite", amount: 1500 }); // 200000 x 9% / 12
    expect(item.gross).toBe(50000);
    expect(item.net).toBe(50000);
    expect(item.taxable_gross).toBe(51500);
  });
});

// ---- Full & final settlement (money-audit B1-B5) ---------------------------------------------------------
async function seedLeaveType(name: string, encashable: boolean): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.leaveTypes).values({ uuid, code: short("lt"), name, encashable });
  return uuid;
}
async function seedBalance(employeeId: string, leaveTypeId: string, days: number) {
  await deps.db.insert(schema.leaveBalances).values({ uuid: genId(), code: short("lb"), employeeId, leaveTypeId, balanceDays: days });
}

describe("FnF: only encashable leave is cashed out (money-audit B2)", () => {
  it("defaults to the encashable balances and debits only those", async () => {
    const emp = await seedEmployee({ startDate: new Date("2020-01-01"), endDate: new Date("2026-01-31") });
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 30000 });
    const earned = await seedLeaveType("Earned Leave", true);
    const sick = await seedLeaveType("Sick Leave", false);
    await seedBalance(emp, earned, 10);
    await seedBalance(emp, sick, 5);

    const row = await computeAndStoreSettlement(deps, actor, { employee: `employees/${emp}`, settlement_date: "2026-01-31" });
    expect(row.leaveDays).toBe(10); // not 15 - sick leave is not encashable
    const balances = await deps.db.select().from(schema.leaveBalances).where(eq(schema.leaveBalances.employeeId, emp));
    expect(balances.find((b) => b.leaveTypeId === earned)!.balanceDays).toBe(0);
    expect(balances.find((b) => b.leaveTypeId === sick)!.balanceDays).toBe(5); // untouched
  });
});

describe("FnF: exit encashment uses the configured rate (money-audit B3)", () => {
  it("prices it off the same basis + divisor a mid-employment cashout uses", async () => {
    const emp = await seedEmployee({ startDate: new Date("2020-01-01"), endDate: new Date("2026-01-31") });
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 30000 });
    await seedComponent({ name: "House Rent Allowance", method: "percent_base", rate: 40 }); // gross = 42000
    const earned = await seedLeaveType("Earned Leave", true);
    await seedBalance(emp, earned, 10);
    await seedSetting("leave_encashment", { rate_basis: "gross", per_day_divisor: 26 });
    await seedSetting("gratuity", { enabled: false }); // isolate the encashment line

    const row = await computeAndStoreSettlement(deps, actor, { employee: `employees/${emp}`, settlement_date: "2026-01-31" });
    const lines = JSON.parse(row.linesJson) as { name: string; amount: number }[];
    expect(lines.find((l) => l.name.startsWith("Leave"))!.amount).toBe(16153.85); // 10 x 42000 / 26
  });
});

describe("FnF: gratuity and the final month (money-audit B4, B5)", () => {
  it("pays statutory gratuity once the qualifying service is served, exempt u/s 10(10)", async () => {
    const emp = await seedEmployee({ startDate: new Date("2019-01-01"), endDate: new Date("2026-01-31") });
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 26000 });
    const row = await computeAndStoreSettlement(deps, actor, { employee: `employees/${emp}`, settlement_date: "2026-01-31" });
    const lines = JSON.parse(row.linesJson) as { name: string; amount: number; taxable?: number }[];
    const gratuity = lines.find((l) => l.name === "Gratuity")!;
    expect(gratuity.amount).toBe(105000); // 26000/26 x 15 x 7 completed years
    expect(gratuity.taxable).toBe(0); // within the s.10(10) exemption
  });

  it("pays a mid-month joiner only for the days employed", async () => {
    const emp = await seedEmployee({ startDate: new Date("2026-01-10"), endDate: new Date("2026-01-31") });
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 31000 });
    const row = await computeAndStoreSettlement(deps, actor, { employee: `employees/${emp}`, settlement_date: "2026-01-31" });
    const lines = JSON.parse(row.linesJson) as { name: string; amount: number }[];
    // Jan 10..31 = 22 days of 31, not the whole month.
    expect(lines.find((l) => l.name.startsWith("Salary"))!.amount).toBe(22000); // 31000 x 22/31
  });
});

describe("FnF: the exit payout withholds like a payroll run (money-audit B1)", () => {
  it("deducts PF, PT and income tax, and records the chargeable base + TDS for Form 16", async () => {
    const emp = await seedEmployee({ epfEnrolled: true, startDate: new Date("2025-04-01"), endDate: new Date("2026-01-31") });
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 1500000 }); // a high final month, so tax is unambiguous
    await seedComponent({ name: "Provident Fund", kind: "deduction", method: "epf", rate: 12, cap: 15000 });
    await seedComponent({ name: "Professional Tax", kind: "deduction", method: "pt" });
    await seedComponent({ name: "Income Tax (TDS)", kind: "deduction", method: "income_tax", regime: "new" });
    await seedSetting("professional-tax", { slabs: [{ up_to: 25000, amount: 0 }, { up_to: null, amount: 200 }] });
    await seedSetting("gratuity", { enabled: false });

    const row = await computeAndStoreSettlement(deps, actor, { employee: `employees/${emp}`, settlement_date: "2026-01-31" });
    const lines = JSON.parse(row.linesJson) as { name: string; kind: string; amount: number }[];
    const named = (n: string) => lines.find((l) => l.name === n);
    expect(named("Provident Fund")).toMatchObject({ kind: "deduction", amount: 1800 }); // 12% of the 15000 ceiling
    expect(named("Professional Tax")).toMatchObject({ kind: "deduction", amount: 200 });
    const tds = named("Income tax (TDS)")!;
    expect(tds.amount).toBeGreaterThan(0);
    expect(row.tds).toBe(tds.amount);
    expect(row.taxableEarnings).toBe(1500000);
    expect(row.net).toBe(1500000 - 1800 - 200 - tds.amount);

    // The same figures are what Form 16 and the year's projection read back for a leaver (no run carries them).
    const fy = fyWindow(new Date("2026-01-31"));
    expect(await settlementTotals(deps, fy, emp)).toEqual({ taxableGross: 1500000, tax: tds.amount });
  });
});

// ---- Month attribution + declarations (money-audit C1, C2) -----------------------------------------------
describe("tax: a paid run is keyed by BOTH its pay month and its earning month (money-audit C1)", () => {
  it("keeps collection months and earned months apart when pay lags earning", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 50000 });
    // April's salary, paid on 5 May.
    const apr = genId();
    await deps.db.insert(schema.payPeriods).values({
      uuid: apr, code: short("pp"), label: "Apr 2026",
      periodStart: new Date("2026-04-01"), periodEnd: new Date("2026-04-30"), payDate: new Date("2026-05-05"),
    });
    const run = await createRun(deps, actor, `pay-periods/${apr}`);
    await buildRunItems(deps, actor, run.uuid);
    await transition(deps, actor, run.uuid, "REVIEW");
    await transition(deps, actor, run.uuid, "APPROVED");

    const totals = (await finalizedTotals(deps, fyWindow(new Date("2026-05-05")))).get(emp)!;
    expect([...totals.paidMonths]).toEqual(["2026-05"]); // when the tax was collected
    expect([...totals.earnedMonths]).toEqual(["2026-04"]); // which month's salary is already priced
  });
});

describe("tax: a VERIFIED declaration reduces withholding (money-audit C2)", () => {
  it("cuts the monthly TDS by the allowed Chapter VI-A deduction", async () => {
    const emp = await seedEmployee({ startDate: new Date("2025-04-01") });
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 200000 });
    await seedComponent({ name: "Income Tax (TDS)", kind: "deduction", method: "income_tax", regime: "new" });
    const period = await seedPeriod();
    const run = await createRun(deps, actor, `pay-periods/${period}`);
    await buildRunItems(deps, actor, run.uuid);
    const before = (await listRunItems(deps, run.uuid))[0]!.tax;
    expect(before).toBeGreaterThan(0);

    const fy = fyWindow(new Date("2026-01-31")).financialYear;
    const declare = async (section: string, amount: number, status: "VERIFIED" | "DECLARED") => {
      await deps.db.insert(schema.taxDeclarations).values({
        uuid: genId(), code: short("td"), employeeId: emp, financialYear: fy, section,
        declaredAmount: amount, verifiedAmount: status === "VERIFIED" ? amount : null, status,
      });
      await buildRunItems(deps, actor, run.uuid);
      return (await listRunItems(deps, run.uuid))[0]!.tax;
    };

    // 80C is disallowed under the new regime, so a verified 80C moves nothing.
    expect(await declare("80C", 150000, "VERIFIED")).toBe(before);
    // A merely DECLARED (unverified) 80CCD(2) must not move withholding either - verification is the gate.
    expect(await declare("80CCD(2)", 50000, "DECLARED")).toBe(before);
    // Verified 80CCD(2) (the employer's NPS contribution) survives the new regime and cuts the tax.
    expect(await declare("80CCD(2)", 100000, "VERIFIED")).toBeLessThan(before);

    // WITHDRAWING it puts the withholding back. `tax-declarations` is a soft-delete collection whose delete
    // carries no state guard, so a VERIFIED row can be removed - and `status` alone does not say so. The
    // delete mark is the second, independent reason a row does not count (sumBySection); pinned here because
    // the alternative is a declaration HR had deleted going on cutting the taxable base for the rest of the
    // year, which is invisible from the list that same HR reads.
    await deps.db.update(schema.taxDeclarations).set({ deleteTime: new Date() }).where(eq(schema.taxDeclarations.section, "80CCD(2)"));
    await buildRunItems(deps, actor, run.uuid);
    expect((await listRunItems(deps, run.uuid))[0]!.tax).toBe(before);
  });
});

describe("compensation: a self-service read is priced by the server and carries no grade or band", () => {
  it("gives the caller's own row its CTC build-up while withholding the grade/band", async () => {
    const emp = await seedEmployee({ epfEnrolled: true });
    const actor = await seedActor(emp);
    const gradeId = genId();
    await deps.db.insert(schema.payGrades).values({ uuid: gradeId, code: short("pg"), name: "L4", bandMin: 600000, bandMid: 1200000, bandMax: 2000000, currency: "INR" });
    await seedComponent({ name: "HRA", method: "percent_base", rate: 40 });
    await seedComponent({ name: "Employer PF", kind: "employer_contribution", method: "epf", rate: 12, cap: 15000 });
    // 50000 basic + 40% HRA + 5000 plug = 75000 gross, + employer PF 12% of the 15000 ceiling = 76800/month.
    await seedComp(emp, { basePay: 50000, specialAllowance: 5000, ctcAnnual: 921600, payGradeId: gradeId });

    // The two scopes the middleware hands down: payroll reads everyone, an employee only ever their own row
    // (what My Profile's tab gets once an org grants compensation.read to its people).
    const orgWide = { breadth: "all", deptCode: null, ownerId: null, seeRestricted: true } as const;
    const ownOnly = { breadth: "own", deptCode: null, ownerId: emp, seeRestricted: true } as const;
    const rows = await listCompensation(deps, orgWide, emp);

    const [asPayroll] = await decorateCompensation(deps, actor, rows, orgWide);
    const [asSelf] = await decorateCompensation(deps, actor, await listCompensation(deps, ownOnly, emp), ownOnly);

    // Payroll keeps the ladder context; the employee gets the pay, not where it sits against the band.
    expect(toCompensationResource(asPayroll).pay_grade_name).toBe("L4");
    expect(toCompensationResource(asPayroll).band_status).toBe("in_band");
    const mine = toCompensationResource(asSelf);
    expect(mine.pay_grade_name).toBeUndefined();
    expect(mine.band_status).toBeUndefined();
    expect(mine.compa_ratio).toBeUndefined();
    expect(mine.pay_grade).toBeUndefined();

    // ...and the build-up is priced server-side, so the employee needs neither the component catalog nor the
    // salary structure to see what makes up the CTC.
    expect(mine.ctc_monthly).toBe(76800);
    expect(mine.breakdown?.map((l) => [l.name, l.monthly])).toEqual([
      ["Basic", 50000], ["HRA", 20000], ["Special Allowance", 5000], ["Employer PF", 1800],
    ]);
    expect(mine.breakdown?.every((l) => l.annual === l.monthly * 12)).toBe(true);
  });

  it("skips the build-up on an org-wide list (it would cost a catalog read per employee)", async () => {
    const a = await seedEmployee();
    const b = await seedEmployee();
    const actor = await seedActor(a);
    await seedComponent({ name: "HRA", method: "percent_base", rate: 40 });
    await seedComp(a, { basePay: 30000, ctcAnnual: 504000 });
    await seedComp(b, { basePay: 40000, ctcAnnual: 672000 });

    const orgWide = { breadth: "all", deptCode: null, ownerId: null, seeRestricted: true } as const;
    const rows = await listCompensation(deps, orgWide);
    const decorated = await decorateCompensation(deps, actor, rows, orgWide);
    expect(decorated).toHaveLength(2);
    expect(decorated.every((r) => toCompensationResource(r).breakdown === undefined)).toBe(true);
  });
});

// A run that cannot price somebody must SAY SO. The build walks every employee who has not left and skips
// anyone with no compensation in force at the period end, because there is no salary to price - correct, but
// it used to be silent, and a skipped person leaves no trace anywhere else: they have no run item, and every
// other warning the run carries (staleness, split drift) is computed FROM the items. So the one employee the
// run is wrong about was the one employee it could not mention, and the symptom was not an error - it was
// somebody quietly not being paid, found when they asked.
describe("payroll: an employee the run could not price is named, not dropped", () => {
  it("lists someone employed in the period who has no compensation on record", async () => {
    const paid = await seedEmployee({ firstName: "Priya", lastName: "Paid", startDate: new Date("2025-01-01") });
    const missed = await seedEmployee({ firstName: "Nadia", lastName: "Nocomp", startDate: new Date("2025-01-01") });
    const actor = await seedActor(paid);
    await seedComp(paid, { basePay: 30000 });
    // `missed` deliberately gets no compensation row at all - the new-joiner-never-set-up case.
    const period = await seedPeriod();
    const run = await createRun(deps, actor, `pay-periods/${period}`);
    await buildRunItems(deps, actor, run.uuid);

    // The run pays exactly one person...
    const items = await listRunItems(deps, run.uuid);
    expect(items).toHaveLength(1);
    // ...and says who it could not.
    const freshness = await runStaleness(deps, await getRun(deps, run.uuid));
    expect(freshness.unpriced).toEqual(["Nadia Nocomp"]);
  });

  it("says nothing when everyone was priced", async () => {
    const emp = await seedEmployee({ startDate: new Date("2025-01-01") });
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 30000 });
    const run = await createRun(deps, actor, `pay-periods/${await seedPeriod()}`);
    await buildRunItems(deps, actor, run.uuid);
    expect((await runStaleness(deps, await getRun(deps, run.uuid))).unpriced).toBeUndefined();
  });

  it("does not cry about a FUTURE joiner, who is correctly unpriced", async () => {
    const emp = await seedEmployee({ startDate: new Date("2025-01-01") });
    const actor = await seedActor(emp);
    await seedComp(emp, { basePay: 30000 });
    // The period is Jan 2026 (seedPeriod); this person starts after it closes, so they are not owed anything
    // and their absence is the right answer. A warning that fires on every start date in the diary is a
    // warning nobody reads.
    await seedEmployee({ firstName: "Later", lastName: "Joiner", startDate: new Date("2026-06-01") });
    const run = await createRun(deps, actor, `pay-periods/${await seedPeriod()}`);
    await buildRunItems(deps, actor, run.uuid);
    expect((await runStaleness(deps, await getRun(deps, run.uuid))).unpriced).toBeUndefined();
  });

  it("clears the list on a rebuild that can price everybody", async () => {
    const paid = await seedEmployee({ startDate: new Date("2025-01-01") });
    const missed = await seedEmployee({ firstName: "Fixed", lastName: "Later", startDate: new Date("2025-01-01") });
    const actor = await seedActor(paid);
    await seedComp(paid, { basePay: 30000 });
    const run = await createRun(deps, actor, `pay-periods/${await seedPeriod()}`);
    await buildRunItems(deps, actor, run.uuid);
    expect((await runStaleness(deps, await getRun(deps, run.uuid))).unpriced).toEqual(["Fixed Later"]);

    // The remedy the banner asks for: enter their compensation, rebuild.
    await seedComp(missed, { basePay: 25000 });
    await buildRunItems(deps, actor, run.uuid);
    expect((await listRunItems(deps, run.uuid))).toHaveLength(2);
    expect((await runStaleness(deps, await getRun(deps, run.uuid))).unpriced).toBeUndefined();
  });
});

// The salary timeline is written as close-the-old-row + open-the-new-one. Those are two statements, and they
// used to be two ROUND TRIPS with a code allocation awaited in between: a failure in the gap committed the
// close and never landed the insert, leaving the employee with every compensation row closed - no current
// salary - which `compAsOf` answers `undefined` for and the payroll build then silently skips.
describe("compensation: a revision leaves the timeline whole", () => {
  it("keeps exactly one open row through a chain of revisions", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await reviseCompensation(deps, actor, { employee: `employees/${emp}`, annual_ctc: 600000, effective_from: "2025-01-01" });
    await reviseCompensation(deps, actor, { employee: `employees/${emp}`, annual_ctc: 720000, effective_from: "2025-07-01" });
    await reviseCompensation(deps, actor, { employee: `employees/${emp}`, annual_ctc: 840000, effective_from: "2026-01-01" });

    const rows = await deps.db.select().from(schema.compensation).where(eq(schema.compensation.employeeId, emp));
    expect(rows).toHaveLength(3);
    const open = rows.filter((r) => r.effectiveTo === null);
    expect(open).toHaveLength(1);
    expect(open[0]!.ctcAnnual).toBe(840000);
    // Half-open and contiguous: each closed row ends exactly where the next begins, so there is no instant the
    // employee has no salary and none where they have two.
    const byFrom = [...rows].sort((a, b) => +new Date(a.effectiveFrom) - +new Date(b.effectiveFrom));
    expect(+new Date(byFrom[0]!.effectiveTo!)).toBe(+new Date(byFrom[1]!.effectiveFrom));
    expect(+new Date(byFrom[1]!.effectiveTo!)).toBe(+new Date(byFrom[2]!.effectiveFrom));
  });

  it("refuses the loser of a concurrent revision instead of opening a second current row", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await reviseCompensation(deps, actor, { employee: `employees/${emp}`, annual_ctc: 600000, effective_from: "2025-01-01" });

    // Both read the same open row, both try to close it and open their own.
    const results = await Promise.allSettled([
      reviseCompensation(deps, actor, { employee: `employees/${emp}`, annual_ctc: 700000, effective_from: "2025-07-01" }),
      reviseCompensation(deps, actor, { employee: `employees/${emp}`, annual_ctc: 800000, effective_from: "2025-08-01" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    // Whichever won, the invariant holds: one current salary, and the loser wrote nothing at all.
    const rows = await deps.db.select().from(schema.compensation).where(eq(schema.compensation.employeeId, emp));
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.effectiveTo === null)).toHaveLength(1);
  });
});

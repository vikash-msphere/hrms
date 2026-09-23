/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import * as XLSX from "xlsx";
// Glob every migration (ordered by filename) so squashing/adding migrations never breaks this suite.
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";

import { buildBankFile } from "../src/services/bankFile";
import { buildStatutoryReport, buildPfEcr } from "../src/services/statutoryReport";
import { saveBankFormat, templateKey, type BankFormatColumn } from "../src/services/bankFormats";
import { setBankDetails } from "../src/services/bankDetails";
import { setIdentityDetails } from "../src/services/identityDetails";

// THE THREE OUTPUTS THAT LEAVE THE BUILDING, none of which had a test.
//
// Everything else money touches is asserted somewhere: moneyFlow/payroll/statutory/incomeTax/taxProjection
// cover what the run COMPUTES. These three cover what is then handed to somebody outside the company - a bulk
// payment file to a bank, a contribution register and ECR to EPFO/ESIC, and a tax certificate to an employee -
// where a mapping error is not a wrong number on a screen but a wrong payment, a rejected challan, or a wrong
// Form 16. They are also the surfaces where a defect is discovered LAST, because nothing downstream of them
// is ours to observe.
//
// So the assertions here are deliberately about the JOIN between the run and the artifact - does the file say
// what the run computed, for the right person, in the right column - rather than re-deriving the arithmetic the
// domain suites already pin.
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
  schema.payrollRunItems, schema.payslips, schema.payrollRuns, schema.payPeriods,
  schema.payComponents, schema.compensation,
  schema.notifications, schema.eventLog, schema.auditLog,
  schema.users, schema.employees, schema.roles,
  schema.settings,
];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

const short = (p: string) => `${p}-${genId().slice(0, 6)}`;

async function seedActor(): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "super_admin", label: "Super admin" }).onConflictDoNothing();
  const uuid = genId();
  const email = `${uuid}@test.example`;
  await deps.db.insert(schema.users).values({ uuid, code: short("u"), email, role: "super_admin", employeeId: null });
  return { uuid, email, role: "super_admin", status: "active", employeeId: null, employeeCode: null } as unknown as AppUser;
}

async function seedEmployee(over: Partial<typeof schema.employees.$inferInsert> = {}): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.employees).values({
    uuid, code: over.code ?? short("04"), firstName: over.firstName ?? "Test", lastName: over.lastName ?? "User",
    workEmail: `${uuid}@test.example`, status: "active", ...over,
  });
  return uuid;
}

async function seedSetting(key: string, value: unknown) {
  await deps.db
    .insert(schema.settings)
    .values({ key, value: JSON.stringify(value), updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify(value) } });
}

/** An APPROVED run with one item per entry, whose lines are given verbatim - the artifact builders read the
 *  stored `lines_json`, so seeding lines directly is what isolates them from the build. */
async function seedRun(
  items: { employeeId: string; net: number; gross?: number; tax?: number; lines?: unknown[] }[],
  state: "APPROVED" | "PUBLISHED" | "DRAFT" = "APPROVED",
): Promise<string> {
  const periodId = genId();
  await deps.db.insert(schema.payPeriods).values({
    uuid: periodId, code: short("pp"), label: "Jan 2026",
    periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-01-31"), payDate: new Date("2026-01-31"),
  });
  const runId = genId();
  await deps.db.insert(schema.payrollRuns).values({ uuid: runId, code: short("07"), payPeriodId: periodId, state });
  for (const it of items) {
    await deps.db.insert(schema.payrollRunItems).values({
      uuid: genId(), code: short("pri"), runId, employeeId: it.employeeId,
      gross: it.gross ?? it.net, taxableGross: it.gross ?? it.net, totalDeductions: 0, net: it.net, tax: it.tax ?? 0,
      linesJson: JSON.stringify(it.lines ?? [{ code: "BASIC", name: "Basic", kind: "earning", amount: it.net }]),
    });
  }
  return runId;
}

// ---- bank file -------------------------------------------------------------------------------------------

const BANK = "HDFC Bank";
// One column per thing that can be mis-mapped: who, how much, and which rail.
const COLUMNS: BankFormatColumn[] = [
  { col: 1, header: "Account", source: "account_number" },
  { col: 2, header: "Name", source: "account_name" },
  { col: 3, header: "Amount", source: "net" },
  { col: 4, header: "Type", source: "transaction_type", intra: "IFT", inter: "NEFT" },
];

/** A blank single-sheet template with just a header row, stored where getBankTemplate looks for it. */
async function seedBankTemplate(actor: AppUser, bank = BANK, columns = COLUMNS) {
  await seedBankFormat(actor, bank, columns);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([columns.map((c) => c.header)]), "Sheet1");
  const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
  await deps.docs.put(templateKey(bank), bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}
async function seedBankFormat(actor: AppUser, bank = BANK, columns = COLUMNS) {
  await saveBankFormat(deps, actor, bank, { columns, sheet: "Sheet1", header_row: 1, data_start_row: 2 });
}

/** The generated workbook's data rows, as an array of arrays. */
function dataRows(bytes: Uint8Array): (string | number | undefined)[][] {
  const wb = XLSX.read(bytes, { type: "array" });
  const aoa = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, blankrows: false });
  return aoa.slice(1); // drop the header row
}

describe("bank file: the payment lines match the run, for the right people, on the right rail", () => {
  it("writes one row per payable employee, carrying that employee's account and that item's net", async () => {
    const actor = await seedActor();
    await seedSetting("organization", { name: "Test Co", banks: [BANK], default_currency: "INR" });
    await seedBankTemplate(actor);

    const alice = await seedEmployee({ code: "04-001", firstName: "Alice", lastName: "Anand" });
    const bob = await seedEmployee({ code: "04-002", firstName: "Bob", lastName: "Bose" });
    await setBankDetails(deps, actor, alice, { bank_name: BANK, account_name: "Alice Anand", account_number: "111111", ifsc_code: "HDFC0000001" });
    await setBankDetails(deps, actor, bob, { bank_name: BANK, account_name: "Bob Bose", account_number: "222222", ifsc_code: "HDFC0000001" });

    const runId = await seedRun([{ employeeId: alice, net: 50000 }, { employeeId: bob, net: 61234 }]);
    const { bytes, fileName } = await buildBankFile(deps, null, runId, BANK);
    const rows = dataRows(bytes);

    expect(rows).toHaveLength(2);
    // Ordered by employee code, so a row's account and its amount cannot be transposed between people
    // without this failing - which is the whole risk a payment file carries.
    expect(rows[0]![0]).toBe("111111");
    expect(rows[0]![2]).toBe(50000);
    expect(rows[1]![0]).toBe("222222");
    expect(rows[1]![2]).toBe(61234);
    expect(fileName).toContain("hdfc-bank-payroll-");
  });

  it("classifies a within-bank payment as intra REGARDLESS of the case the bank name was stored in", async () => {
    // The regression: the intra/inter decision was a raw `===` between the employee's stored `bank_name` and
    // the format key, so a row differing only by case was paid as an inter-bank transfer - silently, and at
    // inter-bank cost, for every internal account in the org.
    const actor = await seedActor();
    await seedSetting("organization", { name: "Test Co", banks: [BANK, "Other Bank"], default_currency: "INR" });
    await seedBankTemplate(actor);

    const same = await seedEmployee({ code: "04-001" });
    const other = await seedEmployee({ code: "04-002" });
    // Stored with different case + padding: still the same bank. `setBankDetails` accepts it because the org
    // declared it (the match is case-insensitive there too), which is precisely why the file must agree.
    await setBankDetails(deps, actor, same, { bank_name: "  hdfc bank ", account_number: "111111" });
    await setBankDetails(deps, actor, other, { bank_name: "Other Bank", account_number: "222222" });

    const runId = await seedRun([{ employeeId: same, net: 1000 }, { employeeId: other, net: 2000 }]);
    const rows = dataRows((await buildBankFile(deps, null, runId, BANK)).bytes);

    expect(rows[0]![3]).toBe("IFT"); // within-bank
    expect(rows[1]![3]).toBe("NEFT"); // another bank
  });

  it("refuses the whole file when a payable employee has no account, naming them", async () => {
    // Refusing beats dropping the row: a short file underpays somebody and looks complete.
    const actor = await seedActor();
    await seedSetting("organization", { name: "Test Co", banks: [BANK], default_currency: "INR" });
    await seedBankTemplate(actor);

    const paid = await seedEmployee({ code: "04-001" });
    const noAccount = await seedEmployee({ code: "04-002", firstName: "Nita", lastName: "Nair" });
    await setBankDetails(deps, actor, paid, { bank_name: BANK, account_number: "111111" });

    const runId = await seedRun([{ employeeId: paid, net: 1000 }, { employeeId: noAccount, net: 2000 }]);
    await expect(buildBankFile(deps, null, runId, BANK)).rejects.toThrow(/Nita Nair/);
  });

  it("omits a zero-net item entirely, and does not demand an account for one", async () => {
    const actor = await seedActor();
    await seedSetting("organization", { name: "Test Co", banks: [BANK], default_currency: "INR" });
    await seedBankTemplate(actor);

    const paid = await seedEmployee({ code: "04-001" });
    const zero = await seedEmployee({ code: "04-002" }); // no bank details at all
    await setBankDetails(deps, actor, paid, { bank_name: BANK, account_number: "111111" });

    const runId = await seedRun([{ employeeId: paid, net: 1000 }, { employeeId: zero, net: 0 }]);
    const rows = dataRows((await buildBankFile(deps, null, runId, BANK)).bytes);
    expect(rows).toHaveLength(1); // nothing to disburse, so nothing to route and nothing to demand
    expect(rows[0]![0]).toBe("111111");
  });

  it("binds a run to the first bank a file was made for, so two banks cannot both pay it", async () => {
    // Every file carries every payable employee. Two files for two banks on one run, both submitted, is every
    // salary paid twice - so the second bank is refused, and the first can be regenerated as often as needed.
    const actor = await seedActor();
    await seedSetting("organization", { name: "Test Co", banks: [BANK, "ICICI Bank"], default_currency: "INR" });
    await seedBankTemplate(actor);
    await seedBankTemplate(actor, "ICICI Bank");
    const paid = await seedEmployee({ code: "04-001" });
    await setBankDetails(deps, actor, paid, { bank_name: BANK, account_number: "111111" });
    const runId = await seedRun([{ employeeId: paid, net: 1000 }]);

    await buildBankFile(deps, null, runId, BANK);
    await expect(buildBankFile(deps, null, runId, "ICICI Bank")).rejects.toThrow(/HDFC Bank/);
    // The same bank again is a regeneration, not a second payout.
    expect(dataRows((await buildBankFile(deps, null, runId, BANK)).bytes)).toHaveLength(1);
    const run = (await deps.db.select().from(schema.payrollRuns))[0]!;
    expect(run.bankFileBank).toBe(BANK);
  });

  it("will not produce a file for a run that is not approved", async () => {
    const actor = await seedActor();
    await seedSetting("organization", { name: "Test Co", banks: [BANK], default_currency: "INR" });
    await seedBankTemplate(actor);
    const emp = await seedEmployee();
    await setBankDetails(deps, actor, emp, { bank_name: BANK, account_number: "111111" });
    const runId = await seedRun([{ employeeId: emp, net: 1000 }], "DRAFT");
    await expect(buildBankFile(deps, null, runId, BANK)).rejects.toThrow(/approved/i);
  });

  it("stamps bankFileAt once, on the first generation only", async () => {
    // The stamp is what stops a delete-after-payout from releasing every payable this run already paid.
    const actor = await seedActor();
    await seedSetting("organization", { name: "Test Co", banks: [BANK], default_currency: "INR" });
    await seedBankTemplate(actor);
    const emp = await seedEmployee();
    await setBankDetails(deps, actor, emp, { bank_name: BANK, account_number: "111111" });
    const runId = await seedRun([{ employeeId: emp, net: 1000 }]);

    await buildBankFile(deps, null, runId, BANK);
    const first = (await deps.db.select().from(schema.payrollRuns))[0]!.bankFileAt;
    expect(first).toBeTruthy();
    await buildBankFile(deps, null, runId, BANK);
    const second = (await deps.db.select().from(schema.payrollRuns))[0]!.bankFileAt;
    expect(+new Date(second!)).toBe(+new Date(first!)); // unchanged: the FIRST hand-off is the one that counts
  });
});

describe("bank details: bank_name is the org's enum, enforced on the server", () => {
  it("refuses a bank the org has not declared", async () => {
    // The SPA only offers settings/organization `banks` in a Select, but an API-key writer bypasses the form -
    // and the payment file decides intra/inter by matching this string, so an off-list name silently misroutes.
    const actor = await seedActor();
    await seedSetting("organization", { banks: [BANK] });
    const emp = await seedEmployee();
    await expect(setBankDetails(deps, actor, emp, { bank_name: "Some Other Bank", account_number: "1" })).rejects.toThrow(/must be one of the organization's banks/);
  });

  it("accepts an on-list bank in any case, and accepts anything when the org declared no list", async () => {
    const actor = await seedActor();
    await seedSetting("organization", { banks: [BANK] });
    const emp = await seedEmployee();
    await expect(setBankDetails(deps, actor, emp, { bank_name: "hdfc BANK", account_number: "1" })).resolves.toMatchObject({ on_file: true });

    // No list configured = no enum to check against; refusing everything would make bank details unfillable.
    await seedSetting("organization", {});
    const emp2 = await seedEmployee();
    await expect(setBankDetails(deps, actor, emp2, { bank_name: "Anything Bank", account_number: "1" })).resolves.toMatchObject({ on_file: true });
  });
});

// ---- statutory register + PF ECR -------------------------------------------------------------------------

/** A run item whose lines carry the full statutory set, as the payroll build writes them. */
const statutoryLines = (basic: number, epf: number, esi: number, pt: number, tds: number) => [
  { code: "BASIC", name: "Basic", kind: "earning", amount: basic },
  { code: "EPF", name: "EPF", kind: "deduction", amount: epf, basis: basic },
  { code: "ER_EPF", name: "Employer EPF", kind: "employer_contribution", amount: epf, basis: basic },
  { code: "ER_EDLI", name: "EDLI", kind: "employer_contribution", amount: 75, basis: basic },
  { code: "ER_PF_ADMIN", name: "PF admin", kind: "employer_contribution", amount: 75, basis: basic },
  { code: "ESI", name: "ESI", kind: "deduction", amount: esi, basis: basic },
  { code: "ER_ESI", name: "Employer ESI", kind: "employer_contribution", amount: esi * 4, basis: basic },
  { code: "PT", name: "Professional Tax", kind: "deduction", amount: pt },
  { code: "TDS", name: "TDS", kind: "deduction", amount: tds },
];

const sheet = (bytes: Uint8Array, name: string): (string | number)[][] => {
  const wb = XLSX.read(bytes, { type: "array" });
  return XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets[name]!, { header: 1, blankrows: false });
};

describe("statutory register: the remittance figures are the run's own", () => {
  it("totals each head over exactly the employees who contributed to it", async () => {
    const actor = await seedActor();
    await seedSetting("organization", { name: "Test Co" });
    // Two PF+ESI+PT members and one employee below every threshold, so a head that counted the whole roster
    // (rather than its own contributors) shows up as a wrong employee count on the challan.
    const a = await seedEmployee({ code: "04-001", firstName: "Alice", lastName: "Anand" });
    const c = await seedEmployee({ code: "04-002", firstName: "Bob", lastName: "Bose" });
    const none = await seedEmployee({ code: "04-003", firstName: "Zoe", lastName: "Zed" });
    const runId = await seedRun([
      { employeeId: a, net: 18000, gross: 20000, tax: 500, lines: statutoryLines(20000, 1800, 150, 200, 500) },
      { employeeId: c, net: 9000, gross: 10000, tax: 0, lines: statutoryLines(10000, 1200, 75, 200, 0) },
      { employeeId: none, net: 5000, gross: 5000, tax: 0, lines: [{ code: "BASIC", name: "Basic", kind: "earning", amount: 5000 }] },
    ]);
    void none;

    const { bytes } = await buildStatutoryReport(deps, runId);
    const summary = sheet(bytes, "Summary");
    const head = (label: string) => summary.find((r) => r[0] === label)!;

    expect(head("Provident Fund (EPF/EPS)")[1]).toBe(2); // the two members, not three
    expect(head("Provident Fund (EPF/EPS)")[2]).toBe(3000); // 1800 + 1200 employee share
    expect(head("ESI")[1]).toBe(2);
    expect(head("ESI")[2]).toBe(225); // 150 + 75
    expect(head("ESI")[3]).toBe(900); // employer share as the run computed it
    expect(head("Professional Tax")[2]).toBe(400);
    expect(head("TDS (income tax)")[1]).toBe(1); // only Alice had tax withheld
    expect(head("TDS (income tax)")[2]).toBe(500);
  });

  it("carves EPS out of the employer share at the pension-wage ceiling, not at the PF wage", async () => {
    // 8.33% of min(pf wages, 15000). Priced off the full wage instead, a high earner's challan over-states EPS
    // and under-states employer EPF by the same amount - a split EPFO rejects.
    const actor = await seedActor();
    void actor;
    await seedSetting("organization", { name: "Test Co" });
    const rich = await seedEmployee({ code: "04-001" });
    const runId = await seedRun([{ employeeId: rich, net: 45000, gross: 50000, lines: statutoryLines(50000, 6000, 0, 200, 0) }]);

    const pf = sheet((await buildStatutoryReport(deps, runId)).bytes, "PF");
    const row = pf.find((r) => r[1] === "04-001")!;
    const epsCol = pf[0]!.indexOf("EPS (8.33%)");
    expect(row[epsCol]).toBe(Math.round(0.0833 * 15000)); // 1250, capped
  });

  it("skips EPS for an EPS-excluded member, leaving the whole employer share in EPF", async () => {
    await seedSetting("organization", { name: "Test Co" });
    const excluded = await seedEmployee({ code: "04-001", epsExcluded: true });
    const runId = await seedRun([{ employeeId: excluded, net: 18000, gross: 20000, lines: statutoryLines(20000, 1800, 0, 200, 0) }]);

    const pf = sheet((await buildStatutoryReport(deps, runId)).bytes, "PF");
    const row = pf.find((r) => r[1] === "04-001")!;
    expect(row[pf[0]!.indexOf("EPS (8.33%)")]).toBe(0);
    expect(row[pf[0]!.indexOf("ER-EPF")]).toBe(1800); // the entire employer share stays in EPF
  });

  it("refuses a run with no items rather than emitting an empty register", async () => {
    const runId = await seedRun([]);
    await expect(buildStatutoryReport(deps, runId)).rejects.toThrow(/build the run first/);
    await expect(buildPfEcr(deps, runId)).rejects.toThrow(/build the run first/);
  });

  it("PF ECR carries one #~#-delimited line per PF member, with that member's UAN", async () => {
    const actor = await seedActor();
    await seedSetting("organization", { name: "Test Co" });
    const member = await seedEmployee({ code: "04-001", firstName: "Alice", lastName: "Anand" });
    const nonMember = await seedEmployee({ code: "04-002" });
    await setIdentityDetails(deps, actor, member, { uan: "100200300400" });

    const runId = await seedRun([
      { employeeId: member, net: 18000, gross: 20000, lines: statutoryLines(20000, 1800, 0, 0, 0) },
      { employeeId: nonMember, net: 5000, gross: 5000, lines: [{ code: "BASIC", name: "Basic", kind: "earning", amount: 5000 }] },
    ]);

    const { text } = await buildPfEcr(deps, runId);
    const lines = text.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1); // only the member
    expect(lines[0]!.startsWith("100200300400#~#")).toBe(true); // UAN first, EPFO's field order
    expect(lines[0]!).toContain("Alice Anand");
  });
});

// ---- Form 16 (Part B) ------------------------------------------------------------------------------------

/** The "Computation of tax" table the certificate renders, as a label -> amount map. */
function form16Figures(content: { blocks: unknown[] }): Record<string, string> {
  const table = (content.blocks as { kind: string; table?: { rows: string[][]; total?: string[] } }[]).find((x) => x.kind === "table")!.table!;
  const out: Record<string, string> = {};
  for (const [label, amount] of table.rows) out[label!] = amount!;
  if (table.total) out[table.total[0]!] = table.total[1]!;
  return out;
}

async function seedTdsComponent(regime: string) {
  await deps.db.insert(schema.payComponents).values({
    uuid: genId(), code: short("pc"), name: "TDS", kind: "deduction", method: "income_tax",
    rate: null, cap: null, regime, recurring: true,
  });
}

describe("Form 16 (Part B): the certificate cites only finalized withholding", () => {
  it("counts an APPROVED run's tax and ignores a DRAFT one", async () => {
    // A certificate is a statement to the tax authority about tax already deducted. A draft run has deducted
    // nothing - it is a projection somebody is still editing - so citing it would over-state the credit the
    // employee then claims in their return, against a challan that was never paid.
    await seedSetting("organization", { name: "Test Co", default_currency: "INR" });
    const emp = await seedEmployee({ code: "04-001" });
    await seedRun([{ employeeId: emp, net: 90000, gross: 100000, tax: 7000 }], "APPROVED");
    await seedRun([{ employeeId: emp, net: 90000, gross: 100000, tax: 5000 }], "DRAFT");

    const { assembleForm16 } = await import("../src/services/form16");
    const figures = form16Figures((await assembleForm16(deps, emp, "2025-26")).content);
    expect(figures["Tax deducted at source (TDS)"]).toBe("7,000"); // the approved run only
  });

  it("states a liability computed from the year's chargeable salary, and reconciles net against the TDS", async () => {
    await seedSetting("organization", { name: "Test Co", default_currency: "INR" });
    const emp = await seedEmployee({ code: "04-001" });
    // One approved run of 100,000 chargeable. Under the new regime the standard deduction is 75,000, so the
    // taxable income is 25,000 - inside the first (nil) slab, hence no liability and the whole 7,000 refunds.
    await seedRun([{ employeeId: emp, net: 93000, gross: 100000, tax: 7000 }], "APPROVED");

    const { assembleForm16 } = await import("../src/services/form16");
    const { content, financialYear, fileName } = await assembleForm16(deps, emp, "2025-26");
    const figures = form16Figures(content);
    expect(financialYear).toBe("2025-26");
    expect(fileName).toBe("Form16-2025-26-04-001.pdf");
    expect(figures["Gross salary"]).toBe("1,00,000");
    expect(figures["Less: Standard deduction u/s 16(ia)"]).toBe("75,000");
    expect(figures["Income chargeable under the head 'Salaries'"]).toBe("25,000");
    expect(figures["Total tax liability"]).toBe("0");
    expect(figures["Tax deducted at source (TDS)"]).toBe("7,000");
    expect(figures["Net tax payable / (refund)"]).toBe("-7,000"); // a refund, not a demand
  });

  it("refuses to issue a certificate under a regime the engine cannot compute", async () => {
    // The old regime needs the s.16(iii)/s.10(13A)/LTA exemptions this build does not compute. Issuing a
    // certificate that ignores them would over-state the liability on a document the employee files.
    await seedSetting("organization", { name: "Test Co", default_currency: "INR" });
    await seedTdsComponent("old");
    const emp = await seedEmployee({ code: "04-001" });
    await seedRun([{ employeeId: emp, net: 90000, gross: 100000, tax: 7000 }], "APPROVED");

    const { assembleForm16 } = await import("../src/services/form16");
    await expect(assembleForm16(deps, emp, "2025-26")).rejects.toThrow(/not implemented/);
  });

  it("will not issue one for an employee who does not exist", async () => {
    const { assembleForm16 } = await import("../src/services/form16");
    await expect(assembleForm16(deps, genId(), "2025-26")).rejects.toThrow(/employee not found/);
  });
});

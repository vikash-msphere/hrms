import * as XLSX from "xlsx";
import { and, eq, isNull } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { notFound, invalidArgument, failedPrecondition } from "../lib/errors";
import { getBankFormats, getBankTemplate, getPayrollDebit, type BankFormatColumn } from "./bankFormats";
import { getSettingValue } from "./settings";
import { decimalsFor, roundMoney, type CurrencyDecimals } from "../domain/currency";

// Build a bank's bulk-payment workbook for a payroll run: read the stored blank template and write one row
// per employee, mapping each column to its configured source. Runs server-side only (it decrypts employee
// account numbers + the employer debit account), behind the run's `bankFile` custom method.

type StoredBank = { account_name?: string; account_number?: string; ifsc_code?: string; bank_name?: string; branch?: string };

async function decryptBank(deps: Deps, enc: string | null): Promise<StoredBank> {
  if (!enc) return {};
  try {
    return JSON.parse(await deps.encryptor.decrypt(enc)) as StoredBank;
  } catch {
    return {};
  }
}

const ddmmyyyy = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;

type RunItem = typeof schema.payrollRunItems.$inferSelect;
type Employee = typeof schema.employees.$inferSelect;
type Ctx = { emp: Employee; it: RunItem; bank: StoredBank; debit: { debit_account_number?: string; currency_code?: string }; valueDate: string; sameBank: boolean; dp: number };

function cellValue(col: BankFormatColumn, c: Ctx): string | number | undefined {
  // Payout amounts are rounded to the currency's precision (whole rupees for INR by default): the money is
  // DISBURSED at this precision, so the file must carry the paid figure, not the paise-precision stored value.
  const pay = (n: number) => roundMoney(n, c.dp);
  switch (col.source) {
    case "account_name": return c.bank.account_name || `${c.emp.firstName} ${c.emp.lastName}`;
    case "account_number": return c.bank.account_number;
    case "ifsc_code": return c.bank.ifsc_code;
    case "bank_name": return c.bank.bank_name;
    case "branch": return c.bank.branch;
    case "employee_code": return c.emp.code ?? undefined;
    case "full_name": return `${c.emp.firstName} ${c.emp.lastName}`;
    case "first_name": return c.emp.firstName;
    case "last_name": return c.emp.lastName;
    case "work_email": return c.emp.workEmail;
    case "net": return pay(c.it.net);
    case "gross": return pay(c.it.gross);
    case "total_deductions": return pay(c.it.totalDeductions);
    case "tax": return pay(c.it.tax);
    case "debit_account": return c.debit.debit_account_number;
    case "currency": return c.debit.currency_code;
    case "value_date": return c.valueDate;
    case "transaction_type": return c.sameBank ? col.intra : col.inter; // within-bank vs other-banks
    case "literal": return col.value;
    case "skip": return undefined;
    default: return undefined;
  }
}

export async function buildBankFile(deps: Deps, runId: string, bank: string): Promise<{ bytes: Uint8Array; fileName: string }> {
  if (!bank) throw invalidArgument("bank query parameter is required");
  const run = (await deps.db.select().from(schema.payrollRuns).where(eq(schema.payrollRuns.uuid, runId)).limit(1))[0];
  if (!run) throw notFound("payroll run not found");
  if (run.state !== "APPROVED" && run.state !== "PUBLISHED") throw failedPrecondition("run must be approved before the bank file can be downloaded");

  const fmt = (await getBankFormats(deps))[bank];
  if (!fmt?.columns?.length) throw invalidArgument(`no format configured for ${bank}`);
  const tpl = await getBankTemplate(deps, bank);
  if (!tpl) throw invalidArgument(`no template uploaded for ${bank}`);
  const debit = (await getPayrollDebit(deps))[bank] ?? {};
  const period = (await deps.db.select().from(schema.payPeriods).where(eq(schema.payPeriods.uuid, run.payPeriodId)).limit(1))[0];
  const valueDate = ddmmyyyy(period?.payDate ?? new Date());
  // Payout precision from the disbursing currency (the debit account's, else the org default).
  const org = await getSettingValue<{ default_currency?: string; currency_decimals?: CurrencyDecimals }>(deps, "organization", {});
  const dp = decimalsFor(debit.currency_code || org.default_currency, org.currency_decimals);

  // Run items joined to their employee, ordered by employee code for a stable sheet.
  const items = await deps.db.select().from(schema.payrollRunItems).where(eq(schema.payrollRunItems.runId, runId));
  const emps = new Map((await deps.db.select().from(schema.employees)).map((e) => [e.uuid, e]));
  const ordered = items.filter((it) => emps.has(it.employeeId)).sort((a, b) => (emps.get(a.employeeId)!.code ?? "").localeCompare(emps.get(b.employeeId)!.code ?? ""));

  // A bulk-payment file must never carry a payment line with no destination account or a non-positive amount.
  // Skip zero/negative-net items (nothing to disburse), and FAIL if any payable employee has no account on
  // file: silently dropping them would underpay, and a blank-account row would be rejected or misrouted by the
  // bank. Surfacing the names lets payroll fix the details (or arrange an alternate payout) and regenerate.
  const rows: (string | number | undefined)[][] = [];
  const missingAccount: string[] = [];
  for (const it of ordered) {
    if (!(it.net > 0.005)) continue; // no payout row for a zero/negative net
    const emp = emps.get(it.employeeId)!;
    const bankDet = await decryptBank(deps, emp.bankDetailsEnc);
    if (!(bankDet.account_number ?? "").trim()) {
      missingAccount.push(`${emp.firstName} ${emp.lastName}${emp.code ? ` (${emp.code})` : ""}`);
      continue;
    }
    const sameBank = (bankDet.bank_name ?? "").trim() === bank.trim();
    rows.push(fmt.columns.map((col) => cellValue(col, { emp, it, bank: bankDet, debit, valueDate, sameBank, dp })));
  }
  if (missingAccount.length) {
    throw failedPrecondition(`${missingAccount.length} payable employee(s) have no bank account on file: ${missingAccount.slice(0, 8).join(", ")}${missingAccount.length > 8 ? ", …" : ""}. Add their bank details, then regenerate the bank file.`);
  }

  // Fill a copy of the template: write each data row from data_start_row down.
  const wb = XLSX.read(new Uint8Array(tpl), { type: "array" });
  const sheetName = fmt.sheet && wb.Sheets[fmt.sheet] ? fmt.sheet : wb.SheetNames[0]!;
  const ws = wb.Sheets[sheetName]!;
  const start0 = (fmt.data_start_row ?? 2) - 1; // 0-based first data row

  rows.forEach((row, i) => {
    fmt.columns.forEach((col, ci) => {
      const addr = XLSX.utils.encode_cell({ r: start0 + i, c: col.col - 1 });
      const v = row[ci];
      if (v === undefined || v === "") delete ws[addr];
      else ws[addr] = typeof v === "number" ? { t: "n", v } : { t: "s", v: String(v) };
    });
  });
  // Clear any leftover template sample rows below the data we wrote.
  const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
  for (let r = start0 + rows.length; r <= range.e.r; r++) {
    for (const col of fmt.columns) delete ws[XLSX.utils.encode_cell({ r, c: col.col - 1 })];
  }
  range.s = { r: 0, c: 0 };
  range.e.r = Math.max((fmt.header_row ?? 1) - 1, start0 + rows.length - 1);
  range.e.c = Math.max(range.e.c, ...fmt.columns.map((c) => c.col - 1));
  ws["!ref"] = XLSX.utils.encode_range(range);

  // Stamp the first generation. Handing the file to the bank is where the money actually leaves, and deleting
  // a run RELEASES every payable it paid back into the queue - so this stamp is what stops a delete-after-payout
  // from paying the same bonuses, encashments and claims all over again on the next run.
  if (!run.bankFileAt) {
    await deps.db.update(schema.payrollRuns).set({ bankFileAt: new Date() }).where(and(eq(schema.payrollRuns.uuid, runId), isNull(schema.payrollRuns.bankFileAt)));
  }

  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const slug = bank.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return { bytes: new Uint8Array(out), fileName: `${slug}-payroll-${run.code}.xlsx` };
}

import * as XLSX from "xlsx";
import { and, eq, inArray, isNull, isNotNull, ne } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { assertMayGenerateBankFile } from "./payroll";
import { byIdChunks, runBatch } from "../lib/dbBatch";
import { audit } from "../lib/audit";
import { notFound, invalidArgument, failedPrecondition } from "../lib/errors";
import { getBankFormats, getBankTemplate, getPayrollDebit, type BankFormatColumn } from "./bankFormats";
import { sameBankName, type BankField } from "./bankDetails";
import { checkPayouts, describePayoutFindings, type PayoutRow } from "../domain/payoutCheck";
import { getSettingValue } from "./settings";
import { decimalsFor, roundMoney, type CurrencyDecimals } from "../domain/currency";

// Build a bank's bulk-payment workbook for a payroll run: read the stored blank template and write one row
// per employee, mapping each column to its configured source. Runs server-side only (it decrypts employee
// account numbers + the employer debit account), behind the run's `bankFile` custom method.

// The stored blob's shape, from the service that WRITES it - not a third hand-written copy. This file
// declared its own, and it carried a `branch` that bank details never stored, so the `branch` column every
// bank format can be configured with resolved to `undefined` on every row: a silently blank column in a file
// the bank has already been handed, and a rejected batch wherever the branch is mandatory.
type StoredBank = Partial<Record<BankField, string>>;

async function decryptBank(deps: Deps, enc: string | null): Promise<StoredBank> {
  if (!enc) return {};
  try {
    return JSON.parse(await deps.encryptor.decrypt(enc)) as StoredBank;
  } catch {
    return {};
  }
}

/**
 * A one-way fingerprint of an account number, for comparison only.
 *
 * Normalised first - spaces and case stripped - so the same account typed two ways is one account and a
 * cosmetic edit is not reported as a change of bank. SHA-256 with no salt ON PURPOSE: the point is that the
 * SAME account gives the same answer across runs and across employees, which a per-row salt would destroy.
 * That does mean a determined holder of the hashes could confirm a guessed account number, which is why the
 * fingerprint stays inside this module and the run item, is never rendered, and never leaves in an export.
 */
async function fingerprint(accountNumber: string): Promise<string> {
  const normalised = accountNumber.replace(/\s+/g, "").toUpperCase();
  if (!normalised) return "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalised));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What the last run that PAID each of these people paid them into. Reads stored fingerprints only, so this
 *  decrypts nothing: the comparison the next run makes is against a hash written when that run's file was
 *  produced. Most recent wins where somebody appears in several. */
async function previousPayoutFingerprints(deps: Deps, runId: string, employeeIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!employeeIds.length) return out;
  const rows = await byIdChunks(employeeIds, (group) =>
    deps.db
      .select({ employeeId: schema.payrollRunItems.employeeId, hash: schema.payrollRunItems.bankAccountHash, at: schema.payrollRunItems.updatedAt })
      .from(schema.payrollRunItems)
      .where(and(inArray(schema.payrollRunItems.employeeId, group), isNotNull(schema.payrollRunItems.bankAccountHash), ne(schema.payrollRunItems.runId, runId))),
  );
  const newest = new Map<string, number>();
  for (const r of rows) {
    if (!r.hash) continue;
    const at = r.at ? +new Date(r.at) : 0;
    if (at >= (newest.get(r.employeeId) ?? -1)) { newest.set(r.employeeId, at); out.set(r.employeeId, r.hash); }
  }
  return out;
}

const ddmmyyyy = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;

type RunItem = typeof schema.payrollRunItems.$inferSelect;
// Only the columns a payment row is built from - the read below selects exactly these, so widening what a
// column source may reach for is a compile error rather than a blank cell in a file the bank has already been
// handed.
type Employee = Pick<typeof schema.employees.$inferSelect, "uuid" | "code" | "firstName" | "lastName" | "workEmail" | "bankDetailsEnc">;
type Ctx = { emp: Employee; it: RunItem; bank: StoredBank; debit: { debit_account_number?: string; currency_code?: string }; valueDate: string; sameBank: boolean; dp: number };

function cellValue(col: BankFormatColumn, c: Ctx): string | number | undefined {
  // Payout amounts are stated at the currency's precision (whole rupees for INR by default). The RUN already
  // settles each item's net to that precision with an explicit rounding line, so this is a no-op on net for a
  // run built by this system - it stays as the belt-and-braces guard for gross/tax columns and for any item
  // predating that line, and it keeps the file from ever carrying sub-paise noise.
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

export async function buildBankFile(deps: Deps, actor: AppUser | null, runId: string, bank: string, acknowledged = false): Promise<{ bytes: Uint8Array; fileName: string }> {
  if (!bank) throw invalidArgument("bank query parameter is required");
  const run = (await deps.db.select().from(schema.payrollRuns).where(eq(schema.payrollRuns.uuid, runId)).limit(1))[0];
  if (!run) throw notFound("payroll run not found");
  if (run.state !== "APPROVED" && run.state !== "PUBLISHED") throw failedPrecondition("run must be approved before the bank file can be downloaded");
  // Separation of duties on the step where the money leaves: off unless the org asks for it, and refused
  // BEFORE any of the work below, so a caller who may not do this never reaches the decrypted accounts.
  await assertMayGenerateBankFile(deps, actor, run);

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
  //
  // BY ID, and only the six columns a payment row is built from. This read used to be the whole `employees`
  // table - every column, the encrypted PII blobs included - to label the items of ONE run, so the cost of
  // producing a payment file grew with the size of the org rather than with the size of the run. It is the
  // same shape services/payroll.ts states its budget in (`byIdChunks`, only the rows named, chunked under the
  // bound-parameter cap); this was the one money path still scanning.
  const items = await deps.db.select().from(schema.payrollRunItems).where(eq(schema.payrollRunItems.runId, runId));
  const emps = new Map(
    (await byIdChunks([...new Set(items.map((it) => it.employeeId))], (group) =>
      deps.db
        .select({
          uuid: schema.employees.uuid,
          code: schema.employees.code,
          firstName: schema.employees.firstName,
          lastName: schema.employees.lastName,
          workEmail: schema.employees.workEmail,
          bankDetailsEnc: schema.employees.bankDetailsEnc,
        })
        .from(schema.employees)
        .where(inArray(schema.employees.uuid, group)),
    )).map((e) => [e.uuid, e]),
  );
  const ordered = items.filter((it) => emps.has(it.employeeId)).sort((a, b) => (emps.get(a.employeeId)!.code ?? "").localeCompare(emps.get(b.employeeId)!.code ?? ""));

  // A bulk-payment file must never carry a payment line with no destination account or a non-positive amount.
  // Skip zero/negative-net items (nothing to disburse), and FAIL if any payable employee has no account on
  // file: silently dropping them would underpay, and a blank-account row would be rejected or misrouted by the
  // bank. Surfacing the names lets payroll fix the details (or arrange an alternate payout) and regenerate.
  const rows: (string | number | undefined)[][] = [];
  const missingAccount: string[] = [];
  const payouts: PayoutRow[] = [];
  for (const it of ordered) {
    if (!(it.net > 0.005)) continue; // no payout row for a zero/negative net
    const emp = emps.get(it.employeeId)!;
    const bankDet = await decryptBank(deps, emp.bankDetailsEnc);
    if (!(bankDet.account_number ?? "").trim()) {
      missingAccount.push(`${emp.firstName} ${emp.lastName}${emp.code ? ` (${emp.code})` : ""}`);
      continue;
    }
    // THE same comparison the write gate uses (services/bankDetails.ts#sameBankName), so "the same bank" means
    // one thing in both places. It was a raw `===` on trimmed strings, which made the classification sensitive
    // to the CASE a name was stored in - and a row written before that gate existed can still differ only by
    // case. A miss falls to the format's `inter` value, which is the safe direction (an inter-bank transfer to
    // an internal account settles; the reverse can be rejected) but costs more, so getting the match right
    // matters even though getting it wrong is not dangerous.
    const sameBank = sameBankName(bankDet.bank_name, bank);
    // The FINGERPRINT of where this money is going, computed here because this is already the one place that
    // decrypts an account number - doing it in the build would add a second decryption point to get the same
    // answer. Normalised first, so the same account written with spaces or in another case is the same
    // account and a cosmetic edit does not read as a change of bank.
    payouts.push({
      employeeId: it.employeeId,
      label: `${emp.firstName} ${emp.lastName}${emp.code ? ` (${emp.code})` : ""}`,
      fingerprint: await fingerprint(bankDet.account_number ?? ""),
    });
    rows.push(fmt.columns.map((col) => cellValue(col, { emp, it, bank: bankDet, debit, valueDate, sameBank, dp })));
  }
  // THE PAYOUT CHECK, before the file exists and therefore before the money can leave.
  //
  // Both findings REFUSE by default and are overridable together, which is the shape item 24's reasoning
  // argues for: a control somebody cannot satisfy is one they route around, and an account genuinely changing
  // is an ordinary event. So this is not "no", it is "say yes on the record" - the acknowledgement is a
  // deliberate act by a named person and the audit row below carries what they were shown.
  const previous = await previousPayoutFingerprints(deps, runId, payouts.map((p) => p.employeeId));
  const findings = checkPayouts(payouts, previous);
  if (findings.length && !acknowledged) {
    const lines = describePayoutFindings(findings);
    throw failedPrecondition(
      `${lines.length} thing(s) about where this money is going need confirming: ${lines.join("; ")}. ` +
      `Check them, then generate the file again with acknowledge=1 to confirm on the record.`,
    );
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

  // Record where each payment actually went, as a fingerprint, so the NEXT run can tell whether an account
  // changed. Written after the file is built rather than before: a run that failed to produce one paid
  // nobody, and a stored fingerprint for a payment that never happened would make the next run compare
  // against a destination the money never reached.
  //
  // Best-effort. The file is already built and the run already stamped by this point, so a failure here costs
  // the NEXT run its comparison - worth a loud log and nothing more, because throwing would refuse a payout
  // file that is correct and already committed.
  try {
    await runBatch(
      deps.db,
      payouts.map((p) =>
        deps.db
          .update(schema.payrollRunItems)
          .set({ bankAccountHash: p.fingerprint })
          .where(and(eq(schema.payrollRunItems.runId, runId), eq(schema.payrollRunItems.employeeId, p.employeeId))),
      ),
    );
  } catch (err) {
    console.error("[bankFile] could not record payout fingerprints - the next run cannot compare accounts", err);
  }

  // What was confirmed, and by whom. An acknowledgement that leaves no trace is not a control, and this is
  // the row somebody reads when asking why a changed account was paid.
  if (findings.length) {
    await audit(deps, actor ?? "system", "payroll.payout_confirmed", "payroll-runs", runId, {
      bank,
      confirmed: describePayoutFindings(findings),
    });
  }

  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const slug = bank.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return { bytes: new Uint8Array(out), fileName: `${slug}-payroll-${run.code}.xlsx` };
}

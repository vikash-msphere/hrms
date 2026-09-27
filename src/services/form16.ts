// Form 16 (Part B) — the annual TDS-on-salary certificate. Assembled from ACTUALS: finalized payroll for the
// financial year (taxable gross + TDS deducted) + the employee's prior-employer declarations, with the tax
// recomputed on the year's gross via the same income-tax engine the projection uses. Rendered through the
// shared letter PDF engine (a heading + a computation table), so it gets the org letterhead for free.
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { notFound, invalidArgument, forbidden } from "../lib/errors";
import { canReadObjectCode } from "../lib/objectAccess";
import type { AppUser } from "../env";
import { getSettingValue } from "./settings";
import { documentLetterhead, documentLetterheadRef, type OrgWithDocumentLogos } from "./letterheads";
import { loadTaxConfig, fyWindow, finalizedTotals, settlementTotals, verifiedDeductions, readDeclarations, tdsComponent } from "./taxProjection";
import { computeAnnualTax, allowedDeductions, assertSupportedRegime } from "../domain/incomeTax";
import { renderLetterPdf, type LetterContent, type LetterBlock } from "../lib/letterPdf";
import { money as fmtMoney, formatLongDate } from "../lib/pdfPrimitives";
import { decimalsFor, type CurrencyDecimals } from "../domain/currency";
import { refPayComponents } from "../lib/refData";
import { orgToday, dayStartMs } from "./orgDay";

const r0 = (n: number) => Math.round(n);
// "2026-08" -> "August 2026".
const monthLabel = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

// A financial year for an FY label like "2025-26" (the window helper keys off any date inside the year).
function fyForLabel(label?: string) {
  if (!label) return fyWindow(new Date());
  const m = /^(\d{4})-(\d{2})$/.exec(label.trim());
  if (!m) throw invalidArgument('financial_year must look like "2025-26"');
  return fyWindow(new Date(Date.UTC(Number(m[1]), 5, 1))); // June of the start year is inside that FY
}

/**
 * Build a Form 16 for `employeeId`. `viewer` is the caller it is built FOR, and the check below is the whole
 * reason it is a parameter.
 *
 * A Form 16 is the year's gross salary and the tax deducted from it - the same figures a payslip carries,
 * annualised. This took no actor and made no access decision, while the verb that reaches it
 * (`personal-documents:generateForm16`) is covered by the `personal-documents.**` an hr_admin holds and the
 * seeded hr_admin grant holds no `payslips` entry at all. Unlike a letter there is no partial answer to give:
 * the pay figures ARE the document, so a caller who may not read this person's payslips is refused rather than
 * handed a narrowed one. Omitting `viewer` is for the paths with no principal to decide against (cron, a
 * system-assembled batch), not a way around the check.
 */
export async function assembleForm16(deps: Deps, employeeId: string, financialYear?: string, viewer?: AppUser) {
  const emp = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
  if (!emp || emp.deleteTime) throw notFound("employee not found");
  // Decided against the EMPLOYEE's code, the scoping key their payslips hang off: `payslips.me.**` matches a
  // person's own certificate, `payslips.**` (payroll_admin, super) matches anyone's.
  if (viewer && !(await canReadObjectCode(deps, viewer, "payslips", emp.code))) {
    throw forbidden("a Form 16 states this employee's salary and tax deducted; you don't have access to their pay records");
  }

  const org = await getSettingValue<{ name?: string; legal_name?: string; address?: string; logo?: string; default_currency?: string; currency_decimals?: CurrencyDecimals } & OrgWithDocumentLogos>(deps, "organization", {});
  const letterheadRef = documentLetterheadRef(org, "form16");
  const letterhead = await documentLetterhead(deps, org, "form16");
  // Figures render in the org currency's precision (whole rupees for INR by default).
  const money = (n: number) => fmtMoney(n, decimalsFor(org.default_currency, org.currency_decimals));
  const cfg = await loadTaxConfig(deps);
  const components = await refPayComponents(deps);
  const regime = tdsComponent(components)?.regime ?? "new";
  // Same gate the withholding path applies: a certificate computed under an unimplemented regime would state a
  // liability the exemptions it ignores would have reduced.
  assertSupportedRegime(regime);
  const regimeCfg = cfg.regimes[regime] ?? cfg.regimes.new!;
  const fy = fyForLabel(financialYear);

  // Includes pay and tax from before HRMS ran payroll this year (a payroll opening), stated below.
  const totals = (await finalizedTotals(deps, fy, undefined, employeeId)).get(employeeId) ?? { gross: 0, taxableGross: 0, tax: 0, months: 0, opening: undefined };
  const decl = await readDeclarations(deps, emp.taxDetailsEnc);
  const prior = Math.max(0, decl.priorEmployerIncome ?? 0);
  // Bounded by the prior income it was withheld from, the same ceiling the withholding projection applies
  // (assembleProjection): tax deducted cannot exceed the pay it came out of, and an unbounded figure here would
  // put a credit on the certificate that the payslips never gave.
  const priorTds = Math.min(Math.max(0, decl.priorEmployerTds ?? 0), prior);
  // A leaver's full-and-final settlement is salary income paid outside any payroll run - final-month salary,
  // leave encashment, bonuses, arrears - and it withholds its own TDS. Without it the certificate would omit the
  // year's largest single payment and under-report the tax deducted on it.
  const settled = await settlementTotals(deps, fy, employeeId);
  // Chapter VI-A the regime allows, from the employee's VERIFIED declarations - the same figure that reduced
  // withholding through the year, so the certificate reconciles with the payslips.
  const deductions = allowedDeductions(await verifiedDeductions(deps, employeeId, fy.financialYear), regimeCfg);

  const grossSalary = r0(totals.taxableGross + settled.taxableGross + prior);
  const b = computeAnnualTax(grossSalary, regimeCfg, deductions.total);
  const tdsDeducted = r0(totals.tax + settled.tax + priorTds);
  const net = r0(b.totalTax - tdsDeducted);

  const rows: string[][] = [
    ["Gross salary", money(grossSalary)],
    ["Less: Standard deduction u/s 16(ia)", money(b.standardDeduction)],
  ];
  for (const d of deductions.rows) if (d.allowed > 0) rows.push([`Less: Deduction u/s ${d.section}`, money(d.allowed)]);
  rows.push(
    ["Income chargeable under the head 'Salaries'", money(b.taxableIncome)],
    ["Tax on total income", money(b.incomeTax)],
  );
  if (b.rebate > 0) rows.push(["Less: Rebate u/s 87A", money(b.rebate)]);
  if (b.surcharge > 0) rows.push(["Surcharge", money(b.surcharge)]);
  rows.push(["Health & education cess (4%)", money(b.cess)]);
  rows.push(["Total tax liability", money(b.totalTax)]);
  rows.push(["Tax deducted at source (TDS)", money(tdsDeducted)]);

  const blocks: LetterBlock[] = [
    { kind: "para", runs: ["Certificate under Section 203 of the Income-tax Act, 1961 for tax deducted at source on salary — Part B."] },
    { kind: "para", runs: [`Financial year ${fy.financialYear} · Assessment year ${fy.assessmentYear} · ${regimeCfg.label}.`] },
    { kind: "table", table: { title: "Computation of tax", columns: ["Particulars", "Amount"], rows, total: ["Net tax payable / (refund)", money(net)] } },
  ];
  if (totals.opening && (totals.opening.taxableGross > 0 || totals.opening.tax > 0)) {
    blocks.push({ kind: "para", runs: [`Includes ${money(totals.opening.taxableGross)} of salary paid by this employer through ${monthLabel(totals.opening.paidThrough)}, before its payroll moved to this system (TDS ${money(totals.opening.tax)}).`] });
  }
  if (prior > 0) blocks.push({ kind: "para", runs: [`Includes ${money(prior)} of salary from a previous employer (TDS ${money(priorTds)}).`] });
  if (settled.taxableGross > 0) blocks.push({ kind: "para", runs: [`Includes ${money(settled.taxableGross)} of chargeable full & final settlement pay (TDS ${money(settled.tax)}).`] });
  blocks.push({ kind: "para", runs: [`System-generated Part B summary under the ${regimeCfg.label.toLowerCase()} from finalized payroll and settlements for the year. Please verify against Form 26AS / AIS before filing.`] });

  const content: LetterContent = {
    org: { name: org.name ?? "", address: org.address, logo: org.logo, legalName: org.legal_name || undefined },
    ...(letterhead ? { letterhead } : {}),
    ...(letterheadRef ? { letterheadRef } : {}),
    // The org's calendar day, not the UTC one. This date is on a STATUTORY tax certificate the employee files
    // with their return, so "issued yesterday" for the first hours of an IST morning is not cosmetic. See
    // services/orgDay.ts, and services/letterSign.ts for the same fix on the signature block.
    date: formatLongDate(new Date(dayStartMs(await orgToday(deps)))),
    ref: `Form No. 16 · Part B · FY ${fy.financialYear}`,
    to: { name: `${emp.firstName} ${emp.lastName}`, lines: [emp.code ? `Employee code: ${emp.code}` : "", emp.jobTitle ?? ""].filter(Boolean) },
    blocks,
  };

  const { bytes: pdf } = await renderLetterPdf(content);
  // `content` goes back with the PDF so the caller can freeze it: a filed Form 16 is re-renderable on the
  // letterhead's print page exactly like a letter (services/letterPrint.ts).
  return { pdf, content, title: `Form 16 (Part B) — FY ${fy.financialYear}`, fileName: `Form16-${fy.financialYear}-${emp.code ?? employeeId}.pdf`, financialYear: fy.financialYear };
}

// Form 16 (Part B) — the annual TDS-on-salary certificate. Assembled from ACTUALS: finalized payroll for the
// financial year (taxable gross + TDS deducted) + the employee's prior-employer declarations, with the tax
// recomputed on the year's gross via the same income-tax engine the projection uses. Rendered through the
// shared letter PDF engine (a heading + a computation table), so it gets the org letterhead for free.
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { notFound, invalidArgument } from "../lib/errors";
import { getSettingValue } from "./settings";
import { loadTaxConfig, fyWindow, finalizedTotals, readDeclarations, tdsComponent } from "./taxProjection";
import { computeAnnualTax } from "../domain/incomeTax";
import { renderLetterPdf, type LetterContent, type LetterBlock } from "../lib/letterPdf";
import { money as fmtMoney, formatLongDate } from "../lib/pdfPrimitives";
import { decimalsFor, type CurrencyDecimals } from "../domain/currency";

const r0 = (n: number) => Math.round(n);

// A financial year for an FY label like "2025-26" (the window helper keys off any date inside the year).
function fyForLabel(label?: string) {
  if (!label) return fyWindow(new Date());
  const m = /^(\d{4})-(\d{2})$/.exec(label.trim());
  if (!m) throw invalidArgument('financial_year must look like "2025-26"');
  return fyWindow(new Date(Date.UTC(Number(m[1]), 5, 1))); // June of the start year is inside that FY
}

export async function assembleForm16(deps: Deps, employeeId: string, financialYear?: string) {
  const emp = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
  if (!emp || emp.deleteTime) throw notFound("employee not found");

  const org = await getSettingValue<{ name?: string; address?: string; logo?: string; default_currency?: string; currency_decimals?: CurrencyDecimals }>(deps, "organization", {});
  // Figures render in the org currency's precision (whole rupees for INR by default).
  const money = (n: number) => fmtMoney(n, decimalsFor(org.default_currency, org.currency_decimals));
  const cfg = await loadTaxConfig(deps);
  const components = await deps.db.select().from(schema.payComponents);
  const regime = tdsComponent(components)?.regime ?? "new";
  const regimeCfg = cfg.regimes[regime] ?? cfg.regimes.new!;
  const fy = fyForLabel(financialYear);

  const totals = (await finalizedTotals(deps, fy)).get(employeeId) ?? { gross: 0, taxableGross: 0, tax: 0, months: 0 };
  const decl = await readDeclarations(deps, emp.taxDetailsEnc);
  const prior = decl.priorEmployerIncome ?? 0;
  const priorTds = decl.priorEmployerTds ?? 0;

  const grossSalary = r0(totals.taxableGross + prior);
  const b = computeAnnualTax(grossSalary, regimeCfg);
  const tdsDeducted = r0(totals.tax + priorTds);
  const net = r0(b.totalTax - tdsDeducted);

  const rows: string[][] = [
    ["Gross salary", money(grossSalary)],
    ["Less: Standard deduction u/s 16(ia)", money(b.standardDeduction)],
    ["Income chargeable under the head 'Salaries'", money(b.taxableIncome)],
    ["Tax on total income", money(b.incomeTax)],
  ];
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
  if (prior > 0) blocks.push({ kind: "para", runs: [`Includes ${money(prior)} of salary from a previous employer (TDS ${money(priorTds)}).`] });
  blocks.push({ kind: "para", runs: ["System-generated Part B summary under the new tax regime from finalized payroll for the year. Please verify against Form 26AS / AIS before filing."] });

  const content: LetterContent = {
    org: { name: org.name ?? "", address: org.address, logo: org.logo },
    date: formatLongDate(new Date()),
    ref: `Form No. 16 · Part B · FY ${fy.financialYear}`,
    to: { name: `${emp.firstName} ${emp.lastName}`, lines: [emp.code ? `Employee code: ${emp.code}` : "", emp.jobTitle ?? ""].filter(Boolean) },
    blocks,
  };

  const { bytes: pdf } = await renderLetterPdf(content);
  return { pdf, title: `Form 16 (Part B) — FY ${fy.financialYear}`, fileName: `Form16-${fy.financialYear}-${emp.code ?? employeeId}.pdf`, financialYear: fy.financialYear };
}

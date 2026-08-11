import { Hono } from "hono";
import type { AppEnv } from "../env";
import { renderPayslipPdf, type PayslipData } from "../lib/pdf";
import { parsePayslipTemplate, payslipTemplateOrDefault } from "../domain/payslipTemplate";
import { getSettingValue } from "../services/settings";
import { decimalsFor, type CurrencyDecimals } from "../domain/currency";
import { invalidArgument } from "../lib/errors";

// Collection-level custom method `payslips:previewTemplate` - render a payslip DESIGN against representative
// SAMPLE figures and return the PDF, persisting nothing. This backs the live preview in the Settings payslip-
// design editor, so an unsaved draft can be seen before it is saved (the same role generateLetter/previewLetter
// plays for letter templates). Sample data (not a real employee's pay) keeps the editor usable with zero
// payroll runs and means designing a layout never exposes anyone's actual salary.
// With no body, the SAVED design is rendered. Real numbers from a real run are previewed by
// `payroll-runs/<id>:previewPayslip` instead.
// The renderer only honours a closed vocabulary of block kinds, so an arbitrary inline template can't do
// anything unsafe; parsePayslipTemplate rejects everything else with a message naming the block.

// Representative figures: enough lines to show both money columns, a round CTC, whole-rupee friendly.
function sampleData(orgName: string, address: string | undefined, logo: string | undefined, currencyCode: string, decimals: number): PayslipData {
  const lines = [
    { name: "Basic", kind: "earning" as const, amount: 40000 },
    { name: "House Rent Allowance", kind: "earning" as const, amount: 16000 },
    { name: "Conveyance Allowance", kind: "earning" as const, amount: 1600 },
    { name: "Special Allowance", kind: "earning" as const, amount: 22400 },
    { name: "Employee PF", kind: "deduction" as const, amount: 1800 },
    { name: "Professional Tax", kind: "deduction" as const, amount: 200 },
    { name: "TDS", kind: "deduction" as const, amount: 6500 },
  ];
  // Employer contributions, with one line deliberately over and above CTC, so the design's employerCost block
  // shows both states (in-CTC rows + the CTC total, then the over-and-above row + the all-in total).
  const employerLines = [
    { name: "Employer ESI", amount: 2600 },
    { name: "Gratuity", amount: 1924 },
    { name: "Employer PF", amount: 1800, aboveCtc: true },
  ];
  const gross = lines.filter((l) => l.kind === "earning").reduce((s, l) => s + l.amount, 0);
  const totalDeductions = lines.filter((l) => l.kind === "deduction").reduce((s, l) => s + l.amount, 0);
  return {
    org: { name: orgName, address, logo },
    periodLabel: "Sample Month",
    currencyCode,
    employee: { name: "A. Sample Employee", designation: "Software Engineer", empNo: "EMP-0042", department: "Engineering" },
    payment: { mode: "Bank Transfer", bankName: "Sample Bank", ifsc: "SMPL0000123", accountMasked: "•••• 4242" },
    attendance: { actualDays: 21, workingDays: 22, lopDays: 1, daysPayable: 21 },
    lines,
    employerLines,
    gross,
    totalDeductions,
    net: gross - totalDeductions,
    decimals,
  };
}

export const payslipTemplatePreview = new Hono<AppEnv>().post("/", async (c) => {
  const deps = c.get("deps");
  const body = (await c.req.json().catch(() => ({}))) as { template?: unknown };
  let template;
  if (body.template != null) {
    try {
      template = parsePayslipTemplate(body.template);
    } catch (e) {
      throw invalidArgument(`payslip design: ${(e as Error).message}`);
    }
  } else {
    template = payslipTemplateOrDefault(await getSettingValue<unknown>(deps, "payslip", null));
  }

  // Branding and currency precision come from the real org settings, so the preview matches what will print.
  const org = await getSettingValue<{ name?: string; logo?: string; address?: string; default_currency?: string; currency_decimals?: CurrencyDecimals }>(deps, "organization", {});
  const currencyCode = org.default_currency || "INR";
  const data = sampleData(org.name || "", org.address, org.logo, currencyCode, decimalsFor(currencyCode, org.currency_decimals));

  const pdf = await renderPayslipPdf(data, template);
  const body_ = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer;
  return c.body(body_, 200, { "Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="payslip-design-preview.pdf"' });
});

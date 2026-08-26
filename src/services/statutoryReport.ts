import * as XLSX from "xlsx";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { notFound, failedPrecondition } from "../lib/errors";
import { esiEmployerContribution } from "../domain/statutory";
import { round2 } from "../domain/money";
import { readIdentityValues } from "./identityDetails";
import { refPayComponents } from "../lib/refData";

// Statutory compliance report for a payroll run: the PF / ESI / PT / TDS contributions to remit, per employee
// + totals, as a multi-sheet .xlsx. Derived from the finalized run's stored line items (EPF/ESI/PT lines, the
// employer's own contribution lines + the item's TDS), with the PF employer split (EPS 8.33% capped at the
// ₹15,000 wage, balance to employer EPF) computed here and EDLI / administration charges taken from the run.
// Per-employee UAN / PAN / ESI-IP come from the encrypted identity fields, so the PF ECR text below is a real
// EPFO upload; the 24Q return itself is still out of scope (this is the contribution register, not an FVU file).
type Line = { code: string; name: string; kind: string; amount: number; taxable?: boolean; units?: number; basis?: number };
const r0 = (n: number) => Math.round(n);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const lineAmt = (lines: Line[], code: string) => sum(lines.filter((l) => l.code === code).map((l) => l.amount));
// The wage a statutory line was priced on, as the run recorded it. Reverse-deriving it from the contribution
// (amount / rate) returns the CEILING whenever one applied, and for ESI it divides a figure already rounded up
// to the rupee - both of which put a wrong wage on a remittance return. `fallback` covers a stored item that
// predates the recorded basis.
const lineBasis = (lines: Line[], code: string, fallback: number) => {
  const l = lines.find((x) => x.code === code);
  return l?.basis != null ? r0(l.basis) : fallback;
};

type Row = {
  code: string; name: string; pan: string; uan: string; esiIp: string;
  gross: number; taxable: number; ncpDays: number; esiDays: number;
  epf: number; epfWages: number; eps: number; erEpf: number; edli: number; pfAdmin: number;
  esi: number; esiWages: number; erEsi: number; pt: number; tds: number;
};

// Shared assembly: the run + period + per-employee statutory figures (with decrypted UAN/PAN/ESI-IP), feeding
// both the .xlsx register and the PF ECR text.
async function collect(deps: Deps, runId: string) {
  const run = (await deps.db.select().from(schema.payrollRuns).where(eq(schema.payrollRuns.uuid, runId)).limit(1))[0];
  if (!run) throw notFound("payroll run not found");
  const items = await deps.db.select().from(schema.payrollRunItems).where(eq(schema.payrollRunItems.runId, runId));
  if (!items.length) throw failedPrecondition("build the run first");

  const employees = new Map((await deps.db.select().from(schema.employees)).map((e) => [e.uuid, e]));
  const components = await refPayComponents(deps);
  const epfRate = components.find((c) => c.method === "epf" && c.kind === "deduction")?.rate ?? 12;
  const esiRate = components.find((c) => c.method === "esi" && c.kind === "deduction")?.rate ?? 0.75;
  // Employer ESI rate is data: the employer_contribution ESI component (defaults to the statutory 3.25%).
  const erEsiRate = components.find((c) => c.method === "esi" && c.kind === "employer_contribution")?.rate ?? 3.25;
  const period = run.payPeriodId ? (await deps.db.select().from(schema.payPeriods).where(eq(schema.payPeriods.uuid, run.payPeriodId)).limit(1))[0] : undefined;
  const periodLabel = period?.label ?? (period ? `${new Date(period.periodStart).toISOString().slice(0, 10)} – ${new Date(period.periodEnd).toISOString().slice(0, 10)}` : "");
  const periodDays = period ? Math.round((+new Date(period.periodEnd) - +new Date(period.periodStart)) / 86400000) + 1 : 30;

  const rows: Row[] = [];
  for (const it of items) {
    const e = employees.get(it.employeeId);
    const lines = JSON.parse(it.linesJson || "[]") as Line[];
    const ids = e ? await readIdentityValues(deps, e) : {};
    const epf = lineAmt(lines, "EPF");
    const esi = lineAmt(lines, "ESI");
    const pt = lineAmt(lines, "PT");
    const tds = it.tax ?? lineAmt(lines, "TDS");
    const epfWages = epf > 0 ? lineBasis(lines, "EPF", r0(epf / (epfRate / 100))) : 0;
    // EPS: 8.33% of the pension wage, carved out of the employer's share. Skipped for an employee HR has
    // declared EPS-excluded (they first joined EPF above the pension wage), whose whole employer share stays
    // in EPF instead.
    const eps = epf > 0 && !e?.epsExcluded ? r0(0.0833 * Math.min(epfWages, 15000)) : 0;
    // The employer's PF share as the RUN computed it (its own component's rate/ceiling), falling back to matching
    // the employee share for runs built before employer lines were carried. Whether the org counts it inside CTC
    // is a compensation question and changes nothing here - the whole share is remitted either way.
    const erEpfTotal = lineAmt(lines, "ER_EPF") || epf;
    const erEpf = erEpfTotal > 0 ? Math.max(0, r0(erEpfTotal - eps)) : 0; // balance after the EPS slice
    // The employer's two PF side-charges, as the run priced them (EDLI 0.5% + administration 0.5% of PF wages by
    // default). Part of the PF challan and of the real cost of employing someone, so the register states them.
    const edli = r0(lineAmt(lines, "ER_EDLI"));
    const pfAdmin = r0(lineAmt(lines, "ER_PF_ADMIN"));
    const esiWages = esi > 0 ? lineBasis(lines, "ESI", r0(esi / (esiRate / 100))) : 0;
    // Eligibility already proven by the employee ESI line; gate with Infinity so the ceil-inflated reverse wage
    // can't falsely drop a near-ceiling worker. Shared domain fn => same up-to-rupee rounding everywhere.
    const erEsi = lineAmt(lines, "ER_ESI") || (esi > 0 ? esiEmployerContribution(esiWages, erEsiRate, Infinity) : 0);
    // Non-contributing-period (LOP) days, summed over EVERY loss-of-pay line (a run can carry both an
    // automatic and a manually keyed one) from the day-units each line records. The label is display text and
    // a manual line does not carry the "(Xd)" shape at all, so parsing it reported zero NCP days.
    const ncpDays = round2(sum(lines.filter((l) => l.code === "LOP").map((l) => l.units ?? 0)));
    rows.push({
      code: e?.code ?? "", name: e ? `${e.firstName} ${e.lastName}` : it.employeeId,
      pan: ids.pan ?? "", uan: ids.uan ?? "", esiIp: ids.esi_ip ?? ids.esi ?? ids.ip ?? "",
      gross: r0(it.gross), taxable: r0((it as { taxableGross?: number }).taxableGross ?? it.gross),
      ncpDays, esiDays: Math.max(0, Math.round(periodDays - ncpDays)),
      epf, epfWages, eps, erEpf, edli, pfAdmin, esi, esiWages, erEsi, pt, tds,
    });
  }
  rows.sort((a, b) => a.code.localeCompare(b.code) || a.name.localeCompare(b.name));
  return { run, periodLabel, epfRate, esiRate, erEsiRate, rows };
}

export async function buildStatutoryReport(deps: Deps, runId: string): Promise<{ bytes: Uint8Array; fileName: string }> {
  const { run, periodLabel, epfRate, esiRate, erEsiRate, rows } = await collect(deps, runId);

  const wb = XLSX.utils.book_new();
  const addSheet = (name: string, aoa: (string | number)[][]) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);

  const pfRows = rows.filter((r) => r.epf > 0);
  const esiRows = rows.filter((r) => r.esi > 0);
  const ptRows = rows.filter((r) => r.pt > 0);
  const tdsRows = rows.filter((r) => r.tds > 0);

  addSheet("Summary", [
    ["Statutory report", "", ""],
    ["Run", run.code ?? "", ""],
    ["Period", periodLabel, ""],
    [],
    ["Head", "Employees", "Employee", "Employer", "Total"],
    ["Provident Fund (EPF/EPS)", pfRows.length, sum(pfRows.map((r) => r.epf)), sum(pfRows.map((r) => r.eps + r.erEpf)), sum(pfRows.map((r) => r.epf + r.eps + r.erEpf))],
    // EDLI + administration charges are employer-only heads on the same challan, so they are their own rows
    // rather than being folded into the PF employer share.
    ["EDLI charges", pfRows.filter((r) => r.edli > 0).length, 0, sum(pfRows.map((r) => r.edli)), sum(pfRows.map((r) => r.edli))],
    ["PF administration charges", pfRows.filter((r) => r.pfAdmin > 0).length, 0, sum(pfRows.map((r) => r.pfAdmin)), sum(pfRows.map((r) => r.pfAdmin))],
    ["ESI", esiRows.length, sum(esiRows.map((r) => r.esi)), sum(esiRows.map((r) => r.erEsi)), sum(esiRows.map((r) => r.esi + r.erEsi))],
    ["Professional Tax", ptRows.length, sum(ptRows.map((r) => r.pt)), 0, sum(ptRows.map((r) => r.pt))],
    ["TDS (income tax)", tdsRows.length, sum(tdsRows.map((r) => r.tds)), 0, sum(tdsRows.map((r) => r.tds))],
  ]);
  const pfTotal = (r: Row) => r.epf + r.eps + r.erEpf + r.edli + r.pfAdmin;
  addSheet("PF", [
    ["UAN", "Code", "Employee", "Gross wages", "EPF wages", `EE (${epfRate}%)`, "EPS (8.33%)", "ER-EPF", "EDLI", "Admin", "NCP days", "Total"],
    ...pfRows.map((r) => [r.uan, r.code, r.name, r.gross, r.epfWages, r.epf, r.eps, r.erEpf, r.edli, r.pfAdmin, r.ncpDays, pfTotal(r)]),
    ["", "", "Total", sum(pfRows.map((r) => r.gross)), sum(pfRows.map((r) => r.epfWages)), sum(pfRows.map((r) => r.epf)), sum(pfRows.map((r) => r.eps)), sum(pfRows.map((r) => r.erEpf)), sum(pfRows.map((r) => r.edli)), sum(pfRows.map((r) => r.pfAdmin)), "", sum(pfRows.map(pfTotal))],
  ]);
  addSheet("ESI", [
    ["IP number", "Code", "Employee", "ESI wages", "Days", `EE (${esiRate}%)`, `ER (${erEsiRate}%)`, "Total"],
    ...esiRows.map((r) => [r.esiIp, r.code, r.name, r.esiWages, r.esiDays, r.esi, r.erEsi, r.esi + r.erEsi]),
    ["", "", "Total", sum(esiRows.map((r) => r.esiWages)), "", sum(esiRows.map((r) => r.esi)), sum(esiRows.map((r) => r.erEsi)), sum(esiRows.map((r) => r.esi + r.erEsi))],
  ]);
  addSheet("PT", [
    ["Code", "Employee", "Professional Tax"],
    ...ptRows.map((r) => [r.code, r.name, r.pt]),
    ["", "Total", sum(ptRows.map((r) => r.pt))],
  ]);
  addSheet("TDS", [
    ["PAN", "Code", "Employee", "Taxable gross", "TDS"],
    ...tdsRows.map((r) => [r.pan, r.code, r.name, r.taxable, r.tds]),
    ["", "", "Total", sum(tdsRows.map((r) => r.taxable)), sum(tdsRows.map((r) => r.tds))],
  ]);

  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return { bytes: new Uint8Array(out), fileName: `statutory-${run.code ?? runId}.xlsx` };
}

// PF ECR (Electronic Challan-cum-Return) text file: one #~#-delimited line per EPF member, the EPFO upload
// format. Fields: UAN, member name, gross wages, EPF wages, EPS wages, EDLI wages, EE EPF, EPS, ER EPF
// (diff), NCP days, refund of advances. Whole rupees. Members with no UAN are still listed (UAN left blank).
export async function buildPfEcr(deps: Deps, runId: string): Promise<{ text: string; fileName: string }> {
  const { run, rows } = await collect(deps, runId);
  const lines = rows
    .filter((r) => r.epf > 0)
    .map((r) => {
      const epsWages = Math.min(r.epfWages, 15000);
      return [r.uan, r.name, r.gross, r.epfWages, epsWages, epsWages, r.epf, r.eps, r.erEpf, r.ncpDays, 0].join("#~#");
    });
  return { text: lines.join("\n") + "\n", fileName: `ECR-${run.code ?? runId}.txt` };
}

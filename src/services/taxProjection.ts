// Assembles the inputs for the pure income-tax calc (src/domain/incomeTax.ts) from DB state, shared by the
// employee Tax page and the payroll build. Annual income for the FY = gross already paid (finalized runs)
// + the current run (build only) + projected remaining months at the current recurring rate + prior-employer
// income; tax is computed once for the year, and the balance (annual tax - already deducted) is spread over
// the remaining months. Pure date/assembly here; the slab math lives in the domain module.
import { and, eq, isNull } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { getSettingValue } from "./settings";
import { applyStructure } from "../domain/payroll";
import { round2 } from "../domain/money";
import { structureLinesById } from "./salaryStructures";
import { DEFAULT_TAX_CONFIG, computeAnnualTax, monthlyTds, type TaxConfig, type RegimeConfig, type TaxBreakdown } from "../domain/incomeTax";

// The stored (encrypted) tax-details blob. Prior-employer income/TDS are employee-DECLARED; HR/payroll then
// VERIFY (accepting the declared figure or an override) before they may affect withholding. `priorEmployerIncome`
// /`priorEmployerTds` hold the declared figures; `verifiedIncome`/`verifiedTds` the accepted ones.
export type TaxDeclarations = {
  assessmentYear?: string;
  priorEmployerIncome?: number;
  priorEmployerTds?: number;
  status?: "DECLARED" | "VERIFIED" | "REJECTED";
  verifiedIncome?: number;
  verifiedTds?: number;
  decidedBy?: string;
  decidedAt?: string;
};
type PayComp = typeof schema.payComponents.$inferSelect;

// The RAW stored blob (declared + verification state). Missing/unreadable -> empty. For the Tax page view and
// as the base the verify/declare writes merge onto.
export async function readRawTaxDetails(deps: Deps, enc: string | null): Promise<TaxDeclarations> {
  if (!enc) return {};
  try {
    return JSON.parse(await deps.encryptor.decrypt(enc)) as TaxDeclarations;
  } catch {
    return {};
  }
}

// The PROJECTION view of prior-employer figures: only HR/payroll-VERIFIED figures feed withholding. A declared
// -but-unverified (or rejected) figure has zero effect until verified. Single gate for the Tax page and the
// payroll build (both compute TDS through assembleProjection with this decl).
export async function readDeclarations(deps: Deps, enc: string | null): Promise<TaxDeclarations> {
  const raw = await readRawTaxDetails(deps, enc);
  const verified = raw.status === "VERIFIED";
  return {
    assessmentYear: raw.assessmentYear,
    priorEmployerIncome: verified ? raw.verifiedIncome ?? 0 : 0,
    priorEmployerTds: verified ? raw.verifiedTds ?? 0 : 0,
  };
}

export async function loadTaxConfig(deps: Deps): Promise<TaxConfig> {
  return getSettingValue<TaxConfig>(deps, "tax-config", DEFAULT_TAX_CONFIG);
}

// The single enabled TDS deduction component's regime, or undefined if TDS isn't configured (then no TDS).
export function tdsComponent(components: PayComp[]): PayComp | undefined {
  return components.find((c) => c.method === "income_tax" && !c.disabled && !c.deleteTime);
}

const firstOfMonthUTC = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

// India financial year (1 Apr - 31 Mar) containing `asOf`, with FY + AY labels.
export function fyWindow(asOf: Date) {
  const y = asOf.getUTCFullYear();
  const sy = asOf.getUTCMonth() >= 3 ? y : y - 1; // Apr = month 3
  const start = new Date(Date.UTC(sy, 3, 1));
  const end = new Date(Date.UTC(sy + 1, 2, 31, 23, 59, 59, 999));
  const yy = (n: number) => String(n % 100).padStart(2, "0");
  return { start, end, financialYear: `${sy}-${yy(sy + 1)}`, assessmentYear: `${sy + 1}-${yy(sy + 2)}` };
}

// Monthly recurring GROSS = basic + recurring earning components + the Special Allowance plug of a top-down
// (CTC-in) row (income_tax/deduction/rate_qty add nothing). The plug is a taxable earning, so it belongs in
// gross. Employer PF is CTC-only (on top of gross), so it rightly never enters the taxable gross here.
export function monthlyRecurringGross(basePay: number, components: PayComp[], specialAllowance = 0): number {
  let g = basePay + specialAllowance;
  for (const c of components) {
    if (c.disabled || c.deleteTime || !c.recurring || c.kind !== "earning") continue;
    g += c.method === "fixed" ? (c.rate ?? 0) : c.method === "percent_base" ? basePay * ((c.rate ?? 0) / 100) : 0;
  }
  return round2(g);
}

// Whole months the employee is employed within the FY (join month .. leaving month, else March), clamped 0..12.
// `endDate` matters as much as the start: projecting a leaver's income to March inflates the year's total, and
// the whole inflated liability is then spread over their few remaining months - the final payslips withhold
// TDS on salary the employee will never earn, refundable only at ITR.
export function employedMonthsInFy(startDate: Date | null, fy: { start: Date; end: Date }, endDate?: Date | null): number {
  const empStart = startDate && startDate > fy.start ? firstOfMonthUTC(startDate) : fy.start;
  const empEnd = endDate && endDate < fy.end ? endDate : fy.end;
  if (empStart > fy.end || empEnd < fy.start || empStart > empEnd) return 0;
  const months = (empEnd.getUTCFullYear() - empStart.getUTCFullYear()) * 12 + (empEnd.getUTCMonth() - empStart.getUTCMonth()) + 1;
  return Math.max(0, Math.min(12, months));
}

const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

// CALENDAR months still available to collect TDS in: from `from` (today on the read-only page; the run's pay
// month during a build - that month itself counts, it's being collected now) through the FY end, clamped to the
// employment window and skipping months a finalized run already paid. This is deliberately different from
// "employed - paid" months: if payroll skipped months (or hasn't started yet), those past months are gone -
// the balance must be spread over the months actually left on the calendar.
export function collectibleMonths(from: Date, startDate: Date | null, fy: { start: Date; end: Date }, paidMonths: ReadonlySet<string>): number {
  let cur = firstOfMonthUTC(from < fy.start ? fy.start : from);
  if (startDate && startDate > cur) cur = firstOfMonthUTC(startDate);
  let n = 0;
  while (cur <= fy.end) {
    if (!paidMonths.has(monthKey(cur))) n++;
    cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
  }
  return n;
}

// Per-employee aggregates of FINALIZED (APPROVED/PUBLISHED) run-items whose pay date falls in the FY.
export async function finalizedTotals(deps: Deps, fy: { start: Date; end: Date }, excludeRunId?: string) {
  const periods = new Map((await deps.db.select().from(schema.payPeriods)).map((p) => [p.uuid, p]));
  const runs = await deps.db.select().from(schema.payrollRuns);
  const inFy = (d: Date) => d >= fy.start && d <= fy.end;
  const runIds = new Set(
    runs
      .filter((r) => (r.state === "APPROVED" || r.state === "PUBLISHED") && r.uuid !== excludeRunId)
      .filter((r) => { const p = periods.get(r.payPeriodId); return !!p && inFy(p.payDate); })
      .map((r) => r.uuid),
  );
  // Pay-date month per finalized run, so callers can tell WHICH calendar months are already collected
  // (feeds collectibleMonths), not just how many.
  const runMonth = new Map<string, string>();
  for (const r of runs) {
    if (!runIds.has(r.uuid)) continue;
    const p = periods.get(r.payPeriodId);
    if (p) runMonth.set(r.uuid, monthKey(p.payDate));
  }
  const out = new Map<string, { gross: number; taxableGross: number; tax: number; months: number; paidMonths: Set<string> }>();
  if (!runIds.size) return out;
  for (const it of await deps.db.select().from(schema.payrollRunItems)) {
    if (!runIds.has(it.runId)) continue;
    const cur = out.get(it.employeeId) ?? { gross: 0, taxableGross: 0, tax: 0, months: 0, paidMonths: new Set<string>() };
    cur.gross += it.gross;
    cur.taxableGross += it.taxableGross ?? it.gross; // taxable base excludes non-taxable lines (e.g. reimbursements)
    cur.tax += it.tax;
    cur.months += 1;
    const mk = runMonth.get(it.runId);
    if (mk) cur.paidMonths.add(mk);
    out.set(it.employeeId, cur);
  }
  return out;
}

export async function currentComp(deps: Deps, employeeId: string) {
  return (await deps.db.select().from(schema.compensation).where(and(eq(schema.compensation.employeeId, employeeId), isNull(schema.compensation.effectiveTo))).limit(1))[0];
}

export type TaxProjection = {
  regime: string;
  regimeLabel: string;
  assessmentYear: string;
  financialYear: string;
  tdsConfigured: boolean;
  annualGross: number;
  priorEmployerIncome: number;
  priorEmployerTds: number;
  breakdown: TaxBreakdown;
  deductedToDate: number;
  remainingMonths: number;
  employedMonths: number;
  monthlyTds: number;
};

// The pure assembler: combine the loaded numbers into the year's tax + the per-month TDS. `currentRunGross`
// set => payroll-build context (the current run is one of the remaining months and its earnings are known);
// undefined => the read-only page projection. Two distinct month counts feed this: unpaid EMPLOYED months
// drive the income projection (every month of the year earns salary whether or not a run was built for it),
// while `collectMonths` (calendar months actually left, from collectibleMonths) drives how the tax balance is
// spread - a skipped payroll month still earned income, but it can no longer collect TDS.
export function assembleProjection(args: {
  cfg: TaxConfig;
  regime: string;
  tdsConfigured: boolean;
  employedMonths: number;
  paidGross: number;
  paidTax: number;
  paidMonths: number;
  collectMonths: number;
  recurringMonthly: number;
  currentRunGross?: number;
  decl: TaxDeclarations;
}): TaxProjection {
  const regimeCfg: RegimeConfig = args.cfg.regimes[args.regime] ?? args.cfg.regimes.new!;
  const unpaidMonths = Math.max(0, args.employedMonths - args.paidMonths);
  const prior = Math.max(0, args.decl.priorEmployerIncome ?? 0);
  const futureMonths = args.currentRunGross !== undefined ? Math.max(0, unpaidMonths - 1) : unpaidMonths;
  // Prior-employer income is folded into the full-year total, so the year's tax is computed on both jobs.
  const annualGross = args.paidGross + (args.currentRunGross ?? 0) + args.recurringMonthly * futureMonths + prior;
  const breakdown = computeAnnualTax(annualGross, regimeCfg);
  // Prior-employer TDS is real tax already remitted (Form 16 / 26AS), so it's CREDITED IN FULL against the
  // year's liability, exactly like TDS this employer already deducted - otherwise folding in the prior income
  // raises the tax while the tax already paid on it silently vanishes (double taxation, refunded only at ITR).
  // If the ex-employer over-withheld, the combined already-paid can exceed the liability; monthlyTds floors at
  // 0 (payroll can't refund - that's an ITR refund), so no negative withholding results. Only HR-VERIFIED
  // figures reach here (readDeclarations gate) - that's the fraud gate. The one sanity ceiling is the prior
  // INCOME itself: TDS can never exceed the income it was withheld from, and this bound is 0 when no prior
  // income was declared, so a bare over-declaration can't zero out withholding.
  const priorTds = Math.min(Math.max(0, args.decl.priorEmployerTds ?? 0), prior);
  const monthly = monthlyTds(breakdown.totalTax, args.paidTax + priorTds, args.collectMonths);
  return {
    regime: args.regime,
    regimeLabel: regimeCfg.label,
    assessmentYear: args.cfg.assessmentYear,
    financialYear: args.cfg.financialYear,
    tdsConfigured: args.tdsConfigured,
    annualGross: Math.round(annualGross),
    priorEmployerIncome: prior,
    priorEmployerTds: priorTds,
    breakdown,
    deductedToDate: Math.round(args.paidTax),
    remainingMonths: args.collectMonths,
    employedMonths: args.employedMonths,
    monthlyTds: monthly,
  };
}

// Read-only projection for one employee (the Tax page). `decl` are the employee's declarations.
export async function getEmployeeTaxProjection(deps: Deps, employee: typeof schema.employees.$inferSelect, decl: TaxDeclarations, asOf: Date = new Date()): Promise<TaxProjection> {
  const cfg = await loadTaxConfig(deps);
  const components = await deps.db.select().from(schema.payComponents);
  const tds = tdsComponent(components);
  const regime = tds?.regime ?? "new";
  const fy = fyWindow(asOf);
  const comp = await currentComp(deps, employee.uuid);
  const effective = applyStructure(components, await structureLinesById(deps, comp?.structureId));
  const recurringMonthly = comp ? monthlyRecurringGross(comp.basePay, effective, comp.specialAllowance) : 0;
  const employedMonths = employedMonthsInFy(employee.startDate ?? null, fy, employee.endDate ?? null);
  const t = (await finalizedTotals(deps, fy)).get(employee.uuid) ?? { gross: 0, taxableGross: 0, tax: 0, months: 0, paidMonths: new Set<string>() };
  const collectMonths = collectibleMonths(asOf, employee.startDate ?? null, fy, t.paidMonths);
  return assembleProjection({ cfg, regime, tdsConfigured: !!tds, employedMonths, paidGross: t.taxableGross, paidTax: t.tax, paidMonths: t.months, collectMonths, recurringMonthly, decl });
}

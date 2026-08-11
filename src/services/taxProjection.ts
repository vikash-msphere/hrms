// Assembles the inputs for the pure income-tax calc (src/domain/incomeTax.ts) from DB state, shared by the
// employee Tax page and the payroll build. Annual income for the FY = gross already paid (finalized runs)
// + the current run (build only) + every remaining month priced off the EFFECTIVE-DATED compensation timeline
// + prior-employer income; tax is computed once for the year, and the balance (annual tax - already deducted)
// is spread over the remaining months. Pure date/assembly here; the slab math lives in the domain module.
import { and, eq, inArray, isNull } from "drizzle-orm";
import { chunk } from "../lib/dbBatch";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { getSettingValue } from "./settings";
import { applyStructure, type StructureLine } from "../domain/payroll";
import { round2 } from "../domain/money";
import { allStructureLines } from "./salaryStructures";
import { DEFAULT_TAX_CONFIG, computeAnnualTax, monthlyTds, allowedDeductions, type TaxConfig, type RegimeConfig, type TaxBreakdown, type DeductionRow } from "../domain/incomeTax";

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

// "YYYY-MM" of a date - the key finalized runs, collectible months and projected months all agree on.
export const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

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

// ---- Effective-dated pricing of the months still to be earned -------------------------------------------
// A compensation row, structurally (so the helpers below stay pure and testable without the schema).
export type CompRow = { uuid: string; effectiveFrom: Date; effectiveTo: Date | null; basePay: number; specialAllowance: number; structureId: string | null };

// The compensation row in force at `asOfMs` (half-open [effectiveFrom, effectiveTo)), or the open row when no
// date is given. Pure over prefetched rows, and the SINGLE definition of "salary that applied then" - the
// payroll build prices a period with it and the projection prices each remaining month with it, so a mid-year
// revision can never be read two different ways.
export function compAsOf<T extends { effectiveFrom: Date; effectiveTo: Date | null }>(rows: T[], asOfMs: number | undefined): T | undefined {
  if (asOfMs === undefined) return rows.find((r) => r.effectiveTo === null);
  return rows
    .filter((r) => +new Date(r.effectiveFrom) <= asOfMs && (r.effectiveTo === null || +new Date(r.effectiveTo) > asOfMs))
    .sort((a, b) => +new Date(b.effectiveFrom) - +new Date(a.effectiveFrom))[0];
}

const monthEndMs = (m: Date) => Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0, 23, 59, 59, 999);

// The FY months in which this employee EARNS salary that no finalized run has paid yet (and that isn't the run
// being built now). Same employment window as employedMonthsInFy - join month .. leaving month - so the two
// agree on which months count. Past months payroll simply never ran for are included: the income was earned.
export function unpaidEarningMonths(
  fy: { start: Date; end: Date },
  startDate: Date | null,
  endDate: Date | null | undefined,
  paidMonths: ReadonlySet<string>,
  excludeMonthKey?: string,
): Date[] {
  const empStart = startDate && startDate > fy.start ? firstOfMonthUTC(startDate) : fy.start;
  const empEnd = endDate && endDate < fy.end ? endDate : fy.end;
  const out: Date[] = [];
  if (empStart > fy.end || empEnd < fy.start || empStart > empEnd) return out;
  let cur = firstOfMonthUTC(empStart);
  while (cur <= empEnd) {
    const k = monthKey(cur);
    if (!paidMonths.has(k) && k !== excludeMonthKey) out.push(cur);
    cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
  }
  return out;
}

// Salary still to be earned this FY, priced MONTH BY MONTH off the compensation timeline. A mid-year revision
// (backdated, current or future-dated) must not repaint the whole year at one rate: each month is valued at
// the row in force at that month's end - exactly how a payroll run for that month prices it. Pricing one rate
// across the year is what makes the annual figure wrong on both sides: months before a raise get inflated to
// the new salary, and months after a future-dated raise stay at the old one.
export function projectedGrossForMonths<T extends CompRow>(months: Date[], rows: T[], grossFor: (row: T) => number): number {
  const cache = new Map<string, number>();
  let total = 0;
  for (const m of months) {
    const row = compAsOf(rows, monthEndMs(m));
    if (!row) continue; // no compensation on record for that month - nothing to project
    let g = cache.get(row.uuid);
    if (g === undefined) { g = grossFor(row); cache.set(row.uuid, g); }
    total += g;
  }
  return round2(total);
}

// Per-row monthly recurring gross, honouring the structure that row points at (a revision may switch
// structures, not just the amount).
export function compGrossPricer<T extends CompRow>(components: PayComp[], linesByStructure: Map<string, StructureLine[]>): (row: T) => number {
  return (row) => monthlyRecurringGross(row.basePay, applyStructure(components, (row.structureId ? linesByStructure.get(row.structureId) : null) ?? null), row.specialAllowance);
}

// Per-employee aggregates of FINALIZED (APPROVED/PUBLISHED) run-items whose pay date falls in the FY.
// TWO month keys per run, because a payroll month is two different things and conflating them mis-prices the
// year whenever pay lags earning (April salary paid on 5 May): `paidMonths` are the CALENDAR months in which tax
// was collected (pay-date keyed - feeds collectibleMonths) and `earnedMonths` the PERIOD months whose salary is
// already priced (feeds unpaidEarningMonths, so the projection doesn't re-price a month a run already covered
// while leaving the real unpaid one out).
export type FinalizedTotals = {
  gross: number;
  taxableGross: number;
  tax: number;
  months: number;
  paidMonths: Set<string>;
  earnedMonths: Set<string>;
};
export const EMPTY_FINALIZED_TOTALS = (): FinalizedTotals => ({ gross: 0, taxableGross: 0, tax: 0, months: 0, paidMonths: new Set<string>(), earnedMonths: new Set<string>() });

export async function finalizedTotals(
  deps: Deps,
  fy: { start: Date; end: Date },
  excludeRunId?: string,
  employeeId?: string,
): Promise<Map<string, FinalizedTotals>> {
  const periods = new Map((await deps.db.select().from(schema.payPeriods)).map((p) => [p.uuid, p]));
  const runs = await deps.db.select().from(schema.payrollRuns);
  const inFy = (d: Date) => d >= fy.start && d <= fy.end;
  const runIds = new Set(
    runs
      .filter((r) => (r.state === "APPROVED" || r.state === "PUBLISHED") && r.uuid !== excludeRunId)
      .filter((r) => { const p = periods.get(r.payPeriodId); return !!p && inFy(p.payDate); })
      .map((r) => r.uuid),
  );
  const out = new Map<string, FinalizedTotals>();
  if (!runIds.size) return out;
  const paidMonth = new Map<string, string>(); // run -> pay-date month (when TDS was collected)
  const earnedMonth = new Map<string, string>(); // run -> period month (which month's salary it priced)
  for (const r of runs) {
    if (!runIds.has(r.uuid)) continue;
    const p = periods.get(r.payPeriodId);
    if (!p) continue;
    paidMonth.set(r.uuid, monthKey(p.payDate));
    earnedMonth.set(r.uuid, monthKey(p.periodStart));
  }
  // Only this FY's finalized runs (and, for a single-employee read, only that employee): the items table is the
  // largest in the app and this is its hottest read path, so the filter belongs in SQL, not in a JS scan.
  // Chunked under D1's bound-parameter cap.
  const ids = [...runIds];
  for (const batch of chunk(ids, 90)) {
    const where = employeeId
      ? and(inArray(schema.payrollRunItems.runId, batch), eq(schema.payrollRunItems.employeeId, employeeId))
      : inArray(schema.payrollRunItems.runId, batch);
    for (const it of await deps.db.select().from(schema.payrollRunItems).where(where)) {
      const cur = out.get(it.employeeId) ?? EMPTY_FINALIZED_TOTALS();
      cur.gross += it.gross;
      cur.taxableGross += it.taxableGross ?? it.gross; // taxable base excludes non-taxable lines (e.g. reimbursements)
      cur.tax += it.tax;
      cur.months += 1;
      const pm = paidMonth.get(it.runId);
      if (pm) cur.paidMonths.add(pm);
      const em = earnedMonth.get(it.runId);
      if (em) cur.earnedMonths.add(em);
      out.set(it.employeeId, cur);
    }
  }
  return out;
}

// Full-and-final settlements paid inside the FY: taxable earnings + the tax withheld on them. A leaver is in no
// payroll run, so their exit payout lives only here - Form 16 has to add it or the certificate omits the year's
// largest payment. `excludeId` skips a settlement being recomputed.
export async function settlementTotals(
  deps: Deps,
  fy: { start: Date; end: Date },
  employeeId: string,
  excludeId?: string,
): Promise<{ taxableGross: number; tax: number }> {
  const rows = await deps.db.select().from(schema.settlements).where(eq(schema.settlements.employeeId, employeeId));
  let taxableGross = 0;
  let tax = 0;
  for (const r of rows) {
    if (r.uuid === excludeId) continue;
    const d = new Date(r.settlementDate);
    if (d < fy.start || d > fy.end) continue;
    taxableGross += r.taxableEarnings;
    tax += r.tds;
  }
  return { taxableGross: round2(taxableGross), tax: round2(tax) };
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
  // Chapter VI-A from the employee's VERIFIED investment declarations, per section: what they declared and what
  // this regime actually allows (0 for a section the regime disallows), so the Tax page can show why.
  deductions: DeductionRow[];
};

// The pure assembler: combine the loaded numbers into the year's tax + the per-month TDS. `currentRunGross`
// set => payroll-build context (the current run is one of the remaining months and its earnings are known);
// undefined => the read-only page projection. Income and collection are deliberately separate: `projectedGross`
// is what the unpaid EARNING months are worth (every month of the year earns salary whether or not a run was
// built for it, each priced at its own compensation), while `collectMonths` (calendar months actually left,
// from collectibleMonths) drives how the tax balance is spread - a skipped payroll month still earned income,
// but it can no longer collect TDS.
export function assembleProjection(args: {
  cfg: TaxConfig;
  regime: string;
  tdsConfigured: boolean;
  employedMonths: number;
  paidGross: number;
  paidTax: number;
  collectMonths: number;
  projectedGross: number;
  currentRunGross?: number;
  decl: TaxDeclarations;
  // VERIFIED Chapter VI-A declarations for the year, keyed by section (e.g. { "80C": 150000 }). The regime
  // decides which of them survive; under the new regime that is only 80CCD(2)/80CCH.
  declaredDeductions?: Record<string, number>;
}): TaxProjection {
  const regimeCfg: RegimeConfig = args.cfg.regimes[args.regime] ?? args.cfg.regimes.new!;
  const prior = Math.max(0, args.decl.priorEmployerIncome ?? 0);
  // Prior-employer income is folded into the full-year total, so the year's tax is computed on both jobs.
  const annualGross = args.paidGross + (args.currentRunGross ?? 0) + args.projectedGross + prior;
  // Chapter VI-A actually reduces withholding: verified declarations, filtered + capped by the regime.
  const deductions = allowedDeductions(args.declaredDeductions ?? {}, regimeCfg);
  const breakdown = computeAnnualTax(annualGross, regimeCfg, deductions.total);
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
    deductions: deductions.rows,
  };
}

// The employee's VERIFIED Chapter VI-A declarations for a financial year, summed per section. Only verified rows
// count - a bare declaration must never move withholding (that is the fraud gate the workflow exists for) - and
// `verifiedAmount` is the figure payroll accepted, which may be less than what was declared.
export async function verifiedDeductions(deps: Deps, employeeId: string, financialYear: string): Promise<Record<string, number>> {
  const rows = await deps.db
    .select()
    .from(schema.taxDeclarations)
    .where(and(eq(schema.taxDeclarations.employeeId, employeeId), eq(schema.taxDeclarations.financialYear, financialYear), eq(schema.taxDeclarations.status, "VERIFIED")));
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.deleteTime) continue;
    const amount = Math.max(0, r.verifiedAmount ?? 0);
    if (!amount) continue;
    const section = r.section.trim();
    out[section] = round2((out[section] ?? 0) + amount);
  }
  return out;
}

// Read-only projection for one employee (the Tax page). `decl` are the employee's declarations.
export async function getEmployeeTaxProjection(deps: Deps, employee: typeof schema.employees.$inferSelect, decl: TaxDeclarations, asOf: Date = new Date()): Promise<TaxProjection> {
  const cfg = await loadTaxConfig(deps);
  const components = await deps.db.select().from(schema.payComponents);
  const tds = tdsComponent(components);
  const regime = tds?.regime ?? "new";
  const fy = fyWindow(asOf);
  // The whole salary history, not just the open row: an unpaid month before a raise (or before a future-dated
  // raise) must be projected at the salary that applies in THAT month.
  const timeline = await deps.db.select().from(schema.compensation).where(eq(schema.compensation.employeeId, employee.uuid));
  const pricer = compGrossPricer(components, await allStructureLines(deps));
  const employedMonths = employedMonthsInFy(employee.startDate ?? null, fy, employee.endDate ?? null);
  const t = (await finalizedTotals(deps, fy, undefined, employee.uuid)).get(employee.uuid) ?? EMPTY_FINALIZED_TOTALS();
  // Collection is keyed on PAY months (when TDS can still be withheld), pricing on EARNED months (which months'
  // salary a run already covered) - see finalizedTotals.
  const collectMonths = collectibleMonths(asOf, employee.startDate ?? null, fy, t.paidMonths);
  const projected = projectedGrossForMonths(unpaidEarningMonths(fy, employee.startDate ?? null, employee.endDate, t.earnedMonths), timeline, pricer);
  // A leaver's exit payout is salary income too, and it is settled outside any run: fold the FnF's taxable
  // earnings and the tax it withheld into the year, else the page understates both.
  const settled = await settlementTotals(deps, fy, employee.uuid);
  return assembleProjection({
    cfg, regime, tdsConfigured: !!tds, employedMonths,
    paidGross: t.taxableGross + settled.taxableGross, paidTax: t.tax + settled.tax,
    collectMonths, projectedGross: projected, decl,
    declaredDeductions: await verifiedDeductions(deps, employee.uuid, fy.financialYear),
  });
}

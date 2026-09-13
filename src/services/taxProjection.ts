// Assembles the inputs for the pure income-tax calc (src/domain/incomeTax.ts) from DB state, shared by the
// employee Tax page and the payroll build. Annual income for the FY = gross already paid (finalized runs)
// + the current run (build only) + every remaining month priced off the EFFECTIVE-DATED compensation timeline
// + prior-employer income; tax is computed once for the year, and the balance (annual tax - already deducted)
// is spread over the remaining months. Pure date/assembly here; the slab math lives in the domain module.
import { and, eq, inArray, isNull } from "drizzle-orm";
import { byIdChunks, chunk, groupBy } from "../lib/dbBatch";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { getSettingValue } from "./settings";
import { applyStructure, type StructureLine } from "../domain/payroll";
import { round2 } from "../domain/money";
import { allStructureLines } from "./salaryStructures";
import { DEFAULT_TAX_CONFIG, fyLabels, computeAnnualTax, monthlyTds, allowedDeductions, assertSupportedRegime, type TaxConfig, type RegimeConfig, type TaxBreakdown, type DeductionRow } from "../domain/incomeTax";
import { refPayComponents, refPayPeriods } from "../lib/refData";

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
  return { start, end, ...fyLabels(sy) };
}

// Monthly recurring GROSS = basic + recurring earning components + the Special Allowance plug of a top-down
// (CTC-in) row (income_tax + deduction components add nothing). The plug is a taxable earning, so it belongs in
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
//
// `endDate` CLOSES THE WINDOW AT THE OTHER END, and it was the half this function did not take. Its two
// siblings do: `employedMonthsInFy` clamps by it (with a header saying why), and `unpaidEarningMonths` stops
// pricing at it - so a leaver's annual income was right while the horizon it was collected over ran to 31
// March regardless. Someone leaving on 30 September had the year's remaining liability spread over seven
// months instead of one, and their final payslips withheld a seventh of what they owed. The settlement does
// recover it (services/settlements.ts passes `collectMonths: 1`, so the whole residual lands on the FnF), but
// only where an FnF is actually run, and the person meets the entire year's shortfall in one line of their
// exit payout instead of over the notice period they were being paid through.
export function collectibleMonths(
  from: Date,
  startDate: Date | null,
  fy: { start: Date; end: Date },
  paidMonths: ReadonlySet<string>,
  endDate?: Date | null,
): number {
  let cur = firstOfMonthUTC(from < fy.start ? fy.start : from);
  if (startDate && startDate > cur) cur = firstOfMonthUTC(startDate);
  // The last month TDS can still be withheld in: the leaving month, else the FY end.
  //
  // NEVER BELOW THE MONTH `from` IS IN, which is the case the clamp alone gets wrong. Collection months are
  // PAY months and the leaving date is an EARNING one, and the two are not the same month whenever pay lags
  // work: September salary paid on 5 October, for someone whose last day was 30 September, is collected in a
  // month the clamp has already closed. Left at that, the leaver's final run would find nothing to spread the
  // balance over and withhold NOTHING - which is worse than the over-long horizon this is fixing, because the
  // shortfall is the whole year's rather than a fraction of it. `from` is the run's own pay date (the build)
  // or today (the read-only page), and standing at it, its month is by definition still collectible.
  // The floor relaxes the EMPLOYMENT clamp only. The financial year's own end is absolute and re-applied after
  // it, or a `from` past 31 March would be handed its own month and report a collectible one in a year that is
  // over - which is the opposite of what this function has always answered there.
  const endCap = endDate && endDate < fy.end ? endDate : fy.end;
  const floored = +endCap >= +cur ? endCap : new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0, 23, 59, 59, 999));
  const last = +floored > +fy.end ? fy.end : floored;
  let n = 0;
  while (cur <= last) {
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
// `pt` is the year's professional tax already withheld - the state annual cap is measured against it, and it
// comes from the same rows, so the build never pays for a second scan of the items table.
export type FinalizedTotals = {
  gross: number;
  taxableGross: number;
  tax: number;
  pt: number;
  months: number;
  paidMonths: Set<string>;
  earnedMonths: Set<string>;
};
export const EMPTY_FINALIZED_TOTALS = (): FinalizedTotals => ({ gross: 0, taxableGross: 0, tax: 0, pt: 0, months: 0, paidMonths: new Set<string>(), earnedMonths: new Set<string>() });

// Professional tax withheld by one stored item, by its stable "PT" line code. Unparseable lines contribute 0
// rather than failing a build: the cap is a ceiling, and reading it as lower only ever withholds more.
function ptOf(linesJson: string | null): number {
  if (!linesJson) return 0;
  try {
    return (JSON.parse(linesJson) as { code?: string; kind?: string; amount?: number }[])
      .filter((l) => l.code === "PT" && l.kind === "deduction")
      .reduce((s, l) => s + (l.amount ?? 0), 0);
  } catch {
    return 0;
  }
}

export async function finalizedTotals(
  deps: Deps,
  fy: { start: Date; end: Date },
  excludeRunId?: string,
  employeeId?: string,
): Promise<Map<string, FinalizedTotals>> {
  const periods = new Map((await refPayPeriods(deps)).map((p) => [p.uuid, p]));
  const inFy = (d: Date) => d >= fy.start && d <= fy.end;
  // THE RUNS, NARROWED IN SQL - state and financial year both. This read the whole `payroll_runs` table (every
  // column of every run the org has ever built) and threw away the drafts and the other years in JS, on the
  // path the paragraph below calls the hottest read in the app: the payroll build takes it once per build,
  // every settlement takes it, Form 16 takes it, and the Tax page takes it on every render.
  //
  // Same shape services/settlements.ts#esiContributingAtExit already uses for this table and this question:
  // the state filter is a plain `inArray`, and the year is expressed as the pay periods that fall in it, taken
  // from the CACHED period list (lib/refData memoizes it per request) so bounding by it costs no query. Three
  // columns instead of the row, because three is what the walk below reads.
  const periodIdsInFy = [...periods.values()].filter((p) => inFy(p.payDate)).map((p) => p.uuid);
  const runs = periodIdsInFy.length
    ? await byIdChunks(periodIdsInFy, (group) =>
        deps.db
          .select({ uuid: schema.payrollRuns.uuid, payPeriodId: schema.payrollRuns.payPeriodId, state: schema.payrollRuns.state })
          .from(schema.payrollRuns)
          .where(and(inArray(schema.payrollRuns.state, ["APPROVED", "PUBLISHED"]), inArray(schema.payrollRuns.payPeriodId, group))),
      )
    : [];
  const runIds = new Set(runs.filter((r) => r.uuid !== excludeRunId).map((r) => r.uuid));
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
      cur.pt += ptOf(it.linesJson);
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
  return (await deps.db.select().from(schema.compensation).where(and(eq(schema.compensation.employeeId, employeeId), isNull(schema.compensation.effectiveTo), isNull(schema.compensation.deleteTime))).limit(1))[0];
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
  // The financial year actually being withheld for, from `fyWindow` on the period/settlement date. Required
  // and separate from `cfg` on purpose: `cfg.financialYear` stamps which Budget's SLABS are loaded, which is
  // a different fact and is routinely a year behind. Labelling the projection from the config is how a
  // FY 2026-27 payslip ends up captioned "FY 2025-26" on the Tax page while the arithmetic is correct.
  fy: { financialYear: string; assessmentYear: string };
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
  // A configured regime this build cannot compute correctly must fail loudly, not fall back to the new regime's
  // slabs under the old regime's label - that withholds a number matching neither.
  assertSupportedRegime(args.regime);
  // The `?? regimes.new!` fallback was a non-null assertion that could be a lie: `getSettingValue` merges a
  // stored `tax-config` over the default SHALLOWLY, so a `regimes` object written without a `new` key leaves
  // the map with no fallback at all - and `computeAnnualTax(x, undefined)` then threw on `cfg.standardDeduction`
  // as a bare 500 on every payroll build and every Tax page, with nothing naming the setting that caused it.
  // Refusing here says which key is wrong. (routes/settings.ts validateTaxConfig stops it being storable now;
  // this covers a row written before that existed.)
  const regimeCfg: RegimeConfig | undefined = args.cfg.regimes?.[args.regime] ?? args.cfg.regimes?.new;
  if (!regimeCfg) {
    throw new Error(
      `settings/tax-config defines no "${args.regime}" regime and no "new" regime to fall back to. ` +
      "A stored `regimes` object REPLACES the default one rather than merging into it, so it has to carry every regime it wants available.",
    );
  }
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
    assessmentYear: args.fy.assessmentYear,
    financialYear: args.fy.financialYear,
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

// Sum a set of declaration rows per section. Only VERIFIED rows reach here - a bare declaration must never
// move withholding, which is the fraud gate the verify workflow exists for - and `verifiedAmount` is the
// figure payroll accepted, which may be less than what was declared.
function sumBySection(rows: (typeof schema.taxDeclarations.$inferSelect)[]): Record<string, number> {
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

/** One employee's verified Chapter VI-A deductions for a financial year, summed per section. */
export async function verifiedDeductions(deps: Deps, employeeId: string, financialYear: string): Promise<Record<string, number>> {
  return sumBySection(
    await deps.db
      .select()
      .from(schema.taxDeclarations)
      .where(and(eq(schema.taxDeclarations.employeeId, employeeId), eq(schema.taxDeclarations.financialYear, financialYear), eq(schema.taxDeclarations.status, "VERIFIED"))),
  );
}

/**
 * THE WHOLE ORG's verified deductions for a financial year, in ONE read, keyed by employee.
 *
 * The single-employee reader above is right for the Tax page and for a settlement, which are about one person.
 * The payroll build is not: it called it inside its per-employee loop, so a build was one D1 subrequest per
 * employee - against a per-invocation budget of 50 on the free plan and 1000 on paid, and directly against the
 * comment the build carries about its own loop touching the DB not at all. It failed at a few dozen employees,
 * with the run left un-stamped so nobody was paid, and it failed only once real headcount was in.
 *
 * The financial year is the narrowing that makes one read the right shape: a year's verified declarations are
 * a few rows per employee at most, and the build already needs every one of them. An employee with no verified
 * declaration is simply absent from the map, which is the empty record the caller wants anyway.
 */
export async function verifiedDeductionsAll(deps: Deps, financialYear: string): Promise<Map<string, Record<string, number>>> {
  const rows = await deps.db
    .select()
    .from(schema.taxDeclarations)
    .where(and(eq(schema.taxDeclarations.financialYear, financialYear), eq(schema.taxDeclarations.status, "VERIFIED")));
  const out = new Map<string, Record<string, number>>();
  for (const [employeeId, group] of groupBy(rows, (r) => r.employeeId)) out.set(employeeId, sumBySection(group));
  return out;
}

// Read-only projection for one employee (the Tax page). `decl` are the employee's declarations.
export async function getEmployeeTaxProjection(deps: Deps, employee: typeof schema.employees.$inferSelect, decl: TaxDeclarations, asOf: Date = new Date()): Promise<TaxProjection> {
  const cfg = await loadTaxConfig(deps);
  const components = await refPayComponents(deps);
  const tds = tdsComponent(components);
  const regime = tds?.regime ?? "new";
  const fy = fyWindow(asOf);
  // The whole salary history, not just the open row: an unpaid month before a raise (or before a future-dated
  // raise) must be projected at the salary that applies in THAT month.
  const timeline = await deps.db.select().from(schema.compensation).where(and(eq(schema.compensation.employeeId, employee.uuid), isNull(schema.compensation.deleteTime)));
  const pricer = compGrossPricer(components, await allStructureLines(deps));
  const employedMonths = employedMonthsInFy(employee.startDate ?? null, fy, employee.endDate ?? null);
  const t = (await finalizedTotals(deps, fy, undefined, employee.uuid)).get(employee.uuid) ?? EMPTY_FINALIZED_TOTALS();
  // Collection is keyed on PAY months (when TDS can still be withheld), pricing on EARNED months (which months'
  // salary a run already covered) - see finalizedTotals.
  const collectMonths = collectibleMonths(asOf, employee.startDate ?? null, fy, t.paidMonths, employee.endDate ?? null);
  const projected = projectedGrossForMonths(unpaidEarningMonths(fy, employee.startDate ?? null, employee.endDate, t.earnedMonths), timeline, pricer);
  // A leaver's exit payout is salary income too, and it is settled outside any run: fold the FnF's taxable
  // earnings and the tax it withheld into the year, else the page understates both.
  const settled = await settlementTotals(deps, fy, employee.uuid);
  return assembleProjection({
    cfg, fy, regime, tdsConfigured: !!tds, employedMonths,
    paidGross: t.taxableGross + settled.taxableGross, paidTax: t.tax + settled.tax,
    collectMonths, projectedGross: projected, decl,
    declaredDeductions: await verifiedDeductions(deps, employee.uuid, fy.financialYear),
  });
}

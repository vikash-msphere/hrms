// PURE payroll logic. No I/O. VERIFIED. Do NOT add statutory tax logic here.

import { esiEmployerContribution } from "./statutory";

// `taxable` defaults to true; a line set `taxable: false` (e.g. a reimbursement payout) is paid in net but
// excluded from the income-tax base.
// An EARNING may be negative: loss of pay is priced as a negative earning, not a deduction, because it is pay
// the employee never earned - so it has to leave gross, the taxable base AND the statutory bases together
// (withholding income tax, ESI and PT on docked wage over-collects from the people who can least afford it).
// `employer_contribution` lines are the employer's own cost for the period (employer PF/ESI/gratuity/EDLI). They
// are NEITHER paid nor withheld - they never touch gross, deductions or net - and are carried on the item so the
// payslip, the run review and the statutory report all report the same figures the run computed. `aboveCtc`
// marks a contribution whose component is set to sit over and above CTC rather than inside it.
// `perquisite` lines are taxable value the employee never receives in cash (e.g. the interest concession on a
// cheap employer loan, Rule 3(7)(i)): they lift the income-tax base and nothing else - not gross, not net.
// `units` and `basis` are the line's own computation facts, carried so downstream readers never have to parse
// them back out of a display label or reverse-derive them from a rounded amount: `units` is the quantity the
// amount was priced from (loss-of-pay day-units today), and `basis` the wage a statutory line was computed on
// (PF wages for EPF/EDLI/administration, ESI wages for ESI). The statutory register and the PF ECR report both.
export type Line = { code: string; name: string; kind: "earning" | "deduction" | "employer_contribution" | "perquisite"; amount: number; taxable?: boolean; aboveCtc?: boolean; units?: number; basis?: number };

import { round2 } from "./money";

// net = sum(earnings) - sum(deductions); employer_contribution and perquisite lines are not paid and enter
// neither gross nor net. Statutory deductions are just input lines with amounts. taxableGross is the slice of
// gross that counts toward income tax (earnings where taxable !== false) PLUS any perquisite value.
export function computeRunItem(lines: Line[]): { gross: number; taxableGross: number; totalDeductions: number; net: number } {
  const earnings = lines.filter((l) => l.kind === "earning");
  const gross = round2(earnings.reduce((s, l) => s + l.amount, 0));
  const perquisites = lines.filter((l) => l.kind === "perquisite").reduce((s, l) => s + l.amount, 0);
  const taxableGross = round2(earnings.filter((l) => l.taxable !== false).reduce((s, l) => s + l.amount, 0) + perquisites);
  const totalDeductions = round2(lines.filter((l) => l.kind === "deduction").reduce((s, l) => s + l.amount, 0));
  return { gross, taxableGross, totalDeductions, net: round2(gross - totalDeductions) };
}

// A salary-structure line: which earning component applies, and an optional rate override (null = use the
// component's own rate).
export type StructureLine = { component: string; rate: number | null };

// Resolve the effective component set for ONE employee given their assigned structure (its lines, or null for
// no structure). Deductions and statutory lines always pass through unchanged. Earnings: with no structure,
// all of them apply (today's global behaviour); with a structure, only the selected earnings apply, each with
// its rate overridden when the line sets one. Pure - the same filter feeds payroll, tax projection, letters
// and encashment pricing, so they never drift.
export function applyStructure<T extends { uuid: string; kind: "earning" | "deduction" | "employer_contribution"; rate: number | null }>(
  components: T[],
  lines: StructureLine[] | null,
): T[] {
  if (!lines) return components;
  const byId = new Map(lines.map((l) => [l.component, l]));
  const out: T[] = [];
  for (const c of components) {
    if (c.kind !== "earning") { out.push(c); continue; } // deductions / EPF / TDS always apply
    const ov = byId.get(c.uuid);
    if (!ov) continue; // earning not in the structure -> excluded for this employee
    out.push(ov.rate != null ? { ...c, rate: ov.rate } : c);
  }
  return out;
}

// Overtime pay. Either a flat `rate_per_hour`, or (default) the ordinary hourly wage (basePay / hours_per_month)
// times a `multiplier` (statutory norm is 2x). Disabled by default - opt-in via settings.
export type OvertimeConfig = { enabled: boolean; multiplier: number; hours_per_month: number; rate_per_hour?: number | null };
export const DEFAULT_OVERTIME_CONFIG: OvertimeConfig = { enabled: false, multiplier: 2, hours_per_month: 200, rate_per_hour: null };
export function overtimePay(minutes: number, basePay: number, cfg: OvertimeConfig): number {
  if (minutes <= 0) return 0;
  const hourly = cfg.rate_per_hour && cfg.rate_per_hour > 0
    ? cfg.rate_per_hour
    : (cfg.hours_per_month > 0 ? basePay / cfg.hours_per_month : 0) * (cfg.multiplier || 1);
  return round2((minutes / 60) * hourly);
}

// `basic_pct` drives the TOP-DOWN split (enter a target CTC -> basic = basic_pct% of monthly CTC, and a
// balancing Special Allowance absorbs the remainder); the wage code wants basic at least 50% of pay. Which
// employer contributions exist (PF/ESI/gratuity/...), at what rate, and whether each counts inside CTC is pure
// data (employer_contribution pay components), never config and never hardcoded.
// `pf_wage_basis` is the org's PF wage composition (see pfWagesOf): "basic" (default) or "basic_plus".
export type CtcConfig = { basic_pct: number; pf_wage_basis?: PfWageBasis };
export const DEFAULT_CTC_CONFIG: CtcConfig = { basic_pct: 50, pf_wage_basis: "basic" };

// A pay component as the CTC math needs it (structural, so this stays pure - no schema import). `inCtc` is the
// employer-contribution CTC choice: true (default) = counted INSIDE the CTC figure, the common Indian
// convention; false = paid OVER AND ABOVE CTC ("CTC + PF"), still a company cost but outside the CTC number.
// Per component, so employer PF, employer ESI and gratuity can each sit on either side independently.
export type CtcComponent = { kind: "earning" | "deduction" | "employer_contribution"; method: string; name: string; rate: number | null; cap: number | null; recurring?: boolean; disabled?: boolean; deleteTime?: unknown; inCtc?: boolean; pfWages?: boolean };
// `aboveCtc` marks a line shown in the breakdown but NOT summed into the CTC total (a contribution whose
// component is set to sit over and above CTC). Absent/false = counted in CTC as normal.
export type CtcLine = { name: string; monthly: number; annual: number; aboveCtc?: boolean };

// A component counts only while it is live: enabled, not soft-deleted, and recurring (one-offs are inputs).
const liveComponent = (c: CtcComponent) => !c.disabled && !c.deleteTime && !!c.recurring;

// Stable line codes for the employer's own contributions, so the payslip/statutory surfaces can find the PF and
// ESI shares by code instead of by (renameable) component name. Distinct from the employee-side "EPF"/"ESI".
// Line codes the engine owns. Every one of them is matched by EXACT code downstream (the statutory register,
// the PF ECR, the loss-of-pay normalisation, the payout rounding line), so a plain pay component must never be
// able to mint one just by being named "PT" or "LOP".
const RESERVED_LINE_CODES = new Set([
  "BASIC", "SPECIAL", "LOP", "ENCASH", "BONUS", "OT", "ARREARS", "REIMB",
  "EPF", "ESI", "PT", "TDS", "PERQ_LOAN", "LOAN", "ROUND",
]);

// The line code for an ordinary (non-statutory) pay component. Derived from the component name so it is stable
// and readable, and prefixed whenever that slug would collide with a code the engine owns.
export function componentLineCode(name: string): string {
  const slug = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
  return RESERVED_LINE_CODES.has(slug) || slug.startsWith("ER_") ? `C_${slug}` : slug || "COMPONENT";
}

// Takes the shape rather than a full CtcComponent: the catalog's uniqueness check (services/payComponents.ts)
// asks this about a stored row, which is not one.
export function employerLineCode(c: { method: string; name: string }): string {
  return c.method === "epf" ? "ER_EPF"
    : c.method === "esi" ? "ER_ESI"
    : c.method === "edli" ? "ER_EDLI"
    : c.method === "pf_admin" ? "ER_PF_ADMIN"
    : `ER_${c.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
}

// The line code a component's amounts will actually appear under - the employer's own contributions are
// namespaced (`ER_…`), everything else takes the slug of its name. One function, so the uniqueness rule the
// catalog enforces is asking about the same string the build writes.
export function payComponentLineCode(c: { kind: string; method: string; name: string }): string {
  return c.kind === "employer_contribution" ? employerLineCode(c) : componentLineCode(c.name);
}

// ---- PF wages -------------------------------------------------------------------------------------------
// WHICH wage PF (both shares, EDLI and admin charges) is computed on. Default "basic": the contractual basic
// only, the convention most Indian payrolls run. "basic_plus" follows the Supreme Court's Vivekananda
// Vidyamandir line - allowances paid universally to everyone are "basic wages" too - by adding the Special
// Allowance plug and every earning component HR has flagged `pfWages`. HRA, overtime and bonus are excluded by
// statute, so they simply stay unflagged. Org policy, never hardcoded: settings/ctc `pf_wage_basis`.
export type PfWageBasis = "basic" | "basic_plus";
export function pfWagesOf(basic: number, specialAllowance: number, components: CtcComponent[], basis: PfWageBasis = "basic"): number {
  if (basis !== "basic_plus") return round2(basic);
  let extra = specialAllowance;
  for (const c of components) {
    if (!liveComponent(c) || c.kind !== "earning" || !c.pfWages) continue;
    extra += componentMonthly(c, basic, 0);
  }
  return round2(basic + extra);
}

// THE single source of the employer's on-top cost for one employee: every live employer_contribution component
// priced by its own method/rate/cap off this employee's basic + gross. Each line carries its component's own
// CTC choice (`inCtc === false` -> `aboveCtc`), so the CTC breakdown, the payroll run, the payslip and the
// letters all classify a contribution the same way without re-reading policy anywhere.
// `esiEligible` overrides the plain ceiling test for the ESI-method row: payroll passes the run's sticky
// eligibility verdict (a mid-period raise past the ceiling keeps contributing to the contribution-period end),
// while CTC views leave it undefined and let the ceiling decide.
// `pfWages` is the wage the PF-family methods (epf / edli / pf_admin) are priced on - the payroll run passes
// the period's actual PF wages (basic net of loss of pay, plus arrears of basic, per the configured basis),
// while CTC views leave it undefined and let plain basic stand in.
// `basis` is the wage the contribution was priced on (PF wages for the PF family, gross for ESI, basic
// otherwise), carried so the statutory register and the PF challan state the wage the run used instead of
// dividing a rounded contribution back out by its rate.
export type EmployerCostLine = { code: string; name: string; monthly: number; aboveCtc: boolean; basis: number };
export function employerCostLines(
  basic: number,
  gross: number,
  components: CtcComponent[],
  epfEnrolled: boolean,
  esiEligible?: boolean,
  pfWages?: number,
): EmployerCostLine[] {
  const out: EmployerCostLine[] = [];
  const pf = pfWages ?? basic;
  for (const c of components) {
    if (!liveComponent(c) || c.kind !== "employer_contribution") continue;
    // The whole PF family is opt-in per employee, same gate as the employee side: no membership, no EPF, no
    // EDLI and no administration charge (they are all levied on PF wages of MEMBERS).
    if ((c.method === "epf" || c.method === "edli" || c.method === "pf_admin") && !epfEnrolled) continue;
    // ESI: an explicit eligibility verdict wins over the ceiling (sticky within a contribution period); gate
    // with Infinity then so a raise past the ceiling doesn't zero the employer share mid-period.
    const monthly =
      c.method === "esi" && esiEligible !== undefined
        ? (esiEligible ? esiEmployerContribution(gross, c.rate ?? 0, Infinity) : 0)
        : componentMonthly(c, basic, gross, pf);
    if (monthly <= 0) continue;
    const wage = c.method === "epf" || c.method === "edli" || c.method === "pf_admin" ? pf : c.method === "esi" ? gross : basic;
    out.push({ code: employerLineCode(c), name: c.name, monthly: round2(monthly), aboveCtc: c.inCtc === false, basis: round2(wage) });
  }
  return out;
}

// One component's monthly amount, dispatched purely by its `method`. `basic`/`gross`/`pfWages` are the
// statutory bases: percent_base sits on basic; the PF family (epf, EDLI, administration charges) sits on PF
// wages, each capped at the wage ceiling; esi sits on gross while within the ceiling; fixed is a flat rupee
// amount. `pfWages` defaults to basic (the default wage basis). Shared by every CTC row so an earning and its
// mirror employer contribution compute identically. Nothing about gratuity/PF/ESI is special-cased - each is
// just a row.
// Exported for the compensation tab, which prices the same components for display (the earnings list, the
// deductions list, the employer build-up) and used to carry its own copy of this dispatch. One rule, one place.
export function componentMonthly(c: CtcComponent, basic: number, gross: number, pfWages = basic): number {
  switch (c.method) {
    case "fixed": return c.rate ?? 0;
    case "percent_base": return basic * ((c.rate ?? 0) / 100);
    case "epf": return Math.min(pfWages, c.cap ?? Infinity) * ((c.rate ?? 12) / 100);
    // EDLI (0.5% by default) and PF administration charges (0.5%) - the employer's PF cost beyond the 12%
    // share. Same wage and same ceiling as EPF, so the three always agree on the base.
    case "edli": return Math.min(pfWages, c.cap ?? Infinity) * ((c.rate ?? 0.5) / 100);
    case "pf_admin": return Math.min(pfWages, c.cap ?? Infinity) * ((c.rate ?? 0.5) / 100);
    case "esi": return esiEmployerContribution(gross, c.rate ?? 0, c.cap ?? 21000);
    default: return 0;
  }
}

// THE single source of the CTC breakdown, keyed off the contractual monthly BASIC (`basePay`): Basic +
// recurring EARNING components + a per-employee Special Allowance = gross, then every recurring
// EMPLOYER_CONTRIBUTION component ON TOP (each computed by its own method/rate/cap - gratuity, employer PF,
// employer ESI, or anything else HR adds as data). CTC = gross + employer contributions. Employee-side
// deductions (EPF employee share, TDS) never appear - this states cost to company, not take-home. Employer
// PF (method "epf") is skipped when the employee opted out, mirroring the employee side. Pure; letters, the
// comp tab and the top-down split solver all consume it, so the figures never drift.
export function ctcLines(
  basePay: number,
  components: CtcComponent[],
  epfEnrolled: boolean,
  specialAllowance = 0,
  pfBasis: PfWageBasis = "basic",
): { lines: CtcLine[]; ctcMonthly: number } {
  const line = (name: string, monthly: number, aboveCtc = false): CtcLine => ({ name, monthly: round2(monthly), annual: round2(monthly * 12), ...(aboveCtc ? { aboveCtc } : {}) });
  const live = liveComponent;
  const lines: CtcLine[] = [line("Basic", basePay)];
  let earnings = 0;
  for (const c of components) {
    if (!live(c) || c.kind !== "earning") continue;
    const monthly = componentMonthly(c, basePay, 0);
    if (monthly > 0) { lines.push(line(c.name, monthly)); earnings += monthly; }
  }
  // The balancing plug of a top-down (CTC-in) split: a taxable fixed earning that makes gross + employer
  // contributions land exactly on the target CTC. Zero for a bottom-up (basic-in) row, so nothing shows.
  if (specialAllowance > 0) { lines.push(line("Special Allowance", specialAllowance)); earnings += specialAllowance; }
  const grossEarnings = round2(basePay + earnings);
  // Employer contributions ON TOP of gross, from the same helper the payroll run and the payslip use, so the
  // amounts AND each contribution's CTC side are decided in exactly one place. PF wages follow the org's
  // configured basis, so the CTC the split solves for is the CTC the run will actually cost.
  const pfWages = pfWagesOf(basePay, specialAllowance, components, pfBasis);
  for (const ec of employerCostLines(basePay, grossEarnings, components, epfEnrolled, undefined, pfWages)) lines.push(line(ec.name, ec.monthly, ec.aboveCtc));
  const ctcMonthly = round2(lines.reduce((s, l) => s + (l.aboveCtc ? 0 : l.monthly), 0)); // gross + in-CTC employer contributions
  return { lines, ctcMonthly };
}

/**
 * TOP-DOWN split: given a target MONTHLY CTC, pin basic at `basic_pct`% of it and solve for the Special
 * Allowance that makes ctcLines() land on the target. Returns null when no split hits the target - either the
 * committed cost already overshoots it (basic % too high, fixed components too large) or no plug lands on it.
 *
 * CTC IS NOT MONOTONIC IN THE PLUG, though the comment here used to say it was. Employer ESI is charged only
 * while the monthly gross is at or under the eligibility ceiling, so at the rupee where the plug pushes gross
 * past that ceiling the ESI line drops to zero and the CTC steps DOWN by ~3.25% of the ceiling.
 *
 * That particular step happens to be survivable by a plain bisection, and the search was not silently wrong
 * because of it: bisection maintains `ctcOf(lo) < target <= ctcOf(hi)`, and a step that goes DOWN as the plug
 * rises cannot satisfy that straddle at the step itself, so it always converged on a real crossing. What was
 * missing was any statement of that, and any check that it held - the function returned its converged point
 * unexamined, so the first component method with a step the other way, or a target the shape simply cannot
 * reach, would be answered with a split whose CTC is not the CTC that was typed in.
 *
 * So the search stopped depending on the shape. SCAN for a bracket, bisect INSIDE it, then CHECK. The scan
 * finds every sub-interval where the sampled value crosses the target, so a crossing on the far side of a step
 * is found rather than assumed away; bisection refines each candidate bracket in ascending order, preferring
 * the smallest plug that works. `ctcLines` is pure arithmetic over a handful of components and this runs on a
 * compensation edit (never per payroll row), so the extra samples cost nothing worth counting.
 *
 * The CHECK is the part that must not be dropped. What the caller stores is the ROUNDED plug, so the residual
 * is measured on exactly that value, and the closest candidate wins - see CTC_TOL for why "closest" rather
 * than "exact", and how far off is still an answer rather than a null.
 */
// ONE RUPEE, and the reason is the staircase rather than the arithmetic. Some targets are not attainable at
// all: ESI is rounded UP to the next rupee (ESIC's own rule, domain/statutory.ts), so the CTC curve climbs in
// one-rupee steps and a target can land in the gap between two of them. The closest reachable split is the
// right answer there - it is off by under a rupee on a figure entered in whole currency - so the tolerance
// admits the gap and nothing wider. A genuine failure (no crossing, an infeasible basic %) misses by
// thousands, never by one.
const CTC_TOL = 1;

export function splitCtc(
  targetMonthlyCtc: number,
  components: CtcComponent[],
  epfEnrolled: boolean,
  cfg: CtcConfig,
): { basePay: number; specialAllowance: number } | null {
  const basePay = round2(targetMonthlyCtc * (cfg.basic_pct / 100));
  const ctcOf = (special: number) => ctcLines(basePay, components, epfEnrolled, special, cfg.pf_wage_basis ?? "basic").ctcMonthly;

  const zero = ctcOf(0);
  if (zero > targetMonthlyCtc + CTC_TOL) return null; // infeasible: committed cost already exceeds the target

  // The best candidate seen, measured on the plug AS STORED - `round2` is what the caller persists, so the
  // residual is taken on the rounded value and not on the converged real number behind it.
  let bestPlug = 0;
  let bestResidual = Infinity;
  const consider = (special: number): void => {
    const rounded = round2(special);
    if (rounded < 0) return;
    const residual = Math.abs(ctcOf(rounded) - targetMonthlyCtc);
    if (residual < bestResidual) {
      bestResidual = residual;
      bestPlug = rounded;
    }
  };
  consider(0); // a target the committed cost already meets needs no plug at all

  // Coarse scan over [0, target] - a crossing cannot lie above it, since the plug lifts CTC at least one for
  // one away from a step. Every sampled crossing becomes a bracket, walked in ascending order so that when two
  // plugs are equally good the smaller one wins.
  const SAMPLES = 64;
  const brackets: [number, number][] = [];
  let prevS = 0;
  let prevV = zero;
  for (let i = 1; i <= SAMPLES; i++) {
    const s = (targetMonthlyCtc * i) / SAMPLES;
    const v = ctcOf(s);
    if (prevV <= targetMonthlyCtc && v >= targetMonthlyCtc) brackets.push([prevS, s]);
    prevS = s;
    prevV = v;
  }

  for (const [from, to] of brackets) {
    let lo = from;
    let hi = to;
    for (let i = 0; i < 48; i++) {
      const mid = (lo + hi) / 2;
      if (ctcOf(mid) < targetMonthlyCtc) lo = mid; else hi = mid;
    }
    // Rounding can push the converged point to either side of the crossing, so both ends are weighed too.
    consider((lo + hi) / 2);
    consider(lo);
    consider(hi);
    if (bestResidual === 0) break; // exact: nothing later can beat it, and the smaller plug is already held
  }
  return bestResidual <= CTC_TOL ? { basePay, specialAllowance: bestPlug } : null;
}

export type RunState = "DRAFT" | "REVIEW" | "APPROVED" | "PUBLISHED";

const TRANSITIONS: Record<RunState, RunState[]> = {
  DRAFT: ["REVIEW"],
  REVIEW: ["DRAFT", "APPROVED"],
  APPROVED: ["PUBLISHED"],
  PUBLISHED: [],
};

// `?? []` because `from` is only a RunState to TypeScript. The column is plain TEXT - drizzle's `enum` is a
// compile-time type, not a CHECK constraint (see the migration), so nothing in the DATABASE stops a value
// outside the four. A bare `TRANSITIONS[from]` on such a row is a TypeError, which reaches the caller as a
// 500; unknown state means no transition is permitted, which is a `failedPrecondition` the operator can read.
// Fail closed and say so, rather than fail loudly and say nothing.
export function canTransition(from: RunState, to: RunState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export const isEditable = (s: RunState) => s === "DRAFT" || s === "REVIEW";

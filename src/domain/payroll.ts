// PURE payroll logic. No I/O. VERIFIED. Do NOT add statutory tax logic here.

import { esiEmployerContribution } from "./statutory";

// `taxable` defaults to true; a line set `taxable: false` (e.g. a reimbursement payout) is paid in net but
// excluded from the income-tax base.
export type Line = { code: string; name: string; kind: "earning" | "deduction"; amount: number; taxable?: boolean };

import { round2 } from "./money";

// net = sum(earnings) - sum(deductions). Statutory deductions are just input lines with amounts. taxableGross
// is the slice of gross that counts toward income tax (earnings where taxable !== false).
export function computeRunItem(lines: Line[]): { gross: number; taxableGross: number; totalDeductions: number; net: number } {
  const earnings = lines.filter((l) => l.kind === "earning");
  const gross = round2(earnings.reduce((s, l) => s + l.amount, 0));
  const taxableGross = round2(earnings.filter((l) => l.taxable !== false).reduce((s, l) => s + l.amount, 0));
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
// employer contributions exist (PF/ESI/gratuity/...) and at what rate is pure data (employer_contribution pay
// components), never hardcoded. `employer_pf_in_ctc` is the one contribution-specific policy: whether the
// employer PF share counts INSIDE the CTC figure (true, the common Indian convention) or sits OVER AND ABOVE
// it (false - "CTC + PF"). Off-CTC PF is still shown as a line, just excluded from the CTC total, so the
// top-down split solves gross + other contributions to the target and lets PF ride on top.
export type CtcConfig = { basic_pct: number; employer_pf_in_ctc: boolean };
export const DEFAULT_CTC_CONFIG: CtcConfig = { basic_pct: 50, employer_pf_in_ctc: true };

// A pay component as the CTC math needs it (structural, so this stays pure - no schema import).
export type CtcComponent = { kind: "earning" | "deduction" | "employer_contribution"; method: string; name: string; rate: number | null; cap: number | null; recurring?: boolean; disabled?: boolean; deleteTime?: unknown };
// `aboveCtc` marks a line shown in the breakdown but NOT summed into the CTC total (employer PF when the org
// puts it over and above CTC). Absent/false = counted in CTC as normal.
export type CtcLine = { name: string; monthly: number; annual: number; aboveCtc?: boolean };

// One component's monthly amount, dispatched purely by its `method`. `basic`/`gross` are the two statutory
// bases: percent_base and epf sit on basic (epf capped at its wage ceiling); esi sits on gross while within
// the ceiling; fixed is a flat rupee amount. Shared by every CTC row so an earning and its mirror employer
// contribution compute identically. Nothing about gratuity/PF/ESI is special-cased - each is just a row.
function componentMonthly(c: CtcComponent, basic: number, gross: number): number {
  switch (c.method) {
    case "fixed": return c.rate ?? 0;
    case "percent_base": return basic * ((c.rate ?? 0) / 100);
    case "epf": return Math.min(basic, c.cap ?? Infinity) * ((c.rate ?? 12) / 100);
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
  cfg: CtcConfig,
  specialAllowance = 0,
): { lines: CtcLine[]; ctcMonthly: number } {
  const line = (name: string, monthly: number, aboveCtc = false): CtcLine => ({ name, monthly: round2(monthly), annual: round2(monthly * 12), ...(aboveCtc ? { aboveCtc } : {}) });
  const live = (c: CtcComponent) => !c.disabled && !c.deleteTime && c.recurring;
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
  // Employer contributions ON TOP of gross. esi-method rows read gross; epf/percent_base rows read basic.
  for (const c of components) {
    if (!live(c) || c.kind !== "employer_contribution") continue;
    if (c.method === "epf" && !epfEnrolled) continue; // PF is opt-in per employee, same gate as the employee side
    const monthly = componentMonthly(c, basePay, grossEarnings);
    // Employer PF rides ON TOP of CTC (excluded from the total) when the org puts it over and above; every
    // other contribution, and PF under the default, counts inside CTC.
    const aboveCtc = c.method === "epf" && !cfg.employer_pf_in_ctc;
    if (monthly > 0) lines.push(line(c.name, monthly, aboveCtc));
  }
  const ctcMonthly = round2(lines.reduce((s, l) => s + (l.aboveCtc ? 0 : l.monthly), 0)); // gross + in-CTC employer contributions
  return { lines, ctcMonthly };
}

// TOP-DOWN split: given a target MONTHLY CTC, pin basic at `basic_pct`% of it and solve for the Special
// Allowance that makes ctcLines() land on the target. CTC is monotonic increasing in the special allowance
// (it lifts gross 1:1, plus employer ESI while eligible), so a bisection converges. Returns null when even a
// zero plug already overshoots the target (basic % too high or fixed components too large to fit).
export function splitCtc(
  targetMonthlyCtc: number,
  components: CtcComponent[],
  epfEnrolled: boolean,
  cfg: CtcConfig,
): { basePay: number; specialAllowance: number } | null {
  const basePay = round2(targetMonthlyCtc * (cfg.basic_pct / 100));
  const ctcOf = (special: number) => ctcLines(basePay, components, epfEnrolled, cfg, special).ctcMonthly;
  if (ctcOf(0) > targetMonthlyCtc + 0.5) return null; // infeasible: committed cost already exceeds the target
  let lo = 0, hi = targetMonthlyCtc; // root is in [0, target] since d(ctc)/d(special) >= 1
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (ctcOf(mid) < targetMonthlyCtc) lo = mid; else hi = mid;
  }
  return { basePay, specialAllowance: round2((lo + hi) / 2) };
}

// Whole calendar months from `fromMs` to `toMs` (0 if to <= from). Used to size backdated-increment arrears.
export function wholeMonthsBetween(fromMs: number, toMs: number): number {
  const a = new Date(fromMs), b = new Date(toMs);
  return Math.max(0, (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()));
}

export type RunState = "DRAFT" | "REVIEW" | "APPROVED" | "PUBLISHED";

const TRANSITIONS: Record<RunState, RunState[]> = {
  DRAFT: ["REVIEW"],
  REVIEW: ["DRAFT", "APPROVED"],
  APPROVED: ["PUBLISHED"],
  PUBLISHED: [],
};

export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to);
}

export const isEditable = (s: RunState) => s === "DRAFT" || s === "REVIEW";

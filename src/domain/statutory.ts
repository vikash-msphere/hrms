// PURE statutory-deduction logic (ESI + Professional Tax). No I/O. Mirrors the discipline of domain/payroll.ts
// and domain/incomeTax.ts: testable, deterministic, fed by the payroll builder.

// ESI (Employees' State Insurance) contributions. ESI applies only while the monthly gross wage is at or below
// the eligibility ceiling (₹21,000 by default); above it the worker is out of ESI for the period. Per ESIC
// rules BOTH shares are rounded UP to the next rupee, computed on the same gross + ceiling.
//   - Employee share: 0.75% (default), DEDUCTED from pay.
//   - Employer share: 3.25% (default), a company COST (CTC) - not deducted, so it never touches net pay; it
//     surfaces in the CTC breakup, the increment/CTC letter annexure and the statutory remittance report.
export function esiEmployeeContribution(grossWages: number, ratePct: number, ceiling: number): number {
  if (grossWages <= 0 || grossWages > ceiling) return 0;
  return Math.ceil(grossWages * (ratePct / 100));
}

// ESI contribution period (half-open [start, end) in ms) containing `payDate`: Apr 1 - Oct 1, or Oct 1 - Apr 1.
// Eligibility is fixed at the period START, so a worker eligible then keeps contributing to the period end even
// after a mid-period raise past the ceiling; the payroll build uses this window to carry that stickiness.
export function esiContributionPeriod(payDate: Date): { start: number; end: number } {
  const y = payDate.getUTCFullYear();
  const m = payDate.getUTCMonth(); // 0=Jan
  if (m >= 3 && m <= 8) return { start: Date.UTC(y, 3, 1), end: Date.UTC(y, 9, 1) }; // Apr..Sep
  const startYear = m >= 9 ? y : y - 1; // Oct..Dec start this year; Jan..Mar belong to the prior Oct
  return { start: Date.UTC(startYear, 9, 1), end: Date.UTC(startYear + 1, 3, 1) }; // Oct..Mar
}

// Employer's ESI share (CTC cost). Same eligibility gate + rounding as the employee share, only a different
// rate (default 3.25%). Single source for every CTC/remittance surface so the figure never drifts.
export function esiEmployerContribution(grossWages: number, ratePct: number, ceiling: number): number {
  if (grossWages <= 0 || grossWages > ceiling) return 0;
  return Math.ceil(grossWages * (ratePct / 100));
}

// Professional Tax: a flat monthly amount chosen from ascending slabs by monthly gross wage. State-specific,
// so the slab table is configurable (settings). Each slab is { up_to, amount }; the first slab whose `up_to`
// is null (open-ended top) or >= the gross gives the deduction. A common case (e.g. Karnataka) is nil up to
// ₹25,000 and ₹200 above. (Some states - Maharashtra - charge a higher amount in one month; model that as a
// separate slab set later if needed.)
// `annual_cap` is the ceiling on a financial year's total PT for one employee. Article 276(2) of the
// Constitution caps professional tax at ₹2,500 a year, and every state act sits under it, so the payroll build
// stops charging once the year's collection reaches the cap. null disables the check.
export type PtSlab = { up_to: number | null; amount: number };
export type PtConfig = { slabs: PtSlab[]; annual_cap?: number | null };

export const DEFAULT_PT_CONFIG: PtConfig = {
  slabs: [
    { up_to: 25000, amount: 0 },
    { up_to: null, amount: 200 },
  ],
  annual_cap: 2500,
};

// Slabs are matched in ASCENDING order; the table is HR-editable settings data, so sort rather than trust the
// stored order - a top (`up_to: null`) slab listed first would otherwise charge its amount to every wage.
export function professionalTax(grossWages: number, cfg: PtConfig): number {
  if (grossWages <= 0) return 0;
  // A STORED BLOB CAN BE PARTIAL, and this used to spread whatever it found. `getSettingValue` merges the
  // settings row over the default SHALLOWLY, so `{"annual_cap": 2500}` leaves `slabs` undefined and
  // `[...undefined]` is a TypeError - a 500 on every payroll build and every full-and-final, from a settings
  // edit. The settings validator (routes/settings.ts validateProfessionalTax) is the first line; this says
  // which key is at fault for a row written before it existed, instead of a bare spread failure.
  if (!Array.isArray(cfg?.slabs) || !cfg.slabs.length) {
    throw new Error("settings/professional-tax has no `slabs` table: a stored blob REPLACES the default rather than merging into it, so it must carry the whole slab table.");
  }
  for (const s of [...cfg.slabs].sort((a, b) => (a.up_to ?? Infinity) - (b.up_to ?? Infinity))) {
    if (s.up_to == null || grossWages <= s.up_to) {
      // `Math.max(0, undefined)` is NaN, which rides silently onto the PT line of a payslip. A slab with no
      // amount is a broken table, not a zero.
      if (!Number.isFinite(s.amount)) throw new Error(`settings/professional-tax slab (up_to=${String(s.up_to)}) has no numeric \`amount\`.`);
      return Math.max(0, s.amount);
    }
  }
  return 0;
}

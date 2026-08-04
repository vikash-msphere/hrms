// Pure India income-tax calculation (NEW REGIME). No I/O - inputs in, numbers out; safe to unit-test and to
// call from a service (the single-source gate only forbids importing the AUTHZ engine, not domain calc).
//
// Faithful to the official incometaxindia.gov.in calculator's client-side logic (decoded): for the new
// regime the pipeline is slab tax -> rebate u/s 87A (with marginal relief) -> surcharge (with marginal
// relief, capped at 25% in the new regime) -> 4% health & education cess. Config is DATA, keyed by regime and
// stamped with the assessment year, so the yearly Budget change is a settings edit and an "old" regime can be
// added later without touching this code (only `new` is implemented today).

export type Slab = { upTo: number | null; rate: number }; // rate is a percent; upTo null = the top band
export type RegimeConfig = {
  label: string;
  standardDeduction: number;
  slabs: Slab[];
  rebate87A: { taxableLimit: number; maxRebate: number; marginalRelief: boolean };
  surcharge: { over: number; rate: number }[]; // ascending by `over`; rate is a percent
  cessRate: number; // percent
};
export type TaxConfig = {
  assessmentYear: string; // e.g. "2026-27"
  financialYear: string; // e.g. "2025-26"
  regimes: Record<string, RegimeConfig>;
};

// Seed / fail-closed fallback - the latest concrete new-regime slabs (FY 2025-26 / AY 2026-27). The DB
// `tax-config` settings row is the runtime source of truth; identical values so a missing row never changes
// behavior. Update this (and the row) each Budget; add an `old` regime here when it's implemented.
export const DEFAULT_TAX_CONFIG: TaxConfig = {
  assessmentYear: "2026-27",
  financialYear: "2025-26",
  regimes: {
    new: {
      label: "New regime",
      standardDeduction: 75000,
      slabs: [
        { upTo: 400000, rate: 0 },
        { upTo: 800000, rate: 5 },
        { upTo: 1200000, rate: 10 },
        { upTo: 1600000, rate: 15 },
        { upTo: 2000000, rate: 20 },
        { upTo: 2400000, rate: 25 },
        { upTo: null, rate: 30 },
      ],
      rebate87A: { taxableLimit: 1200000, maxRebate: 60000, marginalRelief: true },
      surcharge: [
        { over: 5000000, rate: 10 },
        { over: 10000000, rate: 15 },
        { over: 20000000, rate: 25 },
      ],
      cessRate: 4,
    },
  },
};

const r0 = (n: number) => Math.round(n);

export type SlabRow = { from: number; to: number | null; rate: number; amount: number };

// Progressive slab tax + a per-band breakdown (only bands that contribute).
// Slabs/surcharge bands MUST be walked in ascending order; the stored config is HR-editable data, so sort
// rather than trust the array's order. An out-of-order band would otherwise silently tax the whole income at
// the wrong rate (a top band listed first caps every lower band out of the walk).
const ascSlabs = (slabs: Slab[]): Slab[] => [...slabs].sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity));

export function slabTax(taxable: number, cfg: RegimeConfig): { tax: number; rows: SlabRow[] } {
  let tax = 0;
  let prev = 0;
  const rows: SlabRow[] = [];
  for (const s of ascSlabs(cfg.slabs)) {
    const cap = s.upTo ?? Infinity;
    if (taxable > prev) {
      const inBand = Math.min(taxable, cap) - prev;
      const amount = inBand * (s.rate / 100);
      tax += amount;
      if (s.rate > 0) rows.push({ from: prev, to: s.upTo, rate: s.rate, amount: r0(amount) });
    }
    prev = cap;
    if (taxable <= cap) break;
  }
  return { tax: r0(tax), rows };
}

// Rebate u/s 87A. At/under the limit -> min(tax, maxRebate). Above the limit, with marginal relief, the
// rebate caps total tax growth to the income over the limit: rebate = max(tax - (taxable - limit), 0).
export function rebate87A(tax: number, taxable: number, cfg: RegimeConfig): number {
  const { taxableLimit, maxRebate, marginalRelief } = cfg.rebate87A;
  if (taxable <= taxableLimit) return Math.min(tax, maxRebate);
  if (!marginalRelief) return 0;
  return Math.max(0, tax - (taxable - taxableLimit));
}

// Surcharge on the tax-after-rebate for high incomes, with marginal relief. New regime caps the rate at 25%
// (config simply omits the 37% band). Marginal relief: (taxAfterRebate + surcharge) may not exceed the tax at
// the threshold income plus the income earned over that threshold.
export function surcharge(taxAfterRebate: number, taxable: number, cfg: RegimeConfig): number {
  const bands = [...cfg.surcharge].sort((a, b) => a.over - b.over);
  let band: { over: number; rate: number } | null = null;
  let prevBand: { over: number; rate: number } | null = null;
  for (const b of bands) if (taxable > b.over) { prevBand = band; band = b; }
  if (!band) return 0;
  const raw = taxAfterRebate * (band.rate / 100);
  // Tax payable AT the threshold, which is what relief compares against. That figure includes the surcharge
  // charged at the threshold itself: at exactly ₹1cr the income is still in the 10% band (the walk above is
  // strict `>`), so the comparison point is slab tax PLUS 10% - not the bare slab tax. Leaving the lower
  // band's surcharge out lowers the ceiling by that amount and under-withholds by lakhs for anyone sitting in
  // the relief window just above a threshold. No rebate applies at these income levels.
  const slabAtThreshold = slabTax(band.over, cfg).tax;
  const taxAtThreshold = slabAtThreshold + (prevBand ? slabAtThreshold * (prevBand.rate / 100) : 0);
  const allowedOverThreshold = taxAtThreshold + (taxable - band.over);
  const capped = Math.min(raw, allowedOverThreshold - taxAfterRebate);
  return r0(Math.max(0, capped));
}

export type TaxBreakdown = {
  grossForYear: number;
  standardDeduction: number;
  taxableIncome: number;
  slabRows: SlabRow[];
  incomeTax: number; // slab tax before rebate
  rebate: number; // 87A
  incomeTaxAfterRebate: number;
  surcharge: number;
  cess: number;
  totalTax: number;
};

// The full annual computation for one regime, mirroring the gov calculator's order.
export function computeAnnualTax(grossForYear: number, cfg: RegimeConfig): TaxBreakdown {
  const gross = Math.max(0, r0(grossForYear));
  const taxableIncome = Math.max(0, gross - cfg.standardDeduction);
  const { tax: incomeTax, rows } = slabTax(taxableIncome, cfg);
  const rebate = rebate87A(incomeTax, taxableIncome, cfg);
  const incomeTaxAfterRebate = Math.max(0, incomeTax - rebate);
  const sc = surcharge(incomeTaxAfterRebate, taxableIncome, cfg);
  const cess = r0((incomeTaxAfterRebate + sc) * (cfg.cessRate / 100));
  return {
    grossForYear: gross,
    standardDeduction: cfg.standardDeduction,
    taxableIncome,
    slabRows: rows,
    incomeTax,
    rebate,
    incomeTaxAfterRebate,
    surcharge: sc,
    cess,
    totalTax: r0(incomeTaxAfterRebate + sc + cess),
  };
}

// Even monthly TDS for the balance of the year: the tax still to collect, spread over the remaining months.
// Clamps at 0 (a pay cut or over-deduction never produces a negative deduction).
export function monthlyTds(totalTax: number, alreadyDeducted: number, remainingMonths: number): number {
  if (remainingMonths <= 0) return 0;
  return Math.max(0, r0((totalTax - alreadyDeducted) / remainingMonths));
}

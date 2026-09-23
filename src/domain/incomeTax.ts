// Pure India income-tax calculation (NEW REGIME). No I/O - inputs in, numbers out; safe to unit-test and to
// call from a service (the single-source gate only forbids importing the AUTHZ engine, not domain calc).
//
// Faithful to the official incometaxindia.gov.in calculator's client-side logic (decoded): for the new
// regime the pipeline is slab tax -> rebate u/s 87A (with marginal relief) -> surcharge (with marginal
// relief, capped at 25% in the new regime) -> 4% health & education cess. Slab rates, the standard deduction,
// the rebate and the surcharge bands are all DATA, stamped with the assessment year, so the yearly Budget
// change is a settings edit.
//
// Only the NEW regime is implemented, and adding an "old" one is NOT a settings edit. The old regime's charge
// depends on machinery this module does not have and this system does not collect: the s.16(iii) professional
// tax deduction from salary income, the s.10(13A) house rent allowance exemption (which needs rent paid and a
// metro flag per employee), leave travel concession, and its own standard-deduction figure. A regime block
// dropped into settings would be taxed as if none of those existed, over-withholding from every employee on
// it - so `assertSupportedRegime` refuses one instead of computing a wrong number quietly.

export type Slab = { upTo: number | null; rate: number }; // rate is a percent; upTo null = the top band
export type RegimeConfig = {
  label: string;
  standardDeduction: number;
  slabs: Slab[];
  rebate87A: { taxableLimit: number; maxRebate: number; marginalRelief: boolean };
  surcharge: { over: number; rate: number }[]; // ascending by `over`; rate is a percent
  cessRate: number; // percent
  // Chapter VI-A: which sections this regime allows a VERIFIED declaration to reduce income by, and the annual
  // cap per section. `deductionSections` omitted = every declared section counts (an old-regime block);
  // `[]` = none at all. The new regime lists only the handful that survive it (80CCD(2), 80CCH). A section with
  // no entry in `sectionCaps` is uncapped, so an org can add one without touching this code.
  deductionSections?: string[];
  sectionCaps?: Record<string, number>;
};
export type TaxConfig = {
  // The VINTAGE STAMP of the slab table below: which financial year this Budget legislated for, and its
  // assessment year. It is NOT the year being withheld for - that is always derived from the payroll period's
  // own dates (`fyWindow`), so a config left at last Budget's vintage still withholds against the right
  // window. What the stamp is for is telling a human WHICH Budget's numbers are loaded, so a stale table is
  // visible instead of silent. `fyLabels` builds both strings from one start year; never hand-write them
  // separately, or the pair drifts.
  assessmentYear: string; // e.g. "2026-27"
  financialYear: string; // e.g. "2025-26"
  regimes: Record<string, RegimeConfig>;
};

// India financial year labels for a year starting 1 April `startYear`: FY "2025-26" and its AY "2026-27".
// One function so the two strings can never disagree, wherever they are produced (this seed, `fyWindow`,
// the bootstrap generator, preflight).
export function fyLabels(startYear: number): { financialYear: string; assessmentYear: string } {
  const yy = (n: number) => String(n % 100).padStart(2, "0");
  return { financialYear: `${startYear}-${yy(startYear + 1)}`, assessmentYear: `${startYear + 1}-${yy(startYear + 2)}` };
}

// Which financial year's charge the slab table below encodes. Bump it in the SAME edit that changes the
// slabs, rebate, standard deduction or surcharge bands - the stamp is only useful if it is true.
// `scripts/preflight.ts` compares it against the financial year being deployed into and REFUSES the deploy
// when the table is a year behind, because withholding at a superseded table is silent (the FY window comes
// from the payroll period's dates, so only the rates are wrong).
//
// A year in which the Budget leaves the new regime alone still moves this stamp, and moving it is the whole
// work of that year's update: the stamp asserts "this table is the charge in force for that FY", not "these
// numbers were legislated that year". Left behind on the theory that unchanged numbers need no edit, it
// blocks every deploy from April onward for a table that is in fact correct - and the way past that block is
// to bump the stamp, which is this line.
export const DEFAULT_TAX_FY_START_YEAR = 2026; // FY 2026-27 / AY 2027-28

// Seed / fail-closed fallback - the new-regime charge in force for FY 2026-27 / AY 2027-28. The DB
// `tax-config` settings row is the runtime source of truth; identical values so a missing row never changes
// behavior. Update this (and the row) each Budget; add an `old` regime here when it's implemented.
//
// The slabs, standard deduction, rebate and surcharge bands are the ones Budget 2025 set for FY 2025-26 and
// Budget 2026 carried forward unchanged, so this table is a year older than its stamp by design.
export const DEFAULT_TAX_CONFIG: TaxConfig = {
  ...fyLabels(DEFAULT_TAX_FY_START_YEAR),
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
      // The new regime disallows Chapter VI-A save for the employer's NPS contribution u/s 80CCD(2) and the
      // Agniveer Corpus Fund u/s 80CCH, so only those two reduce withholding here.
      deductionSections: ["80CCD(2)", "80CCH"],
      sectionCaps: {},
    },
  },
};

// Sections whose statutory annual cap is fixed enough to seed. Used by any regime that allows Chapter VI-A
// (an "old" regime block added to the settings row can point `sectionCaps` at these).
export const COMMON_SECTION_CAPS: Record<string, number> = {
  "80C": 150000,
  "80CCC": 150000,
  "80CCD(1B)": 50000,
  "80D": 25000,
  "80DD": 75000,
  "80DDB": 40000,
  "80TTA": 10000,
  "80TTB": 50000,
  "80U": 75000,
};

const r0 = (n: number) => Math.round(n);

// Regimes this module can actually compute. Kept as data next to the pipeline it describes, so adding old-regime
// support means implementing the exemptions AND listing it here, in one place.
export const SUPPORTED_REGIMES = ["new"] as const;

// Throws when a configured regime is one this module cannot compute correctly (see the header). The caller
// resolving a regime name from settings calls this before withholding anything: failing the payroll build is
// recoverable, silently over-taxing a year of payslips is not.
export function assertSupportedRegime(regime: string): void {
  if (!(SUPPORTED_REGIMES as readonly string[]).includes(regime)) {
    throw new Error(
      `income tax regime "${regime}" is configured but not implemented: only ${SUPPORTED_REGIMES.join(", ")} is supported. ` +
      "The old regime needs the s.16(iii), s.10(13A) and LTA exemptions, which this build does not compute - " +
      "set the TDS pay component's regime back to \"new\" rather than withholding a figure that ignores them.",
    );
  }
}

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

// The Chapter VI-A deduction a regime actually allows, from the employee's VERIFIED declarations keyed by
// section. Sections the regime doesn't list are dropped; the rest are capped by `sectionCaps`. Pure, so the
// projection, the payroll build and the Tax page all reduce income by exactly the same figure.
/** `cap` is the regime's limit for the section, null where it has none. Carried so a reader can be told "you
 *  have declared 60,000 of a 150,000 limit" - a figure the app has always known and never stated, and the
 *  only form of this that is useful BEFORE the window shuts. */
export type DeductionRow = { section: string; declared: number; allowed: number; cap: number | null };

/** A capped section the employee has declared NOTHING against. Reported separately from `rows` rather than as
 *  a zero row, so no existing reader's list changes shape - and it is the case the reminder is most useful
 *  for, since somebody who has declared nothing is exactly who does not know they could. */
export type DeductionHeadroom = { section: string; cap: number; declared: number; remaining: number };

export function allowedDeductions(bySection: Record<string, number>, cfg: RegimeConfig): { total: number; rows: DeductionRow[]; headroom: DeductionHeadroom[] } {
  const rows: DeductionRow[] = [];
  const permittedIn = (section: string) => !cfg.deductionSections || cfg.deductionSections.includes(section);
  for (const [section, declared] of Object.entries(bySection)) {
    const amount = Math.max(0, declared);
    if (!amount) continue;
    const permitted = permittedIn(section);
    const cap = cfg.sectionCaps?.[section];
    const allowed = !permitted ? 0 : cap != null ? Math.min(amount, cap) : amount;
    rows.push({ section, declared: amount, allowed: r0(allowed), cap: permitted && cap != null ? cap : null });
  }
  rows.sort((a, b) => a.section.localeCompare(b.section));

  // Every capped section this regime allows, with what is left in it. An UNCAPPED section has no headroom to
  // report - "unlimited minus what you used" is not a number anybody can act on - and a section the regime
  // disallows is not an opportunity, so neither appears.
  const headroom: DeductionHeadroom[] = Object.entries(cfg.sectionCaps ?? {})
    .filter(([section]) => permittedIn(section))
    .map(([section, cap]) => {
      const declared = Math.max(0, bySection[section] ?? 0);
      return { section, cap, declared: r0(declared), remaining: r0(Math.max(0, cap - declared)) };
    })
    .filter((h) => h.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining); // most left first: the biggest opportunity is the useful one
  return { total: r0(rows.reduce((s, r) => s + r.allowed, 0)), rows, headroom };
}

export type TaxBreakdown = {
  grossForYear: number;
  standardDeduction: number;
  chapterVIA: number; // Chapter VI-A deductions allowed by the regime (0 when none apply)
  taxableIncome: number;
  slabRows: SlabRow[];
  incomeTax: number; // slab tax before rebate
  rebate: number; // 87A
  incomeTaxAfterRebate: number;
  surcharge: number;
  cess: number;
  totalTax: number;
};

/**
 * Refuse a regime block whose numbers are not numbers, the way `assertSupportedRegime` refuses one this module
 * cannot compute.
 *
 * `getSettingValue` merges a stored `tax-config` over the default SHALLOWLY, so a row that sets `regimes` at
 * all replaces the whole default map: a block written with only `slabs` arrives here with `standardDeduction`
 * undefined. The arithmetic then did something worse than fail - `gross - undefined` is NaN, `Math.max(0, NaN)`
 * is NaN rather than 0 (the "clamps at 0" comments notwithstanding), every later step propagates it, and
 * `services/payroll.ts` drops the TDS line on `tax > 0`, which NaN fails. The result was a month of payslips
 * with no income tax withheld, no error and no audit signal.
 *
 * The settings validator (routes/settings.ts validateTaxConfig) is the first line and stops this being
 * storable. This is the second, because the config also reaches here from a row written before that validator
 * existed - and `domain/money.ts` already states the rule this breaks: a money helper whose failure mode is
 * "returns zero without saying so" is the exact shape these functions exist to prevent.
 */
export function assertComputableRegime(cfg: RegimeConfig | undefined | null): asserts cfg is RegimeConfig {
  const bad: string[] = [];
  if (!cfg || typeof cfg !== "object") throw new Error("income tax config: no regime block to compute with (settings/tax-config replaced the default regimes map without providing one)");
  if (!Number.isFinite(cfg.standardDeduction)) bad.push("standardDeduction");
  if (!Number.isFinite(cfg.cessRate)) bad.push("cessRate");
  if (!Array.isArray(cfg.slabs) || !cfg.slabs.length || cfg.slabs.some((s) => !Number.isFinite(s?.rate))) bad.push("slabs");
  if (!cfg.rebate87A || !Number.isFinite(cfg.rebate87A.taxableLimit) || !Number.isFinite(cfg.rebate87A.maxRebate)) bad.push("rebate87A");
  if (!Array.isArray(cfg.surcharge)) bad.push("surcharge");
  if (bad.length) {
    throw new Error(
      `income tax config is incomplete: ${bad.join(", ")} ${bad.length === 1 ? "is" : "are"} missing or not a number. ` +
      "settings/tax-config is merged over the defaults SHALLOWLY, so a stored `regimes` block must carry every field, not only the ones being changed. " +
      "Failing the payroll build is recoverable; withholding nothing without saying so is not.",
    );
  }
}

// The full annual computation for one regime, mirroring the gov calculator's order. `chapterVIA` is the already
// regime-filtered, already-capped deduction total (see allowedDeductions) and comes off after the standard
// deduction, before the slab walk.
export function computeAnnualTax(grossForYear: number, cfg: RegimeConfig, chapterVIA = 0): TaxBreakdown {
  assertComputableRegime(cfg);
  const gross = Math.max(0, r0(grossForYear));
  const deductions = Math.max(0, r0(chapterVIA));
  const taxableIncome = Math.max(0, gross - cfg.standardDeduction - deductions);
  const { tax: incomeTax, rows } = slabTax(taxableIncome, cfg);
  const rebate = rebate87A(incomeTax, taxableIncome, cfg);
  const incomeTaxAfterRebate = Math.max(0, incomeTax - rebate);
  const sc = surcharge(incomeTaxAfterRebate, taxableIncome, cfg);
  const cess = r0((incomeTaxAfterRebate + sc) * (cfg.cessRate / 100));
  return {
    grossForYear: gross,
    standardDeduction: cfg.standardDeduction,
    chapterVIA: deductions,
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
  // `Math.max(0, NaN)` is NaN, so the clamp on the next line is not one on its own - and a NaN that reaches
  // `services/payroll.ts` drops the TDS line silently (`tax > 0` is false for NaN). Nothing should get here
  // with a non-finite figure now that `computeAnnualTax` refuses an incomplete config, which is exactly why an
  // arrival is worth a throw rather than a zero.
  const due = (totalTax - alreadyDeducted) / remainingMonths;
  if (!Number.isFinite(due)) throw new Error(`monthlyTds: non-finite figure (totalTax=${totalTax}, alreadyDeducted=${alreadyDeducted}, remainingMonths=${remainingMonths})`);
  return Math.max(0, r0(due));
}

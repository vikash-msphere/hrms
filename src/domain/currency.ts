// Per-currency display/payout precision. Storage stays full precision (money is `real`, rounded to 2dp/paise
// by round2 - see money.ts and the schema monetary invariant); this module decides how many decimal places a
// currency is SHOWN and PAID in. Rounding is a presentation/output concern only: the DB keeps paise, while
// payslips, letters, the web UI and the bank payout file quantize to the currency's minor units.
//
// The org can override any currency's precision via settings/organization.currency_decimals (a
// { [code]: decimals } map edited in Settings -> Organization). Absent an override, the base table below
// applies, then a 2dp fallback. INR defaults to 0 (whole rupees) - the app's convention and the common Indian
// payroll expectation - overridable to 2 if an org wants paise on screen.

export type CurrencyDecimals = Record<string, number>;

// App default minor-unit digits by ISO 4217 code. Only the exceptions to the 2dp norm are listed (plus INR,
// which we default to 0 by app convention). Everything else falls through to DEFAULT_DECIMALS.
const BASE_DECIMALS: CurrencyDecimals = {
  INR: 0, // app convention: whole rupees (override to 2 for paise)
  // Zero-decimal ISO currencies.
  JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, HUF: 0, TWD: 0, UGX: 0, XAF: 0, XOF: 0, XPF: 0, RWF: 0, PYG: 0, KMF: 0, DJF: 0, BIF: 0, GNF: 0, VUV: 0,
  // Three-decimal ISO currencies.
  BHD: 3, KWD: 3, OMR: 3, TND: 3, JOD: 3, IQD: 3, LYD: 3,
};
const DEFAULT_DECIMALS = 2;

// Resolve the decimal places for a currency: org override first, then the app base table, then 2. Clamped to
// [0, 4] so a bad config can't produce nonsense precision.
export function decimalsFor(code: string | null | undefined, cfg?: CurrencyDecimals | null): number {
  const c = (code || "INR").toUpperCase();
  const raw = cfg && Object.prototype.hasOwnProperty.call(cfg, c) ? cfg[c] : (c in BASE_DECIMALS ? BASE_DECIMALS[c] : DEFAULT_DECIMALS);
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_DECIMALS;
  return Math.min(4, Math.max(0, Math.trunc(n)));
}

// Round an amount to a currency's display/payout precision, decimal-half-correct (same scaling trick as
// round2, generalised to any dp). Use at OUTPUT boundaries only - the bank payout file, and any figure being
// rendered. Never for stored values.
export function roundMoney(n: number, decimals: number): number {
  if (!Number.isFinite(n)) return 0;
  const dp = Math.min(4, Math.max(0, Math.trunc(decimals)));
  if (Math.abs(n) < Math.pow(10, -dp) / 2) return 0;
  return Number(`${Math.round(Number(`${n}e${dp}`))}e-${dp}`);
}

// Default org config: INR shown in whole rupees out of the box. Merged under any stored currency_decimals.
export const DEFAULT_CURRENCY_DECIMALS: CurrencyDecimals = { INR: 0 };

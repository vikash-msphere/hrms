// The ONE money-rounding helper. Money + leave-day values are stored as `real` (IEEE-754); every computed
// value must pass through `round2` before it is stored, summed, or displayed (the monetary invariant, see
// schema.ts header). This replaces the 9 copies of `Math.round(n * 100) / 100` that used to live inline in the
// domain + services, so rounding behaviour is defined in exactly one place.
//
// Why not plain `Math.round(n * 100) / 100`: the multiply happens in float, so a decimal half-case rounds the
// WRONG way — `1.005 * 100` is `100.4999999999`, which `Math.round`s DOWN to `100` (→ 1.00) instead of `101`
// (→ 1.01). Scaling via the decimal string (`` `${n}e2` ``) makes the parser produce the nearest double to the
// intended DECIMAL (100.5, exactly representable), so the half-case rounds as a human expects.
//
// TIES GO AWAY FROM ZERO, not toward +∞. `Math.round` breaks a tie upward on the NUMBER LINE, which means
// -1.005 rounds to -1.00 while +1.005 rounds to +1.01 - the same half-paise treated as a rounding-up on one
// sign and a rounding-down on the other. That asymmetry is invisible while every amount is positive, and this
// codebase does not keep them positive: loss of pay is priced as a NEGATIVE earning (domain/payroll.ts), a
// correction to a past compensation row and a settlement clawback are negative, and `sum2` rounds a total that
// can land on either side of zero. Half away from zero is the rule accounting states and the one a person
// checking the arithmetic by hand applies to both columns, so the magnitude of a half-case rounds up whichever
// direction it points.

// Round to 2 decimal places (paise), decimal-half-correct and sign-symmetric. Non-finite / sub-paise noise
// collapses to 0 (also dodges the exponential-string edge for |n| < 1e-6, which is already 0 at 2dp).
// The decimal-string trick below only works while `n` stringifies in POSITIONAL notation. JS switches to
// exponential at both ends of the range, and `${1e21}e2` parses as NaN - so both ends need a guard, not just
// the small one. Under 1e-6 the answer is 0 at 2dp anyway; at or above 1e21 there is no meaningful paise value
// to return, and Math.round is the honest fallback (it cannot be a decimal half-case at that magnitude).
const EXP_MAX = 1e21;
export function round2(n: number): number {
  if (!Number.isFinite(n) || Math.abs(n) < 1e-6) return 0;
  if (Math.abs(n) >= EXP_MAX) return Math.round(n);
  // Rounded on the MAGNITUDE and the sign reapplied, which is what makes the tie symmetric. `-0` cannot
  // survive: `${-0}e-2` parses back as -0, and a stored -0 compares equal to 0 but prints as "-0" on a
  // payslip. The `|| 0` normalises it.
  const scaled = Number(`${n}e2`);
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled));
  return Number(`${rounded}e-2`) || 0;
}

// Sum a list of amounts and round ONCE at the end. Use for every aggregate (run totals, bank-file total,
// settlement net, FY/YTD): summing already-rounded floats can still drift a sub-paise over many rows, and a
// single trailing round2 pins the total to the paise it should be.
export function sum2(xs: number[]): number {
  return round2(xs.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0));
}

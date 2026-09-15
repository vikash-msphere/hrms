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

// Round to 2 decimal places (paise), decimal-half-correct and sign-symmetric. Sub-paise noise collapses to 0
// (which also dodges the exponential-string edge for |n| < 1e-6, already 0 at 2dp).
//
// A NON-FINITE ARRIVAL THROWS, and this is the one case where that is the point of the function rather than a
// detail of it. It used to answer 0 for NaN and Infinity - which is the exact failure the header below names
// ("a money helper whose failure mode is 'returns zero without saying so'"), reached the ordinary way: a
// float accumulator that overflows. `sum2([1e308, 1e308])` is Infinity, and the total therefore read as 0
// with the rows still on the books; `services/expenseBudgets.ts#computeBudgetSpendMany` accumulates SUBMITTED
// expenses into a plain `+=` before rounding, so two absurd claims made a budget report `pending: 0`,
// `remaining: the whole cap` and never tripped `checkBudgetThresholds`. Nothing legitimate is non-finite at
// this point, so an arrival is worth a throw rather than a zero - the same call domain/incomeTax.ts#monthlyTds
// makes, in the same words. The inputs are bounded too (`money()` in http/moneyField.ts), so this is the
// backstop under that, not the only line of defence.
//
// LARGE-BUT-FINITE IS NOT THE SAME CASE and deliberately still passes through: returning the value is the only
// honest answer there, and returning 0 would be money vanishing without an error.
//
// The decimal-string trick only works while the number being stringified is in POSITIONAL notation; JS
// switches to exponential at 1e21, and `${1e21}e2` parses as NaN. THERE ARE TWO SUCH STRINGIFICATIONS, not
// one, and they switch at different inputs: `${n}e2` goes exponential at n = 1e21, but `${rounded}e-2` goes
// exponential at rounded = 1e21, i.e. at n = 1e19. A single guard on `n >= 1e21` therefore left a two-decade
// hole beneath itself in which the SECOND parse produced NaN and `|| 0` turned it into a silent ZERO -
// round2(5e20) answered 0. Nothing legitimate reaches that magnitude, but a money helper whose failure mode
// is "returns zero without saying so" is the exact shape this function exists to prevent.
//
// So the guard is not a threshold to keep in sync with the language's switch point: each parse is CHECKED,
// where it happens. Past either one there is no meaningful paise value to return and Math.round is the honest
// fallback - at that magnitude the value cannot be a decimal half-case anyway.
export function round2(n: number): number {
  if (!Number.isFinite(n)) throw new Error(`round2: non-finite figure (${n}) - a money value overflowed or was never a number`);
  if (Math.abs(n) < 1e-6) return 0;
  const scaled = Number(`${n}e2`);
  if (!Number.isFinite(scaled)) return Math.round(n);
  // Rounded on the MAGNITUDE and the sign reapplied, which is what makes the tie symmetric. `-0` cannot
  // survive: `${-0}e-2` parses back as -0, and a stored -0 compares equal to 0 but prints as "-0" on a
  // payslip. The `|| 0` normalises it.
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled));
  const back = Number(`${rounded}e-2`);
  return Number.isFinite(back) ? back || 0 : Math.round(n);
}

// Sum a list of amounts and round ONCE at the end. Use for every aggregate (run totals, bank-file total,
// settlement net, FY/YTD): summing already-rounded floats can still drift a sub-paise over many rows, and a
// single trailing round2 pins the total to the paise it should be.
export function sum2(xs: number[]): number {
  // A non-finite ELEMENT is dropped rather than thrown on: a missing line is `undefined` in more than one
  // caller and has always meant "nothing to add". A non-finite TOTAL is a different statement - every element
  // was a real number and their sum left the range - and `round2` throws on it, which is what stops an
  // overflowed total reading as 0.
  return round2(xs.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0));
}

// Bounded zod fields for money and day counts, so the next one cannot be written bare.
//
// `routes/loans.ts` identified this hazard and fixed it for loans alone, with the reasoning written out: a
// bare `z.number()` accepts Infinity (JSON cannot carry it, but a non-JSON caller can) and has no upper bound
// at all. Every other money input in the app kept the bare form, and `1e308` is an ordinary JSON number that
// passes `.positive()`.
//
// THE DAMAGE IS NOT THE ONE HUGE ROW, IT IS THE NEXT AGGREGATE OVER IT. Every money total in the app is a
// `sum2` or a `round2` over a plain `+=`, and a float accumulator that passes 1.8e308 becomes Infinity. The
// worked case is `services/expenseBudgets.ts#computeBudgetSpendMany`: `STATES_CHARGED` includes SUBMITTED, so
// an employee charges `pending` with no approver involved, and two submissions of 1e308 against one
// department/period overflowed the accumulator - after which the budget reported `pending: 0`,
// `remaining: the whole cap`, `utilization: 0`, and `checkBudgetThresholds` never fired. `domain/money.ts`
// now throws on a non-finite figure rather than answering 0, which is the backstop; this is the fence.
//
// THE CEILINGS ARE SANITY, NOT POLICY, exactly as loans puts it: a figure past them is a typo rather than an
// amount. Real limits (an approval threshold, a band ceiling, an encashment cap) belong to the org and live in
// settings, never in a schema.
import { z } from "zod";

/** Past this, the figure is a typo rather than money. Matches the bound `routes/loans.ts` already chose. */
export const MAX_MONEY = 1_000_000_000;

/** Past this, the figure is a typo rather than a number of days (about 27 years). */
export const MAX_DAYS = 10_000;

/** A money amount that must be strictly positive (an expense, a claim, an award). */
export const positiveMoney = () => z.number().finite().positive().max(MAX_MONEY);

/** A money amount that may be zero (a tax component, a cost that does not apply). */
export const nonNegativeMoney = () => z.number().finite().nonnegative().max(MAX_MONEY);

/**
 * A money amount that may be NEGATIVE. Not the common case: it is for the figures this app deliberately keeps
 * signed - a correction to a past compensation row, a settlement clawback - which `domain/money.ts` documents
 * as the reason its rounding is sign-symmetric.
 */
export const signedMoney = () => z.number().finite().min(-MAX_MONEY).max(MAX_MONEY);

/** A count of days that must be strictly positive (leave encashed, notice served). */
export const positiveDays = () => z.number().finite().positive().max(MAX_DAYS);

/** A count of days that may be zero (an opening leave balance, days already encashed). */
export const nonNegativeDays = () => z.number().finite().nonnegative().max(MAX_DAYS);

/** A SIGNED change in days (a leave balance correction: positive adds, negative takes off). */
export const signedDays = () => z.number().finite().min(-MAX_DAYS).max(MAX_DAYS);

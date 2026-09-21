// Loss of pay that changed after the period closed.
//
// THE HOLE THIS FILLS. With `lop_enabled`, approved leave and attendance punches decide how many day-units a
// period docks. Both can move AFTER that period's run has published: leave approved retroactively excuses a
// day already docked, a regularization fixes a punch, an HR day-mark re-values a day. Every other
// income-affecting input that lands late is queued and paid by the next run (`paid_run_id` on bonuses,
// encashments, overtime, claims) or routed to arrears (a back-dated compensation revision). Loss of pay had
// neither, so the published payslip and the live attendance record simply disagreed, and nothing reconciled
// them.
//
// WHY CARRY AND NOT REFUSE. The alternative was to refuse the leave approval once the period published. That
// protects payroll by making the attendance record lie: the leave was genuinely taken, and a system that
// declines to record it so that a number stays tidy has corrupted the more important of the two. So the fact
// lands, and the money follows it into the next run - which is exactly how this app already treats every
// other late-arriving payable.
//
// RECOMPUTED, NOT ACCUMULATED. An adjustment states "this closed period should have docked X day-units; the
// run docked Y; the difference is owed". It is recalculated from scratch whenever the period's attendance
// changes again and REPLACES the previous figure rather than adding to it. Three retroactive approvals
// against one period therefore leave one adjustment worth three days, never three adjustments racing each
// other - the same property that makes `arrears_periods_json` safe to recompute.
import { round2 } from "./money";

/** What a closed period docked, what it should have docked, and what has already been settled - all in
 *  day-units. */
export type LopRestatement = {
  /** Day-units the published run actually charged (from its own `LOP` line). A historical fact: it never
   *  changes, whatever happens to the attendance afterwards. */
  charged: number;
  /** Day-units the period's attendance says it should have charged, recomputed now. */
  correct: number;
  /**
   * Day-units already PAID OUT as corrections for this same period, signed the same way as `dayUnits`.
   *
   * WITHOUT THIS THE SECOND CORRECTION DOUBLE-PAYS, and the reason is worth stating because the rest of the
   * design hides it. `charged` never moves, so `charged - correct` is always the TOTAL correction for the
   * period - and the open-row uniqueness index is partial on `paid_run_id is null`, which correctly permits
   * a new open row once the previous one has been paid. Put together: dock 2, correct to 1, pay 1; correct
   * again to 0, and the total is restated as 2 and paid a second time. Three units out for a two-unit
   * correction.
   *
   * Netting it here rather than in the service is the same argument as `recoverableFrom`: the residual is
   * arithmetic, and arithmetic that can be got wrong belongs where a test can reach it without a database.
   */
  settled: number;
};

export type LopAdjustment = {
  /** Positive = the employee is owed money back (the run over-docked). Negative = they owe (it under-docked). */
  dayUnits: number;
  amount: number;
};

/**
 * The correction owed for one closed period, priced at `dailyRate`.
 *
 * A DAILY RATE, NOT A WAGE AND A BASIS, and that is a correctness choice rather than a simplification. The
 * rate belongs to the CLOSED period: the caller reads it off that run's own loss-of-pay line
 * (amount / units), so the wage, the divisor, the proration factor and the `lop_basis` that produced it are
 * already baked into one number. Taking a wage and a basis here would invite pricing an old period with
 * TODAY's configuration - an org that switched `lop_basis` from working-days to days-30 after March closed
 * would refund March at a rate it never docked at, and the refund would not equal what was taken.
 *
 * Returns null when nothing is owed, so a caller can delete the adjustment row rather than store a zero -
 * a zero adjustment on a payslip is a line that says nothing happened, which is worse than no line.
 */
export function lopAdjustment(r: LopRestatement, dailyRate: number): LopAdjustment | null {
  // The RESIDUAL, not the total. Positive when the run docked more than it should have, which is money back
  // to the employee; `settled` carries the same sign, so subtracting it leaves only what is still owed.
  //
  // This is also what makes a correction REVERSIBLE. Attendance can move back: refund two days, then have
  // the leave rescinded, and the arithmetic gives (2 - 2) - 2 = -2, recovering exactly what was paid. A
  // design that clamped to positive corrections, or that stored the total and trusted nothing to change
  // twice, would leave the refund standing.
  const dayUnits = round2(r.charged - r.correct - r.settled);
  if (dayUnits === 0) return null;
  if (!(dailyRate > 0)) return null; // nothing to price the correction against
  const amount = round2(dailyRate * dayUnits);
  // A sub-paisa correction is arithmetic noise from the rate, not a debt. Returning it would put a line
  // reading 0.00 on a payslip and leave a row in the queue that can never be satisfied.
  if (amount === 0) return null;
  return { dayUnits, amount };
}

/**
 * The line this becomes on the next run.
 *
 * ONE LINE, SIGNED, and never split into an earning and a deduction depending on direction. A correction is
 * one fact about one closed period, and a payslip that shows it as "LOP refund" in some months and "LOP
 * recovery" in others makes the reader work out that they are the same thing. The sign carries the direction,
 * exactly as the reconciliation statement's movements do.
 *
 * It is an EARNING because that is the side loss of pay itself sits on - `lopDayUnits` produces a negative
 * earning, not a deduction, so a correction to it belongs on the same side or the two do not net out.
 */
export const LOP_ADJUST_CODE = "LOPADJ";

/** How the line reads on a payslip, naming the period it corrects - the whole point of the line is that it is
 *  not about this month. */
export function lopAdjustLabel(periodLabel: string, dayUnits: number): string {
  const back = dayUnits > 0;
  const days = Math.abs(dayUnits);
  const unit = days === 1 ? "day" : "days";
  return `Loss of pay ${back ? "refunded" : "recovered"} for ${periodLabel} (${days} ${unit})`;
}

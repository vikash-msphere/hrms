/// <reference types="vite/client" />
// Loss of pay corrected after the period closed.
//
// Two conventions to hold on to. POSITIVE means the run over-docked and the employee is owed money BACK -
// signed that way because loss of pay is itself a negative earning, so a correction to it lives on the same
// side or the two never net out. And the figure is a RESIDUAL, not a total: `charged` is a historical
// constant, so without netting off what has already been paid, every further attendance change would restate
// the whole correction and pay it again.
import { describe, it, expect } from "vitest";
import { lopAdjustment, lopAdjustLabel } from "../src/domain/lopAdjust";

// 30,000 a month over 20 working days.
const RATE = 1_500;

/** `settled` defaults to nothing paid yet, which is the first correction for a period. */
const state = (charged: number, correct: number, settled = 0) => ({ charged, correct, settled });

describe("lopAdjustment", () => {
  it("refunds an over-dock as a positive amount", () => {
    // Leave approved retroactively for a day already docked: the employee gets that day back.
    expect(lopAdjustment(state(2, 1), RATE)).toEqual({ dayUnits: 1, amount: 1_500 });
  });

  it("recovers an under-dock as a negative amount", () => {
    // A day that should have been docked and was not. Same line, opposite sign - never a separate "recovery"
    // concept, or a payslip shows the same fact under two names depending on which way it went.
    expect(lopAdjustment(state(0, 1), RATE)).toEqual({ dayUnits: -1, amount: -1_500 });
  });

  it("pays only the RESIDUAL once an earlier correction has been settled", () => {
    // THE DOUBLE-PAY THIS FIELD EXISTS FOR. `charged` never moves, so the naive restatement is the whole
    // correction every time. Dock 2, correct to 1, pay 1; then correct to 0. Without netting, the second
    // pass restates the total as 2 and pays it, putting 3 units out for a 2-unit correction - and the
    // open-row uniqueness index cannot catch it, because it deliberately allows a new open row once the
    // previous one is paid. Exactly the shape of the loan advance double-credit.
    const first = lopAdjustment(state(2, 1, 0), RATE)!;
    expect(first.dayUnits).toBe(1);
    const second = lopAdjustment(state(2, 0, first.dayUnits), RATE)!;
    expect(second.dayUnits).toBe(1);
    expect(first.dayUnits + second.dayUnits).toBe(2); // the true total correction, not 3
  });

  it("reverses a paid refund when the attendance change is itself undone", () => {
    // Refund two days, then the leave is rescinded. The residual goes negative and recovers exactly what was
    // paid. A design that clamped to positive corrections would leave the refund standing.
    const refund = lopAdjustment(state(2, 0, 0), RATE)!;
    expect(refund.dayUnits).toBe(2);
    const undo = lopAdjustment(state(2, 2, refund.dayUnits), RATE)!;
    expect(undo).toEqual({ dayUnits: -2, amount: -3_000 });
    expect(refund.dayUnits + undo.dayUnits).toBe(0);
  });

  it("answers null once the correction has been fully settled", () => {
    // The steady state after a correction is paid and nothing else has changed. A row here would be a debt
    // nothing can satisfy.
    expect(lopAdjustment(state(2, 1, 1), RATE)).toBeNull();
  });

  it("answers null when the period was docked correctly", () => {
    // Null rather than a zero: a zero adjustment is a payslip line saying nothing happened.
    expect(lopAdjustment(state(1.5, 1.5), RATE)).toBeNull();
  });

  it("handles a half day", () => {
    // Half-day leave and half-day holidays both produce fractional units, so nothing here may assume whole
    // days.
    expect(lopAdjustment(state(1, 0.5), RATE)).toEqual({ dayUnits: 0.5, amount: 750 });
  });

  it("answers null when there is no rate to price the correction against", () => {
    // A period whose run paid no regular earnings has no daily rate, and pricing the correction at zero
    // would silently settle a debt that still exists.
    expect(lopAdjustment(state(2, 0), 0)).toBeNull();
  });

  it("answers null when the correction rounds away to nothing", () => {
    // Sub-paisa noise from the rate, not a debt.
    expect(lopAdjustment(state(0.0001, 0), 0.01)).toBeNull();
  });

  it("prices at the rate it is given, whatever produced it", () => {
    // The caller reads the rate off the closed run's own LOP line, so the wage basis, divisor, proration and
    // `lop_basis` that produced it are already baked in. An org that changed `lop_basis` after the period
    // closed must still refund at the rate that period docked at - which is only guaranteed by this function
    // not knowing what a basis is.
    expect(lopAdjustment(state(1, 0), 1_000)).toEqual({ dayUnits: 1, amount: 1_000 });
    expect(lopAdjustment(state(1, 0), 1_500)).toEqual({ dayUnits: 1, amount: 1_500 });
  });
});

describe("lopAdjustLabel", () => {
  it("names the period it corrects and the direction", () => {
    // The whole point of the line is that it is not about this month, so the period has to be in the text.
    expect(lopAdjustLabel("March 2026", 1)).toBe("Loss of pay refunded for March 2026 (1 day)");
    expect(lopAdjustLabel("March 2026", -2)).toBe("Loss of pay recovered for March 2026 (2 days)");
  });

  it("pluralises, and never prints a negative day count", () => {
    // The sign is carried by the wording, so printing it again as "-2 days" would read as a double negative.
    expect(lopAdjustLabel("April 2026", -1)).toContain("(1 day)");
    expect(lopAdjustLabel("April 2026", 2.5)).toContain("(2.5 days)");
    expect(lopAdjustLabel("April 2026", -2)).not.toContain("-2");
  });
});

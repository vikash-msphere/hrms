/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { measuredProgress } from "../src/services/goals";
import { measuredPct } from "../web/src/lib/goalMeasure";

// The goal form shows the percentage a measure will produce BEFORE it is saved ("saving this puts you at 70%"),
// which means the client computes the same thing the server stores. Two implementations of one rule is a drift
// waiting to happen - and a preview that disagrees with what lands is worse than no preview, because it is
// believed. So the two are pinned to each other here, on the cases that actually differ between naive and
// correct: a baseline above zero, a target below the baseline (reduction goals), and the degenerate span.
//
// The web bundle can't import from src/, hence the duplicate rather than a shared module.
describe("the goal form's measure preview mirrors the server", () => {
  const cases: [number | undefined, number | undefined, number | undefined][] = [
    [undefined, 60, 42],   // plain growth from zero
    [0, 60, 0],            // nothing done yet
    [0, 60, 60],           // target reached
    [0, 60, 75],           // overshot - clamps at 100
    [8, 4, 6],             // reduction: half way down
    [8, 4, 8],             // reduction: not started
    [8, 4, 3],             // reduction: past the target
    [99, 99.9, 99.5],      // fractional span
    [10, 10, 10],          // nothing to travel: no measure
    [0, undefined, 5],     // no target: no measure
    [0, 60, undefined],    // no current value: no measure
  ];

  it("agrees on every shape a measure can take", () => {
    for (const [baseline, target, current] of cases) {
      expect(measuredPct(baseline, target, current), `baseline=${baseline} target=${target} current=${current}`).toBe(
        measuredProgress({ baselineValue: baseline ?? null, targetValue: target ?? null, currentValue: current ?? null }),
      );
    }
  });

  it("reads a reduction goal as half done at the midpoint", () => {
    // The case the naive formula (current/target) gets backwards: churn 8% -> 4%, sitting at 6%.
    expect(measuredPct(8, 4, 6)).toBe(50);
  });

  it("does not report a goal that starts above zero as nearly finished", () => {
    // Uptime 99.0 -> 99.9, still at 99.0: 0%, not 99%.
    expect(measuredPct(99, 99.9, 99)).toBe(0);
  });
});

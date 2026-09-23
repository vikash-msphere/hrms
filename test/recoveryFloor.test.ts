/// <reference types="vite/client" />
// The floor under take-home: how much of a period's pay loan and advance recovery may actually take.
//
// This is the rule that decides whether somebody is recovered down to nothing in a month, so the cases that
// matter are the ones where two exclusions interact. The bug this was written with - and which reasoning
// nearly let through - was taking the SMALLER of the two caps instead of subtracting both, which lets a
// reimbursement stand in for protected wages and recovers straight through the floor. That case is the fourth
// test, with the arithmetic spelled out, because it is the one a reader has to be able to check.
import { describe, it, expect } from "vitest";
import { recoverableFrom } from "../src/domain/loans";

describe("recoverableFrom", () => {
  it("takes the whole net when no floor is set", () => {
    // The behaviour that existed before the floor: recovery may take net to zero. An org that has set no
    // policy must get exactly the arithmetic it had, which is why 0 is the default.
    expect(recoverableFrom(40_000, 0, 50_000, 0)).toBe(40_000);
  });

  it("never garnishes a reimbursement", () => {
    // A refund is money the employee already spent out of their own pocket. Recovering a debt out of it takes
    // back something that was never pay.
    expect(recoverableFrom(45_000, 5_000, 55_000, 0)).toBe(40_000);
  });

  it("protects the floor share of wages", () => {
    // 100,000 wages, half protected: recovery may take net down to 50,000 and no further.
    expect(recoverableFrom(80_000, 0, 100_000, 0.5)).toBe(30_000);
    // ...and the recovery that follows leaves take-home exactly on the floor.
    expect(80_000 - recoverableFrom(80_000, 0, 100_000, 0.5)).toBe(50_000);
  });

  it("subtracts BOTH exclusions rather than taking the smaller", () => {
    // THE CASE THE FIRST VERSION GOT WRONG. Gross 100,000 including a 5,000 claim, so wages are 95,000 and a
    // half floor protects 47,500. Net 60,000.
    const taken = recoverableFrom(60_000, 5_000, 100_000, 0.5);
    expect(taken).toBe(7_500); // 60,000 - 5,000 - 47,500

    // Wage take-home after recovery lands ON the floor: net, less what was taken, less the refund that was
    // never wages.
    const wageTakeHome = 60_000 - taken - 5_000;
    expect(wageTakeHome).toBe(47_500);
    expect(wageTakeHome / 95_000).toBeCloseTo(0.5, 5);

    // The rejected form, kept as an assertion so the mistake cannot come back unnoticed: min(55,000, 12,500)
    // would have taken 12,500 and left wage take-home at 42,500 - 44.7% of wages, under a 50% floor.
    const wrong = Math.min(60_000 - 5_000, 60_000 - 47_500);
    expect(wrong).toBe(12_500);
    expect((60_000 - wrong - 5_000) / 95_000).toBeLessThan(0.5);
  });

  it("takes nothing when the floor already exceeds net", () => {
    // A heavily docked month: wages are high on paper but net is small after statutory deductions. Recovery
    // yields entirely rather than going negative.
    expect(recoverableFrom(20_000, 0, 100_000, 0.5)).toBe(0);
    // Never negative, whatever the inputs - a negative "available" would read as headroom to the caller.
    expect(recoverableFrom(0, 0, 100_000, 0.75)).toBe(0);
    expect(recoverableFrom(-500, 0, 100_000, 0)).toBe(0);
  });

  it("clamps a floor outside 0..1 rather than trusting it", () => {
    // A fraction stored as a PERCENTAGE is the misconfiguration that matters (50 meaning half), and it must
    // not protect fifty times the wage bill and silently collect nothing for ever.
    expect(recoverableFrom(80_000, 0, 100_000, 50)).toBe(recoverableFrom(80_000, 0, 100_000, 1));
    expect(recoverableFrom(80_000, 0, 100_000, 1)).toBe(0);
    // A negative floor protects nothing rather than inverting into extra headroom.
    expect(recoverableFrom(80_000, 0, 100_000, -1)).toBe(80_000);
  });

  it("holds when the reimbursement is the whole of net", () => {
    // A month that paid nothing but a refund: there is no wage to recover from at all.
    expect(recoverableFrom(5_000, 5_000, 5_000, 0)).toBe(0);
    expect(recoverableFrom(5_000, 5_000, 5_000, 0.5)).toBe(0);
  });

  it("rounds to the paise, so an accumulated recovery cannot drift", () => {
    const taken = recoverableFrom(1_000.005, 0.001, 1_000.004, 0.333);
    expect(Number.isFinite(taken)).toBe(true);
    expect(Math.round(taken * 100) / 100).toBe(taken);
  });
});

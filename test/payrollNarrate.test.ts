/// <reference types="vite/client" />
// The run-to-run movement, said in a sentence.
//
// Deterministic by design rather than as a fallback: the model path would need a third `CONSENTED_PATHS`
// entry because `payroll-runs` is denied, and a model rephrasing five labelled figures adds wording rather
// than information. So the sentence IS the feature, and it has to be right in the cases where a careless one
// would mislead - which is what most of these assert.
import { describe, it, expect } from "vitest";
import { narrateRun } from "../src/domain/payrollNarrate";
import type { Reconciliation } from "../src/domain/payrollReconcile";

const rec = (over: Partial<Reconciliation> = {}): Reconciliation => ({
  opening: { employees: 10, gross: 1_000_000 },
  closing: { employees: 10, gross: 1_000_000 },
  movements: [],
  residual: 0,
  headcountResidual: 0,
  ...over,
});

const mv = (key: Reconciliation["movements"][number]["key"], employees: number, amount: number) => ({ key, employees, amount });

describe("narrateRun", () => {
  it("names the direction and size of the movement", () => {
    const n = narrateRun(rec({
      closing: { employees: 11, gross: 1_080_000 },
      movements: [mv("joiners", 1, 80_000)],
    }));
    expect(n.text).toContain("up 80000");
    expect(n.text).toContain("1 joiner");
    expect(n.compared).toBe(true);
  });

  it("says a zero movement is unchanged when nothing moved underneath it", () => {
    const n = narrateRun(rec());
    expect(n.text).toContain("unchanged");
    expect(n.drivers).toEqual([]);
  });

  it("does NOT say nothing happened when offsetting movements net to zero", () => {
    // The case a careless sentence gets wrong and the reason this is not just `if (delta === 0) return
    // "unchanged"`. A raise exactly offset by a leaver reads as a quiet month to anybody looking at the
    // total, and it is the opposite of one.
    const n = narrateRun(rec({
      movements: [mv("leavers", 1, -60_000), mv("recurring", 9, 60_000)],
    }));
    expect(n.text).toContain("not because nothing moved");
    expect(n.text).toContain("1 leaver");
    expect(n.text).toContain("pay changes for 9 people");
  });

  it("orders the clauses like the statement, not by size", () => {
    // The drivers are CHOSEN by size and then re-sorted into MOVEMENT_ORDER, so a reader comparing the prose
    // with the table beside it does not have to re-map the rows.
    const n = narrateRun(rec({
      closing: { employees: 12, gross: 1_300_000 },
      movements: [mv("recurring", 8, 100_000), mv("joiners", 2, 200_000)],
    }));
    expect(n.text.indexOf("joiner")).toBeLessThan(n.text.indexOf("pay changes"));
  });

  it("names only the largest drivers and counts the rest", () => {
    const n = narrateRun(rec({
      closing: { employees: 14, gross: 1_400_000 },
      movements: [
        mv("joiners", 4, 300_000), mv("recurring", 9, 60_000), mv("added", 3, 40_000),
        mv("leavers", 1, -5_000), mv("dropped", 2, -1_000),
      ],
    }), 3);
    expect(n.text).toContain("plus 2 smaller movements");
    expect(n.text).not.toContain("one-offs ending");
  });

  it("pluralises the leftover count", () => {
    const n = narrateRun(rec({
      closing: { employees: 12, gross: 1_200_000 },
      movements: [mv("joiners", 2, 190_000), mv("recurring", 5, 10_000)],
    }), 1);
    expect(n.text).toContain("plus 1 smaller movement");
    expect(n.text).not.toContain("smaller movements");
  });

  it("ignores a movement whose amount rounds to zero, even when it has a headcount", () => {
    // Somebody joining and somebody leaving at the same wage is a real event but not a DRIVER of the total,
    // and naming it with a (+0) beside it would read as noise.
    const n = narrateRun(rec({ movements: [mv("joiners", 1, 0), mv("leavers", 1, 0)] }));
    expect(n.drivers).toEqual([]);
    expect(n.text).toContain("unchanged");
  });

  it("does not claim a comparison on the first run", () => {
    // Opening zeroes mean there was no previous run. "Unchanged" or "up 100%" would both be statements about
    // a comparison that never happened.
    const n = narrateRun(rec({
      opening: { employees: 0, gross: 0 },
      closing: { employees: 7, gross: 700_000 },
      movements: [mv("joiners", 7, 700_000)],
    }));
    expect(n.compared).toBe(false);
    expect(n.text).toContain("First run");
    expect(n.text).not.toContain("up");
  });

  it("signs each driver so the clauses read as a sum", () => {
    const n = narrateRun(rec({
      closing: { employees: 9, gross: 940_000 },
      movements: [mv("leavers", 1, -60_000)],
    }));
    expect(n.text).toContain("(-60000)");
    expect(n.text).toContain("down 60000");
  });

  it("uses singular nouns for a single person", () => {
    const n = narrateRun(rec({
      closing: { employees: 10, gross: 1_010_000 },
      movements: [mv("recurring", 1, 10_000)],
    }));
    expect(n.text).toContain("pay changes for 1 person");
    expect(n.text).not.toContain("1 people");
  });

  it("always names at least one driver even when asked for none", () => {
    // `maxDrivers` is clamped to 1: a sentence saying gross moved and refusing to say why is worse than a
    // long one.
    const n = narrateRun(rec({
      closing: { employees: 11, gross: 1_080_000 },
      movements: [mv("joiners", 1, 80_000)],
    }), 0);
    expect(n.text).toContain("1 joiner");
  });

  it("carries every moving driver in `drivers`, largest first, whatever the sentence names", () => {
    // The prose is a summary; the structured list is not, so a caller rendering chips beside it gets all of
    // them and in a stable order.
    const n = narrateRun(rec({
      closing: { employees: 14, gross: 1_400_000 },
      movements: [mv("recurring", 9, 60_000), mv("joiners", 4, 300_000), mv("dropped", 2, -1_000)],
    }), 1);
    expect(n.drivers.map((d) => d.key)).toEqual(["joiners", "recurring", "dropped"]);
  });
});

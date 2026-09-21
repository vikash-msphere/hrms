/// <reference types="vite/client" />
// The budget narration's arithmetic half. The model half is not tested here because there is nothing of ours
// in it: `aiGenerate` is mocked out in the AI tests, and what matters on this side is that the findings are
// honest and that the plain summary is a real answer rather than a placeholder for one.
import { describe, it, expect } from "vitest";
import { findMovements, groundedIn, plainSummary, MIN_CHANGE_PCT } from "../src/domain/narrate";
import { priorPeriodKey, promptFor } from "../src/services/budgetNarrate";
import type { MetricDef } from "../src/domain/peopleAnalytics";

const money = (key: string, label: string): MetricDef =>
  ({ key, label, short: label, group: "expenses", collection: "expense-budgets", unit: "money", agg: "sum", direction: "none", hint: "" });
const count = (key: string, label: string): MetricDef =>
  ({ key, label, short: label, group: "expenses", collection: "expense-budgets", unit: "count", agg: "sum", direction: "lower", hint: "" });
const MEASURES = [money("budgeted", "Total budgeted"), money("spent", "Total spent"), count("over", "Budgets over their cap")];

describe("priorPeriodKey", () => {
  it("steps back a period without string arithmetic", () => {
    expect(priorPeriodKey("monthly", "2026-07")).toBe("2026-06");
    expect(priorPeriodKey("quarterly", "2026-Q3")).toBe("2026-Q2");
    expect(priorPeriodKey("yearly", "2026")).toBe("2025");
  });

  it("crosses a year boundary, which is where string arithmetic would fail", () => {
    expect(priorPeriodKey("monthly", "2026-01")).toBe("2025-12");
    expect(priorPeriodKey("quarterly", "2026-Q1")).toBe("2025-Q4");
  });

  it("says nothing about a key it cannot parse", () => {
    expect(priorPeriodKey("monthly", "not-a-period")).toBeNull();
  });
});

describe("what the narration is allowed to say", () => {
  it("reports a movement large enough to be worth a sentence", () => {
    const f = findMovements(MEASURES, { budgeted: 100_000, spent: 40_000, over: 0 }, { budgeted: 100_000, spent: 70_000, over: 2 });
    // Budgeted did not move, so it is absent: a narration about an unchanged number is noise.
    expect(f.map((x) => x.key).sort()).toEqual(["spent"]);
    expect(f[0]!.movement).toBe("up");
  });

  it("stays quiet about a wobble", () => {
    // The proportional floor doing the work the money unit's absolute floor deliberately does not.
    const small = Math.round(100_000 * (1 + (MIN_CHANGE_PCT - 1) / 100));
    expect(findMovements(MEASURES, { budgeted: 0, spent: 100_000, over: 0 }, { budgeted: 0, spent: small, over: 0 })).toEqual([]);
  });

  it("rejects a paragraph carrying a number nobody computed", () => {
    // THE GUARANTEE. The model never sees the data, so it cannot invent a movement; this is what stops it
    // inventing a FIGURE, and it is why a fabricated sentence costs a reader nothing.
    const f = findMovements(MEASURES, { budgeted: 100_000, spent: 40_000, over: 0 }, { budgeted: 100_000, spent: 70_000, over: 0 });
    expect(groundedIn("Spending rose from 40000 to 70000 this period.", f)).toBe(true);
    expect(groundedIn("Spending rose to 70000, around 63% of the 110000 budgeted.", f)).toBe(false);
  });

  it("has a real answer when there is no model", () => {
    // `plain` is not a placeholder: the same facts, written deterministically, which is what every caller
    // gets when the feature is off, the allowance is spent, or the generated text was thrown away.
    const f = findMovements(MEASURES, { budgeted: 100_000, spent: 40_000, over: 0 }, { budgeted: 100_000, spent: 70_000, over: 3 });
    const text = plainSummary(f);
    expect(text.length).toBeGreaterThan(0);
    expect(groundedIn(text, f)).toBe(true); // the fallback passes its own check
  });

  it("puts every allowed figure in the prompt, and nothing else", () => {
    // `groundedIn` is only a fair check if the prompt actually offered the model those numbers.
    const f = findMovements(MEASURES, { budgeted: 100_000, spent: 40_000, over: 0 }, { budgeted: 140_000, spent: 70_000, over: 0 });
    const prompt = promptFor(f);
    for (const finding of f) {
      expect(prompt).toContain(String(finding.previous));
      expect(prompt).toContain(String(finding.current));
    }
    expect(prompt).not.toMatch(/2026|January|month/i); // no dates: repeating one gets the answer discarded
  });
});

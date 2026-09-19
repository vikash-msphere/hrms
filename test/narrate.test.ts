/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import {
  MAX_FINDINGS, MIN_ABSOLUTE, MIN_CHANGE_PCT,
  allowedNumbers, findMovements, groundedIn, plainSummary, type Finding,
} from "../src/domain/narrate";
import { priorWindow, promptFor } from "../src/services/analyticsNarrate";
import { METRICS } from "../src/domain/peopleAnalytics";
import type { MetricDef } from "../src/domain/peopleAnalytics";

// Narrated analytics rests on two claims, and both are checkable, so both are checked here:
//
//   The model cannot invent an ANOMALY, because detection is `findMovements` and it is arithmetic.
//   The model cannot invent a NUMBER, because `groundedIn` rejects a sentence containing one that was not in
//   the findings, and the caller falls back to the plain summary.
//
// The second is the one that matters most in practice. A fabricated figure sitting beside a real dashboard is
// worse than no sentence, and it is exactly the mistake a fluent model makes without noticing.

const metric = (key: string, over: Partial<MetricDef> = {}): MetricDef =>
  ({ key, label: key, short: key, group: "g", collection: "attendance", unit: "count", agg: "sum", direction: "none", hint: "", ...over } as MetricDef);

describe("detection is arithmetic", () => {
  it("reports a move that clears both the proportional and the absolute floor", () => {
    const m = [metric("late_days", { unit: "count", direction: "lower" })];
    const found = findMovements(m, { late_days: 10 }, { late_days: 20 });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ key: "late_days", previous: 10, current: 20, changePct: 100, movement: "up", direction: "lower" });
  });

  it("ignores a big percentage on a tiny number", () => {
    // Two late arrivals becoming three is a 50% rise and means nothing. Both tests have to pass.
    const m = [metric("late_days")];
    expect(findMovements(m, { late_days: 2 }, { late_days: 3 })).toEqual([]);
    expect(MIN_ABSOLUTE.count).toBeGreaterThan(1);
  });

  it("ignores a large absolute move that is proportionally small", () => {
    const m = [metric("days_present", { unit: "days" })];
    // 400 -> 410 is 10 days but only 2.5%.
    expect(findMovements(m, { days_present: 400 }, { days_present: 410 })).toEqual([]);
    expect(MIN_CHANGE_PCT).toBeGreaterThan(2.5);
  });

  it("reports a measure that came off zero, which has no percentage", () => {
    const m = [metric("overtime_hours", { unit: "hours" })];
    const found = findMovements(m, { overtime_hours: 0 }, { overtime_hours: 11 });
    expect(found).toHaveLength(1);
    expect(found[0]!.changePct).toBeNull();
  });

  it("skips a measure missing from either side rather than reading it as zero", () => {
    // Absent means the caller could not see that collection. Treating it as a fall to nothing would report a
    // change caused purely by permissions.
    const m = [metric("a"), metric("b")];
    expect(findMovements(m, { a: 100 }, { b: 100 })).toEqual([]);
  });

  it("orders by proportional size and caps the list", () => {
    const keys = Array.from({ length: 12 }, (_, i) => `m${i}`);
    const m = keys.map((k) => metric(k));
    const prev = Object.fromEntries(keys.map((k) => [k, 100]));
    const now = Object.fromEntries(keys.map((k, i) => [k, 100 + (i + 2) * 20]));
    const found = findMovements(m, prev, now);
    expect(found).toHaveLength(MAX_FINDINGS);
    expect(found[0]!.key).toBe("m11"); // the biggest mover first
  });

  it("carries the metric's own good direction rather than guessing one", () => {
    const m = [metric("attrition", { direction: "lower" }), metric("goals_done", { direction: "higher" })];
    const found = findMovements(m, { attrition: 10, goals_done: 10 }, { attrition: 20, goals_done: 20 });
    expect(found.find((f) => f.key === "attrition")!.direction).toBe("lower");
    expect(found.find((f) => f.key === "goals_done")!.direction).toBe("higher");
  });

  it("every real metric has an absolute floor for its unit", () => {
    // A unit with no floor would fall back to 1 and make that whole family of measures noisy.
    for (const m of METRICS) expect(MIN_ABSOLUTE[m.unit], `${m.unit} needs a floor`).toBeGreaterThan(0);
  });
});

describe("the grounding guard", () => {
  const findings: Finding[] = [
    { key: "late_days", label: "Late days", unit: "count", direction: "lower", previous: 10, current: 20, changePct: 100, movement: "up" },
    { key: "overtime", label: "Overtime", unit: "hours", direction: "lower", previous: 12.4, current: 18.6, changePct: 50, movement: "up" },
  ];

  it("accepts a sentence built only from the findings", () => {
    expect(groundedIn("Late days rose from 10 to 20, and overtime went from 12.4 to 18.6 hours.", findings)).toBe(true);
  });

  it("accepts a rounded figure, which is how a person writes", () => {
    expect(groundedIn("Overtime was up around 50%, from 12.4 to 18.6 hours.", findings)).toBe(true);
    expect(allowedNumbers(findings).has("19")).toBe(true); // 18.6 rounded
  });

  it("accepts the difference, which nobody would call invented", () => {
    expect(groundedIn("Late days were up by 10.", findings)).toBe(true);
  });

  it("REJECTS a number nobody computed", () => {
    // The failure this exists for: a fluent model averaging two figures and stating the result as fact.
    expect(groundedIn("Late days rose to 20, an average of 15 across the period.", findings)).toBe(false);
    expect(groundedIn("That is 240 hours a year.", findings)).toBe(false);
  });

  it("allows small counting words about the narration itself", () => {
    expect(groundedIn("Two measures moved: late days and overtime.", findings)).toBe(true);
  });

  it("rejects a plausible-looking year or total", () => {
    expect(groundedIn("Late days are the highest since 2024.", findings)).toBe(false);
  });
});

describe("the plain fallback", () => {
  it("says nothing moved when nothing did", () => {
    expect(plainSummary([])).toMatch(/Nothing moved/);
  });

  it("states every finding, and is itself grounded", () => {
    const findings = findMovements([metric("late_days")], { late_days: 10 }, { late_days: 20 });
    const text = plainSummary(findings);
    expect(text).toContain("10");
    expect(text).toContain("20");
    // The fallback must pass the same check the model's answer has to, or it would be held to a lower
    // standard than the thing it replaces.
    expect(groundedIn(text, findings)).toBe(true);
  });
});

describe("the comparison window", () => {
  it("is the equal-length window immediately before, with no overlap", () => {
    expect(priorWindow("2026-03-08", "2026-03-14")).toEqual({ from: "2026-03-01", to: "2026-03-07" });
  });

  it("handles a single day", () => {
    expect(priorWindow("2026-03-08", "2026-03-08")).toEqual({ from: "2026-03-07", to: "2026-03-07" });
  });

  it("refuses a reversed or unparseable pair", () => {
    expect(priorWindow("2026-03-14", "2026-03-08")).toBeNull();
    expect(priorWindow("not-a-date", "2026-03-08")).toBeNull();
  });
});

describe("the prompt", () => {
  it("carries labels and numbers and no people", () => {
    const findings = findMovements([metric("late_days", { direction: "lower" })], { late_days: 10 }, { late_days: 20 });
    const prompt = promptFor(findings, { from: "2026-03-08", to: "2026-03-14" }, { from: "2026-03-01", to: "2026-03-07" });
    expect(prompt).toContain("late_days");
    expect(prompt).toContain("was 10, now 20");
    expect(prompt).toContain("lower is the good direction");
    // Team aggregates only. If a person's name could ever reach this prompt, the feature would have a
    // different risk profile entirely.
    expect(prompt).not.toMatch(/employee|name|person/i);
  });

  it("says plainly when a measure had no previous value to compare", () => {
    const findings = findMovements([metric("overtime", { unit: "hours" })], { overtime: 0 }, { overtime: 11 });
    const prompt = promptFor(findings, { from: "a", to: "b" }, { from: "c", to: "d" });
    expect(prompt).toContain("no previous value");
  });
});

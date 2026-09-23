/// <reference types="vite/client" />
// Committed salary cost for the year ahead.
//
// The word doing the work is COMMITTED. Everything here is about the boundary between what somebody has
// already agreed to and what they have merely considered - a future-dated raise counts, a joiner with a
// start date counts from the month they are actually employed, a leaver stops, and nothing invents hiring or
// attrition. A forecast that blurred that line would be a plan wearing the clothes of a commitment.
import { describe, it, expect } from "vitest";
import { forecastPayroll, type ForecastPerson } from "../src/domain/payrollForecast";

const JAN = Date.UTC(2026, 0, 1);
const month = (y: number, m: number) => Date.UTC(y, m, 1);

const person = (over: Partial<ForecastPerson> = {}): ForecastPerson => ({
  employeeId: "a",
  departmentId: null,
  startMs: null,
  endMs: null,
  segments: [{ fromMs: month(2020, 0), toMs: null, monthlyCost: 100_000 }],
  ...over,
});

describe("forecastPayroll", () => {
  it("carries a steady salary across the horizon", () => {
    const f = forecastPayroll([person()], JAN, 12);
    expect(f.months.length).toBe(12);
    expect(f.months[0]).toMatchObject({ month: "2026-01", cost: 100_000, people: 1 });
    expect(f.months[11]!.month).toBe("2026-12");
    expect(f.total).toBe(1_200_000);
  });

  it("picks up a future-dated revision from the month it takes effect", () => {
    // A raise somebody has already entered IS committed, even though it has not been paid yet - that is the
    // difference between this and a guess.
    const p = person({
      segments: [
        { fromMs: month(2026, 3), toMs: null, monthlyCost: 120_000 },
        { fromMs: month(2020, 0), toMs: month(2026, 3), monthlyCost: 100_000 },
      ],
    });
    const f = forecastPayroll([p], JAN, 12);
    expect(f.months.find((m) => m.month === "2026-03")!.cost).toBe(100_000);
    expect(f.months.find((m) => m.month === "2026-04")!.cost).toBe(120_000);
  });

  it("starts a joiner the month after they join mid-month, and never overstates", () => {
    // A month counts somebody employed on its FIRST day. Prorating here would imply the rest of the figure is
    // precise to the day when it is not, so the rule understates by part of one month - the safe direction
    // for something being read as a floor.
    const f = forecastPayroll([person({ startMs: Date.UTC(2026, 1, 15) })], JAN, 4);
    expect(f.months.find((m) => m.month === "2026-01")!.people).toBe(0);
    expect(f.months.find((m) => m.month === "2026-02")!.people).toBe(0); // joined after the 1st
    expect(f.months.find((m) => m.month === "2026-03")!.people).toBe(1);
  });

  it("stops a known leaver, and keeps the month their notice ends in", () => {
    // They are paid for part of that month, so dropping it would understate a cost the company is committed
    // to - the one place the coarse rule rounds up rather than down.
    const f = forecastPayroll([person({ endMs: Date.UTC(2026, 2, 20) })], JAN, 5);
    expect(f.months.find((m) => m.month === "2026-03")!.people).toBe(1);
    expect(f.months.find((m) => m.month === "2026-04")!.people).toBe(0);
  });

  it("splits by cost centre, and keeps people who have none", () => {
    // Dropping the unassigned would make the parts stop summing to the whole, which is the one thing a
    // breakdown must not do.
    const f = forecastPayroll(
      [person({ employeeId: "a", departmentId: "eng" }), person({ employeeId: "b", departmentId: null })],
      JAN,
      1,
    );
    expect(f.months[0]!.byDepartment).toEqual({ eng: 100_000, "": 100_000 });
    const parts = Object.values(f.months[0]!.byDepartment).reduce((s, n) => s + n, 0);
    expect(parts).toBe(f.months[0]!.cost);
  });

  it("skips somebody employed with no compensation in force", () => {
    // Employed but unpriced is not zero cost, it is an unknown - and counting them at zero would quietly
    // report a commitment nobody has recorded.
    const f = forecastPayroll([person({ segments: [{ fromMs: month(2027, 0), toMs: null, monthlyCost: 50_000 }] })], JAN, 3);
    expect(f.months.every((m) => m.people === 0 && m.cost === 0)).toBe(true);
  });

  it("totals what its own column adds up to", () => {
    // Summed from the ROUNDED months. Totalling unrounded figures and rounding once prints a total that does
    // not match the numbers above it, which is the sort of thing that costs a finance team an afternoon.
    const f = forecastPayroll([person({ segments: [{ fromMs: month(2020, 0), toMs: null, monthlyCost: 33_333.33 }] })], JAN, 3);
    expect(f.total).toBe(f.months.reduce((s, m) => s + m.cost, 0));
  });

  it("answers an empty roster with an empty horizon rather than nothing", () => {
    const f = forecastPayroll([], JAN, 12);
    expect(f.months.length).toBe(12);
    expect(f.total).toBe(0);
  });
});

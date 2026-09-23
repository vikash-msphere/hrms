/// <reference types="vite/client" />
// A team-only measure may be reported for a GROUP and never attributed to a named person.
//
// WHY THIS IS TESTED WITH SYNTHETIC MEASURES. No measure in `METRICS` carries the flag yet - the money
// measures that would are blocked on a separate scoping decision (see the note where they would go). So the
// one piece of code standing between a salary figure and a report that writes no audit row would otherwise
// ship with no coverage at all, and would first be exercised by the change that depends on it. The flag is
// infrastructure, so it is tested as infrastructure.
//
// The failure this guards is not an exception. It is a number appearing in a row it should not be in, which
// looks exactly like a number appearing in a row it should be in.
import { describe, it, expect } from "vitest";
import {
  METRICS,
  MIN_TEAM_FOR_TEAM_ONLY,
  teamOnlyKeys,
  teamOnlyReportable,
  withoutTeamOnly,
  type MetricDef,
} from "../src/domain/peopleAnalytics";

const def = (key: string, teamOnly?: true): MetricDef => ({
  key,
  label: key,
  short: key,
  group: "money",
  collection: "payroll-runs",
  unit: "money",
  agg: "sum",
  direction: "none",
  hint: "",
  ...(teamOnly ? { teamOnly } : {}),
});

const PAY = def("pay_cost", true);
const ORDINARY = def("expense_claimed");

describe("withoutTeamOnly strips a team-only measure from a person row", () => {
  it("removes the flagged key and leaves everything else alone", () => {
    const values = { pay_cost: 90_000, expense_claimed: 1_200, days_present: 20 };
    expect(withoutTeamOnly(values, [PAY, ORDINARY])).toEqual({ expense_claimed: 1_200, days_present: 20 });
  });

  it("removes it even when its value is null", () => {
    // A present key with a null value still says the measure was asked for about this person. Absent is the
    // only honest answer, and `null` is what an empty aggregate looks like - so a filter on truthiness would
    // have let the flagged key through in exactly the case where it looks harmless.
    expect(withoutTeamOnly({ pay_cost: null, days_present: 3 }, [PAY])).toEqual({ days_present: 3 });
  });

  it("removes it whatever the roster size, because the row is one person either way", () => {
    // The group-size rule governs the TEAM line. A person row is a person row in a group of one thousand.
    const values = { pay_cost: 90_000 };
    expect(withoutTeamOnly(values, [PAY])).toEqual({});
  });

  it("does not mutate the row it was handed", () => {
    // The caller holds these rows in a list it already built; a helper that empties them in place is a worse
    // thing to call from a second site later.
    const values = { pay_cost: 90_000, days_present: 20 };
    withoutTeamOnly(values, [PAY]);
    expect(values.pay_cost).toBe(90_000);
  });

  it("is a no-op when nothing is flagged", () => {
    const values = { expense_claimed: 1_200 };
    expect(withoutTeamOnly(values, [ORDINARY])).toEqual(values);
  });
});

describe("teamOnlyReportable suppresses a group too small to hide anybody", () => {
  it("refuses a roster below the floor and allows one at it", () => {
    // A total over one person IS that person's figure; over two it is one subtraction away for either member.
    expect(teamOnlyReportable(0)).toBe(false);
    expect(teamOnlyReportable(1)).toBe(false);
    expect(teamOnlyReportable(2)).toBe(false);
    expect(teamOnlyReportable(MIN_TEAM_FOR_TEAM_ONLY - 1)).toBe(false);
    expect(teamOnlyReportable(MIN_TEAM_FOR_TEAM_ONLY)).toBe(true);
    expect(teamOnlyReportable(MIN_TEAM_FOR_TEAM_ONLY + 50)).toBe(true);
  });

  it("keeps the floor above one, whatever it is later set to", () => {
    // The constant is meant to be raised by an org with a different obligation. Lowering it to 1 would turn
    // every team-only measure back into a per-person lookup through the team line, which is the whole thing
    // the flag exists to prevent - so the floor itself is pinned, not just today's value.
    expect(MIN_TEAM_FOR_TEAM_ONLY).toBeGreaterThan(2);
  });
});

describe("the registry stays honest about what is flagged", () => {
  it("names every team-only measure currently shipped", () => {
    // Deliberately empty today: the pay measures that would carry the flag are blocked on a scoping decision
    // recorded beside them. This asserts the CURRENT answer rather than allowing any answer, so adding a
    // flagged measure has to come here and state itself - and adding an unflagged pay measure fails the next
    // assertion instead.
    expect(teamOnlyKeys(METRICS)).toEqual([]);
  });

  it("has no money measure over a pay collection that is not team-only", () => {
    // The rule the flag encodes, checked against the registry rather than trusted to review. `expenses` is a
    // money measure and is deliberately NOT team-only - a claim someone filed is already theirs to see - so
    // the gate is the COLLECTION, not the unit.
    const PAY_COLLECTIONS = new Set(["payroll-runs", "payslips", "compensation", "payroll-run-items"]);
    const unflagged = METRICS.filter((m) => PAY_COLLECTIONS.has(m.collection) && !m.teamOnly).map((m) => m.key);
    expect(
      unflagged,
      "a measure derived from pay must be team-only: this report answers per person and writes no audit row, " +
        "while reading the same figure on a payslip writes a payslips.read.sensitive one",
    ).toEqual([]);
  });
});

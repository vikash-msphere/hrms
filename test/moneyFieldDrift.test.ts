/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { positiveMoney, nonNegativeMoney, signedMoney, positiveDays, MAX_MONEY, MAX_DAYS } from "../src/http/moneyField";

// MONEY INPUTS ARE BOUNDED, and the next one cannot be written bare.
//
// `routes/loans.ts` worked this hazard out first and fixed it for loans alone, with the reasoning written out:
// a bare `z.number()` admits Infinity (JSON cannot carry it, but a non-JSON caller can) and has no upper bound
// at all. Every other money input in the app kept the bare form, and `1e308` is an ordinary JSON number that
// passes `.positive()` - and STORES, because `round2` fell through its own guard and handed it back unchanged.
//
// The damage is the next aggregate over it, not the one huge row: every money total here is a `sum2` or a
// `round2` over a plain `+=`, and a float accumulator past 1.8e308 is Infinity. `STATES_CHARGED` includes
// SUBMITTED, so an employee charges a budget's `pending` with no approver involved; two submissions of 1e308
// against one department/period overflowed it, and `budgetUtilization` then reported `pending: 0`,
// `remaining: the whole cap` and never tripped `checkBudgetThresholds`.
//
// So this has two halves: the helpers behave, and every money field in the routes goes through one of them.
// The second half is a SOURCE scan, like test/listOwnerColumns.test.ts - a zod field is a call site.
const routes = import.meta.glob("../src/routes/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

// Field names that carry money or a day count. Matched on the name because that is what a reviewer reads; a
// new one that is not on this list is not silently exempt, it is simply not yet known to be money - which is
// why the list is kept beside the exemptions rather than derived.
const MONEY_FIELDS = [
  "amount", "tax_amount", "principal", "annual_ctc", "variable_pay_target", "base_comp",
  "band_min", "band_mid", "band_max", "employee_cost", "employer_cost", "days",
  // What a thing cost: an asset's purchase price, a background check's vendor invoice. Both are summed
  // (inventory book value, spend per vendor), which is the property that makes an unbounded one dangerous.
  "purchase_cost", "cost",
];

/**
 * Keyed `<file>:<field>`: a money-NAMED field that is deliberately not a bounded money amount, with the reason.
 * Empty today, and kept because the next one has to be a decision written down rather than a name quietly left
 * off `MONEY_FIELDS`.
 *
 * NOT the place for the leave-policy thresholds in `routes/leaveTypes.ts` (`min_days`, `notice_days`,
 * `up_to_days`): those are named differently, are policy rather than an accumulated amount, and are validated
 * by `domain/leaveRestrictions.ts#validateRestrictions` on their own terms.
 */
const NOT_MONEY: Record<string, string> = {};

/** Every `<field>: z.<something>` line in the routes, with its file. */
function bareMoneyFields(): string[] {
  const out: string[] = [];
  for (const [path, src] of Object.entries(routes)) {
    const file = path.split("/").pop()!;
    src.split("\n").forEach((line) => {
      const m = /^\s*([a-z_]+): (z\.number\(\)[^,]*)/.exec(line);
      if (!m) return;
      const [, field, expr] = m as unknown as [string, string, string];
      if (!MONEY_FIELDS.includes(field)) return;
      if (NOT_MONEY[`${file}:${field}`]) return;
      out.push(`${file}: ${field}: ${expr.trim()}`);
    });
  }
  return out;
}

describe("money fields are bounded", () => {
  it("scans the routes (so a parser change cannot empty this test)", () => {
    expect(Object.keys(routes).length).toBeGreaterThan(50);
  });

  it("no money or day field is a bare z.number() anywhere in the routes", () => {
    expect(
      bareMoneyFields(),
      "use positiveMoney()/nonNegativeMoney()/signedMoney()/positiveDays() from http/moneyField.ts, or add the field to NOT_MONEY with its reason",
    ).toEqual([]);
  });

  it("every NOT_MONEY exemption still names a field that exists", () => {
    const present = new Set<string>();
    for (const [path, src] of Object.entries(routes)) {
      const file = path.split("/").pop()!;
      for (const m of src.matchAll(/^\s*([a-z_]+): z\./gm)) present.add(`${file}:${m[1]}`);
    }
    expect(Object.keys(NOT_MONEY).filter((k) => !present.has(k))).toEqual([]);
  });

  describe("the helpers themselves", () => {
    it("refuse Infinity and NaN, which a bare z.number() admits", () => {
      for (const f of [positiveMoney(), nonNegativeMoney(), signedMoney(), positiveDays()]) {
        expect(f.safeParse(Infinity).success).toBe(false);
        expect(f.safeParse(-Infinity).success).toBe(false);
        expect(f.safeParse(NaN).success).toBe(false);
      }
    });

    it("refuse the overflow magnitudes that make an accumulator non-finite", () => {
      for (const f of [positiveMoney(), nonNegativeMoney(), signedMoney()]) {
        expect(f.safeParse(1e308).success).toBe(false);
        expect(f.safeParse(MAX_MONEY + 1).success).toBe(false);
      }
      expect(positiveDays().safeParse(MAX_DAYS + 1).success).toBe(false);
    });

    it("accept ordinary figures, and the ceiling itself", () => {
      expect(positiveMoney().safeParse(50_000).success).toBe(true);
      expect(positiveMoney().safeParse(MAX_MONEY).success).toBe(true);
      expect(nonNegativeMoney().safeParse(0).success).toBe(true);
      expect(positiveDays().safeParse(12.5).success).toBe(true);
    });

    it("keep their sign rules: positive refuses 0, non-negative refuses a negative, signed takes both", () => {
      expect(positiveMoney().safeParse(0).success).toBe(false);
      expect(positiveMoney().safeParse(-1).success).toBe(false);
      expect(nonNegativeMoney().safeParse(-1).success).toBe(false);
      expect(signedMoney().safeParse(-1).success).toBe(true);
      expect(signedMoney().safeParse(-MAX_MONEY - 1).success).toBe(false);
      expect(positiveDays().safeParse(0).success).toBe(false);
    });
  });
});

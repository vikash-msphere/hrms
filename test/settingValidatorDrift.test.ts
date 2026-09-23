/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { validateSettingValue, SETTING_VALIDATOR_KEYS, UNVALIDATED_SETTING_KEYS } from "../src/routes/settings";
import { overtimePay, DEFAULT_OVERTIME_CONFIG } from "../src/domain/payroll";

// A SETTINGS KEY THE SERVER READS AND NOBODY VALIDATES IS A KEY THE ADMIN CAN BREAK SILENTLY.
//
// `upsertSetting` writes any JSON to any key, and `getSettingValue` merges the stored blob over the typed
// default with a SHALLOW spread (`{ ...fallback, ...parsed }`). So a stored `null` does not fall back to the
// default - it REPLACES it, which is exactly what an admin who clears a number input stores. Two of the keys
// this used to be true of computed a wrong answer rather than throwing:
//
//   overtime.hours_per_month: null  -> the hourly rate becomes 0, and every overtime line in the run pays 0
//   probation.default_months: null  -> every new joiner's probation ends the day it starts
//
// Both on a screen that reported success, and neither reportable from anywhere downstream. The registry in
// routes/settings.ts is the only place a bad value can be caught, so the requirement is DERIVED here rather
// than remembered: every key the server actually reads must either have a validator or be named, with a
// reason, in UNVALIDATED_SETTING_KEYS. That is the same registry cross-check shape as the audit-verb,
// purge-cascade and owner-ref gates - where one exists the registries agree, and where none does they drift.
const src = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Every key the server reads through `getSettingValue(deps, "<key>", ...)`, with where it is read. */
function keysRead(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [path, text] of Object.entries(src)) {
    for (const m of text.matchAll(/getSettingValue\s*(?:<[^>]*>)?\s*\(\s*\w+\s*,\s*"([a-z0-9_-]+)"/gi)) {
      const key = m[1]!;
      out.set(key, [...(out.get(key) ?? []), path.replace("../", "")]);
    }
  }
  return out;
}

const read = keysRead();

describe("every settings key the server reads is classified", () => {
  it("found the reads (sanity: the call shape still matches)", () => {
    expect(read.size).toBeGreaterThan(20);
    // The two whose absence was demonstrable, and the two the statutory note in routes/settings.ts is about.
    for (const key of ["overtime", "probation", "tax-config", "professional-tax"]) expect([...read.keys()]).toContain(key);
  });

  it("has a validator or a named exemption for each one", () => {
    const unclassified = [...read.keys()].filter((k) => !SETTING_VALIDATOR_KEYS.has(k) && !UNVALIDATED_SETTING_KEYS.has(k));
    expect(
      unclassified.map((k) => `${k} (read in ${read.get(k)!.join(", ")})`),
      "read by the server with no write validator and no documented exemption - add one to SETTING_VALIDATORS or a reason to UNVALIDATED_SETTING_KEYS",
    ).toEqual([]);
  });

  it("names no exemption for a key nothing reads, and none that also has a validator", () => {
    // An exemption for a key that is gone is a stale excuse; one that duplicates a validator is a contradiction.
    expect([...UNVALIDATED_SETTING_KEYS.keys()].filter((k) => !read.has(k))).toEqual([]);
    expect([...UNVALIDATED_SETTING_KEYS.keys()].filter((k) => SETTING_VALIDATOR_KEYS.has(k))).toEqual([]);
  });

  it("gives every exemption an actual reason", () => {
    const empty = [...UNVALIDATED_SETTING_KEYS.entries()].filter(([, why]) => why.trim().length < 20).map(([k]) => k);
    expect(empty, "an exemption without a reason is an omission with a comment next to it").toEqual([]);
  });
});

// The keys whose leaves feed arithmetic, driven through the real registry entry. `undefined` has to pass
// (the shallow merge leaves an absent key at its typed default); `null` has to fail (it replaces it).
const check = (key: string, patch: Record<string, unknown>) => () => validateSettingValue(key, patch);

describe("settings/overtime", () => {
  it("accepts the shipped default and an ordinary edit", () => {
    expect(check("overtime", DEFAULT_OVERTIME_CONFIG as unknown as Record<string, unknown>)).not.toThrow();
    expect(check("overtime", { multiplier: 1.5 })).not.toThrow();
    expect(check("overtime", { rate_per_hour: 500 })).not.toThrow();
    // null `rate_per_hour` is the shipped value and MEANS "derive from base pay", so it stays legal.
    expect(check("overtime", { rate_per_hour: null })).not.toThrow();
  });

  it("rejects the cleared field, which is what pays every overtime line nothing", () => {
    // The consequence, reproduced against the real helper rather than asserted.
    expect(overtimePay(600, 50_000, DEFAULT_OVERTIME_CONFIG)).toBe(5000);
    expect(overtimePay(600, 50_000, { ...DEFAULT_OVERTIME_CONFIG, hours_per_month: null as unknown as number })).toBe(0);
    expect(check("overtime", { hours_per_month: null })).toThrow();
    expect(check("overtime", { hours_per_month: 0 })).toThrow();
    expect(check("overtime", { multiplier: null })).toThrow();
    expect(check("overtime", { multiplier: "two" })).toThrow();
    expect(check("overtime", { rate_per_hour: "abc" })).toThrow();
  });
});

describe("settings/probation", () => {
  it("accepts a real policy, including 'no probation'", () => {
    expect(check("probation", { default_months: 3 })).not.toThrow();
    expect(check("probation", { default_months: 0 })).not.toThrow();
    expect(check("probation", {})).not.toThrow();
  });

  it("rejects the values that end probation on day one, or write an Invalid Date", () => {
    // `month + null` is `month + 0`, so the end date equals the start date - and that silently flips who the
    // probation leave cap and `availableDuringProbation` apply to.
    expect(check("probation", { default_months: null })).toThrow();
    // `Date.UTC(y, NaN, d)` is NaN: an Invalid Date persisted to a timestamp_ms column, which every later
    // comparison reads as false.
    expect(check("probation", { default_months: "three" })).toThrow();
    expect(check("probation", { default_months: 1.5 })).toThrow();
  });
});

describe("the remaining arithmetic keys", () => {
  it("leave_accrual takes only the roundings its reader knows", () => {
    expect(check("leave_accrual", { rounding: "half" })).not.toThrow();
    expect(check("leave_accrual", {})).not.toThrow();
    // `INCREMENT[v.rounding] ?? 0.5` falls back, so a typo here rounds balances the old way for ever.
    expect(check("leave_accrual", { rounding: "halfday" })).toThrow();
    expect(check("leave_accrual", { rounding: null })).toThrow();
  });

  it("leave_encashment guards the divisor that prices every cashout", () => {
    expect(check("leave_encashment", { rate_basis: "gross", per_day_divisor: 26 })).not.toThrow();
    expect(check("leave_encashment", { per_day_divisor: null })).toThrow();
    expect(check("leave_encashment", { per_day_divisor: 0 })).toThrow();
    expect(check("leave_encashment", { rate_basis: "net" })).toThrow();
  });

  it("loan-perquisite is checked only when the policy is on", () => {
    expect(check("loan-perquisite", { enabled: false, sbi_rate_pct: null })).not.toThrow();
    expect(check("loan-perquisite", { enabled: true, sbi_rate_pct: 6.5, interest_charged_pct: 0 })).not.toThrow();
    expect(check("loan-perquisite", { enabled: true, sbi_rate_pct: null })).toThrow();
    expect(check("loan-perquisite", { enabled: true, exempt_principal_upto: -1 })).toThrow();
  });

  it("performance keeps a framework that can actually be rated", () => {
    expect(check("performance", { goal_approval: "required" })).not.toThrow();
    expect(check("performance", { competencies: [{ key: "delivery", label: "Delivery", weight: 2 }] })).not.toThrow();
    expect(check("performance", { goal_approval: "on" })).toThrow();
    // An empty scale leaves every review with nothing to pick; a duplicate key silently overwrites a score,
    // because ratings are stored under the key.
    expect(check("performance", { scale: [] })).toThrow();
    expect(check("performance", { competencies: [{ key: "a", label: "A" }, { key: "a", label: "Also A" }] })).toThrow();
    expect(check("performance", { competencies: [{ key: "a", label: "A", weight: "heavy" }] })).toThrow();
  });

  it("referrals guards the bonus amount it pays out", () => {
    expect(check("referrals", { default_bonus_amount: 25_000, award_trigger: "joining" })).not.toThrow();
    // `resolveBonusAmount` ends `return cfg.default_bonus_amount` with no guard, so this is a wrong stored
    // answer on the one payout a referrer chases.
    expect(check("referrals", { default_bonus_amount: null })).toThrow();
    expect(check("referrals", { award_trigger: "offer" })).toThrow();
    expect(check("referrals", { join_tiers: [{ amount: 5000, max_days: null }] })).not.toThrow();
    expect(check("referrals", { join_tiers: [{ amount: null, max_days: 30 }] })).toThrow();
  });
});

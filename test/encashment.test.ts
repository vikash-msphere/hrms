import { describe, it, expect } from "vitest";
import { encashmentRatePerDay, encashmentAmount, encashmentEligibilityError } from "../src/domain/encashment";

describe("encashment rate math", () => {
  it("per-day = basis / divisor (default basis is base/30, like FnF)", () => {
    expect(encashmentRatePerDay(90000, 30)).toBe(3000);
    expect(encashmentAmount(10, 90000, 30)).toBe(30000);
  });
  it("a configurable divisor changes the rate", () => {
    expect(encashmentRatePerDay(93000, 31)).toBe(3000); // monthly basis over a 31-divisor
    expect(encashmentRatePerDay(90000, 26)).toBeCloseTo(3461.54, 2); // working-days divisor
  });
  it("a non-positive divisor falls back to 30", () => {
    expect(encashmentRatePerDay(90000, 0)).toBe(3000);
    expect(encashmentAmount(10, 90000, 0)).toBe(30000);
  });
  it("rounds to paise", () => {
    expect(encashmentAmount(2.5, 90000, 26)).toBe(8653.85);
  });
  it("rounds ONCE from the unrounded rate (no per-day-rate drift)", () => {
    // rate = 100000/30 = 3333.33 (rounded); days x rounded-rate = 33333.30, but the true payout is 33333.33.
    expect(encashmentRatePerDay(100000, 30)).toBe(3333.33);
    expect(encashmentAmount(10, 100000, 30)).toBe(33333.33);
  });
});

describe("encashment eligibility", () => {
  const base = {
    encashable: true,
    disabled: false,
    days: 5,
    balance: 20,
    minBalanceRetainedDays: 0,
    capDaysPerYear: null as number | null,
    alreadyEncashedThisYear: 0,
  };
  it("passes a plain in-bounds request", () => {
    expect(encashmentEligibilityError(base)).toBeNull();
  });
  it("rejects a non-encashable or disabled leave type", () => {
    expect(encashmentEligibilityError({ ...base, encashable: false })).toMatch(/not encashable/);
    expect(encashmentEligibilityError({ ...base, disabled: true })).toMatch(/not encashable/);
  });
  it("rejects when the balance can't cover the request", () => {
    expect(encashmentEligibilityError({ ...base, days: 25 })).toMatch(/insufficient leave balance/);
  });
  it("enforces the minimum-retained floor", () => {
    // 20 balance, retain 18 -> at most 2 days encashable; 5 days breaches the floor.
    expect(encashmentEligibilityError({ ...base, minBalanceRetainedDays: 18 })).toMatch(/retain at least 18/);
    expect(encashmentEligibilityError({ ...base, days: 2, minBalanceRetainedDays: 18 })).toBeNull(); // exactly at the floor is OK
  });
  it("enforces the annual cap against FY-to-date encashed days", () => {
    // cap 10/yr, 7 already used -> only 3 left; 5 more exceeds it.
    expect(encashmentEligibilityError({ ...base, capDaysPerYear: 10, alreadyEncashedThisYear: 7 })).toMatch(/annual encashment cap of 10/);
    expect(encashmentEligibilityError({ ...base, days: 3, capDaysPerYear: 10, alreadyEncashedThisYear: 7 })).toBeNull(); // exactly at the cap is OK
  });
});

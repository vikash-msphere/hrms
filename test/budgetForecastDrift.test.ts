/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
// The two forward-looking numbers on the expenses surface, and both are arithmetic: where a budget lands if
// the rest of its period spends like the part already gone, and whether a generated occurrence costs what its
// series usually costs.
//
// What these assert hardest is the NEGATIVE space. Both functions return null far more often than they return
// a value, and every one of those nulls is a decision: a forecast the elapsed time cannot support, a drift
// measured against nothing, a period whose spend is already final. A test suite that only checked the happy
// answers would leave the app free to start showing confident numbers built on one invoice in January.
import { describe, it, expect } from "vitest";
import {
  projectBudget,
  seriesDrift,
  budgetUtilization,
  periodBounds,
  MIN_ELAPSED_TO_PROJECT,
  SERIES_DRIFT_TOLERANCE,
  paymentDueOn,
  ratedAmount,
  categoryBreaches,
  allocationError,
  autoApproveBlocks,
  MAX_RATED_QUANTITY,
} from "../src/domain/expenses";

const JUNE = periodBounds("monthly", "2026-06");
const YEAR = periodBounds("yearly", "2026");
// A day inside June 2026, as milliseconds. June has 30 days, so the 16th is almost exactly halfway.
const june = (day: number) => Date.UTC(2026, 5, day);

describe("projectBudget", () => {
  it("projects the period total from the rate the elapsed part spent at", () => {
    // Half the month gone, half the cap spent: the run rate lands exactly on the cap, not over it.
    const p = projectBudget(100_000, 50_000, JUNE, june(16))!;
    expect(p).not.toBeNull();
    expect(p.elapsed).toBeCloseTo(0.5, 2);
    expect(p.projected).toBeCloseTo(100_000, -2);
    expect(p.projectedUtilization).toBeCloseTo(1, 1);
    expect(Math.abs(p.projectedOverBy)).toBeLessThan(2_000);
  });

  it("calls a breach weeks before the spend reaches the cap", () => {
    // THE WHOLE POINT OF THE FEATURE. A third of the month gone and half the cap spent is only 50% utilized,
    // so no threshold has fired and `alert_level` is still 0 - but the rate lands it 50% over.
    const spent = 50_000;
    const cap = 100_000;
    const p = projectBudget(cap, spent, JUNE, june(11))!;
    expect(budgetUtilization(cap, spent).utilization).toBeCloseTo(0.5, 2); // nothing has crossed 80%
    expect(p.projected).toBeGreaterThan(cap);
    expect(p.projectedOverBy).toBeGreaterThan(0);
  });

  it("says nothing when the cap is forecast to hold", () => {
    // Still a projection - the caller needs the number to show "on course" - but not a breach.
    const p = projectBudget(100_000, 20_000, JUNE, june(16))!;
    expect(p.projected).toBeLessThan(100_000);
    expect(p.projectedOverBy).toBeLessThan(0);
  });

  it("refuses to extrapolate from too little of the period", () => {
    // One invoice on the second of January against a yearly cap implies a 180x overspend. The guard is what
    // stops that arithmetic reaching a page.
    expect(projectBudget(100_000, 5_000, YEAR, Date.UTC(2026, 0, 2))).toBeNull();
    // ...and the same spend, once enough of the year has gone to mean something, does project.
    const later = projectBudget(100_000, 5_000, YEAR, Date.UTC(2026, 4, 1));
    expect(later).not.toBeNull();
    expect(later!.elapsed).toBeGreaterThan(MIN_ELAPSED_TO_PROJECT);
  });

  it("refuses a period that is not the current one", () => {
    // A closed period's spend IS its total; projecting it would restate a fact as a forecast.
    expect(projectBudget(100_000, 50_000, JUNE, Date.UTC(2026, 7, 1))).toBeNull();
    // A future period has no elapsed time to divide by.
    expect(projectBudget(100_000, 50_000, JUNE, Date.UTC(2026, 3, 1))).toBeNull();
    // The boundaries themselves: the first instant is in (but too early to project), the last is out.
    expect(projectBudget(100_000, 50_000, JUNE, JUNE.end)).toBeNull();
  });

  it("refuses when there is nothing to extrapolate", () => {
    // Zero spend would project zero, which reads as "on track" when it means "no data".
    expect(projectBudget(100_000, 0, JUNE, june(16))).toBeNull();
    // A cap of zero has no utilization to forecast either.
    expect(projectBudget(0, 50_000, JUNE, june(16))).toBeNull();
    expect(projectBudget(-1, 50_000, JUNE, june(16))).toBeNull();
  });
});

describe("seriesDrift", () => {
  it("flags an occurrence that costs more than the series usually does", () => {
    const d = seriesDrift(1_200, [1_000, 1_000, 1_000])!;
    expect(d.direction).toBe("up");
    expect(d.baseline).toBe(1_000);
    expect(d.delta).toBe(200);
    expect(d.deltaFraction).toBeCloseTo(0.2, 5);
    expect(d.samples).toBe(3);
  });

  it("flags a drop as well as a rise", () => {
    // A lapsed charge is as interesting as a price rise: it is the month the service was not billed.
    const d = seriesDrift(600, [1_000, 1_000])!;
    expect(d.direction).toBe("down");
    expect(d.delta).toBe(-400);
    expect(d.deltaFraction).toBeCloseTo(-0.4, 5);
  });

  it("stays quiet inside the tolerance", () => {
    // Ordinary variation on a metered bill. A flag on every occurrence is a flag nobody reads.
    expect(seriesDrift(1_020, [1_000, 1_000])).toBeNull();
    expect(seriesDrift(1_000, [1_000])).toBeNull();
    // Just inside and just outside the boundary, so the tolerance is a real edge rather than a rough idea.
    const justInside = 1_000 * (1 + SERIES_DRIFT_TOLERANCE * 0.9);
    const justOutside = 1_000 * (1 + SERIES_DRIFT_TOLERANCE * 1.1);
    expect(seriesDrift(justInside, [1_000])).toBeNull();
    expect(seriesDrift(justOutside, [1_000])).not.toBeNull();
  });

  it("uses a median, so one bad month cannot poison the next one", () => {
    // THE CASE THE MEDIAN EXISTS FOR. A double-billed month sits in the history; the month after it is correct
    // at 1000. Against a MEAN of [1000, 1000, 2000] (1333) that correct month reads as a 25% drop, so the app
    // would report the same billing error twice and get the direction wrong the second time.
    const history = [1_000, 1_000, 2_000];
    const mean = history.reduce((a, b) => a + b, 0) / history.length;
    expect(seriesDrift(1_000, history)).toBeNull(); // median 1000: nothing to say, correctly
    expect(Math.abs((1_000 - mean) / mean)).toBeGreaterThan(SERIES_DRIFT_TOLERANCE); // a mean would have fired
    // The double-billed month itself is still caught when it is the one being judged.
    expect(seriesDrift(2_000, [1_000, 1_000])!.direction).toBe("up");
  });

  it("has nothing to say without a baseline", () => {
    expect(seriesDrift(1_000, [])).toBeNull();
    expect(seriesDrift(1_000, [0, -5])).toBeNull(); // non-amounts are not a baseline
    expect(seriesDrift(0, [1_000])).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------
// When a vendor invoice is payable. The rule is one addition, and everything interesting about it is which
// date it counts from and when it declines to answer at all.
// ---------------------------------------------------------------------------------------------------------

describe("paymentDueOn", () => {
  const march = (day: number) => new Date(Date.UTC(2026, 2, day));

  it("counts from the invoice date, not from approval", () => {
    // Net 30 means thirty days from the invoice. Counting from approval would let a slow approval quietly
    // extend the term the vendor agreed to, so a company that approved late would look - to its own reports -
    // as though it had paid on time.
    expect(paymentDueOn(march(1), 30)).toEqual(new Date(Date.UTC(2026, 2, 31)));
  });

  it("crosses a month end and a year end without drifting", () => {
    expect(paymentDueOn(march(20), 30)).toEqual(new Date(Date.UTC(2026, 3, 19)));
    expect(paymentDueOn(new Date(Date.UTC(2026, 11, 20)), 30)).toEqual(new Date(Date.UTC(2027, 0, 19)));
    // Into a leap February. Jan 31 + 30 days lands on 1 March: the 29 days of February take it to the 29th,
    // and the thirtieth day is the 1st. A month-step would have said 29 February and been a day short.
    expect(paymentDueOn(new Date(Date.UTC(2028, 0, 31)), 30)).toEqual(new Date(Date.UTC(2028, 2, 1)));
    expect(paymentDueOn(new Date(Date.UTC(2028, 0, 31)), 29)).toEqual(new Date(Date.UTC(2028, 1, 29)));
  });

  it("treats zero days as due on the invoice date, and null as no answer", () => {
    // The distinction the column exists to preserve: 0 is "due immediately", null is "no agreed terms".
    expect(paymentDueOn(march(1), 0)).toEqual(march(1));
    expect(paymentDueOn(march(1), null)).toBeNull();
    expect(paymentDueOn(march(1), undefined)).toBeNull();
  });

  it("says nothing without an invoice date", () => {
    // A payables list shows such a row with no due date rather than inventing one: a wrong due date is the
    // number somebody chases against, so it is worse than a blank.
    expect(paymentDueOn(null, 30)).toBeNull();
    expect(paymentDueOn(undefined, 30)).toBeNull();
    expect(paymentDueOn(new Date(NaN), 30)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------
// Rated categories: mileage and per diem, where the org publishes a rate and the claimant states a quantity.
// The arithmetic is one multiplication, so what is worth pinning is every case where it must NOT produce a
// number - those are what keep a mistyped distance from becoming a total nobody can check.
// ---------------------------------------------------------------------------------------------------------

describe("ratedAmount", () => {
  it("multiplies the rate by the quantity", () => {
    expect(ratedAmount("per_km", 12, 412)).toBe(4944);
    expect(ratedAmount("per_day", 1500, 3)).toBe(4500);
    // Rounded to the paise like every other money figure, so a fractional rate cannot leave a long tail.
    expect(ratedAmount("per_km", 12.35, 7.5)).toBe(92.63);
  });

  it("declines on an unrated category", () => {
    // The common case by far: an ordinary category keeps whatever amount the claimant typed.
    expect(ratedAmount(null, 12, 100)).toBeNull();
    expect(ratedAmount(undefined, 12, 100)).toBeNull();
    expect(ratedAmount("", 12, 100)).toBeNull();
    expect(ratedAmount("per_hour", 12, 100)).toBeNull(); // not a kind this app has
  });

  it("declines on a half-configured category", () => {
    // A kind with no usable rate cannot compute, and computing 0 would file a claim for nothing rather than
    // telling anybody the category is misconfigured.
    expect(ratedAmount("per_km", null, 100)).toBeNull();
    expect(ratedAmount("per_km", 0, 100)).toBeNull();
    expect(ratedAmount("per_km", -5, 100)).toBeNull();
  });

  it("declines on a quantity that is not a claim", () => {
    expect(ratedAmount("per_km", 12, null)).toBeNull();
    expect(ratedAmount("per_km", 12, undefined)).toBeNull();
    expect(ratedAmount("per_km", 12, 0)).toBeNull(); // an expense of nothing is not an expense
    expect(ratedAmount("per_km", 12, -10)).toBeNull();
    expect(ratedAmount("per_km", 12, Number.NaN)).toBeNull();
  });

  it("refuses a quantity that is a decimal-point slip", () => {
    // THE RAIL THAT MATTERS. 41200 km is not a journey, it is 412 with a finger on the wrong key - and the
    // only moment it can be caught is before it becomes a plausible-looking total.
    expect(ratedAmount("per_km", 12, MAX_RATED_QUANTITY)).not.toBeNull();
    expect(ratedAmount("per_km", 12, MAX_RATED_QUANTITY + 1)).toBeNull();
    expect(ratedAmount("per_km", 12, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------
// Category policy, checked when a claim is filed rather than when somebody rejects it days later. The same
// function runs on the server (at submit) and in the form (as a warning), so these cases pin both at once -
// which is the property that stops the form letting a claim through that the server then refuses.
// ---------------------------------------------------------------------------------------------------------

describe("categoryBreaches", () => {
  const TODAY = Date.UTC(2026, 5, 30);
  const ago = (days: number) => Date.UTC(2026, 5, 30 - days);
  const ok = { amount: 100, incurredOn: TODAY, hasReceipt: true };

  it("says nothing about an unrestricted category", () => {
    expect(categoryBreaches(null, ok, TODAY)).toEqual([]);
    expect(categoryBreaches({}, ok, TODAY)).toEqual([]);
    expect(categoryBreaches({ amountCap: null, maxAgeDays: null, requiresReceipt: false }, ok, TODAY)).toEqual([]);
  });

  it("names the limit, not just the breach", () => {
    // A submitter told "over the cap" without being told the cap has to go and ask somebody.
    const [b] = categoryBreaches({ amountCap: 5000 }, { ...ok, amount: 5001 }, TODAY, (n) => `Rs${n}`);
    expect(b!.code).toBe("amount_cap");
    expect(b!.message).toContain("Rs5000");
    // Exactly at the cap is allowed: a cap is a maximum, not a strict bound.
    expect(categoryBreaches({ amountCap: 5000 }, { ...ok, amount: 5000 }, TODAY)).toEqual([]);
  });

  it("counts age in whole days from the date incurred", () => {
    expect(categoryBreaches({ maxAgeDays: 30 }, { ...ok, incurredOn: ago(30) }, TODAY)).toEqual([]);
    const [b] = categoryBreaches({ maxAgeDays: 30 }, { ...ok, incurredOn: ago(31) }, TODAY);
    expect(b!.code).toBe("too_old");
    expect(b!.message).toContain("31 days old");
  });

  it("does not report a future-dated claim as too old", () => {
    // The form refuses a future date separately. Calling it "too old" here would be actively misleading.
    expect(categoryBreaches({ maxAgeDays: 30 }, { ...ok, incurredOn: Date.UTC(2026, 6, 5) }, TODAY)).toEqual([]);
  });

  it("has no age opinion when nothing says when it happened", () => {
    expect(categoryBreaches({ maxAgeDays: 30 }, { ...ok, incurredOn: null }, TODAY)).toEqual([]);
  });

  it("requires a receipt, except on a rated category", () => {
    const [b] = categoryBreaches({ requiresReceipt: true }, { ...ok, hasReceipt: false }, TODAY);
    expect(b!.code).toBe("receipt_required");
    // THE EXEMPTION. There is no invoice for a car journey, so a category that is both rated and
    // receipt-required would be unsatisfiable - the rate feature would be unusable wherever both were set.
    expect(categoryBreaches({ requiresReceipt: true, rateKind: "per_km" }, { ...ok, hasReceipt: false }, TODAY)).toEqual([]);
    expect(categoryBreaches({ requiresReceipt: true, rateKind: "per_day" }, { ...ok, hasReceipt: false }, TODAY)).toEqual([]);
  });

  it("reports every breach at once", () => {
    // One round trip per rule is the thing this replaces, so fixing the amount only to be told about the date
    // would be the same failure in a new place.
    const breaches = categoryBreaches(
      { amountCap: 100, maxAgeDays: 7, requiresReceipt: true },
      { amount: 500, incurredOn: ago(60), hasReceipt: false },
      TODAY,
    );
    expect(breaches.map((b) => b.code).sort()).toEqual(["amount_cap", "receipt_required", "too_old"]);
  });

  it("ignores a limit that is not a limit", () => {
    // A zero or negative cap would refuse every claim in the category while reading as a policy on screen. The
    // write path refuses to store one; this is the second line of defence for a row that predates it.
    expect(categoryBreaches({ amountCap: 0 }, { ...ok, amount: 1 }, TODAY)).toEqual([]);
    expect(categoryBreaches({ amountCap: -5 }, { ...ok, amount: 1 }, TODAY)).toEqual([]);
    expect(categoryBreaches({ maxAgeDays: Number.NaN }, { ...ok, incurredOn: ago(900) }, TODAY)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// One invoice split across cost centres. The sum is the whole rule: lines that do not add up to the invoice
// would charge cost centres a different total from the one the company paid, and nothing downstream could
// notice, because each side would be internally consistent.
// ---------------------------------------------------------------------------------------------------------

describe("allocationError", () => {
  it("accepts a split that adds up", () => {
    expect(allocationError([{ amount: 600 }, { amount: 400 }], 1000)).toBeNull();
  });

  it("treats no split as no problem", () => {
    // Every ordinary expense. An absent or empty split means the row's own department and category are the
    // whole answer, which must not read as a validation failure.
    expect(allocationError([], 1000)).toBeNull();
    expect(allocationError(null, 1000)).toBeNull();
    expect(allocationError(undefined, 1000)).toBeNull();
  });

  it("refuses a split that does not add up, and says what it came to", () => {
    const err = allocationError([{ amount: 600 }, { amount: 300 }], 1000);
    expect(err).toContain("900");
    expect(err).toContain("1000");
    // Over as well as under: charging cost centres MORE than the invoice is the same defect.
    expect(allocationError([{ amount: 600 }, { amount: 600 }], 1000)).not.toBeNull();
  });

  it("tolerates the rounding a split of its own creates", () => {
    // A three-way split of 100 cannot come out exact. Refusing it would be pedantry about an artefact of the
    // app's own arithmetic, so each line may absorb a paise.
    expect(allocationError([{ amount: 33.33 }, { amount: 33.33 }, { amount: 33.34 }], 100)).toBeNull();
    expect(allocationError([{ amount: 33.33 }, { amount: 33.33 }, { amount: 33.33 }], 100)).toBeNull();
    // ...but the tolerance is per line, so it cannot be stretched into hiding a real gap.
    expect(allocationError([{ amount: 30 }, { amount: 30 }, { amount: 30 }], 100)).not.toBeNull();
  });

  it("refuses a line that is not an amount", () => {
    expect(allocationError([{ amount: 0 }, { amount: 1000 }], 1000)).not.toBeNull();
    expect(allocationError([{ amount: -100 }, { amount: 1100 }], 1000)).not.toBeNull();
    expect(allocationError([{ amount: Number.NaN }], 1000)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------
// The straight-through lane. Amount decides only whether a claim is CONSIDERED routine; these guards decide
// whether it actually is. The cases worth pinning are the ones where the answer is "send it to a person".
// ---------------------------------------------------------------------------------------------------------

describe("autoApproveBlocks", () => {
  const clean = { inBudget: true, duplicateOf: null, knownVendor: true, hasReceipt: true };

  it("lets a routine claim through", () => {
    expect(autoApproveBlocks(["in_budget", "not_duplicate", "known_vendor", "has_receipt"], clean)).toEqual([]);
  });

  it("requires nothing when the org has configured nothing", () => {
    // Behaviour before the lane existed: amount alone. An org that has not chosen guards has not asked for
    // them, and inventing one would change what their existing threshold means.
    expect(autoApproveBlocks([], { inBudget: false, duplicateOf: "EXP-1", knownVendor: false, hasReceipt: false })).toEqual([]);
    expect(autoApproveBlocks(null, { inBudget: false, duplicateOf: "EXP-1", knownVendor: false, hasReceipt: false })).toEqual([]);
  });

  it("holds a claim that would put its budget over", () => {
    const [b] = autoApproveBlocks(["in_budget"], { ...clean, inBudget: false });
    expect(b!.guard).toBe("in_budget");
  });

  it("treats no budget at all as nothing to breach", () => {
    // THE THIRD ANSWER. `inBudget: null` means no cap covers this claim - an org that has not budgeted a
    // category has said nothing about it, and refusing to auto-approve for want of a budget nobody created
    // would make the guard a trap rather than a control.
    expect(autoApproveBlocks(["in_budget"], { ...clean, inBudget: null })).toEqual([]);
  });

  it("names the claim it looks like a copy of", () => {
    const [b] = autoApproveBlocks(["not_duplicate"], { ...clean, duplicateOf: "EXP-0412" });
    expect(b!.guard).toBe("not_duplicate");
    expect(b!.message).toContain("EXP-0412");
  });

  it("only checks the guards the org asked for", () => {
    // A claim failing three conditions, where the org only cares about one, is held for that one and told only
    // about that one - the others are not this org's rules.
    const bad = { inBudget: false, duplicateOf: "EXP-1", knownVendor: false, hasReceipt: false };
    expect(autoApproveBlocks(["known_vendor"], bad).map((b) => b.guard)).toEqual(["known_vendor"]);
    expect(autoApproveBlocks(["in_budget", "has_receipt"], bad).map((b) => b.guard)).toEqual(["in_budget", "has_receipt"]);
  });
});

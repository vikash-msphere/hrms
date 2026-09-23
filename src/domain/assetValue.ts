// What a company asset is worth today. Pure arithmetic over three inputs the inventory already holds: what it
// cost, when it was bought, and how long its CATEGORY is written down over.
//
// STRAIGHT LINE, TO ZERO, NOT PRO-RATED BY MONTH. The asset page's question is "what are we holding" - a
// figure to plan a hardware refresh against and to total a stocktake with - not a figure anyone files. Real
// depreciation is an accounting policy (reducing balance, salvage values, half-year conventions, the
// distinction between book and tax), it belongs to whoever keeps the ledger, and quietly answering one of
// those shapes here would make the inventory look like a fixed-asset register it is not. Straight line is the
// one rule a reader can reconstruct from the two numbers in front of them.
//
// ANSWERING NOTHING IS A REAL ANSWER. Every input is optional on the row (most kit an inventory inherits has
// no invoice behind it any more), and `undefined` is what says so. Substituting 0 would report written-off
// equipment and un-priced equipment identically, and any total over the column would then be wrong in the
// direction that matters - understating what the company holds. A caller that wants a total sums the values
// it got and says how many rows it could not value.

const MONTH_MS = 30.436_875 * 86_400_000; // mean Gregorian month: the life is quoted in months, the gap is in ms

/**
 * Written-down value at `nowMs`, or `undefined` when it cannot be known.
 *
 * `undefined` for a missing cost, a missing purchase date or a category with no useful life. Clamped into
 * [0, cost]: nothing appreciates here, and an asset bought in the future (a mis-typed date, a pre-paid order
 * logged early) is worth what it cost rather than more than it cost.
 */
export function bookValue(
  cost: number | null | undefined,
  purchasedAtMs: number | null | undefined,
  usefulLifeMonths: number | null | undefined,
  nowMs: number,
): number | undefined {
  if (cost == null || purchasedAtMs == null || usefulLifeMonths == null) return undefined;
  // A non-finite figure would propagate into every total over this column, which is the hazard
  // http/moneyField.ts exists to fence; a life of zero months has no straight line to draw.
  if (!Number.isFinite(cost) || !Number.isFinite(purchasedAtMs) || !(usefulLifeMonths > 0)) return undefined;
  if (cost <= 0) return 0;

  const elapsedMonths = (nowMs - purchasedAtMs) / MONTH_MS;
  if (elapsedMonths <= 0) return round2(cost);
  if (elapsedMonths >= usefulLifeMonths) return 0;
  return round2(cost * (1 - elapsedMonths / usefulLifeMonths));
}

// Local rather than imported from domain/money.ts: that module's round2 throws on a non-finite figure, which
// is correct where money is being moved and wrong here, where the non-finite case is already answered with
// `undefined` above and this file must stay a pure function of its arguments.
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

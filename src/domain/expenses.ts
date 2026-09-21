// Pure expense domain (NO I/O): budget-period keys/bounds, spend rollup, recurrence next-date. Shared by the
// expense-budgets service (utilization), the cron (recurring generation + budget alerts), and tests.
import { addMonthsFromAnchor, seriesAnchorDay } from "./calendar";
import { round2 } from "./money";

export type RecurrenceRule = "monthly" | "quarterly" | "yearly";
export type PeriodType = "monthly" | "quarterly" | "yearly";

const pad2 = (n: number) => String(n).padStart(2, "0");

// The period key a UTC date falls into, for a period type: "2026" | "2026-Q3" | "2026-07".
export function periodKeyFor(type: PeriodType, d: Date): string {
  const y = d.getUTCFullYear();
  if (type === "yearly") return `${y}`;
  if (type === "quarterly") return `${y}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
  return `${y}-${pad2(d.getUTCMonth() + 1)}`;
}

// [start, end) millisecond bounds of a period key. Throws on a malformed key (defensive; keys are generated).
export function periodBounds(type: PeriodType, key: string): { start: number; end: number } {
  if (type === "yearly") {
    const y = Number(key);
    if (!Number.isInteger(y)) throw new Error(`bad yearly period key: ${key}`);
    return { start: Date.UTC(y, 0, 1), end: Date.UTC(y + 1, 0, 1) };
  }
  if (type === "quarterly") {
    const m = /^(\d{4})-Q([1-4])$/.exec(key);
    if (!m) throw new Error(`bad quarterly period key: ${key}`);
    const y = Number(m[1]);
    const startMonth = (Number(m[2]) - 1) * 3;
    return { start: Date.UTC(y, startMonth, 1), end: Date.UTC(y, startMonth + 3, 1) };
  }
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) throw new Error(`bad monthly period key: ${key}`);
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  return { start: Date.UTC(y, mo, 1), end: Date.UTC(y, mo + 1, 1) };
}

// Advance a UTC date by one recurrence step. `anchorDay` is the series' own day of the month - pass it, or a
// template written for the 31st spends the rest of its life on the 28th after one February (see
// domain/calendar.ts#addMonthsFromAnchor). Omitted, the day is taken from `d`, which is right for the first
// step of a series and for a one-off "when is this due next".
export function advanceRecurrence(d: Date, rule: RecurrenceRule, anchorDay?: number | null): Date {
  return addMonthsFromAnchor(d, rule === "monthly" ? 1 : rule === "quarterly" ? 3 : 12, seriesAnchorDay(d, anchorDay));
}

// Utilization from a cap + spent (+ spend still awaiting approval). `remaining` goes negative on overspend;
// `utilization` is a 0..>1 fraction (0 when the cap is 0, to avoid divide-by-zero). `pending` is NOT part of
// utilization - it is not yet spend - but a cap at 92% with a queue behind it is already blown, so the number
// travels alongside instead of being discovered after approval.
export function budgetUtilization(amount: number, spent: number, pending = 0): { spent: number; pending: number; remaining: number; utilization: number } {
  const s = round2(spent);
  return { spent: s, pending: round2(pending), remaining: round2(amount - s), utilization: amount > 0 ? s / amount : 0 };
}

// ---- Burn forecast --------------------------------------------------------------------------------------

/**
 * How much of a period has to be gone before its run rate is worth extrapolating.
 *
 * The number is a judgement about noise, not about budgets. Two days into a year one invoice implies a 180x
 * overspend; at a sixth of the way through, a single charge still moves the projection a lot but no longer
 * fabricates it. Below this the answer is "not yet", which is an honest thing for a forecast to say and the
 * reason this returns null rather than a wide number.
 */
export const MIN_ELAPSED_TO_PROJECT = 0.15;

/** Where a budget lands at period end if the rest of the period spends like the part already gone.
 *  `elapsed` is the fraction of the period behind us, and it travels with the projection because it is what
 *  tells a reader how much to trust it. `projectedOverBy` is negative when the cap holds. */
export type BudgetProjection = {
  elapsed: number;
  projected: number;
  projectedUtilization: number;
  projectedOverBy: number;
};

/**
 * The budget alert asked forwards instead of backwards.
 *
 * `checkBudgetThresholds` reports a crossing that has already happened, which is true and late: by the time a
 * cap reads 100% the money is spent and the decision it would have informed is behind us. This is the same
 * division in the other direction, and the whole value is the arrival time - a monthly cap on course to finish
 * 30% over says so in week one.
 *
 * NULL IS A REAL ANSWER HERE and it has three causes, deliberately not collapsed into one:
 *   - the period is not the current one. A past period's spend is its total, not a rate to project; an
 *     upcoming one has no elapsed time to divide by.
 *   - too little of the period has gone (`MIN_ELAPSED_TO_PROJECT`).
 *   - there is no cap, or nothing has been spent yet. Zero spend projects zero, which renders as a
 *     reassurance when what it actually means is that there is no data.
 *
 * Callers show nothing when this returns null. A forecast the arithmetic cannot support is worse than no
 * forecast, because the reader has no way to tell the two apart once it is on the page.
 */
export function projectBudget(
  amount: number,
  spent: number,
  range: { start: number; end: number },
  now: number,
  minElapsed: number = MIN_ELAPSED_TO_PROJECT,
): BudgetProjection | null {
  if (!(amount > 0) || !(spent > 0)) return null;
  const span = range.end - range.start;
  if (!(span > 0)) return null;
  if (now < range.start || now >= range.end) return null;
  const elapsed = (now - range.start) / span;
  if (elapsed < minElapsed) return null;
  const projected = round2(spent / elapsed);
  return {
    elapsed,
    projected,
    projectedUtilization: projected / amount,
    projectedOverBy: round2(projected - amount),
  };
}

// ---- Recurring series drift -----------------------------------------------------------------------------

/** How far a generated occurrence may sit from its series' usual amount before it is worth saying so. Five
 *  per cent clears ordinary variation (a metered bill, a part month) and still catches a price rise, which is
 *  the thing this exists to notice. */
export const SERIES_DRIFT_TOLERANCE = 0.05;

/** A generated occurrence that does not cost what this series usually costs. `baseline` is the median of the
 *  occurrences it was compared against, and `samples` is how many there were, because a drift measured
 *  against one prior month is a different claim from one measured against six. */
export type SeriesDrift = {
  baseline: number;
  delta: number;
  deltaFraction: number;
  direction: "up" | "down";
  samples: number;
};

/**
 * Has this occurrence drifted from what the series normally costs?
 *
 * A recurring template clones its own amount, so every occurrence starts out identical and the drift only
 * appears when somebody puts the real invoice figure in. That edit is currently silent, which means a SaaS
 * price rise, a lapsed discount and a double-billed month all look exactly like a rent payment that did not
 * change.
 *
 * THE BASELINE IS A MEDIAN, not a mean, and the difference matters on exactly the series this is for: one
 * double-billed month drags a mean far enough that the NEXT month's correct amount reads as a drop, so a mean
 * reports the same error twice and gets the direction wrong the second time. A median absorbs it.
 *
 * Returns null when there is nothing to compare against or the difference is inside the tolerance. As with
 * `projectBudget`, the null is the point: a flag on every occurrence is a flag nobody reads.
 */
export function seriesDrift(
  amount: number,
  priorAmounts: readonly number[],
  tolerance: number = SERIES_DRIFT_TOLERANCE,
): SeriesDrift | null {
  const priors = priorAmounts.filter((a) => Number.isFinite(a) && a > 0);
  if (!priors.length || !(amount > 0)) return null;
  const baseline = median(priors);
  if (!(baseline > 0)) return null;
  const delta = round2(amount - baseline);
  const deltaFraction = (amount - baseline) / baseline;
  if (Math.abs(deltaFraction) < tolerance) return null;
  return {
    baseline: round2(baseline),
    delta,
    deltaFraction,
    direction: deltaFraction > 0 ? "up" : "down",
    samples: priors.length,
  };
}

/** Middle value, averaging the two middles on an even count. Sorts a copy: the caller's array is its own. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ---- Payment due date -----------------------------------------------------------------------------------

/**
 * When a vendor invoice is payable: the invoice date plus the vendor's agreed terms.
 *
 * FROM THE INVOICE DATE, not from approval. That is what "Net 30" means in the trade, and it is also the only
 * definition that produces a due date a payables list can use - an approval date would let a slow approval
 * quietly extend the term the vendor agreed to, so a company that approved late would look, to its own
 * reports, as though it had paid on time.
 *
 * Null whenever the answer would be invented: no vendor terms agreed, or no invoice date recorded. A payables
 * list shows those rows without a due date rather than guessing one, because a wrong due date is worse than a
 * missing one - it is the number somebody chases against.
 */
export function paymentDueOn(incurredOn: Date | number | null | undefined, termsDays: number | null | undefined): Date | null {
  if (incurredOn === null || incurredOn === undefined) return null;
  if (termsDays === null || termsDays === undefined || !Number.isFinite(termsDays)) return null;
  const from = new Date(incurredOn);
  const ms = from.getTime();
  if (!Number.isFinite(ms)) return null;
  // UTC day arithmetic, like every other date in this module: a due date is a DAY, and adding hours across a
  // DST boundary in a local zone is how a term of 30 days becomes 29 or 31.
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + termsDays));
}

// ---- Rated categories (mileage, per diem) ----------------------------------------------------------------

/** What a rated category charges per unit of. Both spellings are a QUANTITY the claimant asserts, not a
 *  receipt they attach, which is what makes the amount computable and the receipt requirement moot. */
export type RateKind = "per_km" | "per_day";

/** How the unit reads to a person, for a form label and for the line a claim carries. */
export const RATE_UNIT: Readonly<Record<RateKind, string>> = { per_km: "km", per_day: "days" };

/**
 * What a claim against a rated category comes to.
 *
 * Returns null when this is not a rated category, or when the quantity is not a usable one, and the caller
 * then treats the amount as hand-entered exactly as before. That is the difference between a category the org
 * has published a rate for and one it has not, and it has to be checkable without knowing which is which.
 *
 * A quantity of zero returns null rather than zero: an expense of nothing is not a claim, and the app already
 * refuses a non-positive amount everywhere else. Bounded above as a sanity rail - a mistyped 41200 km is a
 * decimal-point slip, not a journey, and the only place it can be caught is before it becomes a total nobody
 * can check.
 */
export const MAX_RATED_QUANTITY = 100_000;

export function ratedAmount(
  rateKind: string | null | undefined,
  rate: number | null | undefined,
  quantity: number | null | undefined,
): number | null {
  if (rateKind !== "per_km" && rateKind !== "per_day") return null;
  if (rate === null || rate === undefined || !Number.isFinite(rate) || rate <= 0) return null;
  if (quantity === null || quantity === undefined || !Number.isFinite(quantity)) return null;
  if (quantity <= 0 || quantity > MAX_RATED_QUANTITY) return null;
  return round2(rate * quantity);
}

// ---- Category policy ------------------------------------------------------------------------------------

/** What a category demands of a claim filed against it. Every field optional, because an unrestricted category
 *  is the normal case and the absence of a rule has to be cheaper to express than the presence of one. */
export type CategoryPolicy = {
  amountCap?: number | null;
  maxAgeDays?: number | null;
  requiresReceipt?: boolean | null;
  rateKind?: string | null;
};

/** One thing wrong with a claim, in words its submitter can act on. `code` is for a caller that wants to
 *  branch; `message` is the sentence, and it names the LIMIT as well as the breach - "over the ₹5,000 limit"
 *  tells somebody what to do next, "too expensive" does not. */
export type PolicyBreach = { code: "amount_cap" | "too_old" | "receipt_required"; message: string };

/**
 * Why this claim cannot be submitted yet, or an empty list.
 *
 * PURE, AND SHARED, which is the point rather than a convenience. The server refuses on this at submit and the
 * form warns on the same function before anybody presses anything, so the two can never disagree about what
 * the rule is - the failure mode otherwise is a form that lets a claim through and a server that rejects it,
 * which is exactly the experience this item exists to remove.
 *
 * A RATED CATEGORY IS EXEMPT FROM THE RECEIPT RULE. Mileage and per diem are paid at a published rate against
 * a stated quantity; there is no invoice for a car journey, so a category that is both rated and
 * receipt-required would be unsatisfiable. Enforcing it anyway would make the rate feature unusable, and
 * silently dropping the requirement without saying so here is how that becomes a surprise.
 *
 * `asOf` is passed rather than read from the clock so the caller decides which day this is - the org's day,
 * not the server's timezone (see services/orgDay.ts).
 */
export function categoryBreaches(
  policy: CategoryPolicy | null | undefined,
  claim: { amount: number; incurredOn: Date | number | null | undefined; hasReceipt: boolean },
  asOf: Date | number,
  money: (n: number) => string = (n) => String(n),
): PolicyBreach[] {
  if (!policy) return [];
  const out: PolicyBreach[] = [];

  const cap = policy.amountCap;
  if (cap !== null && cap !== undefined && Number.isFinite(cap) && cap > 0 && claim.amount > cap) {
    out.push({ code: "amount_cap", message: `This category allows at most ${money(cap)} per claim.` });
  }

  const maxAge = policy.maxAgeDays;
  if (maxAge !== null && maxAge !== undefined && Number.isFinite(maxAge) && maxAge >= 0 && claim.incurredOn != null) {
    const days = daysBetweenUtc(claim.incurredOn, asOf);
    // Only a claim OLDER than the limit breaches. A future-dated one is a different problem the form already
    // refuses, and reporting it here as "too old" would be actively misleading.
    if (days !== null && days > maxAge) {
      out.push({ code: "too_old", message: `This category must be claimed within ${maxAge} days; this one is ${days} days old.` });
    }
  }

  const rated = policy.rateKind === "per_km" || policy.rateKind === "per_day";
  if (policy.requiresReceipt && !rated && !claim.hasReceipt) {
    out.push({ code: "receipt_required", message: "This category needs a receipt attached." });
  }
  return out;
}

/** Whole days from one instant to another, by UTC day boundaries. Day arithmetic, not hours: an age limit
 *  counted in elapsed milliseconds would tick over at whatever time of day the claim was filed. */
function daysBetweenUtc(from: Date | number, to: Date | number): number | null {
  const a = new Date(from);
  const b = new Date(to);
  if (!Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime())) return null;
  const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((day(b) - day(a)) / 86_400_000);
}

// ---- Month-end close ------------------------------------------------------------------------------------

/** The collections the close checklist reads. Named here so the authz middleware and the service bind the same
 *  list: a collection the caller may not list is absent from the scope map and its checks come back empty,
 *  which is the fail-closed behaviour every aggregate route in this app has. */
export const CLOSE_COLLECTIONS = ["expenses", "expense-budgets", "card-transactions"] as const;

/** One thing standing between the org and a closed month. `count` is what a reader acts on; `amount` only
 *  where money is the point (unpaid, overdue), because a count of budgets over their cap IS the finding and
 *  their total is not. `filter` is the query string that opens exactly this set on the expenses list.
 *
 *  Lives in the DOMAIN rather than beside the service that builds it because the SPA renders it: importing the
 *  type from a service drags the worker's own types (D1Database, R2Bucket) into the web build, which is why
 *  every other type this page shares with the server comes from here. */
export type CloseCheck = { key: string; count: number; amount?: number; filter?: string };

// ---- Allocation lines -----------------------------------------------------------------------------------

/** One share of an invoice, charged to a cost centre. Both refs optional: an allocation may name a department,
 *  a category, both, or neither (a share charged to nothing in particular still spends the money). */
export type AllocationLine = { department?: string | null; category?: string | null; amount: number };

/** How far the lines may sit from the invoice total before the split is rejected. One paise per line, because
 *  a three-way split of an odd amount cannot come out exact and refusing it would be arithmetic pedantry about
 *  a rounding the app itself created. */
export const ALLOCATION_TOLERANCE = 0.01;

/**
 * Why this split cannot be saved, or null.
 *
 * THE SUM IS THE WHOLE RULE. Lines that do not add up to the invoice are the failure this feature could
 * plausibly introduce: the budget attribution would charge cost centres a different total from the one the
 * company paid, and nothing downstream could notice, because each side is internally consistent. So it is
 * checked on the way in, once, where a person can still fix it.
 *
 * An empty list is not an error - it means "no split", which is every ordinary expense.
 */
export function allocationError(lines: readonly AllocationLine[] | null | undefined, total: number): string | null {
  if (!lines || lines.length === 0) return null;
  if (lines.some((l) => !Number.isFinite(l.amount) || l.amount <= 0)) {
    return "every split line needs an amount greater than 0";
  }
  const sum = round2(lines.reduce((t, l) => t + l.amount, 0));
  // Tolerance scales with the number of lines: each one can absorb a paise of rounding, and a split with more
  // lines has more places for that to happen.
  if (Math.abs(sum - round2(total)) > ALLOCATION_TOLERANCE * lines.length) {
    return `the split adds up to ${sum}, but the expense is ${round2(total)}`;
  }
  return null;
}

// ---- Straight-through approval ---------------------------------------------------------------------------

/** The conditions an org can require before a small claim approves itself. Data, not code: every one is a
 *  deterministic fact about the claim, checked by the server, and an org picks which of them it cares about. */
export const AUTO_APPROVE_GUARDS = ["in_budget", "not_duplicate", "known_vendor", "has_receipt"] as const;
export type AutoApproveGuard = (typeof AUTO_APPROVE_GUARDS)[number];

/** Why a claim under the threshold is NOT approving itself. Empty means nothing stood in the way. */
export type AutoApproveBlock = { guard: AutoApproveGuard; message: string };

/**
 * Should this claim skip the approval queue?
 *
 * THE VALUE IS NOT THE APPROVAL, it is what the queue becomes. Two hundred claims a month that a human clicks
 * through is a queue nobody reads, and a queue nobody reads approves everything anyway, only slower. Taking
 * the routine ninety-five per cent out of it is what makes the remaining five per cent get read.
 *
 * WHAT THIS IS NOT. Auto-approval today fires on AMOUNT ALONE, which means a duplicate claim under the
 * threshold approves itself, as does one that puts its budget over. The guards are the org's own list of what
 * "routine" means, and every one is arithmetic over rows - nothing here is a suggestion being auto-accepted,
 * which is the line `ai-rollout-plan.md` Decision 5 draws and which this deliberately stays on the right side
 * of. A model contributes nothing to this decision and must not be allowed to.
 *
 * Item 42's second-approval threshold is the counterweight and is checked separately: straight-through
 * processing below a line is only defensible while there is a firmer hand above one.
 */
export function autoApproveBlocks(
  required: readonly AutoApproveGuard[] | null | undefined,
  facts: { inBudget: boolean | null; duplicateOf: string | null; knownVendor: boolean; hasReceipt: boolean },
): AutoApproveBlock[] {
  if (!required?.length) return [];
  const out: AutoApproveBlock[] = [];
  for (const guard of required) {
    // `inBudget` is nullable because "no cap covers this claim" is a third answer, not a yes or a no. Treated
    // as SATISFIED: an org that has not budgeted a category has not said anything about it, and refusing to
    // auto-approve for want of a budget nobody created would make the guard a trap rather than a control.
    if (guard === "in_budget" && facts.inBudget === false) {
      out.push({ guard, message: "it would put its budget over" });
    }
    if (guard === "not_duplicate" && facts.duplicateOf) {
      out.push({ guard, message: `it looks like ${facts.duplicateOf}` });
    }
    if (guard === "known_vendor" && !facts.knownVendor) {
      out.push({ guard, message: "it names no vendor on file" });
    }
    if (guard === "has_receipt" && !facts.hasReceipt) {
      out.push({ guard, message: "it has no receipt attached" });
    }
  }
  return out;
}

// ---- Duplicate claims -----------------------------------------------------------------------------------
// "This looks like one you already filed."
//
// The honest double-submit is the common case: the same receipt entered twice, days apart, because the first
// one was a draft nobody finished. Caught at SUBMIT it costs the filer one click; caught at approval it is a
// conversation, and caught after payment it is a recovery.
//
// DETERMINISTIC, AND DELIBERATELY SO. The plan paired this with a vector comparison to catch a claim retyped
// with different wording. That half is not built, because the only field worth embedding for it is the
// free-text `description`, which can carry medical detail bridged from a personal reimbursement
// (`expenses.reimbursement_id`) - so embedding it is a privacy decision rather than a feature decision. The
// arithmetic below catches the exact re-entry more reliably than a vector ever would, and needs no model, no
// consented path and no new data leaving the row.
//
// A STATEMENT ABOUT TWO DOCUMENTS, never about the person. Nothing here scores a filer, counts their history
// or produces anything that could be read as an accusation: it says these two claims look alike and leaves
// the judgement to a human who can see both.

/** The fields a duplicate is judged on. Dates are ms at UTC midnight, as the date-only columns store them. */
export type DuplicateCandidate = {
  id: string;
  amount: number;
  vendorId: string | null;
  categoryId: string | null;
  incurredMs: number | null;
  invoiceNumber: string | null;
};

/** Why two claims were matched, so the warning can say it rather than just assert a resemblance. */
export type DuplicateReason = "same_invoice" | "same_amount_vendor_date" | "same_amount_category_date";

export type DuplicateMatch = { id: string; reason: DuplicateReason };

/**
 * How far apart two claims may be incurred and still be the same one.
 *
 * Two days, not zero: the pair this exists to catch is a receipt entered twice from memory, and the second
 * entry often carries the date it was filed rather than the date on the receipt. Wider than a few days and
 * genuine repeat spending - a daily commute, a weekly supplier - starts matching itself.
 */
export const DUPLICATE_DAY_WINDOW = 2;

/** Amounts equal to the paisa. A tolerance here would match a 500 lunch against a different 501 lunch, and
 *  the exact re-entry this targets is exact by construction. */
const sameAmount = (a: number, b: number) => round2(a) === round2(b);

const withinWindow = (a: number | null, b: number | null): boolean => {
  if (a === null || b === null) return false; // an undated claim states nothing about when it happened
  return Math.abs(a - b) <= DUPLICATE_DAY_WINDOW * 86_400_000;
};

const invoiceKey = (s: string | null): string | null => {
  const t = (s ?? "").trim().toLowerCase();
  return t === "" ? null : t;
};

/**
 * Existing claims that look like `candidate`, strongest reason first.
 *
 * Three rules, in descending confidence:
 *   1. the same invoice number - an invoice number identifies a document, so two claims carrying one are the
 *      same document whatever else differs (amount corrected, date retyped);
 *   2. the same amount, the same vendor, within the day window;
 *   3. the same amount, the same category, within the day window - for the filer who did not pick a vendor,
 *      which is most of them on a small claim.
 *
 * Rule 3 is the loosest and is why this WARNS rather than blocks. `candidate.id` is excluded so an edit does
 * not match the row being edited.
 */
export function findDuplicateClaims(
  candidate: DuplicateCandidate,
  existing: readonly DuplicateCandidate[],
): DuplicateMatch[] {
  const inv = invoiceKey(candidate.invoiceNumber);
  const out: DuplicateMatch[] = [];
  for (const e of existing) {
    if (e.id === candidate.id) continue;
    if (inv && invoiceKey(e.invoiceNumber) === inv) {
      out.push({ id: e.id, reason: "same_invoice" });
      continue;
    }
    if (!sameAmount(candidate.amount, e.amount) || !withinWindow(candidate.incurredMs, e.incurredMs)) continue;
    // A vendor match is the stronger claim, so it is tested first and the two never both fire for one row.
    if (candidate.vendorId && e.vendorId === candidate.vendorId) {
      out.push({ id: e.id, reason: "same_amount_vendor_date" });
      continue;
    }
    // TWO KNOWN VENDORS THAT DISAGREE END IT. A vendor difference is positive evidence that these are
    // different claims, and rule 3 must not overrule it - two 1,200 taxi rides on one day from different
    // companies share a category and are still two rides. This was an `else` at first, which let the weaker
    // rule fire precisely where the stronger one had already answered "no": the ranking said a vendor match
    // outranks a category match, but only vendors that AGREED were being listened to.
    //
    // Rule 3 therefore applies only where the vendor CANNOT discriminate: neither side records one, or one
    // side does not. The one-sided case stays in deliberately - a claim re-entered from memory often omits
    // the vendor the original carried, which is the duplicate this rule exists to catch.
    if (candidate.vendorId && e.vendorId) continue;
    if (candidate.categoryId && e.categoryId === candidate.categoryId) {
      out.push({ id: e.id, reason: "same_amount_category_date" });
    }
  }
  const RANK: Record<DuplicateReason, number> = { same_invoice: 0, same_amount_vendor_date: 1, same_amount_category_date: 2 };
  return out.sort((a, b) => RANK[a.reason] - RANK[b.reason]);
}

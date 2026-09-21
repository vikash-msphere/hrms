// Expense categories: org-wide reference (mirrors reimbursement-categories). Configurable in Settings; expenses
// reference one. `requires_receipt` makes an invoice attachment mandatory; `gl_code` is the accounting code.
// `rate_kind` + `rate` make a category PRICED rather than claimed: mileage and per diem have no invoice, so the
// claimant states a distance or a number of days and the amount follows (domain/expenses.ts#ratedAmount).
import * as schema from "../db/schema";
import { invalidArgument } from "../lib/errors";
import { has, type CrudSpec, type SetOf } from "./crud";

export type ExpenseCategoryInput = {
  display_name?: string;
  requires_receipt?: boolean;
  gl_code?: string | null;
  rate_kind?: "per_km" | "per_day" | null;
  rate?: number | null;
  amount_cap?: number | null;
  max_age_days?: number | null;
};

/** A limit, or null for none. Zero is refused rather than stored: a cap of zero would make every claim in the
 *  category impossible while reading on screen as though a policy had simply been set, and an age limit of
 *  zero would mean "claim it the same day", which no finance team means and every mistyped field produces. */
const limit = (v: number | null | undefined, label: string): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw invalidArgument(`${label} must be a positive number, or cleared`);
  return n;
};

/**
 * A category's rate settings, validated as a PAIR.
 *
 * The two fields are meaningless apart - a kind with no rate cannot compute an amount, and a rate with no kind
 * does not say what it is per - so a half-set category would be a category that silently behaves like an
 * ordinary one while looking configured on the Settings screen. Refused rather than tolerated, because the
 * failure is invisible: claims keep working, they are just hand-typed again, and nobody finds out until
 * somebody compares two people's mileage.
 *
 * Clearing is explicit and clears BOTH, so "this is no longer a rated category" cannot leave an orphan rate
 * behind to be picked up by a later edit that sets only the kind.
 */
function rateFields(input: { rate_kind?: string | null; rate?: number | null }): { rateKind: "per_km" | "per_day" | null; rate: number | null } {
  const kind = input.rate_kind ?? null;
  if (kind === null || kind === "") return { rateKind: null, rate: null };
  if (kind !== "per_km" && kind !== "per_day") throw invalidArgument("rate_kind must be per_km or per_day");
  const rate = Number(input.rate);
  if (!Number.isFinite(rate) || rate <= 0) throw invalidArgument("a rated category needs a positive rate");
  return { rateKind: kind, rate };
}

export const expenseCategorySpec: CrudSpec<ExpenseCategoryInput, typeof schema.expenseCategories> = {
  table: schema.expenseCategories,
  collection: "expense-categories",
  auditName: "expense_category",
  notFound: "expense category not found",
  insert: (input) => {
    if (!input.display_name) throw invalidArgument("display_name is required");
    return {
      name: input.display_name,
      requiresReceipt: input.requires_receipt ?? false,
      glCode: input.gl_code?.trim() || null,
      amountCap: limit(input.amount_cap, "amount_cap"),
      maxAgeDays: limit(input.max_age_days, "max_age_days"),
      ...rateFields(input),
    };
  },
  patch: (patch, row) => {
    const set: SetOf<typeof schema.expenseCategories> = {};
    if (has(patch, "display_name")) set.name = patch.display_name;
    if (has(patch, "requires_receipt")) set.requiresReceipt = patch.requires_receipt;
    if (has(patch, "gl_code")) set.glCode = patch.gl_code?.trim() || null;
    if (has(patch, "amount_cap")) set.amountCap = limit(patch.amount_cap, "amount_cap");
    if (has(patch, "max_age_days")) set.maxAgeDays = limit(patch.max_age_days, "max_age_days");
    // Either field mentioned re-validates the PAIR, against the row's current values rather than against the
    // patch alone. This is a merge-patch: a body carrying only `rate` means "change the rate", and validating
    // the patch by itself would read the absent `rate_kind` as a clear and quietly turn a mileage category into
    // an ordinary one - the edit would report success and the next claim would be hand-typed.
    if (has(patch, "rate_kind") || has(patch, "rate")) {
      Object.assign(set, rateFields({
        rate_kind: has(patch, "rate_kind") ? patch.rate_kind : row.rateKind,
        rate: has(patch, "rate") ? patch.rate : row.rate,
      }));
    }
    return set;
  },
};

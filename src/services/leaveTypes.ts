// Leave types: the org's leave catalog. Each type carries its own accrual rate (with a separate probation
// rate), encashment and carry-forward policy; balances are accrued per type by services/leaveAccrual.ts.
import * as schema from "../db/schema";
import { invalidArgument } from "../lib/errors";
import { has, type CrudSpec, type SetOf } from "./crud";
import { accrueLeave } from "./leaveAccrual";
import { validateRestrictions } from "../domain/leaveRestrictions";

export type LeaveTypeInput = {
  display_name?: string;
  accrual_days_per_year?: number;
  accrual_frequency?: string;
  accrual_cap_days?: number | null;
  paid?: boolean;
  color?: string | null;
  available_during_probation?: boolean;
  probation_accrual_days_per_year?: number;
  probation_cap_days?: number | null;
  encashable?: boolean;
  encashment_cap_days_per_year?: number | null;
  min_balance_retained_days?: number;
  carry_forward?: boolean;
  carry_forward_cap_days?: number | null;
  restrictions?: Record<string, unknown> | null;
};

const frequency = (v?: string) => (v === "semi_monthly" ? "semi_monthly" : "monthly");

/**
 * Store the restrictions blob AS WRITTEN, once it has been validated.
 *
 * Not the parsed form: parsing fills every leaf it did not find with null, and a null leaf is how a type says
 * "exempt me from the org's rule" (domain/leaveRestrictions.ts mergeRestrictions). Storing the parsed blob
 * would therefore turn every leave type into an exemption from every org-wide rule the moment anybody saved
 * it - the policy would appear to apply and quietly apply to nobody.
 */
const restrictionsFor = (v: Record<string, unknown> | null | undefined) => {
  if (v == null) return null;
  validateRestrictions(v); // throws 400 on an unknown section/leaf or an unusable value
  return v;
};

export const leaveTypeSpec: CrudSpec<LeaveTypeInput, typeof schema.leaveTypes> = {
  table: schema.leaveTypes,
  collection: "leave-types",
  auditName: "leave_type",
  notFound: "leave type not found",
  insert: (input) => {
    if (!input.display_name) throw invalidArgument("display_name is required");
    return {
      name: input.display_name,
      accrualDaysPerYear: input.accrual_days_per_year ?? 0,
      accrualFrequency: frequency(input.accrual_frequency),
      accrualCapDays: input.accrual_cap_days ?? null,
      paid: input.paid ?? true,
      color: input.color?.trim() || null,
      availableDuringProbation: input.available_during_probation ?? true,
      probationAccrualDaysPerYear: input.probation_accrual_days_per_year ?? 0,
      probationCapDays: input.probation_cap_days ?? null,
      encashable: input.encashable ?? false,
      encashmentCapDaysPerYear: input.encashment_cap_days_per_year ?? null,
      minBalanceRetainedDays: input.min_balance_retained_days ?? 0,
      carryForward: input.carry_forward ?? false,
      carryForwardCapDays: input.carry_forward_cap_days ?? null,
      restrictions: restrictionsFor(input.restrictions),
    };
  },
  patch: (patch) => {
    const set: SetOf<typeof schema.leaveTypes> = {};
    if (has(patch, "display_name")) set.name = patch.display_name;
    if (has(patch, "accrual_days_per_year")) set.accrualDaysPerYear = patch.accrual_days_per_year;
    if (has(patch, "accrual_frequency")) set.accrualFrequency = frequency(patch.accrual_frequency);
    if (has(patch, "accrual_cap_days")) set.accrualCapDays = patch.accrual_cap_days ?? null;
    if (has(patch, "paid")) set.paid = patch.paid;
    if (has(patch, "color")) set.color = patch.color?.trim() || null;
    if (has(patch, "available_during_probation")) set.availableDuringProbation = patch.available_during_probation;
    if (has(patch, "probation_accrual_days_per_year")) set.probationAccrualDaysPerYear = patch.probation_accrual_days_per_year;
    if (has(patch, "probation_cap_days")) set.probationCapDays = patch.probation_cap_days;
    if (has(patch, "encashable")) set.encashable = patch.encashable;
    if (has(patch, "encashment_cap_days_per_year")) set.encashmentCapDaysPerYear = patch.encashment_cap_days_per_year;
    if (has(patch, "min_balance_retained_days")) set.minBalanceRetainedDays = patch.min_balance_retained_days;
    if (has(patch, "carry_forward")) set.carryForward = patch.carry_forward;
    if (has(patch, "carry_forward_cap_days")) set.carryForwardCapDays = patch.carry_forward_cap_days;
    if (has(patch, "restrictions")) set.restrictions = restrictionsFor(patch.restrictions);
    return set;
  },
  // Accrual rate changed -> re-accrue this type now so balances update immediately (otherwise the change
  // wouldn't take effect until the next daily cron). Idempotent: only credits months not already recorded.
  //
  // `restrictions` is in the list because the joining-date rule prices the joining month
  // (domain/leave.ts JoiningRule) - it is an accrual input like the rate is, and an edit to it that only took
  // effect at 02:00 the next morning would read as a policy that did not save. It applies to months not yet
  // credited, like every other change here: a month already behind the accrual marker was paid for under the
  // policy of the day and is not restated, which is the same rule a mid-year rate change follows.
  afterUpdate: async (deps, _actor, row, _before, patch) => {
    if (has(patch, "accrual_days_per_year") || has(patch, "probation_accrual_days_per_year") || has(patch, "accrual_frequency") || has(patch, "restrictions"))
      await accrueLeave(deps, row.uuid);
  },
};


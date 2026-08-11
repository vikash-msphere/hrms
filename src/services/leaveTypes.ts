// Leave types: the org's leave catalog. Each type carries its own accrual rate (with a separate probation
// rate), encashment and carry-forward policy; balances are accrued per type by services/leaveAccrual.ts.
import * as schema from "../db/schema";
import { invalidArgument } from "../lib/errors";
import { crudService, has, type CrudSpec } from "./crud";
import { accrueLeave } from "./leaveAccrual";

export type LeaveTypeInput = {
  display_name?: string;
  accrual_days_per_year?: number;
  accrual_frequency?: string;
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
};

const frequency = (v?: string) => (v === "semi_monthly" ? "semi_monthly" : "monthly");

export const leaveTypeSpec: CrudSpec<LeaveTypeInput> = {
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
      paid: input.paid ?? true,
      color: input.color ?? null,
      availableDuringProbation: input.available_during_probation ?? true,
      probationAccrualDaysPerYear: input.probation_accrual_days_per_year ?? 0,
      probationCapDays: input.probation_cap_days ?? null,
      encashable: input.encashable ?? false,
      encashmentCapDaysPerYear: input.encashment_cap_days_per_year ?? null,
      minBalanceRetainedDays: input.min_balance_retained_days ?? 0,
      carryForward: input.carry_forward ?? false,
      carryForwardCapDays: input.carry_forward_cap_days ?? null,
    };
  },
  patch: (patch) => {
    const set: Record<string, unknown> = {};
    if (has(patch, "display_name")) set.name = patch.display_name;
    if (has(patch, "accrual_days_per_year")) set.accrualDaysPerYear = patch.accrual_days_per_year;
    if (has(patch, "accrual_frequency")) set.accrualFrequency = frequency(patch.accrual_frequency);
    if (has(patch, "paid")) set.paid = patch.paid;
    if (has(patch, "color")) set.color = patch.color;
    if (has(patch, "available_during_probation")) set.availableDuringProbation = patch.available_during_probation;
    if (has(patch, "probation_accrual_days_per_year")) set.probationAccrualDaysPerYear = patch.probation_accrual_days_per_year;
    if (has(patch, "probation_cap_days")) set.probationCapDays = patch.probation_cap_days;
    if (has(patch, "encashable")) set.encashable = patch.encashable;
    if (has(patch, "encashment_cap_days_per_year")) set.encashmentCapDaysPerYear = patch.encashment_cap_days_per_year;
    if (has(patch, "min_balance_retained_days")) set.minBalanceRetainedDays = patch.min_balance_retained_days;
    if (has(patch, "carry_forward")) set.carryForward = patch.carry_forward;
    if (has(patch, "carry_forward_cap_days")) set.carryForwardCapDays = patch.carry_forward_cap_days;
    return set;
  },
  // Accrual rate changed -> re-accrue this type now so balances update immediately (otherwise the change
  // wouldn't take effect until the next daily cron). Idempotent: only credits months not already recorded.
  afterUpdate: async (deps, _actor, row, _before, patch) => {
    if (has(patch, "accrual_days_per_year") || has(patch, "probation_accrual_days_per_year") || has(patch, "accrual_frequency"))
      await accrueLeave(deps, row.uuid);
  },
};

export const {
  list: listLeaveTypes,
  get: getLeaveType,
  create: createLeaveType,
  update: updateLeaveType,
  remove: deleteLeaveType,
  restore: restoreLeaveType,
  purge: purgeLeaveType,
} = crudService(leaveTypeSpec);

import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { leaveTypeSpec } from "../services/leaveTypes";
import { toLeaveTypeResource } from "../http/serialize";

const writeSchema = z.object({
  display_name: z.string().min(1).optional(),
  accrual_days_per_year: z.number().min(0).optional(),
  accrual_frequency: z.enum(["monthly", "semi_monthly"]).optional(),
  paid: z.boolean().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  available_during_probation: z.boolean().optional(),
  probation_accrual_days_per_year: z.number().min(0).optional(),
  probation_cap_days: z.number().min(0).nullable().optional(),
  encashable: z.boolean().optional(),
  encashment_cap_days_per_year: z.number().min(0).nullable().optional(),
  min_balance_retained_days: z.number().min(0).optional(),
  carry_forward: z.boolean().optional(),
  carry_forward_cap_days: z.number().min(0).nullable().optional(),
}).strict();

export const leaveTypes = collectionRoutes({
  ...leaveTypeSpec,
  param: "leave_type_id",
  writeSchema,
  serialize: toLeaveTypeResource,
  lifecycleName: "leave-type",
});

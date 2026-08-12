import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { benefitPlanSpec } from "../services/benefitPlans";
import { toBenefitPlanResource } from "../http/serialize";

const writeSchema = z.object({
  name: z.string().min(1).optional(),
  category: z.enum(["health", "dental", "vision", "life", "disability", "retirement", "other"]).optional(),
  description: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  employee_cost: z.number().optional(),
  employer_cost: z.number().optional(),
  cost_period: z.enum(["month", "year"]).optional(),
  allows_dependents: z.boolean().optional(),
  auto_enroll: z.boolean().optional(),
}).strict();

export const benefitPlans = collectionRoutes({ ...benefitPlanSpec, param: "plan_id", writeSchema, serialize: toBenefitPlanResource });

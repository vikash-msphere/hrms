// Benefit plans: the catalog an employee enrols into (benefit-enrollments). Costs are per employee per
// `cost_period`; `auto_enroll` is what the new-hire automation picks up.
import * as schema from "../db/schema";
import { invalidArgument } from "../lib/errors";
import { has, type CrudSpec, type SetOf } from "./crud";

type Category = typeof schema.benefitPlans.$inferSelect.category;
export type BenefitPlanInput = {
  name?: string;
  category?: Category;
  description?: string | null;
  provider?: string | null;
  employee_cost?: number;
  employer_cost?: number;
  cost_period?: "month" | "year";
  allows_dependents?: boolean;
  auto_enroll?: boolean;
};

const period = (v?: string) => (v === "year" ? "year" : "month");

export const benefitPlanSpec: CrudSpec<BenefitPlanInput, typeof schema.benefitPlans> = {
  table: schema.benefitPlans,
  collection: "benefit-plans",
  auditName: "benefit-plan",
  notFound: "benefit plan not found",
  insert: (input) => {
    if (!input.name?.trim()) throw invalidArgument("name is required");
    return {
      name: input.name.trim(),
      category: input.category ?? "health",
      description: input.description?.trim() || null,
      provider: input.provider?.trim() || null,
      employeeCost: Math.max(0, input.employee_cost ?? 0),
      employerCost: Math.max(0, input.employer_cost ?? 0),
      costPeriod: period(input.cost_period),
      allowsDependents: !!input.allows_dependents,
      autoEnroll: !!input.auto_enroll,
    };
  },
  patch: (patch) => {
    const set: SetOf<typeof schema.benefitPlans> = {};
    if (has(patch, "name")) {
      if (!patch.name?.trim()) throw invalidArgument("name is required");
      set.name = patch.name.trim();
    }
    if (has(patch, "category")) set.category = patch.category;
    if (has(patch, "description")) set.description = patch.description?.trim() || null;
    if (has(patch, "provider")) set.provider = patch.provider?.trim() || null;
    if (has(patch, "employee_cost")) set.employeeCost = Math.max(0, patch.employee_cost ?? 0);
    if (has(patch, "employer_cost")) set.employerCost = Math.max(0, patch.employer_cost ?? 0);
    if (has(patch, "cost_period")) set.costPeriod = period(patch.cost_period);
    if (has(patch, "allows_dependents")) set.allowsDependents = !!patch.allows_dependents;
    if (has(patch, "auto_enroll")) set.autoEnroll = !!patch.auto_enroll;
    return set;
  },
};


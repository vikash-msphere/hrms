// Benefit plans. employeeCost/employerCost are contributions per costPeriod; allowsDependents gates whether
// an enrollment can cover the employee's dependents.
import { Ctx, T0, q, b, code2, rows } from "../lib";

type BenefitPlanSeed = {
  name: string;
  category: "health" | "dental" | "vision" | "life" | "disability" | "retirement" | "other";
  description: string;
  provider: string;
  employeeCost: number;
  employerCost: number;
  costPeriod: "month" | "year";
  allowsDependents: boolean;
  autoEnroll?: boolean; // new hires are auto-enrolled (employer-paid mandatory cover)
};

const BENEFIT_PLANS: BenefitPlanSeed[] = [
  { name: "Group Health Insurance", category: "health", description: "Family floater group mediclaim, ₹5,00,000 sum insured.", provider: "TBD insurer", employeeCost: 0, employerCost: 1500, costPeriod: "month", allowsDependents: true, autoEnroll: true },
  { name: "Group Personal Accident", category: "disability", description: "Accidental death & disability cover.", provider: "TBD insurer", employeeCost: 0, employerCost: 200, costPeriod: "month", allowsDependents: false, autoEnroll: true },
  { name: "Group Term Life", category: "life", description: "Term life cover, 3x annual CTC.", provider: "TBD insurer", employeeCost: 0, employerCost: 300, costPeriod: "month", allowsDependents: false, autoEnroll: true },
  { name: "National Pension System (NPS)", category: "retirement", description: "Voluntary NPS contribution (employer 80CCD(2) eligible).", provider: "NPS Trust", employeeCost: 0, employerCost: 0, costPeriod: "month", allowsDependents: false },
];

export function benefitPlans(ctx: Ctx): string {
  return rows(
    "INSERT INTO benefit_plans (uuid,code,name,category,description,provider,employee_cost,employer_cost,cost_period,allows_dependents,auto_enroll,created_at,updated_at) VALUES",
    BENEFIT_PLANS.map((p, i) =>
      ` (${q(ctx.nid())},${q(code2(i + 1))},${q(p.name)},${q(p.category)},${q(p.description)},${q(p.provider)},${p.employeeCost},${p.employerCost},${q(p.costPeriod)},${b(p.allowsDependents)},${b(!!p.autoEnroll)},${T0},${T0})`,
    ),
  );
}

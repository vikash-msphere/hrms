import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { complianceRuleSpec } from "../services/complianceRules";
import { toComplianceRuleResource } from "../http/serialize";

// Recurring compliance obligations (auto-generate compliance-events). NO access checks - middleware gates the
// path by grants (private by default). Standard CRUD + soft-delete/restore; create/update also generate
// occurrences (in the service's afterCreate/afterUpdate).
const writeSchema = z
  .object({
    title: z.string().min(1).optional(),
    category: z.string().nullable().optional(),
    frequency: z.enum(["monthly", "quarterly", "annual"]).optional(),
    due_day: z.number().int().min(1).max(31).optional(),
    anchor_month: z.number().int().min(1).max(12).nullable().optional(),
    assignee: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict();

export const complianceRules = collectionRoutes({
  ...complianceRuleSpec,
  param: "compliance_rule_id",
  writeSchema,
  serialize: toComplianceRuleResource,
});

import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { goalTemplateSpec, applyGoalTemplate } from "../services/goalTemplates";
import { toGoalTemplateResource } from "../http/serialize";

const writeSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  weight: z.number().optional(),
  due_in_days: z.number().int().min(0).max(3650).nullable().optional(),
  unit: z.string().max(24).nullable().optional(),
  baseline_value: z.number().nullable().optional(),
  target_value: z.number().nullable().optional(),
  department: z.string().nullable().optional(),
  group_name: z.string().max(80).nullable().optional(),
  disabled: z.boolean().optional(),
}).strict();
const applySchema = z.object({
  employees: z.array(z.string()).min(1).max(200),
  cycle: z.string().nullable().optional(),
}).strict();

// Goal templates: the org's catalogue of goal blueprints. Ordinary reference-data CRUD plus `:apply`, which
// is the reason it exists - one press turns a blueprint into a real goal for a whole team.
export const goalTemplates = collectionRoutes({
  ...goalTemplateSpec,
  param: "template_id",
  writeSchema,
  serialize: toGoalTemplateResource,
  lifecycleName: "goal-template",
  verbs: {
    apply: { schema: applySchema, run: (deps, user, id, body) => applyGoalTemplate(deps, user, id, body.employees, body.cycle) },
  },
});

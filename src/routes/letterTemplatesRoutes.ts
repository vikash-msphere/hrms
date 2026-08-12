import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { letterTemplateSpec } from "../services/letterTemplates";
import { toLetterTemplateResource } from "../http/serialize";

// blocks/inputs are validated loosely (the resolver only honors a closed vocabulary at render time, exactly
// like the previous settings-backed editor; the schema just guards the wire shape).
const writeSchema = z.object({
  label: z.string().min(1).optional(),
  category: z.string().nullable().optional(),
  filename: z.string().nullable().optional(),
  inputs: z.array(z.any()).nullable().optional(),
  blocks: z.array(z.any()).optional(),
}).strict();

export const letterTemplates = collectionRoutes({
  ...letterTemplateSpec,
  param: "letter_template_id",
  writeSchema,
  serialize: toLetterTemplateResource,
});

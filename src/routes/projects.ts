import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { projectSpec } from "../services/projects";
import { toProjectResource } from "../http/serialize";

const writeSchema = z.object({
  name: z.string().min(1).optional(),
  client: z.string().nullable().optional(),
  code: z.string().nullable().optional(),
  billable: z.boolean().optional(),
  goal: z.string().nullable().optional(),
  status: z.enum(["active", "archived"]).optional(),
}).strict();

export const projects = collectionRoutes({ ...projectSpec, param: "project_id", writeSchema, serialize: toProjectResource });

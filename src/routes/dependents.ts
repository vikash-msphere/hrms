import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { dependentSpec, listDependents } from "../services/dependents";
import { toDependentResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";

const writeSchema = z.object({
  employee: z.string().nullable().optional(),
  name: z.string().min(1).optional(),
  relationship: z.enum(["spouse", "child", "parent", "domestic_partner", "other"]).optional(),
  date_of_birth: z.string().nullable().optional(),
}).strict();

export const dependents = collectionRoutes({
  ...dependentSpec,
  param: "dependent_id",
  writeSchema,
  serialize: toDependentResource,
  list: (c) =>
    listDependents(
      c.get("deps"),
      c.get("scope"),
      clampPageSize(Number(c.req.query("max_page_size")) || undefined),
      c.req.query("page_token"),
      c.req.query("employee"),
      c.req.query("show_deleted") === "true",
    ),
});

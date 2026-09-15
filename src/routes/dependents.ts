import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { dependentSpec, listDependents } from "../services/dependents";
import { toDependentResource } from "../http/serialize";

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
  list: (c, page) =>
    listDependents(
      c.get("deps"),
      c.get("scope"),
      page.maxPageSize,
      page.pageToken,
      c.req.query("employee"),
      page.showDeleted,
      page.deletedOnly,
    ),
});

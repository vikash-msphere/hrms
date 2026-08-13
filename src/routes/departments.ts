import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { departmentSpec, listDepartments, updateDepartment, type DepartmentInput } from "../services/departments";
import { toDepartmentResource } from "../http/serialize";

const writeSchema = z.object({ display_name: z.string().min(1).optional(), parent: z.string().nullable().optional(), managers: z.array(z.string()).nullable().optional() }).strict();

// The org hierarchy. Standard methods plus the shared lifecycle verbs (the table carries locked/disabled) and
// soft delete/restore. The update stays the service's own: changing `parent` re-codes this department and
// cascades the new code through its subtree - sub-departments, employees, their owned rows and any access-rule
// codes - which is a good deal more than a column write.
export const departments = collectionRoutes<DepartmentInput>({
  ...departmentSpec,
  param: "department_id",
  writeSchema,
  serialize: toDepartmentResource,
  overrides: {
    update: (deps, actor, id, patch, ifMatch) => updateDepartment(deps, actor, id, patch, ifMatch),
  },
  list: (c, page) => {
    // `departments` defines a `subtree` read tier, so a scoped grant must not see the whole tree; the middleware
    // decided that scope and the service binds it to the hierarchy code.
    return listDepartments(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, page.showDeleted);
  },
});

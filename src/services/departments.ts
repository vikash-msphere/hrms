import { allocUnderDept, CODE_WIDTH } from "./codeAlloc";
// SIMPLE resource template. Copy this file for holidays, announcements, leave-types,
// pay-components, pay-periods (rename table, fields, capability). See docs/03-add-a-resource.md.
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, diffMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted } from "../lib/errors";
import { moveDepartment } from "./codeCascade";
import { encodeCursor, decodeCursor } from "../http/pagination";
import { etagOf } from "../http/serialize";
import { visibleByDelete } from "./softDelete";
import { assertNotLocked } from "./lifecycle";
import { crudService, type CrudSpec, type SetOf } from "./crud";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";

export type DepartmentInput = { display_name?: string; parent?: string | null; managers?: string[] | null };
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
// Normalise a managers array (employee paths/ids, decoded to internal ids by the inbound edge) to a JSON
// array of employee uuids for storage.
const managerIdsJson = (managers?: string[] | null) =>
  JSON.stringify(Array.from(new Set((managers ?? []).map((m) => idFromPath(m)).filter((x): x is string => !!x))));

// Honors the middleware-decided list scope: `departments` defines a `subtree` read tier, so a scoped grant
// must not see the whole tree. Departments have no employee owner, so the hierarchy `code` is both the scope
// key and the owner column. `all`-breadth callers get no filter (unchanged); a narrower grant is enforced.
export async function listDepartments(deps: Deps, scope: ListScope | undefined, maxPageSize: number, pageToken?: string, showDeleted = false) {
  const where = applyScope(scope, schema.departments.code, schema.departments.code);
  const all = visibleByDelete(await deps.db.select().from(schema.departments).where(where), showDeleted).sort(
    (a, b) => +new Date(a.createdAt) - +new Date(b.createdAt) || a.uuid.localeCompare(b.uuid),
  );
  const cur = decodeCursor(pageToken);
  const start = cur
    ? all.findIndex((e) => +new Date(e.createdAt) > cur.createTimeMs || (+new Date(e.createdAt) === cur.createTimeMs && e.uuid > cur.uid))
    : 0;
  const slice = start < 0 ? [] : all.slice(start, start + maxPageSize);
  const last = slice[slice.length - 1];
  const nextPageToken = start >= 0 && start + maxPageSize < all.length && last ? encodeCursor(+new Date(last.createdAt), last.uuid) : undefined;
  return { items: slice, nextPageToken };
}

// A department is a node in the hierarchy, so its code IS its position in the tree: the create allocates one
// under the chosen parent, and re-parenting (below) has to move the whole subtree with it.
export const departmentSpec: CrudSpec<DepartmentInput, typeof schema.departments> = {
  table: schema.departments,
  collection: "departments",
  auditName: "department",
  notFound: "department not found",
  allocCode: (deps, _table, values) => allocUnderDept(deps, (values.parentId as string | undefined) ?? null, CODE_WIDTH.dept),
  insert: (input) => {
    if (!input.display_name) throw invalidArgument("display_name is required");
    return { name: input.display_name, parentId: idFromPath(input.parent), managerIds: managerIdsJson(input.managers) };
  },
};

// Creating a department is the generic create over the spec above. Named here because the hierarchy tests (and
// anything that has to seed a tree) create departments without going through HTTP.
export const { create: createDepartment } = crudService(departmentSpec);

export async function updateDepartment(deps: Deps, actor: AppUser, id: string, patch: DepartmentInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.departments).where(eq(schema.departments.uuid, id)).limit(1))[0];
  if (!row) throw notFound("department not found");
  assertNotLocked(row);
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: SetOf<typeof schema.departments> = { updatedAt: new Date() };
  const has = (k: keyof DepartmentInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("display_name")) set.name = patch.display_name;
  if (has("managers")) set.managerIds = managerIdsJson(patch.managers);
  if (has("parent")) {
    const next = idFromPath(patch.parent) ?? null;
    // Re-parent: recompute this dept's code + cascade the whole subtree (sub-depts, employees, owned rows) +
    // any access-rule codes. moveDepartment sets parentId itself, so it's not in `set`.
    if (next !== row.parentId) { await moveDepartment(deps, id, row.code!, next); await audit(deps, actor, "department.reparent", "departments", id, { from: row.parentId, to: next }); }
  }
  const [updated] = await deps.db.update(schema.departments).set(set).where(eq(schema.departments.uuid, id)).returning();
  await audit(deps, actor, "department.update", "departments", id, diffMeta(row, updated, set), updated);
  return updated;
}


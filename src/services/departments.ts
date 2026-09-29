import { allocUnderDept, CODE_WIDTH } from "./codeAlloc";
// SIMPLE resource template. Copy this file for holidays, announcements, leave-types,
// pay-components, pay-periods (rename table, fields, capability). See docs/03-add-a-resource.md.
import { and, eq, type SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, diffMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted } from "../lib/errors";
import { moveDepartment } from "./codeCascade";
import { departmentSubtree, syncBoardsUnder } from "./boardShares";
import { keysetPage } from "./keysetPage";
import { etagOf } from "../http/serialize";
import { assertNotLocked } from "./lifecycle";
import { crudService, type CrudSpec, type SetOf } from "./crud";
import { applyScope } from "./listScope";
import { deleteStateFilter } from "./softDelete";
import type { ListScope } from "../domain/access";
import { checkEtag, updateAtVersion } from "./versionGuard";

export type DepartmentInput = { display_name?: string; parent?: string | null; managers?: string[] | null };
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
// Normalise a managers array (employee paths/ids, decoded to internal ids by the inbound edge) to a JSON
// array of employee uuids for storage.
const managerIdsJson = (managers?: string[] | null) =>
  JSON.stringify(Array.from(new Set((managers ?? []).map((m) => idFromPath(m)).filter((x): x is string => !!x))));

// Honors the middleware-decided list scope: `departments` defines a `subtree` read tier, so a scoped grant
// must not see the whole tree. Departments have no employee owner, so the hierarchy `code` is both the scope
// key and the owner column. `all`-breadth callers get no filter (unchanged); a narrower grant is enforced.
export async function listDepartments(deps: Deps, scope: ListScope | undefined, maxPageSize: number, pageToken?: string, showDeleted = false, deletedOnly = false) {
  // Paged in SQL (services/keysetPage.ts), soft-delete filter included, rather than reading the whole tree
  // into the isolate to slice one page out of it.
  const conds = [applyScope(scope, schema.departments.code, schema.departments.code), deleteStateFilter(schema.departments.deleteTime, showDeleted, deletedOnly)];
  return keysetPage<typeof schema.departments.$inferSelect>(deps, schema.departments, "departments", and(...(conds.filter(Boolean) as SQL[])), { dir: "desc", max: maxPageSize, pageToken });
}

// A department is a node in the hierarchy, so its code IS its position in the tree: the create allocates one
// under the chosen parent, and re-parenting (below) has to move the whole subtree with it.
export const departmentSpec: CrudSpec<DepartmentInput, typeof schema.departments> = {
  table: schema.departments,
  collection: "departments",
  auditName: "department",
  notFound: "department not found",
  allocCode: (deps, _table, values, attempt) => allocUnderDept(deps, (values.parentId as string | undefined) ?? null, CODE_WIDTH.dept, attempt > 1),
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
  checkEtag(row, ifMatch);
  const set: SetOf<typeof schema.departments> = { updatedAt: new Date() };
  let moved = false; // a re-parent writes this row itself - see the note by the guarded write below
  const has = (k: keyof DepartmentInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("display_name")) set.name = patch.display_name;
  if (has("managers")) set.managerIds = managerIdsJson(patch.managers);
  if (has("parent")) {
    const next = idFromPath(patch.parent) ?? null;
    // Re-parent: recompute this dept's code + cascade the whole subtree (sub-depts, employees, owned rows) +
    // any access-rule codes. moveDepartment sets parentId itself, so it's not in `set`.
    // Refs, not the bare ids the column holds - same rule as every other FK in an audit meta (lib/audit).
    if (next !== row.parentId) { await moveDepartment(deps, id, row.code!, next); moved = true; await audit(deps, actor, "department.reparent", "departments", id, { from: row.parentId ? `departments/${row.parentId}` : null, to: next ? `departments/${next}` : null }); }
  }
  // THE CASCADE ABOVE REWRITES THIS VERY ROW, so the version to guard the write below with is the one that
  // exists AFTER it, not the one read at the top. The guard is there to refuse somebody ELSE'S concurrent
  // write; pinning the pre-cascade version would make this request conflict with itself and answer 409 for a
  // re-parent that was working perfectly. Re-read only on the path that moved something.
  const version = moved ? (await deps.db.select().from(schema.departments).where(eq(schema.departments.uuid, id)).limit(1))[0] ?? row : row;
  const updated = await updateAtVersion(deps, schema.departments, "department", version, set);
  await audit(deps, actor, "department.update", "departments", id, diffMeta(row, updated, set, "departments"), updated);
  // A department's managers manage the boards filed under it AND under every department below it
  // (services/boardShares.ts), so a change of managers, or of where the department sits, moves board access
  // across the whole subtree.
  if ((has("managers") && updated.managerIds !== row.managerIds) || moved) await syncBoardsUnder(deps, actor, await departmentSubtree(deps, id));
  return updated;
}


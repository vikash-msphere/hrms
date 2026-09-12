// Dependents: who an employee can enrol in a benefit plan. Employee-owned (the code is allocated under the
// owner), so a caller sees their own by scope; HR sees the department or all.
import { eq, and, isNull, type SQL } from "drizzle-orm";
import { CODE_WIDTH, allocOwnedCode } from "./codeAlloc";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { invalidArgument } from "../lib/errors";
import { keysetPage } from "./keysetPage";
import { crudService, has, type CrudSpec, type SetOf } from "./crud";

type Relationship = typeof schema.dependents.$inferSelect.relationship;
export type DependentInput = {
  employee?: string | null;
  name?: string;
  relationship?: Relationship;
  date_of_birth?: string | null;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string | null) => (s ? Date.parse(s + "T00:00:00Z") : NaN);

export async function listDependents(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, employee?: string, showDeleted = false) {
  const conds = [applyScope(scope, schema.dependents.code, schema.dependents.employeeId)];
  const empId = idFromPath(employee);
  if (empId) conds.push(eq(schema.dependents.employeeId, empId));
  if (!showDeleted) conds.push(isNull(schema.dependents.deleteTime));
  // Paged in SQL (services/keysetPage.ts) rather than by reading every dependent the scope matches and
  // slicing one page out of it in the isolate - a whole-org read on the HR lane, billed by rows read, to
  // answer with fifty. The soft-delete filter is in the WHERE for the same reason.
  return keysetPage<typeof schema.dependents.$inferSelect>(deps, schema.dependents, "dependents", and(...(conds.filter(Boolean) as SQL[])), { dir: "desc", max: maxPageSize, pageToken });
}

export const dependentSpec: CrudSpec<DependentInput, typeof schema.dependents> = {
  table: schema.dependents,
  collection: "dependents",
  auditName: "dependent",
  notFound: "dependent not found",
  // Owned code: allocated under the owning employee, which `insert` has just resolved.
  allocCode: (deps, table, values, attempt) => allocOwnedCode(deps, table, schema.dependents.employeeId, values.employeeId as string, CODE_WIDTH.owned, attempt > 1),
  insert: (input, _deps, actor) => {
    if (!input.name?.trim()) throw invalidArgument("name is required");
    const employeeId = idFromPath(input.employee) ?? actor.employeeId;
    if (!employeeId) throw invalidArgument("employee is required");
    if (input.date_of_birth && Number.isNaN(dayMs(input.date_of_birth))) throw invalidArgument("date_of_birth is invalid");
    return {
      employeeId,
      name: input.name.trim(),
      relationship: input.relationship ?? "other",
      dateOfBirth: input.date_of_birth ? new Date(dayMs(input.date_of_birth)) : null,
    };
  },
  patch: (patch) => {
    const set: SetOf<typeof schema.dependents> = {};
    if (has(patch, "name")) { if (!patch.name?.trim()) throw invalidArgument("name is required"); set.name = patch.name.trim(); }
    if (has(patch, "relationship")) set.relationship = patch.relationship;
    if (has(patch, "date_of_birth")) {
      if (patch.date_of_birth && Number.isNaN(dayMs(patch.date_of_birth))) throw invalidArgument("date_of_birth is invalid");
      set.dateOfBirth = patch.date_of_birth ? new Date(dayMs(patch.date_of_birth)) : null;
    }
    return set;
  },
};

export const {
  remove: deleteDependent,
} = crudService(dependentSpec);

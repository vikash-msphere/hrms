// Code allocation at the persistence boundary: fetch the sibling codes in scope, then compose the next
// code via the pure domain core (domain/codes.ts). Tables are loosely typed (`any`) to avoid Drizzle's
// generic gymnastics; every resource table has a `.code` column (schema.ts). The internal `code` is the
// matching/scoping key (docs/archive/plan.txt section 0); it is never on the wire.
//
// NOTE (concurrency): allocation is read-then-write (max+1), so two concurrent creates in the same scope
// can race for a leaf. Acceptable for an internal app now; harden later with a unique index on `code` +
// retry, or a per-scope transaction. Tracked in docs/archive/PROGRESS-AUTHZ.md.
import { eq, isNull } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { nextChildCode } from "../domain/codes";

export const CODE_WIDTH = { dept: 2, employee: 3, owned: 3, flat: 2 } as const;

// Flat resources (holidays, leave-types, pay-periods, announcements, payroll-runs, users): one namespace.
export async function allocFlatCode(deps: Deps, table: any, minWidth: number = CODE_WIDTH.flat): Promise<string> {
  const rows = await deps.db.select({ code: table.code }).from(table);
  return nextChildCode(rows.map((r: { code: string | null }) => r.code), null, minWidth);
}

// Children of a department: BOTH sub-departments (parentId) AND employees (departmentId) share the same
// child-segment namespace under a dept, so they never collide (docs/archive/plan.txt section 0 design note).
export async function allocUnderDept(deps: Deps, parentUuid: string | null, minWidth: number): Promise<string> {
  let parentCode: string | null = null;
  if (parentUuid) {
    const d = (await deps.db.select({ code: schema.departments.code }).from(schema.departments).where(eq(schema.departments.uuid, parentUuid)).limit(1))[0];
    parentCode = d?.code ?? null;
  }
  const subDepts = await deps.db
    .select({ code: schema.departments.code })
    .from(schema.departments)
    .where(parentUuid ? eq(schema.departments.parentId, parentUuid) : isNull(schema.departments.parentId));
  const emps = await deps.db
    .select({ code: schema.employees.code })
    .from(schema.employees)
    .where(parentUuid ? eq(schema.employees.departmentId, parentUuid) : isNull(schema.employees.departmentId));
  return nextChildCode([...subDepts, ...emps].map((r) => r.code), parentCode, minWidth);
}

// Employee-owned resources (leave-requests, documents, payslips, leave-balances, holiday-selections):
// code = owner employee's code + own seg, scoped within (this table, this owner).
export async function allocOwnedCode(deps: Deps, table: any, ownerCol: any, ownerUuid: string, minWidth: number = CODE_WIDTH.owned): Promise<string> {
  const e = (await deps.db.select({ code: schema.employees.code }).from(schema.employees).where(eq(schema.employees.uuid, ownerUuid)).limit(1))[0];
  const rows = await deps.db.select({ code: table.code }).from(table).where(eq(ownerCol, ownerUuid));
  return nextChildCode(rows.map((r: { code: string | null }) => r.code), e?.code ?? null, minWidth);
}

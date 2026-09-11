import { allocOwnedCode } from "./codeAlloc";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { invalidArgument, notFound, failedPrecondition } from "../lib/errors";
import { type CrudSpec } from "./crud";

// Effective-dated role history (designation/department/location). A promotion or transfer is a NEW row
// effective from a chosen date; the previously-current row is closed (effective_to set). Mirrors the
// compensation pattern - there is no in-place edit; history is preserved by design so the promotion/transfer
// letters can read old -> new. The employee's current jobTitle/departmentId are kept in sync with the new row.
export type PositionInput = {
  employee?: string | null;
  job_title?: string | null;
  department?: string | null; // resource path; null clears the department
  location?: string | null;
  note?: string | null;
  effective_from?: string; // YYYY-MM-DD
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string) => (s ? Date.parse(s + "T00:00:00Z") : NaN);

// One employee's role history (newest first), or - unfiltered - everything the caller may see.
//
// PAGED IN SQL, on `effective_from`. One employee's history is short by nature, but the UNFILTERED list is
// org-wide and grows with headcount x every promotion, transfer and relocation the org ever records - and it
// was returning all of it with `nextPageToken: undefined`, so there was no cursor to follow even when the
// answer was truncated by nothing but the Worker's memory. `effective_from` is `notNull`, so it is a valid
// keyset key for every matching row.
export async function listPositions(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, employeeId?: string) {
  const conds = [applyScope(scope, schema.positions.code, schema.positions.employeeId)];
  if (employeeId) conds.push(eq(schema.positions.employeeId, employeeId));
  const where = conds.filter(Boolean).length ? and(...(conds.filter(Boolean) as SQL[])) : undefined;
  return keysetPage<typeof schema.positions.$inferSelect>(deps, schema.positions, "positions", where, {
    max: maxPageSize,
    pageToken,
    order: { expr: sql`${schema.positions.effectiveFrom}`, value: (r) => +new Date(r.effectiveFrom) },
  });
}

// The standard lane for this collection is list + get only: `changeRole` below is its create (see
// routes/positions.ts, which wires it as the create override), and a history row is never edited or deleted.
export const positionSpec: CrudSpec<PositionInput, typeof schema.positions> = {
  table: schema.positions,
  collection: "positions",
  auditName: "position",
  notFound: "position record not found",
};

// Record a role change (promotion/transfer): close the current open row at the new effective date, insert the
// new current row, and sync the employee's current designation/department to match.
export async function changeRole(deps: Deps, actor: AppUser, input: PositionInput) {
  const employeeId = idFromPath(input.employee);
  const from = dayMs(input.effective_from);
  if (!employeeId) throw invalidArgument("employee is required");
  if (Number.isNaN(from)) throw invalidArgument("effective_from is required");
  const emp = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
  if (!emp || emp.deleteTime) throw notFound("employee not found");

  const current = (await deps.db
    .select()
    .from(schema.positions)
    .where(and(eq(schema.positions.employeeId, employeeId), isNull(schema.positions.effectiveTo)))
    .limit(1))[0];
  if (current && +new Date(current.effectiveFrom) >= from) {
    throw failedPrecondition("the effective date must be after the current role's start");
  }

  // Carry forward unspecified fields from the current row (or the employee record on the first ever change),
  // so a promotion that only changes the title keeps the existing department/location, and vice versa.
  const departmentId = input.department !== undefined ? idFromPath(input.department) ?? null : current?.departmentId ?? emp.departmentId ?? null;
  const jobTitle = input.job_title !== undefined ? input.job_title?.trim() || null : current?.jobTitle ?? emp.jobTitle ?? null;
  const location = input.location !== undefined ? input.location?.trim() || null : current?.location ?? null;

  // Half-open intervals: the prior row ends where the new one begins.
  if (current) {
    await deps.db.update(schema.positions).set({ effectiveTo: new Date(from), updatedAt: new Date() }).where(eq(schema.positions.uuid, current.uuid));
  }
  const row = (await deps.db
    .insert(schema.positions)
    .values({
      code: await allocOwnedCode(deps, schema.positions, schema.positions.employeeId, employeeId),
      employeeId,
      jobTitle,
      departmentId,
      location,
      note: input.note?.trim() || null,
      effectiveFrom: new Date(from),
      effectiveTo: null,
    })
    .returning())[0]!;
  // Keep the employee's live current designation/department in sync (the rest of the app reads these).
  await deps.db.update(schema.employees).set({ jobTitle, departmentId, updatedAt: new Date() }).where(eq(schema.employees.uuid, employeeId));
  await audit(deps, actor, "position.change", "positions", row.uuid, { employee: `employees/${employeeId}` });
  return row;
}

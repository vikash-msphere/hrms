import { allocOwnedCode } from "./codeAlloc";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { runBatchChecked } from "../lib/dbBatch";
import { genId } from "../lib/idCodec";
import { invalidArgument, notFound, failedPrecondition, aborted, isOpenTimelineCollision } from "../lib/errors";
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
  employment_type?: string | null;
  work_mode?: string | null;
  note?: string | null;
  effective_from?: string; // YYYY-MM-DD
};
export const EMPLOYMENT_TYPES = ["full_time", "part_time", "contract", "intern", "temporary"] as const;
export const WORK_MODES = ["on_site", "hybrid", "remote"] as const;
type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];
type WorkMode = (typeof WORK_MODES)[number];
/** Narrow an incoming enum, rejecting anything the column cannot hold rather than writing it and finding out. */
function asEnum<T extends string>(allowed: readonly T[], value: string | null | undefined, field: string): T | null {
  if (value === null || value === undefined || value === "") return null;
  const v = value.trim();
  if (!(allowed as readonly string[]).includes(v)) throw invalidArgument(`${field} must be one of: ${allowed.join(", ")}`);
  return v as T;
}
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
  const employmentType: EmploymentType | null = input.employment_type !== undefined
    ? asEnum(EMPLOYMENT_TYPES, input.employment_type, "employment_type")
    : current?.employmentType ?? emp.employmentType ?? null;
  const workMode: WorkMode | null = input.work_mode !== undefined
    ? asEnum(WORK_MODES, input.work_mode, "work_mode")
    : current?.workMode ?? emp.workMode ?? null;

  // Everything the write needs, resolved BEFORE the batch: the code allocation is a read-then-write of its own
  // (services/codeAlloc.ts) and the row id is minted here so the successor can be read back by it. Nothing
  // below this line may fail for a reason other than the writes themselves.
  const code = await allocOwnedCode(deps, schema.positions, schema.positions.employeeId, employeeId);
  const uuid = genId();
  const now = new Date();

  // Half-open intervals: the prior row ends where the new one begins.
  //
  // ONE ATOMIC BATCH, and the close is GUARDED - the same pair services/compensation.ts uses on the salary
  // timeline, which this table mirrors and which it was missing both halves of.
  //
  //   - Guarded (`isNull(effectiveTo)` + a checked row count): two concurrent role changes both read the same
  //     open row, and the loser has to stop rather than close a row that is already closed and open a second
  //     current one. `pos_open_idx` is the DB backstop for the ordering this check cannot see.
  //   - Atomic (D1 executes a batch as one implicit transaction, see lib/dbBatch.ts): close, insert and the
  //     denormalized sync onto `employees` are one row change described three ways, and a failure between them
  //     left the employee with every position row closed - no current role at all - or with a
  //     `employees.department_id` that names a department no position row mentions. That column is a scope key.
  const short = await runBatchChecked(deps.db, [
    ...(current
      ? [{
          stmt: deps.db
            .update(schema.positions)
            .set({ effectiveTo: new Date(from), updatedAt: now })
            .where(and(eq(schema.positions.uuid, current.uuid), isNull(schema.positions.effectiveTo)))
            .returning({ uuid: schema.positions.uuid }),
          expect: 1,
          label: "close the current role",
        }]
      : []),
    deps.db.insert(schema.positions).values({
      uuid,
      code,
      employeeId,
      jobTitle,
      departmentId,
      location,
      employmentType,
      workMode,
      note: input.note?.trim() || null,
      effectiveFrom: new Date(from),
      effectiveTo: null,
    }),
    // Keep the employee's live current designation/department/place in sync (the rest of the app reads these
    // rather than joining this table - see the mirror note on `employees` in db/schema.ts).
    deps.db.update(schema.employees).set({ jobTitle, departmentId, location, employmentType, workMode, updatedAt: now }).where(eq(schema.employees.uuid, employeeId)),
  ]).catch((e: unknown) => {
    // The other ordering of the same race: our close matched nothing and the insert then collided on
    // `pos_open_idx`, so D1 rolled the whole batch back. Same answer as the short count below.
    if (isOpenTimelineCollision(e)) throw aborted("this employee's role was changed concurrently; reload and try again");
    throw e;
  });
  if (short.length) throw aborted("this employee's role was changed concurrently; reload and try again");

  const row = (await deps.db.select().from(schema.positions).where(eq(schema.positions.uuid, uuid)).limit(1))[0]!;
  await audit(deps, actor, "position.change", "positions", row.uuid, { employee: `employees/${employeeId}` });
  return row;
}

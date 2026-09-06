import { allocFlatCode, allocUnderDept, withFreshCode, CODE_WIDTH } from "./codeAlloc";
import { applyScope } from "./listScope";
import { searchFilter } from "./searchFilter";
import type { ListScope } from "../domain/access";
import { eq, and, isNotNull, isNull, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, createdMeta, fieldDiff } from "../lib/audit";
import { emitEvent } from "./eventBus";
import { notify } from "./notifications";
import { invalidArgument, notFound, aborted, isCodeCollision, isEmployeeNumberCollision } from "../lib/errors";
import { moveEmployee } from "./codeCascade";
import { keysetPage } from "./keysetPage";
import { etagOf } from "../http/serialize";
import { assertNotLocked } from "./lifecycle";
import { getSettingValue } from "./settings";
import { DEFAULT_EMPLOYEE_NUMBER_CONFIG, formatEmployeeNumber, nextSeq } from "../domain/employeeNumber";

// Wire input is snake_case (matches the OpenAPI schema). national_id/bank_details are write-only.
export type EmployeeInput = {
  first_name?: string;
  last_name?: string;
  legal_name?: string | null;
  work_email?: string;
  job_title?: string | null;
  employee_number?: string | null; // human ID; auto-assigned on create when omitted, HR-overridable
  department?: string | null; // departments/{id}
  manager?: string | null; // employees/{id}
  start_date?: string | null; // YYYY-MM-DD
  probation_end_date?: string | null; // YYYY-MM-DD
  epf_enrolled?: boolean;
  eps_excluded?: boolean;
  national_id?: string | null;
  // bank details are managed via the dedicated :getBankDetails/:setBankDetails methods.
};

// Next auto employee number from the org format (settings/employee-number) + the highest existing sequence.
// Read-then-write like code allocation - a concurrent double-create can race, but the UNIQUE index on
// employee_number is the backstop (the loser's insert fails). Fine for an internal-scale app.
async function allocEmployeeNumber(deps: Deps): Promise<string> {
  const cfg = await getSettingValue(deps, "employee-number", DEFAULT_EMPLOYEE_NUMBER_CONFIG);
  const rows = await deps.db.select({ n: schema.employees.employeeNumber }).from(schema.employees);
  return formatEmployeeNumber(cfg, nextSeq(cfg, rows.map((r) => r.n)), new Date().getUTCFullYear());
}

// Reject a duplicate human ID (case-insensitive), so an HR override never collides. `exceptId` skips the row
// being updated. The UNIQUE index enforces this at the DB too; this is the friendly, pre-flight check.
async function assertNumberFree(deps: Deps, number: string, exceptId?: string): Promise<void> {
  const key = number.trim().toLowerCase();
  const rows = await deps.db
    .select({ uuid: schema.employees.uuid, n: schema.employees.employeeNumber })
    .from(schema.employees);
  if (rows.some((r) => r.uuid !== exceptId && (r.n ?? "").trim().toLowerCase() === key))
    throw invalidArgument(`employee number ${number} is already in use`);
}

const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dateMs = (s?: string | null) => (s ? new Date(s + "T00:00:00Z") : null);
const addMonths = (ms: number, months: number) => {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()));
};

export async function listEmployees(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, showDeleted = false, q?: string, deletedOnly = false) {
  // Visibility was decided in the middleware (scopeFor over the grant); here we only bind it to columns.
  // `q` narrows further via the FTS index - a filter, never a widening (see services/searchFilter.ts).
  const conds = [
    applyScope(scope, schema.employees.code, schema.employees.uuid),
    // `deletedOnly` is the trash by itself - a "Deleted" view is its own fetch, not a filter over a page of
    // mostly-live people.
    deletedOnly ? isNotNull(schema.employees.deleteTime) : showDeleted ? undefined : isNull(schema.employees.deleteTime),
    await searchFilter(deps, "employees", q, schema.employees.uuid),
  ].filter(Boolean);
  return keysetPage(deps, schema.employees, "employees", and(...(conds as any)), { max: maxPageSize, pageToken });
}

export async function getEmployee(deps: Deps, actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, id)).limit(1))[0];
  // Item-level access (own / dept / hr / super) is enforced by the middleware on employees/<code>.
  if (!row || row.deleteTime) throw notFound("employee not found");
  return row;
}

// Give the person a sign-in account. An access rule names a `users/{id}` subject (domain/policyValidate.ts),
// so somebody with no account row cannot be granted anything and does not appear in the people pickers at all -
// which is why the access modal used to offer only the handful who had already signed in. Provisioning here
// makes the account exist from the moment the employee does, and first login then finds it by email instead of
// minting a second one (middleware/auth.ts).
//
// An account with the same email may already exist (they signed in before HR added them, or an earlier record
// used the address): link it if it is unlinked, and otherwise leave it alone rather than steal it from the
// employee it points at. `email` is UNIQUE, so this must look before it inserts.
async function provisionAccount(deps: Deps, employeeId: string, workEmail: string) {
  const email = workEmail.toLowerCase();
  const existing = (
    await deps.db
      .select({ uuid: schema.users.uuid, employeeId: schema.users.employeeId })
      .from(schema.users)
      .where(sql`lower(${schema.users.email}) = ${email}`)
      .limit(1)
  )[0];
  if (existing) {
    if (!existing.employeeId) {
      await deps.db
        .update(schema.users)
        .set({ employeeId, updatedAt: new Date() })
        .where(and(eq(schema.users.uuid, existing.uuid), isNull(schema.users.employeeId)));
    }
    return;
  }
  await deps.db
    .insert(schema.users)
    .values({ code: await allocFlatCode(deps, schema.users), email: workEmail, role: "employee", employeeId });
}

export async function createEmployee(deps: Deps, actor: AppUser, input: EmployeeInput, id?: string) {
  if (!input.first_name || !input.last_name || !input.work_email)
    throw invalidArgument("first_name, last_name, work_email are required");
  // Read out here rather than off `input` below: the insert runs inside a closure (the allocation retry), and
  // a narrowing from the guard above does not survive into one.
  const { first_name: firstName, last_name: lastName, work_email: workEmail } = input;
  const nationalIdEnc = input.national_id ? await deps.encryptor.encrypt(input.national_id) : null;
  // Human ID: an HR-provided override (validated unique), else auto-assigned from the org format.
  const override = input.employee_number?.trim();
  if (override) await assertNumberFree(deps, override);
  const startDate = dateMs(input.start_date);
  // Default probation end to start_date + the org default probation period when not given explicitly.
  let probationEndDate = dateMs(input.probation_end_date);
  if (!probationEndDate && startDate) {
    const { default_months } = await getSettingValue(deps, "probation", { default_months: 3 });
    probationEndDate = addMonths(+startDate, default_months);
  }
  // Both allocated numbers sit inside the retry: the authz `code` under the department, and the human
  // employee number - each read-max-then-write, each unique, so two people added at once collide on one of
  // them (codeAlloc.ts withFreshCode). An HR admin pasting a new intake while a manager adds one hire is
  // exactly that. A number typed in by hand is not re-allocated: it is the number the org has decided on,
  // and a second attempt would not free it, so that collision still reaches the caller as a conflict.
  const row = (await withFreshCode(
    async () =>
      deps.db
    .insert(schema.employees)
    .values({
      // `uuid`, which is the primary key (schema.ts). Spelled `{ id }` this named no column at all, so a
      // caller-specified id was silently dropped and a random one minted - and that path exists to make a
      // create IDEMPOTENT, so a client retrying a timed-out request made a second person instead of being
      // told the first already existed.
      ...(id ? { uuid: id } : {}),
      firstName,
      lastName,
      // Empty string clears, like an omitted field: the SPA sends "" for a text box the user left blank
      // (nothing on the wire is ever null - see web/src/api.ts).
      legalName: input.legal_name?.trim() || null,
      workEmail,
      jobTitle: input.job_title?.trim() || null,
      employeeNumber: override || (await allocEmployeeNumber(deps)),
      code: await allocUnderDept(deps, idFromPath(input.department) ?? null, CODE_WIDTH.employee),
      departmentId: idFromPath(input.department),
      managerId: idFromPath(input.manager),
      startDate,
      probationEndDate,
      nationalIdEnc,
    })
        .returning(),
    (e) => isCodeCollision(e) || (!override && isEmployeeNumberCollision(e)),
  ))[0]!;
  await audit(deps, actor, "employee.create", "employees", row.uuid, createdMeta(row, "employees"), row);
  await provisionAccount(deps, row.uuid, row.workEmail);
  await emitEvent(deps, actor, "employee.created", {
    subject: `employees/${row.uuid}`,
    employeeId: row.uuid,
    payload: { departmentId: row.departmentId ?? null, startDate: row.startDate ? new Date(row.startDate).toISOString() : null },
  });
  return row;
}

// Move the linked account onto the employee's new work email (or provision one, for an employee created
// before accounts were provisioned on create). A DIFFERENT account already holding the new address is left
// alone: `email` is UNIQUE, and stealing or clobbering it would sign somebody else out of their own account -
// the employee edit still stands, and the two rows are reconciled by whoever owns that other account.
async function syncAccountEmail(deps: Deps, employeeId: string, workEmail: string) {
  const taken = (
    await deps.db
      .select({ uuid: schema.users.uuid })
      .from(schema.users)
      .where(and(sql`lower(${schema.users.email}) = ${workEmail.toLowerCase()}`, sql`${schema.users.employeeId} is not ${employeeId}`))
      .limit(1)
  ).length > 0;
  if (taken) return;
  const linked = (
    await deps.db.select({ uuid: schema.users.uuid }).from(schema.users).where(eq(schema.users.employeeId, employeeId)).limit(1)
  )[0];
  if (!linked) return provisionAccount(deps, employeeId, workEmail);
  await deps.db.update(schema.users).set({ email: workEmail, updatedAt: new Date() }).where(eq(schema.users.uuid, linked.uuid));
}

// JSON Merge Patch: present = set, explicit null = clear, absent = unchanged.
export async function updateEmployee(deps: Deps, actor: AppUser, id: string, patch: EmployeeInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("employee not found");
  assertNotLocked(row);
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");

  const set: SetOf<typeof schema.employees> = { updatedAt: new Date() };
  const has = (k: keyof EmployeeInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("first_name")) set.firstName = patch.first_name;
  if (has("last_name")) set.lastName = patch.last_name;
  if (has("legal_name")) set.legalName = patch.legal_name?.trim() || null;
  if (has("work_email")) set.workEmail = patch.work_email;
  if (has("job_title")) set.jobTitle = patch.job_title?.trim() || null;
  if (has("employee_number")) {
    const n = patch.employee_number?.trim();
    if (!n) throw invalidArgument("employee_number can't be blank");
    await assertNumberFree(deps, n, id);
    set.employeeNumber = n;
  }
  if (has("department")) {
    const next = idFromPath(patch.department) ?? null;
    // Re-parent: recompute the employee's code + cascade every owned row (leave, payslips, comp, ...) + any
    // access-rule codes. moveEmployee sets departmentId itself, so it's not added to `set`.
    if (next !== row.departmentId) { await moveEmployee(deps, id, row.code!, next); await audit(deps, actor, "employee.reparent", "employees", id, { from: row.departmentId, to: next }); }
  }
  if (has("manager")) set.managerId = idFromPath(patch.manager) ?? null;
  if (has("start_date")) set.startDate = dateMs(patch.start_date);
  if (has("probation_end_date")) set.probationEndDate = dateMs(patch.probation_end_date);
  if (has("epf_enrolled")) set.epfEnrolled = !!patch.epf_enrolled;
  if (has("eps_excluded")) set.epsExcluded = !!patch.eps_excluded;
  if (has("national_id")) set.nationalIdEnc = patch.national_id ? await deps.encryptor.encrypt(patch.national_id) : null;

  const [updated] = await deps.db.update(schema.employees).set(set).where(eq(schema.employees.uuid, id)).returning();
  // Diff non-sensitive fields (never the encrypted national id) for the activity trail; fall back to field names.
  // The sign-in account is keyed by email, so a corrected work address has to move with it - otherwise the
  // account keeps the old address and the person's next login mints a SECOND one under the new email.
  if (set.workEmail && set.workEmail.toLowerCase() !== row.workEmail.toLowerCase()) await syncAccountEmail(deps, id, set.workEmail);
  const keys = Object.keys(set).filter((k) => k !== "updatedAt" && k !== "nationalIdEnc");
  const diff = fieldDiff(row, updated!, keys);
  const changedSensitive = "nationalIdEnc" in set;
  await audit(deps, actor, "employee.update", "employees", id, Object.keys(diff).length || changedSensitive ? { diff, ...(changedSensitive ? { fields: ["national_id"] } : {}) } : undefined);
  // A manager reassignment tells the employee who they now report to, and the new manager who joined their team.
  if (has("manager") && updated!.managerId !== row.managerId && updated!.managerId) {
    const empName = `${updated!.firstName} ${updated!.lastName}`.trim();
    if (updated!.managerId !== actor.employeeId)
      await notify(deps, { recipient: updated!.managerId, type: "system.reports_to_you", title: "New report", body: `${empName} now reports to you.`, link: "employees", subject: `employees/${id}`, actorId: actor.employeeId });
    if (id !== actor.employeeId)
      await notify(deps, { recipient: id, type: "system.manager_changed", title: "Your manager was updated", body: "Your reporting manager has changed - see your profile.", link: "profile", subject: `employees/${id}`, actorId: actor.employeeId });
  }
  return updated;
}




/** Public "about me" one-liner shown on profile heroes and the directory. Plain text on the base
 *  record (not PII, no encryption) so display rides every employee read for free. Access (owner /
 *  HR / super) is enforced by the middleware on employees/<code>/bio. */
export async function setBio(deps: Deps, actor: AppUser, id: string, bio: string | null | undefined) {
  const row = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("employee not found");
  const v = (bio ?? "").trim();
  if (v.length > 280) throw invalidArgument("bio is too long (max 280 characters)");
  await deps.db.update(schema.employees).set({ bio: v || null, updatedAt: new Date() }).where(eq(schema.employees.uuid, id));
  await audit(deps, actor, "employee.bio.update", "employees", id, { diff: { bio: { from: row.bio, to: v || null } } }, row);
  return { bio: v || undefined };
}
